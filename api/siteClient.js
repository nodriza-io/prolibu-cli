const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const { zipSite } = require('../cli/builders/siteBuilder');

/**
 * Upload zip file to /v2/file
 * @returns {string} fileId
 */
async function uploadZipFile(domain, apiKey, zipPath) {
  const fileName = path.basename(zipPath);
  const filePath = `dist/${fileName}`;
  const url = `https://${domain}/v2/file?filePath=${encodeURIComponent(filePath)}`;
  
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(zipPath));
    
    const response = await axios.post(url, formData, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    return response.data._id || response.data.fileId;
  } catch (err) {
    console.error(`Failed to upload zip file:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * PATCH field to /v2/site/{siteCode}
 * If field is 'package' and value is a file path, uploads the ZIP with multipart/form-data
 */
async function patchSite(domain, apiKey, siteCode, value, field) {
  const url = `https://${domain}/v2/site/${siteCode}`;
  try {
    if (field === 'package' && typeof value === 'string' && fs.existsSync(value)) {
      // Upload package ZIP using multipart/form-data
      const formData = new FormData();
      formData.append('package', fs.createReadStream(value), {
        filename: path.basename(value),
        contentType: 'application/zip'
      });
      
      await axios.patch(url, formData, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
    } else {
      // Regular JSON patch
      await axios.patch(url, { [field]: value }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });
    }
  } catch (err) {
    console.error(`Failed to PATCH ${field} for ${siteCode}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * POST initial site document to /v2/site
 */
async function createSiteDoc(domain, apiKey, siteCode, siteName, siteType, extra = {}) {
  const url = `https://${domain}/v2/site`;
  try {
    const body = {
      siteCode,
      siteName,
      siteType,
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
    console.error(`Failed to create site ${siteCode}:`, err.response?.data || err.message);
  }
}

/**
 * Ensures a site exists, creates it if it doesn't (on 404 response)
 */
async function ensureSiteExists(domain, apiKey, siteCode, siteName, siteType) {
  const url = `https://${domain}/v2/site/${siteCode}`;
  try {
    await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    // Site exists, no need to create
  } catch (err) {
    if (err.response?.status === 404) {
      // Site doesn't exist, create it
      await createSiteDoc(domain, apiKey, siteCode, siteName, siteType);
      console.log(`[AUTO-CREATE] Site '${siteCode}' created automatically.`);
    } else {
      console.error(`Failed to check if site ${siteCode} exists:`, err.response?.data || err.message);
    }
  }
}

/**
 * Creates a site for the specified environment
 */
async function createSite(sitePrefix, env, domain, siteType, gitRepo) {
  const config = require('../config/config');
  const siteCode = `${sitePrefix}-${env}`;
  const apiKey = config.get('apiKey', domain);
  const envLabel = env === 'dev' ? 'Dev' : 'Prod';
  const siteNameLabel = `${sitePrefix} - ${envLabel}`;
  
  const extra = {};
  if (gitRepo) {
    extra.git = { repositoryUrl: gitRepo };
  }
  
  await createSiteDoc(domain, apiKey, siteCode, siteNameLabel, siteType, extra);
  console.log(`Creating site: ${siteCode} (domain: ${domain}) as '${siteNameLabel}'`);
}

/**
 * Runs the site in the specified environment and watches for changes
 */
async function runDevSite(sitePrefix, env, domain, apiKey, watch = false, port = 3000, extensions = 'html,css,js') {
  const siteCode = `${sitePrefix}-${env}`;
  const envLabel = env === 'dev' ? 'Dev' : 'Prod';
  const siteNameLabel = `${sitePrefix} - ${envLabel}`;
  
  const siteFolder = path.join(process.cwd(), 'accounts', domain, sitePrefix);
  const publicFolder = path.join(siteFolder, 'public');
  const distZip = path.join(siteFolder, 'dist.zip');
  const configPath = path.join(siteFolder, 'config.json');
  const settingsPath = path.join(siteFolder, 'settings.json');
  const readmePath = path.join(siteFolder, 'README.md');
  
  if (!fs.existsSync(publicFolder)) {
    console.error(`❌ Public folder not found: ${publicFolder}`);
    console.log('Please create a public/ folder with your site files.');
    process.exit(1);
  }

  // Ensure site exists (auto-create if not)
  let configData = {};
  if (fs.existsSync(configPath)) {
    try {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {}
  }
  const siteType = configData.siteType || 'Static';
  await ensureSiteExists(domain, apiKey, siteCode, siteNameLabel, siteType);

  // Ensure config.json exists with default values (model data)
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      variables: [],
      lifecycleHooks: [],
      readme: '',
      git: { repositoryUrl: '' },
      siteType: 'Static'
    };
    configData = defaultConfig;
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  // Ensure settings.json exists with default values (local settings)
  if (!fs.existsSync(settingsPath)) {
    const defaultSettings = {
      port: 3000
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
  }

  // Read settings.json for port override
  try {
    const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settingsData.port) {
      port = settingsData.port;
    }
  } catch (e) {
    console.error(`[ERROR] Failed to parse settings.json: ${e.message}`);
  }

  // Ensure README.md exists
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, '');
  }

  // Sync README.md → config.json on startup
  const readmeContent = fs.readFileSync(readmePath, 'utf8');
  try {
    configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configData.readme = readmeContent;
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
  } catch (e) {
    console.error(`[ERROR] Failed to sync README.md to config.json: ${e.message}`);
  }

  // Initial upload of all config fields (including synced readme)
  if (configData.variables) {
    await patchSite(domain, apiKey, siteCode, configData.variables, 'variables');
  }
  if (configData.lifecycleHooks) {
    await patchSite(domain, apiKey, siteCode, configData.lifecycleHooks, 'lifecycleHooks');
  }
  if (configData.readme) {
    await patchSite(domain, apiKey, siteCode, configData.readme, 'readme');
    console.log(`[UPLOAD] README from config.json for '${siteCode}' uploaded to site.readme (initial sync).`);
  }
  if (configData.git?.repositoryUrl) {
    await patchSite(domain, apiKey, siteCode, { repositoryUrl: configData.git.repositoryUrl }, 'git');
  }

  // Initial zip and upload
  console.log(`[ZIP] Creating package from ${publicFolder}...`);
  await zipSite(publicFolder, distZip);
  
  const fileStat = fs.statSync(distZip);
  const fileSizeMB = (fileStat.size / (1024 * 1024)).toFixed(2);
  console.log(`[ZIP] Created dist.zip (${fileSizeMB} MB)`);
  
  console.log(`[UPLOAD] Uploading package to site...`);
  await patchSite(domain, apiKey, siteCode, distZip, 'package');
  console.log(`[UPLOAD] Site '${siteCode}' package uploaded successfully`);

  if (watch) {
    // Start local server
    const { spawn } = require('child_process');
    const serverProcess = spawn('npx', ['http-server', publicFolder, '-p', port.toString(), '-c-1'], {
      stdio: 'inherit'
    });
    
    console.log(`[SERVER] Running at http://localhost:${port}`);
    
    const extArray = extensions.split(',').map(e => e.trim());
    const watchPatterns = extArray.map(ext => `*.${ext}`);
    console.log(`[WATCH] Watching ${watchPatterns.join(', ')} for changes...`);

    // Watch public folder
    const chokidar = require('chokidar');
    const watcher = chokidar.watch(publicFolder, {
      persistent: true,
      ignoreInitial: true,
      depth: 99,
      awaitWriteFinish: true,
    });

    const triggerUpload = async (event, filePath) => {
      console.log(`[WATCH] ${event} detected in ${filePath}. Re-zipping and uploading...`);
      try {
        await zipSite(publicFolder, distZip);
        await patchSite(domain, apiKey, siteCode, distZip, 'package');
        const chalk = (await import('chalk')).default;
        console.log(chalk.green.bold(`[SYNC] Site package uploaded for ${siteCode}`));
      } catch (err) {
        console.error(`[ERROR] Upload failed: ${err.message}`);
      }
    };

    watcher.on('add', (filePath) => triggerUpload('add', filePath));
    watcher.on('change', (filePath) => triggerUpload('change', filePath));
    watcher.on('unlink', (filePath) => triggerUpload('unlink', filePath));

    // Watch README.md and sync to config.json
    fs.watchFile(readmePath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        try {
          const readmeContent = fs.readFileSync(readmePath, 'utf8');
          const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          updatedConfig.readme = readmeContent;
          fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
          
          // PATCH readme
          await patchSite(domain, apiKey, siteCode, readmeContent, 'readme');
          console.log(`[SYNC] README.md synced to config.json and uploaded for '${siteCode}'`);
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
            await patchSite(domain, apiKey, siteCode, updatedConfig.variables, 'variables');
          }
          if (updatedConfig.lifecycleHooks) {
            await patchSite(domain, apiKey, siteCode, updatedConfig.lifecycleHooks, 'lifecycleHooks');
          }
          if (updatedConfig.readme) {
            await patchSite(domain, apiKey, siteCode, updatedConfig.readme, 'readme');
          }
          if (updatedConfig.git?.repositoryUrl) {
            await patchSite(domain, apiKey, siteCode, { repositoryUrl: updatedConfig.git.repositoryUrl }, 'git');
          }
          
          console.log(`[CONFIG] config.json updated for '${siteCode}' - all fields synced.`);
        } catch (err) {
          console.error(`[ERROR] Failed to process config.json: ${err.message}`);
        }
      }
    });

    // Handle Ctrl+C to cleanup
    process.on('SIGINT', () => {
      console.log('\n[INFO] Stopping server and watcher...');
      serverProcess.kill();
      watcher.close();
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

module.exports = {
  uploadZipFile,
  patchSite,
  createSiteDoc,
  createSite,
  runDevSite,
};
