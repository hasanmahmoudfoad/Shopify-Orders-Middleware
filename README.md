# 🚀 Shopify Order Middleware

A lightweight Shopify middleware application for monitoring, managing, and processing Shopify orders using Shopify Admin GraphQL APIs.

This project receives Shopify webhooks, displays orders in a dashboard, and provides fulfillment management features similar to ERP and warehouse systems.

---

# ✨ Features

## 📦 Order Dashboard

* View incoming Shopify orders.
* Order details page.
* Order status indicators.
* Real-time order updates.

---

## 🏷️ Order Status Management

Supported statuses:

* Unfulfilled
* In Progress
* On Hold
* Partially Fulfilled
* Fulfilled

Visual badges are displayed on:

* Orders list
* Order details page

---

## 🚚 Fulfillment Management

### Mark as Fulfilled

* Single item fulfillment.
* Multiple item fulfillment.
* Partial fulfillment support.
* Shopify automatically calculates:

  * FULFILLED
  * PARTIALLY_FULFILLED

### On Hold

* Place fulfillment orders on hold.
* Release hold support.
* Prevent invalid fulfillment actions while on hold.

### In Progress

* Internal middleware status.
* Stored using Shopify order metafields.

---

## 📝 Order Notes

Add custom notes directly to orders.

Notes are stored using Shopify metafields.

* namespace: custom
* key: external_middleware

---

## 🏷️ Order Tags

* Add Shopify tags.
* Synchronize tags with Shopify.
* Display tags inside the dashboard.

---

## 📦 Archive Orders

* Archive completed orders.
* Synchronize archived status with Shopify.

---

## 🔄 Shopify Synchronization

The application uses Shopify as the source of truth.

After every action:

* Refresh order data.
* Refresh fulfillment status.
* Refresh metafields.
* Refresh tags.
* Update UI automatically.

---

# 🛠 Shopify GraphQL Features

The application integrates with:

* fulfillmentCreate
* fulfillmentOrderHold
* fulfillmentOrderReleaseHold
* metafieldsSet
* tagsAdd
* orderArchive

---

# 📡 Webhooks

Currently supported:

* orders/create

Optional webhooks for future enhancements:

* fulfillments/update
* fulfillment_orders/placed_on_hold
* fulfillment_orders/hold_released

---

# 🏗 Architecture

```text
Shopify
    ↓
Webhook
    ↓
Middleware Server
    ↓
GraphQL API
    ↓
Dashboard UI
```

The middleware acts as a lightweight Order Management System.

---

# 🚀 Getting Started

## 1. Install dependencies

```bash
npm install
```

---

## 2. Configure environment variables

```env
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your-access-token

CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret
```

---

## 3. Start the server

```bash
npm start
```

---

## 4. Expose the application

```bash
cloudflared tunnel --url http://localhost:3000
```

Configure Shopify webhooks to point to:

```text
https://your-tunnel.trycloudflare.com/webhooks/orders-create
```

---

# 📚 API Endpoints

## Orders

```text
GET /api/orders
GET /api/orders/:id
GET /orders/:id
```

---

## Fulfillment

```text
POST /api/orders/:id/fulfill
POST /api/orders/:id/hold
POST /api/orders/:id/release-hold
```

---

## Metafields

```text
POST /api/orders/:id/order-metafields
```

---

## Tags

```text
POST /api/orders/:id/tags
```

---

# ⚠ Current Storage

The application currently uses:

* In-memory order storage.
* Webhook-driven synchronization.

Restarting the server clears locally stored orders.

Future improvements:

* SQLite support.
* PostgreSQL support.
* Persistent order synchronization.

---

# 🧠 Technical Stack

* Node.js
* Express
* Shopify Admin GraphQL API
* Shopify Webhooks
* Cloudflare Tunnel
* Vanilla JavaScript
* HTML/CSS

---

# 🎯 Project Goals

This middleware demonstrates:

* Shopify GraphQL integrations.
* Fulfillment workflows.
* Order management systems.
* ERP-style order processing.
* Warehouse management concepts.
* Shopify middleware architecture.

---

# 👨‍💻 Developed For

Learning:

* Shopify GraphQL
* Fulfillment APIs
* Middleware architecture
* ERP integrations
* Order management workflows
* Shopify application development



# ⚠ Known Limitations In the mean time 6/2026

## Partial Quantity Fulfillment

Currently, the application supports:

* Full line item fulfillment.
* Partial fulfillment by selecting line items.

However, when a line item contains multiple quantities of the same product:

Example:

* Snowboard × 2

The current fulfillment modal treats the line item as a single selectable item.

Selecting the item will fulfill the entire quantity.

Current behavior:

```text
Snowboard × 2
☑ Selected
→ Quantity fulfilled: 2
```

The application does not yet support:

* Quantity selectors.
* Increment/decrement controls.
* Fulfilling individual quantities from the same line item.

Future improvement:

```text
Snowboard × 2

[-] 1 [+]

Quantity to fulfill: 1
Remaining quantity: 1
```

This feature is planned for a future release.

---

## UI Improvements

Several user interface improvements are planned:

* Improved fulfillment modal layout.
* Better status badge styling.
* Order timeline visualization.
* Confirmation dialogs.
* Mobile responsiveness improvements.
* Loading skeletons.
* Toast notifications.
* Enhanced order filtering and search.
