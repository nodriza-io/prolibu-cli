module.exports = async function runPlugin(mode, flags) {
  const inquirer = await import('inquirer');
  const { pascalCase } = await import('change-case');
  const pluginClient = require('../../../api/pluginClient');
  const config = require('../../../config/config');
  const { zipPlugin } = require('../../builders/pluginBuilder');
  const path = require('path');
  const fs = require('fs');
  const { execSync, spawn } = require('child_process');

  let domain = flags.domain;
  let pluginPrefix = flags.prefix || flags.pluginPrefix;
  let watch = flags.watch || flags.w;
  let port = flags.port || 4500;

  // 1. Domain
  if (!domain) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter domain:',
      validate: input => input ? true : 'Domain is required.'
    });
    domain = response.domain;
  }

  // 2. Plugin prefix
  if (!pluginPrefix) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'pluginPrefix',
      message: 'Enter plugin prefix (name):',
      validate: input => input ? true : 'Plugin prefix is required.'
    });
    pluginPrefix = response.pluginPrefix;
  }

  // Get API key from profile
  const apiKey = config.get('apiKey', domain);
  if (!apiKey) {
    console.error(`No API key found for domain '${domain}'. Run 'prolibu plugin create' first.`);
    process.exit(1);
  }

  // Plugin paths
  const pluginDir = path.join(process.cwd(), 'accounts', domain, pluginPrefix);
  const configPath = path.join(pluginDir, 'config.json');
  const settingsPath = path.join(pluginDir, 'settings.json');
  const readmePath = path.join(pluginDir, 'README.md');
  const distDir = path.join(pluginDir, 'dist');

  if (!fs.existsSync(pluginDir)) {
    console.error(`Plugin directory not found: ${pluginDir}`);
    console.error(`Run 'prolibu plugin create --domain ${domain} --prefix ${pluginPrefix}' first.`);
    process.exit(1);
  }

  // Read settings
  let settings = { port: 4500 };
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch { }
  }
  port = settings.port || port;

  // Plugin code (with -dev suffix for dev mode)
  const pluginCode = mode === 'dev' ? `${pluginPrefix}-dev` : pluginPrefix;
  const pluginName = pascalCase(pluginPrefix);

  // Ensure plugin exists on the API
  const pluginData = await pluginClient.ensurePluginExists(domain, apiKey, pluginCode);
  if (!pluginData) {
    console.error(`Could not ensure plugin '${pluginCode}' exists on the server.`);
    process.exit(1);
  }

  const chalk = (await import('chalk')).default;

  if (mode === 'dev') {
    // DEV MODE: Start Vite dev server
    console.log(chalk.blue(`\n[DEV] Starting Vite dev server for '${pluginCode}'...`));
    console.log(chalk.gray(`Plugin directory: ${pluginDir}`));
    console.log(chalk.gray(`Port: ${port}\n`));

    // Start Vite dev server
    const viteProcess = spawn('npx', ['vite', '--port', String(port), '--host'], {
      cwd: pluginDir,
      stdio: 'inherit',
      shell: true
    });

    viteProcess.on('error', (err) => {
      console.error(chalk.red(`Failed to start Vite: ${err.message}`));
      process.exit(1);
    });

    // Watch for config changes and sync to API
    if (watch) {
      setupWatchers(domain, apiKey, pluginCode, pluginDir, configPath, readmePath, chalk);
    }

    // Handle process termination
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n[DEV] Shutting down...'));
      viteProcess.kill();
      process.exit(0);
    });

  } else {
    // PROD MODE: Build and upload as ZIP package
    console.log(chalk.blue(`\n[PROD] Building plugin '${pluginCode}'...`));

    try {
      // Run Vite build
      execSync('npx vite build', { cwd: pluginDir, stdio: 'inherit' });
      console.log(chalk.green(`[BUILD] Build completed successfully!`));

      // Verify bundle exists
      const bundlePath = path.join(distDir, `${pluginPrefix}.js`);
      if (!fs.existsSync(bundlePath)) {
        const distFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
        if (distFiles.length === 0) {
          console.error(chalk.red(`No bundle found in ${distDir}`));
          process.exit(1);
        }
        console.log(chalk.yellow(`[WARN] Expected ${pluginPrefix}.js, found ${distFiles[0]}`));
      }

      // Find icon and assets directory
      const assetsDir = path.join(pluginDir, 'src', 'assets');
      let iconPath = null;
      if (fs.existsSync(assetsDir)) {
        const iconFiles = fs.readdirSync(assetsDir).filter(f =>
          /^icon\.(svg|png|jpg|jpeg|gif)$/i.test(f)
        );
        if (iconFiles.length > 0) {
          iconPath = path.join(assetsDir, iconFiles[0]);
          console.log(chalk.gray(`[ICON] Found: ${iconFiles[0]}`));
        }
      }

      if (!iconPath) {
        console.log(chalk.yellow(`[WARN] No icon found. Add icon.png or icon.svg in src/assets/`));
      }

      // Create ZIP package (dist + assets)
      const distZip = path.join(pluginDir, 'dist.zip');
      console.log(chalk.blue(`[ZIP] Creating package from dist/...`));

      // Check if there are additional assets to include (excluding icon)
      let additionalAssetsDir = null;
      if (fs.existsSync(assetsDir)) {
        const assetFiles = fs.readdirSync(assetsDir).filter(f =>
          !/^icon\.(svg|png|jpg|jpeg|gif)$/i.test(f)
        );
        if (assetFiles.length > 0) {
          additionalAssetsDir = assetsDir;
          console.log(chalk.gray(`[ASSETS] Including ${assetFiles.length} additional asset(s)`));
        }
      }

      await zipPlugin(distDir, distZip, additionalAssetsDir);

      const fileStat = fs.statSync(distZip);
      const fileSizeKB = (fileStat.size / 1024).toFixed(2);
      console.log(chalk.gray(`[ZIP] Created dist.zip (${fileSizeKB} KB)`));

      // Upload to API
      console.log(chalk.blue(`[UPLOAD] Uploading plugin to '${domain}'...`));

      // Read config and sync to API
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (configData.variables) {
          await pluginClient.patchPlugin(domain, apiKey, pluginCode, configData.variables, 'variables');
        }
        if (configData.description) {
          await pluginClient.patchPlugin(domain, apiKey, pluginCode, configData.description, 'description');
        }
      }

      // Read package.json for version
      const packageJsonPath = path.join(pluginDir, 'package.json');
      let version = '1.0.0';
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          version = packageJson.version || '1.0.0';
        } catch { }
      }

      // Sync metadata fields
      await pluginClient.patchPlugin(domain, apiKey, pluginCode, pluginName, 'pluginName');
      await pluginClient.patchPlugin(domain, apiKey, pluginCode, version, 'version');
      await pluginClient.patchPlugin(domain, apiKey, pluginCode, true, 'active');

      // Extract and sync formSchema as optionsSchema
      const { extractOptionsSchema } = require('../../builders/pluginBuilder');
      const optionsSchema = extractOptionsSchema(bundlePath);

      if (optionsSchema) {
        await pluginClient.patchPlugin(domain, apiKey, pluginCode, optionsSchema, 'optionsSchema');
        console.log(chalk.gray(`[SCHEMA] Synced optionsSchema to API`));
      }

      // Read and sync README
      if (fs.existsSync(readmePath)) {
        const readme = fs.readFileSync(readmePath, 'utf8');
        await pluginClient.patchPlugin(domain, apiKey, pluginCode, readme, 'readme');
      }

      // Upload icon separately if exists
      if (iconPath) {
        await pluginClient.uploadPluginIcon(domain, apiKey, pluginCode, iconPath);
      }

      // Upload ZIP package
      await pluginClient.patchPlugin(domain, apiKey, pluginCode, distZip, 'package');

      console.log(chalk.green(`\n[DONE] Plugin '${pluginCode}' published successfully!`));
      console.log(chalk.gray(`View at: https://${domain}/ui/spa/suite/plugin`));

    } catch (err) {
      console.error(chalk.red(`[ERROR] Build failed: ${err.message}`));
      process.exit(1);
    }
  }
};

