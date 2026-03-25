module.exports = async function getCob(flags) {
  const chalk = (await import('chalk')).default;
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let id = flags.id;

  if (!id) {
    const inquirer = await import('inquirer');
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: 'Enter Custom Object ID:',
      validate: (v) => (v ? true : 'ID is required.'),
    });
    id = r.id;
  }

  try {
    const cob = await api.getCob(domain, apiKey, id);
    console.log(chalk.cyan(`\n🧩 Custom Object: ${cob.modelName}\n`));
    console.log(JSON.stringify(cob, null, 2));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
