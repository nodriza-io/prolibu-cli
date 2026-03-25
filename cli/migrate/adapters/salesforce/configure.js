const path = require('path');
const fs = require('fs');
const credentialStore = require('../../shared/credentialStore');
const configLoader = require('../../shared/configLoader');
const presets = require('./presets');

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

  // 4. Apply preset (defaults to "standard", override with --preset <name> or --preset custom)
  let presetName = flags.preset || 'standard';

  if (presetName && presetName !== 'custom') {
    const preset = presets.load(presetName);
    if (!preset) {
      console.error(`❌ Unknown preset: ${presetName}`);
      console.log(`Available presets: ${presets.names().join(', ')}, custom`);
      process.exit(1);
    }

    // Apply preset config (entities + batchSize)
    credentialStore.saveConfig(domain, 'salesforce', preset.config, true);
    console.log(`✅ Preset "${preset.label}" applied → config.json`);

    // Apply preset pipeline order if it differs from template default
    if (preset.pipeline?.order) {
      const templatePipelines = configLoader.loadPipelines(domain, 'salesforce');
      const templateOrder = templatePipelines.data?.pipeline?.order || [];
      const presetOrder = preset.pipeline.order;
      const orderChanged = JSON.stringify(presetOrder) !== JSON.stringify(templateOrder);

      if (orderChanged) {
        const pipelinesPath = path.join(
          configLoader.domainDir(domain, 'salesforce'),
          'pipelines.json'
        );
        const pipelinesData = templatePipelines.data || {};
        pipelinesData.pipeline = { ...pipelinesData.pipeline, order: presetOrder };
        configLoader.writeConfig(pipelinesPath, pipelinesData);
        console.log(`✅ Pipeline order customized → pipelines.json`);
      }
    }

    // Scaffold template config files to domain for local customization
    const scaffolded = configLoader.scaffoldConfig(domain, 'salesforce');
    if (scaffolded.length) {
      console.log(`📄 Configuration files scaffolded for customization:`);
      for (const f of scaffolded) {
        console.log(`   ${path.basename(f)}`);
      }
    }

    // Print preset summary
    console.log('');
    console.log(`📋 Preset "${preset.name}" — enabled entities:`);
    for (const [entity, cfg] of Object.entries(preset.config.entities)) {
      const status = cfg.enabled ? '✅' : '⏭️ ';
      console.log(`   ${status} ${entity}`);
    }
  } else {
    // Custom / no preset — use minimal default config
    const defaultConfig = {
      entities: {
        contacts: { enabled: true },
        products: { enabled: true },
        accounts: { enabled: false },
      },
      batchSize: 200,
    };
    const created = credentialStore.saveConfig(domain, 'salesforce', defaultConfig);
    if (created) {
      console.log(`✅ Default config.json created`);
    }
  }

  // 5. Ensure transformers directory exists
  const transformersDir = credentialStore.ensureTransformersDir(domain, 'salesforce');
  console.log(`📁 Transformers override folder ready: ${transformersDir}`);

  // 6. Ensure pipelines directory exists
  const pipelinesDir = credentialStore.ensurePipelinesDir(domain, 'salesforce');
  console.log(`📁 Pipelines folder ready: ${pipelinesDir}`);

  console.log('');
  console.log('💡 To customize the configuration:');
  console.log(`   prolibu migrate ui --domain ${domain} --crm salesforce`);
  console.log(`   Or edit files directly in accounts/${domain}/migrations/salesforce/`);
  console.log('');
  console.log(`🚀 Ready to migrate. Run:`);
  console.log(`   prolibu migrate salesforce run --domain ${domain} --phase discover`);
  console.log(`   prolibu migrate salesforce run --domain ${domain} --entity all --dry-run`);
};
