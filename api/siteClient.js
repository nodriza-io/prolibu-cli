const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const { zipSite } = require('../cli/builders/siteBuilder');

/**
 * Format axios error for user-friendly display
 */
function formatAxiosError(err, context = '') {
  if (err.response?.data) {
    const data = err.response.data;
    // If there's a structured error message
    if (data.error) {
      let message = `❌ ${context ? context + ': ' : ''}${data.error}`;
      if (data.details?.code) {
        message += ` (${data.details.code})`;
      }
      return message;
    }
    // Fallback to status text
    return `❌ ${context ? context + ': ' : ''}${err.response.statusText || 'Request failed'} (${err.response.status})`;
  }
  // Network or other errors
  return `❌ ${context ? context + ': ' : ''}${err.message}`;
}

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
    console.error(formatAxiosError(err, 'Failed to upload zip file'));
    process.exit(1);
  }
}

/**
 * PATCH field to /v2/site/{siteCode}
 * If field is 'package' and value is a file path, uploads the ZIP with multipart/form-data
 */
async function patchSite(domain, apiKey, siteCode, value, field) {
  const url = `https://${domain}/v2/site/${siteCode}`;
  try {
    let response;
    if (field === 'package' && typeof value === 'string' && fs.existsSync(value)) {
      // Upload package ZIP using multipart/form-data
      const formData = new FormData();
      formData.append('package', fs.createReadStream(value), {
        filename: path.basename(value),
        contentType: 'application/zip'
      });
      
      response = await axios.patch(url, formData, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
    } else {
      // Regular JSON patch
      response = await axios.patch(url, { [field]: value }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });
    }
    return response.data;
  } catch (err) {
    console.error(formatAxiosError(err, `Failed to update ${field} for ${siteCode}`));
    process.exit(1);
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
    console.error(formatAxiosError(err, `Failed to create site ${siteCode}`));
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
      console.error(formatAxiosError(err, `Failed to check if site ${siteCode} exists`));
    }
  }
}

/**
 * Creates a site for the specified environment
 */
