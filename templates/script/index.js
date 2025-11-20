/**
 * Prolibu Basic Script Template - Simple Event Handler
 */

/* global eventName, eventData, env, axios, variables, setVariable */

const Events = require('../../../lib/vendors/prolibu/EventManager');

console.log('🚀 Script started');

// Handle API Run events
Events.on('ApiRun', async () => {
  console.log('📡 API Run event triggered');
  
  // Simulate some async processing
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('✅ API processing completed');
});

(async function main() {
  await Events.init();
})();