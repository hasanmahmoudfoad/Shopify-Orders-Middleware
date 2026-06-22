// Request an access token using client credentials and add a note to a Shopify order
const fetch = require('node-fetch');
const path = require('path');
// simple app.env parser (avoid requiring dotenv)
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', 'app.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        const key = m[1];
        let val = m[2] || '';
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    });
  }
} catch (e) {
  /* ignore */
}

(async function(){
  try{
    const SHOP = process.env.SHOPIFY_STORE;
    const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
    const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
    const GRANT = process.env.GRANT_TYPE || 'client_credentials';
    if(!SHOP || !CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing SHOPIFY_STORE/CLIENT_ID/CLIENT_SECRET in app.env');

    const TOKEN_URL = `https://${SHOP}/admin/oauth/access_token`;
    console.log('Requesting token from', TOKEN_URL);
    const tRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: GRANT })
    });
    const tJson = await tRes.json();
    if(!tRes.ok) {
      console.error('Token request failed', tRes.status, tRes.statusText, tJson);
      process.exit(2);
    }
    const token = tJson.access_token;
    console.log('Got token:', token ? '[present]' : '[missing]');

    const API_VER = process.env.SHOPIFY_API_VERSION || '2023-10';
    const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VER}/graphql.json`;

    const gid = 'gid://shopify/Order/7346140938555';
    const note = 'Test note added by add-note-test.js';
    const mutation = `mutation orderUpdate($input: OrderInput!) { orderUpdate(input: $input) { order { id note } userErrors { field message } } }`;
    const variables = { input: { id: gid, note } };

    const gRes = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: mutation, variables })
    });
    const gJson = await gRes.json();
    console.log('GraphQL response status', gRes.status);
    console.log(JSON.stringify(gJson, null, 2));
  }catch(err){
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
})();