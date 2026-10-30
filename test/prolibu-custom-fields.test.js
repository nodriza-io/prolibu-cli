/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cf = require('../.claude/skills/prolibu-custom-fields/scripts/customfields');

const D = 'dev99.example.com';
const DEAL_CF = 'a'.repeat(24);
const BOOT_MS = 25000;

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let state;
let clock;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function uptime(ms) {
  const s = Math.floor(ms / 1000);
  return `0d ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

// What a booting server does with the Custom Field records (verified in the server code):
// each active record is loaded; success writes a "Success" status, a failure switches it off.
function boot() {
  state.bootedAt = clock + 1000 + BOOT_MS;
  for (const record of state.records) {
    if (record.active === false) continue;
    if (state.loadFails) {
      record.status = 'Error: CastError: bad schema';
      record.active = false;
    } else {
      record.status = `Success: '${record.objectAssigned}' Custom fields loaded succesfully.`;
    }
  }
  if (state.staleLive) return;
  state.live = {};
  for (const record of state.records) {
    if (record.active === false) continue;
    const schema = { ...(state.native[record.objectAssigned] || {}) };
    for (const [k, v] of Object.entries(record.overrides || {})) schema[k] = { ...v, isCustomField: true };
    if (record.customFields) schema.customFields = record.customFields;
    state.live[record.objectAssigned] = schema;
  }
  for (const cob of state.cobs) if (!state.live[cob.modelName]) state.live[cob.modelName] = {};
}

function down() {
  return clock > state.restartAt && clock < state.bootedAt;
}

function write(record, body) {
  for (const key of ['customFields', 'overrides']) {
    if (key in body) {
      if (body[key] && Object.keys(body[key]).length) record[key] = JSON.parse(JSON.stringify(body[key]));
      else delete record[key];
    }
  }
  if (body.active !== undefined) record.active = body.active;
  record.updatedAt = new Date(clock).toISOString();
  state.restartAt = clock + 1000;
  boot();
}

// A fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (u.pathname === '/prlversion') {
    if (down()) throw new TypeError('fetch failed');
    const birth = state.bootedAt || 0;
    return respond(200, { uptime: uptime(clock - birth + 3600000 * (state.bootedAt ? 0 : 1)), podBirth: new Date(birth).toISOString() });
  }
  if (down()) throw new TypeError('fetch failed');
  const m = init.method;
  if (m === 'GET' && u.pathname === '/v2/customfield') return respond(200, { pagination: { count: state.records.length }, data: state.records });
  if (m === 'GET' && u.pathname.startsWith('/v2/customfield/')) {
    const record = state.records.find((r) => r._id === u.pathname.split('/').pop());
    return record ? respond(200, record) : respond(404, { error: 'Not found' });
  }
  if (m === 'GET' && u.pathname === '/v2/cob') return respond(200, { data: state.cobs });
  if (m === 'GET' && u.pathname === '/v2/user/me') return respond(200, { profile: {}, modelSchemas: state.live });
  if (m === 'GET' && u.pathname === '/v2/deal') {
    if (u.searchParams.get('xquery')) return respond(200, { pagination: { count: state.missing }, data: [] });
    return respond(200, { pagination: { count: state.dealValues.length }, data: state.dealValues.map((v) => ({ customFields: { code: v } })) });
  }
  if (m === 'GET' && u.pathname === '/v2/pet') return respond(200, { pagination: { count: 0 }, data: [] });
  if (m === 'PATCH' && u.pathname.startsWith('/v2/customfield/')) {
    if (state.patchStatus) return respond(state.patchStatus, { error: 'The type is required in customFields.' });
    const record = state.records.find((r) => r._id === u.pathname.split('/').pop());
    write(record, body);
    if (state.dropWrite) throw new TypeError('socket hang up');
    return respond(200, record);
  }
  if (m === 'POST' && u.pathname === '/v2/customfield') {
    const record = { _id: 'c'.repeat(24), objectAssigned: body.objectAssigned, createdAt: new Date(clock).toISOString() };
    state.records.push(record);
    write(record, body);
    return respond(200, record);
  }
  if (m === 'DELETE' && u.pathname.startsWith('/v2/customfield/')) {
    state.records = state.records.filter((r) => r._id !== u.pathname.split('/').pop());
    state.restartAt = clock + 1000;
    boot();
    return respond(200, {});
  }
  if (m === 'POST' && u.pathname === '/v2/cob') {
    const cob = { _id: 'b'.repeat(24), modelName: body.modelName.replace(/s$/, ''), active: true };
    state.cobs.push(cob);
    state.restartAt = clock + 1000;
    boot();
    return respond(200, cob);
  }
  return respond(404, { error: `unexpected ${m} ${u.pathname}` });
}

const run = (argv) => cf.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  now: () => clock,
  sleep: async (ms) => { clock += ms; },
  settleMs: 20000,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const plan = (body) => JSON.stringify({ object: 'Deal', ...body });
const json = () => JSON.parse(out);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-cf-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-cf-plan-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  clock = Date.parse('2026-10-30T12:00:00Z');
  state = {
    native: {
      Deal: { dealName: { type: 'string', required: true }, stage: { type: 'objectid', ref: 'Stage' }, denied: { reason: { type: 'string' } } },
      Contact: { email: { type: 'string' } },
    },
    records: [{
      _id: DEAL_CF,
      objectAssigned: 'Deal',
      customFields: { code: { isCustomField: true, type: 'string', label: 'Code' } },
      overrides: { denied: { reason: { isCustomField: true, type: 'string', enum: ['Price', 'Timing'] } } },
      active: true,
      status: "Success: 'Deal' Custom fields loaded succesfully.",
      updatedAt: '2026-10-01T00:00:00.000Z',
    }],
    cobs: [],
    missing: 0,
    dealValues: ['A1', 'A2'],
    restartAt: 0,
    bootedAt: 0,
  };
  boot();
  state.bootedAt = Date.parse('2026-10-29T00:00:00Z');
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('field rules', () => {
  test('a key comes from the label the way the app makes it', () => {
    expect(cf.keyFromLabel('Año de creación')).toBe('anoDeCreacion');
    expect(cf.keyFromLabel('Total VIP guests')).toBe('totalVipGuests');
  });

  test('index only on plain text, enum only on text or numbers, ref only on links', () => {
    const v = (attrs) => () => cf.validateField(attrs, { where: 'x', needsType: true });
    expect(v({ type: 'number', index: true })).toThrow('indexed');
    expect(v({ type: ['string'], index: true })).toThrow('indexed');
    expect(v({ type: 'string', uiCom: 'PasswordInput', index: true })).toThrow('indexed');
    expect(v({ type: 'string', index: true, label: 'Code' })).not.toThrow();
    expect(v({ type: 'boolean', enum: ['a'] })).toThrow('enum');
    expect(v({ type: 'string', enum: ['a', 'a'] })).toThrow('repeats');
    expect(v({ type: 'string', ref: 'User' })).toThrow('objectid');
    expect(v({ type: 'text' })).toThrow('not valid');
    expect(v({ label: 'No type' })).toThrow('"type" is required');
    expect(v({ type: 'mixed', objectShape: {} })).toThrow('objectShape');
    expect(cf.validateField({ type: 'objectid', label: 'Owner' }, { where: 'x', needsType: true }).join(' ')).toContain('without "ref"');
  });

  test('names follow the server pattern and the reserved words', () => {
    expect(() => cf.buildDefinition(null, { add: [{ name: '2fast', type: 'string' }] })).toThrow('not a valid field name');
    expect(() => cf.buildDefinition(null, { add: [{ name: 'Default', type: 'string' }] })).toThrow('reserved');
    expect(() => cf.buildDefinition(null, { add: [{ name: 'createdAt', type: 'date' }] })).toThrow('reserved');
  });
});

describe('buildDefinition and buildRequest', () => {
  const record = () => JSON.parse(JSON.stringify(state.records[0]));

  test('keeps every stored field and adds the new one with isCustomField', () => {
    const { next, changes } = cf.buildDefinition(record(), { add: [{ label: 'Event type', type: 'string', enum: ['A', 'B'] }] });
    expect(next.customFields.code).toEqual(record().customFields.code);
    expect(next.overrides).toEqual(record().overrides);
    expect(next.customFields.eventType).toEqual({ isCustomField: true, label: 'Event type', type: 'string', enum: ['A', 'B'] });
    expect(changes).toEqual([expect.objectContaining({ change: 'add', in: 'customFields', name: 'eventType' })]);
  });

  test('a built-in field is only overridden on purpose, and keeps its type', () => {
    const live = state.live.Deal;
    expect(() => cf.buildDefinition(record(), { add: [{ name: 'stage', in: 'overrides', type: 'string' }] }, { liveSchema: live })).toThrow('overrideBuiltIn');
    const { next, warnings } = cf.buildDefinition(record(), {
      add: [{ name: 'dealName', in: 'overrides', type: 'number', required: true, overrideBuiltIn: true }],
    }, { liveSchema: live });
    expect(next.overrides.dealName).toEqual({ isCustomField: true, required: true });
    expect(warnings.join(' ')).toContain('original type');
  });

  test('update merges properties; remove drops the field and its empty group', () => {
    const { next, changes } = cf.buildDefinition(record(), {
      update: [{ name: 'code', set: { required: true }, unset: ['label'] }],
      remove: [{ name: 'denied.reason' }],
    });
    expect(next.customFields.code).toEqual({ isCustomField: true, type: 'string', required: true });
    expect(next.overrides).toEqual({});
    expect(changes.map((c) => c.change)).toEqual(['update', 'remove']);
  });

  test('PATCH carries both blocks whole, {} for an empty one; nothing left means DELETE', () => {
    const r = record();
    const { next } = cf.buildDefinition(r, { remove: [{ name: 'denied.reason' }] });
    const patch = cf.buildRequest(r, next, { objectName: 'Deal' });
    expect(patch).toEqual({ method: 'PATCH', path: `/v2/customfield/${DEAL_CF}`, body: { customFields: r.customFields, overrides: {} } });
    const all = cf.buildDefinition(r, { remove: [{ name: 'denied.reason' }, { name: 'code' }] });
    expect(cf.buildRequest(r, all.next, { objectName: 'Deal' }).method).toBe('DELETE');
    const create = cf.buildRequest(null, { customFields: { a: { isCustomField: true, type: 'string' } }, overrides: {} }, { objectName: 'Contact' });
    expect(create.body).toEqual({ objectAssigned: 'Contact', active: true, customFields: { a: { isCustomField: true, type: 'string' } } });
  });

  test('a new server process is told apart by its uptime', () => {
    expect(cf.parseUptime('1d 2h 3m 4s')).toBe(93784);
    const at = Date.parse('2026-10-30T12:00:00Z');
    expect(cf.restartedSince({ uptime: '0d 0h 0m 10s' }, at, at + 30000)).toBe(true);
    expect(cf.restartedSince({ uptime: '0d 1h 0m 0s' }, at, at + 30000)).toBe(false);
  });
});

describe('commands', () => {
  test('show explains the state and which fields are live', async () => {
    expect(await run(['show', D, 'deal'])).toBe(0);
    const r = json();
    expect(r.object).toBe('Deal');
    expect(r.record.state).toBe('loaded');
    expect(r.fields.map((f) => f.recordPath)).toEqual(['customFields.code', 'denied.reason']);
    expect(r.live).toEqual({ checked: true, missing: [] });
  });

  test('preview writes nothing and returns the version', async () => {
    expect(await run(['preview', D, plan({ add: [{ name: 'eventType', type: 'string', label: 'Event type' }] })])).toBe(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const r = json();
    expect(r.version).toBe('2026-10-01T00:00:00.000Z');
    expect(r.requests[0].body.customFields).toHaveProperty('code');
    expect(r.requests[0].body.customFields).toHaveProperty('eventType');
    expect(r.restart).toContain('restarts every server');
  });

  test('a switched-off record blocks until the plan decides about reactivating', async () => {
    Object.assign(state.records[0], { active: false, status: 'Error: MongoNetworkError: closed' });
    expect(await run(['preview', D, plan({ add: [{ name: 'x', type: 'string', label: 'X' }] })])).toBe(3);
    expect(json().blockers.join(' ')).toContain('reactivate');
    out = '';
    expect(await run(['preview', D, plan({ reactivate: true })])).toBe(0);
    expect(json().requests[0].body.active).toBe(true);
  });

  test('a new unique rule on repeated values is blocked; a new required rule counts the gaps', async () => {
    state.dealValues = ['A1', 'A1', 'B'];
    expect(await run(['preview', D, plan({ update: [{ name: 'code', set: { unique: true } }] })])).toBe(3);
    expect(json().checks[0]).toMatchObject({ rule: 'unique', duplicates: ['A1'] });
    out = '';
    state.missing = 7;
    expect(await run(['preview', D, plan({ update: [{ name: 'code', set: { required: true } }] })])).toBe(0);
    expect(json().checks[0]).toMatchObject({ rule: 'required', recordsWithoutValue: 7 });
    const xq = JSON.parse(calls.find((c) => c.path === '/v2/deal' && c.query.xquery).query.xquery);
    expect(xq).toEqual({ 'customFields.code': { $in: [null, ''] } });
  });

  test('apply refuses without a version or without --confirmed', async () => {
    const p = plan({ add: [{ name: 'x', type: 'string' }] });
    expect(await run(['apply', D, p, '--confirmed'])).toBe(2);
    expect(await run(['apply', D, p, '--version', '2026-10-01T00:00:00.000Z'])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('apply stops if the record changed after the preview', async () => {
    expect(await run(['apply', D, plan({ add: [{ name: 'x', type: 'string' }] }), '--version', 'old', '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  test('apply sends one grouped write, waits for the restart, then reads back and checks the live schema', async () => {
    const p = plan({ add: [{ name: 'eventType', type: 'string', label: 'Event type' }, { name: 'paid', type: 'boolean', label: 'Paid' }] });
    expect(await run(['apply', D, p, '--version', '2026-10-01T00:00:00.000Z', '--confirmed'])).toBe(0);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].body.customFields)).toEqual(['code', 'eventType', 'paid']);
    expect(writes[0].body.overrides).toEqual(state.records[0].overrides);
    const r = json();
    expect(r.saved).toBe(true);
    expect(r.restart.restarted).toBe(true);
    expect(r.restart.seconds).toBeGreaterThanOrEqual(25);
    expect(r.record.state).toBe('loaded');
    expect(r.live.missing).toEqual([]);
  });

  test('a load error after the restart is reported, not hidden', async () => {
    state.loadFails = true;
    expect(await run(['apply', D, plan({ add: [{ name: 'x', type: 'string', label: 'X' }] }), '--version', '2026-10-01T00:00:00.000Z', '--confirmed'])).toBe(1);
    const r = json();
    expect(r.saved).toBe(false);
    expect(r.record.state).toBe('loadError');
    expect(r.problems.join(' ')).toContain('switched the record off');
  });

  test('a field missing from the live schema after the restart is reported', async () => {
    state.staleLive = true;
    expect(await run(['apply', D, plan({ add: [{ name: 'x', type: 'string', label: 'X' }] }), '--version', '2026-10-01T00:00:00.000Z', '--confirmed'])).toBe(1);
    expect(json().problems.join(' ')).toContain('Not live yet: customFields.x');
  });

  test('a connection cut by the restart is not a failure: the read-back decides', async () => {
    state.dropWrite = true;
    expect(await run(['apply', D, plan({ add: [{ name: 'x', type: 'string', label: 'X' }] }), '--version', '2026-10-01T00:00:00.000Z', '--confirmed'])).toBe(0);
    expect(json().write).toBe('unknown');
  });

  test('a rejected write stops before any wait', async () => {
    state.patchStatus = 400;
    expect(await run(['apply', D, plan({ add: [{ name: 'x', type: 'string' }] }), '--version', '2026-10-01T00:00:00.000Z', '--confirmed'])).toBe(1);
    expect(err).toContain('answered 400');
  });

  test('removing every field deletes the record, as the app does', async () => {
    const p = plan({ remove: [{ name: 'code' }, { name: 'denied.reason' }] });
    expect(await run(['apply', D, p, '--version', '2026-10-01T00:00:00.000Z', '--confirmed'])).toBe(0);
    expect(calls.find((c) => c.method === 'DELETE').path).toBe(`/v2/customfield/${DEAL_CF}`);
    expect(json().deleted).toBe(true);
  });

  test('a new object is created empty, then its fields go on a Custom Field record under the stored name', async () => {
    const p = JSON.stringify({ createObject: 'Pets', add: [{ name: 'petName', type: 'string', label: 'Pet name', required: true }] });
    out = '';
    expect(await run(['preview', D, p])).toBe(0);
    expect(json().warnings.join(' ')).toContain('singular');
    out = '';
    expect(await run(['apply', D, p, '--version', 'new-object', '--confirmed'])).toBe(0);
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes[0]).toMatchObject({ path: '/v2/cob', body: { modelName: 'Pets', active: true } });
    expect(writes[1]).toMatchObject({ path: '/v2/customfield', body: { objectAssigned: 'Pet', overrides: { petName: { isCustomField: true } } } });
    const r = json();
    expect(r.saved).toBe(true);
    expect(r.customObject.restPath).toBe('/v2/pet');
    expect(r.restarts).toHaveLength(2);
  });

  test('a name already taken blocks a new object', async () => {
    expect(await run(['preview', D, JSON.stringify({ createObject: 'Deal', add: [] })])).toBe(3);
  });

  test('plan files outside temp folders are refused', async () => {
    const file = path.join(__dirname, `outside-cf-plan-${process.pid}.json`);
    fs.writeFileSync(file, plan({ add: [{ name: 'x', type: 'string' }] }));
    try {
      expect(await run(['preview', D, file])).toBe(2);
      expect(err).toContain('temp folder');
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('a plan file in a temp folder works, and the API key never reaches the output', async () => {
    const file = path.join(tmpDir, 'plan.json');
    fs.writeFileSync(file, plan({ add: [{ name: 'x', type: 'string', label: 'X' }] }));
    expect(await run(['preview', D, file])).toBe(0);
    expect(out + err).not.toContain('SECRET123');
  });
});
