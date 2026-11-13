module.exports = async function pushAccount(flags) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');
  const { execSync, execFileSync } = require('child_process');
  const chalk = (await import('chalk')).default;
  const { hasGitRepo } = require('../../core/gitUtil');

  let domain = flags.domain;
  let message = flags.message || flags.m;

  // Prompt for domain if not provided
  if (!domain) {
    const accountsDir = path.join(process.cwd(), 'accounts');
    const availableAccounts = [];
    
    if (fs.existsSync(accountsDir)) {
      const entries = fs.readdirSync(accountsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'));
      
      for (const entry of entries) {
        const accountPath = path.join(accountsDir, entry.name);
        if (hasGitRepo(accountPath)) {
          // Check if there are changes to push
          try {
            const status = execSync('git status --porcelain', { cwd: accountPath, stdio: 'pipe' }).toString().trim();
            const label = status ? `${entry.name} (${status.split('\n').length} changes)` : `${entry.name} (clean)`;
            availableAccounts.push({ name: label, value: entry.name });
          } catch {
            availableAccounts.push({ name: entry.name, value: entry.name });
          }
        }
      }
    }

    if (availableAccounts.length > 0) {
      const response = await inquirer.default.prompt({
        type: 'list',
        name: 'domain',
        message: 'Select account to push:',
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
    process.exit(1);
  }

  // Validate it has git
  if (!hasGitRepo(accountDir)) {
    console.error(chalk.red(`❌ Account '${domain}' is not a git repository.`));
    process.exit(1);
  }

  // API keys never leave the machine: profile.json and every profile.<name>.json, whatever the
  // account's own .gitignore says (a cloned repo keeps its .gitignore).
  const withoutKeys = ['--', '.', ':(exclude,glob)**/profile*.json'];
  const git = (args, stdio = 'pipe') => execFileSync('git', args, { cwd: accountDir, stdio });

  const committedKeys = git(['ls-files', '--', ':(glob)**/profile*.json']).toString().trim();
  if (committedKeys) {
    console.error(chalk.red(`❌ API key files are committed in '${domain}':\n${committedKeys}`));
    console.error(chalk.red('Rotate those keys, untrack the files with "git rm --cached <file>", and push again.'));
    process.exit(1);
  }

  // Show current status
  const status = git(['status', '--porcelain', ...withoutKeys]).toString().trim();
  
  if (!status) {
    console.log(chalk.green(`✅ Account '${domain}' is clean, nothing to push.`));
    return;
  }

  console.log(chalk.cyan(`\n📋 Changes in '${domain}':\n`));
  git(['status', '--short', ...withoutKeys], 'inherit');

  // Prompt for commit message if not provided
  if (!message) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'message',
      message: 'Commit message:',
      validate: input => input ? true : 'Commit message is required.'
    });
    message = response.message;
  }

  // Git add, commit, push
  try {
    console.log(chalk.cyan('\n📦 Staging all changes...'));
    git(['add', '--all', ...withoutKeys], 'inherit');

    console.log(chalk.cyan(`💾 Committing: "${message}"`));
    git(['commit', '-m', message], 'inherit'); // no shell: $(…) or backticks in the message stay text

    console.log(chalk.cyan('🚀 Pushing to remote...'));
    execSync('git push', { cwd: accountDir, stdio: 'inherit' });

    console.log(chalk.green(`\n✅ Account '${domain}' pushed successfully.`));
  } catch (err) {
    console.error(chalk.red(`\n❌ Push failed: ${err.message}`));
    process.exit(1);
  }
};
