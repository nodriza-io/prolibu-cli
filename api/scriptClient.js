const axios = require('axios');
const _ = require('lodash');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

/**
 * Check if script exists, create if not
 * @returns {Object|null} Script data including _id, or null if failed
 */
async function ensureScriptExists(domain, apiKey, scriptCode) {
  const checkUrl = `https://${domain}/v2/script/${scriptCode}`;

  try {
    const response = await axios.get(checkUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    return response.data; // Returns script data including _id
  } catch (error) {
    if (error.response?.status === 404) {
      console.log(`🔧 Script '${scriptCode}' not found. Creating...`);

      try {
        const createUrl = `https://${domain}/v2/script`;
        const createResponse = await axios.post(createUrl, {
          scriptCode,
          scriptName: scriptCode,
          code: '// Script will be synced from local files',
          active: true,
          readme: '# Script created automatically',
          variables: [],
          lifecycleHooks: []
        }, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        });

        console.log(`✅ Script '${scriptCode}' created successfully!`);
        return createResponse.data; // Returns created script data including _id
      } catch (createError) {
        console.error(`❌ Failed to create script '${scriptCode}':`, createError.response?.data || createError.message);
        return null;
      }
    }

    console.error(`❌ Error checking script '${scriptCode}':`, error.response?.data || error.message);
    return null;
  }
}

/**
 * PATCH field to /v2/script/{scriptCode}
 */
