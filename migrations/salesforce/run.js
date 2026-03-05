const path = require('path');
const fs = require('fs');
const engine = require('./engine');
const credentialStore = require('../shared/credentialStore');

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

  // 3. Check credentials exist
  const credentials = credentialStore.getCredentials(domain, 'salesforce');
  if (!credentials) {
    console.error(`❌ No Salesforce credentials found for domain "${domain}".`);
    console.error(`   Run: prolibu migrate salesforce configure --domain ${domain}`);
    process.exit(1);
  }

  // 4. Resolve phases to run — do this before entity prompt so we can skip it
  //    --phase discover|migrate|all  (default: all phases)
  //    --from <n> --to <n>           (1-based phase index range)
  let phases;
  let from;
  let to;

  const phaseFlag = flags.phase;
  if (phaseFlag && phaseFlag !== 'all') {
    phases = [phaseFlag];
  } else if (flags.from !== undefined || flags.to !== undefined) {
    from = flags.from ? Number(flags.from) : undefined;
    to = flags.to ? Number(flags.to) : undefined;
  }
  // else: run all phases in order (phases/from/to all undefined)

  // Determine if the selected phases require entities (discover does not)
  const needsEntities = !phases || phases.some((p) => p === 'migrate');

  // 5. Resolve entities to migrate (skip if only running discover)
  let entities = ['all'];
  if (needsEntities) {
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
    entities = entity === 'all' ? ['all'] : [entity];
  }

  // 6. Dry-run flag
  const dryRun = flags['dry-run'] === true || flags.dryRun === true;
  if (dryRun) {
    console.log('⚠️  DRY RUN mode — no data will be written to Prolibu');
    console.log('');
  }

  // --count: fetch record counts during discover (opt-in, slower)
  const withCount = flags.count === true;

  // 7. Run engine
  await engine.run({ domain, apiKey, entities, phases, from, to, dryRun, withCount });
};
