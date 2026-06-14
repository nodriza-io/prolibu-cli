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
 * @returns {boolean} true if created successfully, false otherwise
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
    return true;
  } catch (err) {
    console.error(formatAxiosError(err, `Failed to create site ${siteCode}`));
    return false;
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
 * Creates a site for the specified environment (uses ensureSiteExists to avoid duplicates)
 */
async function createSite(sitePrefix, env, domain, siteType, gitRepo) {
  const config = require('../config/config');
  const siteCode = env === 'prod' ? sitePrefix : `${sitePrefix}-${env}`;
  const apiKey = config.get('apiKey', domain);
  const envLabel = env === 'dev' ? 'Dev' : 'Prod';
  const siteNameLabel = `${sitePrefix} - ${envLabel}`;
  
  // Check if site already exists, create only if not found
  const url = `https://${domain}/v2/site/${siteCode}`;
  try {
    await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    // Site exists, just log it
    console.log(`Site ${siteCode} already exists on ${domain}`);
  } catch (err) {
    if (err.response?.status === 404) {
      // Site doesn't exist, create it
      const extra = {};
      if (gitRepo) {
        extra.git = { repositoryUrl: gitRepo };
      }
      const created = await createSiteDoc(domain, apiKey, siteCode, siteNameLabel, siteType, extra);
      if (created) {
        console.log(`✓ Site created: ${siteCode} (domain: ${domain}) as '${siteNameLabel}'`);
      }
    } else {
      console.error(formatAxiosError(err, `Failed to check if site ${siteCode} exists`));
    }
  }
}

/**
 * Runs the site in the specified environment and watches for changes
 */
/**
 * Detect if a site project uses a build tool (Vite, etc.)
 * Returns { hasBuild, packageJson, buildScript, devScript, outputDir } or null
 */
function detectBuildTool(siteFolder) {
  const pkgPath = path.join(siteFolder, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    if (!scripts.build) return null;

    // Determine output dir: check for vite.config, otherwise default to 'dist'
    let outputDir = 'dist';
    const settingsPath = path.join(siteFolder, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.outputDir) outputDir = settings.outputDir;
      } catch (e) {}
    }

    return {
      hasBuild: true,
      packageJson: pkg,
      buildScript: scripts.build,
      devScript: scripts.dev || null,
      outputDir,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Run npm install if node_modules is missing or outdated
 */
function ensureDeps(siteFolder) {
  const nodeModules = path.join(siteFolder, 'node_modules');
  const pkgPath = path.join(siteFolder, 'package.json');
  const needsInstall = !fs.existsSync(nodeModules) ||
    (fs.existsSync(pkgPath) && fs.statSync(pkgPath).mtimeMs > fs.statSync(nodeModules).mtimeMs);

  if (needsInstall) {
    console.log('[DEPS] Installing dependencies...');
    const { execSync } = require('child_process');
    execSync('npm install', { cwd: siteFolder, stdio: 'inherit' });
    console.log('[DEPS] Dependencies installed');
  }
}

async function runDevSite(sitePrefix, env, domain, apiKey, watch = false, port = 3030, extensions = 'html,css,js') {
  const siteCode = env === 'prod' ? sitePrefix : `${sitePrefix}-${env}`;
  const envLabel = env === 'dev' ? 'Dev' : 'Prod';
  const siteNameLabel = `${sitePrefix} - ${envLabel}`;
  
  const siteFolder = path.join(process.cwd(), 'accounts', domain, 'sites', sitePrefix);
  const publicFolder = path.join(siteFolder, 'public');
  const distZip = path.join(siteFolder, 'dist.zip');
  const configPath = path.join(siteFolder, 'config.json');
  const settingsPath = path.join(siteFolder, 'settings.json');
  const readmePath = path.join(siteFolder, 'README.md');

  // Detect build tool (React+Vite, Vue+Vite, etc.)
  const buildTool = detectBuildTool(siteFolder);
  const hasBuild = buildTool && buildTool.hasBuild;
  const outputDir = hasBuild ? path.join(siteFolder, buildTool.outputDir) : publicFolder;
  
  if (!hasBuild && !fs.existsSync(publicFolder)) {
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
    // If project has a build step, run it first
    if (hasBuild) {
      ensureDeps(siteFolder);

      // Inject _prolibu_config.js into public/ so Vite copies it to dist
      const configJsDir = fs.existsSync(publicFolder) ? publicFolder : siteFolder;
      const configJsPath = path.join(configJsDir, '_prolibu_config.js');
      const configJsContent = `// Auto-generated by Prolibu CLI - DO NOT EDIT\nwindow.__PROLIBU_CONFIG__ = {\n  domain: '${domain}',\n  apiBaseUrl: 'https://${domain}/v2',\n  isDev: false\n};`;
      if (!fs.existsSync(configJsDir)) fs.mkdirSync(configJsDir, { recursive: true });
      fs.writeFileSync(configJsPath, configJsContent);

      console.log(`[BUILD] Running: npm run build`);
      const { execSync } = require('child_process');
      execSync('npm run build', { cwd: siteFolder, stdio: 'inherit' });
      console.log(`[BUILD] Build completed`);

      if (!fs.existsSync(outputDir)) {
        console.error(`❌ Build output folder not found: ${outputDir}`);
        console.error('Check your build tool config (vite.config.ts, etc.)');
        process.exit(1);
      }
    }

    const zipSource = hasBuild ? outputDir : publicFolder;

    // Initial zip and upload
    console.log(`[ZIP] Creating package from ${zipSource}...`);
    await zipSite(zipSource, distZip);
    
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
    
    let serverProcess;
    let serverPid;

    if (hasBuild && buildTool.devScript) {
      // ── Build-tool project (React+Vite, Vue+Vite, etc.) ──
      ensureDeps(siteFolder);

      // Inject _prolibu_config.js for dev into public/ (Vite copies it)
      const configJsDir = fs.existsSync(publicFolder) ? publicFolder : path.join(siteFolder, 'public');
      if (!fs.existsSync(configJsDir)) fs.mkdirSync(configJsDir, { recursive: true });
      const configJsPath = path.join(configJsDir, '_prolibu_config.js');
      const configJsContent = `// Auto-generated by Prolibu CLI - DO NOT EDIT\nwindow.__PROLIBU_CONFIG__ = {\n  domain: '${domain}',\n  apiBaseUrl: 'https://${domain}/v2',\n  isDev: true\n};`;
      fs.writeFileSync(configJsPath, configJsContent);

      // Run the dev server (e.g. vite dev) 
      serverProcess = spawn('npx', buildTool.devScript.split(' '), {
        cwd: siteFolder,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, PORT: port.toString(), BROWSER: 'none' },
      });

      serverPid = serverProcess.pid;

      // Pipe server output to console, filtering out Vite's startup banner
      // (we already print our own server info with QR code, URLs, etc.)
      const viteStartupRe = /VITE\s+v[\d.]+\s+ready|➜\s+(Local|Network):/i;
      serverProcess.stdout.on('data', d => {
        d.toString().split('\n').filter(l => l.trim()).forEach(line => {
          if (!viteStartupRe.test(line)) process.stdout.write(`    ${line}\n`);
        });
      });
      serverProcess.stderr.on('data', d => {
        d.toString().split('\n').filter(l => l.trim()).forEach(line => {
          if (!viteStartupRe.test(line)) process.stderr.write(`    ${line}\n`);
        });
      });
    } else {
      // ── Vanilla project → live-server ──
      const liveServerArgs = [
        'live-server',
        publicFolder,
        '--port=' + port.toString(),
        '--no-browser',
        '--quiet',
        '--wait=200'
      ];
      // SPA mode: serve index.html for any route that doesn't match a file
      if (siteType === 'SPA') {
        liveServerArgs.push('--entry-file=index.html');
      }
      serverProcess = spawn('npx', liveServerArgs, {
        stdio: 'ignore',
        detached: false
      });

      serverPid = serverProcess.pid;

      // Create a config file with domain info for local development
      const configJsPath = path.join(publicFolder, '_prolibu_config.js');
      const configJsContent = `// Auto-generated by Prolibu CLI - DO NOT EDIT\nwindow.__PROLIBU_CONFIG__ = {\n  domain: '${domain}',\n  apiBaseUrl: 'https://${domain}/v2',\n  isDev: true\n};`;
      fs.writeFileSync(configJsPath, configJsContent);
    }
    
    const chalk = (await import('chalk')).default;
    const qrcode = require('qrcode-terminal');
    
    // ASCII Art Logo
    console.log('');
    console.log('    ' + chalk.blue('◯') + chalk.yellow(' || ') + chalk.hex('#E91E63')('▶') + chalk.bold.white(' Prolibu CLI') + chalk.dim(' v2.0'));
    console.log('');
    
    // Show QR code for mobile access
    const qrUrl = addresses.length > 0 ? `http://${addresses[0]}:${port}` : `http://localhost:${port}`;
    console.log('    ' + chalk.bold('📱 Scan QR code for mobile access on ') + chalk.cyan(qrUrl));
    qrcode.generate(qrUrl, { small: true }, (qr) => {
      qr.split('\n').forEach(line => console.log('    ' + line));
      console.log('');
    });
    
    console.log('    ' + chalk.bold('Server available on:'));
    console.log(`      ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`      ${chalk.cyan(`http://127.0.0.1:${port}`)}`);
    addresses.forEach(addr => console.log(`      ${chalk.cyan(`http://${addr}:${port}`)}`));
    console.log('');
    
    if (hasBuild) {
      const pkgName = buildTool.packageJson.name || sitePrefix;
      const devCmd = buildTool.devScript || 'npm run dev';
      console.log(`    ${chalk.dim('⚡ Build tool:')} ${chalk.cyan(devCmd)} ${chalk.dim(`(${pkgName})`)}`);
      console.log(`    ${chalk.dim('💡 HMR enabled — changes apply instantly')}`);
    } else {
      const extArray = extensions.split(',').map(e => e.trim());
      const watchPatterns = extArray.map(ext => `*.${ext}`);
      console.log(`    ${chalk.dim('📁 Watching')} ${chalk.cyan(watchPatterns.join(', '))} ${chalk.dim('in')} ${chalk.cyan('public/')}`);
      console.log(`    ${chalk.dim('💡 Browser will auto-reload on changes (no upload needed)')}`);
    }
    if (siteType === 'SPA') {
      console.log(`    ${chalk.dim('🔀 SPA mode:')} ${chalk.cyan('All routes fallback to index.html')}`);
    }    console.log('');
    console.log(`    ${chalk.dim('Press')} ${chalk.bold.cyan('p')} ${chalk.dim('to publish to')} ${chalk.bold(envLabel)} ${chalk.dim('or')} ${chalk.bold.red('x')} ${chalk.dim('to exit')}`);
    console.log('');

    // Watch folder for file change logging
    const chokidar = require('chokidar');
    const watchDir = hasBuild ? siteFolder : publicFolder;
    const watcher = chokidar.watch(watchDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 99,
      awaitWriteFinish: true,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.DS_Store', '**/dist.zip']
    });

    // Log file changes
    watcher.on('add', (filePath) => {
      console.log(`${chalk.dim('[FILE]')} ${chalk.green('added')} ${chalk.dim(path.relative(watchDir, filePath))}`);
    });
    watcher.on('change', (filePath) => {
      console.log(`${chalk.dim('[FILE]')} ${chalk.cyan('changed')} ${chalk.dim(path.relative(watchDir, filePath))}`);
    });
    watcher.on('unlink', (filePath) => {
      console.log(`${chalk.dim('[FILE]')} ${chalk.red('deleted')} ${chalk.dim(path.relative(watchDir, filePath))}`);
    });

    // Listen for keypress to publish or exit
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);
    
    let isRawMode = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      isRawMode = true;
    }
    process.stdin.resume();
    
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
          // Build step if applicable
          if (hasBuild) {
            console.log(`${chalk.dim('[BUILD]')} Running: npm run build`);
            const { execSync: execSyncPub } = require('child_process');
            execSyncPub('npm run build', { cwd: siteFolder, stdio: 'inherit' });
            console.log(`${chalk.dim('[BUILD]')} Build completed`);
          }

          const zipSource = hasBuild ? outputDir : publicFolder;
          const zipLabel = hasBuild ? buildTool.outputDir + '/' : 'public/';

          // Create zip
          console.log(`${chalk.dim('[ZIP]')} Creating package from ${chalk.cyan(zipLabel)}...`);
          await zipSite(zipSource, distZip);
          
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
