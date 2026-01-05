/**
 * Virtual Tour Bulk Creator
 * 
 * Crea VirtualTours masivamente desde estructura de carpetas.
 * Soporta dos tipos: Automotive y Spaces.
 * 
 * ESTRUCTURA DE CARPETAS (AUTOMOTIVE):
 * virtualTours/
 * └── NOMBRE_TOUR/
 *     ├── _config.json          # Opcional: metadatos del tour
 *     ├── _colors/
 *     │   ├── external/         # Texturas de colores externos
 *     │   └── internal/         # Texturas de colores internos
 *     ├── external/
 *     │   └── {color-slug}/
 *     │       └── seq_*.png     # Sequences (múltiples = 1 scene)
 *     └── internal/
 *         └── {color-slug}/
 *             ├── 2d_*.jpeg     # 2D (cada archivo = 1 scene)
 *             ├── 360_*.webp    # 360 (cada archivo = 1 scene)
 *             └── seq_*.png     # Sequences
 * 
 * ESTRUCTURA DE CARPETAS (SPACES):
 * virtualTours/
 * └── NOMBRE_TOUR/
 *     ├── _config.json          # Opcional: metadatos del tour
 *     ├── _floorplans/          # Planos de piso (opcional)
 *     │   └── {name}.{jpg|png}  # Imagen del plano
 *     └── scenes/
 *         └── 360_*.webp        # 360 panoramas (cada archivo = 1 scene)
 * 
 * PREFIJOS:
 * - 2d_   → sceneType: '2d'
 * - 360_  → sceneType: '360'
 * - seq_  → sceneType: 'sequence'
 * 
 * TOUR_TYPE:
 * - automotive: Usa colores y estructura external/internal (default)
 * - spaces: Sin colores, scenes directas en scenes/
 */

const ProlibuApi = require('lib/vendors/prolibu/ProlibuApi');
const sleep = require('lib/utils/sleep');
const {
    slugToName,
    parseFileName,
    groupFilesBySceneType,
    getImageFiles
} = require('./lib/utils');

const ui = require('./lib/ui');

// Configuración desde variables de entorno
const DOMAIN = process.env.DOMAIN;
const API_KEY = process.env.API_KEY;
const VIRTUAL_TOURS_PATH = process.env.VIRTUAL_TOURS_PATH || './virtualTours';
const TOUR_NAME = process.env.TOUR_NAME; // Opcional: procesar solo un tour
const TOUR_TYPE = process.env.TOUR_TYPE || 'automotive'; // 'automotive' o 'spaces'

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES PRINCIPALES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Procesa todos los tours en la carpeta virtualTours/
 */
async function createVirtualToursFromFolders(api) {
    const fs = require('fs');
    const path = require('path');
    const startTime = Date.now();

    if (!fs.existsSync(VIRTUAL_TOURS_PATH)) {
        ui.printError(`Carpeta ${VIRTUAL_TOURS_PATH} no existe`);
        return { success: false, error: 'Carpeta virtualTours no encontrada' };
    }

    let tourFolders = fs.readdirSync(VIRTUAL_TOURS_PATH)
        .filter(folder => {
            const folderPath = path.join(VIRTUAL_TOURS_PATH, folder);
            return fs.statSync(folderPath).isDirectory();
        });

    // Filtrar por tour específico si se proporciona
    if (TOUR_NAME) {
        tourFolders = tourFolders.filter(folder => folder === TOUR_NAME);
        if (tourFolders.length === 0) {
            ui.printError(`Tour "${TOUR_NAME}" no encontrado`);
            return { success: false, error: `Tour ${TOUR_NAME} no encontrado` };
        }
    }

    if (tourFolders.length === 0) {
        ui.printWarning('No se encontraron carpetas de tours en virtualTours/');
        return { success: false, error: 'No hay tours para procesar' };
    }

    // Mostrar tours encontrados
    ui.printSection(`Found ${tourFolders.length} tour(s)`, '📁');
    for (const folder of tourFolders) {
        console.log(`     ${ui.c.dim('•')} ${folder}`);
    }

    const results = [];

    for (let i = 0; i < tourFolders.length; i++) {
        const tourFolderName = tourFolders[i];
        ui.printTourHeader(tourFolderName, i + 1, tourFolders.length);

        try {
            const result = await processTour(api, tourFolderName);
            results.push({ tour: tourFolderName, ...result });

            console.log('');
            ui.printSuccess(`Tour completed successfully`);
        } catch (error) {
            ui.printError(`Error: ${error.message}`);
            results.push({ tour: tourFolderName, success: false, error: error.message });
        }
    }

    const totalTime = Date.now() - startTime;
    return { success: true, results, totalTime };
}

