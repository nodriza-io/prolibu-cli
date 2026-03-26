module.exports = async function pushCobs(flags) {
  const chalk = (await import('chalk')).default;
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

  const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
  if (!fs.existsSync(cobDir)) {
    console.error(chalk.red(`❌ No objects/Cob/ folder found for ${domain}. Run 'pull' first or create JSON files.`));
    process.exit(1);
  }

  const files = fs.readdirSync(cobDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log(chalk.yellow('No JSON files found in objects/Cob/ folder.'));
    return;
  }

  // Fetch existing COBs to know which to create vs update
  let existing = [];
  try {
    const result = await api.listCobs(domain, apiKey);
    existing = result.data || [];
  } catch {}

  const existingMap = {};
  for (const cob of existing) {
    existingMap[cob.modelName] = cob._id;
  }

  for (const file of files) {
    const filePath = path.join(cobDir, file);
    try {
      const body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const modelName = body.modelName;

      if (!modelName) {
        console.error(chalk.red(`  ❌ ${file}: missing 'modelName' field, skipping.`));
        continue;
      }

      // Remove read-only fields before pushing
      const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, ...payload } = body;

      if (existingMap[modelName]) {
        await api.updateCob(domain, apiKey, existingMap[modelName], payload);
        console.log(chalk.green(`  ✅ ${file} → updated (${modelName})`));
      } else {
        await api.createCob(domain, apiKey, payload);
        console.log(chalk.green(`  ✅ ${file} → created (${modelName})`));
      }

      // COB create/update triggers backend restart — wait before next operation
      await waitForBackend(modelName);
    } catch (err) {
      const msg = err.message || '';
      const isRestart = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      if (isRestart) {
        const modelName = path.basename(file, '.json');
        console.log(chalk.yellow(`  ⚠️  ${file} → backend restarted (operation likely succeeded)`));
        await waitForBackend(modelName);
      } else {
        const errData = err.response?.data;
        console.error(chalk.red(`  ❌ ${file}: ${errData?.error || err.message}`));
      }
    }
  }

  console.log(chalk.cyan(`\n📤 Push complete for ${domain}`));
};
