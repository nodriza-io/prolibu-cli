module.exports = async function deleteCustomField(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let id = flags.id;

  if (!id) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: 'Enter Custom Field ID to delete:',
      validate: (v) => (v ? true : 'ID is required.'),
    });
    id = r.id;
  }

  // Fetch first to show details
  try {
    const cf = await api.getCustomField(domain, apiKey, id);
    console.log(chalk.yellow(`\n⚠️  About to delete Custom Field for model '${cf.objectAssigned}' (${id})`));
  } catch {
    console.error(chalk.red(`❌ Custom Field with ID '${id}' not found.`));
    process.exit(1);
  }

  const { confirm } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'Are you sure you want to delete this Custom Field?',
    default: false,
  });

  if (!confirm) {
    console.log('Aborted.');
    return;
  }

  try {
    await api.deleteCustomField(domain, apiKey, id);
    console.log(chalk.green('✅ Custom Field deleted successfully.'));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
