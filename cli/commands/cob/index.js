module.exports = async function cobHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: ./prolibu cob <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  list     List all custom objects');
    console.log('  get      Get a custom object by ID');
    console.log('  create   Create a custom object (interactive or from JSON file)');
    console.log('  update   Update a custom object from a JSON file');
    console.log('  delete   Delete a custom object by ID');
    console.log('  pull     Download all custom objects to local JSON files');
    console.log('  sync     Sync local objects (COB + CustomField) to the platform');
    console.log('');
    console.log('Options:');
    console.log('  --domain, -d <domain>      Account domain');
    console.log('  --modelName <name>         Model name for create (PascalCase)');
    console.log('  --id <id>                  Custom object ID (for get/update/delete)');
    console.log('  --file, -f <path>          JSON file path (for create/update)');
    console.log('');
    console.log('Examples:');
    console.log('  ./prolibu cob create --domain dev12.prolibu.com --modelName Vehicle');
    console.log('  ./prolibu cob create --domain dev12.prolibu.com -f cob-pet.json');
    console.log('  ./prolibu cob list --domain dev12.prolibu.com');
    console.log('  ./prolibu cob pull --domain dev12.prolibu.com');
    console.log('  ./prolibu cob sync --domain dev12.prolibu.com');
    return;
  }

  if (command === 'list' || command === 'ls') {
    const list = require('./list');
    await list(flags);
  } else if (command === 'get') {
    const get = require('./get');
    await get(flags);
  } else if (command === 'create') {
    const create = require('./create');
    await create(flags);
  } else if (command === 'update') {
    const update = require('./update');
    await update(flags);
  } else if (command === 'delete') {
    const del = require('./delete');
    await del(flags);
  } else if (command === 'pull') {
    const pull = require('./pull');
    await pull(flags);
  } else if (command === 'sync') {
    const sync = require('./sync');
    await sync(flags);
  } else if (command === 'push') {
    // Backward compat: push redirects to sync
    const sync = require('./sync');
    await sync(flags);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: list, get, create, update, delete, pull, sync');
    process.exit(1);
  }
};
