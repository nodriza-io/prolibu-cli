module.exports = async function pluginHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: ./prolibu plugin <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  create   Create a new plugin project');
    console.log('  dev      Run plugin in development mode with HMR');
    console.log('  prod     Build and publish plugin to production');
    console.log('  import   Import plugin from git repository');
    console.log('');
    console.log('Options:');
    console.log('  --domain <domain>            Prolibu domain (e.g., dev10.prolibu.com)');
    console.log('  --prefix <name>              Plugin name prefix');
    console.log('  --watch, -w                  Watch for changes (dev mode)');
    console.log('  --port <port>                Dev server port (default: 4500)');
    console.log('  --repo <url>                 Git repository URL');
    console.log('  --apikey <key>               Prolibu API key');
    console.log('');
    console.log('Examples:');
    console.log('  ./prolibu plugin create --domain dev10.prolibu.com --prefix my-plugin');
    console.log('  ./prolibu plugin dev --domain dev10.prolibu.com --prefix my-plugin --watch');
    console.log('  ./prolibu plugin prod --domain dev10.prolibu.com --prefix my-plugin');
    return;
  }

  if (command === 'create') {
    const createPlugin = require('./create');
    await createPlugin(flags, args);
  } else if (command === 'dev' || command === 'prod') {
    const runPlugin = require('./run');
    await runPlugin(command, flags, args);
  } else if (command === 'import') {
    const importPlugin = require('./import');
    await importPlugin(flags, args);
  } else {
    console.error(`Unknown command: ${command}`);
    console.log('Available commands: create, dev, prod, import');
    process.exit(1);
  }
};
