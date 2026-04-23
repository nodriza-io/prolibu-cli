module.exports = async function createObject(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
  const axios = require('axios');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cobApi = require('../../../api/cobClient');
  const cfApi = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  // Shared waitForBackend
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

  // If --file is provided, detect type and upload directly
  if (flags.file) {
    const resolved = path.resolve(flags.file);
    if (!fs.existsSync(resolved)) {
      console.error(chalk.red(`❌ File not found: ${resolved}`));
      process.exit(1);
    }
    const body = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    try {
      if (body.modelName) {
        const result = await cobApi.createCob(domain, apiKey, body);
        console.log(chalk.green(`✅ Custom Object '${result.modelName}' created`));
        console.log(chalk.gray(`   ID: ${result._id}`));
      } else if (body.objectAssigned) {
        const result = await cfApi.createCustomField(domain, apiKey, body);
        console.log(chalk.green(`✅ Custom Field for '${result.objectAssigned}' created`));
        console.log(chalk.gray(`   ID: ${result._id}`));
      } else {
        console.error(chalk.red(`❌ JSON must have 'modelName' (COB) or 'objectAssigned' (CustomField).`));
        process.exit(1);
      }
    } catch (err) {
      const errData = err.response?.data;
      console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
      process.exit(1);
    }
    return;
  }

  // Interactive: ask what to create
  const { objectType } = await inquirer.default.prompt({
    type: 'list',
    name: 'objectType',
    message: 'What do you want to create?',
    choices: [
      { name: 'New model (Custom Object / COB)', value: 'cob' },
      { name: 'Extend existing model (Custom Field)', value: 'cf' },
    ],
  });

  if (objectType === 'cob') {
    await createCob(flags, domain, apiKey, chalk, inquirer, fs, path, cobApi, cfApi, waitForBackend);
  } else {
    await createCustomField(flags, domain, apiKey, chalk, inquirer, fs, path, cfApi, waitForBackend);
  }
};

// ── Create COB (new model) ──────────────────────────────────────────

async function createCob(flags, domain, apiKey, chalk, inquirer, fs, path, cobApi, cfApi, waitForBackend) {
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

  const fields = await promptFields(chalk, inquirer);

  // Build COB definition
  const cobDef = { modelName, active: true };
  for (const f of fields) {
    const fieldDef = { type: f.type };
    if (f.required) fieldDef.required = true;
    if (f.displayName) fieldDef.displayName = true;
    if (f.description) fieldDef.description = f.description;
    if (f.ref) fieldDef.ref = f.ref;
    if (f.enum) fieldDef.enum = f.enum;
    cobDef[f.name] = fieldDef;
  }

  // Build CustomField overrides
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
  const cfDef = { objectAssigned: modelName, active: true, overrides };

  // Save locally
  const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
  fs.mkdirSync(cobDir, { recursive: true });
  const localPath = path.join(cobDir, `${modelName}.json`);
  fs.writeFileSync(localPath, JSON.stringify(cobDef, null, 2));
  console.log(chalk.green(`\n📄 COB saved: accounts/${domain}/objects/Cob/${modelName}.json`));

  const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');
  fs.mkdirSync(cfDir, { recursive: true });
  const cfPath = path.join(cfDir, `${modelName}.json`);
  fs.writeFileSync(cfPath, JSON.stringify(cfDef, null, 2));
  console.log(chalk.green(`📄 CustomField saved: accounts/${domain}/objects/CustomField/${modelName}.json`));

  // Ask to push
  const { pushNow } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'pushNow',
    message: 'Push to platform now?',
    default: true,
  });

  if (pushNow) {
    let cobCreated = false;
    let cobResult;
    try {
      cobResult = await cobApi.createCob(domain, apiKey, cobDef);
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
        console.log(chalk.yellow('Files saved locally. Push later with: ./prolibu object sync'));
      }
    }

    if (cobCreated) {
      await waitForBackend(modelName);

      // Update local COB with full platform data
      try {
        if (cobResult?._id) {
          const fullData = await cobApi.getCob(domain, apiKey, cobResult._id);
          fs.writeFileSync(localPath, JSON.stringify(fullData, null, 2));
        }
      } catch {}

      // Push CustomField
      if (Object.keys(overrides).length > 0) {
        try {
          const cfResult = await cfApi.createCustomField(domain, apiKey, cfDef);
          console.log(chalk.green(`✅ CustomField for '${modelName}' created on platform`));
          console.log(chalk.gray(`   ID: ${cfResult._id}`));
          await waitForBackend(modelName);

          try {
            const fullCf = await cfApi.getCustomField(domain, apiKey, cfResult._id);
            fs.writeFileSync(cfPath, JSON.stringify(fullCf, null, 2));
          } catch {}
        } catch (cfErr) {
          const cfMsg = cfErr.message || '';
          const cfIsRestart = cfMsg.includes('socket hang up') || cfMsg.includes('ECONNRESET') || cfMsg.includes('ECONNREFUSED');
          if (cfIsRestart) {
            console.log(chalk.yellow(`  ⚠️  CustomField '${modelName}' → backend restarted (likely succeeded)`));
            await waitForBackend(modelName);
          } else {
            const cfErrData = cfErr.response?.data;
            console.error(chalk.yellow(`⚠️  COB created but CustomField push failed: ${cfErrData?.error || cfErr.message}`));
            console.log(chalk.yellow('   Push later with: ./prolibu object sync --domain ' + domain));
          }
        }
      }
    }
  }
}