/**
 * Procesa un tour individual
 */
async function processTour(api, tourFolderName) {
    const fs = require('fs');
    const path = require('path');

    const tourPath = path.join(VIRTUAL_TOURS_PATH, tourFolderName);

    // 1. Cargar configuración opcional
    const spinner = ui.createSpinner('Loading configuration...');
    spinner.start();

    const config = loadConfig(tourPath);

    // Detectar tipo de tour desde config o variable de entorno
    const tourType = config.eventType?.toLowerCase() === 'spaces' ? 'spaces' :
        (TOUR_TYPE === 'spaces' ? 'spaces' : 'automotive');

    spinner.succeed(`Config: ${ui.c.cyan(config.virtualTourName || tourFolderName)} [${ui.c.yellow(tourType)}]`);

    let colorMap = { external: {}, internal: {} };
    let totalColors = 0;

    // 2. Solo procesar colores para Automotive
    if (tourType === 'automotive') {
        const colorSpinner = ui.createSpinner('Processing colors...');
        colorSpinner.start();

        colorMap = await uploadColors(api, tourPath, colorSpinner);
        totalColors = Object.keys(colorMap.external).length + Object.keys(colorMap.internal).length;
        colorSpinner.succeed(`Colors: ${ui.c.green(totalColors)} registered`);
    }

    // 3. Crear VirtualTour
    const vtSpinner = ui.createSpinner('Creating VirtualTour...');
    vtSpinner.start();

    const virtualTour = await createVirtualTour(api, tourFolderName, config, colorMap, tourType);
    vtSpinner.succeed(`VirtualTour: ${ui.c.cyan(virtualTour._id)}`);

    // 4. Crear scenes
    console.log('');
    const scenesCreated = await createScenes(api, tourPath, virtualTour._id, colorMap, tourType);

    // 5. Crear floorPlans (solo para Spaces)
    let floorPlansCreated = 0;
    if (tourType === 'spaces') {
        floorPlansCreated = await createFloorPlans(api, tourPath, virtualTour._id);
    }

    return {
        success: true,
        virtualTourId: virtualTour._id,
        virtualTourName: virtualTour.virtualTourName,
        colorsCount: totalColors,
        scenesCount: scenesCreated,
        floorPlansCount: floorPlansCreated
    };
}

/**
 * Carga configuración del tour desde _config.json
 */
function loadConfig(tourPath) {
    const fs = require('fs');
    const path = require('path');

    const configPath = path.join(tourPath, '_config.json');
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
            ui.printWarning(`Error reading _config.json: ${e.message}`);
        }
    }
    return {};
}

/**
 * Sube los archivos de colores y retorna un mapa de colorSlug → colorId
 */
async function uploadColors(api, tourPath, spinner) {
    const fs = require('fs');
    const path = require('path');

    const colorsPath = path.join(tourPath, '_colors');
    const colorMap = { external: {}, internal: {} };

    if (!fs.existsSync(colorsPath)) {
        return colorMap;
    }

    let colorCount = 0;
    const allColors = [];

    // Count total colors first
    for (const automotiveType of ['external', 'internal']) {
        const typePath = path.join(colorsPath, automotiveType);
        if (!fs.existsSync(typePath)) continue;
        const files = getImageFiles(typePath);
        files.forEach(file => allColors.push({ file, type: automotiveType, path: typePath }));
    }

    for (const { file, type, path: typePath } of allColors) {
        const colorSlug = path.basename(file, path.extname(file));
        const colorName = slugToName(colorSlug);

        spinner.update(`Uploading color ${++colorCount}/${allColors.length}: ${colorName}`);

        try {
            const fileId = await uploadColorFile(api, {
                filePath: path.join(typePath, file),
                colorName,
                colorSlug,
                automotiveType: type
            });

            if (fileId) {
                colorMap[type][colorSlug] = {
                    id: fileId,
                    name: colorName
                };
            }
        } catch (error) {
            // Silent fail, will be handled later
        }

        await sleep(100);
    }

    return colorMap;
}

/**
 * Genera un UUID v4
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Sube un archivo de color con metadatos
 */
async function uploadColorFile(api, { filePath, colorName, colorSlug, automotiveType }) {
    const fs = require('fs');
    const path = require('path');
    const FormData = require('form-data');

    const formData = new FormData();
    const fileName = path.basename(filePath);
    const timestamp = Date.now();
    const colorCode = colorSlug.toUpperCase().replace(/[^A-Z0-9]/g, '-').substring(0, 20);
    const uuid = generateUUID();

    formData.append('file', fs.createReadStream(filePath));
    formData.append('isPublic', 'true');
    formData.append('filePath', `.api/virtualTour/config.${automotiveType}/${timestamp}_${fileName}`);
    formData.append('meta.id', uuid);
    formData.append('meta.name', colorName);
    formData.append('meta.hex', '#000000');
    formData.append('meta.code', colorCode);
    formData.append('meta.type', 'automotive-color');

    const response = await api.axios.post('/v2/file', formData, {
        headers: formData.getHeaders(),
        timeout: 60000
    });

    return response.data._id;
}

