'use strict';

const path = require('path');
const fs = require('fs');
const engine = require('./engine');
const credentialStore = require('../../shared/credentialStore');

module.exports = async function runProlibuMigration(flags) {
  const inquirer = await import('inquirer');

  // 1. Resolve destination domain
  let domain = flags.domain;
  if (!domain) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter destination Prolibu domain:',
      validate: (input) => (input ? true : 'Domain is required.'),
    });
    domain = res.domain;
  }
  if (!domain.includes('.')) domain = `${domain}.prolibu.com`;

  // 2. Resolve destination API key
  const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
  let apiKey = flags.apikey;
  if (!apiKey && fs.existsSync(profilePath)) {
    try {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      apiKey = profile.apiKey;
    } catch { }
  }
  if (!apiKey) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: `Destination Prolibu API key for "${domain}":`,
      validate: (input) => (input ? true : 'API key is required.'),
    });
    apiKey = res.apiKey;
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));
  }

  // 3. Verify source credentials exist
  const credentials = credentialStore.getCredentials(domain, 'prolibu');
  if (!credentials) {
    console.error(`❌ No source Prolibu credentials found for domain "${domain}".`);
    console.error(`   Run: prolibu migrate prolibu configure --domain ${domain}`);
    process.exit(1);
  }

  // 4. Parse phases
  const phaseFlag = flags.phase;
  let phases;
  if (phaseFlag && phaseFlag !== 'all') {
    phases = [phaseFlag];
  }

  // 5. --count flag
  const withCount = flags.count === true;

  // 6. Run
  await engine.run({ domain, apiKey, phases, withCount });
};
