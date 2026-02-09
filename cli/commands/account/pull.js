module.exports = async function pullAccount(flags) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  const chalk = (await import('chalk')).default;
  const { hasGitRepo } = require('../../core/gitUtil');

  let domain = flags.domain;

  // Prompt for domain if not provided
  if (!domain) {
    // List available accounts that have git repos
    const accountsDir = path.join(process.cwd(), 'accounts');
    const availableAccounts = [];
    
    if (fs.existsSync(accountsDir)) {
      const entries = fs.readdirSync(accountsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'));
      
      for (const entry of entries) {
        const accountPath = path.join(accountsDir, entry.name);
        if (hasGitRepo(accountPath)) {
          availableAccounts.push(entry.name);
        }
      }
    }

    if (availableAccounts.length > 0) {
      const response = await inquirer.default.prompt({
        type: 'list',
        name: 'domain',
        message: 'Select account to pull:',
        choices: [...availableAccounts, { name: 'Enter manually...', value: '__manual__' }]
      });
      domain = response.domain;
    }
    
    if (!domain || domain === '__manual__') {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'domain',
        message: 'Enter the account domain:',
        validate: input => input ? true : 'Domain is required.'
      });
      domain = response.domain;
    }
  }

  const accountDir = path.join(process.cwd(), 'accounts', domain);

  // Validate account exists
  if (!fs.existsSync(accountDir)) {
    console.error(chalk.red(`❌ Account folder not found: accounts/${domain}/`));
    console.log(`Use ${chalk.green(`./prolibu account import --domain ${domain}`)} to import it first.`);
    process.exit(1);
  }

  // Validate it has git
  if (!hasGitRepo(accountDir)) {
    console.error(chalk.red(`❌ Account '${domain}' is not a git repository.`));
    console.log(`Use ${chalk.green(`./prolibu account import --domain ${domain} --repo <url>`)} to set it up.`);
    process.exit(1);
  }

  // Pull latest changes
  try {
    console.log(chalk.cyan(`\n📥 Pulling latest changes for '${domain}'...`));
    execSync('git pull', { cwd: accountDir, stdio: 'inherit' });
    console.log(chalk.green(`\n✅ Account '${domain}' updated successfully.`));
  } catch (err) {
    console.error(chalk.red(`\n❌ Git pull failed: ${err.message}`));
    process.exit(1);
  }
};
