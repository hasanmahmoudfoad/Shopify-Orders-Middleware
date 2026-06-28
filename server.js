const express = require('express');
const fs = require('fs');
const path = require('path');
const shopify = require('./services/shopify');

const app = express();
const PORT = process.env.PORT || 3000;
const orders = [];
const deliveries = [];
const PAGE_SIZE = 10;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.method === 'POST') {
    const record = {
      path: req.path,
      headers: req.headers,
      body: req.body,
      received_at: new Date().toISOString()
    };
    deliveries.unshift(record);
    fs.appendFile(path.join(__dirname, 'post-deliveries.log'), `${JSON.stringify(record)}\n`, () => { });
  }
  next();
});

function numericId(id) {
  return String(id || '').split('/').pop();
}

function normalizeWebhookOrder(order) {
  const copy = { ...order };
  copy.id = shopify.toOrderGid(copy.admin_graphql_api_id || copy.id);
  copy.numericId = numericId(copy.id);
  copy.received_at = copy.received_at || new Date().toISOString();
  copy.closed_at = copy.closed_at || copy.closedAt || null;
  return copy;
}

function upsertOrder(order) {
  const index = orders.findIndex(existing => String(existing.id) === String(order.id));
  if (index >= 0) {
    orders[index] = { ...orders[index], ...order };
    return orders[index];
  }
  orders.unshift(order);
  return order;
}

function findOrder(value) {
  const target = String(value || '');
  const numeric = numericId(target);
  return orders.find(order =>
    String(order.id) === target ||
    String(order.numericId) === numeric ||
    String(order.name) === target ||
    String(order.order_number) === target
  );
}

