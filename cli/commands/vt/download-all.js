module.exports = async function downloadAllVt(flags) {
    const inquirer = await import('inquirer');
    const path = require('path');
    const fs = require('fs');
    const axios = require('axios');
    const { downloadVirtualTour } = require('../../../templates/vt/lib/download');

    let domain = flags.domain;
    let prefix = flags.prefix;

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

    // 2. prefix (for organizing downloads)
    if (!prefix) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'prefix',
            message: 'Enter project name (for organizing downloads):',
            default: 'all',
            validate: input => input ? true : 'Project name is required.'
        });
        prefix = response.prefix;
    }

    // 3. Get API key from profile
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
    console.log('◯ || ▶ Prolibu VT Sync (Download All / Update)');
    console.log('');
    console.log('🌐 Domain:', domain);
    console.log('');

    // 4. Initialize API client
    const client = axios.create({
        baseURL: `https://${domain}/v2`,
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        }
    });

    // 5. Fetch all VirtualTours list
    console.log('📡 Fetching VirtualTour list...');

    let tours;

    try {
        const response = await client.get('/virtualTour', { params: { limit: 1000 } });
        const tourList = response.data;
        tours = Array.isArray(tourList) ? tourList : (tourList.data || tourList.results || []);
    } catch (error) {
        const msg = error.response ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message;
        console.error(`❌ Error fetching VirtualTour list: ${msg}`);
        process.exit(1);
    }

    if (!tours.length) {
        console.log('⚠️  No virtual tours found in this account.');
        return;
    }

    console.log(`✅ Found ${tours.length} virtual tour(s)`);
    console.log('');

    // 5. Create output directory
    const vtDir = path.join(process.cwd(), 'accounts', domain, 'vt', prefix);
    const virtualToursPath = path.join(vtDir, 'virtualTours');

    if (!fs.existsSync(virtualToursPath)) {
        fs.mkdirSync(virtualToursPath, { recursive: true });
    }

    // 6. Download/update each tour
    let downloaded = 0;
    let updated = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < tours.length; i++) {
        const tour = tours[i];
        const tourId = tour._id;
        const tourName = tour.virtualTourName || tour.name || tourId;
        const tourCode = tour.virtualTourCode || tourName;
        const existingPath = path.join(virtualToursPath, tourCode);
        const isUpdate = fs.existsSync(existingPath);

        const action = isUpdate ? '🔄 Updating' : '📥 Downloading';
        console.log(`\n[${i + 1}/${tours.length}] ${action}: ${tourName} (${tourId})`);

        try {
            // Fetch full tour data
            const response = await client.get(`/virtualTour/view/${tourId}`);
            const tourData = response.data;

            if (!tourData || !tourData._id) {
                throw new Error('Invalid VirtualTour data received');
            }

            const result = await downloadVirtualTour(tourData, virtualToursPath);
            console.log(`   ✅ ${result.totalFiles} files → ${result.tourPath}`);
            if (isUpdate) {
                updated++;
            } else {
                downloaded++;
            }
        } catch (error) {
            console.error(`   ❌ Failed: ${error.message}`);
            errors.push({ name: tourName, id: tourId, error: error.message });
            failed++;
        }
    }

    // 7. Summary
    console.log('');
    console.log('═'.repeat(60));
    console.log('📊 SYNC COMPLETE');
    console.log('═'.repeat(60));
    console.log(`📁 Location: ${virtualToursPath}`);
    console.log(`📥 New: ${downloaded}`);
    console.log(`🔄 Updated: ${updated}`);
    if (failed > 0) {
        console.log(`❌ Failed: ${failed}`);
        errors.forEach(e => console.log(`   - ${e.name} (${e.id}): ${e.error}`));
    }
    console.log('');
    console.log('To re-upload these tours, run:');
    console.log(`  ./prolibu vt bulk --domain ${domain} --prefix ${prefix}`);
    console.log('');
};
