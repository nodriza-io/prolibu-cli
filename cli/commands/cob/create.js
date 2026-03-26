module.exports = async function createCob(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
  const axios = require('axios');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  // Wait for backend to be ready after a restart
  async function waitForBackend(label) {
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const start = Date.now();
    const maxWait = 60000;
    const pollInterval = 3000;
    const initialDelay = 12000;

    process.stdout.write(chalk.yellow(`  ⏳ ${label} — waiting for backend restart`));

    await new Promise((r) => setTimeout(r, initialDelay));

    while (Date.now() - start < maxWait) {
      try {
        await axios.get(`https://${domain}/v2/cob?limit=1`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 5000,
        });
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        console.log(chalk.green(`  ✓ Backend ready (${Math.round((Date.now() - start) / 1000)}s)`));
        return;
      } catch {
        process.stdout.write(`\r  ${spinner[i % spinner.length]} ${label} — waiting for backend restart (${Math.round((Date.now() - start) / 1000)}s)`);
        i++;
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log(chalk.yellow(`  ⚠️  Backend wait timeout — continuing anyway`));
  }

  // If --file is provided, use the old flow (upload existing JSON)
  if (flags.file) {
    const resolved = path.resolve(flags.file);
    if (!fs.existsSync(resolved)) {
      console.error(chalk.red(`❌ File not found: ${resolved}`));
      process.exit(1);
    }
    try {
      const body = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      const result = await api.createCob(domain, apiKey, body);
      console.log(chalk.green(`✅ Custom Object '${result.modelName}' created`));
      console.log(chalk.gray(`   ID: ${result._id}`));
      console.log(chalk.gray(`   API: /v2/${result.modelName.toLowerCase()}`));
    } catch (err) {
      const errData = err.response?.data;
      console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
      process.exit(1);
    }
    return;
  }

  // Interactive: ask for modelName
  let modelName = flags.modelName || flags.modelname;

  if (!modelName) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'modelName',
      message: 'Enter model name (PascalCase, e.g. Vehicle, Pet):',
      validate: (v) => {
        if (!v) return 'Model name is required.';
        if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Use PascalCase (e.g. Vehicle, Pet).';
        return true;
      },
    });
    modelName = r.modelName;
  }

  // Ask for fields interactively
  const fields = [];
  console.log(chalk.cyan('\nDefine fields for the model:\n'));

  const TYPE_CHOICES = ['string', 'number', 'boolean', 'date', 'objectid', 'mixed'];

  let addField = true;
  while (addField) {
    const { fieldName } = await inquirer.default.prompt({
      type: 'input',
      name: 'fieldName',
      message: `Field #${fields.length + 1} name:`,
      validate: (v) => v ? true : 'Field name is required.',
    });

    const fieldOpts = await inquirer.default.prompt([
      {
        type: 'list',
        name: 'type',
        message: `  Type for '${fieldName}':`,
        choices: TYPE_CHOICES,
        default: 'string',
      },
      {
        type: 'confirm',
        name: 'required',
        message: `  Required?`,
        default: false,
      },
      {
        type: 'confirm',
        name: 'displayName',
        message: `  Use as display name?`,
        default: fields.length === 0,
      },
      {
        type: 'input',
        name: 'label',
        message: `  Label (human-readable):`,
        default: fieldName,
      },
      {
        type: 'input',
        name: 'description',
        message: `  Description:`,
        default: '',
      },
    ]);

    // If objectid, ask for ref
    if (fieldOpts.type === 'objectid') {
      const { ref } = await inquirer.default.prompt({
        type: 'input',
        name: 'ref',
        message: `  Reference model (e.g. User, Contact):`,
        default: '',
      });
      if (ref) fieldOpts.ref = ref;
    }

    // If string, ask for enum
    if (fieldOpts.type === 'string') {
      const { enumValues } = await inquirer.default.prompt({
        type: 'input',
        name: 'enumValues',
        message: `  Enum values (comma-separated, empty to skip):`,
        default: '',
      });
      if (enumValues.trim()) {
        fieldOpts.enum = enumValues.split(',').map((v) => v.trim()).filter(Boolean);
      }
    }

    fields.push({ name: fieldName, ...fieldOpts });
    console.log(chalk.green(`  ✓ Field '${fieldName}' added (${fields.length} total)\n`));

    const { another } = await inquirer.default.prompt({
      type: 'confirm',
      name: 'another',
      message: 'Add another field?',
      default: true,
    });
    addField = another;
  }

  // Build COB definition
  const cobDef = {
    modelName,
    active: true,
  };

  for (const f of fields) {
    const fieldDef = { type: f.type };
    if (f.required) fieldDef.required = true;
    if (f.displayName) fieldDef.displayName = true;
    if (f.description) fieldDef.description = f.description;
    if (f.ref) fieldDef.ref = f.ref;
    if (f.enum) fieldDef.enum = f.enum;
    cobDef[f.name] = fieldDef;
  }

  // Build CustomField definition (overrides with UI metadata)
  const overrides = {};
  for (const f of fields) {
    const override = { isCustomField: true, type: f.type };
    if (f.required) override.required = true;
    if (f.displayName) override.displayName = true;
    if (f.label && f.label !== f.name) override.label = f.label;
    if (f.description) override.description = f.description;
    if (f.ref) override.ref = f.ref;
    if (f.enum) override.enum = f.enum;
    overrides[f.name] = override;
  }

  const cfDef = {
    objectAssigned: modelName,
    active: true,
    overrides,
  };

  // Save COB locally
  const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
  fs.mkdirSync(cobDir, { recursive: true });
  const localPath = path.join(cobDir, `${modelName}.json`);
  fs.writeFileSync(localPath, JSON.stringify(cobDef, null, 2));
  console.log(chalk.green(`\n📄 COB saved: accounts/${domain}/objects/Cob/${modelName}.json`));

  // Save CustomField locally
  const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');
  fs.mkdirSync(cfDir, { recursive: true });
  const cfPath = path.join(cfDir, `${modelName}.json`);
  fs.writeFileSync(cfPath, JSON.stringify(cfDef, null, 2));
  console.log(chalk.green(`📄 CustomField saved: accounts/${domain}/objects/CustomField/${modelName}.json`));

  // Ask to push to platform
  const { pushNow } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'pushNow',
    message: 'Push to platform now?',
    default: true,
  });

  if (pushNow) {
    const cfApi = require('../../../api/customFieldClient');
    let cobCreated = false;
    let cobResult;
    try {
      // 1. Push COB
      cobResult = await api.createCob(domain, apiKey, cobDef);
      console.log(chalk.green(`✅ Custom Object '${cobResult.modelName}' created on platform`));
      console.log(chalk.gray(`   ID: ${cobResult._id}`));
      console.log(chalk.gray(`   API: /v2/${cobResult.modelName.toLowerCase()}`));
      cobCreated = true;
    } catch (err) {
      const msg = err.message || '';
      const isRestart = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      if (isRestart) {
        console.log(chalk.yellow(`  ⚠️  COB '${modelName}' → backend restarted (operation likely succeeded)`));
        cobCreated = true;
      } else {
        const errData = err.response?.data;
        console.error(chalk.red(`❌ Error pushing: ${errData?.error || err.message}`));
        console.log(chalk.yellow('The JSONs were saved locally. Fix and push with: ./prolibu cob push && ./prolibu customfield push'));
      }
    }

    if (cobCreated) {
      // COB create triggers backend restart — wait before continuing
      await waitForBackend(modelName);

      // Update local COB file with full data from platform
      try {
        if (cobResult?._id) {
          const fullData = await api.getCob(domain, apiKey, cobResult._id);
          fs.writeFileSync(localPath, JSON.stringify(fullData, null, 2));
        }
      } catch {
        // Non-critical: local file stays as-is
      }

      // 2. Push CustomField
      if (Object.keys(overrides).length > 0) {
        try {
          const cfResult = await cfApi.createCustomField(domain, apiKey, cfDef);
          console.log(chalk.green(`✅ CustomField for '${modelName}' created on platform`));
          console.log(chalk.gray(`   ID: ${cfResult._id}`));

          // CustomField also triggers restart — wait
          await waitForBackend(modelName);

          // Update local CF file with full data
          try {
            const fullCf = await cfApi.getCustomField(domain, apiKey, cfResult._id);
            fs.writeFileSync(cfPath, JSON.stringify(fullCf, null, 2));
          } catch {
            // Non-critical
          }
        } catch (cfErr) {
          const cfMsg = cfErr.message || '';
          const cfIsRestart = cfMsg.includes('socket hang up') || cfMsg.includes('ECONNRESET') || cfMsg.includes('ECONNREFUSED');
          if (cfIsRestart) {
            console.log(chalk.yellow(`  ⚠️  CustomField '${modelName}' → backend restarted (operation likely succeeded)`));
            await waitForBackend(modelName);
          } else {
            const cfErrData = cfErr.response?.data;
            console.error(chalk.yellow(`⚠️  COB created but CustomField push failed: ${cfErrData?.error || cfErr.message}`));
            console.log(chalk.yellow('   Push it later with: ./prolibu customfield push --domain ' + domain));
          }
        }
      }
    }
  }
};
