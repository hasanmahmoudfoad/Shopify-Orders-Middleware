const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', 'app.env');

try {
  require('dotenv').config({ path: envPath });
} catch (error) {
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) return;
      let value = match[2] || '';
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    });
  }
}

const SHOP = process.env.SHOPIFY_STORE;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const GRAPHQL_URL = SHOP ? `https://${SHOP}/admin/api/${API_VERSION}/graphql.json` : null;
const TOKEN_ENDPOINT = SHOP ? `https://${SHOP}/admin/oauth/access_token` : null;

function toOrderGid(id) {
  const value = String(id || '');
  return value.startsWith('gid://') ? value : `gid://shopify/Order/${value}`;
}

function toLocationGid(id) {
  const value = String(id || '');
  return value.startsWith('gid://') ? value : `gid://shopify/Location/${value}`;
}

function createIdempotencyKey() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
}

function readTokenExpiry() {
  return Number(process.env.SHOPIFY_ACCESS_TOKEN_EXPIRES_AT || 0);
}

function persistToken(token, expiresAt) {
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    for (const [key, value] of Object.entries({
      SHOPIFY_ACCESS_TOKEN: token,
      SHOPIFY_ACCESS_TOKEN_EXPIRES_AT: expiresAt
    })) {
      const pattern = new RegExp(`^${key}\\s*=.*$`, 'm');
      content = pattern.test(content)
        ? content.replace(pattern, `${key}=${value}`)
        : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (error) {
    console.warn('Could not persist refreshed Shopify token:', error.message);
  }
}

async function requestAccessToken() {
  if (!TOKEN_ENDPOINT) throw new Error('SHOPIFY_STORE is not configured');
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Shopify client credentials are missing');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: process.env.GRANT_TYPE || 'client_credentials'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || `Token request failed (${response.status})`);
  }

  const expiresAt = body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : 0;
  process.env.SHOPIFY_ACCESS_TOKEN = body.access_token;
  process.env.SHOPIFY_ACCESS_TOKEN_EXPIRES_AT = String(expiresAt);
  persistToken(body.access_token, expiresAt);
  return body.access_token;
}

async function accessToken() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const expiresAt = readTokenExpiry();
  if (token && (!expiresAt || Date.now() < expiresAt - 5000)) return token;
  return requestAccessToken();
}

