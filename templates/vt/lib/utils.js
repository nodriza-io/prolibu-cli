/**
 * Utilidades para el Virtual Tour Bulk Creator
 */

const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prefijos de archivos para determinar el tipo de scene
 */
const PREFIXES = {
    '2d': '2d_',
    '360': '360_',
    'sequence': 'seq_'
};

/**
 * Extensiones de imagen soportadas
 */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES DE NOMBRE Y SLUG
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convierte un slug en nombre legible
 * @param {string} slug - Ej: "negro-sport", "blanco_almendra"
 * @returns {string} - Ej: "Negro Sport", "Blanco Almendra"
 */
function slugToName(slug) {
    return slug
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Convierte un nombre en slug
 * @param {string} name - Ej: "Negro Sport"
 * @returns {string} - Ej: "negro-sport"
 */
function nameToSlug(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remover acentos
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES DE PARSEO DE ARCHIVOS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parsea el nombre de un archivo para extraer sceneType y sceneName
 * @param {string} filename - Ej: "2d_dashboard.jpg", "seq_angle_01.png"
 * @returns {object} - { sceneType, sceneName, originalName }
 */
function parseFileName(filename) {
    const baseName = path.basename(filename, path.extname(filename));

    for (const [sceneType, prefix] of Object.entries(PREFIXES)) {
        if (baseName.toLowerCase().startsWith(prefix.toLowerCase())) {
            let nameWithoutPrefix = baseName.substring(prefix.length);

            // Para 2d y 360, remover índice numérico final (_001, _002, etc.)
            // Formato típico: 2d_scenename_001 o 360_scenename_001
            if ((sceneType === '2d' || sceneType === '360') && /_\d{1,3}$/.test(nameWithoutPrefix)) {
                nameWithoutPrefix = nameWithoutPrefix.replace(/_\d{1,3}$/, '');
            }

            return {
                sceneType,
                sceneName: slugToName(nameWithoutPrefix),
                originalName: baseName,
                prefix
            };
        }
    }

    // Si no tiene prefijo, intentar detectar por patrones comunes
    const lowerName = baseName.toLowerCase();

    // Detectar sequences por patrón numérico (angle_01, frame_001, etc.)
    if (/[_-]?\d{2,}$/.test(baseName) || /^(angle|frame|step|image)[_-]?\d+$/i.test(baseName)) {
        return {
            sceneType: 'sequence',
            sceneName: slugToName(baseName.replace(/[_-]?\d+$/, '')),
            originalName: baseName,
            prefix: null,
            autoDetected: true
        };
    }

    // Detectar 360 por patrones comunes
    if (/pano(cube)?|panorama|360|equirect/i.test(baseName)) {
        return {
            sceneType: '360',
            sceneName: slugToName(baseName),
            originalName: baseName,
            prefix: null,
            autoDetected: true
        };
    }

    throw new Error(`Archivo "${filename}" no tiene prefijo válido (2d_, 360_, seq_)`);
}

/**
 * Agrupa archivos por tipo de scene
 * Para sequences: agrupa todos los archivos seq_ en una sola scene
 * Para 2d/360: cada archivo es una scene separada
 * 
 * @param {Array} files - Array de objetos parseados con { path, sceneType, sceneName }
 * @param {string} colorSlug - Slug del color para naming
 * @returns {Array} - Array de { sceneName, sceneType, files: [paths] }
 */
function groupFilesBySceneType(files, colorSlug) {
    const scenes = [];
    const sequenceFiles = [];

    for (const file of files) {
        if (file.sceneType === 'sequence') {
            sequenceFiles.push(file);
        } else {
            // 2d y 360: cada archivo es una scene separada
            scenes.push({
                sceneName: file.sceneName || `${slugToName(colorSlug)} ${file.sceneType}`,
                sceneType: file.sceneType,
                files: [file.path]
            });
        }
    }

    // Agrupar sequences
    if (sequenceFiles.length > 0) {
        // Ordenar por nombre/número
        sequenceFiles.sort((a, b) => {
            const numA = extractNumber(a.originalName);
            const numB = extractNumber(b.originalName);
            if (numA !== null && numB !== null) {
                return numA - numB;
            }
            return a.originalName.localeCompare(b.originalName);
        });

        // Determinar nombre de la sequence
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

/**
 * Extrae el número de un nombre de archivo para ordenamiento
 * @param {string} name - Ej: "angle_10", "frame_001"
 * @returns {number|null}
 */
function extractNumber(name) {
    const match = name.match(/(\d+)(?:\.\w+)?$/);
    return match ? parseInt(match[1], 10) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES DE SISTEMA DE ARCHIVOS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifica si un archivo es una imagen soportada
 * @param {string} filename 
 * @returns {boolean}
 */
function isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Obtiene todos los archivos de imagen en un directorio
 * @param {string} dirPath 
 * @returns {string[]} - Array de nombres de archivo
 */
function getImageFiles(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs.readdirSync(dirPath)
        .filter(file => {
            const filePath = path.join(dirPath, file);
            return fs.statSync(filePath).isFile() && isImageFile(file);
        })
        .sort();
}

/**
 * Lee un directorio recursivamente
 * @param {string} dirPath - Ruta del directorio
 * @param {number} maxDepth - Profundidad máxima (default: 3)
 * @returns {object} - Estructura del directorio
 */
function readDirRecursive(dirPath, maxDepth = 3, currentDepth = 0) {
    if (currentDepth > maxDepth || !fs.existsSync(dirPath)) {
        return null;
    }

    const result = {
        path: dirPath,
        name: path.basename(dirPath),
        files: [],
        directories: []
    };

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            const subDir = readDirRecursive(itemPath, maxDepth, currentDepth + 1);
            if (subDir) {
                result.directories.push(subDir);
            }
        } else if (stat.isFile() && isImageFile(item)) {
            result.files.push(item);
        }
    }

    return result;
}

/**
 * Cuenta total de archivos de imagen en un directorio y subdirectorios
 * @param {string} dirPath 
 * @returns {number}
 */
function countImages(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;

    let count = 0;
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            count += countImages(itemPath);
        } else if (isImageFile(item)) {
            count++;
        }
    }

    return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    // Constantes
    PREFIXES,
    IMAGE_EXTENSIONS,

    // Funciones de nombre
    slugToName,
    nameToSlug,

    // Funciones de parseo
    parseFileName,
    groupFilesBySceneType,
    extractNumber,

    // Funciones de archivos
    isImageFile,
    getImageFiles,
    readDirRecursive,
    countImages
};
