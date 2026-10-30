/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const setup = require('../.claude/skills/prolibu-account-setup/scripts/account-setup');

const D = 'dev99.example.com';
const KEY = 'qa-skills-secret-key-1234567890';

let rootDir;
let out;
let err;
let calls;
let server;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

// Fake of the three reads the script makes, shaped after the verified server answers:
// /v2/user/me → {profile, permissions, …}; /v2/user/preferences → public settings;
// /v2/mcpsession/metadata → public discovery document.
async function fakeFetch(url, init) {
  const u = new URL(url);
  calls.push({ method: init.method, path: u.pathname, auth: init.headers.Authorization });
  if (u.pathname === '/v2/user/me') return respond(server.me.status, server.me.body);
  if (u.pathname === '/v2/user/preferences') return respond(server.prefs.status, server.prefs.body);
  if (u.pathname === '/v2/mcpsession/metadata') {
    return respond(200, { endpoint: `https://${D}/v2/mcpsession/ses`, tools: [{ name: 'find' }, { name: 'getMyProfile' }] });
  }
  return respond(404, { statusCode: 404, error: 'not found' });
}

async function run(...argv) {
  out = '';
  err = '';
  const code = await setup.main(argv, {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } },
  });
  return code;
}

const json = () => JSON.parse(out);

function writeProfile(domain, content, file = 'profile.json', mode = 0o600) {
  const dir = path.join(rootDir, 'accounts', domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content, { mode });
  fs.chmodSync(path.join(dir, file), mode);
  return dir;
}

function gitIn(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=QA Skills', '-c', 'user.email=qa-skills@example.com', '-C', dir, ...args], { stdio: 'pipe' }).toString();
}

function initRepo(dir, gitignore) {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q');
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
}

const adminMe = { status: 200, body: { profile: { _id: 'u1', firstName: 'Ana', lastName: 'QA', email: 'qa-skills@example.com', status: 'Active', isAdmin: true, roles: [], locale: { language: 'es', currency: 'USD' } }, permissions: [] } };
const prefsOn = { status: 200, body: { integrations: { mcp: { enabled: true }, webhooks: { enabled: true }, lifecycleHooks: { enabled: true, enabledEntities: ['Contact'] } }, security: { oauthServer: { enabled: false } } } };

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-setup-'));
  calls = [];
  server = { me: adminMe, prefs: prefsOn };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('init', () => {
  test('creates an empty profile file only the owner can read', async () => {
    expect(await run('init', D)).toBe(0);
    const file = path.join(rootDir, 'accounts', D, 'profile.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ apiKey: '' });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(json()).toMatchObject({ created: true, key: 'empty', gitignore: 'not a git repository' });
    expect(calls).toHaveLength(0);
  });

  test('never overwrites a profile that already has a key', async () => {
    writeProfile(D, JSON.stringify({ apiKey: KEY }));
    expect(await run('init', D)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), 'utf8')).apiKey).toBe(KEY);
    expect(json()).toMatchObject({ created: false, key: 'set' });
    expect(out).not.toContain(KEY);
  });

  test('--profile <name> makes profile.<name>.json', async () => {
    expect(await run('init', D, '--profile', 'sales-rep')).toBe(0);
    expect(fs.existsSync(path.join(rootDir, 'accounts', D, 'profile.sales-rep.json'))).toBe(true);
  });

  test('git-ignores profile files in an account repository whose .gitignore lacks them, once', async () => {
    const dir = path.join(rootDir, 'accounts', D);
    initRepo(dir, 'node_modules/\n');
    expect(await run('init', D, '--profile', 'qa')).toBe(0);
    expect(json().gitignore).toBe('added profile*.json to .gitignore');
    expect(gitIn(dir, 'check-ignore', 'profile.qa.json').trim()).toBe('profile.qa.json');
    expect(gitIn(dir, 'check-ignore', 'profile.json').trim()).toBe('profile.json');
    expect(await run('init', D)).toBe(0);
    expect(json().gitignore).toBe('already ignored');
    const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').filter((l) => l === 'profile*.json');
    expect(lines).toHaveLength(1);
  });

  test('blocks when the profile file is already committed', async () => {
    const dir = path.join(rootDir, 'accounts', D);
    initRepo(dir);
    writeProfile(D, JSON.stringify({ apiKey: KEY }));
    gitIn(dir, 'add', 'profile.json');
    gitIn(dir, 'commit', '-qm', 'oops');
    expect(await run('init', D)).toBe(3);
    expect(err).toMatch(/committed.*Revoke/s);
    expect(out + err).not.toContain(KEY);
  });

  test('rejects a domain that is not a domain, and writes nothing', async () => {
    expect(await run('init', '../evil')).toBe(2);
    expect(fs.existsSync(path.join(rootDir, 'accounts'))).toBe(false);
  });
});

