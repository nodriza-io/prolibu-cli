/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const path = require('path');
const session = require('../.claude/skills/prolibu-sites/assets/prolibu-session');

const ASSET = path.join(__dirname, '../.claude/skills/prolibu-sites/assets/prolibu-session.js');

let store;
let assigned;
let calls;
let replies;
let root;

function reply(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

beforeEach(() => {
  store = {};
  assigned = [];
  calls = [];
  replies = [];
  root = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
    location: { pathname: '/site/my-site/deals', search: '?page=2', hash: '#top', assign: (url) => assigned.push(url) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return replies.shift() || reply(200, {});
    },
  };
});

describe('token', () => {
  test('reads the V2 JSON-quoted form and the V1 plain form', () => {
    const s = session.create(root);
    store.apiKey = JSON.stringify('tok-v2');
    expect(s.token()).toBe('tok-v2');
    store.apiKey = 'tok-v1';
    expect(s.token()).toBe('tok-v1');
    store.apiKey = '12345';
    expect(s.token()).toBe('12345');
  });

  test('no session, or storage blocked, gives null', () => {
    expect(session.create(root).token()).toBeNull();
    root.localStorage = { getItem: () => { throw new Error('blocked'); } };
    expect(session.create(root).token()).toBeNull();
  });
});

describe('api', () => {
  test('sends the unquoted token as Bearer to the same origin', async () => {
    store.apiKey = JSON.stringify('tok-v2');
    replies.push(reply(200, { profile: { email: 'a@b.co' } }));
    const me = await session.create(root).me();
    expect(me.profile.email).toBe('a@b.co');
    expect(calls[0].url).toBe('/v2/user/me');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok-v2');
  });

  test('serializes an object body as JSON', async () => {
    store.apiKey = 'tok';
    await session.create(root).api('/endpoint/post/orders-push', { method: 'POST', body: { a: 1 } });
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
  });

  test('without a token it goes to the sign-in page with a relative redirect, and calls nothing', async () => {
    await expect(session.create(root).api('/user/me')).rejects.toMatchObject({ signingIn: true });
    expect(calls).toHaveLength(0);
    expect(assigned).toEqual(['/v2/auth/signin?redirect=%2Fsite%2Fmy-site%2Fdeals%3Fpage%3D2%23top']);
  });

  test('off the platform (a local dev server) it never redirects', async () => {
    root.location.pathname = '/';
    await expect(session.create(root).api('/user/me')).rejects.toMatchObject({ noSession: true });
    expect(assigned).toHaveLength(0);
  });

  test('on 401 it goes to sign in and leaves the stored token alone', async () => {
    store.apiKey = 'expired';
    replies.push(reply(401, { statusCode: 401, error: 'Unauthorized' }));
    await expect(session.create(root).api('/user/me')).rejects.toMatchObject({ signingIn: true });
    expect(store.apiKey).toBe('expired');
    expect(assigned).toHaveLength(1);
  });

  test('other errors carry the status and the server message', async () => {
    store.apiKey = 'tok';
    replies.push(reply(400, { statusCode: 400, error: 'Invalid JSON' }));
    await expect(session.create(root).api('/x')).rejects.toMatchObject({ status: 400, message: 'Invalid JSON' });
  });
});

