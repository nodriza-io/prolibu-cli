module.exports = async function scriptHandler(command, flags, args) {
  const inquirer = await import('inquirer');
  
  if (!command) {
    console.log('Usage: ./prolibu script <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  create   Create a new script');
    console.log('  dev      Run script in development mode');
    console.log('  prod     Run script in production mode');
    console.log('  import   Import script from git repository');
    console.log('  test     Run script tests');
    console.log('');
    console.log('Options:');
    console.log('  --domain <domain>');
    console.log('  --prefix <name>              Script name prefix');
    console.log('  --file <fileName>            Entry file name (default: index)');
    console.log('  --watch, -w                  Watch for changes and sync');
    console.log('  --repo <url>                 Git repository URL');
    console.log('  --lifecycleHooks <hooks>     Comma-separated hooks');
    console.log('  --apikey <key>               Prolibu API key');
    return;
  }

  if (command === 'create') {
    const createScript = require('./create');
    await createScript(flags, args);
  } else if (command === 'dev' || command === 'prod') {
    const runScript = require('./run');
    await runScript(command, flags, args);
  } else if (command === 'import') {
    const importScript = require('./import');
    await importScript(flags, args);
  } else if (command === 'test') {
    const testScript = require('./test');
    await testScript(flags, args);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: create, dev, prod, import, test');
    process.exit(1);
  }
};
