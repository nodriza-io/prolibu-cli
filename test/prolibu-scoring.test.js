/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sc = require('../.claude/skills/prolibu-scoring/scripts/scoring');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-654321';
const USER = 'a'.repeat(24);
const WS = 'b'.repeat(24);
const ACTIVE_C = 'c'.repeat(24);
const ACTIVE_D = 'd'.repeat(24);
const DRAFT = 'e'.repeat(24);
const CONTACT = '1'.repeat(24);
const CONTACT2 = '2'.repeat(24);
const DEAL = '3'.repeat(24);
const STAGE_CLOSED = '4'.repeat(24);
const HOOK = '5'.repeat(24);

const SCHEMAS = {
  Contact: {
    _id: { type: 'objectid' },
    workspace: { type: 'objectid', ref: 'Workspace' },
    firstName: { type: 'string' },
    email: { type: 'string' },
    jobTitle: { type: 'string' },
    company: { type: 'objectid', ref: 'Company' },
    tags: { type: ['objectid'], ref: 'Tag' },
    createdAt: { type: 'date' },
  },
  Deal: {
    _id: { type: 'objectid' },
    workspace: { type: 'objectid', ref: 'Workspace' },
    dealName: { type: 'string' },
    contact: { type: 'objectid', ref: 'Contact' },
    stage: { type: 'objectid', ref: 'Stage' },
    proposal: { enabled: { type: 'boolean' }, quote: { type: 'mixed' } },
    tracking: { totalViews: { type: 'number' } },
  },
};

let rootDir;
let out;
let err;
let calls;
let state;
let seq;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const crit = (label, when, points) => ({ key: label.toLowerCase().replace(/\W+/g, '-'), label, when, points });

