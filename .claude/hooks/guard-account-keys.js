#!/usr/bin/env node
// PreToolUse guard for Bash: keeps agents from reading an account's API key by hand.
// accounts/<domain>/profile*.json holds the key. The repo's scripts (prolibu-api.js,
// site.js, ui-review.js…) read it themselves and never print it, so a command that names
// a profile file, globs the account folder or pulls `apiKey` out with inline code is
// refused with a pointer to the right script. Exit 2 = blocked (stderr goes to the agent).

const REASON =
  'Blocked: account API keys live in accounts/<domain>/profile*.json and are never read, ' +
  'copied or printed by hand (not with cat, node -e, jq, curl or a shell variable). ' +
  "Use the repo's scripts, which read the key themselves: " +
  "node .claude/skills/_shared/prolibu-api.js <domain> GET '/v2/...' for API calls, " +
  'or the skill script for the task (site.js, ui-review.js…).';

// A search in the repo's code for the word is fine; one aimed at accounts/ is not.
const SEARCH = /^\s*(grep|rg|git)\b/;

// Steps that only ask whether a file exists, or list a folder, never read it. They are
// dropped before the checks, as long as nothing is piped out of them.
const EXISTENCE_ONLY = /^\s*(test\s+-[efs]\s+\S+|\[\[?\s+-[efs]\s+\S+\s+\]\]?|ls\b[^|<>`$]*)\s*$/;

function dropExistenceChecks(command) {
  return command.split(/&&|\|\||;/).filter((step) => !EXISTENCE_ONLY.test(step)).join(' ; ');
}

function verdict(original) {
  if (typeof original !== 'string' || !original) return null;
  const command = dropExistenceChecks(original);
  if (!command.trim()) return null;
  const touchesAccounts = /(^|[\s'"=/])accounts\//.test(command) || /\bcd\s+[^;&|]*accounts\b/.test(command);
  const isRepoSearch = SEARCH.test(command) && !touchesAccounts;

  // 1. Names a profile file: profile.json, profile.vendedor.json, "profile*.json"…
  if (!isRepoSearch && /profile[\w.*?-]*\.json/i.test(command)) return REASON;

  // 2. Globs the root of an account folder (accounts/x/*, accounts/x/p*), where the profiles are.
  //    Listing it is harmless; reading through a glob is not.
  if (!/^\s*ls\b/.test(command) && /accounts\/[^\s/'"]*\/[^\s/'"]*[*?[]/.test(command)) return REASON;
  if (/accounts\/[*?[]/.test(command) && !/^\s*ls\b/.test(command)) return REASON;

  // 3. Pulls apiKey out with inline code or jq.
  if (/apiKey/.test(command) && !isRepoSearch &&
      /(\b(node|python3?|ruby|perl|deno|bun)\s+(-\w*[epc]\b|<<)|\bjq\b|\bsed\b|\bawk\b|\$\(|`)/.test(command)) {
    return REASON;
  }
  return null;
}

module.exports = { verdict };

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let command;
    try {
      command = JSON.parse(input).tool_input.command;
    } catch {
      process.exit(0); // not a Bash payload we understand: let the normal permission flow decide
    }
    const reason = verdict(command);
    if (reason) {
      process.stderr.write(reason + '\n');
      process.exit(2);
    }
    process.exit(0);
  });
}