describe('list', () => {
  test('reports key state without the key, and every exposure', async () => {
    writeProfile(D, JSON.stringify({ apiKey: KEY }));
    writeProfile('dev98.example.com', JSON.stringify({ apiKey: '' }), 'profile.json', 0o644);
    const repo = path.join(rootDir, 'accounts', 'acme.example.com');
    initRepo(repo, 'profile.json\n');
    gitIn(repo, 'remote', 'add', 'origin', 'https://bot:tokentoken@git.example.com/org/acme.git');
    writeProfile('acme.example.com', JSON.stringify({ apiKey: KEY }));
    writeProfile('acme.example.com', JSON.stringify({ apiKey: KEY }), 'profile.qa.json');

    expect(await run('list')).toBe(0);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('tokentoken');
    const byDomain = Object.fromEntries(json().accounts.map((a) => [a.domain, a]));
    expect(byDomain[D].profiles[0]).toMatchObject({ file: 'profile.json', key: 'set', mode: '0600' });
    expect(byDomain[D].production).toBe(false);
    expect(byDomain['acme.example.com'].production).toBe(true);
    expect(byDomain['dev98.example.com'].warnings.join(' ')).toMatch(/no key yet/);
    expect(byDomain['dev98.example.com'].warnings.join(' ')).toMatch(/other users/);
    const acme = byDomain['acme.example.com'];
    expect(acme.git.remote).toBe('https://***@git.example.com/org/acme.git');
    expect(acme.git.profiles.find((p) => p.file === 'profile.json').exposed).toBe(false);
    expect(acme.git.profiles.find((p) => p.file === 'profile.qa.json').exposed).toBe(true);
    expect(acme.warnings.join(' ')).toMatch(/profile\.qa\.json is not git-ignored/);
    expect(calls).toHaveLength(0);
  });

  test('with no accounts folder it says what to do next', async () => {
    expect(await run('list')).toBe(0);
    expect(json().accounts).toEqual([]);
    expect(json().nextStep).toMatch(/init <domain>/);
  });
});

describe('check', () => {
  beforeEach(() => writeProfile(D, JSON.stringify({ apiKey: KEY })));

  test('a full admin key: who, admin, switches, every skill ready; sends the key only as a header', async () => {
    expect(await run('check', D)).toBe(0);
    const r = json();
    expect(r).toMatchObject({ keyWorks: true, isAdmin: true, access: 'admin', production: false });
    expect(r.user).toMatchObject({ name: 'Ana QA', language: 'es', currency: 'USD' });
    expect(r.switches).toMatchObject({ mcp: 'on', webhooks: 'on', oauthServer: 'off', lifecycleHooksObjects: ['Contact'] });
    expect(r.skills.every((s) => s.status === 'ready')).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v2/user/me', 'GET /v2/user/preferences']);
    expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    expect(out).not.toContain(KEY);
  });

  test('an admin whose key has scopes is not a full admin', async () => {
    server.me = { status: 200, body: { ...adminMe.body, permissions: ['Resource@Site.*', 'Resource@User.me'] } };
    expect(await run('check', D)).toBe(0);
    const r = json();
    expect(r.access).toBe('admin-scoped');
    expect(r.skills.find((s) => s.skill === 'prolibu-sites').status).toBe('ready');
    expect(r.skills.find((s) => s.skill === 'prolibu-scripts')).toMatchObject({ status: 'missing permissions', missing: ['Resource@Script.create', 'Resource@Script.update', 'Resource@Script.run'] });
    expect(r.notes.join(' ')).toMatch(/admin-only actions are refused/);
  });

  test('a non-admin key: missing permissions per skill and its write permissions', async () => {
    server.me = {
      status: 200,
      body: {
        profile: { ...adminMe.body.profile, isAdmin: false, roles: [{ _id: 'r1', roleName: 'Seller' }] },
        permissions: ['Resource@Deal.find', 'Resource@Deal.update', 'Resource@Quote.*', 'Resource@User.me', 'Resource@Stage.find'],
      },
    };
    expect(await run('check', D)).toBe(0);
    const r = json();
    expect(r).toMatchObject({ isAdmin: false, access: 'roles' });
    expect(r.user.roles).toEqual(['Seller']);
    expect(r.skills.find((s) => s.skill === 'prolibu-quotes').status).toBe('ready');
    expect(r.skills.find((s) => s.skill === 'prolibu-stages').status).toBe('ready');
    expect(r.skills.find((s) => s.skill === 'prolibu-forms').status).toBe('missing permissions');
    expect(r.writePermissions).toEqual({ Deal: ['update'], Quote: ['*'] });
    expect(r.notes.join(' ')).toMatch(/roles changed later/);
  });

  test('a switch that is off blocks the skills that need it', async () => {
    server.prefs = { status: 200, body: { integrations: { mcp: { enabled: false } } } };
    expect(await run('check', D)).toBe(0);
    const r = json();
    expect(r.switches.mcp).toBe('off');
    expect(r.skills.find((s) => s.skill === 'prolibu-dashboards').status).toBe('switch off');
    expect(r.skills.find((s) => s.skill.startsWith('mcp-server')).status).toBe('switch off');
    expect(r.skills.find((s) => s.skill === 'prolibu-webhooks').status).toBe('switch off');
  });

  test('a refused key (401) says so and exits 1', async () => {
    server.me = { status: 401, body: { statusCode: 401, error: 'token does not exist' } };
    expect(await run('check', D)).toBe(1);
    expect(json()).toMatchObject({ keyWorks: false, status: 401, serverSays: 'token does not exist' });
    expect(json().nextStep).toMatch(/API Keys/);
    expect(calls).toHaveLength(1);
  });

  test('a valid key without Resource@User.me (403) is reported as limited, not broken', async () => {
    server.me = { status: 403, body: { statusCode: 403, error: 'Forbidden' } };
    server.prefs = { status: 403, body: { statusCode: 403, error: 'Forbidden' } };
    expect(await run('check', D)).toBe(0);
    expect(json()).toMatchObject({ keyWorks: true, access: 'limited', switches: null });
  });

  test('a production-looking domain gets a note', async () => {
    writeProfile('acme.example.com', JSON.stringify({ apiKey: KEY }));
    expect(await run('check', 'acme.example.com')).toBe(0);
    expect(json().production).toBe(true);
    expect(json().notes.join(' ')).toMatch(/production/);
  });

  test('an empty or missing key is refused before any call', async () => {
    writeProfile('dev98.example.com', JSON.stringify({ apiKey: '' }));
    expect(await run('check', 'dev98.example.com')).toBe(2);
    expect(err).toMatch(/no usable key/);
    expect(await run('check', D, '--profile', 'qa')).toBe(2);
    expect(err).toMatch(/init dev99\.example\.com --profile qa/);
    expect(calls).toHaveLength(0);
  });

  test('never prints the key, even when the server echoes it', async () => {
    server.me = { status: 401, body: { statusCode: 401, error: `bad token ${KEY}` } };
    await run('check', D);
    expect(out + err).not.toContain(KEY);
  });
});

