module.exports = async function pushCustomFields(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');
  if (!fs.existsSync(cfDir)) {
    console.error(chalk.red(`❌ No objects/CustomField/ folder found for ${domain}. Run 'pull' first or create JSON files.`));
    process.exit(1);
  }

  const files = fs.readdirSync(cfDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log(chalk.yellow('No JSON files found in objects/CustomField/ folder.'));
    return;
  }

  // Fetch existing custom fields to know which to create vs update
  let existing = [];
  try {
    const result = await api.listCustomFields(domain, apiKey);
    existing = result.data || [];
  } catch {}

  const existingMap = {};
  for (const cf of existing) {
    existingMap[cf.objectAssigned] = cf._id;
  }

  for (const file of files) {
    const filePath = path.join(cfDir, file);
    try {
      const body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const model = body.objectAssigned;

      if (!model) {
        console.error(chalk.red(`  ❌ ${file}: missing 'objectAssigned' field, skipping.`));
        continue;
      }

      // Remove read-only fields before pushing
      const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, status, ...payload } = body;

      if (existingMap[model]) {
        await api.updateCustomField(domain, apiKey, existingMap[model], payload);
        console.log(chalk.green(`  ✅ ${file} → updated (${model})`));
      } else {
        await api.createCustomField(domain, apiKey, payload);
        console.log(chalk.green(`  ✅ ${file} → created (${model})`));
      }
    } catch (err) {
      const errData = err.response?.data;
      console.error(chalk.red(`  ❌ ${file}: ${errData?.error || err.message}`));
    }
  }

  console.log(chalk.cyan(`\n📤 Push complete for ${domain}`));
};
