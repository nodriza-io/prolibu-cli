/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const refs = require('../.claude/skills/prolibu-external-refs/scripts/refs');

const D = 'dev99.example.com';
const UNIQUE = new Set(['contact', 'company', 'deal', 'product']);

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Shaped after the verified server behavior:
// - ?refId=<v> compares text (a number stored as a number is not found);
// - xquery equality matches the stored type;
// - contact/company/deal/product reject a second record with the same TEXT refId (400);
// - PATCH merges plain objects key by key and replaces anything else; null removes the field.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const [, , object, id] = u.pathname.split('/');
  const list = () => state.records[object] || [];

  if (init.method === 'GET' && object === 'syncconnection') {
    if (state.syncStatus) return respond(state.syncStatus, { statusCode: state.syncStatus, error: 'Forbidden' });
    return respond(200, { pagination: { count: state.sync.length }, data: state.sync });
  }
  if (init.method === 'GET' && object === 'stage') return respond(200, state.stages[id]);
  if (init.method === 'GET' && !id) {
    let found = list();
    if (u.searchParams.has('refId')) found = found.filter((r) => r.refId === u.searchParams.get('refId'));
    if (u.searchParams.has('xquery')) {
      const xq = JSON.parse(u.searchParams.get('xquery'));
      found = found.filter((r) => Object.entries(xq).every(([k, v]) => r[k] === v));
    }
    const limit = Number(u.searchParams.get('limit') || 20);
    return respond(200, { pagination: { count: found.length }, data: found.slice(0, limit) });
  }
  if (init.method === 'GET' && id) {
    const rec = list().find((r) => r._id === id);
    return rec ? respond(200, rec) : respond(404, { statusCode: 404, error: 'Not found' });
  }
  const duplicate = (refId, selfId) => UNIQUE.has(object) && typeof refId === 'string' && refId > ''
    && list().some((r) => r.refId === refId && r._id !== selfId);
  if (init.method === 'POST') {
    if (state.raceOnCreate) {
      state.records[object] = [...list(), { _id: 'race1', refId: body.refId }];
      return respond(400, { statusCode: 400, error: `refId '${body.refId}' ya existe.` });
    }
    if (duplicate(body.refId)) return respond(400, { statusCode: 400, error: `refId '${body.refId}' ya existe.` });
    const rec = { _id: `new${list().length + 1}`, ...body, updatedAt: 'T1' };
    state.records[object] = [...list(), rec];
    return respond(201, rec);
  }
  if (init.method === 'PATCH') {
    const rec = list().find((r) => r._id === id);
    if (!rec) return respond(404, { statusCode: 404, error: 'Not found' });
    if (duplicate(body.refId, id)) return respond(400, { statusCode: 400, error: `refId '${body.refId}' ya existe.` });
    for (const [k, v] of Object.entries(body)) {
      if (v === null) delete rec[k];
      else if (isPlainObject(v) && isPlainObject(rec[k])) rec[k] = { ...rec[k], ...v };
      else rec[k] = v;
    }
    rec.updatedAt = 'T2';
    return respond(200, rec);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => refs.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const plan = (p) => JSON.stringify({ refId: 'CUS-1', refUrl: 'https://erp.example.com/customers/CUS-1', ...p });
const writes = () => calls.filter((c) => c.method !== 'GET');
const json = () => JSON.parse(out);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-refs-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    sync: [],
    records: {
      contact: [
        { _id: 'c1', firstName: 'Ana', email: 'ana@acme.com', refId: 'CUS-1', address: { street: 'Calle 1', city: 'Bogota' }, updatedAt: 'T0' },
        { _id: 'c2', firstName: 'Luis', email: 'luis@acme.com', updatedAt: 'T0' },
        { _id: 'c3', firstName: 'Eva', email: 'eva@acme.com', refId: 'OTHER-9', updatedAt: 'T0' },
        { _id: 'c4', firstName: 'Num', email: 'num@acme.com', refId: 900001, updatedAt: 'T0' },
      ],
      ticket: [
        { _id: 't1', subject: 'A', refId: 'TK-1' },
        { _id: 't2', subject: 'B', refId: 'TK-1' },
      ],
      deal: [{ _id: 'd1', dealName: 'Closed deal', refId: 'D-1', stage: 's-won' }],
    },
    stages: { 's-won': { _id: 's-won', stageName: 'Approved', endFlowStage: true } },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('readPlan', () => {
  test('refuses a numeric refId, with the reason', () => {
    expect(() => refs.readPlan('{"refId": 900001}')).toThrow(/must be text/);
  });
  test('refuses spaces at the ends of refId', () => {
    expect(() => refs.readPlan('{"refId": " CUS-1"}')).toThrow(/spaces/);
  });
  test('refuses refUrl that is not http(s) or carries credentials', () => {
    expect(() => refs.readPlan('{"refId":"A","refUrl":"javascript:alert(1)"}')).toThrow(/https/);
    expect(() => refs.readPlan('{"refId":"A","refUrl":"https://u:p@erp.example.com/x"}')).toThrow(/password/);
    expect(() => refs.readPlan('{"refId":"A","refUrl":"https://erp.example.com/x?access_token=abc"}')).toThrow(/credential/);
  });
  test('refuses system fields and refId inside fields, and unknown plan keys', () => {
    expect(() => refs.readPlan('{"refId":"A","fields":{"refId":"B"}}')).toThrow(/top of the plan/);
    expect(() => refs.readPlan('{"refId":"A","fields":{"createdBy":"x"}}')).toThrow(/cannot be set/);
    expect(() => refs.readPlan('{"refId":"A","foo":1}')).toThrow(/Unknown plan key/);
  });
  test('lowercases an email used as match key', () => {
    expect(refs.readPlan('{"refId":"A","match":{"email":" Ana@Acme.com "}}').match).toEqual({ email: 'ana@acme.com' });
  });
});

describe('preview (writes nothing)', () => {
  test('no record has the refId and no match: create, with a warning about existing records', async () => {
    const code = await run(['preview', D, 'contact', plan({ refId: 'NEW-1', refUrl: undefined, fields: { firstName: 'Zoe', email: 'zoe@acme.com' } })]);
    expect(code).toBe(0);
    const r = json();
    expect(r.action).toBe('create');
    expect(r.expect).toBe('create');
    expect(r.body).toEqual({ firstName: 'Zoe', email: 'zoe@acme.com', refId: 'NEW-1' });
    expect(r.warnings.join(' ')).toMatch(/match/);
    expect(writes()).toHaveLength(0);
  });

  test('one record has the refId: update only what changed', async () => {
    const code = await run(['preview', D, 'contact', plan({ fields: { firstName: 'Ana', address: { city: 'Medellin' } } })]);
    expect(code).toBe(0);
    const r = json();
    expect(r.action).toBe('update');
    expect(r.expect).toBe('c1');
    expect(r.changes).toEqual({
      address: { city: { from: 'Bogota', to: 'Medellin' } },
      refUrl: { from: null, to: 'https://erp.example.com/customers/CUS-1' },
    });
    expect(r.body).toEqual({ address: { city: 'Medellin' }, refUrl: 'https://erp.example.com/customers/CUS-1' });
    expect(writes()).toHaveLength(0);
  });

  test('nothing differs: action none', async () => {
    await run(['preview', D, 'contact', JSON.stringify({ refId: 'CUS-1', fields: { firstName: 'Ana' } })]);
    expect(json().action).toBe('none');
    expect(json().expect).toBeNull();
  });

  test('a record found by match without refId is linked, not duplicated', async () => {
    await run(['preview', D, 'contact', plan({ refId: 'CUS-2', match: { email: 'luis@acme.com' } })]);
    const r = json();
    expect(r.action).toBe('link');
    expect(r.expect).toBe('c2');
    expect(r.body.refId).toBe('CUS-2');
  });

  test('a record found by match that holds another refId stops', async () => {
    const code = await run(['preview', D, 'contact', plan({ refId: 'CUS-3', match: { email: 'eva@acme.com' } })]);
    expect(code).toBe(3);
    expect(json().action).toBe('stop');
    expect(json().blockers.join(' ')).toMatch(/already linked to refId "OTHER-9"/);
  });

  test('two records with the same refId stop and list both', async () => {
    const code = await run(['preview', D, 'ticket', plan({ refId: 'TK-1' })]);
    expect(code).toBe(3);
    expect(json().records.map((x) => x._id)).toEqual(['t1', 't2']);
  });

  test('the same id stored as a number stops instead of creating a twin', async () => {
    const code = await run(['preview', D, 'contact', plan({ refId: '900001' })]);
    expect(code).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/as a number/);
  });

  test('an active sync that covers the object blocks', async () => {
    state.sync = [{ _id: 's1', connector: 'hubspot', active: true, objects: [{ objectType: 'Contact', direction: 'bidirectional' }] }];
    const code = await run(['preview', D, 'contact', plan({ refId: 'NEW-1' })]);
    expect(code).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/custom field/);
  });

  test('a sync entry turned off does not block', async () => {
    state.sync = [{ _id: 's1', connector: 'hubspot', active: true, objects: [{ objectType: 'Contact', direction: 'off' }] }];
    expect(await run(['preview', D, 'contact', plan({ refId: 'NEW-1' })])).toBe(0);
  });

  test('a refused sync read blocks: you cannot tell', async () => {
    state.syncStatus = 403;
    const code = await run(['preview', D, 'contact', plan({ refId: 'NEW-1' })]);
    expect(code).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/ask an admin/);
  });

  test('a deal in an end-of-flow stage blocks an update', async () => {
    const code = await run(['preview', D, 'deal', plan({ refId: 'D-1', refUrl: 'https://crm.example.com/d/1' })]);
    expect(code).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/end-of-flow/);
  });

  test('objects that hold keys or platform logs are refused', async () => {
    expect(await run(['preview', D, 'token', plan({})])).toBe(2);
    expect(await run(['preview', D, 'contactsubmission', plan({})])).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('upsert', () => {
  test('needs --expect and --confirmed, and sends nothing without them', async () => {
    expect(await run(['upsert', D, 'contact', plan({ refId: 'NEW-1' }), '--confirmed'])).toBe(2);
    expect(await run(['upsert', D, 'contact', plan({ refId: 'NEW-1' }), '--expect', 'create'])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('creates with refId in the create body and reads back exactly one', async () => {
    const code = await run(['upsert', D, 'contact', plan({ refId: 'NEW-1', fields: { email: 'zoe@acme.com' } }), '--expect', 'create', '--confirmed']);
    expect(code).toBe(0);
    const post = writes();
    expect(post).toHaveLength(1);
    expect(post[0].method).toBe('POST');
    expect(post[0].body.refId).toBe('NEW-1');
    expect(json().saved).toBe(true);
    expect(json().record.refId).toBe('NEW-1');
  });

  test('updates the one match with a PATCH of the changes only', async () => {
    const code = await run(['upsert', D, 'contact', plan({ fields: { address: { city: 'Medellin' } } }), '--expect', 'c1', '--confirmed']);
    expect(code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: '/v2/contact/c1' })]);
    const c1 = state.records.contact.find((r) => r._id === 'c1');
    expect(c1.address).toEqual({ street: 'Calle 1', city: 'Medellin' });
  });

  test('refuses when the account changed since the preview', async () => {
    const code = await run(['upsert', D, 'contact', plan({}), '--expect', 'create', '--confirmed']);
    expect(code).toBe(3);
    expect(err).toMatch(/changed since the preview/);
    expect(writes()).toHaveLength(0);
  });

  test('a create that loses a race reports the winner and writes nothing else', async () => {
    state.raceOnCreate = true;
    const code = await run(['upsert', D, 'contact', plan({ refId: 'NEW-2' }), '--expect', 'create', '--confirmed']);
    expect(code).toBe(3);
    expect(err).toMatch(/in the meantime \(race1\)/);
    expect(writes()).toHaveLength(1);
  });

  test('a blocked plan is not written', async () => {
    const code = await run(['upsert', D, 'deal', plan({ refId: 'D-1', refUrl: 'https://crm.example.com/d/1' }), '--expect', 'd1', '--confirmed']);
    expect(code).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('--allow-end-flow-stage lets the deal update through', async () => {
    const code = await run(['upsert', D, 'deal', plan({ refId: 'D-1', refUrl: 'https://crm.example.com/d/1' }), '--expect', 'd1', '--confirmed', '--allow-end-flow-stage']);
    expect(code).toBe(0);
    expect(writes()[0].body).toEqual({ refUrl: 'https://crm.example.com/d/1' });
  });

  test('a read-back with two matches is reported as a problem', async () => {
    state.records.ticket = [{ _id: 't9', subject: 'X', refId: 'TK-9' }];
    const original = fakeFetch;
    // Another process adds a twin right after our write.
    const racing = async (url, init) => {
      const res = await original(url, init);
      if (init.method === 'PATCH') state.records.ticket.push({ _id: 't10', subject: 'Y', refId: 'TK-9' });
      return res;
    };
    const code = await refs.main(['upsert', D, 'ticket', plan({ refId: 'TK-9', fields: { subject: 'Z' } }), '--expect', 't9', '--confirmed'], {
      rootDir, fetchImpl: racing, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    });
    expect(code).toBe(1);
    expect(json().problems.join(' ')).toMatch(/expected exactly 1/);
  });
});

describe('find and check', () => {
  test('find lists text matches and numeric twins', async () => {
    await run(['find', D, 'contact', '900001']);
    expect(json().count).toBe(0);
    expect(json().numericTwins.map((x) => x._id)).toEqual(['c4']);
  });

  test('check reports the uniqueness rule and sync coverage', async () => {
    await run(['check', D, 'ticket']);
    expect(json().canWriteRefId).toBe(true);
    expect(json().uniqueRule).toMatch(/None/);
  });

  test('the API key never reaches the output', async () => {
    await run(['find', D, 'contact', 'CUS-1']);
    expect(out + err).not.toMatch(/SECRET123/);
  });
});
