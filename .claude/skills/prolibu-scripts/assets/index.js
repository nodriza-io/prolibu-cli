/* eslint-disable no-unused-vars -- `output` is read by the platform after the run */
/* global eventData, scriptCode, output:writable */
// Entry of a Prolibu script: accounts/<domain>/scripts/<prefix>/index.js
// The CLI bundles this file with esbuild. require() works here for your own files, the
// repo's lib/ (four levels up) and pure-JS npm packages; at run time it does not exist.
const Events = require('../../../../lib/vendors/prolibu/EventManager');
const { getVariable } = require('../../../../lib/utils/variables');

// Manual run: GET /v2/script/run?scriptId=<_id>&key=value
Events.on('ApiRun', async () => {
  const query = eventData.query || {};
  console.info(`${scriptCode} ran with ${JSON.stringify(query)}`);
  output = { ok: true, query, greeting: getVariable('greeting') || null };
});

// A record event also needs the object in config.json "lifecycleHooks", e.g. ["Contact"],
// and the object enabled for lifecycle hooks on the account.
// Events.on('Contact.afterUpdate', async () => {
//   const { doc, beforeUpdateDoc } = eventData;
// });

// Keep this the last statement: the run ends when this promise settles.
(async function main() {
  await Events.init();
})();
