# PHASE 3 — Fulfillment Management System

## Goal

Implement a fulfillment workflow inside the middleware dashboard with Shopify fulfillment support.

---

## 1. Fulfillment Status Badge

Display the Shopify fulfillment status badge on:

* Orders list page
* Order details page

Supported statuses:

* UNFULFILLED
* FULFILLED
* PARTIALLY_FULFILLED
* ON_HOLD
* IN_PROGRESS

Badge colors:

* UNFULFILLED → gray
* FULFILLED → green
* PARTIALLY_FULFILLED → orange
* ON_HOLD → red
* IN_PROGRESS → blue

---

## 2. Fulfillment Actions

Inside the order details page add three buttons:

* Mark as Fulfilled
* Mark as On Hold
* Mark as In Progress

---

## 3. Mark as Fulfilled Workflow

When the user clicks "Mark as Fulfilled":

### If the order contains only one line item:

* Fulfill the item.
* Update Shopify fulfillment.
* Refresh the order.
* Display FULFILLED status.

### If the order contains multiple line items:

Open a modal.

The modal should display:

* Product title
* Variant title
* Quantity
* Checkbox for each line item

The user can select one or more items.

After clicking Confirm:

* Send the selected line items to the backend.
* The backend should execute the Shopify GraphQL fulfillment mutation.
* Selected items become fulfilled.
* Unselected items remain unfulfilled.

Expected behavior:

* If all items are fulfilled:

  * display FULFILLED
* If some items are fulfilled:

  * display PARTIALLY_FULFILLED

Refresh the order after completion.

---

## 4. On Hold

When the user clicks "On Hold":

* Update the middleware status.
* Display the ON_HOLD badge.
* Prevent fulfillment actions if required.

---

## 5. In Progress

When the user clicks "In Progress":

* Update the middleware status.
* Display the IN_PROGRESS badge.
* Indicate that warehouse processing has started.

---

## 6. Shopify Integration

The backend should use Shopify GraphQL Fulfillment APIs.

Requirements:

* Retrieve fulfillment orders.
* Retrieve fulfillment order line items.
* Fulfill selected line items.
* Refresh the order status after fulfillment.

Shopify should automatically determine:

* FULFILLED
* PARTIALLY_FULFILLED

based on the fulfilled line items.

---

## 7. Components

Create reusable components:

* FulfillmentStatusBadge
* FulfillmentActions
* FulfillmentModal
* LineItemCheckboxList

---

## 8. User Experience

Requirements:

* Loading states
* Success notifications
* Error notifications
* Disabled buttons during requests
* Existing application styling
* Modular implementation
