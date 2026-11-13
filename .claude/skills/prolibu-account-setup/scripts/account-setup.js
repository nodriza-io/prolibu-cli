#!/usr/bin/env node
'use strict';

// Connects this CLI to a Prolibu account without the API key ever leaving its file.
// Nothing here writes to an account. `init` only creates an empty local profile file and
// keeps it out of git; every other command reads.
//
//   account-setup.js list                                   local accounts, key files, git safety
//   account-setup.js init  <domain> [--profile <name>]      empty profile file, git-ignored
//   account-setup.js check <domain> [--profile <name>]      key works? who, admin, switches, skills
//   account-setup.js mcp   <domain> [--profile <name>]      the `claude mcp add` command (no key in it)
//
// Output is JSON. Exit codes: 0 ok, 1 API error or key refused, 2 usage error (nothing sent),
// 3 blocked (nothing written).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  createClient, UsageError, DEFAULT_ROOT, isLikelyProduction,
} = require('../../_shared/prolibu-api');

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const PROFILE_RE = /^[a-z0-9-]+$/;
const PROFILE_FILE_RE = /^profile(\.[a-z0-9-]+)?\.json$/;
const IGNORE_LINE = 'profile*.json';
const BLOCKED = 3;

class Blocked extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

// What each skill needs from the key, as `Model.action` permissions (the names of
// /v2/permission/library without "Resource@"), and the account switch it depends on.
// An admin key without scopes has every permission; switches apply to everyone.
const SKILL_NEEDS = [
  { skill: 'prolibu-sites', needs: ['Site.create', 'Site.update'] },
  { skill: 'prolibu-scripts', needs: ['Script.create', 'Script.update', 'Script.run'] },
  { skill: 'prolibu-endpoints', needs: ['Endpoint.create', 'Endpoint.update', 'Script.update'] },
  { skill: 'prolibu-forms', needs: ['Form.create', 'Form.update'] },
  { skill: 'prolibu-webhooks', needs: ['Webhook.create', 'Webhook.update'], switch: 'webhooks' },
  { skill: 'prolibu-custom-fields', needs: ['CustomField.create', 'CustomField.update'] },
  { skill: 'prolibu-quotes', needs: ['Deal.update', 'Quote.calculate', 'Quote.formatLineItem', 'Quote.productSearch'] },
  { skill: 'prolibu-extended-quote-sites', needs: ['Site.create', 'Site.update'] },
  { skill: 'prolibu-stages', needs: ['Stage.find', 'Deal.update'] },
  { skill: 'prolibu-dashboards', needs: ['Report.create', 'Report.update', 'Dashboard.create', 'Dashboard.update'], switch: 'mcp' },
  { skill: 'mcp-server (Prolibu tools inside Claude)', needs: [], switch: 'mcp' },
];

const SWITCH_LABELS = {
  mcp: 'Preferences › Integrations › MCP',
  webhooks: 'Preferences › Integrations › Webhooks',
  lifecycleHooks: 'Preferences › Integrations › Lifecycle hooks',
  oauthServer: 'Preferences › Security › OAuth server',
};

function assertDomain(domain) {
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) {
    throw new UsageError('Invalid domain. Expected something like example.prolibu.com.');
  }
}

function profileFileName(profile) {
  if (profile === undefined || profile === null) return 'profile.json';
  if (!PROFILE_RE.test(profile)) throw new UsageError('Invalid profile name. Use lowercase letters, digits and hyphens.');
  return `profile.${profile}.json`;
}

// Says whether a profile file holds a key, without ever returning it.
function keyState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const key = JSON.parse(text).apiKey;
    return typeof key === 'string' && key.trim() ? 'set' : 'empty';
  } catch {
    return 'not valid JSON';
  }
}

