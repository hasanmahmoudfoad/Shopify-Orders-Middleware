# Workflow Rules

The fulfillment workflow is state-driven.

The application must not allow invalid actions.



## UNFULFILLED

Available actions:

* Mark as Fulfilled
* Mark as On Hold
* Mark as In Progress



## IN_PROGRESS

Available actions:

* Mark as Fulfilled
* Mark as On Hold

The order may still be fulfilled completely or partially.



## ON_HOLD

Available actions:

* Release Hold

Disabled actions:

* Mark as Fulfilled
* Partial Fulfillment
* In Progress

The fulfillment order must be released before any fulfillment operation.

## RELEASED

After releasing the hold:

* Mark as Fulfilled
* Partial Fulfillment
* Mark as On Hold

become available again.


## PARTIALLY_FULFILLED

Available actions:

* Fulfill remaining items
* On Hold

Already fulfilled items should be disabled.

Only unfulfilled line items may be selected.


## FULFILLED

All actions should be disabled.

The order is complete.



# UI Rules

Disabled actions should:

* appear dimmed
* be non-clickable
* display a tooltip explaining why the action is unavailable

Example:

"This order is currently on hold. Release the hold before fulfilling items."



# Source of Truth

The application should use:

* fulfillmentOrder.status
* displayFulfillmentStatus
* middleware.status

to determine available actions.

The UI should never allow actions that Shopify will reject.
