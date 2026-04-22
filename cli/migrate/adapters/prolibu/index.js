'use strict';

module.exports = async function prolibuHandler(command, flags) {
  if (!command) {
    console.log('Usage: prolibu migrate prolibu <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  configure   Save source Prolibu credentials for a destination domain');
    console.log('  run         Execute the migration phases (Prolibu → Prolibu)');
    console.log('  status      Show credentials and last discovery summary');
    console.log('');
    console.log('Migration phases (--phase <name>):');
    console.log('  discover    Fetch custom objects, custom fields, and scripts from source');
    console.log('  scaffold    Sync custom fields and custom objects to destination');
    console.log('  migrate     Fetch records, transform, and write to destination');
    console.log('');
    console.log('Options:');
    console.log('  --domain <domain>          Destination Prolibu domain');
    console.log('  --apikey <key>             Destination Prolibu API key');
    console.log('  --entity <name|all>        Entity to migrate (default: all)');
    console.log('  --dry-run                  Run without writing to destination');
    console.log('  --force                    Re-migrate already-mapped records');
    console.log('');
    console.log('Examples:');
    console.log('  prolibu migrate prolibu configure --domain dest.prolibu.com');
    console.log('  prolibu migrate prolibu run --domain dest.prolibu.com --phase discover');
    console.log('  prolibu migrate prolibu run --domain dest.prolibu.com --phase migrate --entity companies');
    console.log('  prolibu migrate prolibu run --domain dest.prolibu.com --phase migrate --dry-run');
    console.log('  prolibu migrate prolibu status --domain dest.prolibu.com');
    return;
  }

  if (command === 'configure') {
    const configure = require('./configure');
    await configure(flags);
  } else if (command === 'run') {
    const run = require('./run');
    await run(flags);
  } else if (command === 'status') {
    const status = require('./status');
    await status(flags);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: configure, run, status');
    process.exit(1);
  }
};