test('the helper passes the cloud-drive content scanner', () => {
  // Same patterns the server rejects in uploaded text files when the scanner is on.
  const text = fs.readFileSync(ASSET, 'utf8');
  const patterns = [/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i, /javascript:/i, /vbscript:/i, /onload\s*=/i,
    /onerror\s*=/i, /onclick\s*=/i, /<iframe\b/i, /<object\b/i, /<embed\b/i, /eval\s*\(/i, /document\.write/i];
  for (const p of patterns) expect(p.test(text)).toBe(false);
});

// ─── scripts/site.js ───────────────────────────────────────────────────────────

const os = require('os');
const crypto = require('crypto');
const siteJs = require('../.claude/skills/prolibu-sites/scripts/site');

const D = 'dev99.example.com';
const ME = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const KEY = ['fake', 'admin', 'k'.repeat(16)].join('-');
const SELLER_KEY = ['fake', 'seller', 'k'.repeat(16)].join('-');
const FAKE_SECRET = 'z'.repeat(20);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let tmp;
let backupRoot;
let state;
let calls2;
let out;
let err;

function res(status, body, headers = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(text);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => (Buffer.isBuffer(body) ? '' : text),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function write(rel, content) {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const siteDir = (name = 'demo') => path.join(tmp, 'accounts', D, 'sites', name);
const PAGE = '<!doctype html><html><head><meta name="robots" content="noindex"><link rel="stylesheet" href="./style.css"></head><body>v1</body></html>';

function goodSite(name = 'demo', page = PAGE) {
  write(`accounts/${D}/sites/${name}/config.json`, '{"siteType":"Static"}');
  write(`accounts/${D}/sites/${name}/public/index.html`, page);
  write(`accounts/${D}/sites/${name}/public/style.css`, 'body{margin:0}');
  return siteDir(name);
}

// A fake of the routes the script uses, shaped after what the test account answered.
async function fake(url, init = {}) {
  const u = new URL(url);
  const method = init.method || 'GET';
  calls2.push({ method, host: u.host, path: u.pathname, multipart: init.body instanceof FormData });
  if (u.host === 's3.amazonaws.com') {
    if (method === 'HEAD') return res(200, '');
    return state.liveZip ? res(200, state.liveZip) : res(404, 'no');
  }
  if (u.pathname.startsWith('/site/')) {
    const code = u.pathname.split('/')[2];
    const rest = u.pathname.split('/').slice(3).join('/');
    const s = state.site && state.site.siteCode === code ? state.site : null;
    if (!s || !s.package) return res(404, 'Not Found');
    if (s.authenticationRequired) return res(302, '', { location: `/v2/auth/signin?redirect=${encodeURIComponent(u.pathname)}` });
    if (rest) return res(302, '', { location: `https://s3.amazonaws.com/bucket/${rest}` });
    if (s.active === false) return res(403, '<Error>AccessDenied</Error>');
    return res(200, 'html', { 'cache-control': 'no-store', 'x-amz-meta-sha256': state.servedIndexSha });
  }
  const auth = init.headers && init.headers.Authorization;
  if (![KEY, SELLER_KEY].map((k) => `Bearer ${k}`).includes(auth)) return res(401, { error: 'Unauthorized' });
  if (state.forbidden && u.pathname.startsWith('/v2/site')) return res(403, { error: 'Forbidden. User has no permission to perform "find" on "Site".' });
  if (u.pathname === '/v2/user/me') return res(200, { profile: { _id: ME, email: 'me@example.com' } });
  if (u.pathname === '/v2/user/preferences') return res(200, { modules: { tools: { cloudDrive: { uploadRestrictions: { maxFileSizeMB: state.maxMB } } } } });
  if (u.pathname === '/v2/preference/read') {
    if (!state.admin) return res(403, { error: 'Admins only' });
    return res(200, { preference: { modules: { tools: { cloudDrive: { uploadRestrictions: { blockExtensions: state.blockExt }, advancedSecurity: { enabled: state.scanner, scanMaliciousContent: state.scanner } } } } } });
  }
  if (u.pathname === '/v2/site' && method === 'GET') return res(200, { data: state.site ? [state.site] : [] });
  if (u.pathname === '/v2/site' && method === 'POST') {
    const body = JSON.parse(init.body);
    state.site = { _id: 'c'.repeat(24), ...body, active: true, authenticationRequired: false, createdBy: ME, updatedAt: 't1' };
    return res(201, state.site);
  }
  if (u.pathname.startsWith('/v2/site/')) {
    const code = decodeURIComponent(u.pathname.split('/')[3]);
    if (!state.site || state.site.siteCode !== code) return res(404, { error: 'No encontrado' });
    if (method === 'GET') return res(200, state.site);
    if (method === 'PATCH' && init.body instanceof FormData) {
      if (state.uploadFails) return res(400, { error: 'The site package must contain an index.html file' });
      const blob = init.body.get('package');
      const buf = Buffer.from(await blob.arrayBuffer());
      const id = crypto.randomBytes(12).toString('hex');
      state.files[id] = { _id: id, fileName: blob.name, size: buf.length, sha256: sha(buf), url: 'https://s3.amazonaws.com/bucket/dist.zip' };
      state.liveZip = buf;
      const index = siteJs.readZipEntries(buf).find((e) => e.rel === 'index.html');
      state.servedIndexSha = index.sha;
      state.site = { ...state.site, package: id, publicUrl: `https://${D}/site/${code}/`, updatedAt: `t${Date.now()}${Math.random()}` };
      return res(200, state.site);
    }
    if (method === 'PATCH') {
      state.site = { ...state.site, ...JSON.parse(init.body), updatedAt: `t${Math.random()}` };
      return res(200, state.site);
    }
  }
  if (u.pathname.startsWith('/v2/file/')) {
    const f = state.files[u.pathname.split('/')[3]];
    return f ? res(200, f) : res(404, { error: 'No encontrado' });
  }
  return res(404, { error: `unexpected ${method} ${u.pathname}` });
}

async function run(...argv) {
  out = '';
  err = '';
  const code = await siteJs.main(argv, {
    rootDir: tmp,
    fetchImpl: fake,
    publicFetch: fake,
    sleep: async () => {},
    backupRoot,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, json: out ? JSON.parse(out) : null };
}

const writes = () => calls2.filter((c) => c.host === D && c.path.startsWith('/v2/') && c.method !== 'GET');

describe('site.js', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitejs-'));
    backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sitejs-bk-'));
    write(`accounts/${D}/profile.json`, JSON.stringify({ apiKey: KEY }));
    write(`accounts/${D}/profile.vendedor.json`, JSON.stringify({ apiKey: SELLER_KEY }));
    calls2 = [];
    state = { key: KEY, site: null, files: {}, maxMB: 20, admin: true, scanner: false, blockExt: [], liveZip: null, servedIndexSha: null };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  });

  test('check passes a clean folder and sends no write', async () => {
    const { code, json } = await run('check', D, goodSite());
    expect(code).toBe(0);
    expect(json.blockers).toEqual([]);
    expect(json.files.sample).toEqual(['index.html', 'style.css']);
    expect(writes()).toHaveLength(0);
  });

  test('check blocks secrets, absolute paths and the account key without printing them', async () => {
    const dir = goodSite('bad', '<html><head><script src="/assets/app.js"></script></head><body><input type="password"><a href="/v2/auth/signin">in</a></body></html>');
    write(`accounts/${D}/sites/bad/public/.env`, 'TOKEN=1');
    write(`accounts/${D}/sites/bad/public/app.js`, `const k = "${KEY}"; fetch("/v2/auth/login")`);
    write(`accounts/${D}/sites/bad/public/x.js`, `const cfg = { apiKey: "${FAKE_SECRET}" }`);
    write(`accounts/${D}/sites/bad/public/.DS_Store`, 'junk');
    const { code, json } = await run('check', D, dir);
    expect(code).toBe(3);
    const rules = json.blockers.map((b) => `${b.rule}:${b.file}`);
    expect(rules).toEqual(expect.arrayContaining(['envFile:.env', 'accountApiKey:app.js', 'hardcodedApiKey:x.js', 'absolutePath:index.html']));
    expect(json.blockers.find((b) => b.rule === 'absolutePath').ref).toBe('/assets/app.js');
    expect(json.warnings.map((w) => w.rule)).toEqual(expect.arrayContaining(['passwordForm', 'authLogin']));
    expect(json.warnings.some((w) => w.rule === 'absolutePath')).toBe(false);
    expect(json.skipped).toEqual(['.DS_Store']);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(FAKE_SECRET);
  });

  test('check warns about a file the page loads but the folder does not have', async () => {
    const dir = goodSite('cfg', PAGE.replace('</head>', '<script src="_prolibu_config.js"></script></head>'));
    const { code, json } = await run('check', D, dir);
    expect(code).toBe(0);
    expect(json.warnings).toEqual([expect.objectContaining({ rule: 'missingFile', ref: '_prolibu_config.js' })]);
  });

  test('check explains a nested index.html and a missing build', async () => {
    write(`accounts/${D}/sites/nested/public/dist/index.html`, PAGE);
    let r = await run('check', D, siteDir('nested'));
    expect(r.code).toBe(3);
    expect(r.json.blockers[0]).toMatchObject({ rule: 'noIndex' });
    expect(r.json.blockers[0].message).toContain('inside dist/');
    write(`accounts/${D}/sites/vite/package.json`, JSON.stringify({ scripts: { build: 'vite build' } }));
    r = await run('check', D, siteDir('vite'));
    expect(r.json.blockers.map((b) => b.rule)).toEqual(['noBuild']);
  });

  test('refuses a source outside the site folders, such as the account folder with its profiles', async () => {
    const { code } = await run('check', D, path.join(tmp, 'accounts', D));
    expect(code).toBe(2);
    expect(err).toContain('Refusing');
    expect(calls2).toHaveLength(0);
  });

  test('preview of a new site writes nothing and tells the agent to stop', async () => {
    const { code, json } = await run('preview', D, 'demo-dev', goodSite());
    expect(code).toBe(0);
    expect(json.action).toBe('create');
    expect(json.site).toMatchObject({ siteCode: 'demo-dev', siteName: 'demo - Dev', siteType: 'Static' });
    expect(json.nextStep).toContain('STOP HERE');
    expect(json.nextStep).toContain(`--version ${json.version}`);
    expect(writes()).toHaveLength(0);
  });

  test('publish refuses without --confirmed, with a stale version, or on a prod code without --prod', async () => {
    const dir = goodSite();
    const { json } = await run('preview', D, 'demo-dev', dir);
    expect((await run('publish', D, 'demo-dev', dir, '--version', json.version)).code).toBe(2);
    expect((await run('publish', D, 'demo', dir, '--version', json.version, '--confirmed')).code).toBe(2);
    expect(err).toContain('--prod');
    write(`accounts/${D}/sites/demo/public/index.html`, PAGE.replace('v1', 'v2'));
    expect((await run('publish', D, 'demo-dev', dir, '--version', json.version, '--confirmed')).code).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('publish creates the site, uploads the zip as multipart and reads back what visitors get', async () => {
    const dir = goodSite();
    const { json: p } = await run('preview', D, 'demo-dev', dir);
    const { code, json } = await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    expect(code).toBe(0);
    expect(json.action).toBe('created');
    const w = writes();
    expect(w.map((c) => `${c.method} ${c.path} ${c.multipart}`)).toEqual(['POST /v2/site false', 'PATCH /v2/site/demo-dev true']);
    expect(json.package.storedMatches).toBe(true);
    expect(json.live).toMatchObject({ status: 200, servesNewVersion: true });
    expect(json.live.assets).toEqual([{ path: 'style.css', status: 200 }]);
    expect(json.problems).toEqual([]);
    expect(out).not.toContain(KEY);
  });

  test('a replace saves the live package first, and publishing that backup rolls back', async () => {
    const dir = goodSite();
    let { json: p } = await run('preview', D, 'demo-dev', dir);
    await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    const v1Sha = state.servedIndexSha;
    write(`accounts/${D}/sites/demo/public/index.html`, PAGE.replace('v1', 'v2'));
    ({ json: p } = await run('preview', D, 'demo-dev', dir));
    expect(p.action).toBe('replace');
    expect(p.replaces.sha256).toBe(sha(state.liveZip));
    const { json } = await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    expect(json.backup.sha256).toBe(p.replaces.sha256);
    expect(fs.existsSync(json.backup.path)).toBe(true);
    expect(state.servedIndexSha).not.toBe(v1Sha);
    ({ json: p } = await run('preview', D, 'demo-dev', json.backup.path));
    expect(p.blockers).toEqual([]);
    const back = await run('publish', D, 'demo-dev', json.backup.path, '--version', p.version, '--confirmed');
    expect(back.code).toBe(0);
    expect(state.servedIndexSha).toBe(v1Sha);
    expect(back.json.live.servesNewVersion).toBe(true);
  });

  test('a backup that does not match its checksum stops the publish before any write', async () => {
    const dir = goodSite();
    let { json: p } = await run('preview', D, 'demo-dev', dir);
    await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    state.files[state.site.package].sha256 = 'f'.repeat(64);
    calls2 = [];
    ({ json: p } = await run('preview', D, 'demo-dev', dir));
    const { code } = await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    expect(code).toBe(1);
    expect(err).toContain('checksum');
    expect(writes()).toHaveLength(0);
  });

  test('a site created by another user is blocked: the server would empty it', async () => {
    state.site = { siteCode: 'demo-dev', siteName: 'x', siteType: 'Static', createdBy: OTHER, updatedAt: 't0' };
    const { code, json } = await run('preview', D, 'demo-dev', goodSite());
    expect(code).toBe(3);
    expect(json.blockers.map((b) => b.rule)).toEqual(['notCreator']);
    expect(json.nextStep).toContain('do not publish');
  });

  test('account limits: size cap, blocked extensions and the content scanner', async () => {
    state.maxMB = 0.000001;
    state.blockExt = ['css'];
    state.scanner = true;
    write(`accounts/${D}/sites/demo/public/inline.html`, '<script>alert(1)</script>');
    const { json } = await run('check', D, goodSite());
    expect(json.blockers.map((b) => b.rule)).toEqual(expect.arrayContaining(['tooBig', 'blockedExtension', 'contentScanner']));
  });

  test('a non-admin still gets the checks; scanner settings are reported unknown', async () => {
    state.admin = false;
    const { code, json } = await run('check', D, goodSite());
    expect(code).toBe(0);
    expect(json.limits).toMatchObject({ adminSettingsRead: false, scannerOn: null });
  });

  test('a 403 stops with FORBIDDEN and nothing else is tried', async () => {
    state.forbidden = true;
    const { code } = await run('list', D, '--profile', 'vendedor');
    expect(code).toBe(1);
    expect(err).toContain('FORBIDDEN');
    expect(calls2.filter((c) => c.path.startsWith('/v2/site'))).toHaveLength(1);
  });

  test('a failed upload after a backup tells how to put the old site back', async () => {
    const dir = goodSite();
    let { json: p } = await run('preview', D, 'demo-dev', dir);
    await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    write(`accounts/${D}/sites/demo/public/index.html`, PAGE.replace('v1', 'v3'));
    ({ json: p } = await run('preview', D, 'demo-dev', dir));
    state.uploadFails = true;
    const { code } = await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    expect(code).toBe(1);
    expect(err).toContain('prolibu-sites-backups');
  });

  test('settings preview and apply change only what differs, and read back the gate', async () => {
    const dir = goodSite();
    const { json: p } = await run('preview', D, 'demo-dev', dir);
    await run('publish', D, 'demo-dev', dir, '--version', p.version, '--confirmed');
    calls2 = [];
    const { json: sp } = await run('settings-preview', D, 'demo-dev', '--gate', 'on', '--active', 'on');
    expect(sp.changes).toEqual({ authenticationRequired: { from: false, to: true } });
    expect(sp.nextStep).toContain('STOP HERE');
    expect(writes()).toHaveLength(0);
    expect((await run('settings', D, 'demo-dev', '--gate', 'on', '--version', 'stale', '--confirmed')).code).toBe(3);
    const { code, json } = await run('settings', D, 'demo-dev', '--gate', 'on', '--version', sp.version, '--confirmed');
    expect(code).toBe(0);
    expect(json.live.gated).toBe(true);
    expect(writes().map((c) => c.method)).toEqual(['PATCH']);
  });

  test('a zip with an unsafe path is rejected', () => {
    const name = Buffer.from('../evil.html');
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(0, 16);
    expect(() => siteJs.readZipEntries(Buffer.concat([cd, name, eocd]))).toThrow('unsafe path');
  });

  test('only https storage hosts are fetched for packages and assets', () => {
    expect(siteJs.storageUrlAllowed('https://s3.amazonaws.com/b/x.zip', D)).toBe(true);
    expect(siteJs.storageUrlAllowed('http://s3.amazonaws.com/b/x.zip', D)).toBe(false);
    expect(siteJs.storageUrlAllowed('https://evil.example.com/x.zip', D)).toBe(false);
    expect(siteJs.storageUrlAllowed('https://s3.amazonaws.com.evil.com/x', D)).toBe(false);
  });
});
