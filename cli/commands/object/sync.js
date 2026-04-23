module.exports = async function syncObjects(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
  const axios = require('axios');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cobApi = require('../../../api/cobClient');
  const cfApi = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
  const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');

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

  // Collect COB files and standalone CF files (for native models)
  const cobFiles = fs.existsSync(cobDir) ? fs.readdirSync(cobDir).filter((f) => f.endsWith('.json')) : [];
  const cfFiles = fs.existsSync(cfDir) ? fs.readdirSync(cfDir).filter((f) => f.endsWith('.json')) : [];

  if (cobFiles.length === 0 && cfFiles.length === 0) {
    console.log(chalk.yellow('No object files found. Run "object pull" or "object create" first.'));
    return;
  }

  // Build unified list: COBs + standalone CFs (CFs for native models that don't have a COB)
  const cobModels = cobFiles.map((f) => f.replace('.json', ''));
  const cfModels = cfFiles.map((f) => f.replace('.json', ''));
  const standaloneCfs = cfModels.filter((m) => !cobModels.includes(m));

  // Build choices
  const choices = [];
  for (const m of cobModels) {
    const hasCf = cfModels.includes(m);
    choices.push({ name: hasCf ? `${m} (COB + CustomField)` : `${m} (COB)`, value: { model: m, type: 'cob' } });
  }
  for (const m of standaloneCfs) {
    choices.push({ name: `${m} (CustomField only)`, value: { model: m, type: 'cf-only' } });
  }

  // Ask: all or specific?
  const { syncMode } = await inquirer.default.prompt({
    type: 'list',
    name: 'syncMode',
    message: `What do you want to sync? (${choices.length} objects found)`,
    choices: [
      { name: `All objects (${choices.length})`, value: 'all' },
      { name: 'Select specific objects', value: 'select' },
    ],
  });

  let selected = choices.map((c) => c.value);

  if (syncMode === 'select') {
    const { chosen } = await inquirer.default.prompt({
      type: 'checkbox',
      name: 'chosen',
      message: 'Select objects to sync:',
      choices,
      validate: (v) => v.length > 0 ? true : 'Select at least one.',
    });
    selected = chosen;
  }

  // Fetch existing platform data
  let existingCobs = [];
  let existingCfs = [];
  try { existingCobs = (await cobApi.listCobs(domain, apiKey)).data || []; } catch {}
  try { existingCfs = (await cfApi.listCustomFields(domain, apiKey)).data || []; } catch {}

  const cobMap = {};
  for (const cob of existingCobs) cobMap[cob.modelName] = cob._id;
  const cfMap = {};
  for (const cf of existingCfs) cfMap[cf.objectAssigned] = cf._id;

  console.log(chalk.cyan(`\n🔄 Syncing ${selected.length} object(s) to ${domain}...\n`));

  let cobSuccess = 0;
  let cfSuccess = 0;
  let errors = 0;

  for (let idx = 0; idx < selected.length; idx++) {
    const { model: modelName, type } = selected[idx];
    console.log(chalk.white.bold(`  [${idx + 1}/${selected.length}] ${modelName}`));

    // ── Sync COB if applicable ──
    if (type === 'cob') {
      const cobFile = path.join(cobDir, `${modelName}.json`);
      let cobSynced = false;
      try {
        const body = JSON.parse(fs.readFileSync(cobFile, 'utf8'));
        const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, unset, ...payload } = body;

        if (cobMap[modelName]) {
          await cobApi.updateCob(domain, apiKey, cobMap[modelName], payload);
          console.log(chalk.green(`  ✅ COB ${modelName} → updated`));
        } else {
          const result = await cobApi.createCob(domain, apiKey, payload);
          cobMap[modelName] = result._id;
          console.log(chalk.green(`  ✅ COB ${modelName} → created`));
        }
        cobSuccess++;
        cobSynced = true;
      } catch (err) {
        const msg = err.message || '';
        const errData = err.response?.data;
        const errMsg = errData?.error || errData?.message || msg;
        const isRestart = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
        const alreadyExists = /already exists|duplicate|11000|exists/i.test(errMsg);

        if (alreadyExists) {
          console.log(chalk.cyan(`  ℹ️  COB ${modelName} already exists — skipping`));
          cobSuccess++;
        } else if (isRestart) {
          console.log(chalk.yellow(`  ⚠️  COB ${modelName} → backend restarted (likely succeeded)`));
          cobSynced = true;
        } else {
          console.error(chalk.red(`  ❌ COB ${modelName}: ${errMsg}`));
          errors++;
        }
      }

      if (cobSynced) {
        await waitForBackend(modelName);
      }
    }

    // ── Sync CustomField if it exists locally ──
    const cfFile = path.join(cfDir, `${modelName}.json`);
    if (fs.existsSync(cfFile)) {
      try {
        const body = JSON.parse(fs.readFileSync(cfFile, 'utf8'));
        const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, status, ...payload } = body;

        if (cfMap[modelName]) {
          await cfApi.updateCustomField(domain, apiKey, cfMap[modelName], payload);
          console.log(chalk.green(`  ✅ CustomField ${modelName} → updated`));
        } else {
          const result = await cfApi.createCustomField(domain, apiKey, payload);
          cfMap[modelName] = result._id;
          console.log(chalk.green(`  ✅ CustomField ${modelName} → created`));
        }
        cfSuccess++;
        await waitForBackend(modelName);
      } catch (cfErr) {
        const cfMsg = cfErr.message || '';
        const cfErrData = cfErr.response?.data;
        const cfErrMsg = cfErrData?.error || cfErrData?.message || cfMsg;
        const cfIsRestart = cfMsg.includes('socket hang up') || cfMsg.includes('ECONNRESET') || cfMsg.includes('ECONNREFUSED');
        const cfAlreadyExists = /already exists|duplicate|11000|exists/i.test(cfErrMsg);

        if (cfAlreadyExists) {
          console.log(chalk.cyan(`  ℹ️  CustomField ${modelName} already exists — skipping`));
          cfSuccess++;
        } else if (cfIsRestart) {
          console.log(chalk.yellow(`  ⚠️  CustomField ${modelName} → backend restarted (likely succeeded)`));
          cfSuccess++;
          await waitForBackend(modelName);
        } else {
          console.error(chalk.red(`  ❌ CustomField ${modelName}: ${cfErrMsg}`));
          errors++;
        }
      }
    }

    console.log('');
  }

  console.log(chalk.cyan('─'.repeat(45)));
  console.log(chalk.cyan(`📊 Sync summary for ${domain}:`));
  if (cobSuccess) console.log(chalk.green(`   COBs: ${cobSuccess} synced`));
  if (cfSuccess) console.log(chalk.green(`   CustomFields: ${cfSuccess} synced`));
  if (errors) console.log(chalk.red(`   Errors: ${errors}`));
  console.log(chalk.cyan('─'.repeat(45)));
};
