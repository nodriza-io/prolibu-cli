module.exports = async function getObject(flags) {
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
      message: `Enter ${type === 'cob' ? 'Custom Object' : 'Custom Field'} ID:`,
      validate: (v) => v ? true : 'ID is required.',
    });
    id = r.id;
  }

  try {
    if (type === 'cob') {
      const cob = await cobApi.getCob(domain, apiKey, id);
      console.log(chalk.cyan(`\n🧩 Custom Object: ${cob.modelName}\n`));
      console.log(JSON.stringify(cob, null, 2));
    } else {
      const cf = await cfApi.getCustomField(domain, apiKey, id);
      console.log(chalk.cyan(`\n📋 Custom Field: ${cf.objectAssigned}\n`));
      console.log(JSON.stringify(cf, null, 2));
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
