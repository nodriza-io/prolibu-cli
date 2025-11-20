module.exports = async function siteHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: ./prolibu site <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  create   Create a new site');
    console.log('  dev      Run site in development mode');
    console.log('  prod     Run site in production mode');
    console.log('  import   Import site from git repository');
    console.log('');
    console.log('Options:');
    console.log('  --domain <domain>');
    console.log('  --prefix <name>              Site name prefix');
    console.log('  --siteType <Static|SPA>      Site type (default: Static)');
    console.log('  --watch, -w                  Watch for changes and hot reload');
    console.log('  --port <port>                Local server port (default: 3000)');
    console.log('  --ext <extensions>           File extensions to watch (default: html,css,js)');
    console.log('  --repo <url>                 Git repository URL');
    console.log('  --apikey <key>               Prolibu API key');
    return;
  }

  if (command === 'create') {
    const createSite = require('./create');
    await createSite(flags, args);
  } else if (command === 'dev' || command === 'prod') {
    const runSite = require('./run');
    await runSite(command, flags, args);
  } else if (command === 'import') {
    const importSite = require('./import');
    await importSite(flags, args);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: create, dev, prod, import');
    process.exit(1);
  }
};