function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function git(dir, args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

// A remote URL can carry a token (https://user:token@host/…): keep only the host and path.
function safeRemote(url) {
  return url ? url.replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1***@') : null;
}

// Git state of an account folder that is its own repository (`./prolibu account import`).
// `exposed` = committed (then `account push` refuses) or a plain `git add .` would publish it.
function accountGit(dir, files) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(dir, ['status', '--porcelain']);
  const profiles = files.map((file) => {
    const tracked = git(dir, ['ls-files', '--error-unmatch', '--', file]).ok;
    const ignored = git(dir, ['check-ignore', '-q', '--', file]).ok;
    return { file, tracked, ignored, exposed: tracked || !ignored };
  });
  return {
    remote: remote.ok ? safeRemote(remote.out) : null,
    branch: branch.ok ? branch.out : null,
    uncommittedChanges: status.ok ? status.out.split('\n').filter(Boolean).length : null,
    profiles,
  };
}

function profileFilesIn(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => PROFILE_FILE_RE.test(name)).sort();
  } catch {
    return [];
  }
}

function describeAccount(rootDir, domain) {
  const dir = path.join(rootDir, 'accounts', domain);
  const validDomain = DOMAIN_RE.test(domain);
  const files = profileFilesIn(dir);
  const gitState = accountGit(dir, files);
  const warnings = [];
  const profiles = files.map((file) => {
    const full = path.join(dir, file);
    const mode = fileMode(full);
    const state = keyState(full);
    if (state === 'empty') warnings.push(`${file} has no key yet: the user pastes it in accounts/${domain}/${file}.`);
    if (state === 'not valid JSON') warnings.push(`${file} is not valid JSON: it must be {"apiKey": "…"}.`);
    if (mode !== null && (mode & 0o077)) warnings.push(`${file} can be read by other users of this computer (chmod 600 fixes it).`);
    const match = /^profile\.([a-z0-9-]+)\.json$/.exec(file);
    return {
      file, profile: match ? match[1] : null, key: state, mode: mode === null ? null : `0${mode.toString(8)}`,
    };
  });
  if (!validDomain) warnings.push('The folder name is not a domain: the CLI and the skills cannot use it.');
  if (validDomain && !files.length) warnings.push(`No profile file: run init ${domain}.`);
  if (gitState) {
    for (const p of gitState.profiles) {
      if (p.tracked) warnings.push(`${p.file} is committed in this account's repository: the key is in its history. Revoke that key in the app and create a new one.`);
      else if (!p.ignored) warnings.push(`${p.file} is not git-ignored in this account's repository: ./prolibu account push would publish the key. Run init ${domain} to fix it.`);
    }
  }
  return {
    domain,
    production: validDomain ? isLikelyProduction(domain) : null,
    profiles,
    git: gitState,
    warnings,
  };
}

