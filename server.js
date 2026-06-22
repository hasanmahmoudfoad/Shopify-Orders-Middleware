const express = require('express');
const path = require('path');
const shopify = require('./services/shopify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Generic POST logger: capture any incoming POSTs (helps catch misconfigured webhook URLs)
const deliveries = [];
app.use((req, res, next) => {
  if (req.method === 'POST') {
    try {
      const rec = { path: req.path, headers: req.headers, body: req.body, received_at: new Date().toISOString() };
      deliveries.unshift(rec);
      // append to file for persistence
      const fs = require('fs');
      const p = path.join(__dirname, 'post-deliveries.log');
      fs.appendFile(p, JSON.stringify(rec) + '\n', err => {});
    } catch (e) {
      // ignore logging errors
    }
  }
  next();
});

// In-memory storage for orders
const orders = [];

// Helpers for normalizing IDs
function toGidOrder(id) {
  if (id == null) return id;
  const s = String(id);
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/Order/${s}`;
}

function numericFromAny(id) {
  if (id == null) return '';
  const s = String(id);
  if (s.indexOf('/') >= 0) return s.split('/').pop();
  return s;
}

function normalizeOrderRecord(order) {
  if (!order) return order;
  // prefer existing gid; otherwise convert numeric id to gid
  if (order.id) {
    order.id = toGidOrder(order.id);
  }
  // ensure numericId exists
  order.numericId = order.numericId || numericFromAny(order.id || order.name || order.order_number || '');
  return order;
}

// Startup order loader removed — this app uses webhook-driven in-memory storage.


// Webhook endpoint: Shopify ORDERS_CREATE
app.post('/webhooks/orders-create', (req, res) => {
  const order = req.body || {};
  order.received_at = new Date().toISOString();

  // Normalize id to GID and compute numericId, then store newest first
  normalizeOrderRecord(order);
  orders.unshift(order);

  const orderId = order.id || order.order_number || order.name || 'unknown';
  const customerName = order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : (order.email || 'unknown');

  console.log(`[Webhook] Order ${orderId} from ${customerName} at ${order.received_at}`);

  // Shopify expects a 200 response quickly for webhooks
  res.status(200).send('OK');
});

// Accept Shopify webhook POSTs sent to the root path (some webhooks may be misconfigured)
app.post('/', (req, res) => {
  const topic = req.header('x-shopify-topic');
  if (topic && topic.toLowerCase() === 'orders/create') {
    const order = req.body || {};
    order.received_at = new Date().toISOString();
    normalizeOrderRecord(order);
    orders.unshift(order);
    const orderId = order.id || order.order_number || order.name || 'unknown';
    const customerName = order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : (order.email || 'unknown');
    console.log(`[Webhook(root)] Order ${orderId} from ${customerName} at ${order.received_at}`);
    return res.status(200).send('OK');
  }
  // If not a Shopify orders/create webhook, serve index for GET/other routes
  res.status(200).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: get orders summary
app.get('/api/orders', (req, res) => {
  const summary = orders.map(o => ({
    // expose numeric id for browser-friendly URLs (always numeric string)
    id: String(o.numericId || numericFromAny(o.id) || (o.id && String(o.id).split('/').pop()) || ''),
    gid: String(o.id || ''),
    name: o.name || o.order_number || '',
    customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : '',
    email: o.customer ? o.customer.email : (o.email || ''),
    total: o.total_price ? String(o.total_price) + ' $' : '',
    created_at: o.created_at || '',
    received_at: o.received_at || '',
    fulfillment_status: o.fulfillment_status || o.displayFulfillmentStatus || '',
    middleware_status: o.middleware_status || ''
  }));
  res.json({ total: orders.length, orders: summary });
});

// Helper to locate an order by id/name/order_number (matches existing lookup logic)
function findOrderByParam(idParam) {
  const p = String(idParam || '');
  const isGid = p.startsWith('gid://');
  const numeric = isGid ? numericFromAny(p) : p;
  return orders.find(o => {
    if (!o) return false;
    if (String(o.id) === p) return true; // gid match
    if (o.numericId && String(o.numericId) === numeric) return true; // numeric match
    if (String(o.name) === p) return true;
    if (String(o.order_number) === p) return true;
    return false;
  });
}

// Refresh an order from Shopify and update in-memory store (best-effort)
async function refreshOrderFromShopify(ownerId) {
  try {
    const query = `query getOrder($ownerId: ID!) {
      node(id: $ownerId) {
        ... on Order {
          id
          name
          totalPriceSet { shopMoney { amount currencyCode } }
          createdAt
          tags
          note
          lineItems(first:50) { edges { node { id title quantity currentQuantity fulfillableQuantity variant { id title } } } }
          fulfillmentOrders(first:10) { edges { node { id status assignedLocation { location { id name } } lineItems(first:50) { edges { node { id lineItem { id title } } } } } } }
          displayFulfillmentStatus
          displayFinancialStatus
          metafield(namespace: "custom", key: "external_middleware") { id value }
          metafields(namespace: "middleware", first:10) { edges { node { id key value } } }
        }
      }
    }`;
    const vars = { ownerId };
    const data = await shopify.graphql(query, vars);
    if (data && data.node) {
      const sod = data.node;
      // find existing index by id or name
      const idx = orders.findIndex(o => String(o.id) === String(sod.id) || String(o.name) === String(sod.name) || String(o.order_number) === String(sod.orderNumber));
      const reconstructed = {
        id: sod.id,
        numericId: numericFromAny(sod.id),
        name: sod.name || sod.orderNumber,
        order_number: sod.name,
        total_price: sod.totalPriceSet && sod.totalPriceSet.shopMoney ? sod.totalPriceSet.shopMoney.amount : undefined,
        created_at: sod.createdAt,
        fulfillment_status: sod.displayFulfillmentStatus || sod.fulfillmentStatus,
        tags: sod.tags,
        note: sod.note,
        line_items: (sod.lineItems && sod.lineItems.edges) ? sod.lineItems.edges.map(e=>e.node) : [],
        fulfillmentOrders: (sod.fulfillmentOrders && sod.fulfillmentOrders.edges) ? sod.fulfillmentOrders.edges.map(e=>e.node) : [],
        metafield: sod.metafield || null,
        metafields: (sod.metafields && sod.metafields.edges) ? sod.metafields.edges.map(e=>e.node) : []
      };
      // map middleware.status metafield into middleware_status for UI convenience
      try {
        const mfs = reconstructed.metafields || [];
        const ms = mfs.find(x => x && x.key === 'status');
        if (ms && ms.value) reconstructed.middleware_status = ms.value;
      } catch (e) { /* ignore */ }
      if (idx >= 0) orders[idx] = Object.assign({}, orders[idx], reconstructed);
      else orders.unshift(reconstructed);
      return reconstructed;
    }
  } catch (e) {
    console.error('refreshOrderFromShopify error', e && e.message ? e.message : e);
  }
  return null;
}

// POST /api/orders/:id/tag
app.post('/api/orders/:id/tag', async (req, res) => {
  try {
    const idParam = req.params.id;
    const tags = Array.isArray(req.body.tags) ? req.body.tags : (req.body.tags ? [req.body.tags] : []);
    if (!tags.length) return res.status(400).json({ error: 'No tags provided' });

    const order = findOrderByParam(idParam);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = await shopify.addTagsToOrder(order.id, tags);
    const existing = Array.isArray(order.tags) ? order.tags : (order.tags ? String(order.tags).split(',').map(s=>s.trim()) : []);
    order.tags = Array.from(new Set([...existing, ...tags]));

    res.json({ ok: true, result, order });
  } catch (err) {
    console.error('POST /api/orders/:id/tag error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/orders/:id/note
app.post('/api/orders/:id/note', async (req, res) => {
  try {
    const idParam = req.params.id;
    const note = req.body.note || '';
    if (!note) return res.status(400).json({ error: 'No note provided' });

    const order = findOrderByParam(idParam);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = await shopify.addNoteToOrder(order.id, note);
    order.note = note;

    res.json({ ok: true, result, order });
  } catch (err) {
    console.error('POST /api/orders/:id/note error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/orders/:id/archive
app.post('/api/orders/:id/archive', async (req, res) => {
  try {
    const idParam = req.params.id;
    const order = findOrderByParam(idParam);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = await shopify.archiveOrder(order.id);
    order.archived = true;

    res.json({ ok: true, result, order });
  } catch (err) {
    console.error('POST /api/orders/:id/archive error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Get metafield for an order
app.get('/api/orders/:id/metafield', async (req, res) => {
  try {
    const idParam = req.params.id;
    const ownerId = String(idParam).startsWith('gid://') ? idParam : `gid://shopify/Order/${idParam}`;
    const query = `query getMetafield($ownerId: ID!, $namespace: String!, $key: String!) {
      node(id: $ownerId) {
        ... on Order {
          metafield(namespace: $namespace, key: $key) { id value }
        }
      }
    }`;
    const variables = { ownerId, namespace: 'custom', key: 'external_middleware' };
    const data = await shopify.graphql(query, variables);
    const mf = data && data.node && data.node.metafield ? data.node.metafield : null;
    res.json({ ok: true, metafield: mf });
  } catch (err) {
    console.error('GET /api/orders/:id/metafield error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Set metafield for an order
app.post('/api/orders/:id/metafield', async (req, res) => {
  try {
    const idParam = req.params.id;
    const value = req.body && typeof req.body.value !== 'undefined' ? String(req.body.value) : '';
    if (!value) return res.status(400).json({ error: 'No value provided' });

    const ownerId = String(idParam).startsWith('gid://') ? idParam : `gid://shopify/Order/${idParam}`;
    const mutation = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id value }
        userErrors { message }
      }
    }`;
    const variables = {
      metafields: [
        {
          ownerId,
          namespace: 'custom',
          key: 'external_middleware',
          type: 'single_line_text_field',
          value
        }
      ]
    };

    const result = await shopify.graphql(mutation, variables);
    if (result && result.metafieldsSet && result.metafieldsSet.userErrors && result.metafieldsSet.userErrors.length) {
      return res.status(400).json({ error: result.metafieldsSet.userErrors.map(u=>u.message).join('; ') });
    }

    const mf = result && result.metafieldsSet && result.metafieldsSet.metafields ? result.metafieldsSet.metafields[0] : null;
    res.json({ ok: true, metafield: mf });
  } catch (err) {
    console.error('POST /api/orders/:id/metafield error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Get full order by id (API)
app.get('/api/orders/:id', async (req, res) => {
  const idParam = req.params.id;
  const order = findOrderByParam(idParam);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // Refresh from Shopify to ensure UI sees current fulfillment state
  try {
    const ownerId = String(order.id).startsWith('gid://') ? order.id : `gid://shopify/Order/${order.id}`;
    await refreshOrderFromShopify(ownerId);
  } catch (e) { /* ignore refresh errors */ }
  const fresh = findOrderByParam(idParam) || order;
  res.json({ ok: true, order: fresh });
});

