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

  // Resource type display config
  const resourceTypes = [
    { folder: 'scripts', icon: '⚡', label: 'Scripts' },
    { folder: 'sites', icon: '🌐', label: 'Sites' },
    { folder: 'plugins', icon: '🧩', label: 'Plugins' },
    { folder: 'vt', icon: '🎥', label: 'Virtual Tours' },
  ];

  console.log(chalk.cyan('\n📦 Prolibu Accounts:\n'));

  for (const entry of entries) {
    const accountPath = path.join(accountsDir, entry.name);
    const isGit = hasGitRepo(accountPath);

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

    for (const rt of resourceTypes) {
      const typeDir = path.join(accountPath, rt.folder);
      if (!fs.existsSync(typeDir)) continue;

      const items = fs.readdirSync(typeDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist');

      if (items.length === 0) continue;

      console.log(chalk.gray(`     ${rt.icon} ${rt.label}:`));
      for (const item of items) {
        console.log(chalk.gray(`        - ${item.name}`));
      }
    }
    console.log('');
  }
};