function cmdList(ctx) {
  const accountsDir = path.join(ctx.rootDir, 'accounts');
  let entries = [];
  try {
    entries = fs.readdirSync(accountsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    // No accounts folder yet.
  }
  const accounts = entries.map((domain) => describeAccount(ctx.rootDir, domain));
  const repoCheck = git(ctx.rootDir, ['check-ignore', '-q', '--', 'accounts/example.prolibu.com/profile.json']);
  const isRepo = git(ctx.rootDir, ['rev-parse', '--is-inside-work-tree']).ok;
  return {
    accounts,
    cliRepoIgnoresAccounts: isRepo ? repoCheck.ok : null,
    nextStep: accounts.length
      ? 'Tell the user which accounts exist and fix every warning before using one. Check a key with: check <domain>.'
      : 'No accounts yet. Ask for the domain, then run init <domain> (or ./prolibu account import when the account has a repository).',
  };
}

// Makes sure the account's own repository (if any) ignores profile files. Appends one line;
// never rewrites the file.
function ensureIgnored(dir, file) {
  const before = accountGit(dir, [file]);
  if (!before) return { gitignore: 'not a git repository', tracked: false };
  const [state] = before.profiles;
  if (state.tracked) return { gitignore: 'tracked', tracked: true };
  if (state.ignored) return { gitignore: 'already ignored', tracked: false };
  const ignorePath = path.join(dir, '.gitignore');
  let current = '';
  try {
    current = fs.readFileSync(ignorePath, 'utf8');
  } catch {
    // Created below.
  }
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(ignorePath, `${current}${prefix}# API keys of this CLI, never committed\n${IGNORE_LINE}\n`);
  const after = accountGit(dir, [file]).profiles[0];
  return { gitignore: after.ignored ? `added ${IGNORE_LINE} to .gitignore` : 'could not ignore it', tracked: false };
}

function cmdInit(ctx, domain, flags) {
  assertDomain(domain);
  const fileName = profileFileName(flags.profile);
  const dir = path.join(ctx.rootDir, 'accounts', domain);
  const file = path.join(dir, fileName);
  const rel = `accounts/${domain}/${fileName}`;
  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ apiKey: '' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    created = true;
  }
  const ignore = ensureIgnored(dir, fileName);
  const state = keyState(file);
  const result = {
    domain,
    file: rel,
    created,
    key: state,
    gitignore: ignore.gitignore,
    production: isLikelyProduction(domain),
  };
  if (ignore.tracked) {
    throw new Blocked(`${rel} is committed in the account's repository: the key is in its history. Revoke that key in the app, create a new one, and remove the file from the repository (git rm --cached) before pasting the new key.`, result);
  }
  if (ignore.gitignore === 'could not ignore it') {
    throw new Blocked(`${rel} is still not git-ignored in the account's repository. Do not paste a key until it is.`, result);
  }
  result.nextStep = state === 'set'
    ? `The file already has a key. Run check ${domain}${flags.profile ? ` --profile ${flags.profile}` : ''}.`
    : `Ask the user to open ${rel} in their editor, paste the key between the quotes of "apiKey", and save. Never ask them to paste it in the chat or on a command line. Then run check ${domain}${flags.profile ? ` --profile ${flags.profile}` : ''}.`;
  return result;
}

async function get(client, reqPath) {
  const res = await client.request('GET', reqPath);
  return res;
}

function errorText(body) {
  if (body && typeof body === 'object') return body.error || body.message || null;
  return typeof body === 'string' ? body.slice(0, 200) : null;
}

function readSwitches(prefs) {
  if (!prefs) return null;
  const integ = prefs.integrations || {};
  const sec = prefs.security || {};
  const flag = (v) => (v === true ? 'on' : 'off');
  const hooks = integ.lifecycleHooks || {};
  return {
    mcp: flag(integ.mcp && integ.mcp.enabled),
    webhooks: flag(integ.webhooks && integ.webhooks.enabled),
    lifecycleHooks: flag(hooks.enabled),
    lifecycleHooksObjects: Array.isArray(hooks.enabledEntities) ? hooks.enabledEntities : [],
    oauthServer: flag(sec.oauthServer && sec.oauthServer.enabled),
  };
}

function covers(held, permission) {
  if (held.has(permission) || held.has('*.*')) return true;
  return held.has(`${permission.split('.')[0]}.*`);
}

// access: 'admin' (every permission), 'admin-scoped' (an admin's key locked to its scopes:
// admin-only actions are refused), 'roles' (a non-admin: the key's permissions).
function accessOf(me) {
  const scopes = Array.isArray(me.permissions) ? me.permissions : [];
  const isAdmin = Boolean(me.profile && me.profile.isAdmin === true);
  if (isAdmin && !scopes.length) return { access: 'admin', scopes };
  return { access: isAdmin ? 'admin-scoped' : 'roles', scopes };
}