// Release holds on fulfillment orders for an order
app.post('/api/orders/:id/release', async (req, res) => {
  try {
    const idParam = req.params.id;
    const order = findOrderByParam(idParam);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const ownerId = String(order.id).startsWith('gid://') ? order.id : `gid://shopify/Order/${order.id}`;
    const fos = await shopify.getFulfillmentOrders(ownerId, 50);
    if (!fos || !fos.edges) return res.status(400).json({ error: 'No fulfillment orders found in Shopify' });
    const releaseResults = [];
    for (const e of fos.edges) {
      const fo = e.node;
      try {
        if (fo && fo.status && String(fo.status).toUpperCase() === 'ON_HOLD') {
          const releaseRes = await shopify.releaseFulfillmentOrder(fo.id);
          releaseResults.push({ id: fo.id, ok: true, res: releaseRes });
          // small delay to allow Shopify to transition
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        releaseResults.push({ id: fo.id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    try { await refreshOrderFromShopify(ownerId); } catch (e) { /* ignore */ }
    return res.json({ ok: true, results: releaseResults });
  } catch (err) {
    console.error('POST /api/orders/:id/release error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Set middleware status (ON_HOLD, IN_PROGRESS, etc.)
app.post('/api/orders/:id/status', async (req, res) => {
  try {
    const idParam = req.params.id;
    const status = String(req.body && req.body.status || '').toUpperCase();
    if (!['ON_HOLD','IN_PROGRESS','UNFULFILLED','FULFILLED','PARTIALLY_FULFILLED'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const order = findOrderByParam(idParam);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const ownerId = String(order.id).startsWith('gid://') ? order.id : `gid://shopify/Order/${order.id}`;
    if (status === 'ON_HOLD') {
      try {
        const fos = await shopify.getFulfillmentOrders(ownerId, 10);
        if (fos && fos.edges && fos.edges.length) {
          for (const e of fos.edges) {
            const fo = e.node;
            try { await shopify.holdFulfillmentOrder(fo.id, 'OTHER'); } catch (e) { console.error('holdFulfillmentOrder error', e); }
          }
        }
        order.middleware_status = 'ON_HOLD';
      } catch (e) {
        console.error('ON_HOLD processing error', e);
        return res.status(500).json({ error: 'Failed to place fulfillment orders on hold' });
      }
    } else if (status === 'IN_PROGRESS') {
      try {
        await shopify.setOrderMetafield(ownerId, 'middleware', 'status', 'single_line_text_field', 'IN_PROGRESS');
        order.middleware_status = 'IN_PROGRESS';
      } catch (e) {
        console.error('setOrderMetafield error', e);
        return res.status(500).json({ error: 'Failed to set IN_PROGRESS metafield' });
      }
    } else {
      order.middleware_status = status;
    }

    try { await refreshOrderFromShopify(ownerId); } catch (e) { /* ignore refresh errors */ }

    return res.json({ ok: true, order });
  } catch (err) {
    console.error('POST /api/orders/:id/status error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Fulfill selected line items (body.items = array of line item ids)
app.post('/api/orders/:id/fulfill', async (req, res) => {
  try {
    const idParam = req.params.id;
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const order = findOrderByParam(idParam);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const ownerId = String(order.id).startsWith('gid://') ? order.id : `gid://shopify/Order/${order.id}`;

    // Fetch fulfillment orders from Shopify
    const fos = await shopify.getFulfillmentOrders(ownerId, 10);
    if (!fos || !fos.edges || !fos.edges.length) {
      return res.status(400).json({ error: 'No fulfillment orders found for this order in Shopify' });
    }

    // If any fulfillment order is ON_HOLD, attempt to release it before creating fulfillment
    for (const e of fos.edges) {
      const fo = e.node;
      try {
        if (fo && fo.status && String(fo.status).toUpperCase() === 'ON_HOLD') {
          console.log('Found ON_HOLD fulfillmentOrder, attempting release:', fo.id);
          try {
            const releaseRes = await shopify.releaseFulfillmentOrder(fo.id);
            // If release returned userErrors, surface them
            const releaseErrors = (releaseRes && ((releaseRes.fulfillmentOrderRelease && releaseRes.fulfillmentOrderRelease.userErrors) || releaseRes.userErrors)) || [];
            if (releaseErrors && releaseErrors.length) {
              return res.status(400).json({ error: 'Unable to release fulfillment order: ' + releaseErrors.map(u=>u.message || JSON.stringify(u)).join('; ') });
            }
            // small delay to let Shopify transition state
            await new Promise(r => setTimeout(r, 800));
          } catch (releaseErr) {
            console.error('releaseFulfillmentOrder error', releaseErr);
            return res.status(500).json({ error: 'Failed to release fulfillment order before fulfilling: ' + (releaseErr && releaseErr.message ? releaseErr.message : String(releaseErr)) });
          }
        }
      } catch (ex) { /* ignore per-FO errors */ }
    }

    // Build lineItemsByFulfillmentOrder payload
    const byFO = [];
    for (const e of fos.edges) {
      const fo = e.node;
      const foItems = (fo.lineItems && fo.lineItems.edges) ? fo.lineItems.edges.map(x=>x.node) : [];
      const selected = [];
      for (const li of foItems) {
        // li.lineItem.id is a gid like gid://shopify/LineItem/12345
        const lineItemGid = li.lineItem && li.lineItem.id ? String(li.lineItem.id) : '';
        const numericMatch = lineItemGid.split('/').pop();
        const lineQty = (li.lineItem && (li.lineItem.quantity || li.lineItem.requestedQuantity)) ? (li.lineItem.quantity || li.lineItem.requestedQuantity) : 1;
        if (items.length === 0) {
          // if no specific items requested, include all
          selected.push({ id: li.id, quantity: lineQty });
        } else if (items.includes(String(numericMatch)) || items.includes(String(li.lineItem && li.lineItem.id)) || items.includes(String(li.id))) {
          selected.push({ id: li.id, quantity: lineQty });
        }
      }
      if (selected.length) byFO.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: selected });
    }

    if (!byFO.length) {
      return res.status(400).json({ error: 'No matching fulfillment order line items found in Shopify for selected items' });
    }

    // Create fulfillment via Shopify
    try {
      const result = await shopify.createFulfillment(byFO, false);
      if (result && result.fulfillment && result.fulfillment.userErrors && result.fulfillment.userErrors.length) {
        return res.status(400).json({ error: result.fulfillment.userErrors.map(u=>u.message).join('; ') });
      }
      // some stores return the payload under fulfillmentCreate; handle both
      if (result && result.fulfillmentCreate && result.fulfillmentCreate.userErrors && result.fulfillmentCreate.userErrors.length) {
        return res.status(400).json({ error: result.fulfillmentCreate.userErrors.map(u=>u.message).join('; ') });
      }
    } catch (e) {
      console.error('createFulfillment error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Shopify fulfillment API error' });
    }

    // Refresh order from Shopify and return updated order
    try {
      await refreshOrderFromShopify(ownerId);
      const updated = findOrderByParam(order.id) || order;
      return res.json({ ok: true, order: updated });
    } catch (e) {
      return res.json({ ok: true, order, warning: 'Fulfillment created but failed to refresh order' });
    }
  } catch (err) {
    console.error('POST /api/orders/:id/fulfill error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Order details page (server-rendered simple HTML)
app.get('/orders/:id', async (req, res) => {
  const id = req.params.id;
  const order = findOrderByParam(id);
  if (!order) return res.status(404).send(`<h1>Order not found</h1><p>No order matching '${id}'</p>`);

  // Basic HTML display of order details
  const customer = order.customer || {};
  const lineItems = order.line_items || [];
  const shipping = order.shipping_address || customer.default_address || {};
  const address1 = shipping.address1 || shipping.address_1 || '';
  const phone = shipping.phone || customer.phone || order.phone || '';
  const zip = shipping.zip || shipping.zipcode || shipping.postal_code || '';
  const province = shipping.province || shipping.province_code || '';
  const country = shipping.country || shipping.country_code || '';
  const displayName = shipping.name || ((customer.first_name || '') + ' ' + (customer.last_name || '')).trim() || order.name || '';
  console.log('Route param:', id);
  console.log(
    orders.map(o => ({
      id: o.id,
      name: o.name
    }))
  );
  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Order ${order.name || order.id}</title>
      <link rel="stylesheet" href="/styles.css">
    </head>
    <body>
      <div class="container">
        <h1>Order ${order.name || order.id}</h1>
        <section class="card">
          <h2>Customer</h2>
          <p><strong>Name:</strong> ${displayName}</p>
          <p><strong>Email:</strong> ${customer.email || ''}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Address1:</strong> ${address1}</p>
          <p><strong>ZIP:</strong> ${zip}</p>
          <p><strong>Province:</strong> ${province}</p>
          <p><strong>Country:</strong> ${country}</p>
        </section>

        <section class="card">
          <h2>Items</h2>
          <ul>
            ${lineItems.map(li => `<li>${li.quantity} × ${li.title} — ${li.price ? String(li.price) + ' $' : ''}</li>`).join('')}
          </ul>
        </section>

        <section class="card">
          <h2>Totals</h2>
          <p>Total: ${order.total_price ? String(order.total_price) + ' $' : ''}</p>
          <p>Created at: ${order.created_at || ''}</p>
          <p>Received at: ${order.received_at || ''}</p>
        </section>

        <section class="card">
          <h2>Fulfillment</h2>
          <p>
            Status: <span id="ful-status" style="font-weight:600">${order.fulfillment_status || (order.middleware_status || 'UNFULFILLED')}</span>
          </p>
          <p>
            <button id="btn-fulfill" class="btn">Mark as Fulfilled</button>
            <button id="btn-onhold" class="btn">Mark as On Hold</button>
            <button id="btn-release" class="btn" style="display:none;">Release Hold</button>
            <button id="btn-inprogress" class="btn">Mark as In Progress</button>
          </p>
        </section>

        <!-- Fulfillment modal for selecting items -->
        <div id="ful-modal" class="modal" style="display:none;">
          <div class="modal-content">
            <h3>Select items to fulfill</h3>
            <div id="ful-items" style="max-height:300px; overflow:auto; margin-top:8px"></div>
            <div style="margin-top:8px; text-align:right">
              <button id="ful-cancel" class="btn">Cancel</button>
              <button id="ful-confirm" class="btn primary">Confirm</button>
            </div>
            <div id="ful-status-msg" style="margin-top:8px"></div>
          </div>
        </div>

        <section class="card">
          <h2>Metafield</h2>
          <p>
            <strong>external_middleware:</strong>
            <span id="mf-value">—</span>
          </p>
          <p>
            <button id="mf-open" class="btn">Metafield Note</button>
          </p>
        </section>

        <!-- Metafield modal -->
        <div id="mf-modal" class="modal" style="display:none;">
          <div class="modal-content">
            <h3>Add Metafield Note</h3>
            <textarea id="mf-text" rows="6" style="width:100%"></textarea>
            <div style="margin-top:8px; text-align:right">
              <button id="mf-cancel" class="btn">Cancel</button>
              <button id="mf-save" class="btn primary">Save</button>
            </div>
            <div id="mf-status" style="margin-top:8px"></div>
          </div>
        </div>

        <p><a href="/">Back to dashboard</a></p>
      </div>
      <style>
        .modal { position: fixed; left:0; top:0; right:0; bottom:0; background: rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; }
        .modal-content { background:#fff; padding:16px; width:600px; border-radius:6px; box-shadow:0 6px 24px rgba(0,0,0,0.1); }
        .btn { padding:8px 12px; margin-left:6px; }
        .btn.primary { background:#0F172A; color:#fff; }
      </style>
      <script>
        (function(){
          const ORDER_ID = ${JSON.stringify(String(order.id || order.name || order.order_number || ''))};
          const mfValue = document.getElementById('mf-value');
          const btn = document.getElementById('mf-open');
          const fulStatusEl = document.getElementById('ful-status');
          const btnFulfill = document.getElementById('btn-fulfill');
          const btnOnHold = document.getElementById('btn-onhold');
          const btnRelease = document.getElementById('btn-release');
          const btnInProgress = document.getElementById('btn-inprogress');
          const fulModal = document.getElementById('ful-modal');
          const fulItems = document.getElementById('ful-items');
          const fulCancel = document.getElementById('ful-cancel');
          const fulConfirm = document.getElementById('ful-confirm');
          const fulStatusMsg = document.getElementById('ful-status-msg');
          const modal = document.getElementById('mf-modal');
          const txt = document.getElementById('mf-text');
          const cancel = document.getElementById('mf-cancel');
          const save = document.getElementById('mf-save');
          const status = document.getElementById('mf-status');

          function setStatus(msg, err){ status.textContent = msg; status.style.color = err ? 'crimson' : 'inherit'; }
          function setFulStatusMsg(msg, err){ fulStatusMsg.textContent = msg; fulStatusMsg.style.color = err ? 'crimson' : 'inherit'; }

          async function loadMetafield(){
            try{
              const res = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/metafield');
              const j = await res.json();
              if (j && j.metafield && j.metafield.value) mfValue.textContent = j.metafield.value;
              else mfValue.textContent = '—';
            } catch(e){ mfValue.textContent = 'error'; }
          }

          btn && btn.addEventListener('click', ()=>{
            modal.style.display = 'flex';
            setStatus('');
            txt.value = mfValue.textContent && mfValue.textContent !== '—' ? mfValue.textContent : '';
            txt.focus();
          });
          cancel && cancel.addEventListener('click', ()=>{ modal.style.display='none'; });

          save && save.addEventListener('click', async ()=>{
            const v = txt.value || '';
            setStatus('Saving...');
            save.disabled = true; cancel.disabled = true;
            try{
              const res = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/metafield', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ value: v }) });
              const j = await res.json();
              if (!res.ok) {
                setStatus(j && j.error ? j.error : 'Save failed', true);
                save.disabled = false; cancel.disabled = false;
                return;
              }
              // success
              modal.style.display = 'none';
              save.disabled = false; cancel.disabled = false;
              await loadMetafield();
            } catch(e){
              setStatus(e && e.message ? e.message : 'Save failed', true);
              save.disabled = false; cancel.disabled = false;
            }
          });

          // initial load
          loadMetafield();
          // Fulfillment actions
          async function refreshOrder(){
            try{
              const r = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID));
              const j = await r.json();
              if (j && j.order) {
                const st = (j.order.fulfillment_status || j.order.middleware_status || 'UNFULFILLED').toUpperCase();
                fulStatusEl.textContent = st;
                const fos = j.order.fulfillmentOrders || [];
                const hasOnHold = fos.some(f => f && f.status && String(f.status).toUpperCase() === 'ON_HOLD');
                // show release when any fulfillment order is on hold
                if (hasOnHold) {
                  btnRelease.style.display = '';
                } else {
                  btnRelease.style.display = 'none';
                }
                // disable/enable actions based on status
                const isFulfilled = st === 'FULFILLED';
                btnFulfill.disabled = isFulfilled || hasOnHold;
                btnOnHold.disabled = isFulfilled || st === 'ON_HOLD';
                btnInProgress.disabled = isFulfilled || st === 'ON_HOLD';
              }
            }catch(e){/* ignore */}
          }

          btnFulfill && btnFulfill.addEventListener('click', async ()=>{
            try{
              const r = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID));
              const j = await r.json();
              const allItems = (j && j.order && j.order.line_items) || [];
              // determine which items are actually fulfillable (quantity left)
              const fulfillable = allItems.filter(li => {
                const qtyLeft = (typeof li.fulfillableQuantity !== 'undefined') ? li.fulfillableQuantity : ((li.fulfillable_quantity !== undefined) ? li.fulfillable_quantity : ((li.quantity || 0) - (li.currentQuantity || 0)));
                return qtyLeft > 0;
              });
              if (fulfillable.length === 0) {
                setFulStatusMsg('No fulfillable items', true);
                return;
              }
              if (fulfillable.length === 1) {
                // fulfill single item explicitly
                setFulStatusMsg('Fulfilling...', false);
                const id = fulfillable[0].id;
                const resp = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/fulfill', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ items: [id] }) });
                const rr = await resp.json();
                if (!resp.ok) { setFulStatusMsg(rr && rr.error ? rr.error : 'Fulfill failed', true); return; }
                setFulStatusMsg('Fulfilled');
                await refreshOrder();
                return;
              }
              // multiple items: show modal with checkboxes for only unfulfilled items
              fulItems.innerHTML = '';
              fulfillable.forEach(li => {
                const id = li.id;
                const q = li.quantity || 1;
                const el = document.createElement('div');
                var labelText = li.title + (li.variant_title ? ' — ' + li.variant_title : '') + ' (qty: ' + q + ')';
                el.innerHTML = '<label><input type="checkbox" value="' + id + '" /> ' + labelText + '</label>';
                fulItems.appendChild(el);
              });
              fulModal.style.display = 'flex';
            }catch(e){ setFulStatusMsg('Failed to prepare items', true); }
          });

          fulCancel && fulCancel.addEventListener('click', ()=>{ fulModal.style.display='none'; });
          fulConfirm && fulConfirm.addEventListener('click', async ()=>{
            const checks = Array.from(fulItems.querySelectorAll('input[type=checkbox]:checked')).map(i=>i.value);
            if (!checks.length) { setFulStatusMsg('Select at least one item', true); return; }
            setFulStatusMsg('Submitting...');
            try{
              const resp = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/fulfill', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items: checks }) });
              const j = await resp.json();
              if (!resp.ok) { setFulStatusMsg(j && j.error ? j.error : 'Fulfill failed', true); return; }
              fulModal.style.display='none';
              setFulStatusMsg('Done');
              await refreshOrder();
            }catch(e){ setFulStatusMsg('Request failed', true); }
          });

          btnOnHold && btnOnHold.addEventListener('click', async ()=>{
            try{
              const resp = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status: 'ON_HOLD' }) });
              const j = await resp.json();
              if (!resp.ok) { alert(j && j.error ? j.error : 'Failed'); return; }
              await refreshOrder();
            }catch(e){ alert('Error'); }
          });

          btnRelease && btnRelease.addEventListener('click', async ()=>{
            try{
              const resp = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/release', { method: 'POST' });
              const j = await resp.json();
              if (!resp.ok) { alert(j && j.error ? j.error : 'Release failed'); return; }
              await refreshOrder();
            }catch(e){ alert('Error releasing hold'); }
          });

          btnInProgress && btnInProgress.addEventListener('click', async ()=>{
            try{
              const resp = await fetch('/api/orders/' + encodeURIComponent(ORDER_ID) + '/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status: 'IN_PROGRESS' }) });
              const j = await resp.json();
              if (!resp.ok) { alert(j && j.error ? j.error : 'Failed'); return; }
              await refreshOrder();
            }catch(e){ alert('Error'); }
          });

          // initial refresh of fulfillment status
          refreshOrder();
        })();
      </script>
    </body>
    </html>
  `);
  
});

// Simple root route — serve public/index.html via static middleware
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Viewer for recent raw POST deliveries (for debugging Shopify webhook deliveries)
app.get('/api/deliveries', (req, res) => {
  res.json({ total: deliveries.length, deliveries: deliveries.slice(0, 20) });
});

// Debug: return raw in-memory orders (for troubleshooting id normalization)
// (removed) temporary debug endpoint for raw orders

// Admin: force reload latest orders from Shopify (useful for debugging startup loader)
// (debug) /api/reload-orders removed

// Start server (webhook-driven; no startup fetch)
app.listen(PORT, () => {
  console.log(`Shopify Order Monitor listening on http://localhost:${PORT}`);
});
