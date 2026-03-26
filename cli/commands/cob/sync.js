module.exports = async function syncCobs(flags) {
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

    // Initial delay: backend needs ~12s to restart
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

  if (!fs.existsSync(cobDir)) {
    console.error(chalk.red(`❌ No objects/Cob/ folder found for ${domain}. Run 'pull' first or create objects.`));
    process.exit(1);
  }

  // Read all local COB files
  const cobFiles = fs.readdirSync(cobDir).filter((f) => f.endsWith('.json'));
  if (cobFiles.length === 0) {
    console.log(chalk.yellow('No JSON files found in objects/Cob/ folder.'));
    return;
  }

  // Build list of model names from COB files
  const models = cobFiles.map((f) => f.replace('.json', ''));

  // Ask: all or specific?
  const { syncMode } = await inquirer.default.prompt({
    type: 'list',
    name: 'syncMode',
    message: 'What do you want to sync?',
    choices: [
      { name: 'All objects', value: 'all' },
      { name: 'Select specific objects', value: 'select' },
    ],
  });

  let selectedModels = models;

  if (syncMode === 'select') {
    const { chosen } = await inquirer.default.prompt({
      type: 'checkbox',
      name: 'chosen',
      message: 'Select objects to sync:',
      choices: models.map((m) => {
        const hasCf = fs.existsSync(path.join(cfDir, `${m}.json`));
        return { name: hasCf ? `${m} (+ CustomField)` : m, value: m };
      }),
      validate: (v) => v.length > 0 ? true : 'Select at least one object.',
    });
    selectedModels = chosen;
  }

  // Fetch existing COBs and CustomFields from platform
  let existingCobs = [];
  let existingCfs = [];
  try {
    const cobResult = await cobApi.listCobs(domain, apiKey);
    existingCobs = cobResult.data || [];
  } catch {}
  try {
    const cfResult = await cfApi.listCustomFields(domain, apiKey);
    existingCfs = cfResult.data || [];
  } catch {}

  const cobMap = {};
  for (const cob of existingCobs) cobMap[cob.modelName] = cob._id;
  const cfMap = {};
  for (const cf of existingCfs) cfMap[cf.objectAssigned] = cf._id;

  console.log(chalk.cyan(`\n🔄 Syncing ${selectedModels.length} object(s) to ${domain}...\n`));

  let cobSuccess = 0;
  let cfSuccess = 0;
  let errors = 0;

  for (let idx = 0; idx < selectedModels.length; idx++) {
    const modelName = selectedModels[idx];
    console.log(chalk.white.bold(`  [${idx + 1}/${selectedModels.length}] ${modelName}`));

    // 1. Sync COB
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
      const isRestart = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      if (isRestart) {
        // Server restarted mid-response — the COB was likely saved
        console.log(chalk.yellow(`  ⚠️  COB ${modelName} → backend restarted (operation likely succeeded)`));
        cobSynced = true;
      } else {
        const errData = err.response?.data;
        console.error(chalk.red(`  ❌ COB ${modelName}: ${errData?.error || err.message}`));
        errors++;
      }
    }

    // COB create/update triggers backend restart — wait before CustomField
    if (cobSynced) {
      await waitForBackend(modelName);
    }

    // 2. Sync CustomField if it exists locally
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

        // CustomField update also triggers restart — always wait for backend
        await waitForBackend(modelName);
      } catch (cfErr) {
        const cfMsg = cfErr.message || '';
        const cfIsRestart = cfMsg.includes('socket hang up') || cfMsg.includes('ECONNRESET') || cfMsg.includes('ECONNREFUSED');
        if (cfIsRestart) {
          console.log(chalk.yellow(`  ⚠️  CustomField ${modelName} → backend restarted (operation likely succeeded)`));
          cfSuccess++;
          await waitForBackend(modelName);
        } else {
          const cfErrData = cfErr.response?.data;
          console.error(chalk.red(`  ❌ CustomField ${modelName}: ${cfErrData?.error || cfErr.message}`));
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
