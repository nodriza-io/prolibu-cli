module.exports = async function createScript(flags) {
  const inquirer = await import('inquirer');
  const apiClient = require('../../../api/scriptClient');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  
  let domain = flags.domain;
  let scriptPrefix = flags.scriptPrefix;
  let repo = flags.repo;
  let lifecycleHooks = flags.lifecycleHooks;
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

  // 2. apiKey (always ensure profile.json is created/updated)
  const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
  
  if (fs.existsSync(profilePath)) {
    try {
      const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (!apiKey) apiKey = profileData.apiKey;
    } catch {}
  }
  if (!apiKey) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: `Enter API key for domain '${domain}':`,
      validate: input => input ? true : 'API key is required.'
    });
    apiKey = response.apiKey;
  }
  
  const domainDir = path.dirname(profilePath);
  if (!fs.existsSync(domainDir)) {
    fs.mkdirSync(domainDir, { recursive: true });
  }
  fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));

  // 3. scriptPrefix
  if (!scriptPrefix) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'scriptPrefix',
      message: 'Enter prefix (script name):',
      validate: input => input ? true : 'Prefix is required.'
    });
    scriptPrefix = response.scriptPrefix;
  }

  // 4. repo
  if (!repo) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'repo',
      message: 'Enter git repository URL:',
      validate: input => input ? true : 'Git repository URL is required.'
    });
    repo = response.repo;
  }

  // 5. lifecycleHooks
  if (!lifecycleHooks) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'lifecycleHooks',
      message: 'Add lifecycleHooks? (comma separated, e.g. Company,Contact,Deal)',
      default: '',
    });
    lifecycleHooks = response.lifecycleHooks;
  }

  let hooksArr = [];
  if (lifecycleHooks && lifecycleHooks.trim()) {
    hooksArr = lifecycleHooks.split(',').map(h => h.trim()).filter(Boolean);
  }

  // Clone repo and copy templates
  const repoDir = path.join(process.cwd(), 'accounts', domain, scriptPrefix);
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
    execSync(`git clone ${repo} ${repoDir}`, { stdio: 'inherit' });
    console.log(`[GIT] Repository cloned to ${repoDir}`);
    
    // Read existing config.json from cloned repo (if exists)
    const repoConfigPath = path.join(repoDir, 'config.json');
    let repoConfig = {};
    if (fs.existsSync(repoConfigPath)) {
      try {
        repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
      } catch (e) {
        console.warn(`[WARN] Failed to parse existing config.json from repo: ${e.message}`);
      }
    }
    
    // Copy all files and folders from templates/script directory
    const templateDir = path.join(__dirname, '../../../templates/script');
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
      }
    };
    
    fs.writeFileSync(repoConfigPath, JSON.stringify(mergedConfig, null, 2));
    
    // Copy settings.json from template (local build settings)
    const templateSettingsPath = path.join(templateDir, 'settings.json');
    const repoSettingsPath = path.join(repoDir, 'settings.json');
    if (fs.existsSync(templateSettingsPath)) {
      fs.copyFileSync(templateSettingsPath, repoSettingsPath);
    }
    
    console.log(`[INIT] Script structure initialized from templates in ${repoDir}`);
  } catch (err) {
    console.error(`[ERROR] Failed to clone repository: ${err.message}`);
    process.exit(1);
  }

  // Merge lifecycleHooks from --lifecycleHooks flag into config.json
  if (hooksArr.length) {
    const configPath = path.join(repoDir, 'config.json');
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Merge hooks (avoid duplicates)
    const existingHooks = configData.lifecycleHooks || [];
    const mergedHooks = [...new Set([...existingHooks, ...hooksArr])];
    configData.lifecycleHooks = mergedHooks;
    
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    console.log(`[INFO] lifecycleHooks merged into config.json: ${JSON.stringify(mergedHooks)}`);
  }

  // Create dev and prod scripts
  await apiClient.createScript(scriptPrefix, 'dev', domain, repo, 'index');
  await apiClient.createScript(scriptPrefix, 'prod', domain, repo, 'index');

  const chalk = (await import('chalk')).default;
  console.log(`Scripts '${scriptPrefix}-dev' and '${scriptPrefix}-prod' created for domain '${domain}'.`);
  console.log('\nNext steps:');
  console.log(`To start development, run:\n  ${chalk.green(`./prolibu script dev --domain ${domain} --prefix ${scriptPrefix} --watch`)}`);
  console.log(`To start production, run:\n  ${chalk.green(`./prolibu script prod --domain ${domain} --prefix ${scriptPrefix} --watch`)}`);
};
