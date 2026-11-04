/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ui = require('../.claude/skills/prolibu-ui-customization/scripts/ui');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-987654';
const ME = 'a'.repeat(24);
const SELLER = 'b'.repeat(24);
const OTHER = 'c'.repeat(24);
const STAGE_WON = '1'.repeat(24);
const STAGE_LOST = '2'.repeat(24);
const COLS = '3'.repeat(24);
const NOW = new Date('2026-11-03T15:00:00Z');

let rootDir;
let calls;
let state;
let seq;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const newId = () => `9${String(seq++).padStart(23, '0')}`;

const SCHEMAS = {
  Deal: {
    dealName: { type: 'string' },
    stage: { type: 'objectid', ref: 'Stage' },
    assignee: { type: 'objectid', ref: 'User' },
    createdAt: { type: 'date' },
    priority: { type: 'string', enum: ['Low', 'High'] },
    proposal: { quote: { type: 'mixed' }, title: { type: 'string' } },
    tracking: { totalViews: { type: 'number' } },
    contact: { type: 'objectid', ref: 'Contact' },
    files: { type: ['objectid'], ref: 'File' },
  },
  Contact: { email: { type: 'string' }, firstName: { type: 'string' } },
  Stage: { stageName: { type: 'string' }, stageCode: { type: 'string' } },
  User: { email: { type: 'string' } },
};

function getPath(record, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), record);
}

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    const field = getPath(record, k);
    if (v && typeof v === 'object' && v.$in) return v.$in.map(String).includes(String(field));
    return String(field) === String(v);
  });
}

function profileOf(init) {
  return init.headers.Authorization === `Bearer ${SELLER_KEY}` ? 'seller' : 'admin';
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const who = profileOf(init);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, who });
  const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
  if (u.pathname === '/v2/user/me') {
    return respond(200, {
      profile: who === 'seller' ? { _id: SELLER, email: 'seller@example.com' } : { _id: ME, email: 'me@example.com', isAdmin: true, apiKey: KEY },
      modelSchemas: SCHEMAS,
      uiSchemas: { sideBar: { Directory: { Contacts: { modelName: 'Contact' } }, SalesAndMarketing: { Deals: { modelName: 'Deal' } } } },
      permissions: who === 'seller' ? ['Resource@CustomUi.find', 'Resource@CustomFilter.create', 'Resource@CustomFilter.search'] : [],
    });
  }
  if (u.pathname === '/v2/user') {
    if (who === 'seller') return respond(403, { error: 'Forbidden.' });
    return respond(200, { data: state.users.filter((x) => matches(x, xq)), pagination: { count: state.users.length } });
  }
  if (u.pathname === '/v2/stage') return respond(200, { data: state.stages.filter((x) => matches(x, xq)) });
  if (u.pathname === '/v2/deal') return respond(200, { data: [], pagination: { count: 4 } });
  const m = u.pathname.match(/^\/v2\/(customui|customfilter)(?:\/([^/]+))?$/);
  if (m) {
    const coll = state[m[1]];
    const ref = m[2] && decodeURIComponent(m[2]);
    const find = () => coll.find((r) => r._id === ref || r.customUiCode === ref || r.customFilterCode === ref);
    if (init.method === 'GET' && ref === 'search') return respond(200, { data: coll.filter((r) => matches(r, xq)) });
    if (init.method === 'GET' && ref) return find() ? respond(200, find()) : respond(404, { error: 'Not found.' });
    if (init.method === 'GET') return respond(200, { data: coll, pagination: { count: coll.length } });
    if (state.forbidWrites) return respond(403, { error: 'Forbidden.' });
    if (init.method === 'POST') {
      const rec = {
        _id: newId(), ...body, createdBy: who === 'seller' ? SELLER : ME, updatedAt: `U${seq++}`,
      };
      if (m[1] === 'customui') rec.customUiCode = `customUi${seq}`;
      else rec.customFilterCode = `CSF-${seq}`;
      coll.push(rec);
      return respond(200, rec);
    }
    if (init.method === 'PATCH') {
      const rec = find();
      if (!rec) return respond(404, { error: 'Not found.' });
      Object.assign(rec, body, { updatedAt: `U${seq++}` });
      return respond(200, rec);
    }
  }
  return respond(404, { error: `no fake for ${init.method} ${u.pathname}` });
}

