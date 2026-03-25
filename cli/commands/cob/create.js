module.exports = async function createCob(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let filePath = flags.file;

  if (!filePath) {
    const inquirer = await import('inquirer');
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'file',
      message: 'Enter JSON file path:',
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
    const result = await api.createCob(domain, apiKey, body);
    console.log(chalk.green(`✅ Custom Object '${result.modelName}' created`));
    console.log(chalk.gray(`   ID: ${result._id}`));
    console.log(chalk.gray(`   API: /v2/${result.modelName.toLowerCase()}`));
  } catch (err) {
    const errData = err.response?.data;
    console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
    process.exit(1);
  }
};
