const path = require('path');
const fs = require('fs');
const credentialStore = require('../shared/credentialStore');

const DEFAULT_CONFIG = {
  entities: {
    contacts: { enabled: true },
    products: { enabled: true },
    accounts: { enabled: false },
  },
  batchSize: 200,
};

module.exports = async function configureSalesforce(flags) {
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

  // 3. Salesforce credentials
  const existing = credentialStore.getCredentials(domain, 'salesforce') || {};

  const { instanceUrl } = await inquirer.default.prompt({
    type: 'input',
    name: 'instanceUrl',
    message: 'Salesforce instance URL (e.g. https://yourorg.salesforce.com):',
    default: existing.instanceUrl || flags['instance-url'] || '',
    validate: input => input ? true : 'Instance URL is required.',
  });

  const { clientKey } = await inquirer.default.prompt({
    type: 'input',
    name: 'clientKey',
    message: 'Salesforce Connected App Client Key (Consumer Key):',
    default: existing.clientKey || flags['client-key'] || '',
    validate: input => input ? true : 'Client Key is required.',
  });

  const { clientSecret } = await inquirer.default.prompt({
    type: 'password',
    name: 'clientSecret',
    message: 'Salesforce Connected App Client Secret:',
    validate: input => input ? true : 'Client Secret is required.',
  });

  credentialStore.saveCredentials(domain, 'salesforce', { instanceUrl, clientKey, clientSecret });
  console.log(`✅ Salesforce credentials saved for "${domain}"`);

  // 4. Create config.json with defaults if it doesn't exist
  const created = credentialStore.saveConfig(domain, 'salesforce', DEFAULT_CONFIG);
  if (created) {
    const configPath = credentialStore.getConfigPath(domain, 'salesforce');
    console.log(`✅ Default config.json created: ${configPath}`);
  }

  // 5. Ensure transformers directory exists
  const transformersDir = credentialStore.ensureTransformersDir(domain, 'salesforce');
  console.log(`📁 Transformers override folder ready: ${transformersDir}`);

  console.log('');
  console.log(`🚀 Ready to migrate. Run:`);
  console.log(`   prolibu migrate salesforce run --domain ${domain} --entity all --dry-run`);
};
