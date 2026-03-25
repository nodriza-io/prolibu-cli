const path = require('path');
const fs = require('fs');

module.exports = async function pullObjects(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cfApi = require('../../../api/customFieldClient');
  const cobApi = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  const accountDir = path.resolve(__dirname, '..', '..', '..', 'accounts', domain);

  let pulled = 0;

  // Pull Custom Fields
  try {
    const cfResult = await cfApi.listCustomFields(domain, apiKey);
    const cfs = cfResult.data || [];
    const cfDir = path.join(accountDir, 'objects', 'CustomField');
    fs.mkdirSync(cfDir, { recursive: true });

    for (const cf of cfs) {
      const name = cf.objectAssigned || cf._id;
      const filePath = path.join(cfDir, `${name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(cf, null, 2), 'utf8');
      pulled++;
    }
    console.log(chalk.green(`✅ Pulled ${cfs.length} Custom Field(s) → objects/CustomField/`));
  } catch (err) {
    console.error(chalk.red(`❌ CustomField pull error: ${err.response?.data?.error || err.message}`));
  }

  // Pull Custom Objects
  try {
    const cobResult = await cobApi.listCobs(domain, apiKey);
    const cobs = cobResult.data || [];
    const cobDir = path.join(accountDir, 'objects', 'Cob');
    fs.mkdirSync(cobDir, { recursive: true });

    for (const cob of cobs) {
      const name = cob.modelName || cob._id;
      const filePath = path.join(cobDir, `${name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(cob, null, 2), 'utf8');
      pulled++;
    }
    console.log(chalk.green(`✅ Pulled ${cobs.length} Custom Object(s) → objects/Cob/`));
  } catch (err) {
    console.error(chalk.red(`❌ COB pull error: ${err.response?.data?.error || err.message}`));
  }

  console.log(chalk.cyan(`\n📁 Total: ${pulled} file(s) written to accounts/${domain}/objects/`));
};