describe('mcp', () => {
  beforeEach(() => writeProfile(D, JSON.stringify({ apiKey: KEY })));

  test('builds a local-scope command that reads the key from the profile file', async () => {
    expect(await run('mcp', D)).toBe(0);
    const r = json();
    expect(r).toMatchObject({ mcpSwitch: 'on', serverName: 'prolibu-dev99', endpoint: `https://${D}/v2/mcpsession/ses`, tools: ['find', 'getMyProfile'] });
    expect(r.command).not.toContain(KEY);
    expect(r.command).toContain(`k=$(node -p 'require("./accounts/${D}/profile.json").apiKey') && claude mcp add`);
    expect(r.command).toContain('--scope local');
    expect(r.command).not.toMatch(/--scope (project|user)/);
    expect(r.command).toContain('--header "Authorization: Bearer $k"; unset k');
    expect(r.nextStep).toMatch(/never claude mcp get/);
  });

  test('a named profile gets its own server name and file', async () => {
    writeProfile(D, JSON.stringify({ apiKey: KEY }), 'profile.qa.json');
    expect(await run('mcp', D, '--profile', 'qa')).toBe(0);
    expect(json().serverName).toBe('prolibu-dev99-qa');
    expect(json().command).toContain(`./accounts/${D}/profile.qa.json`);
  });

  test('blocks when the account switch is off, and never offers to change it', async () => {
    server.prefs = { status: 200, body: { integrations: { mcp: { enabled: false } } } };
    expect(await run('mcp', D)).toBe(3);
    expect(err).toMatch(/An admin turns it on/);
  });

  test('blocks when the key is refused', async () => {
    server.me = { status: 401, body: { statusCode: 401, error: 'expired' } };
    expect(await run('mcp', D)).toBe(3);
  });
});

describe('usage', () => {
  test.each([
    [['nope', D]],
    [['check']],
    [['check', 'not a domain']],
    [['check', D, '--profile', 'Bad Name']],
    [['check', D, '--apikey', 'x']],
    [['list', D]],
  ])('%j exits 2 and sends nothing', async (argv) => {
    expect(await run(...argv)).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('safeRemote hides credentials in remote URLs only', () => {
    expect(setup.safeRemote('https://u:p@host/x.git')).toBe('https://***@host/x.git');
    expect(setup.safeRemote('git@git.example.com:org/x.git')).toBe('git@git.example.com:org/x.git');
  });
});