function freshState() {
  return {
    primaryWorkspace: null,
    prefs: { enabled: true, entities: ['Contact', 'Deal'] },
    forbidScoring: false,
    forbidWrites: false,
    scoring: [
      {
        _id: ACTIVE_C, scoringName: 'Contacts main', scoringCode: 'SCR-1', entity: 'Contact', type: 'rules', active: true,
        criteria: [crit('Has e-mail', { '!!': [{ var: 'email' }] }, 5), crit('Has job', { '!!': [{ var: 'jobTitle' }] }, 30)],
        bands: [{ key: 'cold', min: 0, max: 29 }, { key: 'warm', min: 30, max: 100 }], updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        _id: ACTIVE_D, scoringName: 'Deals main', scoringCode: 'SCR-2', entity: 'Deal', type: 'rules', active: true,
        criteria: [crit('Big quote', { '>': [{ var: 'quoteTotal' }, 1000] }, 40)], bands: [], updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        _id: DRAFT, scoringName: 'Draft', scoringCode: 'qa-draft', entity: 'Contact', type: 'rules', active: false,
        criteria: [crit('Has e-mail', { '!!': [{ var: 'email' }] }, 50)], bands: [], updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    contact: [
      {
        _id: CONTACT, firstName: 'Ana', email: 'ana@example.com', jobTitle: null, score: 5, scoreBand: 'cold',
        scoreDetail: { scoring: ACTIVE_C, breakdown: [{ criterion: 'Has e-mail', points: 5 }], computedAt: '2026-03-01T00:00:00.000Z' },
      },
      { _id: CONTACT2, firstName: 'Beto', email: 'beto@example.com' },
    ],
    deal: [{ _id: DEAL, dealName: 'Big deal', stage: STAGE_CLOSED, score: 40 }],
    stage: [{ _id: STAGE_CLOSED, stageName: 'Won', endFlowStage: true }],
    webhook: [
      { _id: HOOK, webhookName: 'CRM sync', endpoint: 'https://hooks.example.com/x', eventNames: ['Deal.update'], active: true, headers: { secret: 'x' } },
      { _id: '6'.repeat(24), webhookName: 'Old', endpoint: 'https://old.example.com', eventNames: ['Contact.update'], active: false },
    ],
    eventtrigger: [],
    preview: { value: 5, band: 'cold', raw: 5, breakdown: [{ criterion: 'Has e-mail', points: 5 }] },
  };
}

function matches(record, xq) {
  return Object.entries(xq || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && v.$in) return v.$in.map(String).includes(String(record[k]));
    if (v && typeof v === 'object' && v.$exists !== undefined) return (record[k] !== undefined) === v.$exists;
    if (v && typeof v === 'object') return true;
    return String(record[k]) === String(v);
  });
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const auth = init.headers.Authorization;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth });
  const [, object, id] = u.pathname.split('/').filter(Boolean);
  if (u.pathname === '/v2/user/me') {
    return respond(200, { profile: { _id: USER, email: 'me@example.com', apiKey: KEY, primaryWorkspace: state.primaryWorkspace }, modelSchemas: SCHEMAS });
  }
  if (u.pathname === '/v2/user/preferences') return respond(200, { modules: { system: { scoring: state.prefs } } });
  if (object === 'scoring' && (state.forbidScoring || auth === `Bearer ${SELLER_KEY}`)) {
    return respond(403, { error: 'Forbidden. User has no permission to perform "find" on "Scoring".' });
  }
  if (u.pathname === '/v2/scoring/preview') {
    return respond(200, { entity: 'Contact', context: { email: 'ana@example.com', jobTitle: null, apiKey: KEY }, rules: state.preview });
  }
  if (u.pathname === '/v2/scoring/recompute') {
    const ids = body.query._id.$in;
    ids.forEach((i) => {
      const r = state[body.entity.toLowerCase()].find((x) => x._id === i);
      if (r) r.score = 77;
    });
    return respond(200, { entity: body.entity, processed: ids.length, failed: 0 });
  }
  if (init.method !== 'GET' && state.forbidWrites) return respond(403, { error: 'Forbidden. No permission to perform "update".' });
  const coll = state[object];
  if (!coll) return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
  if (init.method === 'GET' && id) {
    const rec = coll.find((x) => x._id === id || x.scoringCode === id);
    return rec ? respond(200, rec) : respond(404, { error: 'Not found' });
  }
  if (init.method === 'GET') {
    const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const data = coll.filter((r) => matches(r, xq));
    const limit = Number(u.searchParams.get('limit') || 200);
    return respond(200, { data: data.slice(0, limit), pagination: { count: data.length } });
  }
  const enforce = (doc) => {
    if (!doc.active) return;
    coll.forEach((p) => {
      if (p._id !== doc._id && p.entity === doc.entity && String(p.workspace || null) === String(doc.workspace || null)) p.active = false;
    });
  };
  if (init.method === 'POST' && !id) {
    seq += 1;
    const rec = { _id: `${'7'.repeat(20)}${String(seq).padStart(4, '0')}`, ...body, updatedAt: `N${seq}` };
    if (!rec.workspace && state.primaryWorkspace) rec.workspace = state.primaryWorkspace._id;
    coll.push(rec);
    enforce(rec);
    return respond(200, rec);
  }
  if (init.method === 'PATCH' && id) {
    const rec = coll.find((x) => x._id === id);
    seq += 1;
    Object.assign(rec, body, { updatedAt: `U${seq}` });
    enforce(rec);
    return respond(200, rec);
  }
  return respond(404, { error: 'unexpected' });
}

