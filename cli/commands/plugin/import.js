module.exports = async function importPlugin(flags) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');

  let domain = flags.domain;
  let pluginPrefix = flags.prefix || flags.pluginPrefix;
  let repo = flags.repo;
  let apiKey = flags.apikey;

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

  // Save API key
  const domainDir = path.dirname(profilePath);
  if (!fs.existsSync(domainDir)) {
    fs.mkdirSync(domainDir, { recursive: true });
  }
  fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));

  // 3. Repository URL
  if (!repo) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'repo',
      message: 'Enter git repository URL:',
      validate: input => input ? true : 'Repository URL is required.'
    });
    repo = response.repo;
  }

  // 4. Plugin prefix (extract from repo name if not provided)
  if (!pluginPrefix) {
    // Try to extract name from repo URL
    const repoName = repo.split('/').pop().replace('.git', '');
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'pluginPrefix',
      message: 'Enter plugin name (prefix):',
      default: repoName,
      validate: input => input ? true : 'Plugin name is required.'
    });
    pluginPrefix = response.pluginPrefix;
  }

  const pluginDir = path.join(process.cwd(), 'accounts', domain, pluginPrefix);

  // Check if directory exists
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
    // Clone repository
    console.log(`[GIT] Cloning repository...`);
    execSync(`git clone ${repo} ${pluginDir}`, { stdio: 'inherit' });
    console.log(`[GIT] Repository cloned to ${pluginDir}`);

    // Remove .git from cloned repo (domain-level git will be used)
    const clonedGitDir = path.join(pluginDir, '.git');
    if (fs.existsSync(clonedGitDir)) {
      fs.rmSync(clonedGitDir, { recursive: true, force: true });
      console.log(`[GIT] Removed .git from plugin folder (domain-level git will be used)`);
    }

    // Create/update config.json with git info
    const configPath = path.join(pluginDir, 'config.json');
    let configData = {};
    if (fs.existsSync(configPath)) {
      try {
        configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {}
    }
    configData.git = { repositoryUrl: repo };
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // Create settings.json if it doesn't exist
    const settingsPath = path.join(pluginDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify({ port: 4500 }, null, 2));
    }

    // Install dependencies
    if (fs.existsSync(path.join(pluginDir, 'package.json'))) {
      console.log(`[NPM] Installing dependencies...`);
      execSync('npm install', { cwd: pluginDir, stdio: 'inherit' });
      console.log(`[NPM] Dependencies installed successfully`);
    }

    console.log(`[INIT] Plugin imported successfully!`);

  } catch (err) {
    console.error(`[ERROR] Failed to import plugin: ${err.message}`);
    process.exit(1);
  }

  const chalk = (await import('chalk')).default;
  console.log(`\nPlugin '${pluginPrefix}' imported for domain '${domain}'.`);
  console.log('\nNext steps:');
  console.log(`  ${chalk.green(`cd accounts/${domain}/${pluginPrefix}`)}`);
  console.log(`  ${chalk.green(`../../prolibu plugin dev --domain ${domain} --prefix ${pluginPrefix} --watch`)}`);

  // Ensure git repository for domain
  const domainPath = path.join(process.cwd(), 'accounts', domain);
  const { ensureDomainGit } = require('../../core/gitUtil');
  await ensureDomainGit(domainPath, domain, flags.noGit, repo);
};
