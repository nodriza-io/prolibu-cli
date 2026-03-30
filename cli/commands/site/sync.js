module.exports = async function syncSites(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
  const config = require('../../../config/config');
  const { ensureSiteExists, patchSite } = require('../../../api/siteClient');
  const { zipSite } = require('../../builders/siteBuilder');

  // Resolve domain
  let domain = flags.domain || flags.d;
  if (!domain) {
    const { d } = await inquirer.default.prompt({
      type: 'input',
      name: 'd',
      message: 'Domain:',
      validate: (v) => v ? true : 'Domain is required.',
    });
    domain = d;
  }

  const apiKey = flags.apikey || config.get('apiKey', domain);
  if (!apiKey) {
    console.error(chalk.red(`❌ No API key found for ${domain}. Set it in profile.json or use --apikey.`));
    process.exit(1);
  }

  const sitesDir = path.join(process.cwd(), 'accounts', domain, 'sites');
  if (!fs.existsSync(sitesDir)) {
    console.error(chalk.red(`❌ No sites/ folder found for ${domain}.`));
    process.exit(1);
  }

  // List all site folders (must have public/ directory)
  const allSites = fs.readdirSync(sitesDir).filter((f) => {
    const full = path.join(sitesDir, f);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'public'));
  });

  if (allSites.length === 0) {
    console.log(chalk.yellow('No sites found with a public/ folder.'));
    return;
  }

  // Ask: all or specific?
  const { syncMode } = await inquirer.default.prompt({
    type: 'list',
    name: 'syncMode',
    message: 'What do you want to sync?',
    choices: [
      { name: `All sites (${allSites.length})`, value: 'all' },
      { name: 'Select specific sites', value: 'select' },
    ],
  });

  let selected = allSites;

  if (syncMode === 'select') {
    const { chosen } = await inquirer.default.prompt({
      type: 'checkbox',
      name: 'chosen',
      message: 'Select sites to sync:',
      choices: allSites,
      validate: (v) => v.length > 0 ? true : 'Select at least one.',
    });
    selected = chosen;
  }

  // Ask environment
  const { env } = await inquirer.default.prompt({
    type: 'list',
    name: 'env',
    message: 'Deploy to which environment?',
    choices: [
      { name: 'Production', value: 'prod' },
      { name: 'Development', value: 'dev' },
    ],
  });

  console.log(chalk.cyan(`\n🔄 Syncing ${selected.length} site(s) to ${domain} [${env}]...\n`));

  let success = 0;
  let errors = 0;

  for (let i = 0; i < selected.length; i++) {
    const sitePrefix = selected[i];
    const siteCode = env === 'prod' ? sitePrefix : `${sitePrefix}-${env}`;
    const envLabel = env === 'dev' ? 'Dev' : 'Prod';
    const siteNameLabel = `${sitePrefix} - ${envLabel}`;
    const siteFolder = path.join(sitesDir, sitePrefix);
    const publicFolder = path.join(siteFolder, 'public');
    const distZip = path.join(siteFolder, 'dist.zip');
    const configPath = path.join(siteFolder, 'config.json');
    const readmePath = path.join(siteFolder, 'README.md');

    console.log(chalk.white.bold(`  [${i + 1}/${selected.length}] ${sitePrefix} → ${siteCode}`));

    try {
      // 1. Read config.json
      let configData = {};
      if (fs.existsSync(configPath)) {
        try { configData = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      }
      const siteType = configData.siteType || 'Static';

      // 2. Ensure site exists on platform
      await ensureSiteExists(domain, apiKey, siteCode, siteNameLabel, siteType);

      // 3. Sync README.md → config.json
      if (fs.existsSync(readmePath)) {
        configData.readme = fs.readFileSync(readmePath, 'utf8');
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
      }

      // 4. Patch metadata
      if (configData.variables) await patchSite(domain, apiKey, siteCode, configData.variables, 'variables');
      if (configData.lifecycleHooks) await patchSite(domain, apiKey, siteCode, configData.lifecycleHooks, 'lifecycleHooks');
      if (configData.readme) await patchSite(domain, apiKey, siteCode, configData.readme, 'readme');
      if (configData.git?.repositoryUrl) await patchSite(domain, apiKey, siteCode, { repositoryUrl: configData.git.repositoryUrl }, 'git');

      // 5. Zip public/ and upload package
      console.log(chalk.gray(`    Zipping public/...`));
      await zipSite(publicFolder, distZip);
      const fileStat = fs.statSync(distZip);
      const fileSizeMB = (fileStat.size / (1024 * 1024)).toFixed(2);

      console.log(chalk.gray(`    Uploading package (${fileSizeMB} MB)...`));
      await patchSite(domain, apiKey, siteCode, distZip, 'package');

      // Show deployed URL
      const siteUrl = `https://${domain}/site/${siteCode}/`;
      console.log(chalk.green(`    ✅ synced → ${siteUrl}`));
      success++;
    } catch (err) {
      console.error(chalk.red(`    ❌ ${err.message}`));
      errors++;
    }
  }

  console.log('');
  console.log(chalk.cyan('─'.repeat(45)));
  console.log(chalk.cyan(`📊 Site sync summary for ${domain} [${env}]:`));
  if (success) console.log(chalk.green(`   Synced: ${success}`));
  if (errors) console.log(chalk.red(`   Errors: ${errors}`));
  console.log(chalk.cyan('─'.repeat(45)));
};
