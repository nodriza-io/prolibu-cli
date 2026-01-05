module.exports = async function bulkVt(flags) {
    const inquirer = await import('inquirer');
    const path = require('path');
    const fs = require('fs');
    const chokidar = require('chokidar');

    let domain = flags.domain;
    let prefix = flags.prefix;
    let tourName = flags.tour;
    let folder = flags.folder || './virtualTours';
    let watch = flags.watch || flags.w;
    let tourType = flags.type || 'automotive'; // 'automotive' o 'spaces'

    // 1. domain
    if (!domain) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'domain',
            message: 'Enter domain:',
            validate: input => input ? true : 'Domain is required.'
        });
        domain = response.domain;
    }

    // 2. prefix
    if (!prefix) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'prefix',
            message: 'Enter virtual tour project name:',
            validate: input => input ? true : 'Project name is required.'
        });
        prefix = response.prefix;
    }

    // 3. Tour type (automotive or spaces)
    if (!flags.type) {
        const response = await inquirer.default.prompt({
            type: 'list',
            name: 'tourType',
            message: 'Select tour type:',
            choices: [
                { name: 'Automotive (colors + external/internal)', value: 'automotive' },
                { name: 'Spaces (panoramas + floor plans)', value: 'spaces' }
            ],
            default: 'automotive'
        });
        tourType = response.tourType;
    }

    // 3. Get API key from profile
    const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
    if (!fs.existsSync(profilePath)) {
        console.error(`❌ Profile not found for domain '${domain}'.`);
        console.log(`Run: ./prolibu vt create --domain ${domain} --prefix ${prefix}`);
        process.exit(1);
    }

    let apiKey;
    try {
        const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        apiKey = profileData.apiKey;
    } catch (e) {
        console.error('❌ Error reading profile.json:', e.message);
        process.exit(1);
    }

    if (!apiKey) {
        console.error('❌ API key not found in profile.json');
        process.exit(1);
    }

    // 4. Verify project directory
    const vtDir = path.join(process.cwd(), 'accounts', domain, prefix);
    if (!fs.existsSync(vtDir)) {
        console.error(`❌ Virtual tour project not found: ${vtDir}`);
        console.log(`Run: ./prolibu vt create --domain ${domain} --prefix ${prefix}`);
        process.exit(1);
    }

    // 5. Get virtualTours folder
    let virtualToursPath = path.isAbsolute(folder)
        ? folder
        : path.join(vtDir, folder);

    if (!fs.existsSync(virtualToursPath)) {
        console.error(`❌ Virtual tours folder not found: ${virtualToursPath}`);
        process.exit(1);
    }

    console.log('');
    console.log('◯ || ▶ Prolibu VT Bulk Uploader');
    console.log('');
    console.log('📁 Project:', vtDir);
    console.log('🌐 Domain:', domain);
    console.log('📂 Tours folder:', virtualToursPath);
    console.log('🏷️  Tour type:', tourType === 'spaces' ? '🏠 Spaces' : '🚗 Automotive');
    if (tourName) {
        console.log('🎯 Processing single tour:', tourName);
    }
    console.log('');

    // 6. Sync template files to project
    syncTemplateFiles(vtDir);

    // 7. Run the bulk upload script
    await runBulkUpload(vtDir, domain, apiKey, virtualToursPath, tourName, tourType);

    // 8. Watch mode
    if (watch) {
        console.log('');
        console.log('👀 Watch mode enabled. Press Ctrl+C to exit.');
        console.log('');

        const watcher = chokidar.watch(virtualToursPath, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            ignoreInitial: true
        });

        let uploadTimeout;
        watcher
            .on('add', path => {
                console.log(`📄 File added: ${path}`);
                scheduleUpload();
            })
            .on('change', path => {
                console.log(`📝 File changed: ${path}`);
                scheduleUpload();
            })
            .on('unlink', path => {
                console.log(`🗑️  File removed: ${path}`);
                scheduleUpload();
            });

        function scheduleUpload() {
            clearTimeout(uploadTimeout);
            uploadTimeout = setTimeout(async () => {
                console.log('');
                console.log('🔄 Changes detected, re-uploading...');
                console.log('');
                await runBulkUpload(vtDir, domain, apiKey, virtualToursPath, tourName, tourType);
            }, 2000); // Wait 2 seconds after last change
        }

        // Keep process alive
        process.stdin.resume();
    }
};

/**
 * Syncs template files to project directory
 */
function syncTemplateFiles(vtDir) {
    const fs = require('fs');
    const path = require('path');

    const projectRoot = path.resolve(__dirname, '../../..');
    const templateDir = path.join(projectRoot, 'templates', 'vt');

    // Files to sync
    const filesToSync = [
        { src: 'index.js', dest: 'index.js' },
        { src: 'lib/utils.js', dest: 'lib/utils.js' },
        { src: 'lib/ui.js', dest: 'lib/ui.js' },
    ];

    for (const file of filesToSync) {
        const srcPath = path.join(templateDir, file.src);
        const destPath = path.join(vtDir, file.dest);

        if (fs.existsSync(srcPath)) {
            // Ensure dest directory exists
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Runs the bulk upload script
 */
async function runBulkUpload(vtDir, domain, apiKey, virtualToursPath, tourName, tourType = 'automotive') {
    const { fork } = require('child_process');
    const path = require('path');

    // Get the project root (prolibu-cli folder)
    const projectRoot = path.resolve(__dirname, '../../..');

    return new Promise((resolve, reject) => {
        // Prepare environment variables
        const env = {
            ...process.env,
            DOMAIN: domain,
            API_KEY: apiKey,
            VIRTUAL_TOURS_PATH: virtualToursPath,
            TOUR_TYPE: tourType,
            // Add project root to NODE_PATH so lib/ modules can be found
            NODE_PATH: projectRoot
        };

        if (tourName) {
            env.TOUR_NAME = tourName;
        }

        // Fork the index.js script
        const indexPath = path.join(vtDir, 'index.js');
        const child = fork(indexPath, [], {
            cwd: vtDir,
            env,
            stdio: 'inherit'
        });

        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}
