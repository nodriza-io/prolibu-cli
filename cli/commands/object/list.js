module.exports = async function listObjects(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cobApi = require('../../../api/cobClient');
  const cfApi = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  // Custom Objects (COBs)
  try {
    const cobResult = await cobApi.listCobs(domain, apiKey);
    const cobs = cobResult.data || [];
    console.log(chalk.cyan(`\n🧩 Custom Objects on ${domain} (${cobs.length}):\n`));
    if (cobs.length === 0) {
      console.log(chalk.gray('  (none)'));
    } else {
      const reserved = ['_id', '__v', 'modelName', 'active', 'unset', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];
      for (const cob of cobs) {
        const status = cob.active ? chalk.green('active') : chalk.red('inactive');
        const fieldKeys = Object.keys(cob).filter((k) => !reserved.includes(k) && typeof cob[k] === 'object' && cob[k]?.type);
        console.log(`  ${chalk.white.bold(cob.modelName)} ${chalk.gray(`(${cob._id})`)} [${status}]`);
        if (fieldKeys.length) console.log(chalk.gray(`     ${fieldKeys.length} field(s): ${fieldKeys.join(', ')}`));
        if (cob.unset?.methods?.length) console.log(chalk.gray(`     unset methods: ${cob.unset.methods.join(', ')}`));
      }
    }
  } catch (err) {
    console.error(chalk.red(`❌ COB error: ${err.response?.data?.error || err.message}`));
  }

  // Custom Fields
  try {
    const cfResult = await cfApi.listCustomFields(domain, apiKey);
    const cfs = cfResult.data || [];
    console.log(chalk.cyan(`\n📋 Custom Fields on ${domain} (${cfs.length}):\n`));
    if (cfs.length === 0) {
      console.log(chalk.gray('  (none)'));
    } else {
      for (const cf of cfs) {
        const cfCount = cf.customFields ? Object.keys(cf.customFields).length : 0;
        const ovCount = cf.overrides ? Object.keys(cf.overrides).length : 0;
        const status = cf.active ? chalk.green('active') : chalk.red('inactive');
        console.log(`  ${chalk.white.bold(cf.objectAssigned)} ${chalk.gray(`(${cf._id})`)} [${status}]`);
        if (cfCount) console.log(chalk.gray(`     customFields: ${cfCount} fields`));
        if (ovCount) console.log(chalk.gray(`     overrides: ${ovCount} fields`));
        if (cf.status) console.log(chalk.gray(`     status: ${cf.status}`));
      }
    }
  } catch (err) {
    console.error(chalk.red(`❌ CustomField error: ${err.response?.data?.error || err.message}`));
  }

  console.log('');
};
