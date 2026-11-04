/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const xq = require('../.claude/skills/prolibu-extended-quote-sites/scripts/extended-quote');

const SKILL_DIR = path.join(__dirname, '..', '.claude', 'skills', 'prolibu-extended-quote-sites');
const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-654321';
const WS_FULL = 'a'.repeat(24);
const WS_OFF = 'b'.repeat(24);
const WS_MINE = 'c'.repeat(24);
const SITE_OK = `https://${D}/site/qa-skills-xq-dev/`;

let rootDir;
let out;
let err;
let calls;
let probes;
let state;
let seq;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

function freshState() {
  return {
    tenant: { enabled: true, url: SITE_OK },
    workspaces: [
      { _id: WS_FULL, workspaceName: 'Full', extendedQuote: { enabled: true, url: `https://${D}/site/other/` }, updatedAt: 'T1' },
      { _id: WS_OFF, workspaceName: 'Off only', extendedQuote: { enabled: false }, updatedAt: 'T2' },
      { _id: WS_MINE, workspaceName: 'Mine', updatedAt: 'T3' },
    ],
    sites: [
      { _id: '1'.repeat(24), siteCode: 'qa-skills-xq-dev', active: true, package: 'pkg' },
      { _id: '2'.repeat(24), siteCode: 'other', active: true, package: 'pkg' },
      { _id: '3'.repeat(24), siteCode: 'unpublished', active: true },
    ],
    pages: {},
    forbidWorkspace: false,
    ignorePatchNull: false,
  };
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const auth = init.headers.Authorization;
  const seller = auth === `Bearer ${SELLER_KEY}`;
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth });
  if (u.pathname === '/v2/user/me') {
    return respond(200, { profile: { isAdmin: !seller, apiKey: seller ? SELLER_KEY : KEY, primaryWorkspace: seller ? { _id: WS_OFF } : null } });
  }
  if (u.pathname === '/v2/preference/read') {
    if (seller) return respond(403, { error: 'Only admins.' });
    return respond(200, { preference: { modules: { sales: { deals: { quote: { extendedQuote: state.tenant } } } } } });
  }
  if (u.pathname === '/v2/user/preferences') {
    const ws = seller ? state.workspaces.find((w) => w._id === WS_OFF).extendedQuote : null;
    return respond(200, { modules: { sales: { deals: { quote: { extendedQuote: xq.backendMerge(state.tenant, ws) } } } } });
  }
  if (u.pathname === '/v2/user') return respond(200, { data: [], pagination: { count: 4 } });
  if (u.pathname === '/v2/site') {
    if (seller) return respond(403, { error: 'Forbidden. find on Site.' });
    const code = JSON.parse(u.searchParams.get('xquery')).siteCode;
    return respond(200, { data: state.sites.filter((s) => s.siteCode === code) });
  }
  const [, object, id] = u.pathname.split('/').filter(Boolean);
  if (object === 'workspace') {
    if (state.forbidWorkspace) return respond(403, { error: 'Forbidden. find on Workspace.' });
    if (init.method === 'GET' && id) {
      const ws = state.workspaces.find((w) => w._id === id);
      return ws ? respond(200, ws) : respond(404, { error: 'Not found' });
    }
    if (init.method === 'GET') {
      const data = state.workspaces.filter((w) => w.extendedQuote);
      return respond(200, { data, pagination: { count: data.length, lastPage: 1 } });
    }
    if (init.method === 'PATCH') {
      if (seller) return respond(403, { error: 'Forbidden' });
      const ws = state.workspaces.find((w) => w._id === id);
      seq += 1;
      const next = { ...body.extendedQuote };
      if (state.ignorePatchNull) next.enabled = ws.extendedQuote && ws.extendedQuote.enabled;
      ws.extendedQuote = next;
      ws.updatedAt = `U${seq}`;
      return respond(200, ws);
    }
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

// The page probe: a plain GET on the site URL, never with the key.
async function fakeProbe(url, init) {
  probes.push({ url, init });
  const page = state.pages[url] || { status: 200, headers: { 'content-security-policy': "frame-ancestors 'self' https://x.example.com" } };
  const headers = new Map(Object.entries(page.headers || {}));
  return { status: page.status, headers: { get: (k) => headers.get(k.toLowerCase()) || null } };
}

async function run(...args) {
  out = '';
  err = '';
  const code = await xq.main(args, {
    rootDir, fetchImpl: fakeFetch, probeFetch: fakeProbe, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, json: out ? JSON.parse(out) : null };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xq-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.vendedor.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  probes = [];
  seq = 0;
  state = freshState();
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('which site the editor opens', () => {
  const tenant = { enabled: true, url: 'https://t.example.com/' };

  test('a complete workspace override wins for everyone', () => {
    const e = xq.effectiveFor(tenant, { enabled: true, url: 'https://w.example.com/' });
    expect(e.v1AndV2Sellers).toEqual({ button: true, url: 'https://w.example.com/' });
    expect(e.v2Admins).toEqual(e.v1AndV2Sellers);
    expect(e.divergent).toBe(false);
  });

  test('enabled=false alone hides it for sellers but V2 admins still get the account site', () => {
    const e = xq.effectiveFor(tenant, { enabled: false });
    expect(e.v1AndV2Sellers.button).toBe(false);
    expect(e.v2Admins).toEqual({ button: true, url: 'https://t.example.com/' });
    expect(e.divergent).toBe(true);
  });

  test('a url alone is merged per field for sellers and ignored for V2 admins', () => {
    const e = xq.effectiveFor(tenant, { url: 'https://w.example.com/' });
    expect(e.v1AndV2Sellers.url).toBe('https://w.example.com/');
    expect(e.v2Admins.url).toBe('https://t.example.com/');
  });

  test('enabled=true without a url is not complete: everyone gets the account site', () => {
    const e = xq.effectiveFor(tenant, { enabled: true });
    expect(e.v1AndV2Sellers).toEqual({ button: true, url: 'https://t.example.com/' });
    expect(e.v2Admins).toEqual(e.v1AndV2Sellers);
  });

  test('the backend merge keeps an explicit false and inherits an empty url', () => {
    expect(xq.backendMerge(tenant, { enabled: false, url: '' })).toEqual({ enabled: false, url: 'https://t.example.com/' });
    expect(xq.backendMerge(tenant, { enabled: null, url: null })).toEqual(tenant);
  });
});

describe('url checks', () => {
  test('another domain is a warning, a token in the URL is an error', () => {
    const a = xq.urlProblems('https://other.example.com/tool/', D).problems.map((p) => `${p.code}:${p.severity}`);
    expect(a).toContain('CROSS_ORIGIN:warning');
    const b = xq.urlProblems(`${SITE_OK}?token=abc`, D).problems.map((p) => p.code);
    expect(b).toContain('TOKEN_IN_URL');
  });

  test('a missing final slash and a non-URL are reported', () => {
    expect(xq.urlProblems(`https://${D}/site/x`, D).problems.map((p) => p.code)).toContain('NO_TRAILING_SLASH');
    expect(xq.urlProblems('site/x', D).problems.map((p) => p.code)).toEqual(['INVALID_URL']);
  });

  test('an unpublished Site is not usable', async () => {
    const { code, json } = await run('check-url', D, `https://${D}/site/unpublished/`);
    expect(code).toBe(0);
    expect(json.usable).toBe(false);
    expect(json.problems.map((p) => p.code)).toContain('SITE_NOT_PUBLISHED');
  });

  test('a redirect to another origin and a frame-ancestors without the app are errors', async () => {
    state.pages[SITE_OK] = { status: 302, headers: { location: 'https://cdn.example.com/x/' } };
    let r = await run('check-url', D, SITE_OK);
    expect(r.json.problems.map((p) => p.code)).toContain('REDIRECT_CROSS_ORIGIN');
    state.pages[SITE_OK] = { status: 200, headers: { 'content-security-policy': 'frame-ancestors https://only.example.com' } };
    r = await run('check-url', D, SITE_OK);
    expect(r.json.problems.map((p) => p.code)).toContain('FRAME_BLOCKED');
  });

  test('the page probe never carries the key, and other domains are not loaded', async () => {
    await run('check-url', D, SITE_OK);
    expect(probes).toHaveLength(1);
    expect(JSON.stringify(probes[0].init)).not.toContain(KEY);
    expect(probes[0].init.redirect).toBe('manual');
    await run('check-url', D, 'https://other.example.com/tool/');
    expect(probes).toHaveLength(1);
  });

  test('a seller that cannot read Sites gets a warning, not a crash', async () => {
    const { code, json } = await run('check-url', D, SITE_OK, '--profile', 'vendedor');
    expect(code).toBe(0);
    expect(json.problems.map((p) => p.code)).toEqual(['SITE_UNREADABLE']);
  });
});

describe('config', () => {
  test('admin sees the account setting and every override, with the divergent one flagged', async () => {
    const { code, json } = await run('config', D);
    expect(code).toBe(0);
    expect(json.tenant.url).toBe(SITE_OK);
    const off = json.workspaces.find((w) => w._id === WS_OFF);
    expect(off.effective.divergent).toBe(true);
    expect(off.warning).toMatch(/Partial override/);
    expect(json.workspaces.find((w) => w._id === WS_FULL).effective.divergent).toBe(false);
  });

  test('a seller only sees its own workspace and the merged preferences', async () => {
    const { code, json } = await run('config', D, '--profile', 'vendedor');
    expect(code).toBe(0);
    expect(json.you.isAdmin).toBe(false);
    expect(json.workspaces.map((w) => w._id)).toEqual([WS_OFF]);
    expect(calls.some((c) => c.path === '/v2/preference/read')).toBe(false);
    expect(json.tenant.source).toMatch(/merged/);
  });
});

describe('attach and inherit', () => {
  const attach = JSON.stringify({ workspace: WS_MINE, action: 'attach', url: SITE_OK });
  const inherit = JSON.stringify({ workspace: WS_FULL, action: 'inherit' });

  test('preview writes nothing and tells the agent to stop', async () => {
    const { code, json } = await run('preview', D, attach);
    expect(code).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(json.version).toBe('T3');
    expect(json.nextStep).toMatch(/STOP HERE/);
    expect(json.after.effective.v1AndV2Sellers.url).toBe(SITE_OK);
    expect(json.usersStandingHere).toBe(4);
  });

  test('an unusable URL blocks the preview', async () => {
    const { code, json } = await run('preview', D, JSON.stringify({ workspace: WS_MINE, action: 'attach', url: `https://${D}/site/unpublished/` }));
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toMatch(/SITE_NOT_PUBLISHED/);
  });

  test('the account preference is never written', async () => {
    const { code } = await run('preview', D, JSON.stringify({ scope: 'tenant', action: 'attach', url: SITE_OK }));
    expect(code).toBe(3);
    expect(calls).toHaveLength(0);
    expect(err).toMatch(/never writes account preferences/);
  });

  test('a seller is refused before any write', async () => {
    const { code } = await run('apply', D, attach, '--version', 'T3', '--confirmed', '--profile', 'vendedor');
    expect(code).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('apply needs the version and --confirmed, and refuses a stale version', async () => {
    expect((await run('apply', D, attach, '--confirmed')).code).toBe(2);
    expect((await run('apply', D, attach, '--version', 'T3')).code).toBe(2);
    expect((await run('apply', D, attach, '--version', 'OLD', '--confirmed')).code).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('attach patches only extendedQuote and reads it back', async () => {
    const { code, json } = await run('apply', D, attach, '--version', 'T3', '--confirmed');
    expect(code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: `/v2/workspace/${WS_MINE}`, body: { extendedQuote: { enabled: true, url: SITE_OK } } })]);
    expect(json.saved).toBe(true);
  });

  test('inherit clears both fields; a read-back that still holds a value fails', async () => {
    let r = await run('apply', D, inherit, '--version', 'T1', '--confirmed');
    expect(r.code).toBe(0);
    expect(writes()[0].body).toEqual({ extendedQuote: { enabled: null, url: null } });
    state = freshState();
    state.ignorePatchNull = true;
    r = await run('apply', D, inherit, '--version', 'T1', '--confirmed');
    expect(r.code).toBe(1);
    expect(r.json.saved).toBe(false);
  });

  test('bad plans are usage errors with nothing sent', async () => {
    for (const plan of ['{"workspace":"x","action":"attach","url":"u"}', `{"workspace":"${WS_MINE}","action":"off"}`, `{"workspace":"${WS_MINE}","action":"inherit","url":"u"}`, 'not json']) {
      expect((await run('preview', D, plan)).code).toBe(2);
    }
    expect(calls).toHaveLength(0);
  });

  test('a 403 stops with FORBIDDEN and is not retried', async () => {
    state.forbidWorkspace = true;
    const { code } = await run('preview', D, attach);
    expect(code).toBe(1);
    expect(err).toMatch(/^FORBIDDEN/);
    expect(calls.filter((c) => c.path.startsWith('/v2/workspace'))).toHaveLength(1);
  });

  test('the key never reaches the output', async () => {
    state.workspaces[2].workspaceName = `leak ${KEY}`;
    await run('preview', D, attach);
    expect(out + err).not.toContain(KEY);
  });
});

describe('lint of the site code', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xq-site-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('the bundled example is clean', async () => {
    const { code, json } = await run('lint', path.join(SKILL_DIR, 'assets'));
    expect(code).toBe(0);
    expect(json.findings).toEqual([]);
  });

  test('a site with the classic mistakes is flagged', async () => {
    const f = path.join(dir, 'index.html');
    fs.writeFileSync(f, `<script>
      addEventListener('message', (e) => { if (e.data.type === 'suite:init') go(e.data) })
      function apply(newLines) { parent.postMessage({ type: 'form:set:model', payload: JSON.stringify({ value: { proposal: { quote: { lineItems: newLines } } } }) }, '*') }
      const line = { productName: 'X', unitPrice: 10 }
      fetch('/v2/quote/productSearch?token=' + t)
    </script>`);
    const { code, json } = await run('lint', f);
    expect(code).toBe(3);
    const codes = json.findings.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['NO_GET_MODEL', 'INVENTED_MESSAGE', 'UNIT_PRICE', 'HAND_BUILT_LINES', 'TOKEN_IN_URL', 'NO_ORIGIN_CHECK', 'NO_CLOSE', 'ONLY_NEW_LINES']));
  });

  test('a hard-coded key is an error', async () => {
    const f = path.join(dir, 'app.js');
    const fakeKey = 'F'.repeat(32);
    fs.writeFileSync(f, `parent.postMessage({ type: 'form:get:model' }, o); const apiKey = '${fakeKey}'; // formatLineItem e.origin\n parent.postMessage({ type: 'form:close' }, o)`);
    const { json } = await run('lint', f);
    expect(json.findings.map((x) => x.code)).toEqual(['EMBEDDED_KEY']);
  });

  test('refuses profile files and unknown file types', async () => {
    const p = path.join(dir, 'profile.json');
    fs.writeFileSync(p, '{}');
    expect((await run('lint', p)).code).toBe(2);
    const t = path.join(dir, 'notes.txt');
    fs.writeFileSync(t, 'x');
    expect((await run('lint', t)).code).toBe(2);
  });
});

describe('browser helper', () => {
  const src = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'prolibu-extended-quote.js'), 'utf8');
  const load = () => {
    const window = { location: { origin: `https://${D}` }, localStorage: { getItem: () => null }, document: { referrer: '' } };
    vm.runInNewContext(src, { window, URL, Intl, Date, Map, Set, WeakSet, JSON, Promise, Error, Object, Number, String, Array });
    return window.ProlibuQuote;
  };

  test('deserialize resolves shared references and dates like the app serializer', () => {
    const PQ = load();
    const deal = PQ.deserialize({
      __id: 1,
      value: {
        __id: 2,
        owner: { __id: 3, name: 'A' },
        assignee: { __ref: 3 },
        closeDate: { __type: 'date', value: '2026-11-05T05:00:00.000Z', __id: 4 },
        proposal: { __id: 5, quote: { __id: 6, lineItems: { __id: 7, 0: { __id: 8, uuid: 'u1' } } } },
      },
    }).value;
    expect(deal.assignee).toBe(deal.owner);
    expect(deal.closeDate).toBe('2026-11-05T05:00:00.000Z');
    expect(JSON.stringify(deal)).not.toContain('__id');
  });

  test('eventDay is midnight to next midnight in the given time zone', () => {
    const PQ = load();
    expect(PQ.eventDay('2026-11-05', 'America/Bogota')).toEqual({ startDate: '2026-11-05T05:00:00.000Z', endDate: '2026-11-06T05:00:00.000Z' });
    expect(() => PQ.eventDay('05/11/2026', 'America/Bogota')).toThrow();
  });
});
