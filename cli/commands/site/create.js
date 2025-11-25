module.exports = async function createSite(flags) {
  const inquirer = await import('inquirer');
  const siteClient = require('../../../api/siteClient');
  const config = require('../../../config/config');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  
  let domain = flags.domain;
  let sitePrefix = flags.sitePrefix;
  let repo = flags.repo;
  let siteType = flags.siteType;
  let apiKey = flags.apikey;

  // 1. domain
  if (!domain) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter domain:',
      validate: input => input ? true : 'Domain is required.'
    });
    domain = response.domain;
  }

  // 2. apiKey - use config module like script does
  if (!apiKey) {
    apiKey = config.get('apiKey', domain);
  }
  if (!apiKey) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: `Enter API key for domain '${domain}':`,
      validate: input => input ? true : 'API key is required.'
    });
    apiKey = response.apiKey;
    config.set('apiKey', apiKey, domain);
  }

  // 3. sitePrefix
  if (!sitePrefix) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'sitePrefix',
      message: 'Enter prefix (site name):',
      validate: input => input ? true : 'Prefix is required.'
    });
    sitePrefix = response.sitePrefix;
  }

  // 4. siteType
  if (!siteType) {
    const response = await inquirer.default.prompt({
      type: 'list',
      name: 'siteType',
      message: 'Select site type:',
      choices: ['Static', 'SPA'],
      default: 'Static'
    });
    siteType = response.siteType;
  } else {
    // Normalize siteType from CLI flag (case-insensitive)
    siteType = siteType.charAt(0).toUpperCase() + siteType.slice(1).toLowerCase();
    if (!['Static', 'Spa'].includes(siteType)) {
      console.error(`Invalid siteType: ${siteType}. Must be 'static' or 'spa'.`);
      process.exit(1);
    }
    // Normalize 'Spa' to 'SPA'
    if (siteType === 'Spa') siteType = 'SPA';
  }

  // 5. repo (optional)
  if (!repo) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'repo',
      message: 'Enter git repository URL (optional, press Enter to skip):',
      default: ''
    });
    repo = response.repo;
  }

  // Create site directory
  const repoDir = path.join(process.cwd(), 'accounts', domain, sitePrefix);
  if (fs.existsSync(repoDir) && fs.readdirSync(repoDir).length > 0) {
    const { confirmDelete } = await inquirer.default.prompt({
      type: 'confirm',
      name: 'confirmDelete',
      message: `The folder ${repoDir} already exists and is not empty. Delete it and continue?`,
      default: false
    });
    if (!confirmDelete) {
      console.log('Aborted by user.');
      process.exit(1);
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    console.log(`[CLEANUP] Deleted existing folder: ${repoDir}`);
  }

  try {
    let repoConfig = {};
    
    // Clone repo if provided
    if (repo && repo.trim()) {
      execSync(`git clone ${repo} ${repoDir}`, { stdio: 'inherit' });
      console.log(`[GIT] Repository cloned to ${repoDir}`);
      
      // Read existing config.json from cloned repo (if exists)
      const repoConfigPath = path.join(repoDir, 'config.json');
      if (fs.existsSync(repoConfigPath)) {
        try {
          repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
        } catch (e) {
          console.warn(`[WARN] Failed to parse existing config.json from repo: ${e.message}`);
        }
      }
    } else {
      // No repo provided, create directory from template
      console.log(`[TEMPLATE] Creating site from template...`);
      fs.mkdirSync(repoDir, { recursive: true });
    }
    
    // Copy template files from templates/site
    const templateDir = path.join(__dirname, '../../../templates/site');
    if (fs.existsSync(templateDir)) {
      fs.readdirSync(templateDir).forEach(item => {
        const src = path.join(templateDir, item);
        const dest = path.join(repoDir, item);
        const stat = fs.statSync(src);
        
        // Skip config.json from template, we'll merge it later
        if (item === 'config.json') return;
        
        if (stat.isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else {
          fs.copyFileSync(src, dest);
        }
      });
    }
    
    // Merge template config with repo config (repo takes priority for variables/lifecycleHooks)
    const templateConfigPath = path.join(templateDir, 'config.json');
    let templateConfig = {};
    if (fs.existsSync(templateConfigPath)) {
      templateConfig = JSON.parse(fs.readFileSync(templateConfigPath, 'utf8'));
    }
    
    // Merge: template provides structure, repo provides data
    const mergedConfig = {
      ...templateConfig,
      ...repoConfig,
      // Preserve repo's variables and lifecycleHooks if they exist
      variables: repoConfig.variables || templateConfig.variables || [],
      lifecycleHooks: repoConfig.lifecycleHooks || templateConfig.lifecycleHooks || [],
      readme: repoConfig.readme || templateConfig.readme || '',
      git: {
        repositoryUrl: repo || repoConfig.git?.repositoryUrl || ''
      },
      siteType: siteType
    };
    
    const finalConfigPath = path.join(repoDir, 'config.json');
    fs.writeFileSync(finalConfigPath, JSON.stringify(mergedConfig, null, 2));
    
    // Copy settings.json from template (local build settings)
    const templateSettingsPath = path.join(templateDir, 'settings.json');
    const repoSettingsPath = path.join(repoDir, 'settings.json');
    if (fs.existsSync(templateSettingsPath)) {
      fs.copyFileSync(templateSettingsPath, repoSettingsPath);
    }
    
    console.log(`[INIT] Site structure initialized from templates in ${repoDir}`);
  } catch (err) {
    console.error(`[ERROR] Failed to clone repository: ${err.message}`);
    process.exit(1);
  }

  // Create dev and prod sites
  await siteClient.createSite(sitePrefix, 'dev', domain, siteType, repo);
  await siteClient.createSite(sitePrefix, 'prod', domain, siteType, repo);

  const chalk = (await import('chalk')).default;
  console.log(`Sites '${sitePrefix}-dev' and '${sitePrefix}-prod' created for domain '${domain}'.`);
  console.log('\nNext steps:');
  console.log(`To start development, run:\n  ${chalk.green(`./prolibu site dev --domain ${domain} --prefix ${sitePrefix} --watch`)}`);
  console.log(`To start production, run:\n  ${chalk.green(`./prolibu site prod --domain ${domain} --prefix ${sitePrefix}`)}`);
};
