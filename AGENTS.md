# Shopify Order Monitor

## Project Goal

Build a lightweight Shopify webhook monitoring application for learning Shopify integrations.

The application acts as middleware between Shopify and external systems.

When a Shopify order is created, Shopify sends the order payload to the application through a webhook endpoint.

The application receives the webhook payload, stores the order in memory, and displays incoming orders in a simple dashboard.

This project is intended for learning purposes and should remain simple.

## Shopify Store

* hm-dev-store-2.myshopify.com

## Architecture

* Shopify
* ORDERS_CREATE Webhook
* Express Server
* In-Memory Storage
* Dashboard UI

## Scope

### Included

* Express.js server
* Webhook endpoint
* Receive Shopify order payloads
* Store orders in memory
* Dashboard page
* Orders list
* Order details page
* Logging
* Clean UI


Keep the project intentionally simple.

## Required Webhook

Topic:

* ORDERS_CREATE

Endpoint:

* POST /webhooks/orders-create

## Dashboard Requirements

Route:

* GET /

Display:

* Total orders received
* Latest orders
* Order number
* Customer name
* Customer contact_email
* Order total currency_code
* Order id
* Created date

## Order Details Page

Take a look into "order-example.md" it should gives you an example of what will Shopify sends the data to you (how the data will look like).

Route:

* GET /orders/:id

Display:

* Order ID
* Shopify Order Name
* Customer Information
    - default_address
    - customer_id
    - province
    - country
* Line Items
    - variant_id
    - price
    - title
    - variant_title
* Quantities
* Total Price
* Total financial_status


## Data Storage

Use in-memory storage only.

Example:

* const orders = []

No database.

Data reset after server restart is acceptable.

## Logging

Log every incoming webhook request.

Display:

* Order Number
* Customer Name
* Timestamp

## UI Design

Style:

* Modern SaaS Dashboard
* Minimal

## Color Scheme

Primary:

* #0F172A

Secondary:

* #1E293B

Accent:

* #22C55E

Background:

* #F8FAFC

Card Background:

* #FFFFFF

Border:

* #E2E8F0

Success:

* #10B981

Text:

* #0F172A

Muted Text:

* #64748B

Notify backgrounnd:

* #fa3737

## Dashboard Layout

* Header
* Statistics Section
* Orders Table
* Order Details Page

### Statistics Section

Display:

* Total Orders
* Last Order Received

### Orders Table

Columns:

* Order Number
* Customer
* Email
* Total
* Created At

## Technical Stack

Backend:

* Node.js
* Express.js

Frontend:

* Plain HTML
* CSS
* JavaScript

Do not implement future phases unless explicitly requested.

## Success Criteria

* Shopify sends ORDERS_CREATE webhook
* Express receives payload
* Order appears in dashboard
* User can inspect full order details
* Project remains simple and easy to understand

## Development Rules 

* Keep code simple
* Avoid over-engineering
* Avoid unnecessary abstractions
* Prefer readability over optimization
* Add comments explaining Shopify-specific logic
* Use Express.js best practices
* Keep all order data in memory
* Focus on learning Shopify integrations
