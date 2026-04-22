'use strict';

const credentialStore = require('../../shared/credentialStore');

module.exports = async function statusProlibu(flags) {
  const inquirer = await import('inquirer');

  // 1. Resolve domain
  let domain = flags.domain;
  if (!domain) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter Prolibu domain:',
      validate: (input) => (input ? true : 'Domain is required.'),
    });
    domain = res.domain;
  }
  if (!domain.includes('.')) domain = `${domain}.prolibu.com`;

  // 2. Credentials check
  const credentials = credentialStore.getCredentials(domain, 'prolibu');

  console.log('');
  console.log(`🏢 Destination domain: ${domain}`);
  console.log(`🔗 Source Prolibu:     ${credentials ? credentials.sourceDomain : '❌ Not configured'}`);
  console.log('');

  if (!credentials) {
    console.log(`   Configure first: prolibu migrate prolibu configure --domain ${domain}`);
    console.log('');
    return;
  }

  // 3. Discovery summary
  const discovery = credentialStore.loadDiscovery(domain, 'prolibu');
  if (!discovery) {
    console.log('⚠️  No discovery run found yet.');
    console.log(`   Run: prolibu migrate prolibu run --domain ${domain} --phase discover`);
    console.log('');
    return;
  }

  const cfCount = (discovery.customFields || []).length;
  const cobCount = (discovery.customObjects || []).length;
  const scriptCount = (discovery.scripts || []).length;
  const discoveredAt = new Date(discovery.discoveredAt).toLocaleString();

  console.log(`📋 Last discovery: ${discoveredAt}`);
  console.log(`   Custom fields:  ${cfCount}`);
  console.log(`   Custom objects: ${cobCount}`);
  console.log(`   Scripts:        ${scriptCount}`);
  console.log('');
};
