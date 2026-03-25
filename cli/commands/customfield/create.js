module.exports = async function createCustomField(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

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
    const result = await api.createCustomField(domain, apiKey, body);
    console.log(chalk.green(`✅ Custom Field created for model '${result.objectAssigned}'`));
    console.log(chalk.gray(`   ID: ${result._id}`));
    if (result.status) console.log(chalk.gray(`   Status: ${result.status}`));
  } catch (err) {
    const errData = err.response?.data;
    console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
    if (errData?.field) console.error(chalk.red(`   Field: ${errData.field}`));
    process.exit(1);
  }
};
