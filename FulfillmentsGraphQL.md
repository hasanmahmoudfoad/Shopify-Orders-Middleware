# Workflow

## Order Page

The order details page should display:

* Order information
* Fulfillment status badge
* Order metafields
* Fulfillment actions

## Available Actions

The following actions should be available:

* Mark as Fulfilled
* Mark as On Hold
* Mark as In Progress

---

## Fulfillment Process

### Single Item Order

When the order contains one line item:

1. The user clicks "Mark as Fulfilled".
2. Retrieve the fulfillment order.
3. Retrieve the fulfillment order line item.
4. Execute the `fulfillmentCreate` mutation.
5. Refresh the order.
6. Update the fulfillment badge.

---

### Multiple Item Order

When the order contains multiple line items:

1. The user clicks "Mark as Fulfilled".
2. Open the fulfillment modal.
3. Display all line items.
4. Allow the user to select one or more items.
5. Submit the selected items.
6. Execute the `fulfillmentCreate` mutation.
7. Refresh the order.
8. Update the fulfillment badge.

---

## Partial Fulfillment Rules

If all line items are fulfilled:

* Shopify returns `FULFILLED`.

If some line items remain unfulfilled:

* Shopify returns `PARTIALLY_FULFILLED`.

The application should never calculate these statuses manually.

---

## On Hold Process

1. The user clicks "On Hold".
2. Execute the `fulfillmentOrderHold` mutation.
3. Refresh the order.
4. Update the status badge.

---

## In Progress Process

1. The user clicks "In Progress".
2. Save the status in the middleware metafield.
3. Refresh the order.
4. Update the status badge.

---

## Refresh Rules

After every action:

* Reload the order.
* Reload fulfillment orders.
* Reload metafields.
* Refresh the status badge.
* Refresh the order details page.

---

## Source of Truth

The application should always use Shopify as the source of truth for:

* displayFulfillmentStatus
* fulfillmentOrders
* fulfilled quantities
* fulfillment statuses
* order metafields