function skillReadiness(access, scopes, switches) {
  const held = new Set(scopes.filter((s) => s.startsWith('Resource@')).map((s) => s.slice('Resource@'.length)));
  return SKILL_NEEDS.map(({ skill, needs, switch: sw }) => {
    const missing = access === 'admin' ? [] : needs.filter((p) => !covers(held, p));
    const switchState = sw ? (switches ? switches[sw] : 'unknown') : null;
    let status = 'ready';
    if (missing.length) status = 'missing permissions';
    else if (switchState === 'off') status = 'switch off';
    else if (switchState === 'unknown') status = 'switch unknown';
    const row = { skill, status };
    if (missing.length) row.missing = missing.map((p) => `Resource@${p}`);
    if (sw) row.switch = `${SWITCH_LABELS[sw]}: ${switchState}`;
    return row;
  });
}

// Write permissions grouped by object, for a key that is not a full admin.
function writePermissions(scopes) {
  const byModel = {};
  for (const s of scopes) {
    const m = /^Resource@([^.]+)\.(.+)$/.exec(s);
    if (!m) continue;
    const [, model, action] = m;
    if (!['create', 'update', 'delete', '*'].includes(action)) continue;
    (byModel[model] = byModel[model] || []).push(action);
  }
  return byModel;
}

async function cmdCheck(client) {
  const { domain } = client;
  const meRes = await get(client, '/v2/user/me');
  if (meRes.status === 401) {
    return {
      exitCode: 1,
      result: {
        domain,
        keyWorks: false,
        status: 401,
        serverSays: errorText(meRes.body),
        nextStep: 'The account refused the key: it is wrong or incomplete, expired, revoked, or its user is not active. Ask the user to create a new key in the app (avatar menu › Security › API Keys) and paste it in the profile file, then check again.',
      },
    };
  }
  if (!meRes.ok && meRes.status !== 403) {
    return {
      exitCode: 1,
      result: {
        domain, keyWorks: null, status: meRes.status, serverSays: errorText(meRes.body),
        nextStep: 'The account did not answer normally. Check the domain, then try again later.',
      },
    };
  }
  const prefsRes = await get(client, '/v2/user/preferences');
  const switches = prefsRes.ok ? readSwitches(prefsRes.body) : null;
  const production = isLikelyProduction(domain);

  if (meRes.status === 403) {
    return {
      exitCode: 0,
      result: {
        domain,
        production,
        keyWorks: true,
        access: 'limited',
        note: 'The key is valid but its scopes do not include reading its own user (Resource@User.me), so its permissions cannot be listed here.',
        switches,
        nextStep: 'Tell the user the key works but is narrowly scoped; skills will refuse what it lacks (403).',
      },
    };
  }

  const me = meRes.body || {};
  const p = me.profile || {};
  const { access, scopes } = accessOf(me);
  const roles = Array.isArray(p.roles) ? p.roles.map((r) => (r && typeof r === 'object' ? r.roleName || r._id : r)) : [];
  const locale = p.locale || {};
  const result = {
    domain,
    production,
    keyWorks: true,
    user: {
      _id: p._id,
      name: [p.firstName, p.lastName].filter(Boolean).join(' '),
      email: p.email,
      status: p.status,
      roles,
      language: locale.language || null,
      currency: locale.currency || null,
      timeZone: locale.timeZone || null,
    },
    isAdmin: p.isAdmin === true,
    access,
    switches,
    skills: skillReadiness(access, scopes, switches),
  };
  if (access !== 'admin') result.writePermissions = writePermissions(scopes);
  if (!switches) result.switchesNote = 'This key cannot read the account settings (Resource@User.preferences).';
  const notes = [];
  if (access === 'admin-scoped') notes.push('The user is an admin, but this key is limited to its scopes: admin-only actions are refused.');
  if (access === 'roles') notes.push('This key carries the permissions its user had when the key was created. If the user\'s roles changed later, the key did not follow: create a new key.');
  if (production) notes.push('The domain looks like production: every write needs a production warning and its own yes.');
  result.notes = notes;
  result.nextStep = 'Tell the user who the key acts as, whether it is admin, which switches are off and which skills will refuse work. Never change a switch: an admin does it in the app.';
  return { exitCode: 0, result };
}

