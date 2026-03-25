const path = require('path');
const fs = require('fs');

module.exports = async function pushObjects(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cfApi = require('../../../api/customFieldClient');
  const cobApi = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  const accountDir = path.resolve(__dirname, '..', '..', '..', 'accounts', domain);

  let pushed = 0;

  // Push Custom Fields
  const cfDir = path.join(accountDir, 'objects', 'CustomField');
  if (fs.existsSync(cfDir)) {
    const files = fs.readdirSync(cfDir).filter((f) => f.endsWith('.json'));

    if (files.length > 0) {
      let existingCFs = [];
      try {
        const r = await cfApi.listCustomFields(domain, apiKey);
        existingCFs = r.data || [];
      } catch {}
      const cfMap = {};
      for (const cf of existingCFs) cfMap[cf.objectAssigned] = cf._id;

      console.log(chalk.cyan(`\n📤 Pushing ${files.length} Custom Field(s)...\n`));

      for (const file of files) {
        try {
          const body = JSON.parse(fs.readFileSync(path.join(cfDir, file), 'utf8'));
          const model = body.objectAssigned;
          if (!model) { console.error(chalk.red(`  ❌ ${file}: missing 'objectAssigned'`)); continue; }

          const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, status, ...payload } = body;
          if (cfMap[model]) {
            await cfApi.updateCustomField(domain, apiKey, cfMap[model], payload);
            console.log(chalk.green(`  ✅ ${file} → updated (${model})`));
          } else {
            await cfApi.createCustomField(domain, apiKey, payload);
            console.log(chalk.green(`  ✅ ${file} → created (${model})`));
          }
          pushed++;
        } catch (err) {
          console.error(chalk.red(`  ❌ ${file}: ${err.response?.data?.error || err.message}`));
        }
      }
    }
  } else {
    console.log(chalk.gray('  (no objects/CustomField/ folder)'));
  }

  // Push Custom Objects
  const cobDir = path.join(accountDir, 'objects', 'Cob');
  if (fs.existsSync(cobDir)) {
    const files = fs.readdirSync(cobDir).filter((f) => f.endsWith('.json'));

    if (files.length > 0) {
      let existingCobs = [];
      try {
        const r = await cobApi.listCobs(domain, apiKey);
        existingCobs = r.data || [];
      } catch {}
      const cobMap = {};
      for (const cob of existingCobs) cobMap[cob.modelName] = cob._id;

      console.log(chalk.cyan(`\n📤 Pushing ${files.length} Custom Object(s)...\n`));

      for (const file of files) {
        try {
          const body = JSON.parse(fs.readFileSync(path.join(cobDir, file), 'utf8'));
          const modelName = body.modelName;
          if (!modelName) { console.error(chalk.red(`  ❌ ${file}: missing 'modelName'`)); continue; }

          const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, ...payload } = body;
          if (cobMap[modelName]) {
            await cobApi.updateCob(domain, apiKey, cobMap[modelName], payload);
            console.log(chalk.green(`  ✅ ${file} → updated (${modelName})`));
          } else {
            await cobApi.createCob(domain, apiKey, payload);
            console.log(chalk.green(`  ✅ ${file} → created (${modelName})`));
          }
          pushed++;
        } catch (err) {
          console.error(chalk.red(`  ❌ ${file}: ${err.response?.data?.error || err.message}`));
        }
      }
    }
  } else {
    console.log(chalk.gray('  (no objects/Cob/ folder)'));
  }

  console.log(chalk.cyan(`\n📤 Push complete: ${pushed} file(s) synced to ${domain}`));
};
