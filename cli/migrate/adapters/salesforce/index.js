module.exports = async function salesforceHandler(command, flags, args) {
  if (!command) {
    console.log('Usage: prolibu migrate salesforce <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  configure   Set up Salesforce credentials and migration config for a domain');
    console.log('  run         Execute the migration (Salesforce → Prolibu)');
    console.log('  status      Show credentials, config, and last run summary');
    console.log('  apex-to-js  Convert Apex code (.cls/.apex/.trigger) to Prolibu script using AI');
    console.log('');
    console.log('Migration phases (--phase <name>):');
    console.log('  discover    Introspect Salesforce — list all SObjects, fields, counts, and Apex code');
    console.log('  review      Interactive UI to map objects/fields and export prolibu_setup.json');
    console.log('  scaffold    Generate objects/Cob/ and objects/CustomField/ files from prolibu_setup.json');
    console.log('  migrate     Fetch records from Salesforce and write to Prolibu');
    console.log('');
    console.log('Scaffold options:');
    console.log('  --force     Overwrite existing scaffold files');
    console.log('');
    console.log('Dashboard (CRM-agnostic):');
    console.log('  prolibu migrate --ui --domain <domain>');
    console.log('');
    console.log('Options:');
    console.log('  --domain <domain>          Prolibu domain (e.g. stg.prolibu.com)');
    console.log('  --entity <entity>          Entity to migrate: contacts | products | accounts | all');
    console.log('  --preset <preset>          Migration preset for configure: standard | minimal | full');
    console.log('  --dry-run                  Simulate migration without writing to Prolibu');
    console.log('  --instance-url <url>       Salesforce instance URL');
    console.log('  --client-key <key>         Salesforce Connected App Consumer Key');
    console.log('  --client-secret <secret>   Salesforce Connected App Consumer Secret');
    console.log('  --apikey <key>             Prolibu API key');
    console.log('');
    console.log('apex-to-js Options:');
    console.log('  --file <path>              Apex source file (.cls/.apex/.trigger)');
    console.log('  --scaffold                 Create full Prolibu script project (index.js + config.json + README)');
    console.log('  --api-key <key>            AI provider API key (or DEEPSEEK_API_KEY env var)');
    console.log('  --provider <name>          AI provider: deepseek (default), openai, anthropic');
    console.log('  --output <path>            Output file or directory path');
    console.log('');
    console.log('Examples:');
    console.log('  prolibu migrate salesforce configure --domain stg.prolibu.com');
    console.log('  prolibu migrate salesforce run --domain stg.prolibu.com --phase discover');
    console.log('  prolibu migrate salesforce run --domain stg.prolibu.com --phase review');
    console.log('  prolibu migrate salesforce run --domain stg.prolibu.com --phase scaffold');
    console.log('  prolibu objects push --domain stg.prolibu.com');
    console.log('  prolibu migrate salesforce run --domain stg.prolibu.com --phase migrate --entity all');
    console.log('  prolibu migrate salesforce run --domain stg.prolibu.com --entity all --dry-run');
    console.log('  prolibu migrate salesforce status --domain stg.prolibu.com');
    console.log('  prolibu migrate salesforce apex-to-js --file MyTrigger.trigger --domain stg.prolibu.com');
    return;
  }

  if (command === 'configure') {
    const configure = require('./configure');
    await configure(flags, args);
  } else if (command === 'run') {
    const run = require('./run');
    await run(flags, args);
  } else if (command === 'status') {
    const status = require('./status');
    await status(flags, args);
  } else if (command === 'apex-to-js') {
    const { handler } = require('./apex-to-js/converter');
    await handler(flags);
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('Available commands: configure, run, status, apex-to-js');
    console.log('For the migration dashboard: prolibu migrate --ui --domain <domain>');
    process.exit(1);
  }
};
