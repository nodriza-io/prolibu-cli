module.exports = async function importScript(flags) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  
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
      message: 'Enter prefix (script name):',
      validate: input => input ? true : 'Prefix is required.'
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
  console.log(`To start development, run:\n  ${chalk.green(`./prolibu script dev --domain ${domain} --prefix ${scriptPrefix} --watch`)}`);
  console.log(`To start production, run:\n  ${chalk.green(`./prolibu script prod --domain ${domain} --prefix ${scriptPrefix} --watch`)}`);
};
