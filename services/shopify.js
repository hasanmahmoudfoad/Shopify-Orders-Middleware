// Lightweight Shopify GraphQL service used by server.js
// Loads credentials from process.env or ./app.env (via dotenv)
const fetch = require('node-fetch');
const path = require('path');

// Load app.env if present (safe; won't override existing env vars)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', 'app.env') });
} catch (e) {
  // dotenv not installed; fallback to simple parser of app.env
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', 'app.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split(/\r?\n/).forEach(line => {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) {
          const key = m[1];
          let val = m[2] || '';
          // remove surrounding quotes
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = val;
        }
      });
    }
  } catch (e2) {
    /* ignore */
  }
}

const SHOP = process.env.SHOPIFY_STORE;
const API_VER = process.env.SHOPIFY_API_VERSION || '2026-04';

if (!SHOP) {
  console.warn('services/shopify: SHOPIFY_STORE not set. API calls will fail until provided.');
}

const GRAPHQL_URL = SHOP ? `https://${SHOP}/admin/api/${API_VER}/graphql.json` : null;

// Token management: check existing env values and refresh when expired or missing.
const TOKEN_ENDPOINT = SHOP ? `https://${SHOP}/admin/oauth/access_token` : null;

function readExpiryFromEnv() {
  const v = process.env.SHOPIFY_ACCESS_TOKEN_EXPIRES_AT;
  if (!v) return 0;
  const n = Number(v);
  if (!n || Number.isNaN(n)) return 0;
  return n;
}

async function persistTokenToAppEnv(token, expiresAt) {
  // try to write back to app.env next to project root if present so manual inspection works
  try {
    const fs = require('fs');
    const p = path.join(__dirname, '..', 'app.env');
    let content = '';
    if (fs.existsSync(p)) content = fs.readFileSync(p, 'utf8');

    const setOrAdd = (key, value, src) => {
      const re = new RegExp('^' + key + '\\s*=.*$', 'm');
      if (re.test(src)) {
        return src.replace(re, `${key}=${value}`);
      }
      if (src && !src.endsWith('\n')) src += '\n';
      return src + `${key}=${value}\n`;
    };

    content = setOrAdd('SHOPIFY_ACCESS_TOKEN', token, content);
    content = setOrAdd('SHOPIFY_ACCESS_TOKEN_EXPIRES_AT', String(expiresAt), content);

    fs.writeFileSync(p, content, 'utf8');
  } catch (e) {
    // non-fatal
    // console.warn('Could not persist token to app.env', e);
  }
}

async function requestNewAccessToken() {
  if (!TOKEN_ENDPOINT) throw new Error('Token endpoint not available (SHOPIFY_STORE missing)');
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const grant = process.env.GRANT_TYPE || 'client_credentials';
  if (!clientId || !clientSecret) throw new Error('SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET missing from environment');

  const body = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: grant
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token request failed: ${res.status} ${res.statusText} ${text}`);
  }

  const json = await res.json();
  const accessToken = json.access_token || json.accessToken || json.token;
  const expiresIn = Number(json.expires_in || json.expires || 0);
  if (!accessToken) throw new Error('Token response did not include access_token');

  // expiresAt in epoch ms
  const expiresAt = expiresIn > 0 ? (Date.now() + (expiresIn * 1000)) : 0;

  // persist to process.env for runtime usage
  process.env.SHOPIFY_ACCESS_TOKEN = accessToken;
  process.env.SHOPIFY_ACCESS_TOKEN_EXPIRES_AT = String(expiresAt);

  // try to persist to app.env for transparency
  persistTokenToAppEnv(accessToken, expiresAt).catch(() => {});

  return { accessToken, expiresAt, expiresIn };
}

async function ensureAccessToken() {
  const current = process.env.SHOPIFY_ACCESS_TOKEN;
  const expiresAt = readExpiryFromEnv();
  const now = Date.now();

  if (current && expiresAt && now < expiresAt - 5000) {
    // token exists and not expired (5s buffer)
    return current;
  }

  // request new token
  const t = await requestNewAccessToken();
  return t.accessToken;
}

function toGidOrder(id) {
  if (!id) return id;
  const s = String(id);
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/Order/${s}`;
}

async function graphql(query, variables = {}) {
  if (!GRAPHQL_URL) throw new Error('Shopify store not configured (SHOPIFY_STORE)');
  const token = await ensureAccessToken();
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    // GraphQL-level errors
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
}

async function addTagsToOrder(orderId, tags = []) {
  const gid = toGidOrder(orderId);
  // Shopify OrderInput often accepts tags as a comma-separated string
  const tagsString = Array.isArray(tags) ? tags.join(', ') : String(tags || '');
  const mutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id tags }
        userErrors { field message }
      }
    }
  `;
  const variables = { input: { id: gid, tags: tagsString } };
  return graphql(mutation, variables);
}

async function addNoteToOrder(orderId, note = '') {
  const gid = toGidOrder(orderId);
  const mutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `;
  const variables = { input: { id: gid, note } };
  return graphql(mutation, variables);
}

