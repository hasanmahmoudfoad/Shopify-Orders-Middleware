const shopify = require('../services/shopify');

async function run() {
  try {
    // Use the example order admin_graphql_api_id from order-example.md
    const gid = 'gid://shopify/Order/7385117557051';

    console.log('Testing addNoteToOrder...');
    const noteResult = await shopify.addNoteToOrder(gid, 'Test note from local test');
    console.log('addNoteToOrder result:', JSON.stringify(noteResult, null, 2));

    console.log('Testing addTagsToOrder...');
    const tagResult = await shopify.addTagsToOrder(gid, ['test-tag-from-local']);
    console.log('addTagsToOrder result:', JSON.stringify(tagResult, null, 2));

    console.log('Testing archiveOrder...');
    const archiveResult = await shopify.archiveOrder(gid);
    console.log('archiveOrder result:', JSON.stringify(archiveResult, null, 2));

    console.log('Done');
  } catch (err) {
    console.error('Test script error:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

run();
