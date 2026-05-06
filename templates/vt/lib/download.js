/**
 * Virtual Tour Downloader
 * 
 * Descarga un VirtualTour existente y lo organiza en la estructura de carpetas
 * que espera el Bulk Creator para poder re-subirlo.
 * 
 * ESTRUCTURA GENERADA (AUTOMOTIVE):
 * virtualTours/
 * └── {TOUR_CODE}/
 *     ├── _config.json          # Metadatos del tour
 *     ├── _colors/
 *     │   ├── external/         # Texturas de colores externos
 *     │   │   └── {color-slug}.webp
 *     │   └── internal/         # Texturas de colores internos
 *     │       └── {color-slug}.webp
 *     ├── external/
 *     │   └── {color-slug}/
 *     │       └── seq_*.png     # Sequences
 *     └── internal/
 *         └── {color-slug}/
 *             ├── 2d_*.jpeg     # 2D scenes
 *             ├── 360_*.webp    # 360 scenes
 *             └── seq_*.png     # Sequences
 * 
 * ESTRUCTURA GENERADA (SPACES):
 * virtualTours/
 * └── {TOUR_CODE}/
 *     ├── _config.json          # Metadatos del tour
 *     ├── _floorplans/          # Planos de piso
 *     │   └── {name}.jpg
 *     └── scenes/
 *         └── 360_*.webp        # 360 panoramas
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Descarga un archivo desde una URL
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const file = fs.createWriteStream(destPath);
        const protocol = url.startsWith('https') ? https : http;

        protocol.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                // Follow redirect
                downloadFile(response.headers.location, destPath)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(destPath);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => { }); // Delete incomplete file
            reject(err);
        });
    });
}

/**
 * Convierte un nombre a slug (para nombres de carpetas)
 */
