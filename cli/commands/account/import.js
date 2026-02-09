module.exports = async function importAccount(flags) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  const chalk = (await import('chalk')).default;
  const { hasGitRepo, createGitignore } = require('../../core/gitUtil');

  let domain = flags.domain;
  let gitRepo = flags.repo;

  // Prompt for domain if not provided
  if (!domain) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter the account domain (e.g., account-faranda):',
      validate: input => input ? true : 'Domain is required.'
    });
    domain = response.domain;
  }

  // Prompt for git repo if not provided
  if (!gitRepo) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'gitRepo',
      message: 'Enter the git repository URL for this account:',
      validate: input => input ? true : 'Git repository URL is required.'
    });
    gitRepo = response.gitRepo;
  }

  const accountDir = path.join(process.cwd(), 'accounts', domain);

  // If folder already exists, handle it
  if (fs.existsSync(accountDir) && fs.readdirSync(accountDir).length > 0) {
    // Check if it's already a git repo
    if (hasGitRepo(accountDir)) {
      const { action } = await inquirer.default.prompt({
        type: 'list',
        name: 'action',
        message: `Account '${domain}' already exists with a git repo. What do you want to do?`,
        choices: [
          { name: 'Pull latest changes (git pull)', value: 'pull' },
          { name: 'Delete and re-clone from scratch', value: 'reclone' },
          { name: 'Cancel', value: 'cancel' }
        ]
      });

      if (action === 'cancel') {
        console.log('Aborted by user.');
        return;
      }

      if (action === 'pull') {
        try {
          console.log(chalk.cyan(`\n📥 Pulling latest changes for '${domain}'...`));
          execSync('git pull', { cwd: accountDir, stdio: 'inherit' });
          console.log(chalk.green(`\n✅ Account '${domain}' updated successfully.`));
          listAccountScripts(accountDir, domain, chalk);
          return;
        } catch (err) {
          console.error(chalk.red(`\n❌ Git pull failed: ${err.message}`));
          process.exit(1);
        }
      }

      // reclone: delete and continue below
      fs.rmSync(accountDir, { recursive: true, force: true });
      console.log(chalk.yellow(`[CLEANUP] Deleted existing folder: ${accountDir}`));
    } else {
      // Not a git repo, ask what to do
      const { confirmDelete } = await inquirer.default.prompt({
        type: 'confirm',
        name: 'confirmDelete',
        message: `The folder '${domain}' already exists but is NOT a git repo. Delete it and import?`,
        default: false
      });
      if (!confirmDelete) {
        console.log('Aborted by user.');
        return;
      }
      fs.rmSync(accountDir, { recursive: true, force: true });
      console.log(chalk.yellow(`[CLEANUP] Deleted existing folder: ${accountDir}`));
    }
  }

  // Clone the repo
  try {
    console.log(chalk.cyan(`\n📥 Cloning account '${domain}' from ${gitRepo}...`));
    execSync(`git clone ${gitRepo} ${accountDir}`, { stdio: 'inherit' });
    console.log(chalk.green(`\n✅ Account '${domain}' imported successfully to accounts/${domain}/`));
  } catch (err) {
    console.error(chalk.red(`\n❌ Failed to clone repository: ${err.message}`));
    process.exit(1);
  }

  // Ensure .gitignore exists
  createGitignore(accountDir);

  // List detected scripts/sites/plugins
  listAccountScripts(accountDir, domain, chalk);

  console.log(chalk.cyan('\nNext steps:'));
  console.log(`  To run a script:  ${chalk.green(`./prolibu script dev --domain ${domain} --prefix <script-name> --watch`)}`);
  console.log(`  To update:        ${chalk.green(`./prolibu account pull --domain ${domain}`)}`);
};

/**
 * Lists all scripts/plugins/sites detected in the account folder
 */
function listAccountScripts(accountDir, domain, chalk) {
  const fs = require('fs');
  const path = require('path');
  
  const entries = fs.readdirSync(accountDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist');

  if (entries.length === 0) {
    console.log(chalk.yellow('\n⚠️  No scripts/plugins found in this account.'));
    return;
  }

  console.log(chalk.cyan(`\n📦 Detected items in '${domain}':`));
  
  for (const entry of entries) {
    const entryPath = path.join(accountDir, entry.name);
    const hasIndex = fs.existsSync(path.join(entryPath, 'index.js'));
    const hasConfig = fs.existsSync(path.join(entryPath, 'config.json'));
    const hasPublic = fs.existsSync(path.join(entryPath, 'public'));
    
    let type = '📄 unknown';
    if (hasPublic) {
      type = '🌐 site';
    } else if (hasIndex && hasConfig) {
      type = '⚡ script';
    } else if (hasIndex) {
      type = '📜 script';
    } else if (hasConfig) {
      type = '⚙️  config';
    }
    
    console.log(`  ${type}  ${chalk.white(entry.name)}`);
  }
}
