const config = require('../../config/config');

/**
 * Resolves domain and apiKey from flags, prompting interactively if missing.
 */
async function resolveDomainAndKey(flags) {
  const inquirer = await import('inquirer');
  const path = require('path');
  const fs = require('fs');

  let domain = flags.domain;
  let apiKey = flags.apikey;

  if (!domain) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'domain',
      message: 'Enter domain:',
      validate: (v) => (v ? true : 'Domain is required.'),
    });
    domain = r.domain;
  }

  // Try profile.json first
  if (!apiKey) {
    const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
    if (fs.existsSync(profilePath)) {
      try {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        apiKey = profile.apiKey;
      } catch {}
    }
  }

  if (!apiKey) {
    apiKey = config.get('apiKey', domain);
  }

  if (!apiKey) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'apiKey',
      message: `Enter API key for '${domain}':`,
      validate: (v) => (v ? true : 'API key is required.'),
    });
    apiKey = r.apiKey;
    config.set('apiKey', apiKey, domain);
  }

  return { domain, apiKey };
}

module.exports = { resolveDomainAndKey };