async function graphql(query, variables = {}) {
  if (!GRAPHQL_URL) throw new Error('SHOPIFY_STORE is not configured');
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await accessToken()
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Shopify request failed (${response.status})`);
  if (body.errors?.length) {
    console.error('[Shopify GraphQL errors]', JSON.stringify(body.errors));
    throw new Error(body.errors.map(error => error.message).join('; '));
  }
  return body.data;
}

function assertUserErrors(payload, label) {
  const errors = payload?.userErrors || [];
  if (!errors.length) return payload;
  console.warn('[Shopify userErrors]', JSON.stringify({ label, errors }));
  const error = new Error(errors.map(item => item.message).join('; '));
  error.code = errors[0].code;
  error.field = errors[0].field;
  error.statusCode = error.code === 'STALE_OBJECT' ? 409 : 400;
  error.message = `${label}: ${error.message}`;
  throw error;
}

async function getAccessScopes() {
  const data = await graphql(`query AccessScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }`);
  return data.currentAppInstallation.accessScopes.map(scope => scope.handle);
}

async function ensureOrderMetafieldDefinitions() {
  const data = await graphql(`query OrderMetafieldDefinitions {
    metafieldDefinitions(first: 100, ownerType: ORDER) {
      nodes { namespace key type { name } }
    }
  }`);
  const exists = data.metafieldDefinitions.nodes.some(definition =>
    definition.namespace === 'middleware' &&
    definition.key === 'status' &&
    definition.type.name === 'single_line_text_field'
  );
  if (exists) return { created: false };

  const result = await graphql(`mutation CreateOrderStatusDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id name }
      userErrors { field message code }
    }
  }`, {
    definition: {
      name: 'Middleware Status',
      namespace: 'middleware',
      key: 'status',
      description: 'Internal order processing status used by the middleware dashboard.',
      type: 'single_line_text_field',
      ownerType: 'ORDER'
    }
  });
  assertUserErrors(result.metafieldDefinitionCreate, 'Could not create order status metafield definition');
  return { created: true, definition: result.metafieldDefinitionCreate.createdDefinition };
}

async function getOrder(orderId) {
  const data = await graphql(`query OrderWorkflow($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      closedAt
      cancelledAt
      cancelReason
      displayFinancialStatus
      displayFulfillmentStatus
      refundable
      tags
      note
      customer {
        id
        firstName
        lastName
        phone
        defaultEmailAddress { emailAddress }
        defaultAddress {
          name
          phone
          address1
          city
          province
          country
        }
      }
      totalPriceSet { shopMoney { amount currencyCode } }
      transactions(first: 20) {
        id
        kind
        gateway
        status
        amountSet { shopMoney { amount currencyCode } }
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          currentQuantity
          refundableQuantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          image { url altText }
          variant {
            sku
            barcode
            image { url altText }
          }
        }
      }
      fulfillments(first: 20) {
        id
        status
        displayStatus
        createdAt
        trackingInfo {
          company
          number
          url
        }
        fulfillmentLineItems(first: 50) {
          nodes {
            quantity
            lineItem {
              id
              title
              variantTitle
              sku
              image { url altText }
            }
          }
        }
      }
      fulfillmentOrders(first: 50) {
        nodes {
          id
          status
          assignedLocation {
            location { id }
          }
          lineItems(first: 100) {
            nodes {
              id
              productTitle
              variantTitle
              remainingQuantity
              totalQuantity
              lineItem { id }
            }
          }
        }
      }
      middlewareStatus: metafield(namespace: "middleware", key: "status") {
        id
        value
        compareDigest
      }
      cancelNote: metafield(namespace: "middleware", key: "cancel_note") {
        id
        value
        compareDigest
      }
      externalMiddleware: metafield(namespace: "custom", key: "external_middleware") {
        id
        value
        compareDigest
      }
    }
  }`, { id: toOrderGid(orderId) });
  return data.order;
}

async function addTags(orderId, tags) {
  const result = await graphql(`mutation AddOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`, { id: toOrderGid(orderId), tags });
  return assertUserErrors(result.tagsAdd, 'Could not add tags');
}

async function removeTags(orderId, tags) {
  const result = await graphql(`mutation RemoveOrderTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`, { id: toOrderGid(orderId), tags });
  return assertUserErrors(result.tagsRemove, 'Could not remove tags');
}

async function getSuggestedRefund(orderId, refundLineItems) {
  const data = await graphql(`query SuggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!]!) {
    order(id: $id) {
      suggestedRefund(refundLineItems: $refundLineItems) {
        amountSet { shopMoney { amount currencyCode } }
        subtotalSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
      }
    }
  }`, { id: toOrderGid(orderId), refundLineItems });
  return data.order?.suggestedRefund;
}

async function getRecentOrdersPage({ first = 10, after, last, before } = {}) {
  const backward = before && last;
  const query = backward
    ? `query RecentOrders($last: Int!, $before: String) {
      orders(last: $last, before: $before, sortKey: CREATED_AT, reverse: true) {
        edges { cursor node { id } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }`
    : `query RecentOrders($first: Int!, $after: String) {
      orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
        edges { cursor node { id } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }`;
  const variables = backward ? { last, before } : { first, after };
  const data = await graphql(query, variables);
  return data.orders;
}

async function getLocations() {
  const data = await graphql(`query RefundLocations {
    locations(first: 50) {
      nodes { id name isActive fulfillsOnlineOrders }
    }
  }`);
  return data.locations?.nodes || [];
}

async function getRefundableTransactions(orderId) {
  const data = await graphql(`query RefundableTransactions($id: ID!) {
    order(id: $id) {
      transactions(first: 50) {
        id
        kind
        status
        gateway
        amountSet { shopMoney { amount currencyCode } }
        maximumRefundableV2 { amount currencyCode }
      }
    }
  }`, { id: toOrderGid(orderId) });

  return data.order?.transactions || [];
}

async function getRefundRestockLocations(orderId) {
  const data = await graphql(`query RefundRestockLocations($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 50) {
        nodes {
          assignedLocation {
            location { id }
          }
          lineItems(first: 100) {
            nodes {
              totalQuantity
              remainingQuantity
              lineItem { id }
            }
          }
        }
      }
    }
    locations(first: 1) {
      nodes { id name }
    }
  }`, { id: toOrderGid(orderId) });

  const byLineItemId = {};
  const fulfilledLineItemIds = [];
  const fulfillmentOrders = data.order?.fulfillmentOrders?.nodes || [];

  for (const fulfillmentOrder of fulfillmentOrders) {
    const locationId = fulfillmentOrder.assignedLocation?.location?.id;
    for (const node of fulfillmentOrder.lineItems?.nodes || []) {
      const lineItemId = node.lineItem?.id;
      if (!lineItemId) continue;
      if (locationId && !byLineItemId[lineItemId]) {
        byLineItemId[lineItemId] = toLocationGid(locationId);
      }
      const totalQuantity = Number(node.totalQuantity) || 0;
      const remainingQuantity = Number(node.remainingQuantity) || 0;
      if (totalQuantity > remainingQuantity && !fulfilledLineItemIds.includes(lineItemId)) {
        fulfilledLineItemIds.push(lineItemId);
      }
    }
  }

  return {
    byLineItemId,
    fulfilledLineItemIds,
    fallbackLocationId: data.locations?.nodes?.[0]?.id
      ? toLocationGid(data.locations.nodes[0].id)
      : null
  };
}

async function createRefund(input) {
  const { idempotencyKey = createIdempotencyKey(), ...refundInput } = input;

  const result = await graphql(`mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {
        id
        totalRefundedSet {
          shopMoney { amount currencyCode }
        }
      }
      userErrors { field message }
    }
  }`, {
    input: { ...refundInput, orderId: toOrderGid(refundInput.orderId) },
    idempotencyKey
  });

  return assertUserErrors(result.refundCreate, 'Could not create refund').refund;
}

async function closeOrder(orderId) {
  const result = await graphql(`mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id closedAt }
      userErrors { field message }
    }
  }`, { input: { id: toOrderGid(orderId) } });
  return assertUserErrors(result.orderClose, 'Could not archive order').order;
}

async function openOrder(orderId) {
  const result = await graphql(`mutation OrderOpen($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order { id closedAt }
      userErrors { field message }
    }
  }`, { input: { id: toOrderGid(orderId) } });
  return assertUserErrors(result.orderOpen, 'Could not unarchive order').order;
}

async function updateOrderNote(orderId, note) {
  const result = await graphql(`mutation UpdateOrderNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note }
      userErrors { field message }
    }
  }`, { input: { id: toOrderGid(orderId), note } });
  return assertUserErrors(result.orderUpdate, 'Could not update order note').order;
}

async function setOrderMetafield({ ownerId, namespace, key, value, compareDigest }) {
  const input = {
    ownerId: toOrderGid(ownerId),
    namespace,
    key,
    type: 'single_line_text_field',
    value
  };
  if (compareDigest !== undefined) input.compareDigest = compareDigest;

  const result = await graphql(`mutation SetOrderMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value compareDigest }
      userErrors { field message code }
    }
  }`, { metafields: [input] });
  return assertUserErrors(result.metafieldsSet, 'Could not save metafield').metafields[0];
}

async function getFulfillmentOrders(orderId) {
  const order = await getOrder(orderId);
  return order ? order.fulfillmentOrders : null;
}

async function createFulfillment(lineItemsByFulfillmentOrder, notifyCustomer = false) {
  const result = await graphql(`mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }`, {
    fulfillment: { notifyCustomer, lineItemsByFulfillmentOrder }
  });
  return assertUserErrors(result.fulfillmentCreate, 'Could not create fulfillment').fulfillment;
}

async function cancelFulfillment(id) {
  const result = await graphql(`mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }`, { id });
  return assertUserErrors(result.fulfillmentCancel, 'Could not cancel fulfillment').fulfillment;
}

async function holdFulfillmentOrder(id) {
  const result = await graphql(`mutation HoldFulfillmentOrder($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }`, {
    id,
    fulfillmentHold: {
      reason: 'OTHER',
      reasonNotes: 'Placed on hold from Shopify Order Monitor'
    }
  });
  return assertUserErrors(result.fulfillmentOrderHold, 'Could not hold fulfillment order').fulfillmentOrder;
}

async function releaseFulfillmentOrder(id) {
  const result = await graphql(`mutation ReleaseFulfillmentOrder($id: ID!) {
    fulfillmentOrderReleaseHold(id: $id) {
      fulfillmentOrder { id status }
      userErrors { field message code }
    }
  }`, { id });
  return assertUserErrors(result.fulfillmentOrderReleaseHold, 'Could not release fulfillment order').fulfillmentOrder;
}

// Shopify native "In progress" — visible in Admin fulfillment column (API 2026-04+).
async function reportFulfillmentProgress(fulfillmentOrderId, reasonNotes = 'Processing started from middleware') {
  const result = await graphql(`mutation ReportFulfillmentProgress($id: ID!, $progressReport: FulfillmentOrderReportProgressInput!) {
    fulfillmentOrderReportProgress(id: $id, progressReport: $progressReport) {
      fulfillmentOrder { id status }
      userErrors { field message code }
    }
  }`, {
    id: fulfillmentOrderId,
    progressReport: { reasonNotes: String(reasonNotes).slice(0, 256) }
  });
  return assertUserErrors(result.fulfillmentOrderReportProgress, 'Could not report fulfillment progress').fulfillmentOrder;
}

async function markOrderAsPaid(orderId) {
  const result = await graphql(`mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }`, { input: { id: toOrderGid(orderId) } });
  return assertUserErrors(result.orderMarkAsPaid, 'Could not mark order as paid').order;
}

async function waitForJob(jobId, attempts = 10, delayMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = await graphql(`query JobStatus($id: ID!) {
      job(id: $id) { id done }
    }`, { id: jobId });
    if (data.job?.done) return data.job;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw Object.assign(new Error('Order cancellation is still processing. Refresh the order shortly.'), { statusCode: 202 });
}

async function cancelOrder({ orderId, reason, staffNote, restock = true, refundMethod, notifyCustomer = false }) {
  const result = await graphql(`mutation OrderCancel(
    $orderId: ID!,
    $reason: OrderCancelReason!,
    $restock: Boolean!,
    $notifyCustomer: Boolean,
    $staffNote: String,
    $refundMethod: OrderCancelRefundMethodInput
  ) {
    orderCancel(
      orderId: $orderId,
      reason: $reason,
      restock: $restock,
      notifyCustomer: $notifyCustomer,
      staffNote: $staffNote,
      refundMethod: $refundMethod
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }`, {
    orderId: toOrderGid(orderId),
    reason,
    restock,
    notifyCustomer,
    staffNote: staffNote || undefined,
    refundMethod
  });
  const payload = result.orderCancel;
  const errors = payload?.orderCancelUserErrors || [];
  if (errors.length) {
    const error = new Error(errors.map(item => item.message).join('; '));
    error.statusCode = 400;
    throw error;
  }
  const job = payload?.job;
  if (job?.id && !job.done) await waitForJob(job.id);
  return job;
}

module.exports = {
  graphql,
  toOrderGid,
  getAccessScopes,
  ensureOrderMetafieldDefinitions,
  getOrder,
  addTags,
  removeTags,
  getSuggestedRefund,
  getRecentOrdersPage,
  getLocations,
  getRefundableTransactions,
  getRefundRestockLocations,
  createRefund,
  closeOrder,
  openOrder,
  updateOrderNote,
  setOrderMetafield,
  getFulfillmentOrders,
  createFulfillment,
  cancelFulfillment,
  holdFulfillmentOrder,
  releaseFulfillmentOrder,
  reportFulfillmentProgress,
  markOrderAsPaid,
  cancelOrder
};
