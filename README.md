# Shopify Order Monitor

Lightweight middleware to receive Shopify ORDERS_CREATE webhooks and display incoming orders in a simple in-memory dashboard.

Quick start

1. Install dependencies

```bash
npm install
```

2. Start the server

```bash
npm start
```

3. Expose to Shopify (local testing)

Use a tunneling service (ngrok) and configure your Shopify store to send ORDERS_CREATE webhooks to:

`https://<your-tunnel>.ngrok.io/webhooks/orders-create`

API

- POST /webhooks/orders-create  — webhook receiver
- GET  /api/orders              — orders summary
- GET  /orders/:id              — order details page

Data is stored in-memory only; restarting the server clears stored orders.
