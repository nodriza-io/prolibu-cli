module.exports = async function pushVt(flags) {
    const inquirer = await import('inquirer');
    const path = require('path');
    const fs = require('fs');
    const axios = require('axios');
    const FormData = require('form-data');

    let domain = flags.domain;
    let prefix = flags.prefix;
    let tourName = flags.tour;
    let tourType = flags.type;

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
            message: 'Enter project name:',
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

    // 4. Verify project directory
    const vtDir = path.join(process.cwd(), 'accounts', domain, 'vt', prefix);
    const virtualToursPath = path.join(vtDir, 'virtualTours');

    if (!fs.existsSync(virtualToursPath)) {
        console.error(`❌ Virtual tour project not found: ${virtualToursPath}`);
        console.log(`Run: ./prolibu vt download-all --domain ${domain} --prefix ${prefix}`);
        process.exit(1);
    }

    // 5. Get tour folders
    let tourFolders = fs.readdirSync(virtualToursPath)
        .filter(f => fs.statSync(path.join(virtualToursPath, f)).isDirectory());

    if (tourName) {
        tourFolders = tourFolders.filter(f => f === tourName);
        if (tourFolders.length === 0) {
            console.error(`❌ Tour folder "${tourName}" not found in ${virtualToursPath}`);
            process.exit(1);
        }
    }

    if (tourFolders.length === 0) {
        console.log('⚠️  No tour folders found.');
        return;
    }

    console.log('');
    console.log('◯ || ▶ Prolibu VT Push (Update Existing Tours)');
    console.log('');
    console.log('🌐 Domain:', domain);
    console.log('📁 Project:', vtDir);
    console.log(`📂 Tours: ${tourFolders.length} folder(s)`);
    console.log('');

    // 6. Initialize API client
    const client = axios.create({
        baseURL: `https://${domain}/v2`,
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 300000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    // 7. Process each tour
    let updated = 0;
    let created = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < tourFolders.length; i++) {
        const folderName = tourFolders[i];
        const tourPath = path.join(virtualToursPath, folderName);

        console.log(`\n[${ i + 1}/${tourFolders.length}] 🔄 Processing: ${folderName}`);

        try {
            const result = await processTourPush(client, tourPath, folderName, tourType);
            if (result.action === 'updated') {
                console.log(`   ✅ Updated (${result.scenesCount} scenes)`);
                updated++;
            } else {
                console.log(`   ✅ Created new (${result.scenesCount} scenes)`);
                created++;
            }
        } catch (error) {
            console.error(`   ❌ Failed: ${error.message}`);
            errors.push({ name: folderName, error: error.message });
            failed++;
        }
    }

    // 8. Summary
    console.log('');
    console.log('═'.repeat(60));
    console.log('📊 PUSH COMPLETE');
    console.log('═'.repeat(60));
    console.log(`🔄 Updated: ${updated}`);
    console.log(`📥 Created: ${created}`);
    if (failed > 0) {
        console.log(`❌ Failed: ${failed}`);
        errors.forEach(e => console.log(`   - ${e.name}: ${e.error}`));
    }
    console.log('');
};

// ═══════════════════════════════════════════════════════════════════════════
// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

async function processTourPush(client, tourPath, folderName, forceTourType) {
    const fs = require('fs');
    const path = require('path');

    // Load config
    const config = loadConfig(tourPath);
    const tourType = forceTourType || (config.eventType?.toLowerCase() === 'spaces' ? 'spaces' : 'automotive');

    // Try to find existing tour
    let existingTour = null;
    let action = 'created';

    // Strategy 1: Use _id from config
    if (config._id) {
        try {
            const response = await client.get(`/virtualTour/view/${config._id}`);
            if (response.data && response.data._id) {
                existingTour = response.data;
            }
        } catch (e) {
            // Tour may have been deleted, continue to strategy 2
        }
    }

    // Strategy 2: Find by virtualTourCode via xquery
    if (!existingTour) {
        const code = config.virtualTourCode || folderName;
        try {
            const response = await client.get('/virtualTour', {
                params: {
                    xquery: JSON.stringify({ virtualTourCode: code }),
                    limit: 1
                }
            });
            const results = response.data;
            const tours = Array.isArray(results) ? results : (results.results || results.data || []);
            if (tours.length > 0) {
                existingTour = tours[0];
            }
        } catch (e) {
            // Continue to create
        }
    }

    let virtualTourId;

    if (existingTour) {
        // UPDATE FLOW
        action = 'updated';
        virtualTourId = existingTour._id;
        console.log(`   🔍 Found existing tour: ${existingTour.virtualTourName} (${virtualTourId})`);

        // Update tour config
        const updatePayload = buildUpdatePayload(config, folderName, tourType);
        await client.patch(`/virtualtour/${virtualTourId}`, updatePayload);

        // Delete old scenes
        const oldScenes = existingTour.scenes || [];
        if (oldScenes.length > 0) {
            console.log(`   🗑️  Removing ${oldScenes.length} old scenes...`);
            for (const scene of oldScenes) {
                const sceneId = typeof scene === 'string' ? scene : scene._id;
                if (sceneId) {
                    try {
                        await client.delete(`/scene/${sceneId}`);
                    } catch (e) {
                        // Scene may already be deleted
                    }
                }
            }
        }

        // Delete old floorPlans (spaces)
        if (tourType === 'spaces') {
            const oldFloorPlans = existingTour.floorPlans || [];
            if (oldFloorPlans.length > 0) {
                console.log(`   🗑️  Removing ${oldFloorPlans.length} old floor plans...`);
                for (const fp of oldFloorPlans) {
                    const fpId = typeof fp === 'string' ? fp : fp._id;
                    if (fpId) {
                        try {
                            await client.delete(`/floorPlan/${fpId}`);
                        } catch (e) {
                            // May already be deleted
                        }
                    }
                }
            }
        }
    } else {
        // CREATE FLOW
        action = 'created';
        const createPayload = buildCreatePayload(config, folderName, tourType);
        const response = await client.post('/virtualtour', createPayload);
        virtualTourId = response.data._id;
        console.log(`   🆕 Created tour: ${response.data.virtualTourName} (${virtualTourId})`);
    }

    // Upload colors (automotive only)
    let colorMap = { external: {}, internal: {} };
    if (tourType === 'automotive') {
        colorMap = await uploadColors(client, tourPath, virtualTourId);
        const totalColors = Object.keys(colorMap.external).length + Object.keys(colorMap.internal).length;
        if (totalColors > 0) {
            console.log(`   🎨 ${totalColors} colors uploaded`);
            await client.patch(`/virtualtour/${virtualTourId}`, {
                'config.automotiveColors.external': Object.values(colorMap.external).map(c => c.id),
                'config.automotiveColors.internal': Object.values(colorMap.internal).map(c => c.id)
            });
        }
    }

    // Upload scenes
    const scenesCount = await uploadScenes(client, tourPath, virtualTourId, colorMap, tourType);

    // Upload floorPlans (spaces only)
    if (tourType === 'spaces') {
        await uploadFloorPlans(client, tourPath, virtualTourId);
    }

    // Update _config.json with _id for future pushes
    if (!config._id) {
        config._id = virtualTourId;
        const configPath = path.join(tourPath, '_config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    return { action, scenesCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function loadConfig(tourPath) {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(tourPath, '_config.json');
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

function slugToName(slug) {
    return slug
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function getImageFiles(dirPath) {
    const fs = require('fs');
    const path = require('path');
    const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
    return fs.readdirSync(dirPath)
        .filter(f => {
            const ext = path.extname(f).toLowerCase();
            return IMAGE_EXTENSIONS.includes(ext) && !f.startsWith('.');
        })
        .sort();
}

function parseFileName(filename) {
    const path = require('path');
    const PREFIXES = { '2d': '2d_', '360': '360_', 'sequence': 'seq_' };
    const baseName = path.basename(filename, path.extname(filename));

    for (const [sceneType, prefix] of Object.entries(PREFIXES)) {
        if (baseName.toLowerCase().startsWith(prefix.toLowerCase())) {
            let nameWithoutPrefix = baseName.substring(prefix.length);
            if ((sceneType === '2d' || sceneType === '360') && /_\d{1,3}$/.test(nameWithoutPrefix)) {
                nameWithoutPrefix = nameWithoutPrefix.replace(/_\d{1,3}$/, '');
            }
            return { sceneType, sceneName: slugToName(nameWithoutPrefix), originalName: baseName, prefix };
        }
    }

    throw new Error(`File "${filename}" has no valid prefix (2d_, 360_, seq_)`);
}

function groupFilesBySceneType(files, colorSlug) {
    const scenes = [];
    const sequenceFiles = [];

    for (const file of files) {
        if (file.sceneType === 'sequence') {
            sequenceFiles.push(file);
        } else {
            scenes.push({
                sceneName: file.sceneName || `${slugToName(colorSlug)} ${file.sceneType}`,
                sceneType: file.sceneType,
                files: [file.path]
            });
        }
    }

    if (sequenceFiles.length > 0) {
        sequenceFiles.sort((a, b) => {
            const numA = extractNumber(a.originalName);
            const numB = extractNumber(b.originalName);
            if (numA !== null && numB !== null) return numA - numB;
            return a.originalName.localeCompare(b.originalName);
        });

        let sequenceName = sequenceFiles[0].sceneName;
        if (!sequenceName || sequenceName === slugToName('')) {
            sequenceName = `${slugToName(colorSlug)} Sequence`;
        }

        scenes.push({
            sceneName: sequenceName,
            sceneType: 'sequence',
            files: sequenceFiles.map(f => f.path)
        });
    }

    return scenes;
}

function extractNumber(name) {
    const match = name.match(/(\d+)(?:\.\w+)?$/);
    return match ? parseInt(match[1], 10) : null;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYLOADS
// ═══════════════════════════════════════════════════════════════════════════

function buildBaseConfig(tourType) {
    return {
        ui: {
            fullscreen: true,
            enableRibbon: true,
            hideRibbonAtStart: false,
            splash: { enabled: false },
            isHideShareButton: false
        },
        panorama: { tinyPlanet: false, autoRotate: true, autoRotateSpeed: 1 },
        camera: {
            lockHorizontalFov: tourType === 'spaces',
            enableLimits: true,
            limitDown: tourType === 'spaces' ? 90 : 50,
            limitUp: tourType === 'spaces' ? 115 : 180,
            disableZoomInIframe: true
        },
        sequence: {
            drag: { enabled: true, swipeable: true, speed: 100, reverse: false },
            autoplay: { enabled: false, speed: 100 },
            zoom: { pointerZoom: false, scale: 1.5 },
            ui: { showBadge: false, showFrameIndicator: true }
        }
    };
}

function buildUpdatePayload(config, folderName, tourType) {
    const payload = {};
    if (config.virtualTourName) payload.virtualTourName = config.virtualTourName;
    if (config.description) payload.description = config.description;
    if (config.config) {
        // Merge base config with saved config
        const base = buildBaseConfig(tourType);
        payload.config = { ...base, ...config.config };
    }
    return payload;
}

function buildCreatePayload(config, folderName, tourType) {
    const tourName = config.virtualTourName || slugToName(folderName);
    const base = buildBaseConfig(tourType);

    let typeConfig = {};
    if (tourType === 'automotive') {
        typeConfig = {
            theme: config.config?.theme || 'flow',
            automotiveColors: { external: [], internal: [] }
        };
    } else {
        typeConfig = {
            theme: config.config?.theme || 'cascade',
            automotiveColors: { external: [], internal: [] },
            floorPlan: { showOpened: true },
            hotspots: { enableAudio: true, allowToggle: false, showInfospotTitle: true },
            navigation: { mode: 'normal', legacyMode: 'initial' }
        };
    }

    return {
        virtualTourName: tourName,
        virtualTourCode: config.virtualTourCode || folderName,
        description: config.description || `Virtual tour: ${tourName}`,
        eventType: tourType === 'spaces' ? 'Spaces' : 'Automotive',
        config: { ...base, ...typeConfig, ...(config.config || {}) }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function uploadColors(client, tourPath, virtualTourId) {
    const fs = require('fs');
    const path = require('path');
    const FormData = require('form-data');

    const colorsPath = path.join(tourPath, '_colors');
    const colorMap = { external: {}, internal: {} };

    if (!fs.existsSync(colorsPath)) return colorMap;

    for (const automotiveType of ['external', 'internal']) {
        const typePath = path.join(colorsPath, automotiveType);
        if (!fs.existsSync(typePath)) continue;

        const files = getImageFiles(typePath);
        for (const file of files) {
            const colorSlug = path.basename(file, path.extname(file));
            const colorName = slugToName(colorSlug);
            const colorCode = colorSlug.toUpperCase().replace(/[^A-Z0-9]/g, '-').substring(0, 20);
            const uuid = generateUUID();

            const formData = new FormData();
            formData.append('file', fs.createReadStream(path.join(typePath, file)));
            formData.append('isPublic', 'true');
            formData.append('filePath', `.api/VirtualTour/${virtualTourId}/config.automotiveColors.${automotiveType}/${colorSlug}${path.extname(file)}`);
            formData.append('meta.id', uuid);
            formData.append('meta.name', colorName);
            formData.append('meta.hex', '#000000');
            formData.append('meta.code', colorCode);
            formData.append('meta.type', 'automotive-color');

            try {
                const response = await client.post('/file', formData, {
                    headers: formData.getHeaders()
                });
                colorMap[automotiveType][colorSlug] = { id: response.data._id, name: colorName };
            } catch (e) {
                console.error(`   ⚠️  Color upload failed: ${colorName} - ${e.message}`);
            }
        }
    }

    return colorMap;
}

async function uploadScenes(client, tourPath, virtualTourId, colorMap, tourType) {
    const fs = require('fs');
    const path = require('path');
    const FormData = require('form-data');

    const allScenes = collectScenes(tourPath, colorMap, tourType);

    if (allScenes.length === 0) {
        console.log(`   ⚠️  No scenes found`);
        return 0;
    }

    console.log(`   🎬 Uploading ${allScenes.length} scenes...`);
    const sceneIds = [];

    for (let i = 0; i < allScenes.length; i++) {
        const sceneData = allScenes[i];

        const formData = new FormData();
        formData.append('sceneName', sceneData.sceneName);
        formData.append('sceneType', sceneData.sceneType);
        formData.append('automotiveType', sceneData.automotiveType);
        formData.append('automotiveColor', sceneData.colorId || 'null');

        for (const filePath of sceneData.files) {
            const fileName = path.basename(filePath);
            formData.append('media', fs.createReadStream(filePath), fileName);
        }

        try {
            const response = await client.post('/scene/', formData, {
                headers: formData.getHeaders()
            });
            sceneIds.push(response.data._id);
        } catch (e) {
            console.error(`   ⚠️  Scene failed: ${sceneData.sceneName} - ${e.message}`);
        }
    }

    // Link scenes to tour
    if (sceneIds.length > 0) {
        await client.patch(`/virtualtour/${virtualTourId}`, { scenes: sceneIds });
    }

    return sceneIds.length;
}

function collectScenes(tourPath, colorMap, tourType) {
    const fs = require('fs');
    const path = require('path');
    const allScenes = [];

    if (tourType === 'spaces') {
        const scenesPath = path.join(tourPath, 'scenes');
        if (!fs.existsSync(scenesPath)) return allScenes;

        const imageFiles = getImageFiles(scenesPath);
        for (const file of imageFiles) {
            let sceneType = '360';
            let sceneName = slugToName(path.basename(file, path.extname(file)));

            try {
                const parsed = parseFileName(file);
                sceneType = parsed.sceneType;
                sceneName = parsed.sceneName;
            } catch (e) {
                // Default to 360
            }

            allScenes.push({
                sceneName,
                sceneType,
                files: [path.join(scenesPath, file)],
                automotiveType: 'external',
                colorId: null
            });
        }
    } else {
        // Automotive: external/internal by color
        const typeMappings = [
            { folder: 'external', type: 'external' },
            { folder: 'exterior', type: 'external' },
            { folder: 'internal', type: 'internal' },
            { folder: 'interior', type: 'internal' }
        ];

        for (const { folder, type: automotiveType } of typeMappings) {
            const typePath = path.join(tourPath, folder);
            if (!fs.existsSync(typePath)) continue;

            const colorFolders = fs.readdirSync(typePath)
                .filter(f => fs.statSync(path.join(typePath, f)).isDirectory());

            for (const colorSlug of colorFolders) {
                const colorPath = path.join(typePath, colorSlug);
                let colorInfo = colorMap[automotiveType][colorSlug];

                if (!colorInfo) {
                    const normalizedSlug = colorSlug.toLowerCase().replace(/\s+/g, '-');
                    colorInfo = colorMap[automotiveType][normalizedSlug];
                }

                const imageFiles = getImageFiles(colorPath);
                if (imageFiles.length === 0) continue;

                const files = imageFiles.map(file => {
                    try {
                        return {
                            name: file,
                            path: path.join(colorPath, file),
                            ...parseFileName(file)
                        };
                    } catch (e) {
                        return null;
                    }
                }).filter(Boolean);

                if (files.length === 0) continue;

                const grouped = groupFilesBySceneType(files, colorSlug);

                for (const sceneData of grouped) {
                    allScenes.push({
                        ...sceneData,
                        automotiveType,
                        colorId: colorInfo ? colorInfo.id : null
                    });
                }
            }
        }
    }

    return allScenes;
}

async function uploadFloorPlans(client, tourPath, virtualTourId) {
    const fs = require('fs');
    const path = require('path');
    const FormData = require('form-data');

    const floorPlansPath = path.join(tourPath, '_floorplans');
    if (!fs.existsSync(floorPlansPath)) return;

    const imageFiles = getImageFiles(floorPlansPath);
    if (imageFiles.length === 0) return;

    console.log(`   🗺️  Uploading ${imageFiles.length} floor plans...`);
    const floorPlanIds = [];

    for (const file of imageFiles) {
        const floorPlanName = slugToName(path.basename(file, path.extname(file)));
        const filePath = path.join(floorPlansPath, file);

        const formData = new FormData();
        formData.append('floorPlanName', floorPlanName);
        formData.append('media', fs.createReadStream(filePath), file);

        try {
            const response = await client.post('/floorPlan/', formData, {
                headers: formData.getHeaders()
            });
            floorPlanIds.push(response.data._id);
        } catch (e) {
            console.error(`   ⚠️  FloorPlan failed: ${floorPlanName} - ${e.message}`);
        }
    }

    if (floorPlanIds.length > 0) {
        await client.patch(`/virtualtour/${virtualTourId}`, { floorPlans: floorPlanIds });
    }
}
