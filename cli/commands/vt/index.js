module.exports = async function vtHandler(command, flags, args) {
    if (!command) {
        console.log('Usage: ./prolibu vt <command> [options]');
        console.log('');
        console.log('Commands:');
        console.log('  create        Create a new virtual tour workspace');
        console.log('  bulk          Upload virtual tours in bulk (creates new tours)');
        console.log('  pull          Download ALL virtual tours from an account');
        console.log('  push          Push local changes to existing tours (update without creating new)');
        console.log('  download      Download a single virtual tour by ID');
        console.log('');
        console.log('Options:');
        console.log('  --domain <domain>           Prolibu domain');
        console.log('  --prefix <name>             Virtual tour project name');
        console.log('  --apikey <key>              Prolibu API key');
        console.log('  --folder <path>             Path to virtualTours folder (default: ./virtualTours)');
        console.log('  --tour <name>               Process specific tour only');
        console.log('  --id <id>                   VirtualTour ID (for download)');
        console.log('  --type <type>               Tour type: automotive (default) or spaces');
        console.log('  --watch, -w                 Watch for changes and auto-upload');
        console.log('');
        console.log('Tour Types:');
        console.log('  automotive    🚗 For car configurators (colors + external/internal)');
        console.log('  spaces        🏠 For real estate/spaces (panoramas + floor plans)');
        console.log('');
        console.log('Examples:');
        console.log('  ./prolibu vt create --domain dev11.prolibu.com --prefix my-vt-project');
        console.log('  ./prolibu vt bulk --domain dev11.prolibu.com --prefix my-vt-project');
        console.log('  ./prolibu vt pull --domain cofino.prolibu.com --prefix cofino');
        console.log('  ./prolibu vt push --domain cofino.prolibu.com --prefix cofino');
        console.log('  ./prolibu vt push --domain cofino.prolibu.com --prefix cofino --tour BMW_81AP');
        console.log('  ./prolibu vt download --domain dev11.prolibu.com --prefix bmw --id 69416e08729e7ce2b7dca043');
        return;
    }

    if (command === 'create') {
        const createVt = require('./create');
        await createVt(flags, args);
    } else if (command === 'bulk') {
        const bulkVt = require('./bulk');
        await bulkVt(flags, args);
    } else if (command === 'pull' || command === 'download-all' || command === 'sync') {
        const pullVt = require('./download-all');
        await pullVt(flags, args);
    } else if (command === 'push') {
        const pushVt = require('./push');
        await pushVt(flags, args);
    } else if (command === 'download') {
        const downloadVt = require('./download');
        await downloadVt(flags, args);
    } else {
        console.error(`❌ Unknown command: ${command}`);
        console.log('Available commands: create, bulk, pull, push, download');
        process.exit(1);
    }
};
