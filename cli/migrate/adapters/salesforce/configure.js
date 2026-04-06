const path = require('path');
const fs = require('fs');
const credentialStore = require('../../shared/credentialStore');
const configLoader = require('../../shared/configLoader');

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
  if (!domain.includes('.')) domain = `${domain}.prolibu.com`;

  // 2. Resolve Prolibu apiKey
  const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
  let apiKey = flags.apikey;
  let profileNeedsSave = false;

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
      message: `Prolibu API key for "${domain}":`,
      validate: input => input ? true : 'API key is required.',
    });
    apiKey = res.apiKey;
    profileNeedsSave = true;
  }
  // Persist profile if not already saved (covers --apikey flag path too)
  if (!fs.existsSync(profilePath) || profileNeedsSave) {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));
  }

  // 3. Salesforce credentials
  const existing = credentialStore.getCredentials(domain, 'salesforce') || {};

  let instanceUrl = existing.instanceUrl || flags['instance-url'] || '';
  if (!instanceUrl) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'instanceUrl',
      message: 'Salesforce instance URL (e.g. https://yourorg.salesforce.com):',
      validate: input => input ? true : 'Instance URL is required.',
    });
    instanceUrl = res.instanceUrl;
  }

  let clientKey = existing.clientKey || flags['client-key'] || '';
  if (!clientKey) {
    const res = await inquirer.default.prompt({
      type: 'input',
      name: 'clientKey',
      message: 'Salesforce Connected App Client Key (Consumer Key):',
      validate: input => input ? true : 'Client Key is required.',
    });
    clientKey = res.clientKey;
  }

  let clientSecret = existing.clientSecret || flags['client-secret'] || '';
  if (!clientSecret) {
    const res = await inquirer.default.prompt({
      type: 'password',
      name: 'clientSecret',
      message: 'Salesforce Connected App Client Secret:',
      validate: input => input ? true : 'Client Secret is required.',
    });
    clientSecret = res.clientSecret;
  }

  credentialStore.saveCredentials(domain, 'salesforce', { instanceUrl, clientKey, clientSecret });
  console.log(`✅ Salesforce credentials saved for "${domain}"`);

  // 4. Scaffold configuration files from templates to domain folder
  //    This gives the user local copies of schema, mappings, pipelines, and transforms
  //    that they can customize. All entities come enabled by default — the user removes
  //    what they don't need via the Review UI or by editing the files directly.
  const scaffolded = configLoader.scaffoldConfig(domain, 'salesforce');
  if (scaffolded.length) {
    console.log(`📄 Configuration files ready for customization:`);
    for (const f of scaffolded) {
      console.log(`   ${path.basename(f)}`);
    }
  } else {
    console.log(`📄 Configuration files already exist (not overwritten)`);
  }

  // 5. Ensure transformers directory exists
  const transformersDir = credentialStore.ensureTransformersDir(domain, 'salesforce');
  console.log(`📁 Transformers override folder ready: ${transformersDir}`);

  // 6. Ensure pipelines directory exists
  const pipelinesDir = credentialStore.ensurePipelinesDir(domain, 'salesforce');
  console.log(`📁 Pipelines folder ready: ${pipelinesDir}`);

  console.log('');
  console.log('💡 To customize the migration (disable entities, adjust mappings, etc.):');
  console.log(`   prolibu migrate --ui --domain ${domain} --crm salesforce`);
  console.log(`   Or edit files directly in accounts/${domain}/migrations/salesforce/`);
  console.log('');
  console.log(`🚀 Ready to migrate. Run:`);
  console.log(`   prolibu migrate salesforce run --domain ${domain} --phase discover`);
  console.log(`   prolibu migrate salesforce run --domain ${domain} --entity all --dry-run`);
};