async function archiveOrder(orderId) {
  const gid = toGidOrder(orderId);
  // Not all Admin APIs provide an explicit archive mutation. As a safe fallback
  // tag the order with "archived" and return the tags result so the UI can
  // reflect archived state. This updates Shopify (tags) and marks locally.
  return addTagsToOrder(gid, ['archived']);
}

// Retrieve fulfillment orders and their line items for a given Order ID (gid or numeric)
async function getFulfillmentOrders(orderId, first = 10) {
  const ownerId = String(orderId).startsWith('gid://') ? orderId : toGidOrder(orderId);
  const query = `query getFulfillmentOrders($ownerId: ID!, $first: Int!) {
    node(id: $ownerId) {
      ... on Order {
        id
        name
        fulfillmentOrders(first: $first) {
          edges {
            node {
              id
              status
              assignedLocation { location { id name } }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    lineItem { id title quantity }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;
  const variables = { ownerId, first };
  const data = await graphql(query, variables);
  return data && data.node && data.node.fulfillmentOrders ? data.node.fulfillmentOrders : null;
}

// Create fulfillment(s) via Shopify GraphQL `fulfillmentCreate`
async function createFulfillment(lineItemsByFulfillmentOrder, notifyCustomer = false) {
  // Build an inline mutation string (no GraphQL input variable types) because this store
  // does not support FulfillmentCreateInput/FulfillmentCreateV2Input.
  // lineItemsByFulfillmentOrder: [{ fulfillmentOrderId, fulfillmentOrderLineItems: [{ id, quantity }] }, ...]
  if (!Array.isArray(lineItemsByFulfillmentOrder) || lineItemsByFulfillmentOrder.length === 0) {
    throw new Error('No fulfillment order line items provided');
  }

  // Helper to build the FO line items block
  const foBlocks = lineItemsByFulfillmentOrder.map(fo => {
    const foId = JSON.stringify(String(fo.fulfillmentOrderId));
    const liBlocks = (fo.fulfillmentOrderLineItems || []).map(li => {
      const liId = JSON.stringify(String(li.id));
      const qty = Number(li.quantity || 1);
      return `{ id: ${liId} quantity: ${qty} }`;
    }).join(' ');
    return `{
      fulfillmentOrderId: ${foId}
      fulfillmentOrderLineItems: [ ${liBlocks} ]
    }`;
  }).join(' ');

  const notify = notifyCustomer ? 'true' : 'false';
  const mutation = `mutation {
    fulfillmentCreate(
      fulfillment: {
        notifyCustomer: ${notify}
        lineItemsByFulfillmentOrder: [ ${foBlocks} ]
      }
    ) {
      fulfillment {
        id
        status
      }
      userErrors { message }
    }
  }`;

  // Execute the inline mutation (no variables)
  return await graphql(mutation);
}

// Hold a fulfillment order
async function holdFulfillmentOrder(fulfillmentOrderId, reason = 'OTHER') {
  // Introspect the mutation args for fulfillmentOrderHold and call it with appropriate variables.
  try {
    const introspect = `query { __type(name: \"Mutation\") { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } } } }`;
    const meta = await graphql(introspect);
    const fields = meta && meta.__type && meta.__type.fields ? meta.__type.fields : [];
    const foField = fields.find(f => f.name === 'fulfillmentOrderHold');
    if (!foField) throw new Error('fulfillmentOrderHold not present in mutation type');

    const args = foField.args || [];

    // helper to get base type name
    function baseTypeName(t) {
      if (!t) return null;
      if (t.name) return t.name;
      if (t.ofType) return baseTypeName(t.ofType);
      return null;
    }

    // helper to stringify GraphQL type from introspection
    function typeToString(t) {
      if (!t) return 'String';
      if (t.kind === 'NON_NULL') return typeToString(t.ofType) + '!';
      if (t.kind === 'LIST') return '[' + typeToString(t.ofType) + ']';
      return t.name || 'String';
    }

    const varDefs = args.map(a => `$${a.name}: ${typeToString(a.type)}`).join(', ');
    const callArgs = args.map(a => `${a.name}: $${a.name}`).join(', ');
    const mutation = `mutation holdFO(${varDefs}) { fulfillmentOrderHold(${callArgs}) { fulfillmentOrder { id status } userErrors { field message } } }`;

    const variables = {};
    for (const a of args) {
      const name = a.name;
      const base = baseTypeName(a.type);
      if (base === 'ID') variables[name] = fulfillmentOrderId;
      else if (base && base.toLowerCase().includes('fulfillmentorderholdinput')) {
        // inspect expected input fields and populate best-effort
        const inputTypeName = base;
        try {
          const inMeta = await graphql(`query { __type(name: \"${inputTypeName}\") { inputFields { name type { name kind ofType { name kind } } } } }`);
          const inputFields = inMeta && inMeta.__type && inMeta.__type.inputFields ? inMeta.__type.inputFields.map(f=>f.name) : [];
          const obj = {};
          for (const f of inputFields) {
            const fn = f;
            if (['reason','holdReason','fulfillmentHoldReason'].includes(fn)) obj[fn] = reason;
            else if (['fulfillmentOrderId','fulfillment_order_id','fulfillmentOrder','orderId','id','fulfillment_order'].includes(fn)) obj[fn] = fulfillmentOrderId;
          }
          variables[name] = obj;
        } catch (e) {
          variables[name] = { fulfillmentOrderId, reason };
        }
      } else if (name.toLowerCase().includes('id')) {
        variables[name] = fulfillmentOrderId;
      }
    }

    return await graphql(mutation, variables);
  } catch (err) {
    // As a last attempt, try the simple id-based mutation (some stores expect id: ID!)
    try {
      const simple = `mutation holdFO($id: ID!) { fulfillmentOrderHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }`;
      const r = await graphql(simple, { id: fulfillmentOrderId });
      return r;
    } catch (e2) {
      // best-effort fallback: set metafield to ON_HOLD and rethrow original error
      try {
        const q = `query getFO($id: ID!){ node(id:$id){ ... on FulfillmentOrder { order { id } } } }`;
        const data = await graphql(q, { id: fulfillmentOrderId });
        const orderGid = data && data.node && data.node.order && data.node.order.id ? data.node.order.id : null;
        if (orderGid) await setOrderMetafield(orderGid, 'middleware', 'status', 'single_line_text_field', 'ON_HOLD');
      } catch (e3) { /* ignore */ }
      throw err;
    }
  }
}

// Release a fulfillment order (undo hold) — introspection-aware with simple fallback
async function releaseFulfillmentOrder(fulfillmentOrderId) {
  try {
    const introspect = `query { __type(name: \"Mutation\") { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } } } }`;
    const meta = await graphql(introspect);
    const fields = meta && meta.__type && meta.__type.fields ? meta.__type.fields : [];
    // find a mutation that looks like a release operation for fulfillment orders
    let foField = fields.find(f => f.name === 'fulfillmentOrderRelease');
    if (!foField) {
      foField = fields.find(f => /fulfillment.*release/i.test(f.name));
    }
    if (!foField) throw new Error('fulfillmentOrderRelease not present in mutation type');

    const args = foField.args || [];
    function baseTypeName(t) {
      if (!t) return null;
      if (t.name) return t.name;
      if (t.ofType) return baseTypeName(t.ofType);
      return null;
    }
    function typeToString(t) {
      if (!t) return 'String';
      if (t.kind === 'NON_NULL') return typeToString(t.ofType) + '!';
      if (t.kind === 'LIST') return '[' + typeToString(t.ofType) + ']';
      return t.name || 'String';
    }

    const varDefs = args.map(a => `$${a.name}: ${typeToString(a.type)}`).join(', ');
    const callArgs = args.map(a => `${a.name}: $${a.name}`).join(', ');
    const mutationName = foField.name || 'fulfillmentOrderRelease';
    const mutation = `mutation releaseFO(${varDefs}) { ${mutationName}(${callArgs}) { fulfillmentOrder { id status } userErrors { field message } } }`;

    const variables = {};
    for (const a of args) {
      const name = a.name;
      const base = baseTypeName(a.type);
      if (base === 'ID') variables[name] = fulfillmentOrderId;
      else if (name.toLowerCase().includes('id')) variables[name] = fulfillmentOrderId;
      else {
        // best-effort fields
        variables[name] = fulfillmentOrderId;
      }
    }

    return await graphql(mutation, variables);
  } catch (err) {
    // fallback: try common names
    try {
      const tries = [
        'mutation releaseFO($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }',
        'mutation releaseFO($id: ID!) { fulfillmentOrderRelease(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }',
        'mutation releaseFO($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }'
      ];
      for (const t of tries) {
        try {
          const r = await graphql(t, { id: fulfillmentOrderId });
          return r;
        } catch (e) { /* try next */ }
      }
      throw err;
    } catch (e2) {
      throw err;
    }
  }
}

// Set a single metafield on an owner (Order)
async function setOrderMetafield(ownerId, namespace, key, type, value) {
  const mutation = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message }
    }
  }`;
  const variables = { metafields: [{ ownerId, namespace, key, type, value }] };
  return graphql(mutation, variables);
}

module.exports = {
  graphql,
  addTagsToOrder,
  addNoteToOrder,
  archiveOrder,
  getFulfillmentOrders,
  createFulfillment,
  holdFulfillmentOrder,
  releaseFulfillmentOrder,
  setOrderMetafield
};
