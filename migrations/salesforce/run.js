const path = require('path');
const fs = require('fs');
const engine = require('./engine');
const credentialStore = require('../shared/credentialStore');

const ALL_ENTITIES = ['contacts', 'products', 'accounts'];

module.exports = async function runSalesforceMigration(flags) {
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

  // 2. Resolve Prolibu apiKey
  const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
  let apiKey = flags.apikey;

  if (!apiKey && fs.existsSync(profilePath)) {
    try {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      apiKey = profile.apiKey;
    } catch {}
  }
  if (!apiKey) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: `Prolibu API key for "${domain}":`,
      validate: input => input ? true : 'API key is required.',
    });
    apiKey = res.apiKey;
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));
  }

  // 3. Check credentials exist
  const credentials = credentialStore.getCredentials(domain, 'salesforce');
  if (!credentials) {
    console.error(`❌ No Salesforce credentials found for domain "${domain}".`);
    console.error(`   Run: prolibu migrate salesforce configure --domain ${domain}`);
    process.exit(1);
  }

  // 4. Resolve entities to migrate
  let entity = flags.entity;
  if (!entity) {
    const res = await inquirer.default.prompt({
      type: 'list',
      name: 'entity',
      message: 'Which entities do you want to migrate?',
      choices: [
        { name: 'All enabled entities', value: 'all' },
        { name: 'Contacts', value: 'contacts' },
        { name: 'Products', value: 'products' },
        { name: 'Accounts', value: 'accounts' },
      ],
    });
    entity = res.entity;
  }

  const entities = entity === 'all' ? ALL_ENTITIES : [entity];

  // 5. Dry-run flag
  const dryRun = flags['dry-run'] === true || flags.dryRun === true;
  if (dryRun) {
    console.log('⚠️  DRY RUN mode — no data will be written to Prolibu');
    console.log('');
  }

  // 6. Run engine
  await engine.run({ domain, apiKey, entities, dryRun });
};
