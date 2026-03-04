/**
 * migrations/index.js
 *
 * Top-level router for `prolibu migrate <crm> <command> [options]`
 *
 * To add a new CRM (e.g. HubSpot):
 *   1. Create migrations/hubspot/ following the same structure as migrations/salesforce/
 *   2. Add a case below: else if (crm === 'hubspot')
 */
module.exports = async function migrateHandler(command, flags, args) {
  // In the prolibu binary: objectType=migrate, command=<crm>, args[2]=<subcommand>
  const crm = command;            // e.g. 'salesforce'
  const subcommand = args[2];     // e.g. 'configure', 'run', 'status'

  if (!crm) {
    console.log('Usage: prolibu migrate <crm> <command> [options]');
    console.log('');
    console.log('CRMs:');
    console.log('  salesforce   Migrate from Salesforce to Prolibu');
    console.log('');
    console.log('Examples:');
    console.log('  prolibu migrate salesforce configure --domain dev10.prolibu.com');
    console.log('  prolibu migrate salesforce run --domain dev10.prolibu.com --entity all');
    console.log('  prolibu migrate salesforce status --domain dev10.prolibu.com');
    return;
  }

  if (crm === 'salesforce') {
    const salesforceHandler = require('./salesforce/index');
    await salesforceHandler(subcommand, flags, args);
  } else {
    console.error(`❌ Unknown CRM: ${crm}`);
    console.log('Available CRMs: salesforce');
    process.exit(1);
  }
};