async function run(args, opts = {}) {
  let stdout = '';
  let stderr = '';
  const code = await ui.main(args, {
    rootDir, fetchImpl: fakeFetch, now: NOW, stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } }, ...opts,
  });
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch { /* not json */ }
  return {
    code, stdout, stderr, json,
  };
}

async function previewThenApply(plan, extra = []) {
  const p = await run(['preview', D, JSON.stringify(plan)]);
  expect(p.code).toBe(0);
  const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed', ...extra]);
  return { p, a };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  seq = 1;
  state = {
    users: [{ _id: ME, email: 'me@example.com' }, { _id: OTHER, email: 'ana@example.com' }],
    stages: [{ _id: STAGE_WON, stageCode: 'deal-won', stageName: 'Won' }, { _id: STAGE_LOST, stageCode: 'deal-lost', stageName: 'Lost' }],
    customui: [],
    customfilter: [],
  };
});

afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('pure rules', () => {
  test('walkSchema follows nested objects and refs, and rejects unknown fields', () => {
    expect(ui.walkSchema(SCHEMAS, 'Deal', 'proposal.quote').ok).toBe(true);
    expect(ui.walkSchema(SCHEMAS, 'Deal', 'stage.stageName').ok).toBe(true);
    expect(ui.walkSchema(SCHEMAS, 'Deal', 'stage').ref).toBe('Stage');
    expect(ui.walkSchema(SCHEMAS, 'Deal', 'valor').ok).toBe(false);
    expect(ui.walkSchema(SCHEMAS, 'Deal', 'dealName.x').ok).toBe(false);
  });

  test('checkUrl refuses script and plain http, and normalizes a bare host', () => {
    expect(() => ui.checkUrl('javascript:alert(1)')).toThrow(/refused/);
    expect(() => ui.checkUrl('JaVaScRiPt:alert(1)')).toThrow(/refused/);
    expect(() => ui.checkUrl('data:text/html,x')).toThrow(/refused/);
    expect(() => ui.checkUrl('http://example.com')).toThrow(/https/);
    expect(() => ui.checkUrl('https://u:p@example.com')).toThrow(/credentials/);
    expect(() => ui.checkUrl('//evil.example.com')).toThrow();
    expect(ui.checkUrl('example.com/docs')).toEqual({ url: 'https://example.com/docs', external: true, host: 'example.com' });
    expect(ui.checkUrl('/deals')).toEqual({ url: '/deals', external: false, host: null });
  });

  test('lintQuery blocks several operators in one object, unknown operators, fields and enum values', () => {
    const blockers = [];
    const warnings = [];
    ui.lintQuery({
      createdAt: { $gte: '2026-11-01', $lt: '2026-12-01' }, $where: '1', valor: 1, priority: 'Mid', dealName: { $regex: 'a', $options: 'i' },
    }, SCHEMAS, 'Deal', blockers, warnings);
    expect(blockers.join(' ')).toMatch(/2 operators/);
    expect(blockers.join(' ')).toMatch(/\$where/);
    expect(blockers.join(' ')).toMatch(/no field "valor"/);
    expect(blockers.join(' ')).toMatch(/"Mid" is not one of/);
    expect(blockers.join(' ')).toMatch(/\(\?i\)/);
  });

  test('lintQuery accepts the app shape and warns that dates are fixed', () => {
    const blockers = [];
    const warnings = [];
    const refs = ui.lintQuery({
      stage: { $nin: [STAGE_WON] }, $and: [{ createdAt: { $gte: '2026-11-01' } }, { createdAt: { $lt: '2026-12-01' } }],
    }, SCHEMAS, 'Deal', blockers, warnings);
    expect(blockers).toEqual([]);
    expect(refs).toEqual([{ field: 'stage', ref: 'Stage', id: STAGE_WON }]);
    expect(warnings.join(' ')).toMatch(/fixed days/);
  });

  test('date presets give day keys with $lt of the next period, one operator per entry', () => {
    expect(ui.dateClauses([{ field: 'createdAt', preset: 'thisMonth' }], NOW)).toEqual([
      { createdAt: { $gte: '2026-11-01' } }, { createdAt: { $lt: '2026-12-01' } }]);
    expect(ui.dateClauses([{ field: 'createdAt', from: '2026-10-01', to: '2026-10-31' }], NOW)).toEqual([
      { createdAt: { $gte: '2026-10-01' } }, { createdAt: { $lt: '2026-11-01' } }]);
    expect(() => ui.dateClauses([{ field: 'createdAt', preset: 'nextDecade' }], NOW)).toThrow(/Unknown date preset/);
  });

  test('generated row action code starts with the V2 marker and only opens the link', () => {
    const code = ui.rowActionCode('https://example.com/x?e={{email}}');
    expect(code.split('\n')[0]).toMatch(/^\/\/ CustomUi v2/);
    expect(code).toMatch(/ctx\.openUrl\(url\)/);
    expect(code).toMatch(/encodeURIComponent/);
    expect(ui.reviewCode(code).runsInV2).toBe(true);
  });

  test('conflicts names the newest default per model as the winner', () => {
    const recs = [
      { _id: 'old', customUiType: 'Default Table Columns', defaultColumns: { modelName: 'Deal' }, updatedAt: '2026-01-01' },
      { _id: 'new', customUiType: 'Default Table Columns', defaultColumns: { modelName: 'Deal' }, updatedAt: '2026-02-01' },
    ];
    expect(ui.conflicts(recs)).toEqual([{ place: 'columns:Deal', wins: 'new', ignored: ['old'] }]);
  });
});

