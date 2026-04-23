module.exports = async function deleteObject(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const cobApi = require('../../../api/cobClient');
  const cfApi = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  // Determine type
  let type = flags.type;
  if (!type) {
    const r = await inquirer.default.prompt({
      type: 'list',
      name: 'type',
      message: 'Object type:',
      choices: [
        { name: 'Custom Object (COB)', value: 'cob' },
        { name: 'Custom Field', value: 'cf' },
      ],
    });
    type = r.type;
  }

  let id = flags.id;
  if (!id) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: `Enter ${type === 'cob' ? 'Custom Object' : 'Custom Field'} ID to delete:`,
      validate: (v) => v ? true : 'ID is required.',
    });
    id = r.id;
  }

  // Show what will be deleted
  try {
    if (type === 'cob') {
      const cob = await cobApi.getCob(domain, apiKey, id);
      console.log(chalk.yellow(`\n⚠️  About to delete Custom Object '${cob.modelName}' (${id})`));
    } else {
      const cf = await cfApi.getCustomField(domain, apiKey, id);
      console.log(chalk.yellow(`\n⚠️  About to delete Custom Field for '${cf.objectAssigned}' (${id})`));
    }
  } catch {
    console.error(chalk.red(`❌ Object with ID '${id}' not found.`));
    process.exit(1);
  }

  const { confirm } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'Are you sure you want to delete this?',
    default: false,
  });

  if (!confirm) {
    console.log('Aborted.');
    return;
  }

  try {
    if (type === 'cob') {
      await cobApi.deleteCob(domain, apiKey, id);
      console.log(chalk.green('✅ Custom Object deleted successfully.'));
    } else {
      await cfApi.deleteCustomField(domain, apiKey, id);
      console.log(chalk.green('✅ Custom Field deleted successfully.'));
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
