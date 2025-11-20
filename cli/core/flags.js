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
      'ext'
    ],
    boolean: [
      'watch',
      'run'
    ],
    alias: {
      domain: 'd',
      prefix: 'p',
      scriptPrefix: 's',  // backward compatibility
      repo: 'r',
      lifecycleHooks: 'l',
      apikey: 'a',
      file: 'f',
      watch: 'w'
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
  
  return parsed;
}

module.exports = { parseFlags };
