module.exports = async function listAccounts(flags) {
  const path = require('path');
  const fs = require('fs');
  const chalk = (await import('chalk')).default;
  const { hasGitRepo } = require('../../core/gitUtil');
  const { execSync } = require('child_process');

  const accountsDir = path.join(process.cwd(), 'accounts');

  if (!fs.existsSync(accountsDir)) {
    console.log(chalk.yellow('⚠️  No accounts folder found.'));
    return;
  }

  const entries = fs.readdirSync(accountsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'));

  if (entries.length === 0) {
    console.log(chalk.yellow('⚠️  No accounts found in accounts/ folder.'));
    return;
  }

  console.log(chalk.cyan('\n📦 Prolibu Accounts:\n'));

  for (const entry of entries) {
    const accountPath = path.join(accountsDir, entry.name);
    const isGit = hasGitRepo(accountPath);
    
    // Count scripts/items in the account
    const items = fs.readdirSync(accountPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist');

    let gitInfo = '';
    if (isGit) {
      try {
        const remote = execSync('git remote get-url origin', { cwd: accountPath, stdio: 'pipe' }).toString().trim();
        gitInfo = chalk.gray(` (${remote})`);
      } catch {
        gitInfo = chalk.gray(' (git, no remote)');
      }
    }

    const gitIcon = isGit ? '🔗' : '📁';
    console.log(`  ${gitIcon} ${chalk.white.bold(entry.name)}${gitInfo}`);
    
    for (const item of items) {
      const itemPath = path.join(accountPath, item.name);
      const hasIndex = fs.existsSync(path.join(itemPath, 'index.js'));
      const hasPublic = fs.existsSync(path.join(itemPath, 'public'));
      
      let type = '  ';
      if (hasPublic) type = '🌐';
      else if (hasIndex) type = '⚡';
      else type = '📄';
      
      console.log(chalk.gray(`     ${type} ${item.name}`));
    }
    console.log('');
  }
};
