const path = require('path');
const migrationLogger = require('../shared/migrationLogger');
const credentialStore = require('../shared/credentialStore');

module.exports = async function statusSalesforce(flags) {
  const inquirer = await import('inquirer');

  // 1. Resolve domain
  let domain = flags.domain;
  if (!domain) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter Prolibu domain:',
      validate: input => input ? true : 'Domain is required.',
    });
    domain = res.domain;
  }

  // 2. Credentials check
  const credentials = credentialStore.getCredentials(domain, 'salesforce');
  const config = credentialStore.getConfig(domain, 'salesforce');

  console.log('');
  console.log(`🏢 Domain: ${domain}`);
  console.log(`🔗 Salesforce: ${credentials ? credentials.instanceUrl : '❌ Not configured'}`);
  console.log('');

  // 3. Config summary
  if (config?.entities) {
    console.log('📋 Entity configuration:');
    for (const [entity, cfg] of Object.entries(config.entities)) {
      const status = cfg.enabled !== false ? '✅ enabled' : '⏭️  disabled';
      const filter = cfg.filter ? ` (filter: ${cfg.filter})` : '';
      console.log(`   ${entity}: ${status}${filter}`);
    }
    console.log('');
  }

  // 4. Last run log
  const log = migrationLogger.readLog(domain, 'salesforce');
  if (!log) {
    console.log('⚠️  No migration runs found yet.');
    if (credentials) {
      console.log(`   Run: prolibu migrate salesforce run --domain ${domain}`);
    } else {
      console.log(`   Configure first: prolibu migrate salesforce configure --domain ${domain}`);
    }
    console.log('');
    return;
  }

  console.log('📜 Last run:');
  migrationLogger.printSummary(log);
};
