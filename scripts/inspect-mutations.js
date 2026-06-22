(async()=>{
  try{
    const shopify = require('../services/shopify');
    const q = 'query { __type(name: "Mutation") { fields { name } } }';
    const data = await shopify.graphql(q);
    const fields = data && data.__type && data.__type.fields ? data.__type.fields.map(f=>f.name) : [];
    console.log('mutations:', fields.join('\n'));
  } catch(e) {
    console.error('inspect failed', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
