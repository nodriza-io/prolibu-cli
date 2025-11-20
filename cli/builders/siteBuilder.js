const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

/**
 * Zip a folder
 * @param {string} sourceDir - Source directory to zip
 * @param {string} outputPath - Output zip file path
 */
async function zipSite(sourceDir, outputPath) {
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
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

module.exports = {
  zipSite,
};
