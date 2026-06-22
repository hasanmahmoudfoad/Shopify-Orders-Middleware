## Phase 2

### Objective

Transform the application from a passive order monitor into an interactive Shopify order management dashboard.

### Shopify Admin API Integration

Add Shopify GraphQL Admin API integration using a secure access token stored in environment variables.
You will find the token need in the "app.env"

### Order Actions

For every order displayed in the dashboard, provide actions to:

* Add Tags
* Add Internal Notes
* Archive Order

### Add Tags

Requirements:

* Add predefined tags
* Add custom tags
* Display existing tags
* Refresh order data after update

### Add Notes

Requirements:

* Add internal notes to orders
* Display current note
* Update notes through GraphQL mutations

Examples:

* Processed by ERP
* Warehouse notified
* Customer contacted

### Archive Orders

Requirements:

* Archive selected order
* Display archive status
* Refresh dashboard after action

### Order Details Page

Display:

* Shopify Order ID
* Order Name
* Customer Information
* Tags
* Notes
* Financial Status
* Fulfillment Status

### Dashboard Improvements

Add action buttons:

* View Details
* Add Tag
* Add Note
* Archive

### Shopify API Layer

Create a dedicated Shopify service module responsible for:

* GraphQL queries
* GraphQL mutations
* Access token handling
* Error handling

### Environment Variables

Store credentials in .env

Required:

* SHOPIFY_STORE
* SHOPIFY_ACCESS_TOKEN

Never hardcode credentials.

### Success Criteria

The user can:

* Select an order
* Add a tag
* Add a note
* Archive the order

Changes must be reflected inside Shopify Admin.
