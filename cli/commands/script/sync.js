module.exports = async function syncScripts(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
  const esbuild = require('esbuild');
  const config = require('../../../config/config');
  const { ensureScriptExists, patchScript } = require('../../../api/scriptClient');

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

  const scriptsDir = path.join(process.cwd(), 'accounts', domain, 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    console.error(chalk.red(`❌ No scripts/ folder found for ${domain}.`));
    process.exit(1);
  }

  // List all script folders
  const allScripts = fs.readdirSync(scriptsDir).filter((f) => {
    const full = path.join(scriptsDir, f);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'index.js'));
  });

  if (allScripts.length === 0) {
    console.log(chalk.yellow('No scripts found with an index.js entry point.'));
    return;
  }

  // Ask: all or specific?
  const { syncMode } = await inquirer.default.prompt({
    type: 'list',
    name: 'syncMode',
    message: 'What do you want to sync?',
    choices: [
      { name: `All scripts (${allScripts.length})`, value: 'all' },
      { name: 'Select specific scripts', value: 'select' },
    ],
  });

  let selected = allScripts;

  if (syncMode === 'select') {
    const { chosen } = await inquirer.default.prompt({
      type: 'checkbox',
      name: 'chosen',
      message: 'Select scripts to sync:',
      choices: allScripts,
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

  console.log(chalk.cyan(`\n🔄 Syncing ${selected.length} script(s) to ${domain} [${env}]...\n`));

  let success = 0;
  let errors = 0;

  for (let i = 0; i < selected.length; i++) {
    const scriptPrefix = selected[i];
    const scriptCode = env === 'prod' ? scriptPrefix : `${scriptPrefix}-${env}`;
    const scriptFolder = path.join(scriptsDir, scriptPrefix);
    const codePath = path.join(scriptFolder, 'index.js');
    const configPath = path.join(scriptFolder, 'config.json');
    const settingsPath = path.join(scriptFolder, 'settings.json');
    const readmePath = path.join(scriptFolder, 'README.md');
    const distPath = path.join(scriptFolder, 'dist', 'bundle.js');

    console.log(chalk.white.bold(`  [${i + 1}/${selected.length}] ${scriptPrefix} → ${scriptCode}`));

    try {
      // 1. Ensure script exists on platform
      const scriptData = await ensureScriptExists(domain, apiKey, scriptCode);
      if (!scriptData) {
        console.error(chalk.red(`    ❌ Could not create or verify script '${scriptCode}'`));
        errors++;
        continue;
      }

      // 2. Read config.json
      let configData = {};
      if (fs.existsSync(configPath)) {
        try { configData = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      }

      // 3. Sync README.md → config.json
      if (fs.existsSync(readmePath)) {
        configData.readme = fs.readFileSync(readmePath, 'utf8');
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
      }

      // 4. Read settings.json for build config
      let minifyProductionCode = false;
      let removeComments = false;
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          minifyProductionCode = !!settings.minifyProductionCode;
          removeComments = !!settings.removeComments;
        } catch {}
      }

      // 5. Bundle with esbuild
      fs.mkdirSync(path.dirname(distPath), { recursive: true });
      const buildOptions = {
        entryPoints: [codePath],
        outfile: distPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      };
      if (env === 'prod' && minifyProductionCode) buildOptions.minify = true;
      if (removeComments) {
        buildOptions.minifySyntax = true;
        buildOptions.legalComments = 'none';
      }
      await esbuild.build(buildOptions);
      const bundledCode = fs.readFileSync(distPath, 'utf8');

      // 6. Patch metadata
      if (configData.variables) await patchScript(domain, apiKey, scriptCode, configData.variables, 'variables');
      if (configData.lifecycleHooks) await patchScript(domain, apiKey, scriptCode, configData.lifecycleHooks, 'lifecycleHooks');
      if (configData.readme) await patchScript(domain, apiKey, scriptCode, configData.readme, 'readme');
      if (configData.git?.repositoryUrl) await patchScript(domain, apiKey, scriptCode, { repositoryUrl: configData.git.repositoryUrl }, 'git');

      // 7. Upload code
      await patchScript(domain, apiKey, scriptCode, bundledCode, 'code');

      console.log(chalk.green(`    ✅ synced`));
      success++;
    } catch (err) {
      console.error(chalk.red(`    ❌ ${err.message}`));
      errors++;
    }
  }

  console.log('');
  console.log(chalk.cyan('─'.repeat(45)));
  console.log(chalk.cyan(`📊 Script sync summary for ${domain} [${env}]:`));
  if (success) console.log(chalk.green(`   Synced: ${success}`));
  if (errors) console.log(chalk.red(`   Errors: ${errors}`));
  console.log(chalk.cyan('─'.repeat(45)));
};