async function createSite(sitePrefix, env, domain, siteType, gitRepo) {
  const config = require('../config/config');
  const siteCode = env === 'prod' ? sitePrefix : `${sitePrefix}-${env}`;
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
async function runDevSite(sitePrefix, env, domain, apiKey, watch = false, port = 3030, extensions = 'html,css,js') {
  const siteCode = env === 'prod' ? sitePrefix : `${sitePrefix}-${env}`;
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
      port: 3030
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
  }

  // Read settings.json for port override (only if port was not explicitly provided)
  if (port === 3030) {
    try {
      const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settingsData.port) {
        port = settingsData.port;
      }
    } catch (e) {
      console.error(`[ERROR] Failed to parse settings.json: ${e.message}`);
    }
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

  // Only do initial zip and upload if NOT in watch mode
  if (!watch) {
    // Initial zip and upload
    console.log(`[ZIP] Creating package from ${publicFolder}...`);
    await zipSite(publicFolder, distZip);
    
    const fileStat = fs.statSync(distZip);
    const fileSizeMB = (fileStat.size / (1024 * 1024)).toFixed(2);
    console.log(`[ZIP] Created dist.zip (${fileSizeMB} MB)`);
    
    console.log(`[UPLOAD] Uploading package to site...`);
    const siteData = await patchSite(domain, apiKey, siteCode, distZip, 'package');
    console.log(`[UPLOAD] Site '${siteCode}' package uploaded successfully`);
    
    // Show site URLs after upload
    const chalk = (await import('chalk')).default;
    const qrcode = require('qrcode-terminal');
    console.log('');
    console.log(chalk.bold('  🌐 Site Published:'));
    if (siteData.url) {
      console.log(`    ${chalk.cyan(siteData.url)}`);
    }
    if (siteData.shortUrl && siteData.shortUrl !== siteData.url) {
      console.log(`    ${chalk.cyan(siteData.shortUrl)} ${chalk.dim('(short)')}`);
    }
    
    // Show QR code for production URL
    const prodQrUrl = siteData.shortUrl || siteData.url;
    if (prodQrUrl) {
      console.log('');
      console.log(chalk.bold('  📱 Scan QR code for mobile access:'));
      console.log('');
      qrcode.generate(prodQrUrl, { small: true }, (qr) => {
        qr.split('\n').forEach(line => console.log('  ' + line));
        console.log('');
      });
    }
    console.log('');
  }

  if (watch) {
    // Check if port is already in use
    const { execSync, spawn } = require('child_process');
    const os = require('os');
    
    try {
      const pidOutput = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
      if (pidOutput) {
        const pid = pidOutput.split('\n')[0];
        let processName = 'Unknown';
        try {
          processName = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim();
        } catch (e) {
          // ignore
        }
        
        const inquirer = await import('inquirer');
        const chalk = (await import('chalk')).default;
        
        console.log('');
        console.log(chalk.yellow(`⚠️  Port ${port} is already in use`));
        console.log(chalk.dim(`   Process: ${processName} (PID: ${pid})`));
        console.log('');
        
        const { killProcess } = await inquirer.default.prompt({
          type: 'confirm',
          name: 'killProcess',
          message: `Kill the process and continue?`,
          default: true
        });
        
        if (killProcess) {
          execSync(`kill -9 ${pid}`);
          console.log(chalk.green(`✓ Process killed successfully`));
          console.log('');
        } else {
          console.log(chalk.yellow('Aborted. Please use a different port with --port flag.'));
          process.exit(0);
        }
      }
    } catch (e) {
      // Port is free, continue
    }
    
    // Start local server
    
    // Get local IP addresses first
    const networkInterfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(networkInterfaces)) {
      for (const net of networkInterfaces[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push(net.address);
        }
      }
    }
    
    // Use live-server for auto-reload in watch mode
    const serverProcess = spawn('npx', [
      'live-server',
      publicFolder,
      '--port=' + port.toString(),
      '--no-browser',
      '--quiet',
      '--wait=200'
    ], {
      stdio: 'ignore',
      detached: false
    });
    
    // Store the PID for cleanup
    const serverPid = serverProcess.pid;
    
    // Create a config file with domain info for local development
    const configJsPath = path.join(publicFolder, '_prolibu_config.js');
    const configJsContent = `// Auto-generated by Prolibu CLI - DO NOT EDIT
window.__PROLIBU_CONFIG__ = {
  domain: '${domain}',
  apiBaseUrl: 'https://${domain}/v2',
  isDev: true
};`;
    fs.writeFileSync(configJsPath, configJsContent);
    
    const chalk = (await import('chalk')).default;
    const qrcode = require('qrcode-terminal');
    
    // ASCII Art Logo
    console.log('');
    console.log('    ' + chalk.blue('◯') + chalk.yellow(' || ') + chalk.hex('#E91E63')('▶') + chalk.bold.white(' Prolibu CLI') + chalk.dim(' v2.0'));
    console.log('');
    console.log('    ' + chalk.green('✓') + ' Server running on port ' + chalk.cyan(port));
    console.log('');
    console.log('    ' + chalk.bold('Available on:'));
    console.log(`      ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`      ${chalk.cyan(`http://127.0.0.1:${port}`)}`);
    addresses.forEach(addr => console.log(`      ${chalk.cyan(`http://${addr}:${port}`)}`));
    console.log('');
    console.log('');
    
    // Show QR code for mobile access
    const qrUrl = addresses.length > 0 ? `http://${addresses[0]}:${port}` : `http://localhost:${port}`;
    console.log('    ' + chalk.bold('📱 Scan QR code for mobile access:'));
    console.log('');
    qrcode.generate(qrUrl, { small: true }, (qr) => {
      qr.split('\n').forEach(line => console.log('    ' + line));
      console.log('');
    });
    
    const extArray = extensions.split(',').map(e => e.trim());
    const watchPatterns = extArray.map(ext => `*.${ext}`);
    console.log(`    ${chalk.dim('📁 Watching')} ${chalk.cyan(watchPatterns.join(', '))} ${chalk.dim('in')} ${chalk.cyan('public/')}`);
    console.log(`    ${chalk.dim('💡 Browser will auto-reload on changes (no upload needed)')}`);
    console.log('');
    console.log(`    ${chalk.dim('Press')} ${chalk.bold.cyan('p')} ${chalk.dim('to publish to')} ${chalk.bold(envLabel)} ${chalk.dim('or')} ${chalk.bold.red('x')} ${chalk.dim('to exit')}`);
    console.log('');

    // Watch public folder (ignoring node_modules and common build folders)
    // In watch mode, we just serve files locally - no need to re-upload on every change
    const chokidar = require('chokidar');
    const watcher = chokidar.watch(publicFolder, {
      persistent: true,
      ignoreInitial: true,
      depth: 99,
      awaitWriteFinish: true,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.DS_Store']
    });

    // Just log file changes (browser will auto-reload via http-server)
    watcher.on('add', (filePath) => {
      console.log(`${chalk.dim('[FILE]')} ${chalk.green('added')} ${chalk.dim(path.relative(publicFolder, filePath))}`);
    });
    watcher.on('change', (filePath) => {
      console.log(`${chalk.dim('[FILE]')} ${chalk.cyan('changed')} ${chalk.dim(path.relative(publicFolder, filePath))}`);
    });
    watcher.on('unlink', (filePath) => {
      console.log(`${chalk.dim('[FILE]')} ${chalk.red('deleted')} ${chalk.dim(path.relative(publicFolder, filePath))}`);
    });

    // Listen for keypress to publish or exit
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);
    
    let isRawMode = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      isRawMode = true;
    }
    
    const cleanupAndExit = async () => {
      console.log('');
      console.log(chalk.yellow('[INFO] Stopping server and watcher...'));
      
      // Remove all listeners first
      process.stdin.removeAllListeners('keypress');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
      
      // Stop file watchers
      try {
        fs.unwatchFile(readmePath);
        fs.unwatchFile(configPath);
      } catch (e) {
        // ignore
      }
      
      // Remove auto-generated config file
      try {
        const configJsPath = path.join(publicFolder, '_prolibu_config.js');
        if (fs.existsSync(configJsPath)) {
          fs.unlinkSync(configJsPath);
        }
      } catch (e) {
        // ignore
      }
      
      // Kill the server process tree
      try {
        if (serverProcess && !serverProcess.killed) {
          // Kill the entire process tree
          const { execSync } = require('child_process');
          try {
            // Find all child processes of live-server
            if (process.platform === 'darwin' || process.platform === 'linux') {
              execSync(`pkill -P ${serverPid}`, { stdio: 'ignore' });
            }
          } catch (e) {
            // Ignore if no children
          }
          
          serverProcess.kill('SIGKILL');
          
          // Wait a bit for cleanup
          await new Promise(resolve => setTimeout(resolve, 200));
          
          // Force kill anything still on the port
          try {
            if (process.platform === 'darwin' || process.platform === 'linux') {
              execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
            }
          } catch (e) {
            // Port already free
          }
        }
      } catch (e) {
        // ignore
      }
      
      try {
        if (watcher) {
          await watcher.close();
        }
      } catch (e) {
        // ignore
      }
      
      try {
        if (isRawMode && process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        process.stdin.destroy();
      } catch (e) {
        // ignore
      }
      
      console.log(chalk.green('✓ Cleanup complete'));
      
      // Force exit
      process.exit(0);
    };
    
    process.stdin.on('keypress', async (str, key) => {
      // Ctrl+C
      if (key && key.ctrl && key.name === 'c') {
        cleanupAndExit();
        return;
      }
      
      // x or X to exit
      if (str === 'x' || str === 'X') {
        cleanupAndExit();
        return;
      }
      
      // p or P to publish
      if (str === 'p' || str === 'P') {
        console.log('');
        console.log(chalk.yellow(`📦 Publishing to ${envLabel}...`));
        console.log('');
        
        try {
          // Create zip
          console.log(`${chalk.dim('[ZIP]')} Creating package from ${chalk.cyan('public/')}...`);
          await zipSite(publicFolder, distZip);
          
          const fileStat = fs.statSync(distZip);
          const fileSizeMB = (fileStat.size / (1024 * 1024)).toFixed(2);
          console.log(`${chalk.dim('[ZIP]')} Created dist.zip (${fileSizeMB} MB)`);
          
          // Upload
          console.log(`${chalk.dim('[UPLOAD]')} Uploading package to site...`);
          const siteData = await patchSite(domain, apiKey, siteCode, distZip, 'package');
          console.log(`${chalk.green('✓')} Site '${chalk.bold(siteCode)}' published successfully`);
          console.log('');
          console.log(chalk.bold('  🌐 Site URLs:'));
          if (siteData.url) {
            console.log(`    ${chalk.cyan(siteData.url)}`);
          }
          if (siteData.shortUrl && siteData.shortUrl !== siteData.url) {
            console.log(`    ${chalk.cyan(siteData.shortUrl)} ${chalk.dim('(short)')}`);
          }
          
          // Show QR code for short URL
          const publishQrUrl = siteData.shortUrl || siteData.url;
          if (publishQrUrl) {
            console.log('');
            console.log(chalk.bold('  📱 Scan QR code for mobile access:'));
            console.log('');
            qrcode.generate(publishQrUrl, { small: true }, (qr) => {
              qr.split('\n').forEach(line => console.log('  ' + line));
              console.log('');
            });
          }
          
          console.log('');
          console.log(`    ${chalk.dim('Press')} ${chalk.bold.cyan('p')} ${chalk.dim('to publish again or')} ${chalk.bold.red('x')} ${chalk.dim('to exit')}`);
          console.log('');
        } catch (err) {
          console.error(chalk.red('✗ Publish failed:'), err.message);
          console.log('');
          console.log(`    ${chalk.dim('Press')} ${chalk.bold.cyan('p')} ${chalk.dim('to try again or')} ${chalk.bold.red('x')} ${chalk.dim('to exit')}`);
          console.log('');
        }
      }
    });

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
    process.on('SIGINT', cleanupAndExit);
    process.on('SIGTERM', cleanupAndExit);
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
