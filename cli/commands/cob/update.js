module.exports = async function updateCob(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let id = flags.id;
  let filePath = flags.file;

  if (!id) {
    const inquirer = await import('inquirer');
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: 'Enter Custom Object ID to update:',
      validate: (v) => (v ? true : 'ID is required.'),
    });
    id = r.id;
  }

  if (!filePath) {
    const inquirer = await import('inquirer');
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'file',
      message: 'Enter JSON file path with updates:',
      validate: (v) => (v ? true : 'File path is required.'),
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
    const result = await api.updateCob(domain, apiKey, id, body);
    console.log(chalk.green(`✅ Custom Object '${result.modelName}' updated`));
  } catch (err) {
    const errData = err.response?.data;
    console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
    process.exit(1);
  }
};
