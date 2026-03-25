module.exports = async function updateCustomField(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);
  let id = flags.id;
  let filePath = flags.file;

  if (!id) {
    const inquirer = await import('inquirer');
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'id',
      message: 'Enter Custom Field ID to update:',
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
    const result = await api.updateCustomField(domain, apiKey, id, body);
    console.log(chalk.green(`✅ Custom Field '${result.objectAssigned}' updated`));
    if (result.status) console.log(chalk.gray(`   Status: ${result.status}`));
  } catch (err) {
    const errData = err.response?.data;
    console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
    if (errData?.field) console.error(chalk.red(`   Field: ${errData.field}`));
    process.exit(1);
  }
};