/**
 * Crea el VirtualTour con la configuración
 */
async function createVirtualTour(api, folderName, config, colorMap, tourType = 'automotive') {
    const tourName = config.virtualTourName || slugToName(folderName);

    // Configuración base compartida
    const baseConfig = {
        ui: {
            fullscreen: true,
            enableRibbon: true,
            hideRibbonAtStart: false,
            splash: { enabled: false },
            isHideShareButton: false
        },
        panorama: {
            tinyPlanet: false,
            autoRotate: true,
            autoRotateSpeed: 1
        },
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

    // Configuración específica por tipo
    let typeConfig = {};
    if (tourType === 'automotive') {
        typeConfig = {
            theme: config.config?.theme || 'flow',
            automotiveColors: {
                external: Object.values(colorMap.external).map(c => c.id),
                internal: Object.values(colorMap.internal).map(c => c.id)
            }
        };
    } else {
        // Spaces
        typeConfig = {
            theme: config.config?.theme || 'cascade',
            automotiveColors: { external: [], internal: [] },
            floorPlan: { showOpened: true },
            hotspots: {
                enableAudio: true,
                allowToggle: false,
                showInfospotTitle: true
            },
            navigation: {
                mode: 'normal',
                legacyMode: 'initial'
            }
        };
    }

    const payload = {
        virtualTourName: tourName,
        virtualTourCode: folderName,
        description: config.description || `Virtual tour: ${tourName}`,
        eventType: tourType === 'spaces' ? 'Spaces' : 'Automotive',
        config: {
            ...baseConfig,
            ...typeConfig,
            ...config.config
        }
    };

    return await api.create('virtualtour', payload);
}

/**
 * Crea las scenes para un tour
 */
async function createScenes(api, tourPath, virtualTourId, colorMap, tourType = 'automotive') {
    const fs = require('fs');
    const path = require('path');

    // Collect all scenes first
    const allScenes = [];

    if (tourType === 'spaces') {
        // Para Spaces: buscar en scenes/ directamente
        const scenesPath = path.join(tourPath, 'scenes');
        if (fs.existsSync(scenesPath)) {
            const imageFiles = getImageFiles(scenesPath);

            for (const file of imageFiles) {
                try {
                    const parsed = parseFileName(file);
                    allScenes.push({
                        sceneName: parsed.sceneName,
                        sceneType: parsed.sceneType,
                        files: [path.join(scenesPath, file)],
                        automotiveType: 'external', // Default para spaces
                        colorInfo: { id: null, name: '' }
                    });
                } catch (e) {
                    // Si no tiene prefijo, asumir 360
                    const baseName = path.basename(file, path.extname(file));
                    allScenes.push({
                        sceneName: slugToName(baseName),
                        sceneType: '360',
                        files: [path.join(scenesPath, file)],
                        automotiveType: 'external',
                        colorInfo: { id: null, name: '' }
                    });
                }
            }
        }
    } else {
        // Para Automotive: buscar en external/internal por color
        const automotiveTypeMappings = [
            { folder: 'external', type: 'external' },
            { folder: 'exterior', type: 'external' },
            { folder: 'internal', type: 'internal' },
            { folder: 'interior', type: 'internal' }
        ];

        for (const { folder, type: automotiveType } of automotiveTypeMappings) {
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
                    if (!colorInfo) {
                        colorInfo = { id: null, name: slugToName(colorSlug) };
                    }
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
                        colorInfo
                    });
                }
            }
        }
    }

    if (allScenes.length === 0) {
        ui.printWarning('No scenes found');
        return 0;
    }

    // Create progress bar for scenes
    const progressBar = ui.createProgressBar({
        format: '  {bar} {percentage}% | {value}/{total} scenes | {task}'
    });

    progressBar.start(allScenes.length, 0, { task: 'Starting...' });

    const sceneIds = [];

    for (let i = 0; i < allScenes.length; i++) {
        const sceneData = allScenes[i];
        const taskName = `${sceneData.sceneName} (${sceneData.sceneType})`;
        progressBar.update(i, { task: ui.truncate(taskName, 30) });

        try {
            const scene = await createScene(api, {
                sceneName: sceneData.sceneName,
                sceneType: sceneData.sceneType,
                automotiveType: sceneData.automotiveType,
                automotiveColorId: sceneData.colorInfo.id,
                files: sceneData.files
            });

            sceneIds.push(scene._id);
        } catch (error) {
            // Continue on error
        }

        await sleep(200);
        progressBar.update(i + 1, { task: ui.truncate(taskName, 30) });
    }

    progressBar.stop();

    // Associate scenes with VirtualTour
    if (sceneIds.length > 0) {
        const linkSpinner = ui.createSpinner(`Linking ${sceneIds.length} scenes...`);
        linkSpinner.start();

        await api.update('virtualtour', virtualTourId, {
            scenes: sceneIds
        });

        linkSpinner.succeed(`Linked ${ui.c.green(sceneIds.length)} scenes to VirtualTour`);
    }

    return sceneIds.length;
}