function serverName(domain, profile) {
  const label = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return profile ? `prolibu-${label}-${profile}` : `prolibu-${label}`;
}

async function cmdMcp(client, flags, ctx) {
  const { domain } = client;
  const fileName = profileFileName(flags.profile);
  const meRes = await get(client, '/v2/user/me');
  if (meRes.status === 401) {
    throw new Blocked('The account refused the key (401). Fix the key first: run check.', { domain, keyWorks: false });
  }
  const prefsRes = await get(client, '/v2/user/preferences');
  const switches = prefsRes.ok ? readSwitches(prefsRes.body) : null;
  const metaRes = await get(client, '/v2/mcpsession/metadata');
  const meta = metaRes.ok && metaRes.body && typeof metaRes.body === 'object' ? metaRes.body : {};
  const fallback = `https://${domain}/v2/mcpsession/ses`;
  const endpoint = typeof meta.endpoint === 'string' && /^https:\/\/[^\s"'`$\\]+$/.test(meta.endpoint) ? meta.endpoint : fallback;
  const name = serverName(domain, flags.profile);
  const keyPath = `./accounts/${domain}/${fileName}`;
  const command = `cd '${ctx.rootDir.replace(/'/g, "'\\''")}' && k=$(node -p 'require("${keyPath}").apiKey') && claude mcp add --transport http --scope local ${name} ${endpoint} --header "Authorization: Bearer $k"; unset k`;
  const result = {
    domain,
    production: isLikelyProduction(domain),
    mcpSwitch: switches ? switches.mcp : 'unknown',
    endpoint,
    serverName: name,
    tools: Array.isArray(meta.tools) ? meta.tools.map((t) => t && t.name).filter(Boolean) : undefined,
    command,
    keepsKeyOut: `The command reads the key from ${keyPath} inside the shell: the key is not on the command line, in the shell history or in this chat. Claude Code stores it in its own user config (outside the repo).`,
  };
  if (switches && switches.mcp === 'off') {
    throw new Blocked(`The MCP server is off on ${domain}. An admin turns it on in the app (${SWITCH_LABELS.mcp}). Never change it from here.`, result);
  }
  result.nextStep = 'Show the user the command. Do not run it yourself: the user runs it (in Claude Code, type ! and paste it). Then: claude mcp list (never claude mcp get: it prints the key) and /mcp in a new session.';
  return result;
}

function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') {
      if (i + 1 >= argv.length) throw new UsageError('Missing value for --profile.');
      i += 1;
      flags.profile = argv[i];
      profileFileName(flags.profile);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const USAGE = 'Usage: account-setup.js <list | init <domain> | check <domain> | mcp <domain>> [--profile <name>]';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  const print = (result) => stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    if (rest.length) throw new UsageError(USAGE);
    const ctx = { rootDir };
    if (command === 'list') {
      if (domain) throw new UsageError(USAGE);
      print(cmdList(ctx));
      return 0;
    }
    if (!['init', 'check', 'mcp'].includes(command) || !domain) throw new UsageError(USAGE);
    assertDomain(domain);
    if (command === 'init') {
      print(cmdInit(ctx, domain, flags));
      return 0;
    }
    const fileName = profileFileName(flags.profile);
    const state = keyState(path.join(rootDir, 'accounts', domain, fileName));
    if (state !== 'set') {
      throw new UsageError(state === 'missing'
        ? `No accounts/${domain}/${fileName}. Run init ${domain}${flags.profile ? ` --profile ${flags.profile}` : ''} first.`
        : `accounts/${domain}/${fileName} has no usable key (${state}). Ask the user to paste it in that file.`);
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    if (command === 'check') {
      const { exitCode, result } = await cmdCheck(client);
      print(result);
      return exitCode;
    }
    print(await cmdMcp(client, flags, ctx));
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      if (err.result) print(err.result);
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, keyState, safeRemote, accessOf, skillReadiness, serverName, readSwitches, SKILL_NEEDS,
};