async function run(...args) {
  out = '';
  err = '';
  const code = await sc.main(args, {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, json: out ? JSON.parse(out) : null };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.vendedor.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  seq = 0;
  state = freshState();
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

const NEW_PLAN = {
  set: {
    scoringName: 'QA plan',
    entity: 'Deal',
    workspace: null,
    criteria: [crit('Big', { '>': [{ var: 'quoteTotal' }, 10] }, 20), crit('Seen', { '>': [{ var: 'proposalViews' }, 2] }, 15)],
    bands: [{ key: 'hot', min: 60, max: 100 }, { key: 'cold', min: 0, max: 29 }, { key: 'warm', min: 30, max: 59 }],
  },
};

describe('criteria lints', () => {
  const lint = (criteria, bands, entity = 'Deal') => sc.lintProfile({ entity, criteria, bands }, { schema: SCHEMAS[entity], prefs: { entities: ['Contact', 'Deal'] } });

  test('an unknown operator blocks (the engine would silently count it as not met)', () => {
    const r = lint([crit('x', { like: [{ var: 'dealName' }, 'a'] }, 5)]);
    expect(r.blockers.join(' ')).toMatch(/operator "like" does not exist/);
  });

  test('a criterion without a condition warns that everyone gets the points', () => {
    expect(lint([{ label: 'All', points: 5 }]).warnings.join(' ')).toMatch(/EVERY record/);
  });

  test('a path inside a linked record warns (links are ids)', () => {
    expect(lint([crit('City', { '==': [{ var: 'contact.city' }, 'X'] }, 5)]).warnings.join(' ')).toMatch(/link to Contact/);
  });

  test('a list attribute read by name warns and suggests some', () => {
    const r = lint([crit('Sku', { '==': [{ var: 'proposal.quote.lineItems.productCode' }, 'S'] }, 5)]);
    expect(r.warnings.join(' ')).toMatch(/"some"/);
  });

  test('a list attribute of a schema array field warns too', () => {
    const r = lint([crit('Tag', { '==': [{ var: 'tags.name' }, 'S'] }, 5)], undefined, 'Contact');
    expect(r.warnings.join(' ')).toMatch(/list "tags"/);
  });

  test('some over line items reading the item is clean; a record field inside it warns', () => {
    const ok = lint([crit('Sku', { some: [{ var: 'proposal.quote.lineItems' }, { '==': [{ var: 'productCode' }, 'S'] }] }, 5)]);
    expect(ok.warnings).toEqual([]);
    const bad = lint([crit('Sku', { some: [{ var: 'proposal.quote.lineItems' }, { '>': [{ var: 'quoteTotal' }, 5] }] }, 5)]);
    expect(bad.warnings.join(' ')).toMatch(/each list item/);
  });

  test('a signals date compared with a text date blocks', () => {
    const r = lint([crit('Recent', { '>': [{ var: 'signals.lastActivityAt' }, '2026-01-01'] }, 5)]);
    expect(r.blockers.join(' ')).toMatch(/daysSinceLastActivity/);
  });

  test('unknown fields, sugar, stage and signals are classified', () => {
    expect(sc.classifyPath('nope', 'Deal', SCHEMAS.Deal).kind).toBe('unknown');
    expect(sc.classifyPath('quoteTotal', 'Deal', SCHEMAS.Deal).kind).toBe('sugar');
    expect(sc.classifyPath('stage.percentage', 'Deal', SCHEMAS.Deal).kind).toBe('stage');
    expect(sc.classifyPath('signals.emailOpens', 'Contact', SCHEMAS.Contact).kind).toBe('signal');
    expect(sc.classifyPath('proposal.quote.total', 'Deal', SCHEMAS.Deal).kind).toBe('field');
    expect(sc.classifyPath('score', 'Deal', SCHEMAS.Deal).kind).toBe('removed');
  });

  test('bands: unreachable, gaps, overlaps and inverted ranges', () => {
    const r = lint([crit('A', { '!!': [{ var: 'dealName' }] }, 45)], [{ key: 'cold', min: 0, max: 20 }, { key: 'warm', min: 10, max: 59 }, { key: 'hot', min: 61, max: 100 }]);
    const text = r.warnings.join(' ');
    expect(text).toMatch(/overlap/);
    expect(text).toMatch(/60-60 fall in no band/);
    expect(text).toMatch(/"warm" .*|above the highest reachable score \(45\)/);
    expect(r.sortedBands.map((b) => b.key)).toEqual(['cold', 'warm', 'hot']);
    expect(lint([crit('A', null, 5)], [{ key: 'x', min: 50, max: 10 }]).blockers.join(' ')).toMatch(/above max/);
  });

  test('ceiling follows maxPoints normalization', () => {
    expect(sc.ceilingOf([{ points: 30 }, { points: -10 }], { mode: 'maxPoints', maxPoints: 60 }).ceiling).toBe(50);
    expect(sc.ceilingOf([{ points: 80 }, { points: 50 }], {}).ceiling).toBe(100);
  });
});

describe('plan and apply', () => {
  test('refuses active, ai and entities without a score; nothing is written', async () => {
    const { code, json } = await run('plan', D, JSON.stringify({ set: { ...NEW_PLAN.set, entity: 'Lead', type: 'ai', active: true } }));
    expect(code).toBe(3);
    const text = json.blockers.join(' ');
    expect(text).toMatch(/created inactive/);
    expect(text).toMatch(/Only rules profiles/);
    expect(text).toMatch(/"Contact" or "Deal"/);
    expect(writes()).toEqual([]);
  });

  test('unknown plan keys are refused before any call', async () => {
    expect((await run('plan', D, JSON.stringify({ ...NEW_PLAN, query: {} }))).code).toBe(2);
    expect(writes()).toEqual([]);
  });

  test('a new profile must say its scope', async () => {
    const { set } = NEW_PLAN;
    const { workspace, ...noScope } = set;
    expect(workspace).toBeNull();
    const { code, json } = await run('plan', D, JSON.stringify({ set: noScope }));
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toMatch(/Say the scope/);
  });

  test('a key whose user has a primary workspace cannot create a whole-account profile', async () => {
    state.primaryWorkspace = { _id: WS, workspaceName: 'North' };
    const { code, json } = await run('plan', D, JSON.stringify(NEW_PLAN));
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toMatch(/primary workspace \(North\)/);
  });

  test('create: preview stops, apply needs the version and --confirmed, profile is born inactive with sorted bands', async () => {
    const plan = JSON.stringify(NEW_PLAN);
    const p = await run('plan', D, plan);
    expect(p.code).toBe(0);
    expect(p.json.next).toMatch(/STOP HERE/);
    expect(p.json.activeInSameScope.map((x) => x._id)).toEqual([ACTIVE_D]);
    expect(p.json.highestReachableScore.ceiling).toBe(35);
    expect(p.json.warnings.join(' ')).toMatch(/"warm" starts at 30|"hot" starts at 60/);
    expect(writes()).toEqual([]);
    expect((await run('apply', D, plan, '--version', p.json.version)).code).toBe(2);
    expect((await run('apply', D, plan, '--version', 'stale', '--confirmed')).code).toBe(3);
    expect(writes()).toEqual([]);
    const a = await run('apply', D, plan, '--version', p.json.version, '--confirmed');
    expect(a.code).toBe(0);
    const post = writes()[0];
    expect(post.method).toBe('POST');
    expect(post.body.active).toBe(false);
    expect(post.body.workspace).toBeUndefined();
    expect(post.body.bands.map((b) => b.key)).toEqual(['cold', 'warm', 'hot']);
    expect(a.json.saved).toBe(true);
    expect(state.scoring.find((s) => s._id === ACTIVE_D).active).toBe(true);
  });

  test('update sends only changed fields and refuses an entity change', async () => {
    const plan = JSON.stringify({ id: 'qa-draft', set: { scoringName: 'Draft 2', criteria: state.scoring[2].criteria } });
    const p = await run('plan', D, plan);
    expect(p.json.changes).toEqual({ scoringName: { from: 'Draft', to: 'Draft 2' } });
    await run('apply', D, plan, '--version', p.json.version, '--confirmed');
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: `/v2/scoring/${DRAFT}`, body: { scoringName: 'Draft 2' } });
    const bad = await run('plan', D, JSON.stringify({ id: DRAFT, set: { entity: 'Deal' } }));
    expect(bad.json.blockers.join(' ')).toMatch(/cannot change/);
  });

  test('editing the active profile warns it applies on each record\'s next save', async () => {
    const p = await run('plan', D, JSON.stringify({ id: ACTIVE_C, set: { scoringName: 'Renamed' } }));
    expect(p.json.warnings.join(' ')).toMatch(/ACTIVE.*next save/);
  });
});

