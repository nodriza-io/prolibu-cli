module.exports = async function pullCobs(flags) {
  const chalk = (await import('chalk')).default;
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');
  const api = require('../../../api/cobClient');

  const { domain, apiKey } = await resolveDomainAndKey(flags);

  try {
    const result = await api.listCobs(domain, apiKey);
    const items = result.data || [];

    if (items.length === 0) {
      console.log(chalk.yellow('No custom objects found on the platform.'));
      return;
    }

    const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
    fs.mkdirSync(cobDir, { recursive: true });

    for (const cob of items) {
      const fileName = `${cob.modelName}.json`;
      const filePath = path.join(cobDir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(cob, null, 2));
      console.log(chalk.green(`  ✅ ${fileName}`));
    }

    console.log(chalk.cyan(`\n📥 Pulled ${items.length} custom object(s) to accounts/${domain}/objects/Cob/`));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.response?.data?.error || err.message}`));
    process.exit(1);
  }
};
