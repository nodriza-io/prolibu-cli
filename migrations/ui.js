const path = require('path');
const fs = require('fs');
const startUIServer = require('./ui-server');

/**
 * Auto-discover available CRMs by scanning for folders with a metadata.js file.
 */
function discoverCRMs() {
  const migrationsDir = __dirname;
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, 'metadata.js')))
    .map(d => d.name);
}

module.exports = async function uiMigration(flags) {
  const inquirer = await import('inquirer');

  const availableCRMs = discoverCRMs();
  if (!availableCRMs.length) {
    console.error('❌ No CRM adapters found. Each CRM needs a metadata.js in its folder.');
    process.exit(1);
  }

  // 1. CRM is now optional — selected in the browser if not provided
  let crm = flags.crm || null;
  if (crm) {
    if (!availableCRMs.includes(crm)) {
      console.error(`❌ Unknown CRM: ${crm}`);
      console.log(`Available: ${availableCRMs.join(', ')}`);
      process.exit(1);
    }
  }

  // 2. Resolve domain
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

  // 3. Resolve Prolibu apiKey
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
  if (!fs.existsSync(profilePath) || profileNeedsSave) {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));
  }

  // 5. Start the dashboard
  const crmLabel = crm ? (() => { try { return require(`./${crm}/metadata`).label; } catch { return crm; } })() : null;
  console.log(`\n🚀 Starting Migration Dashboard for ${domain}${crmLabel ? ` (${crmLabel})` : ''}\n`);
  await startUIServer({ domain, apiKey, crm });
};
