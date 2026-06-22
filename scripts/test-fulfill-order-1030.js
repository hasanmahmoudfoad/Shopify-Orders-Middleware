const shopify = require('../services/shopify');

async function run(){
  try{
    const orderNumber = 1030;
    console.log('Searching for order_number=' + orderNumber);
    const q = `query findOrder($q: String!) { orders(first:1, query: $q) { edges { node { id name lineItems(first:50){ edges{ node{ id title quantity } } } } } } }`;
    let vars = { q: `order_number:${orderNumber}` };
    let data;
    try { data = await shopify.graphql(q, vars); } catch (e) { console.error('GraphQL error while searching by order_number', e); }
    if ((!data || !data.orders || !data.orders.edges || !data.orders.edges.length)){
      // fallback search by name
      console.log('Fallback: searching by name');
      vars = { q: `name:#${orderNumber}` };
      data = await shopify.graphql(q, vars);
    }

    const edge = data && data.orders && data.orders.edges && data.orders.edges[0];
    if (!edge){
      console.error('Order not found in Shopify');
      process.exit(2);
    }

    const order = edge.node;
    console.log('Found order:', order.id, order.name);

    // Get fulfillment orders
    const fos = await shopify.getFulfillmentOrders(order.id, 10);
    console.log('Fulfillment orders:', JSON.stringify(fos, null, 2));

    if (fos && fos.edges && fos.edges.length){
      for (const e of fos.edges){
        const fo = e.node;
        console.log('Processing FO:', fo.id, 'status=', fo.status);
        // list FO line items
        const foItems = (fo.lineItems && fo.lineItems.edges) ? fo.lineItems.edges.map(x=>x.node) : [];
        console.log('FO line items:', JSON.stringify(foItems, null, 2));

        // If FO is ON_HOLD, attempt to release it before creating fulfillment
        if (fo && fo.status && String(fo.status).toUpperCase() === 'ON_HOLD') {
          try {
            console.log('FO is ON_HOLD — attempting release', fo.id);
            const rel = await shopify.releaseFulfillmentOrder(fo.id);
            console.log('Release result:', JSON.stringify(rel, null, 2));
            // allow a moment for Shopify to transition
            await new Promise(r => setTimeout(r, 800));
          } catch (e) {
            console.error('Release error', e);
          }
        }

        // Build fulfillment payload: include all foItems
        const lineItemsByFulfillmentOrder = [];
        const selected = foItems.map(li => ({ id: li.id, quantity: (li.lineItem && (li.lineItem.quantity || li.lineItem.requestedQuantity)) ? (li.lineItem.quantity || li.lineItem.requestedQuantity) : 1 }));
        if (selected.length) lineItemsByFulfillmentOrder.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: selected });

        if (lineItemsByFulfillmentOrder.length){
          try{
            const res = await shopify.createFulfillment(lineItemsByFulfillmentOrder, false);
            console.log('createFulfillment result:', JSON.stringify(res, null, 2));
          } catch (e){ console.error('createFulfillment error', e); }
        }
      }
    } else {
      console.log('No fulfillment orders found for this order');
    }

    // Set IN_PROGRESS metafield
    try{
      const mf = await shopify.setOrderMetafield(order.id, 'middleware', 'status', 'single_line_text_field', 'IN_PROGRESS');
      console.log('setOrderMetafield result:', JSON.stringify(mf, null, 2));
    } catch (e){ console.error('setOrderMetafield error', e); }

    console.log('Done');
    process.exit(0);
  }catch(e){
    console.error('Fatal error', e);
    process.exit(1);
  }
}

run();
