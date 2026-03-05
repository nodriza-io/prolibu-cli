const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_GITIGNORE = `# Secrets
profile.json

# Migration credentials and logs (never commit)
migrations/*/credentials.json
migrations/*/last-run.json

# Build artifacts
dist.zip
node_modules/

# OS files
.DS_Store
*.log
`;

/**
 * Check if a git repository exists in the domain folder
 * @param {string} domainPath - Path to the domain folder (e.g., accounts/dev10.prolibu.com)
 * @returns {boolean}
 */
function hasGitRepo(domainPath) {
  const gitPath = path.join(domainPath, '.git');
  return fs.existsSync(gitPath);
}

/**
 * Initialize a git repository in the domain folder
 * @param {string} domainPath - Path to the domain folder
 * @param {string} remoteUrl - Optional remote URL to add as origin
 */
function initGitRepo(domainPath, remoteUrl = null) {
  try {
    // Initialize git
    execSync('git init', { cwd: domainPath, stdio: 'pipe' });

    // Add remote if provided
    if (remoteUrl) {
      execSync(`git remote add origin ${remoteUrl}`, { cwd: domainPath, stdio: 'pipe' });
    }

    return true;
  } catch (err) {
    console.error(`❌ Failed to initialize git: ${err.message}`);
    return false;
  }
}

/**
 * Create a default .gitignore file in the domain folder
 * @param {string} domainPath - Path to the domain folder
 */
function createGitignore(domainPath) {
  const gitignorePath = path.join(domainPath, '.gitignore');

  // Don't overwrite if exists
  if (fs.existsSync(gitignorePath)) {
    return false;
  }

  fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE);
  return true;
}

/**
 * Ensure git repository exists for a domain, prompt user if not
 * @param {string} domainPath - Path to the domain folder
 * @param {string} domain - Domain name for display
 * @param {boolean} skipGit - If true, skip git initialization entirely
 * @param {string} providedRemoteUrl - Optional remote URL (if provided, won't prompt for it)
 * @returns {Promise<boolean>} - True if git was initialized or already exists
 */
async function ensureDomainGit(domainPath, domain, skipGit = false, providedRemoteUrl = null) {
  // Skip if --no-git flag is set
  if (skipGit) {
    return false;
  }

  // Already has git, nothing to do
  if (hasGitRepo(domainPath)) {
    return true;
  }

  const inquirer = await import('inquirer');
  const chalk = (await import('chalk')).default;

  // If remote URL was already provided, skip prompts and just init
  if (providedRemoteUrl) {
    const success = initGitRepo(domainPath, providedRemoteUrl);
    if (success) {
      console.log(chalk.green(`✓ Git initialized in accounts/${domain}/`));
      console.log(chalk.green(`✓ Remote 'origin' added`));
      if (createGitignore(domainPath)) {
        console.log(chalk.green(`✓ .gitignore created`));
      }
    }
    return success;
  }

  console.log('');
  console.log(chalk.yellow(`⚠️  No git repository found for domain '${domain}'`));

  const { initGit } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'initGit',
    message: 'Initialize git repository for this domain?',
    default: true
  });

  if (!initGit) {
    return false;
  }

  const { remoteUrl } = await inquirer.default.prompt({
    type: 'input',
    name: 'remoteUrl',
    message: 'Remote repository URL (leave empty to skip):',
    default: ''
  });

  // Initialize git
  const success = initGitRepo(domainPath, remoteUrl || null);

  if (success) {
    console.log(chalk.green(`✓ Git initialized in accounts/${domain}/`));

    if (remoteUrl) {
      console.log(chalk.green(`✓ Remote 'origin' added`));
    }

    // Create .gitignore
    if (createGitignore(domainPath)) {
      console.log(chalk.green(`✓ .gitignore created`));
    }
  }

  return success;
}

module.exports = {
  hasGitRepo,
  initGitRepo,
  createGitignore,
  ensureDomainGit,
  DEFAULT_GITIGNORE
};
