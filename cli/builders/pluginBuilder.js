const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

/**
 * Zip a plugin's dist folder (bundle + assets)
 * @param {string} distDir - Dist directory with built files
 * @param {string} outputPath - Output zip file path
 * @param {string} assetsDir - Optional assets directory to include
 */
async function zipPlugin(distDir, outputPath, assetsDir = null) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    output.on('close', () => {
      resolve();
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    // Add all files from dist directory (bundle, css, etc.)
    if (fs.existsSync(distDir)) {
      archive.directory(distDir, false);
    }

    // Add assets directory if provided and exists
    if (assetsDir && fs.existsSync(assetsDir)) {
      archive.directory(assetsDir, 'assets');
    }

    archive.finalize();
  });
}

/**
 * Collect all assets from src/assets (excluding icon which is uploaded separately)
 * @param {string} assetsDir - Assets directory path
 * @returns {string[]} Array of asset file paths
 */
function collectAssets(assetsDir) {
  if (!fs.existsSync(assetsDir)) {
    return [];
  }

  const assets = [];
  const files = fs.readdirSync(assetsDir, { withFileTypes: true });

  for (const file of files) {
    const filePath = path.join(assetsDir, file.name);
    if (file.isDirectory()) {
      // Recursively collect from subdirectories
      const subAssets = collectAssetsRecursive(filePath, file.name);
      assets.push(...subAssets);
    } else {
      // Skip icon files (they're uploaded separately)
      if (!/^icon\.(svg|png|jpg|jpeg|gif)$/i.test(file.name)) {
        assets.push({ path: filePath, name: file.name });
      }
    }
  }

  return assets;
}

function collectAssetsRecursive(dir, prefix) {
  const assets = [];
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const filePath = path.join(dir, file.name);
    const relativeName = path.join(prefix, file.name);

    if (file.isDirectory()) {
      const subAssets = collectAssetsRecursive(filePath, relativeName);
      assets.push(...subAssets);
    } else {
      assets.push({ path: filePath, name: relativeName });
    }
  }

  return assets;
}

module.exports = {
  zipPlugin,
  collectAssets,
};