// ── Create CustomField (extend existing model) ─────────────────────

async function createCustomField(flags, domain, apiKey, chalk, inquirer, fs, path, cfApi, waitForBackend) {
  // Ask which model to extend
  const { modelName } = await inquirer.default.prompt({
    type: 'input',
    name: 'modelName',
    message: 'Model to extend (e.g. Deal, Contact, Vehicle):',
    validate: (v) => v ? true : 'Model name is required.',
  });

  const fields = await promptFields(chalk, inquirer);

  // Build as customFields (new fields) or overrides depending on context
  const customFields = {};
  for (const f of fields) {
    const def = { isCustomField: true, type: f.type };
    if (f.required) def.required = true;
    if (f.displayName) def.displayName = true;
    if (f.label && f.label !== f.name) def.label = f.label;
    if (f.description) def.description = f.description;
    if (f.ref) def.ref = f.ref;
    if (f.enum) def.enum = f.enum;
    customFields[f.name] = def;
  }

  const cfDef = { objectAssigned: modelName, active: true, customFields };

  // Save locally
  const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');
  fs.mkdirSync(cfDir, { recursive: true });
  const cfPath = path.join(cfDir, `${modelName}.json`);

  // Merge if file already exists
  if (fs.existsSync(cfPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
      existing.customFields = { ...(existing.customFields || {}), ...customFields };
      fs.writeFileSync(cfPath, JSON.stringify(existing, null, 2));
      console.log(chalk.green(`\n📄 Merged into: accounts/${domain}/objects/CustomField/${modelName}.json`));
    } catch {
      fs.writeFileSync(cfPath, JSON.stringify(cfDef, null, 2));
      console.log(chalk.green(`\n📄 Saved: accounts/${domain}/objects/CustomField/${modelName}.json`));
    }
  } else {
    fs.writeFileSync(cfPath, JSON.stringify(cfDef, null, 2));
    console.log(chalk.green(`\n📄 Saved: accounts/${domain}/objects/CustomField/${modelName}.json`));
  }

  // Ask to push
  const { pushNow } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'pushNow',
    message: 'Push to platform now?',
    default: true,
  });

  if (pushNow) {
    const payload = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
    const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, status, ...cleanPayload } = payload;

    try {
      // Check if CF already exists for this model
      const existing = await cfApi.listCustomFields(domain, apiKey, { objectAssigned: modelName });
      const found = (existing.data || []).find((c) => c.objectAssigned === modelName);

      if (found) {
        const result = await cfApi.updateCustomField(domain, apiKey, found._id, cleanPayload);
        console.log(chalk.green(`✅ CustomField for '${modelName}' updated on platform`));
      } else {
        const result = await cfApi.createCustomField(domain, apiKey, cleanPayload);
        console.log(chalk.green(`✅ CustomField for '${modelName}' created on platform`));
        console.log(chalk.gray(`   ID: ${result._id}`));
      }
      await waitForBackend(modelName);

      // Update local file with full platform data
      try {
        const updatedList = await cfApi.listCustomFields(domain, apiKey, { objectAssigned: modelName });
        const full = (updatedList.data || []).find((c) => c.objectAssigned === modelName);
        if (full) fs.writeFileSync(cfPath, JSON.stringify(full, null, 2));
      } catch {}
    } catch (err) {
      const msg = err.message || '';
      const isRestart = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      if (isRestart) {
        console.log(chalk.yellow(`  ⚠️  CustomField '${modelName}' → backend restarted (likely succeeded)`));
        await waitForBackend(modelName);
      } else {
        const errData = err.response?.data;
        console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
        console.log(chalk.yellow('File saved locally. Push later with: ./prolibu object sync'));
      }
    }
  }
}

// ── Shared: prompt for fields interactively ─────────────────────────

async function promptFields(chalk, inquirer) {
  const fields = [];
  console.log(chalk.cyan('\nDefine fields:\n'));
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
      { type: 'list', name: 'type', message: `  Type for '${fieldName}':`, choices: TYPE_CHOICES, default: 'string' },
      { type: 'confirm', name: 'required', message: `  Required?`, default: false },
      { type: 'confirm', name: 'displayName', message: `  Use as display name?`, default: fields.length === 0 },
      { type: 'input', name: 'label', message: `  Label (human-readable):`, default: fieldName },
      { type: 'input', name: 'description', message: `  Description:`, default: '' },
    ]);

    if (fieldOpts.type === 'objectid') {
      const { ref } = await inquirer.default.prompt({
        type: 'input', name: 'ref', message: `  Reference model (e.g. User, Contact):`, default: '',
      });
      if (ref) fieldOpts.ref = ref;
    }

    if (fieldOpts.type === 'string') {
      const { enumValues } = await inquirer.default.prompt({
        type: 'input', name: 'enumValues', message: `  Enum values (comma-separated, empty to skip):`, default: '',
      });
      if (enumValues.trim()) {
        fieldOpts.enum = enumValues.split(',').map((v) => v.trim()).filter(Boolean);
      }
    }

    fields.push({ name: fieldName, ...fieldOpts });
    console.log(chalk.green(`  ✓ Field '${fieldName}' added (${fields.length} total)\n`));

    const { another } = await inquirer.default.prompt({
      type: 'confirm', name: 'another', message: 'Add another field?', default: true,
    });
    addField = another;
  }

  return fields;
}
