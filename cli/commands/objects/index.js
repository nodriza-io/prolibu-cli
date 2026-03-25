module.exports = async function objectsHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: ./prolibu objects <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  create   Create a new Custom Object (COB) scaffold locally');
    console.log('  list     List all Custom Objects and Custom Fields');
    console.log('  pull     Download all objects to local JSON files');
    console.log('  push     Upload local object JSON files to the platform');
    console.log('');
    console.log('  cob <cmd>          Manage Custom Objects (list, get, create, update, delete, pull, push)');
    console.log('  customfield <cmd>  Manage Custom Fields (list, get, create, update, delete, pull, push)');
    console.log('');
    console.log('Options:');
    console.log('  --domain, -d <domain>     Account domain');
    console.log('  --modelName <name>        Model name for new COB (PascalCase)');
    console.log('');
    console.log('Examples:');
    console.log('  ./prolibu objects create --domain dev12.prolibu.com --modelName Pet');
    console.log('  ./prolibu objects list --domain dev12.prolibu.com');
    console.log('  ./prolibu objects pull --domain dev12.prolibu.com');
    console.log('  ./prolibu objects push --domain dev12.prolibu.com');
    console.log('  ./prolibu objects cob list --domain dev12.prolibu.com');
    console.log('  ./prolibu objects customfield pull --domain dev12.prolibu.com');
    return;
  }

  // Sub-routing to cob/customfield handlers
  if (command === 'cob') {
    const cobHandler = require('../cob/index');
    const subCommand = args[2];
    await cobHandler(subCommand, flags, args.slice(1));
    return;
  }

  if (command === 'customfield' || command === 'cf') {
    const cfHandler = require('../customfield/index');
    const subCommand = args[2];
    await cfHandler(subCommand, flags, args.slice(1));
    return;
  }

  if (command === 'create') {
    const create = require('./create');
    await create(flags);
  } else if (command === 'list' || command === 'ls') {
    const list = require('./list');
    await list(flags);
  } else if (command === 'pull') {
    const pull = require('./pull');
    await pull(flags);
  } else if (command === 'push') {
    const push = require('./push');
    await push(flags);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: create, list, pull, push, cob, customfield');
    process.exit(1);
  }
};
