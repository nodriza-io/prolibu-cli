module.exports = async function pullCustomFields(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/customFieldClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  try {
    const result = await api.listCustomFields(domain, apiKey);
    const items = result.data || [];

    if (items.length === 0) {
      console.log(chalk.yellow('No custom fields found on the platform.'));
      return;
    }

    const cfDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'CustomField');
    fs.mkdirSync(cfDir, { recursive: true });

    for (const cf of items) {
      const fileName = `${cf.objectAssigned}.json`;
      const filePath = path.join(cfDir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(cf, null, 2));
      console.log(chalk.green(`  ✅ ${fileName}`));
    }

    console.log(chalk.cyan(`\n📥 Pulled ${items.length} custom field(s) to accounts/${domain}/objects/CustomField/`));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
