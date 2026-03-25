module.exports = async function deleteCob(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let id = flags.id;

  if (!id) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: 'Enter Custom Object ID to delete:',
      validate: (v) => (v ? true : 'ID is required.'),
    });
    id = r.id;
  }

  // Fetch first to show details
  try {
    const cob = await api.getCob(domain, apiKey, id);
    console.log(chalk.yellow(`\n⚠️  About to delete Custom Object '${cob.modelName}' (${id})`));
  } catch {
    console.error(chalk.red(`❌ Custom Object with ID '${id}' not found.`));
    process.exit(1);
  }

  const { confirm } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'Are you sure you want to delete this Custom Object?',
    default: false,
  });

  if (!confirm) {
    console.log('Aborted.');
    return;
  }

  try {
    await api.deleteCob(domain, apiKey, id);
    console.log(chalk.green('✅ Custom Object deleted successfully.'));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