async function patchScript(domain, apiKey, scriptCode, value, field) {
  const url = `https://${domain}/v2/script/${scriptCode}`;
  try {
    await axios.patch(url, { [field]: value }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    console.error(`Failed to PATCH ${field} for ${scriptCode}:`, err.response?.data || err.message);
  }
}

/**
 * POST initial script document to /v2/script
 */
async function createScriptDoc(domain, apiKey, scriptCode, scriptName, code, extra = {}) {
  const url = `https://${domain}/v2/script`;
  try {
    const body = {
      scriptCode,
      scriptName,
      code,
      active: true,
      ...extra
    };
    await axios.post(url, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    console.error(`Failed to create script ${scriptCode}:`, err.response?.data || err.message);
  }
}

/**
 * GET /v2/script/run
 * @param {string} scriptId - Can be _id (preferred) or scriptCode
 */
async function runScript(domain, apiKey, scriptId) {
  const url = `https://${domain}/v2/script/run?scriptId=${scriptId}`;
  try {
    const response = await axios({
      method: 'get',
      url,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const result = response.data;

    // Wait a bit for socket logs to arrive before showing results
    await new Promise(resolve => setTimeout(resolve, 500));

    let chalk;
    try {
      chalk = await import('chalk');
    } catch {
      chalk = null;
    }

    const gray = (str) => chalk ? chalk.default.gray(str) : str;
    const green = (str) => chalk ? chalk.default.green(str) : str;
    const red = (str) => chalk ? chalk.default.red(str) : str;

    // Errors block
    if (result.error) {
      console.log(`\n${red('[DONE WITH ERRORS]')}\n`);
      console.error(red(result.error?.error || result.error));
    }

    // Output block - only show if not empty
    if (result.output !== undefined && !_.isEmpty(result.output)) {
      console.log(`\n${green('[OUTPUT] ' + '-'.repeat(60))}\n`);
      console.dir(result.output, { depth: null, colors: true });
    }

    // Execution time
    if (result.timeMs !== undefined) {
      console.log(`\n${gray('Execution time: ' + result.timeMs + ' ms')}`);
    }

    // Message to rerun script
    console.log(gray('Press [R] to run the script again (No build/upload)'));
    return result;
  } catch (err) {
    console.error(`Failed to run script ${scriptId}:`, err.response?.data || err.message);
  }
}

/**
 * Runs the script in the specified environment and watches for changes
 */
async function runDevScript(scriptPrefix, env, domain, watch = false, fileName = 'index') {
  const { listenScriptLog } = require('../cli/socketLog');
  const scriptCode = env === 'prod' ? scriptPrefix : `${scriptPrefix}-${env}`;
  const apiKey = config.get('apiKey', domain);

  const scriptData = await ensureScriptExists(domain, apiKey, scriptCode);

  if (!scriptData) {
    console.error(`❌ Could not create or verify script '${scriptCode}'. Exiting.`);
    process.exit(1);
  }

  // Use _id for running script (better cache consistency)
  const scriptId = scriptData._id;

  const codePath = config.getScriptEntryPath(domain, scriptPrefix, fileName);
  const scriptFolder = path.dirname(codePath);

  if (!fs.existsSync(scriptFolder)) {
    fs.mkdirSync(scriptFolder, { recursive: true });
  }

  const configPath = path.join(scriptFolder, 'config.json');
  const settingsPath = path.join(scriptFolder, 'settings.json');
  const distPath = path.join(scriptFolder, 'dist', 'bundle.js');
  const readmePath = path.join(scriptFolder, 'README.md');

  // Ensure config.json exists with default values (model data)
  config.ensureScriptCode(domain, scriptPrefix);
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      variables: [],
      lifecycleHooks: [],
      readme: '',
      git: { repositoryUrl: '' }
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  // Ensure settings.json exists with default values (build settings)
  if (!fs.existsSync(settingsPath)) {
    const defaultSettings = {
      minifyProductionCode: false,
      removeComments: true
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
  }

  // Ensure README.md exists
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, '');
  }

  // Sync README.md → config.json on startup
  const readmeContent = fs.readFileSync(readmePath, 'utf8');
  let configData = {};
  try {
    configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configData.readme = readmeContent;
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
  } catch (e) {
    console.error(`[ERROR] Failed to sync README.md to config.json: ${e.message}`);
  }

  // Read settings.json for build configuration
  let minifyProductionCode = false;
  let removeComments = false;
  try {
    const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    minifyProductionCode = !!settingsData.minifyProductionCode;
    removeComments = !!settingsData.removeComments;
  } catch (e) {
    console.error(`[ERROR] Failed to parse settings.json: ${e.message}`);
  }

  const gitRepositoryUrl = configData.git?.repositoryUrl || '';

  // Helper function to process bundled code based on config
  const processBundledCode = async (entryPath, outputPath, shouldMinify, shouldRemoveComments) => {
    const esbuild = require('esbuild');
    const buildOptions = {
      entryPoints: [entryPath],
      outfile: outputPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    };

    if (shouldMinify) {
      buildOptions.minify = true;
    }

    if (shouldRemoveComments) {
      buildOptions.minifySyntax = true;
      buildOptions.legalComments = 'none';
    }

    await esbuild.build(buildOptions);
    return fs.readFileSync(outputPath, 'utf8');
  };

  // Initial bundle and PATCH for code.js
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  const shouldMinify = env === 'prod' && minifyProductionCode;
  const bundledCode = await processBundledCode(codePath, distPath, shouldMinify, removeComments);

  if (shouldMinify) {
    console.log(`[MINIFY] Production build: minifyProductionCode enabled in config.json, script was minified.`);
  }

  // Upload all config fields (variables, lifecycleHooks, readme, git)
  if (configData.variables) {
    await patchScript(domain, apiKey, scriptCode, configData.variables, 'variables');
  }
  if (configData.lifecycleHooks) {
    await patchScript(domain, apiKey, scriptCode, configData.lifecycleHooks, 'lifecycleHooks');
  }
  if (configData.readme) {
    await patchScript(domain, apiKey, scriptCode, configData.readme, 'readme');
  }
  if (gitRepositoryUrl) {
    await patchScript(domain, apiKey, scriptCode, { repositoryUrl: gitRepositoryUrl }, 'git');
  }

  // Upload bundled code
  await patchScript(domain, apiKey, scriptCode, bundledCode, 'code');

  if (watch) {
    // Connect to socket.io and listen for script logs
    await new Promise((resolve) => {
      listenScriptLog(domain, scriptPrefix, env, apiKey, () => {
        runScript(domain, apiKey, scriptId).then(resolve);
      });
    });

    // Listen for 'R' key to run the script again
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', async (key) => {
        if (key.toLowerCase() === 'r') {
          const chalk = (await import('chalk')).default;
          await runScript(domain, apiKey, scriptId);
        }
        if (key === '\u0003') {
          process.exit();
        }
      });
    }

    // Watch code entry file and lib/
    const libPath = path.join(scriptFolder, 'lib');
    const chokidar = require('chokidar');
    const watcher = chokidar.watch([codePath, libPath], {
      persistent: true,
      ignoreInitial: true,
      depth: 99,
      awaitWriteFinish: true,
    });

    const triggerBundle = async (event, filePath) => {
      process.stdout.write('\x1Bc');
      console.log(`[WATCH] ${event} detected in ${filePath}. Bundling and uploading...`);
      try {
        const shouldMinify = env === 'prod' && minifyProductionCode;
        const bundledCode = await processBundledCode(codePath, distPath, shouldMinify, removeComments);
        await patchScript(domain, apiKey, scriptCode, bundledCode, 'code');

        // Small delay to ensure cache invalidation is complete
        await new Promise(resolve => setTimeout(resolve, 100));

        await runScript(domain, apiKey, scriptId);
        const chalk = (await import('chalk')).default;
        console.log(chalk.green.bold(`[SYNC] Bundled code uploaded for ${scriptCode}`));
      } catch (err) {
        console.error(`[ERROR] Bundling/upload failed: ${err.message}`);
      }
    };

    watcher.on('add', (filePath) => triggerBundle('add', filePath));
    watcher.on('change', (filePath) => triggerBundle('change', filePath));
    watcher.on('unlink', (filePath) => triggerBundle('unlink', filePath));

    // Watch README.md and sync to config.json
    fs.watchFile(readmePath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        try {
          const readmeContent = fs.readFileSync(readmePath, 'utf8');
          const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          updatedConfig.readme = readmeContent;
          fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

          // PATCH readme
          await patchScript(domain, apiKey, scriptCode, readmeContent, 'readme');
          console.log(`[SYNC] README.md synced to config.json and uploaded for '${scriptCode}'`);
        } catch (err) {
          console.error(`[ERROR] Failed to sync README.md: ${err.message}`);
        }
      }
    });

    // Watch config.json for any changes (variables, lifecycleHooks, readme, git, etc.)
    fs.watchFile(configPath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        try {
          const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

          // PATCH all config fields
          if (updatedConfig.variables) {
            await patchScript(domain, apiKey, scriptCode, updatedConfig.variables, 'variables');
          }
          if (updatedConfig.lifecycleHooks) {
            await patchScript(domain, apiKey, scriptCode, updatedConfig.lifecycleHooks, 'lifecycleHooks');
          }
          if (updatedConfig.readme) {
            await patchScript(domain, apiKey, scriptCode, updatedConfig.readme, 'readme');
          }
          if (updatedConfig.git?.repositoryUrl) {
            await patchScript(domain, apiKey, scriptCode, { repositoryUrl: updatedConfig.git.repositoryUrl }, 'git');
          }

          await runScript(domain, apiKey, scriptId);
          console.log(`[CONFIG] config.json updated for '${scriptCode}' - all fields synced.`);
        } catch (err) {
          console.error(`[ERROR] Failed to process config.json: ${err.message}`);
        }
      }
    });
  }

  if (!watch) {
    process.exit(0);
  }
}

/**
 * Creates a script for the specified environment
 */
async function createScript(scriptPrefix, env, domain, gitRepo, fileName = 'index') {
  const scriptCode = env === 'prod' ? scriptPrefix : `${scriptPrefix}-${env}`;
  const apiKey = config.get('apiKey', domain);
  config.ensureScriptCode(domain, scriptPrefix, fileName);
  const code = config.readScriptCode(domain, scriptPrefix, fileName);
  const envLabel = env === 'dev' ? 'Dev' : 'Prod';
  const scriptNameLabel = `${scriptPrefix} - ${envLabel}`;

  const extra = {};
  if (gitRepo) {
    extra.git = { repositoryUrl: gitRepo };
  }

  await createScriptDoc(domain, apiKey, scriptCode, scriptNameLabel, code, extra);
  console.log(`Creating script: ${scriptCode} (domain: ${domain}) as '${scriptNameLabel}'`);
}

module.exports = {
  ensureScriptExists,
  patchScript,
  createScriptDoc,
  runScript,
  runDevScript,
  createScript,
};
