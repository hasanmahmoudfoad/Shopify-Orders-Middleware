const fetch = require('node-fetch');

async function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function run(){
  try{
    console.log('Integration test: posting a fake webhook order');
    const order = {
      id: 'gid://shopify/Order/TEST123',
      numericId: 'TEST123',
      name: '#TEST123',
      order_number: 'TEST123',
      total_price: '10.00',
      created_at: new Date().toISOString(),
      line_items: [ { id: 'gid://shopify/LineItem/1', title: 'Product A', quantity: 1 }, { id: 'gid://shopify/LineItem/2', title: 'Product B', quantity: 2 } ]
    };

    let r = await fetch('http://localhost:3000/webhooks/orders-create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(order) });
    console.log('Webhook response status', r.status);
    await delay(200);

    r = await fetch('http://localhost:3000/api/orders');
    const list = await r.json();
    console.log('Orders list:', JSON.stringify(list, null, 2));

    r = await fetch('http://localhost:3000/api/orders/TEST123');
    const single = await r.json();
    console.log('Single order GET:', JSON.stringify(single, null, 2));

    console.log('Setting middleware status IN_PROGRESS');
    r = await fetch('http://localhost:3000/api/orders/TEST123/status', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: 'IN_PROGRESS' }) });
    const st = await r.json();
    console.log('Status set result:', JSON.stringify(st, null, 2));

    r = await fetch('http://localhost:3000/api/orders');
    const list2 = await r.json();
    console.log('Orders list after status change:', JSON.stringify(list2, null, 2));

    console.log('Integration test complete');
    process.exit(0);
  }catch(e){ console.error('Test error', e); process.exit(1); }
}

run();