#!/usr/bin/env node


const { runPrompts } = require('./cli/prompts');
const { runDevScript, createScript, minifyScript } = require('./cli/commands');
const { parseFlags } = require('./cli/flags');

const argv = process.argv;
const flags = parseFlags(argv);
const args = argv.slice(2);
const command = args[0];




(async () => {
  if (!command) {
    // No command: show help
    console.log('Usage: ./script <dev|prod|create|import|test> [options]');
    console.log('Commands:');
    console.log('  create   Create a new script (interactive or one-liner)');
    console.log('  dev      Run script in dev mode');
    console.log('  prod     Run script in prod mode');
    console.log('  import   Import script from git repo');
    console.log('  test     Run tests for a script');
    console.log('Options for create:');
    console.log('  --domain <domain>');
    console.log('  --scriptPrefix <scriptPrefix>');
    console.log('  --repo <gitRepo>');
    console.log('  --lifecycleHooks <hooks>');
    console.log('  --apikey <apiKey>');
    console.log('Options for dev/prod:');
    console.log('  --domain <domain>');
    console.log('  --scriptPrefix <scriptPrefix>');
    console.log('  --file <fileName>        Entry file name (default: index)');
    console.log('  --watch, -w              Watch for changes and sync');
    console.log('Options for test:');
    console.log('  --domain <domain>');
    console.log('  --scriptPrefix <scriptPrefix>');
    console.log('  --file <testFileName>    Test file name (default: index)');
    console.log('  --watch                  Watch for changes and re-run tests');
    return;
  }

  if (command === 'test') {
    const inquirer = await import('inquirer');
    let domain = flags.domain;
    let scriptPrefix = flags.scriptPrefix;
    let testFileName = flags.file || 'index'; // Default to 'index' if no --file specified
    const watchFlag = typeof flags.watch !== 'undefined' || args.includes('--watch');
    // Interactive prompts for missing values
    if (!domain) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'domain',
        message: 'Enter domain:',
        validate: input => input ? true : 'Domain is required.'
      });
      domain = response.domain;
    }
    if (!scriptPrefix) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'scriptPrefix',
        message: 'Enter script prefix:',
        validate: input => input ? true : 'Script prefix is required.'
      });
      scriptPrefix = response.scriptPrefix;
    }
    const path = require('path');
    const fs = require('fs');
    const testFile = path.join(process.cwd(), 'accounts', domain, scriptPrefix, 'test', `${testFileName}.test.js`);
    if (!fs.existsSync(testFile)) {
      console.error(`[ERROR] Test file not found: ${testFile}`);
      process.exit(1);
    }
    const { execSync } = require('child_process');
    if (watchFlag) {
      const chokidar = require('chokidar');
      console.log(`[WATCH] Watching for changes in ${testFile}...`);
      console.log('[INFO] Press [R] to run the test again.');
      let running = false;
      const runTest = () => {
        if (running) return;
        running = true;
        try {
          execSync(`DOMAIN=${domain} SCRIPT_PREFIX=${scriptPrefix} npx jest ${testFile}`, { stdio: 'inherit' });
        } catch (err) {
          console.error(`[ERROR] Test failed: ${err.message}`);
        }
        running = false;
      };
      runTest();
      const watcher = chokidar.watch(testFile, { persistent: true });
      watcher.on('change', () => {
        console.clear();
        console.log(`[WATCH] Change detected in ${testFile}. Rerunning tests...`);
        runTest();
      });
      // Handle keyboard input for re-running tests
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'r' || key === 'R') {
          console.clear();
          console.log('[MANUAL] Re-running tests...');
          runTest();
        } else if (key === '\u0003') { // Ctrl+C
          console.log('\n[INFO] Stopping test watcher...');
          watcher.close();
          process.exit(0);
        }
      });
      return;
    } else {
      console.log('[INFO] Press [R] to run the test again.');
      
      const runSingleTest = () => {
        try {
          execSync(`DOMAIN=${domain} SCRIPT_PREFIX=${scriptPrefix} npx jest ${testFile}`, { stdio: 'inherit' });
        } catch (err) {
          console.error(`[ERROR] Test failed: ${err.message}`);
        }
      };
      
      runSingleTest();
      
      // Handle keyboard input for re-running tests in non-watch mode
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'r' || key === 'R') {
          console.clear();
          console.log('[MANUAL] Re-running tests...');
          runSingleTest();
        } else if (key === '\u0003') { // Ctrl+C
          console.log('\n[INFO] Exiting...');
          process.exit(0);
        }
      });
      return;
    }
  }
  if (command === 'dev' || command === 'prod') {
    const inquirer = await import('inquirer');
    let domain = flags.domain;
    let scriptPrefix = flags.scriptPrefix;
    let fileName = flags.file || 'index';
    let watchFlag = flags.watch || args.includes('--watch');

    // Interactive prompts for missing values
    if (!domain) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'domain',
        message: 'Enter domain:',
        validate: input => input ? true : 'Domain is required.'
      });
      domain = response.domain;
    }
    if (!scriptPrefix) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'scriptPrefix',
        message: 'Enter script prefix:',
        validate: input => input ? true : 'Script prefix is required.'
      });
      scriptPrefix = response.scriptPrefix;
    }
    await runPrompts(command, scriptPrefix, domain);
    await runDevScript(scriptPrefix, command, domain, watchFlag, fileName);
    return;
  }

  if (command === 'import') {
    const inquirer = await import('inquirer');
    let domain = flags.domain;
    let scriptPrefix = flags.scriptPrefix;
    let gitRepo = flags.repo;

    if (!domain) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'domain',
        message: 'Enter domain:',
        validate: input => input ? true : 'Domain is required.'
      });
      domain = response.domain;
    }
    if (!scriptPrefix) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'scriptPrefix',
        message: 'Enter script prefix:',
        validate: input => input ? true : 'Script prefix is required.'
      });
      scriptPrefix = response.scriptPrefix;
    }
    if (!gitRepo) {
      const response = await inquirer.default.prompt({
        type: 'input',
        name: 'gitRepo',
        message: 'Enter the git repository URL to import:',
        validate: input => input ? true : 'Git repository URL is required.'
      });
      gitRepo = response.gitRepo;
    }
    // Import logic (clone repo only)
    const fs = require('fs');
    const { execSync } = require('child_process');
    const path = require('path');
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
      execSync(`git clone ${gitRepo} ${repoDir}`, { stdio: 'inherit' });
      console.log(`[IMPORT] Repository imported to ${repoDir}`);
    } catch (err) {
      console.error(`[ERROR] Failed to import repository: ${err.message}`);
      process.exit(1);
    }
  const chalk = (await import('chalk')).default;
  console.log('\nNext steps:');
  console.log(`To start development, run:\n  ${chalk.green(`./script dev --domain ${domain} --scriptPrefix ${scriptPrefix} --watch`)}`);
  console.log(`To start production, run:\n  ${chalk.green(`./script prod --domain ${domain} --scriptPrefix ${scriptPrefix} --watch`)}`);
    return;
  }
    const inquirer = await import('inquirer');
  let domain = flags.domain;
  let scriptPrefix = flags.scriptPrefix;
  let repo = flags.repo;
  let lifecycleHooks = flags.lifecycleHooks;
  let apiKey = flags.apikey;

    // Interactive mode if any required flag is missing
    const fs = require('fs');
    const path = require('path');
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
    // 2. apiKey (always ensure config.json is created/updated)
  let profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
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
        message: 'Enter script prefix:',
        validate: input => input ? true : 'Script prefix is required.'
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
    const { execSync } = require('child_process');
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
      
      // Copy all files and folders from templates directory
      const templateDir = path.join(process.cwd(), 'templates');
      if (fs.existsSync(templateDir)) {
        fs.readdirSync(templateDir).forEach(item => {
          const src = path.join(templateDir, item);
          const dest = path.join(repoDir, item);
          const stat = fs.statSync(src);
          
          if (stat.isDirectory()) {
            // Copy directory recursively
            fs.cpSync(src, dest, { recursive: true });
          } else {
            // Copy file
            fs.copyFileSync(src, dest);
          }
        });
      }
      console.log(`[INIT] Script structure initialized from templates in ${repoDir}`);
    } catch (err) {
      console.error(`[ERROR] Failed to clone repository: ${err.message}`);
      process.exit(1);
    }
    // Write lifecycleHooks.json
    if (hooksArr.length) {
      const hooksPath = path.join(repoDir, 'lifecycleHooks.json');
      fs.writeFileSync(hooksPath, JSON.stringify(hooksArr, null, 2));
      console.log(`[INFO] lifecycleHooks.json created: ${JSON.stringify(hooksArr)}`);
    }
    // Pass git.repositoryUrl to createScript
    await createScript(scriptPrefix, 'dev', domain, repo, 'index');
    await createScript(scriptPrefix, 'prod', domain, repo, 'index');
  const chalk = (await import('chalk')).default;
  console.log(`Scripts '${scriptPrefix}-dev' and '${scriptPrefix}-prod' created for domain '${domain}'.`);
  console.log('\nNext steps:');
  console.log(`To start development, run:\n  ${chalk.green(`./script dev --domain ${domain} --scriptPrefix ${scriptPrefix} --watch`)}`);
  console.log(`To start production, run:\n  ${chalk.green(`./script prod --domain ${domain} --scriptPrefix ${scriptPrefix} --watch`)}`);
})();
