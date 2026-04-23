module.exports = async function objectHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: ./prolibu object <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  list     List all Custom Objects (COBs) and Custom Fields');
    console.log('  get      Get a COB or Custom Field by ID');
    console.log('  create   Create a new model (COB) or extend an existing one (CustomField)');
    console.log('  update   Update a COB or Custom Field from a JSON file');
    console.log('  delete   Delete a COB or Custom Field by ID');
    console.log('  pull     Download all COBs and Custom Fields to local JSON files');
    console.log('  sync     Sync local objects (COB + CustomField) to the platform');
    console.log('');
    console.log('Options:');
    console.log('  --domain, -d <domain>      Account domain');
    console.log('  --type <cob|cf>            Object type (for get/update/delete)');
    console.log('  --modelName <name>         Model name for create (PascalCase)');
    console.log('  --id <id>                  Object ID (for get/update/delete)');
    console.log('  --file, -f <path>          JSON file path (for create/update)');
    console.log('');
    console.log('Examples:');
    console.log('  ./prolibu object list --domain dev12.prolibu.com');
    console.log('  ./prolibu object create --domain dev12.prolibu.com');
    console.log('  ./prolibu object get --domain dev12.prolibu.com --type cob --id 64a...');
    console.log('  ./prolibu object pull --domain dev12.prolibu.com');
    console.log('  ./prolibu object sync --domain dev12.prolibu.com');
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
    // Backward compat
    const sync = require('./sync');
    await sync(flags);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: list, get, create, update, delete, pull, sync');
    process.exit(1);
  }
};
