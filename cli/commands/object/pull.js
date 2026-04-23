module.exports = async function pullObjects(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cobApi = require('../../../api/cobClient');
  const cfApi = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let pulled = 0;

  // Pull Custom Objects
  try {
    const cobResult = await cobApi.listCobs(domain, apiKey);
    const cobs = cobResult.data || [];
    const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
    fs.mkdirSync(cobDir, { recursive: true });
    for (const cob of cobs) {
      const fileName = `${cob.modelName}.json`;
      fs.writeFileSync(path.join(cobDir, fileName), JSON.stringify(cob, null, 2));
      console.log(chalk.green(`  ✅ Cob/${fileName}`));
      pulled++;
    }
    console.log(chalk.cyan(`  📥 ${cobs.length} Custom Object(s) → objects/Cob/\n`));
  } catch (err) {
    console.error(chalk.red(`❌ COB pull error: ${err.response?.data?.error || err.message}`));
  }

  // Pull Custom Fields
  try {
    const cfResult = await cfApi.listCustomFields(domain, apiKey);
    const cfs = cfResult.data || [];
    const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');
    fs.mkdirSync(cfDir, { recursive: true });
    for (const cf of cfs) {
      const fileName = `${cf.objectAssigned}.json`;
      fs.writeFileSync(path.join(cfDir, fileName), JSON.stringify(cf, null, 2));
      console.log(chalk.green(`  ✅ CustomField/${fileName}`));
      pulled++;
    }
    console.log(chalk.cyan(`  📥 ${cfs.length} Custom Field(s) → objects/CustomField/\n`));
  } catch (err) {
    console.error(chalk.red(`❌ CustomField pull error: ${err.response?.data?.error || err.message}`));
  }

  console.log(chalk.cyan(`📁 Total: ${pulled} file(s) pulled to accounts/${domain}/objects/`));
};
