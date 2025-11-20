module.exports = async function testScript(flags, args) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  
  let domain = flags.domain;
  let scriptPrefix = flags.scriptPrefix;
  let testFileName = flags.file || 'index';
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
      message: 'Enter prefix (script name):',
      validate: input => input ? true : 'Prefix is required.'
    });
    scriptPrefix = response.scriptPrefix;
  }

  const testFile = path.join(process.cwd(), 'accounts', domain, scriptPrefix, 'test', `${testFileName}.test.js`);
  
  if (!fs.existsSync(testFile)) {
    console.error(`[ERROR] Test file not found: ${testFile}`);
    process.exit(1);
  }

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
  }
};
