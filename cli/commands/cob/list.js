module.exports = async function listCobs(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  try {
    const result = await api.listCobs(domain, apiKey);
    const items = result.data || [];

    if (items.length === 0) {
      console.log(chalk.yellow('No custom objects found.'));
      return;
    }

    console.log(chalk.cyan(`\n🧩 Custom Objects on ${domain} (${items.length}):\n`));

    for (const cob of items) {
      const status = cob.active ? chalk.green('active') : chalk.red('inactive');
      // Count schema fields (exclude reserved)
      const reserved = ['_id', '__v', 'modelName', 'active', 'unset', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];
      const fieldKeys = Object.keys(cob).filter((k) => !reserved.includes(k) && typeof cob[k] === 'object' && cob[k]?.type);
      const fieldCount = fieldKeys.length;

      console.log(`  ${chalk.white.bold(cob.modelName)} ${chalk.gray(`(${cob._id})`)} [${status}]`);
      if (fieldCount) console.log(chalk.gray(`     ${fieldCount} field(s): ${fieldKeys.join(', ')}`));
      if (cob.unset?.methods?.length) console.log(chalk.gray(`     unset methods: ${cob.unset.methods.join(', ')}`));
      console.log('');
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
