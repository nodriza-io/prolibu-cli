/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const promote = require('../.claude/skills/prolibu-config-promotion/scripts/promote');

const SRC = 'dev99.example.com';
const STG = 'stg.example.com';
const PROD = 'acme.example.com';
const SECRET_VAR = 'var-secret-value-123456';
const SECRET_HEADER = 'header-secret-value-987654';
const FORM_PASSWORD = 'form-pass-555';

let rootDir;
let tmp;
let out;
let err;
let calls;
let db;
let seq;

const id = (n) => n.toString(16).padStart(24, '0');
const newId = () => { seq += 1; return id(0xa00000 + seq); };

function respond(status, body) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

// One in-memory account per host. Lists honor a single-field xquery equality (and drop unknown
// fields like the server does), reads by id, POST and PATCH (plain objects merge, the rest replaces).
const MERGED = ['authentication', 'access', 'thankYou', 'submissions', 'uploads', 'allowEveryone'];
function account(seed) {
  return {
    prefs: { integrations: { lifecycleHooks: { enabled: true, enabledEntities: ['Contact'] } } },
    columns: { Contact: ['_id', 'email', 'firstName'], Task: ['_id', 'title', 'description'] },
    forbidden: [],
    ...seed,
  };
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const acc = db[u.host];
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ host: u.host, method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const parts = u.pathname.split('/').filter(Boolean); // v2, model, id
  const model = parts[1];
  if (acc.forbidden.includes(model)) return respond(403, { statusCode: 403, error: 'Forbidden' });
  if (u.pathname === '/v2/preference/read') return respond(200, { preference: acc.prefs });
  if (u.pathname === '/v2/service/getschema') {
    const m = u.searchParams.get('modelNames');
    if (u.searchParams.get('type') === 'attrs' && m === 'Webhook') return respond(200, { Webhook: { eventNames: { enum: ['Contact.create', 'Contact.update', 'Deal.update'] } } });
    return acc.columns[m] ? respond(200, acc.columns[m]) : respond(404, { statusCode: 404, error: 'Model does not exist' });
  }
  if (model === 'form' && parts[2] === 'getmodelfields') {
    return respond(200, (acc.columns[parts[3]] || []).map((p) => ({ attrPath: p, type: 'string' })));
  }
  const rows = acc[model] || [];
  if (init.method === 'GET' && parts.length === 2) {
    let list = rows;
    const xq = u.searchParams.get('xquery');
    if (xq) {
      const q = JSON.parse(xq);
      const [k, v] = Object.entries(q)[0];
      if (rows.length && typeof v === 'string' && rows.some((r) => k in r)) list = rows.filter((r) => r[k] === v);
    }
    return respond(200, { pagination: { count: list.length }, data: list });
  }
  if (init.method === 'GET' && parts.length === 3) {
    const r = rows.find((x) => x._id === parts[2]);
    return r ? respond(200, r) : respond(404, { statusCode: 404, error: 'Not found' });
  }
  if (init.method === 'POST' && parts.length === 2) {
    const rec = { _id: newId(), ...body, updatedAt: `T${seq}` };
    acc[model] = [...rows, rec];
    return respond(201, rec);
  }
  if (init.method === 'PATCH' && parts.length === 3) {
    const r = rows.find((x) => x._id === parts[2]);
    if (!r) return respond(404, { statusCode: 404, error: 'Not found' });
    for (const [k, v] of Object.entries(body)) r[k] = MERGED.includes(k) && r[k] ? { ...r[k], ...v } : v;
    seq += 1;
    r.updatedAt = `T${seq}`;
    return respond(200, r);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => promote.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = (host) => calls.filter((c) => c.host === host && c.method !== 'GET');

const USER = id(1);
const T_USER = id(101);
const SCRIPT = id(2);
const ENDPOINT = id(3);
const STAGE = id(4);
const T_STAGE = id(104);
const FILE = id(5);

function seed() {
  db = {
    [SRC]: account({
      user: [{ _id: USER, email: 'ana@example.com' }],
      stage: [{ _id: STAGE, stageCode: 'task-todo', stageName: 'To do', stageType: 'Task.stage', protected: '-requiredFields', requiredFields: ['description'], updatedAt: 'S1' }],
      file: [{ _id: FILE, fileName: 'icon.png' }],
      script: [{
        _id: SCRIPT, scriptCode: 'orders-dev', scriptName: 'Orders', active: true, lifecycleHooks: [], code: 'output = 1;',
        variables: [{ key: 'hmac', value: SECRET_VAR }], collaborators: [USER], updatedAt: 'S2',
      }],
      endpoint: [{
        _id: ENDPOINT, endpointCode: 'ENP-1', routeName: 'orders', endpointName: 'Orders', method: 'POST', script: SCRIPT,
        active: true, authentication: { enabled: true, requiredRoles: [] }, updatedAt: 'S3',
      }],
      customfilter: [{ _id: id(6), customFilterCode: 'my-tasks', customFilterName: 'My tasks', modelName: 'Task', filter: { stage: { $in: [STAGE] }, assignee: USER }, updatedAt: 'S4' }],
      webhook: [{
        _id: id(7), webhookCode: 'WHK-1', webhookName: 'CRM', endpoint: 'https://hooks.example.com/in', eventNames: ['Contact.create'],
        headers: [{ name: 'X-Signature', value: SECRET_HEADER }], active: true, updatedAt: 'S5',
      }],
      form: [{
        _id: id(8), formCode: 'contact-form', formName: 'Contact', type: 'web', active: true,
        access: { mode: 'password', password: FORM_PASSWORD, serviceCredential: id(9) },
        formSchema: { email: { type: 'String', format: 'email', label: 'E-mail', required: true } },
        mappings: [{ modelName: 'Contact', action: 'create', fieldMap: { email: 'email' } }],
        submissions: { persist: true, notifyOnSubmit: [USER] }, updatedAt: 'S6',
      }],
      customui: [{ _id: id(10), customUiCode: 'side', customUiName: 'Side', customUiType: 'Sidebar', active: true, sideBar: { icon: FILE, label: 'X' }, updatedAt: 'S7' }],
      customfield: [{ _id: id(11), objectAssigned: 'Deal', customFields: { color: { type: 'string' }, size: { type: 'string' } }, updatedAt: 'S8' }],
      messagetemplate: [],
    }),
    [STG]: account({ user: [{ _id: T_USER, email: 'ana@example.com' }], stage: [{ _id: T_STAGE, stageCode: 'task-todo', stageName: 'To do', stageType: 'Task.stage', requiredFields: [], updatedAt: 'U1' }] }),
    [PROD]: account({ user: [{ _id: T_USER, email: 'ana@example.com' }], stage: [{ _id: T_STAGE, stageCode: 'task-todo', stageName: 'To do', stageType: 'Task.stage', requiredFields: [], updatedAt: 'U1' }] }),
  };
}

async function exportBundle(items, extra = {}) {
  out = '';
  const file = path.join(tmp, `bundle-${Date.now()}-${Math.random()}.json`);
  const code = await run(['export', SRC, JSON.stringify({ items, ...extra }), '--out', file]);
  expect(code).toBe(0);
  out = '';
  calls = [];
  return file;
}

async function previewJson(host, bundle, more = []) {
  out = '';
  const code = await run(['preview', host, bundle, ...more]);
  return { code, plan: out ? json() : null };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-promo-root-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-promo-tmp-'));
  for (const d of [SRC, STG, PROD]) {
    fs.mkdirSync(path.join(rootDir, 'accounts', d), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'accounts', d, 'profile.json'), JSON.stringify({ apiKey: `KEY-${d}` }));
  }
  out = '';
  err = '';
  calls = [];
  seq = 0;
  seed();
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('export', () => {
  test('never writes secrets to the bundle or the output, and lists them as set by hand', async () => {
    const file = path.join(tmp, 'b.json');
    const code = await run(['export', SRC, JSON.stringify({ items: [{ kind: 'endpoint', key: 'orders' }, { kind: 'webhook', key: 'WHK-1' }, { kind: 'form', key: 'contact-form' }] }), '--out', file]);
    expect(code).toBe(0);
    const text = fs.readFileSync(file, 'utf8') + out;
    for (const secret of [SECRET_VAR, SECRET_HEADER, FORM_PASSWORD, `KEY-${SRC}`]) expect(text).not.toContain(secret);
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    const script = bundle.objects.find((o) => o.kind === 'script');
    expect(script.data.variables).toEqual(['hmac']);
    expect(script.setByHand.join(' ')).toMatch(/hmac/);
    const webhook = bundle.objects.find((o) => o.kind === 'webhook');
    expect(webhook.data.headers).toEqual(['X-Signature']);
    expect(webhook.data.endpoint).toBeUndefined();
    const form = bundle.objects.find((o) => o.kind === 'form');
    expect(form.data.access.password).toBeUndefined();
    expect(form.data.access.serviceCredential).toBeUndefined();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('pulls the endpoint\'s script in as a dependency and rewrites ids as stable keys', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }, { kind: 'customFilter', key: 'my-tasks' }]);
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(bundle.objects.map((o) => o.kind)).toEqual(['script', 'customFilter', 'endpoint']);
    const ep = bundle.objects.find((o) => o.kind === 'endpoint');
    expect(ep.data.script.$ref).toMatchObject({ model: 'Script', value: 'orders-dev' });
    const cf = bundle.objects.find((o) => o.kind === 'customFilter');
    expect(cf.data.filter.stage.$in[0].$ref).toMatchObject({ model: 'Stage', value: 'task-todo' });
    expect(cf.data.filter.assignee.$ref).toMatchObject({ model: 'User', value: 'ana@example.com' });
    expect(JSON.stringify(bundle.objects)).not.toMatch(/"[a-f0-9]{24}"/);
  });

  test('strips source files and reports ids it cannot identify', async () => {
    db[SRC].customfilter[0].filter.other = id(77);
    const file = await exportBundle([{ kind: 'customUi', key: 'side' }, { kind: 'customFilter', key: 'my-tasks' }]);
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ui = bundle.objects.find((o) => o.kind === 'customUi');
    expect(ui.data.sideBar.icon).toBeUndefined();
    expect(ui.setByHand.join(' ')).toMatch(/re-upload/);
    expect(bundle.objects.find((o) => o.kind === 'customFilter').unresolved).toEqual([`filter.other = ${id(77)}`]);
  });

  test('a 403 stops with FORBIDDEN and no retry', async () => {
    db[SRC].forbidden = ['endpoint'];
    const code = await run(['export', SRC, '{"items":[{"kind":"endpoint","key":"orders"}]}', '--out', path.join(tmp, 'x.json')]);
    expect(code).toBe(1);
    expect(err).toMatch(/^FORBIDDEN/);
    expect(calls.filter((c) => c.path.startsWith('/v2/endpoint'))).toHaveLength(1);
  });

  test('refuses a bundle path outside the temp folders', async () => {
    const code = await run(['export', SRC, '{"items":[{"kind":"endpoint","key":"orders"}]}', '--out', path.join(rootDir, 'accounts', SRC, 'b.json')]);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('preview and apply', () => {
  test('creates the script before the endpoint and binds the endpoint to the new script', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    const map = JSON.stringify({ 'script:orders-dev': 'orders' });
    const { code, plan } = await previewJson(STG, file, ['--map', map]);
    expect(code).toBe(0);
    expect(plan.totals).toMatchObject({ create: 2, blocked: 0 });
    expect(plan.steps.find((s) => s.kind === 'endpoint').changes.find((c) => c.field === 'script').after).toBe('<new script:orders>');
    expect(plan.nextStep).toMatch(/STOP HERE/);
    expect(writes(STG)).toHaveLength(0);

    out = '';
    expect(await run(['apply', STG, file, '--map', map, '--version', plan.version, '--confirmed'])).toBe(0);
    const res = json();
    expect(res.saved).toBe(true);
    const [scriptPost, endpointPost] = writes(STG);
    expect(scriptPost.path).toBe('/v2/script');
    expect(scriptPost.body.scriptCode).toBe('orders');
    expect(scriptPost.body.variables).toEqual([{ key: 'hmac', value: '' }]);
    expect(scriptPost.body.collaborators).toEqual([T_USER]);
    const newScript = db[STG].script[0]._id;
    expect(endpointPost.body.script).toBe(newScript);
    expect(endpointPost.body.endpointCode).toBeUndefined();

    calls = [];
    const again = await previewJson(STG, file, ['--map', map]);
    expect(again.plan.totals).toMatchObject({ create: 0, update: 0, same: 2 });
  });

  test('apply needs --version and --confirmed, and refuses a stale version', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    const { plan } = await previewJson(STG, file);
    expect(await run(['apply', STG, file, '--version', plan.version])).toBe(2);
    expect(await run(['apply', STG, file, '--confirmed'])).toBe(2);
    db[STG].script = [{ _id: id(200), scriptCode: 'orders-dev', scriptName: 'x', code: '', updatedAt: 'Z' }];
    expect(await run(['apply', STG, file, '--version', plan.version, '--confirmed'])).toBe(3);
    expect(err).toMatch(/changed since the preview/);
    expect(writes(STG)).toHaveLength(0);
  });

  test('an update keeps the target\'s variables and only sends what changed', async () => {
    db[STG].script = [{ _id: id(201), scriptCode: 'orders-dev', scriptName: 'Old name', active: true, lifecycleHooks: [], code: 'output = 1;', variables: [{ key: 'hmac', value: 'prod-value' }], collaborators: [T_USER], updatedAt: 'U9' }];
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }], { dependencies: true });
    const { plan } = await previewJson(STG, file);
    const step = plan.steps.find((s) => s.kind === 'script');
    expect(step.action).toBe('update');
    expect(step.changes.map((c) => c.field)).toEqual(['scriptName']);
    out = '';
    await run(['apply', STG, file, '--version', plan.version, '--confirmed']);
    const patch = writes(STG).find((c) => c.method === 'PATCH');
    expect(patch.body).toEqual({ scriptName: 'Orders' });
    expect(db[STG].script[0].variables[0].value).toBe('prod-value');
  });

  test('blocks when a referenced user does not exist in the target', async () => {
    db[STG].user = [];
    const file = await exportBundle([{ kind: 'customFilter', key: 'my-tasks' }]);
    const { code, plan } = await previewJson(STG, file);
    expect(code).toBe(3);
    expect(plan.steps[0].action).toBe('blocked');
    expect(plan.steps[0].blockers.join(' ')).toMatch(/User email "ana@example.com".*does not exist in the target/);
  });

  test('resolves stage and user references to the target ids', async () => {
    const file = await exportBundle([{ kind: 'customFilter', key: 'my-tasks' }]);
    const { plan } = await previewJson(STG, file);
    out = '';
    await run(['apply', STG, file, '--version', plan.version, '--confirmed']);
    expect(writes(STG)[0].body.filter).toEqual({ stage: { $in: [T_STAGE] }, assignee: T_USER });
  });

  test('a webhook needs a target destination, is created off and without header values', async () => {
    const file = await exportBundle([{ kind: 'webhook', key: 'WHK-1' }]);
    let r = await previewJson(STG, file);
    expect(r.code).toBe(3);
    expect(r.plan.steps[0].blockers.join(' ')).toMatch(/--override/);
    r = await previewJson(STG, file, ['--override', '{"webhook:WHK-1":{"endpoint":"http://10.0.0.5/in"}}']);
    expect(r.code).toBe(3);
    const ov = '{"webhook:WHK-1":{"endpoint":"https://hooks.example.com/prod"}}';
    r = await previewJson(STG, file, ['--override', ov]);
    expect(r.code).toBe(0);
    out = '';
    await run(['apply', STG, file, '--override', ov, '--version', r.plan.version, '--confirmed']);
    const post = writes(STG)[0];
    expect(post.body.active).toBe(false);
    expect(post.body.headers).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(SECRET_HEADER);
    expect(json().setByHand.join(' ')).toMatch(/X-Signature/);
  });

  test('a script that runs by itself is created off; hooks off in the target block it', async () => {
    db[SRC].script[0].lifecycleHooks = ['Contact'];
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    let r = await previewJson(STG, file);
    expect(r.plan.steps[0].changes.find((c) => c.field === 'active').after).toBe(false);
    db[STG].prefs.integrations.lifecycleHooks.enabledEntities = [];
    r = await previewJson(STG, file);
    expect(r.code).toBe(3);
    expect(r.plan.steps[0].blockers.join(' ')).toMatch(/lifecycle hooks on for Contact/);
  });

  test('a stage whose required field the target lacks is blocked; a protected stage only takes unlocked fields', async () => {
    db[SRC].stage[0].requiredFields = ['customFields.budget'];
    const file = await exportBundle([{ kind: 'stage', key: 'task-todo' }]);
    let r = await previewJson(STG, file);
    expect(r.plan.steps[0].blockers.join(' ')).toMatch(/no field customFields.budget/);
    db[SRC].stage[0].requiredFields = ['description'];
    db[STG].stage[0].protected = '-requiredFields';
    const file2 = await exportBundle([{ kind: 'stage', key: 'task-todo' }]);
    r = await previewJson(STG, file2);
    expect(r.plan.steps[0].action).toBe('update');
    r = await previewJson(STG, file2, ['--override', '{"stage:task-todo":{"stageName":"Pendiente"}}']);
    expect(r.plan.steps[0].blockers.join(' ')).toMatch(/protected.*stageName/);
  });

  test('custom fields are compared field by field and never written', async () => {
    db[STG].customfield = [{ _id: id(300), objectAssigned: 'Deal', customFields: { color: { type: 'string' }, legacy: { type: 'string' } }, updatedAt: 'U3' }];
    const file = await exportBundle([{ kind: 'customField', key: 'Deal' }]);
    const { plan } = await previewJson(STG, file);
    const step = plan.steps[0];
    expect(step.exportOnly).toMatch(/restarts/);
    expect(step.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'customFields.size', change: 'missing in the target' }),
      expect.objectContaining({ field: 'customFields.legacy', change: 'only in the target' }),
    ]));
    expect(plan.totals).toMatchObject({ create: 0, update: 0, exportOnly: 1 });
    out = '';
    await run(['apply', STG, file, '--version', plan.version, '--confirmed']);
    expect(writes(STG)).toHaveLength(0);
  });

  test('a bundle edited after export is refused', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    b.objects[0].data.code = 'evil()';
    fs.writeFileSync(file, JSON.stringify(b));
    expect(await run(['preview', STG, file])).toBe(2);
    expect(err).toMatch(/edited after export/);
  });

  test('--map and --override must name objects in the bundle and cannot carry secrets', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    expect(await run(['preview', STG, file, '--map', '{"script:nope":"x"}'])).toBe(2);
    expect(await run(['preview', STG, file, '--override', '{"script:orders-dev":{"variables":[{"key":"a","value":"b"}]}}'])).toBe(2);
  });
});

