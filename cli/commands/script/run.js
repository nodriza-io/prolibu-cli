module.exports = async function runScript(env, flags, args) {
  const inquirer = await import('inquirer');
  const apiClient = require('../../../api/scriptClient');
  const config = require('../../../config/config');
  
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
      message: 'Enter prefix (script name):',
      validate: input => input ? true : 'Prefix is required.'
    });
    scriptPrefix = response.scriptPrefix;
  }

  const { runPrompts } = require('../../core/prompts');
  await runPrompts(env, scriptPrefix, domain);
  await apiClient.runDevScript(scriptPrefix, env, domain, watchFlag, fileName);
};