/**
 * Crea una scene individual con su media
 */
async function createScene(api, { sceneName, sceneType, automotiveType, automotiveColorId, files }) {
    const fs = require('fs');
    const path = require('path');
    const FormData = require('form-data');

    const formData = new FormData();

    formData.append('sceneName', sceneName);
    formData.append('sceneType', sceneType);
    formData.append('automotiveType', automotiveType);
    formData.append('automotiveColor', automotiveColorId || 'null');

    for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const fileName = path.basename(filePath);
        formData.append('media', fs.createReadStream(filePath), fileName);
    }

    const response = await api.axios.post('/v2/scene/', formData, {
        headers: formData.getHeaders(),
        timeout: 300000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    return response.data;
}

/**
 * Crea los floorPlans para un tour de tipo Spaces
 */
async function createFloorPlans(api, tourPath, virtualTourId) {
    const fs = require('fs');
    const path = require('path');
    const FormData = require('form-data');

    const floorPlansPath = path.join(tourPath, '_floorplans');
    if (!fs.existsSync(floorPlansPath)) {
        return 0;
    }

    const imageFiles = getImageFiles(floorPlansPath);
    if (imageFiles.length === 0) {
        return 0;
    }

    const floorPlanSpinner = ui.createSpinner(`Creating ${imageFiles.length} floor plans...`);
    floorPlanSpinner.start();

    const floorPlanIds = [];

    for (const file of imageFiles) {
        const floorPlanName = slugToName(path.basename(file, path.extname(file)));
        const filePath = path.join(floorPlansPath, file);

        try {
            const formData = new FormData();
            formData.append('floorPlanName', floorPlanName);
            formData.append('media', fs.createReadStream(filePath), file);

            const response = await api.axios.post('/v2/floorPlan/', formData, {
                headers: formData.getHeaders(),
                timeout: 60000
            });

            floorPlanIds.push(response.data._id);
        } catch (error) {
            // Continue on error
        }

        await sleep(200);
    }

    // Associate floorPlans with VirtualTour
    if (floorPlanIds.length > 0) {
        await api.update('virtualtour', virtualTourId, {
            floorPlans: floorPlanIds
        });
    }

    floorPlanSpinner.succeed(`Created ${ui.c.green(floorPlanIds.length)} floor plans`);
    return floorPlanIds.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

(async function main() {
    // Print header
    ui.printHeader('VIRTUAL TOUR BULK CREATOR', 'Prolibu CLI v1.0');

    if (!DOMAIN || !API_KEY) {
        ui.printError('Missing required environment variables: DOMAIN and API_KEY');
        process.exit(1);
    }

    // Print config
    ui.printSection('Configuration', '⚙️');
    ui.printInfo('Domain', ui.c.cyan(DOMAIN));
    ui.printInfo('Path', VIRTUAL_TOURS_PATH);
    ui.printInfo('Type', ui.c.magenta(TOUR_TYPE));
    if (TOUR_NAME) {
        ui.printInfo('Filter', ui.c.yellow(TOUR_NAME));
    }

    // Initialize API
    const apiSpinner = ui.createSpinner('Connecting to API...');
    apiSpinner.start();

    const api = new ProlibuApi({
        domain: DOMAIN,
        apiKey: API_KEY
    });

    apiSpinner.succeed('API connected');

    // Run bulk upload
    const result = await createVirtualToursFromFolders(api);

    // Show results table
    if (result.success && result.results && result.results.length > 0) {
        ui.printSection('Results', '📊');
        console.log(ui.createResultsTable(result.results));

        const successful = result.results.filter(r => r.success);
        const failed = result.results.filter(r => !r.success);

        ui.printSummary(successful.length, failed.length, result.totalTime);
    } else if (result.error) {
        ui.printError(result.error);
    }

    console.log('');
    process.exit(0);
})();