describe('saved filters', () => {
  const plan = {
    kind: 'filter',
    set: {
      name: 'qa-skills mine open', model: 'Deal', query: { assignee: { $in: ['$me'] }, stage: { $nin: ['deal-won', 'deal-lost'] } }, dates: [{ field: 'createdAt', preset: 'thisMonth' }], shared: true,
    },
  };

  test('preview resolves $me and stage codes to ids, warns about shared fixed values, writes nothing', async () => {
    const r = await run(['preview', D, JSON.stringify(plan)]);
    expect(r.code).toBe(0);
    expect(writes()).toEqual([]);
    expect(r.json.body.filter.assignee).toEqual({ $in: [ME] });
    expect(r.json.body.filter.stage).toEqual({ $nin: [STAGE_WON, STAGE_LOST] });
    expect(r.json.body.filter.$and).toHaveLength(2);
    expect(r.json.body.allowEveryone).toEqual({ view: true, edit: false });
    expect(r.json.warnings.join(' ')).toMatch(/YOUR records/);
    expect(r.json.warnings.join(' ')).toMatch(/fixed days/);
    expect(r.json.matchesForThisProfile).toEqual({ count: 4 });
    expect(r.json.nextStep).toMatch(/STOP HERE/);
  });

  test('apply needs the preview version and --confirmed, then creates and reads back', async () => {
    const noConfirm = await run(['apply', D, JSON.stringify(plan), '--version', 'x']);
    expect(noConfirm.code).toBe(2);
    const stale = await run(['apply', D, JSON.stringify(plan), '--version', 'stale', '--confirmed']);
    expect(stale.code).toBe(3);
    expect(writes()).toEqual([]);
    const { a } = await previewThenApply(plan);
    expect(a.code).toBe(0);
    expect(a.json.saved).toBe(true);
    const post = writes()[0];
    expect(post.method).toBe('POST');
    expect(post.path).toBe('/v2/customfilter');
    expect(post.body.modelName).toBe('Deal');
  });

  test('a filter editable by everyone is refused', async () => {
    const r = await run(['preview', D, JSON.stringify({ ...plan, set: { ...plan.set, editableByAll: true } })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/refused/);
  });

  test('an unknown stage code is blocked before anything is written', async () => {
    const r = await run(['preview', D, JSON.stringify({ ...plan, set: { ...plan.set, query: { stage: 'deal-nope' } } })]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/No Stage with stageCode "deal-nope"/);
  });

  test('a filter this profile cannot see explains why instead of failing', async () => {
    const r = await run(['filter', D, 'CSF-404', '--profile', 'seller']);
    expect(r.code).toBe(0);
    expect(r.json.visible).toBe(false);
    expect(r.json.explain).toMatch(/not shared/);
  });

  test('"id" inside "set" is a usage error with a hint', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'filter', set: { id: 'CSF-1', shared: true } })]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/top of the plan/);
  });

  test('editing sends only changed fields and replaces the whole filter', async () => {
    state.customfilter.push({
      _id: 'f'.repeat(24), customFilterCode: 'CSF-1', customFilterName: 'Old', modelName: 'Deal', filter: { assignee: ME }, allowEveryone: { view: false, edit: false }, createdBy: ME, updatedAt: 'U0',
    });
    const { a } = await previewThenApply({ kind: 'filter', id: 'CSF-1', set: { query: { stage: STAGE_WON } } });
    expect(a.code).toBe(0);
    const patch = writes()[0];
    expect(patch.method).toBe('PATCH');
    expect(Object.keys(patch.body)).toEqual(['filter']);
    expect(patch.body.filter).toEqual({ stage: STAGE_WON });
  });

  test('a 403 on write prints FORBIDDEN and stops without retrying', async () => {
    state.forbidWrites = true;
    const p = await run(['preview', D, JSON.stringify(plan)]);
    const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(a.code).toBe(1);
    expect(a.stderr).toMatch(/^FORBIDDEN:/);
    expect(writes()).toHaveLength(1);
  });
});