function workflowStatus(order) {
  const fulfillmentOrders = order.fulfillmentOrders || [];
  if (fulfillmentOrders.some(item => String(item.status).toUpperCase() === 'ON_HOLD')) return 'ON_HOLD';
  const fulfillment = String(order.fulfillment_status || order.displayFulfillmentStatus || '').toUpperCase();
  if (fulfillment === 'FULFILLED' || fulfillment === 'PARTIALLY_FULFILLED') return fulfillment;
  if (fulfillment === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (fulfillmentOrders.some(item => String(item.status).toUpperCase() === 'IN_PROGRESS')) return 'IN_PROGRESS';
  if (String(order.middleware_status || '').toUpperCase() === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'UNFULFILLED';
}

const DELIVERY_STATUS_RANK = {
  DELIVERED: 6,
  OUT_FOR_DELIVERY: 5,
  IN_TRANSIT: 4,
  LABEL_PRINTED: 3,
  CONFIRMED: 2,
  SUBMITTED: 1
};

function pickHighestDeliveryStatus(statuses) {
  return statuses.reduce((best, status) => {
    const value = String(status || '').toUpperCase();
    const rank = DELIVERY_STATUS_RANK[value] || 0;
    const bestRank = DELIVERY_STATUS_RANK[best] || 0;
    return rank > bestRank ? value : best;
  }, statuses[0]);
}

function deliveryStatus(order) {
  const statuses = (order.fulfillments || [])
    .map(item => item.displayStatus)
    .filter(Boolean);
  if (!statuses.length) return order.cancelled_at ? 'CANCELLED' : 'NOT_SHIPPED';
  return pickHighestDeliveryStatus(statuses.map(status => String(status).toUpperCase()));
}

function orderStatus(order) {
  return order.cancelled_at ? 'CANCELLED' : workflowStatus(order);
}

function mapLineItem(item) {
  const quantity = Number(item.quantity) || 0;
  const currentQuantity = Number(item.currentQuantity) || 0;
  const imageUrl = item.image?.url ||
    item.variant?.image?.url ||
    item.variant?.media?.nodes?.[0]?.preview?.image?.url ||
    '';
  return {
    id: item.id,
    title: item.title,
    variant_title: item.variantTitle,
    sku: item.sku || item.variant?.sku || '',
    barcode: item.variant?.barcode || '',
    image_url: imageUrl,
    quantity,
    currentQuantity,
    fulfilled_quantity: Math.max(0, quantity - currentQuantity),
    refundable_quantity: Number(item.refundableQuantity) || 0,
    price: item.originalUnitPriceSet?.shopMoney?.amount,
    currency: item.originalUnitPriceSet?.shopMoney?.currencyCode
  };
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.nodes || value.edges?.map(edge => edge.node).filter(Boolean) || [];
}

function mapCustomer(customer) {
  if (!customer) return null;
  const defaultAddress = customer.defaultAddress ? {
    name: customer.defaultAddress.name,
    phone: customer.defaultAddress.phone,
    address1: customer.defaultAddress.address1,
    city: customer.defaultAddress.city,
    province: customer.defaultAddress.province,
    country: customer.defaultAddress.country
  } : null;
  return {
    id: customer.id,
    first_name: customer.firstName || '',
    last_name: customer.lastName || '',
    email: customer.defaultEmailAddress?.emailAddress || '',
    phone: customer.phone || '',
    default_address: defaultAddress
  };
}

function mapFulfillment(item) {
  const tracking = Array.isArray(item.trackingInfo) ? item.trackingInfo[0] : item.trackingInfo;
  return {
    id: item.id,
    status: item.status,
    displayStatus: item.displayStatus,
    createdAt: item.createdAt,
    cancellable: String(item.status || '').toUpperCase() === 'SUCCESS',
    tracking: tracking ? {
      company: tracking.company,
      number: tracking.number,
      url: tracking.url
    } : null,
    lineItems: asList(item.fulfillmentLineItems).map(node => ({
      quantity: node.quantity,
      lineItem: node.lineItem ? {
        id: node.lineItem.id,
        title: node.lineItem.title,
        variant_title: node.lineItem.variantTitle,
        sku: node.lineItem.sku || '',
        image_url: node.lineItem.image?.url || ''
      } : null
    }))
  };
}

function mergeShopifyOrder(remote) {
  if (!remote) return null;
  const index = orders.findIndex(order => String(order.id) === String(remote.id));
  const existing = index >= 0 ? orders[index] : {};
  const merged = {
    ...existing,
    id: remote.id,
    numericId: numericId(remote.id),
    name: remote.name,
    order_number: remote.name,
    created_at: remote.createdAt,
    closed_at: remote.closedAt || null,
    total_price: remote.totalPriceSet?.shopMoney?.amount,
    currency: remote.totalPriceSet?.shopMoney?.currencyCode,
    financial_status: remote.displayFinancialStatus,
    fulfillment_status: remote.displayFulfillmentStatus,
    refundable: remote.refundable,
    cancelled_at: remote.cancelledAt || null,
    cancel_reason: remote.cancelReason || null,
    cancel_note: remote.cancelNote?.value || '',
    tags: remote.tags || [],
    note: remote.note || '',
    customer: mapCustomer(remote.customer) || existing.customer,
    shipping_address: existing.shipping_address || mapCustomer(remote.customer)?.default_address,
    line_items: (remote.lineItems?.nodes || []).map(mapLineItem),
    fulfillments: asList(remote.fulfillments).map(mapFulfillment),
    transactions: asList(remote.transactions).map(txn => ({
      id: txn.id,
      kind: txn.kind,
      gateway: txn.gateway,
      status: txn.status,
      amount: txn.amountSet?.shopMoney?.amount,
      currency: txn.amountSet?.shopMoney?.currencyCode
    })),
    fulfillmentOrders: remote.fulfillmentOrders?.nodes || [],
    middleware_status: remote.middlewareStatus?.value || '',
    middlewareStatus: remote.middlewareStatus || null,
    metafield: remote.externalMiddleware || null
  };
  merged.workflow_status = workflowStatus(merged);
  merged.order_status = orderStatus(merged);
  merged.delivery_status = deliveryStatus(merged);
  upsertOrder(merged);
  return merged;
}

async function refreshOrder(orderId) {
  return mergeShopifyOrder(await shopify.getOrder(orderId));
}

function serializeOrder(order) {
  return {
    id: order.numericId || numericId(order.id),
    gid: order.id,
    name: order.name || order.order_number,
    customer: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : '',
    email: order.customer?.email || order.contact_email || order.email || '',
    total: order.total_price ? `${order.total_price} ${order.currency || ''}`.trim() : '',
    created_at: order.created_at,
    closed_at: order.closed_at || null,
    cancelled_at: order.cancelled_at || null,
    order_status: order.order_status || orderStatus(order),
    workflow_status: workflowStatus(order),
    financial_status: order.financial_status || '',
    fulfillment_status: order.fulfillment_status || '',
    delivery_status: order.delivery_status || deliveryStatus(order),
    archived: Boolean(order.closed_at),
    tags: Array.isArray(order.tags) ? order.tags : String(order.tags || '').split(',').filter(Boolean)
  };
}

function localOrdersPage() {
  return {
    total: orders.length,
    orders: orders.slice(0, PAGE_SIZE).map(serializeOrder),
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }
  };
}

async function fetchOrdersPage({ direction, cursor }) {
  const page = await shopify.getRecentOrdersPage(
    direction === 'prev'
      ? { last: PAGE_SIZE, before: cursor }
      : { first: PAGE_SIZE, after: direction === 'next' ? cursor : undefined }
  );
  const pageOrders = [];
  for (const edge of page.edges || []) {
    try {
      pageOrders.push(await refreshOrder(edge.node.id));
    } catch (error) {
      console.warn(`Could not load order ${edge.node.id}: ${error.message}`);
    }
  }
  return {
    total: orders.length,
    orders: pageOrders.map(serializeOrder),
    pageInfo: page.pageInfo || { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }
  };
}

async function syncRecentOrdersOnStartup() {
  try {
    const page = await fetchOrdersPage({});
    console.log(`Synced ${page.orders.length} recent Shopify order(s) on startup`);
  } catch (error) {
    console.warn(`Startup order sync failed: ${error.message}`);
  }
}

function errorResponse(res, error) {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || 'Server error', code: error.code });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function receiveOrder(req, res, label) {
  const order = normalizeWebhookOrder(req.body || {});
  upsertOrder(order);
  const name = order.customer
    ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
    : order.email || 'unknown';
  console.log(`[${label}] Order ${order.name || order.id} from ${name} at ${order.received_at}`);
  res.status(200).send('OK');
}

