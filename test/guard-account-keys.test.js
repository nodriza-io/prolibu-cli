/* global describe, test, expect */
const { execFileSync } = require('child_process');
const path = require('path');
const { verdict } = require('../.claude/hooks/guard-account-keys');

const HOOK = path.resolve(__dirname, '../.claude/hooks/guard-account-keys.js');

describe('guard-account-keys', () => {
  test.each([
    'cat accounts/dev12.prolibu.com/profile.json',
    'jq -r .apiKey accounts/dev12.prolibu.com/profile.vendedor.json',
    "node -e \"console.log(require('./accounts/dev12.prolibu.com/profile.json').apiKey)\"",
    'KEY=$(jq -r .apiKey < accounts/x/profile.json) && curl -H "Authorization: Bearer $KEY" https://x',
    'cat accounts/dev12.prolibu.com/*.json',
    'head accounts/dev12.prolibu.com/p*',
    'cat accounts/*/profile.json',
    'cd accounts/dev12.prolibu.com && cat profile.json',
    'grep apiKey accounts/dev12.prolibu.com/profile.json',
    "node -e \"const p=require('fs').readFileSync(process.argv[1]);console.log(JSON.parse(p).apiKey)\" x",
  ])('blocks %s', (command) => {
    expect(verdict(command)).toMatch(/Blocked/);
  });

  test.each([
    "node .claude/skills/_shared/prolibu-api.js dev12.prolibu.com GET '/v2/deal?limit=1'",
    'node .claude/skills/prolibu-sites/scripts/site.js preview dev12.prolibu.com x-dev accounts/dev12.prolibu.com/sites/x',
    'node .claude/skills/_shared/ui-review.js dev12.prolibu.com accounts/dev12.prolibu.com/sites/x --profile vendedor',
    'ls accounts/dev12.prolibu.com/*',
    'ls accounts/',
    'grep -rn "profile.json" .claude/skills',
    'grep -rn apiKey .claude/skills/_shared',
    'git status --short',
    'cat accounts/dev12.prolibu.com/sites/x/public/index.html',
    'npx jest test/prolibu-sites.test.js',
  ])('allows %s', (command) => {
    expect(verdict(command)).toBeNull();
  });

  test('exits 2 with the reason on stderr when run as a hook', () => {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat accounts/a/profile.json' } });
    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', [HOOK], { input, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/prolibu-api\.js/);
    const ok = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(() => execFileSync('node', [HOOK], { input: ok })).not.toThrow();
  });
});
