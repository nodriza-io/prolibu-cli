module.exports = async function runSite(env, flags, args) {
  const inquirer = await import('inquirer');
  const siteClient = require('../../../api/siteClient');
  const config = require('../../../config/config');
  
  let domain = flags.domain;
  let sitePrefix = flags.sitePrefix;
  let watchFlag = flags.watch || args.includes('--watch');
  let port = parseInt(flags.port) || 3030;
  let extensions = flags.ext || 'html,css,js';

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

  if (!sitePrefix) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'sitePrefix',
      message: 'Enter prefix (site name):',
      validate: input => input ? true : 'Prefix is required.'
    });
    sitePrefix = response.sitePrefix;
  }

  // Check for apiKey in profile, prompt if missing
  let apiKey = config.get('apiKey', domain);
  if (!apiKey) {
    const response = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: `Enter API key for domain '${domain}':`,
      validate: input => input ? true : 'API key is required.'
    });
    apiKey = response.apiKey;
    config.set('apiKey', apiKey, domain);
  }

  await siteClient.runDevSite(sitePrefix, env, domain, apiKey, watchFlag, port, extensions);
};