describe('activation', () => {
  test('preview names the profile it switches off; activate reads both back', async () => {
    const p = await run('activate-preview', D, DRAFT);
    expect(p.json.displaced.map((x) => x._id)).toEqual([ACTIVE_C]);
    expect(p.json.effects.join(' ')).toMatch(/Switches OFF "Contacts main"/);
    expect(p.json.effects.join(' ')).toMatch(/next save/);
    expect(writes()).toEqual([]);
    expect((await run('activate', D, DRAFT, '--version', 'old', '--confirmed')).code).toBe(3);
    const a = await run('activate', D, DRAFT, '--version', p.json.version, '--confirmed');
    expect(a.code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', body: { active: true } })]);
    expect(a.json.switchedOff.map((x) => x._id)).toEqual([ACTIVE_C]);
  });

  test('deactivation says scores stay and which profile applies next', async () => {
    const p = await run('deactivate-preview', D, ACTIVE_C);
    expect(p.json.effects.join(' ')).toMatch(/frozen.*not scored/);
    expect(p.json.fallbackAfterDeactivation).toBeNull();
  });
});

describe('explain and try', () => {
  test('explain lists every criterion with what it read, and flags another profile', async () => {
    state.contact[0].scoreDetail.scoring = DRAFT;
    const { code, json } = await run('explain', D, '--entity', 'Contact', '--record', CONTACT);
    expect(code).toBe(0);
    expect(json.criteria).toEqual([
      expect.objectContaining({ criterion: 'Has e-mail', met: true, points: 5 }),
      expect.objectContaining({ criterion: 'Has job', met: false, valuesRead: { jobTitle: null } }),
    ]);
    expect(json.findings.join(' ')).toMatch(/another profile/);
    expect(out).not.toContain(KEY);
  });

  test('a record with no score explains the no-backfill rule', async () => {
    const { json } = await run('explain', D, '--entity', 'Contact', '--record', CONTACT2);
    expect(json.findings.join(' ')).toMatch(/only when the record is saved/);
  });

  test('without the Scoring permission explain returns the stored breakdown only', async () => {
    const { code, json } = await run('explain', D, '--entity', 'Contact', '--record', CONTACT, '--profile', 'vendedor');
    expect(code).toBe(0);
    expect(json.profileAccess).toBe('forbidden');
    expect(json.stored.breakdown).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/v2/scoring/preview')).toEqual([]);
    expect(calls.every((c) => c.auth === `Bearer ${SELLER_KEY}`)).toBe(true);
  });

  test('try previews without writing and caps the list', async () => {
    const { code, json } = await run('try', D, DRAFT, CONTACT);
    expect(code).toBe(0);
    expect(json.results[0].withThisProfile.score).toBe(5);
    expect(writes()).toEqual([]);
    const many = Array.from({ length: 11 }, (_, i) => String(i).padStart(24, 'f')).join(',');
    expect((await run('try', D, DRAFT, many)).code).toBe(2);
  });
});

describe('re-score', () => {
  const plan = (o) => JSON.stringify({ entity: 'Deal', ids: [DEAL], ...o });

  test('refuses a query, more than 50 ids and missing flags; nothing sent', async () => {
    expect((await run('recompute-preview', D, JSON.stringify({ entity: 'Contact', query: {} }))).code).toBe(2);
    expect((await run('recompute-preview', D, JSON.stringify({ entity: 'Contact', ids: [CONTACT], query: { _id: { $ne: null } } }))).code).toBe(2);
    const ids = Array.from({ length: 51 }, (_, i) => String(i).padStart(24, 'a'));
    expect((await run('recompute-preview', D, JSON.stringify({ entity: 'Contact', ids }))).code).toBe(2);
    expect((await run('recompute', D, plan(), '--version', 'v', '--confirmed')).code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('preview lists webhooks (host only) and closed-stage deals; recompute sends only the ids', async () => {
    const p = await run('recompute-preview', D, plan());
    expect(p.code).toBe(0);
    const effects = p.json.sideEffects.join(' ');
    expect(effects).toMatch(/"CRM sync" → hooks\.example\.com/);
    expect(effects).not.toMatch(/old\.example\.com/);
    expect(out).not.toMatch(/secret/);
    expect(p.json.records[0].closedStage).toBe(true);
    expect(writes()).toEqual([]);
    const r = await run('recompute', D, plan(), '--version', p.json.version, '--confirmed', '--reaches-people');
    expect(r.code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ path: '/v2/scoring/recompute', body: { entity: 'Deal', query: { _id: { $in: [DEAL] } } } })]);
    expect(r.json.records[0]).toMatchObject({ before: 40, after: 77 });
  });

  test('a new webhook after the preview blocks the run', async () => {
    const p = await run('recompute-preview', D, plan());
    state.webhook.push({ _id: '8'.repeat(24), webhookName: 'New', endpoint: 'https://new.example.com', eventNames: ['Deal.*'], active: true });
    expect((await run('recompute', D, plan(), '--version', p.json.version, '--confirmed', '--reaches-people')).code).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('permissions and safety', () => {
  test('a 403 stops with the FORBIDDEN message and is not retried', async () => {
    const p = await run('activate-preview', D, DRAFT);
    state.forbidWrites = true;
    const before = calls.length;
    const { code } = await run('activate', D, DRAFT, '--version', p.json.version, '--confirmed');
    expect(code).toBe(1);
    expect(err).toMatch(/FORBIDDEN/);
    expect(err).toMatch(/did not retry it or try another profile/);
    expect(calls.slice(before).filter((c) => c.method !== 'GET')).toHaveLength(1);
  });

  test('the seller profile is used and a forbidden profile read stops plan', async () => {
    const { code } = await run('plan', D, JSON.stringify(NEW_PLAN), '--profile', 'vendedor');
    expect(code).toBe(1);
    expect(err).toMatch(/FORBIDDEN/);
    expect(calls.every((c) => c.auth === `Bearer ${SELLER_KEY}`)).toBe(true);
    expect(writes()).toEqual([]);
  });

  test('status degrades without the Scoring permission and never calls seed-default', async () => {
    state.forbidScoring = true;
    const { code, json } = await run('status', D);
    expect(code).toBe(0);
    expect(json.profiles).toBe('forbidden');
    expect(calls.some((c) => /seed-default/i.test(c.path))).toBe(false);
  });

  test('status reports a primary workspace and missing global profiles', async () => {
    state.primaryWorkspace = { _id: WS, workspaceName: 'North' };
    state.scoring.find((s) => s._id === ACTIVE_D).active = false;
    const { json } = await run('status', D, '--counts');
    const text = json.findings.join(' ');
    expect(text).toMatch(/primary workspace \(North\)/);
    expect(text).toMatch(/No active global Deal profile/);
    expect(json.counts.Contact).toMatchObject({ total: 2, withScore: 1, withoutScore: 1, sampleWithoutScore: [CONTACT2] });
    expect(calls.some((c) => c.query.xquery && JSON.parse(c.query.xquery).updatedAt)).toBe(true);
  });

  test('unknown options and bad entities are usage errors', async () => {
    expect((await run('explain', D, '--entity', 'Lead', '--record', CONTACT)).code).toBe(2);
    expect((await run('status', D, '--all')).code).toBe(2);
    expect(calls).toEqual([]);
  });
});
