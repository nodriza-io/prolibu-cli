const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Extract formSchema from a compiled plugin bundle
 * Executes the UMD bundle in a sandboxed context and retrieves the formSchema.
 * Falls back to parsing the source index.tsx if sandbox execution fails.
 * @param {string} bundlePath - Path to the compiled plugin bundle (.js)
 * @returns {Object|null} The formSchema object or null if extraction fails
 */
function extractOptionsSchema(bundlePath) {
  // Try sandbox approach first
  const result = _extractFromBundle(bundlePath);
  if (result) return result;

  // Fallback: try to extract from source index.tsx
  const pluginDir = path.dirname(path.dirname(bundlePath)); // dist/../ = pluginDir
  const srcIndexPath = path.join(pluginDir, 'src', 'index.tsx');
  return _extractFromSource(srcIndexPath);
}

/**
 * Extract formSchema by executing the bundle in a sandbox
 */
function _extractFromBundle(bundlePath) {
  try {
    if (!fs.existsSync(bundlePath)) {
      return null;
    }

    const code = fs.readFileSync(bundlePath, 'utf8');

    // Sandboxed context with mocked globals
    const noopComponent = () => ({});
    const mockReact = {
      createElement: () => ({}),
      createContext: () => ({ Provider: noopComponent, Consumer: noopComponent }),
      useState: (v) => [v, () => { }],
      useEffect: () => { },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: () => ({ current: null }),
      useContext: () => ({}),
      useReducer: (r, v) => [v, () => { }],
      useLayoutEffect: () => { },
      useId: () => '',
      memo: (c) => c,
      forwardRef: (c) => c,
      lazy: () => noopComponent,
      Suspense: noopComponent,
      Fragment: noopComponent,
      Children: { map: () => [], forEach: () => { }, toArray: () => [] },
      isValidElement: () => false,
      cloneElement: () => ({}),
    };
    const mockReactDOM = { createRoot: () => ({ render: () => { } }) };
    const context = {
      React: mockReact,
      ReactDOM: mockReactDOM,
      module: { exports: {} },
      exports: {},
      require: (mod) => {
        if (mod === 'react') return mockReact;
        if (mod === 'react-dom') return mockReactDOM;
        return {};
      },
      window: {},
      document: {
        createElement: () => ({
          appendChild: () => { },
          setAttribute: () => { },
          style: {},
          sheet: { insertRule: () => { } },
        }),
        createTextNode: () => ({}),
        head: { appendChild: () => { }, removeChild: () => { } },
        body: { appendChild: () => { } },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createComment: () => ({}),
      },
      console,
      setTimeout: () => 0,
      clearTimeout: () => { },
      setInterval: () => 0,
      clearInterval: () => { },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => { },
      navigator: { userAgent: '', language: 'en-US', languages: ['en-US'] },
      location: { href: '', protocol: 'https:', host: '', hostname: '', pathname: '/', search: '', hash: '' },
      self: {},
      Object, Array, String, Number, Boolean, RegExp, Date, Math, JSON, Error,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      encodeURI, decodeURI,
      Promise,
      Symbol,
      Map, Set, WeakMap, WeakSet,
      Proxy, Reflect,
    };
    context.window = context;
    context.self = context;
    context.globalThis = context;

    vm.createContext(context);

    // Use vm.SourceTextModule approach if available, otherwise fall back
    // Node 20 requires --experimental-vm-modules for importModuleDynamically in vm.Script
    // We wrap the code to prevent dynamic import() from crashing the process
    const wrappedCode = `
      // Override dynamic import to prevent crashes in sandbox
      (function() {
        ${code}
      })();
    `;

    // Catch unhandled rejections from async dynamic imports inside the sandbox
    const onUnhandled = () => { };
    process.on('unhandledRejection', onUnhandled);

    try {
      vm.runInContext(wrappedCode, context, { timeout: 5000 });
    } finally {
      // Give async dynamic imports a moment to settle, then remove listener
      setTimeout(() => process.removeListener('unhandledRejection', onUnhandled), 100);
    }

    const pluginExport = context.module.exports.default || context.module.exports;

    if (!pluginExport?.components?.[0]?.formSchema) {
      return null;
    }

    return pluginExport.components[0].formSchema;
  } catch (err) {
    console.warn(`[SCHEMA] Sandbox extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract formSchema from the source index.tsx by evaluating the export default object.
 * This is a fallback when sandbox execution of the bundle fails (e.g., due to heavy dependencies).
 */
function _extractFromSource(srcPath) {
  try {
    if (!fs.existsSync(srcPath)) return null;

    const source = fs.readFileSync(srcPath, 'utf8');

    // Find the start of formSchema
    const startIdx = source.indexOf('formSchema:');
    if (startIdx === -1) return null;

    // Find the opening brace after formSchema:
    const braceStart = source.indexOf('{', startIdx);
    if (braceStart === -1) return null;

    // Count braces to find the matching closing brace
    let depth = 0;
    let endIdx = -1;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx === -1) return null;

    const schemaStr = source.substring(braceStart, endIdx + 1);

    // Use Function constructor to evaluate the object literal
    const fn = new Function(`return (${schemaStr})`);
    const schema = fn();

    if (schema && typeof schema === 'object') {
      console.log(`[SCHEMA] Extracted from source file`);
      return schema;
    }

    return null;
  } catch (err) {
    console.warn(`[SCHEMA] Source extraction failed: ${err.message}`);
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
