const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Extract formSchema from a compiled plugin bundle
 * Executes the UMD bundle in a sandboxed context and retrieves the formSchema
 * @param {string} bundlePath - Path to the compiled plugin bundle (.js)
 * @returns {Object|null} The formSchema object or null if extraction fails
 */
function extractOptionsSchema(bundlePath) {
  try {
    if (!fs.existsSync(bundlePath)) {
      return null;
    }

    const code = fs.readFileSync(bundlePath, 'utf8');

    // Sandboxed context with mocked globals
    const context = {
      React: {
        createElement: () => ({}),
        useState: (v) => [v, () => { }],
        useEffect: () => { },
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useRef: () => ({ current: null }),
      },
      ReactDOM: { createRoot: () => ({ render: () => { } }) },
      module: { exports: {} },
      exports: {},
      require: () => ({}),
      window: {},
      document: {
        createElement: () => ({ appendChild: () => { }, style: {} }),
        head: { appendChild: () => { } },
      },
      console,
    };
    context.window = context;

    vm.createContext(context);
    vm.runInContext(code, context, { timeout: 5000 });

    const pluginExport = context.module.exports.default || context.module.exports;

    if (!pluginExport?.components?.[0]?.formSchema) {
      return null;
    }

    return pluginExport.components[0].formSchema;
  } catch (err) {
    console.warn(`[SCHEMA] Failed to extract: ${err.message}`);
    return null;
  }
}

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
  extractOptionsSchema,
};
