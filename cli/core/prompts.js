const config = require('../../config/config');

// Prompts for domain, apiKey, and scriptName (prefix)
async function runPrompts(env, scriptName, domain) {
  const inquirer = await import('inquirer');
  // Use provided domain, prompt only if missing
  // Only prompt for apiKey if missing
  let apiKey = config.get('apiKey', domain);
  if (!apiKey) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: 'API Key:',
    });
    apiKey = response.apiKey;
    config.set('apiKey', apiKey, domain);
  }
  // Prompt for lifecycleHooks only during create and gitRepo
  if (env === 'create') {
    const inquirer = await import('inquirer');
    const { lifecycleHooks } = await inquirer.default.prompt({
      type: 'input',
      name: 'lifecycleHooks',
      message: 'Add lifecycleHooks? (comma separated, e.g. Company,Contact,Deal)',
      default: '',
    });
     if (lifecycleHooks && lifecycleHooks.trim()) {
       const hooksArr = lifecycleHooks.split(',').map(h => h.trim()).filter(Boolean);
       const fs = require('fs');
       const path = require('path');
       const codePath = require('../config/config').getScriptCodePath(domain, scriptName);
       const hooksPath = codePath.replace('code.js', 'lifecycleHooks.json');
       const scriptDir = path.dirname(codePath);
       fs.mkdirSync(scriptDir, { recursive: true });
       fs.writeFileSync(hooksPath, JSON.stringify(hooksArr, null, 2));
       console.log(`[INFO] lifecycleHooks.json created: ${JSON.stringify(hooksArr)}`);
     }
    const { gitRepo } = await inquirer.default.prompt({
      type: 'input',
      name: 'gitRepo',
      message: 'Enter the git repository URL to clone:',
      validate: input => input ? true : 'Git repository URL is required.'
    });
    return { domain, apiKey, gitRepo };
  }
  return { domain, apiKey };
}

module.exports = { runPrompts };