function nameToSlug(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Obtiene la extensión de un archivo desde la URL
 */
function getExtension(url) {
    const urlPath = new URL(url).pathname;
    return path.extname(urlPath) || '.png';
}

/**
 * Descarga un VirtualTour completo
 */
async function downloadVirtualTour(tourData, outputPath) {
    const tourCode = tourData.virtualTourCode || nameToSlug(tourData.virtualTourName);
    const tourPath = path.join(outputPath, tourCode);
    const isSpaces = tourData.eventType === 'Spaces';

    console.log(`\n📁 Descargando tour: ${tourData.virtualTourName}`);
    console.log(`   🏷️  Tipo: ${isSpaces ? '🏠 Spaces' : '🚗 Automotive'}`);
    console.log(`   📂 Destino: ${tourPath}\n`);

    // Crear estructura de carpetas según el tipo
    if (isSpaces) {
        fs.mkdirSync(path.join(tourPath, 'scenes'), { recursive: true });
        fs.mkdirSync(path.join(tourPath, '_floorplans'), { recursive: true });
    } else {
        fs.mkdirSync(path.join(tourPath, '_colors', 'external'), { recursive: true });
        fs.mkdirSync(path.join(tourPath, '_colors', 'internal'), { recursive: true });
        fs.mkdirSync(path.join(tourPath, 'external'), { recursive: true });
        fs.mkdirSync(path.join(tourPath, 'internal'), { recursive: true });
    }

    let colorIdToSlug = { external: {}, internal: {} };
    let totalFiles = 0;

    // 2. Descargar colores SOLO para Automotive
    if (!isSpaces) {
        console.log('\n   🎨 Descargando colores...');

        for (const automotiveType of ['external', 'internal']) {
            const colors = tourData.config?.automotiveColors?.[automotiveType] || [];
            console.log(`      Encontrados ${colors.length} colores ${automotiveType}`);

            for (const color of colors) {
                if (!color.url || !color.meta?.name) {
                    console.log(`      ⚠️ Color sin URL o nombre:`, JSON.stringify(color));
                    continue;
                }

                const colorSlug = nameToSlug(color.meta.name);
                const ext = getExtension(color.url);
                const destPath = path.join(tourPath, '_colors', automotiveType, `${colorSlug}${ext}`);

                try {
                    await downloadFile(color.url, destPath);
                    colorIdToSlug[automotiveType][color._id] = colorSlug;
                    console.log(`      ✅ ${automotiveType}/${colorSlug}${ext}`);
                    totalFiles++;
                } catch (error) {
                    console.error(`      ❌ Error descargando color ${color.meta.name}: ${error.message}`);
                }
            }
        }
    }

    // 1. Guardar configuración
    console.log('\n   📋 Guardando _config.json...');
    const config = {
        _id: tourData._id,
        virtualTourName: tourData.virtualTourName,
        virtualTourCode: tourCode,
        description: tourData.description,
        eventType: tourData.eventType,
        config: JSON.parse(JSON.stringify(tourData.config || {})) // Deep copy
    };
    // Remove the color IDs from config since we'll re-upload them
    if (config.config?.automotiveColors) {
        delete config.config.automotiveColors;
    }
    fs.writeFileSync(
        path.join(tourPath, '_config.json'),
        JSON.stringify(config, null, 2)
    );

    // 3. Descargar scenes
    console.log('\n   🎬 Descargando scenes...');
    const scenes = tourData.scenes || [];

    for (const scene of scenes) {
        const sceneType = scene.sceneType || '360';
        const sceneSlug = nameToSlug(scene.sceneName);

        let destFolder;
        if (isSpaces) {
            // Para Spaces: todas las scenes van en scenes/
            destFolder = path.join(tourPath, 'scenes');
        } else {
            // Para Automotive: scenes van en {automotiveType}/{colorSlug}/
            const automotiveType = scene.automotiveType || 'external';
            let colorSlug = 'default';
            if (scene.automotiveColor) {
                const colorId = typeof scene.automotiveColor === 'object'
                    ? scene.automotiveColor._id
                    : scene.automotiveColor;
                colorSlug = colorIdToSlug[automotiveType]?.[colorId] || sceneSlug;
            } else {
                colorSlug = sceneSlug;
            }
            destFolder = path.join(tourPath, automotiveType, colorSlug);
        }

        fs.mkdirSync(destFolder, { recursive: true });

        const media = scene.media || [];
        console.log(`\n      📋 ${scene.sceneName} (${sceneType}) - ${media.length} archivos`);

        // Determinar prefijo según tipo de scene
        let prefix = 'seq_';
        if (sceneType === '2d') prefix = '2d_';
        else if (sceneType === '360') prefix = '360_';

        for (let i = 0; i < media.length; i++) {
            const mediaItem = media[i];
            if (!mediaItem.url) continue;

            const ext = getExtension(mediaItem.url);
            const urlParts = mediaItem.url.split('/');
            let originalName = urlParts[urlParts.length - 1];

            let fileName;
            if (sceneType === 'sequence') {
                if (originalName.match(/^seq_/i)) {
                    fileName = originalName;
                } else {
                    const paddedIndex = String(i + 1).padStart(3, '0');
                    fileName = `${prefix}${paddedIndex}${ext}`;
                }
            } else {
                const paddedIndex = String(i + 1).padStart(3, '0');
                fileName = `${prefix}${sceneSlug}_${paddedIndex}${ext}`;
            }

            const destPath = path.join(destFolder, fileName);

            try {
                await downloadFile(mediaItem.url, destPath);
                totalFiles++;

                if (media.length > 10 && (i + 1) % 10 === 0) {
                    console.log(`         📥 ${i + 1}/${media.length}`);
                }
            } catch (error) {
                console.error(`         ❌ Error: ${error.message}`);
            }
        }
    }

    // 4. Descargar floorPlans (solo para Spaces)
    if (isSpaces && tourData.floorPlans && tourData.floorPlans.length > 0) {
        console.log('\n   🗺️  Descargando floor plans...');

        for (const floorPlan of tourData.floorPlans) {
            const floorPlanSlug = nameToSlug(floorPlan.floorPlanName || 'floorplan');
            const mediaUrl = floorPlan.media?.url;

            if (!mediaUrl) {
                console.log(`      ⚠️ FloorPlan sin media: ${floorPlan.floorPlanName}`);
                continue;
            }

            const ext = getExtension(mediaUrl);
            const destPath = path.join(tourPath, '_floorplans', `${floorPlanSlug}${ext}`);

            try {
                await downloadFile(mediaUrl, destPath);
                console.log(`      ✅ ${floorPlanSlug}${ext}`);
                totalFiles++;
            } catch (error) {
                console.error(`      ❌ Error descargando floorplan ${floorPlan.floorPlanName}: ${error.message}`);
            }
        }
    }

    console.log(`\n   ✅ Tour descargado: ${totalFiles} archivos`);
    return { tourPath, totalFiles };
}

module.exports = {
    downloadVirtualTour,
    downloadFile,
    nameToSlug,
    getExtension
};
