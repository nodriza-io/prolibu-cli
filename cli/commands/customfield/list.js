module.exports = async function listCustomFields(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  const query = {};
  if (flags.model) query.objectAssigned = flags.model;

  try {
    const result = await api.listCustomFields(domain, apiKey, query);
    const items = result.data || [];

    if (items.length === 0) {
      console.log(chalk.yellow('No custom fields found.'));
      return;
    }

    console.log(chalk.cyan(`\n📋 Custom Fields on ${domain} (${items.length}):\n`));

    for (const cf of items) {
      const cfCount = cf.customFields ? Object.keys(cf.customFields).length : 0;
      const ovCount = cf.overrides ? Object.keys(cf.overrides).length : 0;
      const status = cf.active ? chalk.green('active') : chalk.red('inactive');

      console.log(`  ${chalk.white.bold(cf.objectAssigned)} ${chalk.gray(`(${cf._id})`)} [${status}]`);
      if (cfCount) console.log(chalk.gray(`     customFields: ${cfCount} fields`));
      if (ovCount) console.log(chalk.gray(`     overrides: ${ovCount} fields`));
      if (cf.status) console.log(chalk.gray(`     status: ${cf.status}`));
      console.log('');
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
