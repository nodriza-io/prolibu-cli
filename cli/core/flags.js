// Parse CLI flags for Prolibu CLI
const minimist = require('minimist');

function parseFlags(argv) {
  // Remove node and script path
  const args = argv.slice(2);
  const parsed = minimist(args, {
    string: [
      'domain',
      'prefix',
      'scriptPrefix',  // backward compatibility
      'sitePrefix',    // backward compatibility
      'repo',
      'lifecycleHooks',
      'apikey',
      'file',
      'siteType',
      'port',
      'ext',
      'message'
    ],
    boolean: [
      'watch',
      'run',
      'no-git'
    ],
    alias: {
      domain: 'd',
      prefix: 'p',
      scriptPrefix: 's',  // backward compatibility
      repo: 'r',
      lifecycleHooks: 'l',
      apikey: 'a',
      file: 'f',
      watch: 'w',
      message: 'm',
      'no-git': 'G'
    },
    default: {}
  });
  
  // Normalize: if --prefix is provided, use it; otherwise fall back to --scriptPrefix or --sitePrefix
  if (parsed.prefix) {
    parsed.scriptPrefix = parsed.prefix;
    parsed.sitePrefix = parsed.prefix;
  } else if (parsed.scriptPrefix) {
    parsed.prefix = parsed.scriptPrefix;
  } else if (parsed.sitePrefix) {
    parsed.prefix = parsed.sitePrefix;
  }
  
  // Normalize --no-git to noGit
  parsed.noGit = parsed['no-git'] || false;
  
  return parsed;
}

module.exports = { parseFlags };