// Setup file watchers for dev mode
function setupWatchers(domain, apiKey, pluginCode, pluginDir, configPath, readmePath, chalk) {
  const fs = require('fs');
  const pluginClient = require('../../../api/pluginClient');

  console.log(chalk.gray('[WATCH] Watching for config and README changes...\n'));

  // Watch config.json
  if (fs.existsSync(configPath)) {
    fs.watchFile(configPath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        try {
          const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

          if (configData.variables) {
            await pluginClient.patchPlugin(domain, apiKey, pluginCode, configData.variables, 'variables');
          }
          if (configData.description) {
            await pluginClient.patchPlugin(domain, apiKey, pluginCode, configData.description, 'description');
          }

          console.log(chalk.green(`[SYNC] config.json synced to '${pluginCode}'`));
        } catch (err) {
          console.error(chalk.red(`[ERROR] Failed to sync config.json: ${err.message}`));
        }
      }
    });
  }

  // Watch README.md
  if (fs.existsSync(readmePath)) {
    fs.watchFile(readmePath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        try {
          const readme = fs.readFileSync(readmePath, 'utf8');
          await pluginClient.patchPlugin(domain, apiKey, pluginCode, readme, 'readme');
          console.log(chalk.green(`[SYNC] README.md synced to '${pluginCode}'`));
        } catch (err) {
          console.error(chalk.red(`[ERROR] Failed to sync README.md: ${err.message}`));
        }
      }
    });
  }
}
