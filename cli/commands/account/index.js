module.exports = async function accountHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: ./prolibu account <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  import   Import an account from a git repository');
    console.log('  pull     Pull latest changes for an account');
    console.log('  push     Stage, commit and push changes for an account');
    console.log('  list     List all accounts and their scripts');
    console.log('');
    console.log('Options:');
    console.log('  --domain <domain>   Account domain/folder name');
    console.log('  --repo <url>        Git repository URL');
    console.log('  -m <message>        Commit message (for push)');
    console.log('');
    console.log('Examples:');
    console.log('  ./prolibu account import --domain accountname.prolibu.com --repo git@github.com:org/account-repo.git');
    console.log('  ./prolibu account pull --domain accountname.prolibu.com');
    console.log('  ./prolibu account push --domain accountname.prolibu.com -m "feat: update agreements-handler"');
    console.log('  ./prolibu account list');
    return;
  }

  if (command === 'import') {
    const importAccount = require('./import');
    await importAccount(flags);
  } else if (command === 'pull') {
    const pullAccount = require('./pull');
    await pullAccount(flags);
  } else if (command === 'push') {
    const pushAccount = require('./push');
    await pushAccount(flags);
  } else if (command === 'list' || command === 'ls') {
    const listAccounts = require('./list');
    await listAccounts(flags);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: import, pull, push, list');
    process.exit(1);
  }
};
