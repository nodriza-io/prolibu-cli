module.exports = async function getCustomField(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let id = flags.id;

  if (!id) {
    const inquirer = await import('inquirer');
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: 'Enter Custom Field ID:',
      validate: (v) => (v ? true : 'ID is required.'),
    });
    id = r.id;
  }

  try {
    const cf = await api.getCustomField(domain, apiKey, id);
    console.log(chalk.cyan(`\n📋 Custom Field: ${cf.objectAssigned}\n`));
    console.log(JSON.stringify(cf, null, 2));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
