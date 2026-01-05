const https = require('https');
const http = require('http');

/**
 * Fetch JSON data from a URL
 */
function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                ...headers
            }
        };

        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${e.message}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

module.exports = async function downloadVt(flags) {
    const inquirer = await import('inquirer');
    const path = require('path');
    const fs = require('fs');
    const { downloadVirtualTour } = require('../../../templates/vt/lib/download');

    let domain = flags.domain;
    let prefix = flags.prefix;
    let tourId = flags.id || flags.tour;

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

    // 2. prefix (optional, for organizing downloads)
    if (!prefix) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'prefix',
            message: 'Enter project name (for organizing downloads):',
            validate: input => input ? true : 'Project name is required.'
        });
        prefix = response.prefix;
    }

    // 3. tourId
    if (!tourId) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'tourId',
            message: 'Enter VirtualTour ID to download:',
            validate: input => input ? true : 'Tour ID is required.'
        });
        tourId = response.tourId;
    }

    // 4. Get API key from profile
    const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
    let apiKey = flags.apikey;

    if (!apiKey && fs.existsSync(profilePath)) {
        try {
            const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            apiKey = profileData.apiKey;
        } catch (e) {
            console.error('⚠️  Could not read profile.json:', e.message);
        }
    }

    if (!apiKey) {
        const response = await inquirer.default.prompt({
            type: 'password',
            name: 'apiKey',
            message: 'Enter API key:',
            validate: input => input ? true : 'API key is required.'
        });
        apiKey = response.apiKey;
    }

    console.log('');
    console.log('◯ || ▶ Prolibu VT Downloader');
    console.log('');
    console.log('🌐 Domain:', domain);
    console.log('📦 Tour ID:', tourId);
    console.log('');

    // 5. Fetch VirtualTour data
    console.log('📡 Fetching VirtualTour data...');

    const apiUrl = `https://${domain}/v2/virtualTour/view/${tourId}`;
    let tourData;

    try {
        tourData = await fetchJson(apiUrl, {
            'Cookie': `apiKey=${apiKey}`
        });
    } catch (error) {
        console.error(`❌ Error fetching VirtualTour: ${error.message}`);
        process.exit(1);
    }

    if (!tourData || !tourData._id) {
        console.error('❌ Invalid VirtualTour data received');
        process.exit(1);
    }

    console.log(`✅ Found: ${tourData.virtualTourName}`);
    console.log(`   - Type: ${tourData.eventType || 'Automotive'}`);
    console.log(`   - ${tourData.scenes?.length || 0} scenes`);
    if (tourData.eventType === 'Spaces') {
        console.log(`   - ${tourData.floorPlans?.length || 0} floor plans`);
    } else {
        console.log(`   - ${tourData.config?.automotiveColors?.external?.length || 0} external colors`);
        console.log(`   - ${tourData.config?.automotiveColors?.internal?.length || 0} internal colors`);
    }

    // 6. Create output directory
    const vtDir = path.join(process.cwd(), 'accounts', domain, prefix);
    const virtualToursPath = path.join(vtDir, 'virtualTours');

    if (!fs.existsSync(virtualToursPath)) {
        fs.mkdirSync(virtualToursPath, { recursive: true });
    }

    // 7. Download everything
    const result = await downloadVirtualTour(tourData, virtualToursPath);

    console.log('');
    console.log('═'.repeat(60));
    console.log('📊 DOWNLOAD COMPLETE');
    console.log('═'.repeat(60));
    console.log(`📁 Location: ${result.tourPath}`);
    console.log(`📥 Files downloaded: ${result.totalFiles}`);
    console.log('');
    console.log('To re-upload this tour, run:');
    console.log(`  ./prolibu vt bulk --domain ${domain} --prefix ${prefix}`);
    console.log('');
};
