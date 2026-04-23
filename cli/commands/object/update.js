module.exports = async function updateObject(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
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
      message: `Enter ${type === 'cob' ? 'Custom Object' : 'Custom Field'} ID to update:`,
      validate: (v) => v ? true : 'ID is required.',
    });
    id = r.id;
  }

  let filePath = flags.file;
  if (!filePath) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'file',
      message: 'Enter JSON file path with updates:',
      validate: (v) => v ? true : 'File path is required.',
    });
    filePath = r.file;
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(chalk.red(`❌ File not found: ${resolved}`));
    process.exit(1);
  }

  try {
    const body = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (type === 'cob') {
      const result = await cobApi.updateCob(domain, apiKey, id, body);
      console.log(chalk.green(`✅ Custom Object '${result.modelName}' updated`));
    } else {
      const result = await cfApi.updateCustomField(domain, apiKey, id, body);
      console.log(chalk.green(`✅ Custom Field '${result.objectAssigned}' updated`));
      if (result.status) console.log(chalk.gray(`   Status: ${result.status}`));
    }
  } catch (err) {
    const errData = err.response?.data;
    console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
    process.exit(1);
  }
};