describe('CustomUi', () => {
  test('columns update the default the app already uses instead of adding a second one', async () => {
    state.customui.push({
      _id: COLS, customUiCode: 'cu1', customUiName: 'Default Columns - Deal', customUiType: 'Default Table Columns', active: true, defaultColumns: { modelName: 'Deal', columns: [{ name: 'dealName' }] }, updatedAt: 'U0',
    });
    const plan = { kind: 'columns', model: 'Deal', columns: ['dealName', 'stage', { path: 'proposal.quote', name: 'proposal', width: 200 }, 'tracking.totalViews'] };
    const { p, a } = await previewThenApply(plan);
    expect(p.json.target).toEqual({ action: 'update', _id: COLS, name: 'Default Columns - Deal' });
    expect(p.json.warnings.join(' ')).toMatch(/Restablecer/);
    expect(a.code).toBe(0);
    const patch = writes()[0];
    expect(patch.method).toBe('PATCH');
    expect(patch.body.defaultColumns.columns).toEqual([
      { name: 'dealName', width: 180, stickyColumn: true },
      { name: 'stage', width: 180 },
      { name: 'proposal', width: 200, path: 'proposal.quote' },
      { name: 'totalViews', width: 180, path: 'tracking.totalViews', selectKey: 'tracking' },
    ]);
  });

  test('columns with an unknown field are blocked', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'columns', model: 'Deal', columns: ['dealName', 'valor'] })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/no field "valor"/);
  });

  test('an unknown object is blocked', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'columns', model: 'Deals', columns: ['dealName'] })]);
    expect(r.code).toBe(3);
  });

  test('a row action link reports host, fields sent out and audience; record values never go in the host', async () => {
    const plan = {
      kind: 'rowAction', model: 'Contact', label: 'Open', openUrl: 'https://example.com/x?e={{email}}', audience: { users: ['ana@example.com'] },
    };
    const { p, a } = await previewThenApply(plan);
    expect(p.json.opens).toBe('example.com');
    expect(p.json.dataSentOut).toEqual(['email']);
    expect(p.json.recipients.everyone).toBe(false);
    expect(p.json.body.allowEveryone).toEqual({ view: false, edit: false });
    expect(p.json.body.assignee).toBe(OTHER);
    expect(a.code).toBe(0);
    const bad = await run(['preview', D, JSON.stringify({ ...plan, openUrl: 'https://{{email}}.example.com/' })]);
    expect(bad.code).toBe(3);
    expect(bad.json.blockers.join(' ')).toMatch(/never in its host/);
  });

  test('a sidebar link to everyone counts the users who get it; javascript: is refused', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'sidebar', set: { label: 'Docs', url: 'example.com/docs', insertBefore: 'Directory' } })]);
    expect(r.code).toBe(0);
    expect(r.json.recipients).toMatchObject({ everyone: true, users: 2 });
    expect(r.json.body.sideBar).toEqual({
      label: 'Docs', url: 'https://example.com/docs', target: '_blank', insertBefore: 'Directory',
    });
    const js = await run(['preview', D, JSON.stringify({ kind: 'sidebar', set: { label: 'x', url: 'javascript:alert(1)' } })]);
    expect(js.code).toBe(3);
  });

  test('hand-written code needs the V2 marker, no sandbox escape, and --runs-code on apply', async () => {
    const noMarker = await run(['preview', D, JSON.stringify({
      kind: 'cellWidget', model: 'Deal', field: 'stage', code: '<template><b>x</b></template>',
    })]);
    expect(noMarker.code).toBe(3);
    const escape = await run(['preview', D, JSON.stringify({
      kind: 'rowAction', model: 'Deal', label: 'x', code: '// CustomUi v2\nconst F = ({}).constructor.constructor;',
    })]);
    expect(escape.json.blockers.join(' ')).toMatch(/sandbox/);
    const plan = {
      kind: 'cellWidget', model: 'Deal', field: 'stage', code: '// CustomUi v2\n<template><b>{{ value }}</b></template>',
    };
    const p = await run(['preview', D, JSON.stringify(plan)]);
    expect(p.json.runsCode).toBe(true);
    expect(p.json.nextStep).toMatch(/--runs-code/);
    const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(a.code).toBe(3);
    expect(writes()).toEqual([]);
    const ok = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed', '--runs-code']);
    expect(ok.code).toBe(0);
  });

  test('deactivate sets active false and reads it back', async () => {
    state.customui.push({
      _id: COLS, customUiCode: 'cu1', customUiName: 'x', customUiType: 'Sidebar', active: true, sideBar: { url: '/x', label: 'x' }, updatedAt: 'U0',
    });
    const { a } = await previewThenApply({ kind: 'deactivate', id: COLS });
    expect(a.code).toBe(0);
    expect(writes()[0].body).toEqual({ active: false });
    expect(state.customui[0].active).toBe(false);
  });

  test('a seller without CustomUi write permission gets FORBIDDEN before any lookup or write', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'sidebar', set: { label: 'x', url: '/x' } }), '--profile', 'seller']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^FORBIDDEN:/);
    expect(calls.map((c) => c.path)).toEqual(['/v2/user/me']);
  });

  test('the API key never reaches the output', async () => {
    const r = await run(['ui', D]);
    expect(r.stdout + r.stderr).not.toContain(KEY);
    const me = await run(['fields', D, 'Deal', '--search', 'stage']);
    expect(me.stdout).not.toContain(KEY);
    expect(me.json.fields.map((f) => f.path)).toEqual(['stage']);
  });
});
