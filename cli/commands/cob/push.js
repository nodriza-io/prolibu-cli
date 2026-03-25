module.exports = async function pushCobs(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

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
    } catch (err) {
      const errData = err.response?.data;
      console.error(chalk.red(`  ❌ ${file}: ${errData?.error || err.message}`));
    }
  }

  console.log(chalk.cyan(`\n📤 Push complete for ${domain}`));
};
