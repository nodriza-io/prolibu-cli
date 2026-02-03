module.exports = async function createPlugin(flags) {
  const inquirer = await import('inquirer');
  const { pascalCase } = await import('change-case');
  const pluginClient = require('../../../api/pluginClient');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');

  let domain = flags.domain;
  let pluginPrefix = flags.prefix || flags.pluginPrefix;
  let repo = flags.repo;
  let description = flags.description;
  let apiKey = flags.apikey;

  // 1. Domain
  if (!domain) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter domain (e.g., dev10.prolibu.com):',
      validate: input => input ? true : 'Domain is required.'
    });
    domain = response.domain;
  }

  // 2. API Key
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

  // Save API key to profile
  const domainDir = path.dirname(profilePath);
  if (!fs.existsSync(domainDir)) {
    fs.mkdirSync(domainDir, { recursive: true });
  }
  fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));

  // 3. Plugin prefix (name)
  if (!pluginPrefix) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'pluginPrefix',
      message: 'Enter plugin name (prefix):',
      validate: input => input ? true : 'Plugin name is required.'
    });
    pluginPrefix = response.pluginPrefix;
  }

  // 4. Description
  if (!description) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'description',
      message: 'Enter plugin description (optional):',
      default: `Plugin ${pluginPrefix}`
    });
    description = response.description;
  }

  // 5. Git repo (optional)
  const domainPath = path.join(process.cwd(), 'accounts', domain);
  const hasExistingGit = fs.existsSync(path.join(domainPath, '.git'));

  if (!repo && !hasExistingGit) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'repo',
      message: 'Enter git repository URL (optional, press Enter to skip):',
      default: ''
    });
    repo = response.repo;
  }

  // Create plugin directory
  const pluginDir = path.join(process.cwd(), 'accounts', domain, pluginPrefix);
  if (fs.existsSync(pluginDir) && fs.readdirSync(pluginDir).length > 0) {
    const { confirmDelete } = await inquirer.default.prompt({
      type: 'confirm',
      name: 'confirmDelete',
      message: `The folder ${pluginDir} already exists. Delete it and continue?`,
      default: false
    });
    if (!confirmDelete) {
      console.log('Aborted by user.');
      process.exit(1);
    }
    fs.rmSync(pluginDir, { recursive: true, force: true });
    console.log(`[CLEANUP] Deleted existing folder: ${pluginDir}`);
  }

  try {
    // Clone repo if provided, otherwise create from template
    if (repo && repo.trim()) {
      execSync(`git clone ${repo} ${pluginDir}`, { stdio: 'inherit' });
      console.log(`[GIT] Repository cloned to ${pluginDir}`);

      // Remove .git from cloned repo
      const clonedGitDir = path.join(pluginDir, '.git');
      if (fs.existsSync(clonedGitDir)) {
        fs.rmSync(clonedGitDir, { recursive: true, force: true });
        console.log(`[GIT] Removed .git from plugin folder (domain-level git will be used)`);
      }
    } else {
      console.log(`[TEMPLATE] Creating plugin from template...`);
      fs.mkdirSync(pluginDir, { recursive: true });
    }

    // Copy template files
    const templateDir = path.join(__dirname, '../../../templates/plugin');
    if (fs.existsSync(templateDir)) {
      copyRecursive(templateDir, pluginDir);
    }

    // Generate plugin name in PascalCase
    const pluginName = pascalCase(pluginPrefix);

    // Update package.json with plugin name
    const packageJsonPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      packageJson.name = pluginPrefix;
      packageJson.description = description;
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    }

    // vite.config.js now reads pluginCode from package.json automatically
    // No need to replace template values

    // Create config.json
    const configPath = path.join(pluginDir, 'config.json');
    const configData = {
      variables: [],
      readme: '',
      git: { repositoryUrl: repo || '' },
      description: description
    };
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // Create settings.json
    const settingsPath = path.join(pluginDir, 'settings.json');
    const settingsData = {
      port: 4500
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2));

    // Create README.md
    const readmePath = path.join(pluginDir, 'README.md');
    fs.writeFileSync(readmePath, `# ${pluginPrefix}\n\n${description}\n`);

    console.log(`[INIT] Plugin structure initialized in ${pluginDir}`);

    // Install dependencies
    console.log(`[NPM] Installing dependencies...`);
    execSync('npm install', { cwd: pluginDir, stdio: 'inherit' });
    console.log(`[NPM] Dependencies installed successfully`);

  } catch (err) {
    console.error(`[ERROR] Failed to create plugin: ${err.message}`);
    process.exit(1);
  }

  // Create dev and prod plugins on the API
  await pluginClient.createPluginDoc(domain, apiKey, `${pluginPrefix}-dev`, `${pluginPrefix} - Dev`, { description });
  await pluginClient.createPluginDoc(domain, apiKey, pluginPrefix, `${pluginPrefix} - Prod`, { description });

  const chalk = (await import('chalk')).default;
  console.log(`\nPlugins '${pluginPrefix}-dev' and '${pluginPrefix}' created for domain '${domain}'.`);
  console.log('\nNext steps:');
  console.log(`  ${chalk.green(`cd accounts/${domain}/${pluginPrefix}`)}`);
  console.log(`  ${chalk.green(`../../prolibu plugin dev --domain ${domain} --prefix ${pluginPrefix} --watch`)}`);

  // Ensure git repository for domain
  const { ensureDomainGit } = require('../../core/gitUtil');
  await ensureDomainGit(domainPath, domain, flags.noGit, repo);
};

// Helper function to copy directory recursively
function copyRecursive(src, dest) {
  const fs = require('fs');
  const path = require('path');

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