describe('production guard', () => {
  test('preview warns loudly; apply refuses without --to-production and writes nothing', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    const { plan } = await previewJson(PROD, file);
    expect(plan.production).toBe(true);
    expect(plan.WARNING).toMatch(/PRODUCTION/);
    expect(plan.nextStep).toMatch(/--to-production/);
    calls = [];
    expect(await run(['apply', PROD, file, '--version', plan.version, '--confirmed'])).toBe(2);
    expect(err).toMatch(/--to-production/);
    expect(calls).toHaveLength(0);
    out = '';
    expect(await run(['apply', PROD, file, '--version', plan.version, '--confirmed', '--to-production'])).toBe(0);
    expect(writes(PROD).map((c) => c.path)).toEqual(['/v2/script', '/v2/endpoint']);
  });

  test('a non-production target needs no extra flag', async () => {
    const file = await exportBundle([{ kind: 'endpoint', key: 'orders' }]);
    const { plan } = await previewJson(STG, file);
    expect(plan.production).toBe(false);
    expect(plan.WARNING).toBeUndefined();
  });
});

describe('helpers', () => {
  test('merged sub-objects compare as a subset, everything else exactly', () => {
    expect(promote.sameValue('authentication', { enabled: true, requiredRoles: [] }, { enabled: true })).toBe(true);
    expect(promote.sameValue('filter', { a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(promote.sameValue('requiredFields', ['a', 'b'], ['a'])).toBe(false);
  });

  test('flags a key written in code and the source domain', () => {
    const fake = 'F'.repeat(24);
    const w = promote.contentWarnings('script x code', `const apiKey = "${fake}"; fetch("https://${SRC}/v2")`, SRC);
    expect(w).toHaveLength(2);
    expect(w.join(' ')).not.toContain(fake);
  });

  test('kinds lists custom fields and custom objects as export-only', async () => {
    await run(['kinds']);
    const kinds = json().kinds;
    expect(kinds.find((k) => k.kind === 'customField').applies).toBe(false);
    expect(kinds.find((k) => k.kind === 'cob').applies).toBe(false);
    expect(kinds.find((k) => k.kind === 'endpoint').applies).toBe(true);
  });
});
