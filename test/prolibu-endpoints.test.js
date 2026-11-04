/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const endpoint = require('../.claude/skills/prolibu-endpoints/scripts/endpoint');

const D = 'dev99.example.com';
const SCRIPT = 'a'.repeat(24);
const OTHER_SCRIPT = 'b'.repeat(24);
const ROLE = 'c'.repeat(24);
const EP = 'd'.repeat(24);

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

const scriptDoc = (id, code, extra = {}) => ({ _id: id, scriptCode: code, scriptName: code, active: true, lifecycleHooks: [], timeout: 30000, ...extra });

// Shaped after the verified server behavior: routeName is unique across methods, the
// dispatcher looks it up case-sensitively, success is { authenticated, output } and
// failures are { statusCode, error }.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body });
  const scriptsById = { [SCRIPT]: state.scripts.app, [OTHER_SCRIPT]: state.scripts.other };
  const scriptByRef = (ref) => Object.values(scriptsById).find((s) => s && (s._id === ref || s.scriptCode === ref));

  if (init.method === 'GET' && u.pathname === '/v2/endpoint') {
    const q = JSON.parse(u.searchParams.get('xquery') || '{}');
    const list = state.endpoint && (!q.routeName || q.routeName === state.endpoint.routeName || typeof q.routeName === 'object')
      ? [{ ...state.endpoint, script: scriptsById[state.endpoint.script] }] : [];
    return respond(200, { pagination: { count: list.length }, data: list });
  }
  if (init.method === 'GET' && u.pathname.startsWith('/v2/script/')) {
    const s = scriptByRef(decodeURIComponent(u.pathname.split('/').pop()));
    return s ? respond(200, s) : respond(404, { statusCode: 404, error: 'Not found' });
  }
  if (init.method === 'GET' && u.pathname === `/v2/role/${ROLE}`) return respond(200, { _id: ROLE, roleName: 'Integrations' });
  if (init.method === 'GET' && u.pathname.startsWith('/v2/role/')) return respond(404, { statusCode: 404, error: 'Not found' });
  if (init.method === 'POST' && u.pathname === '/v2/endpoint') {
    if (state.endpoint && state.endpoint.routeName === body.routeName) return respond(400, { statusCode: 400, error: `routeName '${body.routeName}' already exists.` });
    state.endpoint = { _id: EP, endpointCode: 'ENP-1', ...body, updatedAt: 'T1' };
    return respond(201, state.endpoint);
  }
  if (init.method === 'PATCH' && u.pathname === `/v2/endpoint/${EP}`) {
    state.endpoint = { ...state.endpoint, ...body, authentication: { ...state.endpoint.authentication, ...(body.authentication || {}) }, updatedAt: 'T2' };
    return respond(200, state.endpoint);
  }
  const call = u.pathname.match(/^\/v2\/endpoint\/(get|post|put|delete)\/(.+)$/i);
  if (call) {
    if (call[1].toUpperCase() !== init.method) return respond(404, `<pre>Cannot ${init.method} ${u.pathname}</pre>`);
    if (!state.endpoint || state.endpoint.routeName !== call[2]) return respond(404, { statusCode: 404, error: 'Not found' });
    const auth = init.headers.Authorization;
    if (auth && auth !== 'Bearer SECRET123') return respond(401, { statusCode: 401, error: 'Unauthorized' });
    if (state.endpoint.authentication.enabled && !auth) return respond(401, { statusCode: 401, error: 'Authentication required to access this endpoint' });
    return respond(200, { authenticated: Boolean(auth), output: { echo: body || null, apiKey: 'leak-me' } });
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => endpoint.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const plan = (body) => JSON.stringify({ routeName: 'orders-push', ...body });
const json = () => JSON.parse(out);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-endpoints-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    scripts: { app: scriptDoc(SCRIPT, 'orders'), other: scriptDoc(OTHER_SCRIPT, 'orders-dev') },
    endpoint: null,
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('validatePlan', () => {
  test('rejects route names the server would reject', () => {
    expect(() => endpoint.validatePlan({ routeName: 'a b' }, { creating: false })).toThrow('routeName');
    expect(() => endpoint.validatePlan({ routeName: 'a/b' }, { creating: false })).toThrow('routeName');
    expect(() => endpoint.validatePlan({ routeName: 'x'.repeat(64) }, { creating: false })).toThrow('routeName');
    expect(endpoint.validatePlan({ routeName: 'Orders_push-1' }, { creating: false }).routeName).toBe('Orders_push-1');
  });

  test('a new endpoint must decide authentication on purpose', () => {
    expect(() => endpoint.validatePlan({ routeName: 'x', endpointName: 'X', method: 'POST', script: 'orders' }, { creating: true }))
      .toThrow('authentication.enabled');
  });

  test('refuses unknown fields, bad methods and bad role ids', () => {
    expect(() => endpoint.validatePlan({ routeName: 'x', url: 'y' }, { creating: false })).toThrow('Unknown plan field');
    expect(() => endpoint.validatePlan({ routeName: 'x', method: 'PATCH' }, { creating: false })).toThrow('method');
    expect(() => endpoint.validatePlan({ routeName: 'x', authentication: { enabled: true, requiredRoles: ['admin'] } }, { creating: false })).toThrow('requiredRoles');
  });

  test('the callable URL uses the lowercase verb', () => {
    expect(endpoint.endpointUrl(D, 'POST', 'orders-push')).toBe(`https://${D}/v2/endpoint/post/orders-push`);
  });
});

describe('preview and apply', () => {
  test('preview of a new endpoint resolves the script by code and writes nothing', async () => {
    const code = await run(['preview', D, plan({ endpointName: 'Orders push', method: 'post', script: 'orders', authentication: { enabled: false } })]);
    expect(code).toBe(0);
    const res = json();
    expect(res.action).toBe('create');
    expect(res.changes).toMatchObject({ method: 'POST', script: SCRIPT, active: true, authentication: { enabled: false, requiredRoles: [] } });
    expect(res.url).toBe(`https://${D}/v2/endpoint/post/orders-push`);
    expect(res.warnings.join(' ')).toContain('Public');
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  test('a missing script is a blocker', async () => {
    const code = await run(['preview', D, plan({ endpointName: 'Orders push', method: 'POST', script: 'nope', authentication: { enabled: true } })]);
    expect(code).toBe(3);
    expect(json().blockers[0]).toContain('does not exist');
  });

  test('apply needs --confirmed and sends nothing without it', async () => {
    const code = await run(['apply', D, plan({ endpointName: 'Orders push', method: 'POST', script: 'orders', authentication: { enabled: true } })]);
    expect(code).toBe(2);
    expect(err).toContain('--confirmed');
    expect(calls).toHaveLength(0);
  });

  test('apply creates, then reads the endpoint back', async () => {
    const code = await run(['apply', D, plan({ endpointName: 'Orders push', method: 'POST', script: 'orders', authentication: { enabled: true } }), '--confirmed']);
    expect(code).toBe(0);
    const res = json();
    expect(res).toMatchObject({ saved: true, action: 'create', problems: [] });
    expect(res.endpoint.authentication.enabled).toBe(true);
    const post = calls.find((c) => c.method === 'POST');
    expect(post.body).toMatchObject({ routeName: 'orders-push', script: SCRIPT, authentication: { enabled: true } });
  });

  test('an update patches only what changed and sends authentication whole', async () => {
    state.endpoint = {
      _id: EP, endpointCode: 'ENP-1', endpointName: 'Orders push', routeName: 'orders-push', method: 'POST',
      script: OTHER_SCRIPT, active: true, authentication: { enabled: true, requiredRoles: [ROLE] }, updatedAt: 'T1',
    };
    const code = await run(['apply', D, plan({ script: 'orders', authentication: { enabled: false } }), '--confirmed']);
    expect(code).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.body).toEqual({ script: SCRIPT, authentication: { enabled: false, requiredRoles: [ROLE] } });
    expect(json().warnings.join(' ')).toContain('requiredRoles is ignored');
  });

  test('nothing to change means no write', async () => {
    state.endpoint = {
      _id: EP, endpointName: 'Orders push', routeName: 'orders-push', method: 'POST', script: SCRIPT, active: true,
      authentication: { enabled: true, requiredRoles: [] },
    };
    const code = await run(['apply', D, plan({ authentication: { enabled: true } }), '--confirmed']);
    expect(code).toBe(0);
    expect(json().action).toBe('none');
    expect(calls.some((c) => c.method === 'PATCH' || c.method === 'POST')).toBe(false);
  });

  test('warns about a dev script', async () => {
    await run(['preview', D, plan({ endpointName: 'Orders push', method: 'POST', script: 'orders-dev', authentication: { enabled: true } })]);
    expect(json().warnings.join(' ')).toContain('dev copy');
  });
});

describe('call', () => {
  beforeEach(() => {
    state.endpoint = {
      _id: EP, endpointName: 'Orders push', routeName: 'orders-push', method: 'POST', script: SCRIPT, active: true,
      authentication: { enabled: true, requiredRoles: [] },
    };
  });

  test('refuses to run the script without --confirmed', async () => {
    expect(await run(['call', D, 'orders-push'])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('without auth sends no Authorization header and reports the 401', async () => {
    const code = await run(['call', D, 'orders-push', '--no-auth', '--data', '{"a":1}', '--confirmed']);
    expect(code).toBe(1);
    const sent = calls.find((c) => c.path === '/v2/endpoint/post/orders-push');
    expect(sent.headers.Authorization).toBeUndefined();
    expect(json().status).toBe(401);
  });

  test('with auth uses the verb of the endpoint, sends the key and never prints it', async () => {
    const code = await run(['call', D, 'orders-push', '--data', '{"a":1}', '--header', 'x-hook-secret: s3', '--confirmed']);
    expect(code).toBe(0);
    const sent = calls.find((c) => c.path === '/v2/endpoint/post/orders-push');
    expect(sent.method).toBe('POST');
    expect(sent.headers.Authorization).toBe('Bearer SECRET123');
    expect(sent.headers['x-hook-secret']).toBe('s3');
    expect(out).not.toContain('SECRET123');
    expect(json().body.output.apiKey).toBe('***');
  });

  test('refuses to set Authorization or a body on GET by hand', async () => {
    expect(await run(['call', D, 'orders-push', '--header', 'Authorization: Bearer x', '--confirmed'])).toBe(2);
    expect(await run(['call', D, 'orders-push', '--method', 'GET', '--data', '{}', '--confirmed'])).toBe(2);
  });

  test('a verb that does not match the URL segment is explained', () => {
    expect(endpoint.hintFor(404, '<pre>Cannot POST</pre>')).toContain('verb');
    expect(endpoint.hintFor(404, { error: 'Not found' })).toContain('case-sensitive');
  });
});