app.post('/webhooks/orders-create', (req, res) => receiveOrder(req, res, 'Webhook'));
app.post('/', (req, res) => {
  if (String(req.header('x-shopify-topic')).toLowerCase() === 'orders/create') {
    return receiveOrder(req, res, 'Webhook(root)');
  }
  res.status(200).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/orders', async (req, res) => {
  const shouldSync = String(req.query.sync || '') === '1';
  const direction = String(req.query.pageDirection || '');
  const cursor = String(req.query.cursor || '');
  if (shouldSync || direction) {
    try {
      return res.json(await fetchOrdersPage({ direction, cursor }));
    } catch (error) {
      console.warn(`Could not fetch Shopify orders page: ${error.message}`);
    }
  }

  res.json(localOrdersPage());
});

app.get('/api/orders/:id', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.get('/api/orders/:id/metafield', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const fresh = await refreshOrder(order.id);
    res.json({ ok: true, metafield: fresh.metafield });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/tag', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const tags = [...new Set((Array.isArray(req.body.tags) ? req.body.tags : [req.body.tags])
    .flatMap(tag => String(tag || '').split(','))
    .map(tag => tag.trim())
    .filter(Boolean))];
  if (!tags.length) return res.status(400).json({ error: 'Enter at least one tag' });
  try {
    await shopify.addTags(order.id, tags);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.delete('/api/orders/:id/tag', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const tags = [...new Set((Array.isArray(req.body.tags) ? req.body.tags : [req.body.tags])
    .map(tag => String(tag || '').trim())
    .filter(Boolean))];
  if (!tags.length) return res.status(400).json({ error: 'Select at least one tag to remove' });
  try {
    await shopify.removeTags(order.id, tags);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

function parseRefundItems(raw) {
  let items;
  try {
    items = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw Object.assign(new Error('Invalid refund item selection'), { statusCode: 400 });
  }
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('Select at least one item to refund'), { statusCode: 400 });
  }
  return items.map(item => {
    const lineItemId = String(item.lineItemId || '');
    const quantity = Number(item.quantity);
    if (!lineItemId || !Number.isInteger(quantity) || quantity <= 0) {
      throw Object.assign(new Error('Invalid refund item selection'), { statusCode: 400 });
    }
    return { lineItemId, quantity };
  });
}

function shouldRestock(value) {
  if (value === undefined || value === null || value === '') return true;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function toLocationGid(id) {
  const value = String(id || '').trim();
  return value && value.startsWith('gid://') ? value : value ? `gid://shopify/Location/${value}` : '';
}

async function prepareRefundLineItems(orderId, items, restock, requestedLocationId) {
  if (!restock) {
    return items.map(item => ({
      ...item,
      restockType: 'NO_RESTOCK'
    }));
  }

  const locations = await shopify.getRefundRestockLocations(orderId);
  const selectedLocationId = toLocationGid(requestedLocationId);
  return items.map(item => {
    const locationId = selectedLocationId || locations.byLineItemId[item.lineItemId] || locations.fallbackLocationId;
    if (!locationId) {
      throw Object.assign(
        new Error('Could not find a Shopify location to restock this refund. Add an active location or refund without restocking.'),
        { statusCode: 400 }
      );
    }
    return {
      ...item,
      restockType: locations.fulfilledLineItemIds.includes(item.lineItemId) ? 'RETURN' : 'CANCEL',
      locationId
    };
  });
}

function moneyToCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function centsToMoney(value) {
  return (value / 100).toFixed(2);
}

function transactionSummary(txn) {
  return {
    id: txn.id,
    kind: txn.kind,
    status: txn.status,
    gateway: txn.gateway,
    amount: txn.amountSet?.shopMoney?.amount,
    currency: txn.amountSet?.shopMoney?.currencyCode,
    maximumRefundable: txn.maximumRefundableV2?.amount,
    maximumRefundableCurrency: txn.maximumRefundableV2?.currencyCode
  };
}

function selectRefundParentTransaction(transactions) {
  const candidates = transactions.filter(txn =>
    ['SALE', 'CAPTURE'].includes(String(txn.kind || '').toUpperCase()) &&
    String(txn.status || '').toUpperCase() === 'SUCCESS' &&
    String(txn.gateway || '').trim()
  );
  return candidates.find(txn => String(txn.kind).toUpperCase() === 'CAPTURE') ||
    candidates.find(txn => String(txn.kind).toUpperCase() === 'SALE') ||
    null;
}

function buildRefundTransactions(orderId, amount, parent) {
  if (moneyToCents(amount) <= 0) {
    throw Object.assign(new Error('No refundable payment transaction found for this order.'), { statusCode: 400 });
  }
  if (!parent) {
    throw Object.assign(new Error('No refundable payment transaction found for this order.'), { statusCode: 400 });
  }
  return [{
    orderId: shopify.toOrderGid(orderId),
    parentId: parent.id,
    gateway: String(parent.gateway).trim(),
    kind: 'REFUND',
    amount: centsToMoney(moneyToCents(amount))
  }];
}

function buildRefundInput(orderId, refundLineItems, suggested, parentTransaction, idempotencyKey, note) {
  const refundAmount = suggested?.amountSet?.shopMoney?.amount;
  const transactions = buildRefundTransactions(orderId, refundAmount, parentTransaction);

  const input = {
    orderId,
    refundLineItems,
    notify: false,
    transactions,
    idempotencyKey
  };
  if (String(note || '').trim()) input.note = String(note).trim();
  return input;
}

app.get('/api/orders/:id/refund-preview', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const refundLineItems = await prepareRefundLineItems(
      order.id,
      parseRefundItems(req.query.items),
      shouldRestock(req.query.restock),
      req.query.locationId
    );
    const suggested = await shopify.getSuggestedRefund(order.id, refundLineItems);
    res.json({
      ok: true,
      preview: {
        amount: suggested?.amountSet?.shopMoney?.amount,
        currency: suggested?.amountSet?.shopMoney?.currencyCode,
        subtotal: suggested?.subtotalSet?.shopMoney?.amount,
        tax: suggested?.totalTaxSet?.shopMoney?.amount
      }
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/refund', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const fresh = await refreshOrder(order.id);
    if (fresh.cancelled_at) return res.status(400).json({ error: 'Cannot refund a cancelled order' });
    if (String(fresh.financial_status || '').toUpperCase() === 'VOIDED') {
      return res.status(400).json({ error: 'This order cannot be refunded' });
    }

    const refundLineItems = await prepareRefundLineItems(
      fresh.id,
      parseRefundItems(req.body.items),
      shouldRestock(req.body.restock),
      req.body.locationId
    );
    const suggested = await shopify.getSuggestedRefund(fresh.id, refundLineItems);
    if (!suggested) throw Object.assign(new Error('Could not calculate refund preview'), { statusCode: 400 });

    const refundableTransactions = await shopify.getRefundableTransactions(fresh.id);
    console.log('[Refund] Order transactions:', JSON.stringify(refundableTransactions.map(transactionSummary)));
    const parentTransaction = selectRefundParentTransaction(refundableTransactions);
    console.log('[Refund] Selected parent transaction:', JSON.stringify(parentTransaction ? transactionSummary(parentTransaction) : null));
    const idempotencyKey = String(req.body.idempotencyKey || '').trim() || undefined;
    const refundInput = buildRefundInput(fresh.id, refundLineItems, suggested, parentTransaction, idempotencyKey, req.body.note);
    console.log('[Refund] refundCreate input:', JSON.stringify(refundInput));
    await shopify.createRefund(refundInput);
    res.json({ ok: true, order: await refreshOrder(fresh.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/note', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const note = String(req.body.note ?? '');
  try {
    await shopify.updateOrderNote(order.id, note);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/metafield', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const metafield = await shopify.setOrderMetafield({
      ownerId: order.id,
      namespace: 'custom',
      key: 'external_middleware',
      value: String(req.body.value ?? ''),
      compareDigest: req.body.compareDigest === undefined ? null : req.body.compareDigest
    });
    res.json({ ok: true, metafield, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/archive', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    await shopify.closeOrder(order.id);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/unarchive', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    await shopify.openOrder(order.id);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/fulfillments/:fulfillmentId/cancel', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    await shopify.cancelFulfillment(req.params.fulfillmentId);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.get('/api/locations', async (req, res) => {
  try {
    res.json({ ok: true, locations: await shopify.getLocations() });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/status', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const status = String(req.body.status || '').toUpperCase();
  try {
    if (status === 'IN_PROGRESS') {
      const fulfillmentOrders = await shopify.getFulfillmentOrders(order.id);
      const active = (fulfillmentOrders?.nodes || []).filter(item =>
        ['OPEN', 'IN_PROGRESS'].includes(String(item.status).toUpperCase())
      );
      if (!active.length) {
        throw Object.assign(new Error('No fulfillment orders can be marked in progress'), { statusCode: 400 });
      }
      const reasonNotes = String(req.body.reasonNotes || 'Processing started from middleware');
      for (const item of active) {
        if (String(item.status).toUpperCase() !== 'IN_PROGRESS') {
          await shopify.reportFulfillmentProgress(item.id, reasonNotes);
        }
      }
    } else if (status === 'ON_HOLD') {
      const fulfillmentOrders = await shopify.getFulfillmentOrders(order.id);
      const active = (fulfillmentOrders?.nodes || []).filter(item =>
        !['CLOSED', 'CANCELLED', 'INCOMPLETE'].includes(String(item.status).toUpperCase())
      );
      if (!active.length) throw Object.assign(new Error('No active fulfillment orders can be placed on hold'), { statusCode: 400 });
      for (const item of active) await shopify.holdFulfillmentOrder(item.id);
    } else {
      return res.status(400).json({ error: 'Unsupported status action' });
    }
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/release', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const fulfillmentOrders = await shopify.getFulfillmentOrders(order.id);
    const held = (fulfillmentOrders?.nodes || []).filter(item => String(item.status).toUpperCase() === 'ON_HOLD');
    if (!held.length) throw Object.assign(new Error('This order has no fulfillment holds to release'), { statusCode: 400 });
    for (const item of held) await shopify.releaseFulfillmentOrder(item.id);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/fulfill', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const requested = Array.isArray(req.body.items) ? req.body.items : [];
  if (!requested.length) return res.status(400).json({ error: 'Select at least one unit to fulfill' });

  try {
    const fulfillmentOrders = await shopify.getFulfillmentOrders(order.id);
    const nodes = fulfillmentOrders?.nodes || [];
    if (nodes.some(item => String(item.status).toUpperCase() === 'ON_HOLD')) {
      throw Object.assign(new Error('Release the fulfillment hold before fulfilling items'), { statusCode: 400 });
    }

    const requestedById = new Map();
    for (const item of requested) {
      const id = String(item.fulfillmentOrderLineItemId || '');
      const quantity = Number(item.quantity);
      if (!id || !Number.isInteger(quantity) || quantity <= 0) {
        throw Object.assign(new Error('Invalid fulfillment item selection'), { statusCode: 400 });
      }
      requestedById.set(id, (requestedById.get(id) || 0) + quantity);
    }

    const lineItemsByFulfillmentOrder = [];
    for (const fulfillmentOrder of nodes) {
      const selected = [];
      for (const lineItem of fulfillmentOrder.lineItems?.nodes || []) {
        const quantity = requestedById.get(lineItem.id) || 0;
        if (!quantity) continue;
        if (quantity > lineItem.remainingQuantity) {
          throw Object.assign(new Error(`${lineItem.productTitle} only has ${lineItem.remainingQuantity} unit(s) remaining`), { statusCode: 409 });
        }
        selected.push({ id: lineItem.id, quantity });
        requestedById.delete(lineItem.id);
      }
      if (selected.length) {
        lineItemsByFulfillmentOrder.push({
          fulfillmentOrderId: fulfillmentOrder.id,
          fulfillmentOrderLineItems: selected
        });
      }
    }
    if (requestedById.size) {
      throw Object.assign(new Error('The fulfillment selection is stale. Refresh and try again.'), { statusCode: 409 });
    }
    await shopify.createFulfillment(lineItemsByFulfillmentOrder, false);
    res.json({ ok: true, order: await refreshOrder(order.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.post('/api/orders/:id/mark-paid', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const fresh = await refreshOrder(order.id);
    const financial = String(fresh.financial_status || '').toUpperCase();
    if (['PAID', 'REFUNDED', 'VOIDED'].includes(financial)) {
      return res.status(400).json({ error: `Order is already ${financial.toLowerCase().replaceAll('_', ' ')}` });
    }
    if (fresh.cancelled_at) return res.status(400).json({ error: 'Cannot mark a cancelled order as paid' });
    await shopify.markOrderAsPaid(fresh.id);
    res.json({ ok: true, order: await refreshOrder(fresh.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

const CANCEL_REASONS = new Set(['CUSTOMER', 'INVENTORY', 'FRAUD', 'DECLINED', 'STAFF', 'OTHER']);

app.post('/api/orders/:id/cancel', async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const reason = String(req.body.reason || '').toUpperCase();
  if (!CANCEL_REASONS.has(reason)) {
    return res.status(400).json({ error: 'Select a valid cancellation reason' });
  }

  const hint = String(req.body.hint || '').trim();
  const refund = String(req.body.refund || 'original').toLowerCase();
  const refundMethod = refund === 'none'
    ? { originalPaymentMethodsRefund: false }
    : { originalPaymentMethodsRefund: true };

  try {
    const fresh = await refreshOrder(order.id);
    if (fresh.cancelled_at) return res.status(400).json({ error: 'Order is already cancelled' });

    await shopify.cancelOrder({
      orderId: fresh.id,
      reason,
      staffNote: hint || undefined,
      restock: true,
      notifyCustomer: false,
      refundMethod
    });
    if (hint) {
      await shopify.setOrderMetafield({
        ownerId: fresh.id,
        namespace: 'middleware',
        key: 'cancel_note',
        value: hint
      });
    }
    res.json({ ok: true, order: await refreshOrder(fresh.id) });
  } catch (error) {
    errorResponse(res, error);
  }
});

app.get('/orders/:id', (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).send('<h1>Order not found</h1>');
  const customer = order.customer || {};
  const address = order.shipping_address || customer.default_address || {};
  res.send(`<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Order ${escapeHtml(order.name || order.id)}</title>
      <link rel="stylesheet" href="/styles.css">
    </head>
    <body data-order-id="${escapeHtml(order.id)}" class="order-page">
      <div id="toast-region" class="toast-region" aria-live="polite"></div>
      <main class="page-shell">
        <div class="page-heading">
          <div>
            <a class="back-link" href="/">← Back to orders</a>
            <h1>Order ${escapeHtml(order.name || order.id)}</h1>
            <p class="muted">Shopify order workflow and fulfillment</p>
          </div>
          <div class="heading-badges">
            <span id="workflow-status" class="badge badge-unfulfilled">UNFULFILLED</span>
            <span id="payment-heading-status" class="badge badge-pending">PAYMENT</span>
            <span id="archive-heading-status" class="badge badge-unfulfilled">OPEN</span>
            <span id="delivery-heading-status" class="badge badge-not-shipped">NOT SHIPPED</span>
          </div>
        </div>
    
        <div class="detail-grid">
          <section class="card">
            <div class="card-heading"><h2>Customer</h2></div>
            <dl class="detail-list">
              <div><dt>Name</dt><dd>${escapeHtml(address.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || '—')}</dd></div>
              <div><dt>Email</dt><dd>${escapeHtml(customer.email || order.contact_email || order.email || '—')}</dd></div>
              <div><dt>Phone</dt><dd>${escapeHtml(address.phone || customer.phone || order.phone || '—')}</dd></div>
              <div><dt>Address</dt><dd>${escapeHtml(address.address1 || '—')}</dd></div>
              <div><dt>Region</dt><dd>${escapeHtml([address.city, address.province, address.country].filter(Boolean).join(', ') || '—')}</dd></div>
            </dl>
          </section>
    
          <section class="card">
            <div class="card-heading"><h2>Order summary</h2></div>
            <dl class="detail-list">
              <div><dt>Order ID</dt><dd>${escapeHtml(numericId(order.id))}</dd></div>
              <div><dt>Total</dt><dd>${escapeHtml(order.total_price || '—')} ${escapeHtml(order.currency || '')}</dd></div>
              <div><dt>Financial status</dt><dd id="summary-financial-status">${escapeHtml(order.financial_status || '—')}</dd></div>
              <div><dt>Created</dt><dd id="created-at">${escapeHtml(order.created_at || '—')}</dd></div>
              <div><dt>Received</dt><dd id="received-at">${escapeHtml(order.received_at || '—')}</dd></div>
            </dl>
          </section>
        </div>

        <div class="items-grid">
        <section class="card">
          <div class="card-heading"><h2>Unfulfilled items</h2></div>
          <div id="line-items-list" class="item-list">
            <p class="muted">Loading line items…</p>
          </div>
        </section>
        <section class="card" id="fulfilled-items-card">
          <div class="card-heading">
            <h2>Fulfilled items</h2>
            <button id="btn-cancel-fulfillment" class="btn btn-small btn-danger" hidden>Cancel Fulfillment</button>
          </div>
          <div id="fulfilled-items-list" class="item-list">
            <p class="muted">Loading fulfilled items...</p>
          </div>
        </section>
        </div>

        <section class="card">
          <div class="card-heading">
            <div>
              <h2>Payment &amp; order status</h2>
              <p class="muted">Payment and cancellation sync with Shopify Admin.</p>
            </div>
            <span id="financial-status" class="badge badge-pending">—</span>
          </div>
          <dl id="cancellation-details" class="detail-list cancellation-details" hidden>
            <div><dt>Cancelled at</dt><dd id="cancelled-at">—</dd></div>
            <div><dt>Cancel reason</dt><dd id="cancel-reason">—</dd></div>
            <div><dt>Cancellation note</dt><dd id="cancel-note">—</dd></div>
          </dl>
          <div class="button-row">
            <button id="btn-mark-paid" class="btn btn-primary">Mark as Paid</button>
            <button id="btn-refund" class="btn">Issue Refund</button>
            <button id="btn-cancel-order" class="btn btn-danger">Cancel Order</button>
          </div>
          <p id="payment-help" class="form-message"></p>
        </section>
    
        
    
        <section class="card">
          <div class="card-heading"><div><h2>Fulfillment workflow</h2><p class="muted">Shopify remains the source of truth.</p></div></div>
          <div class="button-row">
            <button id="btn-fulfill" class="btn btn-primary">Mark as Fulfilled</button>
            <button id="btn-inprogress" class="btn">Mark as In Progress</button>
            <button id="btn-onhold" class="btn">Mark as On Hold</button>
          </div>
          <p id="workflow-help" class="form-message"></p>
        </section>
    
    
        <div class="detail-grid">
          <section class="card">
            <div class="card-heading">
              <div><h2>Tags</h2><p class="muted">Add or remove tags in Shopify.</p></div>
              <button id="btn-tags" class="btn btn-small">Manage</button>
            </div>
            <div id="tag-list" class="chip-list"></div>
          </section>
          <section class="card">
            <div class="card-heading">
              <div><h2>Order note</h2><p class="muted">Native Shopify order note.</p></div>
              <button id="btn-note" class="btn btn-small">Edit</button>
            </div>
            <p id="order-note" class="note-value">—</p>
          </section>
        </div>
    
        <section class="card">
          <div class="card-heading">
            <div><h2>Metafield note</h2><p class="muted">custom.external_middleware · protected against stale writes</p></div>
            <button id="btn-metafield" class="btn btn-small">Edit</button>
          </div>
          <p id="metafield-note" class="note-value">—</p>
        </section>
      </main>
    
      <div id="dialog-backdrop" class="dialog-backdrop" hidden>
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <div class="dialog-header">
            <div><h2 id="dialog-title"></h2><p id="dialog-description" class="muted"></p></div>
            <button id="dialog-close" class="icon-btn" aria-label="Close">×</button>
          </div>
          <div id="dialog-body" class="dialog-body"></div>
          <p id="dialog-message" class="form-message"></p>
          <div class="dialog-footer">
            <button id="dialog-cancel" class="btn">Cancel</button>
            <button id="dialog-confirm" class="btn btn-primary">Save</button>
          </div>
        </section>
      </div>
      <script src="/order.js"></script>
    </body>
  </html>`);
});

app.get('/api/deliveries', (req, res) => {
  res.json({ total: deliveries.length, deliveries: deliveries.slice(0, 20) });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`Shopify Order Monitor listening on http://localhost:${PORT}`);
  try {
    const required = [
      'read_orders',
      'read_customers',
      'write_orders',
      'read_fulfillments',
      'read_locations',
      'write_fulfillments',
      'write_merchant_managed_fulfillment_orders'
    ];
    const scopes = await shopify.getAccessScopes();
    const missing = required.filter(scope => !scopes.includes(scope));
    if (missing.length) console.warn(`Missing Shopify scopes: ${missing.join(', ')}`);
    const setup = await shopify.ensureOrderMetafieldDefinitions();
    if (setup.created) console.log('Created middleware.status order metafield definition');
    await syncRecentOrdersOnStartup();
  } catch (error) {
    console.warn(`Shopify startup check failed: ${error.message}`);
  }
});
