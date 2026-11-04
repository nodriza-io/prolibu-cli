/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const leads = require('../.claude/skills/prolibu-leads/scripts/leads');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-987654';
const ME = 'a'.repeat(24);
const SELLER = 'b'.repeat(24);
const OFF_USER = 'c'.repeat(24);
const GROUP = 'd'.repeat(24);
const TPL_EMAIL = 'e'.repeat(24);
const TPL_WA = 'f'.repeat(24);
const STAGE_REVIEW = '1'.repeat(24);
const STAGE_CONVERTED = '2'.repeat(24);
const STAGE_CONTACT = '3'.repeat(24);
const PROTOCOL = '4'.repeat(24);
const GOAL = '5'.repeat(24);
const CONTACT = '6'.repeat(24);

let rootDir;
let calls;
let state;
let seq;
let forbid;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v === null || v === undefined ? null : String(v));
const newId = () => `9${String(seq++).padStart(23, '0')}`;

function getPath(record, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), record);
}

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    const field = getPath(record, k);
    if (v === null) return field === null || field === undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.$in) return [].concat(field ?? []).some((f) => v.$in.map(String).includes(idOf(f)));
      if (v.$ne !== undefined) return field !== v.$ne;
      if (v.$regex) {
        const src = v.$regex.replace(/^\(\?i\)/, '');
        return new RegExp(src, 'i').test(String(field || ''));
      }
      if (v.$gt !== undefined) return field > v.$gt;
      if (v.$lte !== undefined || v.$gte !== undefined) {
        const f = String(field || '');
        return (v.$lte === undefined || f <= v.$lte) && (v.$gte === undefined || f >= v.$gte);
      }
      return true;
    }
    if (Array.isArray(field)) return field.map(idOf).includes(String(v));
    return idOf(field) === String(v) || field === v;
  });
}

function withUser(record) {
  if (!record || !record.assignee) return record;
  const u = state.user.find((x) => x._id === idOf(record.assignee));
  return u ? { ...record, assignee: u } : record;
}

// Verified behaviour of the server: a lead converts on {converted:true} or the Converted stage,
// refuses an exact contact e-mail, makes the caller owner of both records, and ignores later changes.
function patchLead(lead, body) {
  if (lead.convertedAt) {
    Object.assign(lead, body, { converted: true, stage: STAGE_CONVERTED, updatedAt: `L${seq++}` });
    return respond(200, lead);
  }
  const next = { ...lead, ...body };
  if (next.converted || next.stage === STAGE_CONVERTED) {
    if (state.contact.some((c) => c.email === lead.email)) return respond(400, { error: 'A contact with this email already exists.' });
    const contact = {
      _id: newId(), email: lead.email, firstName: lead.firstName, lastName: lead.lastName, mobile: lead.mobile, assignee: ME, notes: lead.description ? ['n1'] : [], updatedAt: 'C0',
    };
    state.contact.push(contact);
    Object.assign(next, {
      converted: true, convertedAt: '2026-11-03', convertedTo: contact._id, stage: STAGE_CONVERTED, assignee: ME,
    });
  }
  Object.assign(lead, next, { updatedAt: `L${seq++}` });
  return respond(200, lead);
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({
    method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: init.headers.Authorization,
  });
  const [, , object, id] = u.pathname.split('/');
  if (forbid && forbid(init.method, u.pathname)) return respond(403, { error: 'Forbidden. User has no permission.' });
  if (u.pathname === '/v2/user/me') return respond(200, { profile: { _id: ME, email: 'me@example.com', firstName: 'Me', apiKey: KEY } });
  if (u.pathname === '/v2/user/preferences') return respond(200, { modules: { directory: { leads: { enabled: true }, contacts: { contactProtocols: { enabled: true } } }, sales: { goals: { enabled: true } } } });
  if (u.pathname === '/v2/contactprotocol/pause' && init.method === 'PUT') {
    const c = state.contact.find((x) => x._id === body.contactId);
    c.protocolRun.status = 'stopped';
    return respond(200, { ok: true });
  }
  const coll = state[object];
  if (!coll) return respond(404, { error: 'not found' });
  if (init.method === 'GET') {
    if (id) {
      const r = coll.find((x) => x._id === id || x.goalCode === id);
      return r ? respond(200, r) : respond(404, { error: 'not found' });
    }
    const xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const limit = Number(u.searchParams.get('limit') || 50);
    const rows = coll.filter((r) => matches(r, xquery));
    return respond(200, { pagination: { count: rows.length }, data: rows.slice(0, limit).map(withUser) });
  }
  if (init.method === 'POST') {
    const rec = { _id: newId(), active: true, ...body, updatedAt: `N${seq++}` };
    if (object === 'contactprotocol') rec.contactProtocolCode = `CTP-${seq}`;
    if (object === 'goal') rec.goalCode = `GOL-${seq}`;
    coll.push(rec);
    return respond(201, rec);
  }
  if (init.method === 'PATCH') {
    const rec = coll.find((x) => x._id === id);
    if (!rec) return respond(404, { error: 'not found' });
    if (object === 'lead') return patchLead(rec, body);
    Object.assign(rec, body, { updatedAt: `U${seq++}` });
    return respond(200, rec);
  }
  return respond(405, { error: 'unexpected' });
}

let stdout;
let stderr;
async function run(args, opts = {}) {
  stdout = '';
  stderr = '';
  const code = await leads.main([args[0], D, ...args.slice(1)], {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } }, ...opts,
  });
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Errors go to stderr.
  }
  return { code, json };
}

async function previewThenApply(plan, extra = []) {
  const p = await run(['preview', JSON.stringify(plan)]);
  expect(p.code).toBe(0);
  calls = [];
  return run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed', ...extra]);
}

const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  calls = [];
  seq = 0;
  forbid = null;
  state = {
    stage: [
      { _id: STAGE_REVIEW, stageCode: 'lead-stage-reviewing', stageName: 'Reviewing', stageType: 'Lead.stage' },
      { _id: '7'.repeat(24), stageCode: 'lead-stage-qualified', stageName: 'Qualified', stageType: 'Lead.stage' },
      { _id: '8'.repeat(24), stageCode: 'lead-stage-discarded', stageName: 'Discarded', stageType: 'Lead.stage' },
      { _id: STAGE_CONVERTED, stageCode: 'lead-stage-converted', stageName: 'Converted', stageType: 'Lead.stage' },
      { _id: STAGE_CONTACT, stageCode: 'contact-qualified', stageName: 'Qualified contact', stageType: 'Contact.stage' },
    ],
    user: [
      { _id: ME, email: 'me@example.com', firstName: 'Me', status: 'Active' },
      { _id: SELLER, email: 'seller@example.com', firstName: 'Sel', lastName: 'Ler', status: 'Active' },
      { _id: OFF_USER, email: 'gone@example.com', firstName: 'Gone', status: 'Inactive' },
    ],
    usergroup: [{ _id: GROUP, userGroupName: 'Sales team', users: [SELLER, OFF_USER, ME], updatedAt: 'G1' }],
    lead: [
      {
        _id: newId(), email: 'ana@example.com', firstName: 'Ana', lastName: 'Ruiz', mobile: '+57 300 111 2222', assignee: SELLER, description: 'Met at the fair', source: 'fair', updatedAt: 'L1',
      },
      { _id: newId(), email: 'bob@example.com', firstName: 'Bob', lastName: 'Stone', source: 'fair', updatedAt: 'L2' },
      { _id: newId(), email: 'cy@example.com', firstName: 'Cy', lastName: 'Moss', source: 'fair', updatedAt: 'L3' },
      {
        _id: newId(), email: 'old@example.com', firstName: 'Old', lastName: 'Lead', converted: true, convertedAt: '2026-01-01', convertedTo: CONTACT, stage: STAGE_CONVERTED, updatedAt: 'L4',
      },
    ],
    contact: [
      { _id: CONTACT, email: 'old@example.com', firstName: 'Old', lastName: 'Lead', searchText: 'old lead', phonesText: '', assignee: ME, updatedAt: 'C1' },
    ],
    contactprotocol: [],
    messagetemplate: [
      { _id: TPL_EMAIL, messageTemplateName: 'Welcome', modelName: 'Email' },
      { _id: TPL_WA, messageTemplateName: 'WA pending', modelName: 'Message', whatsappStatus: 'pending' },
    ],
    goal: [],
    livestream: [],
    contactsubmission: [],
    email: [],
  };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('pure helpers', () => {
  test('name similarity ignores accents, case and spacing', () => {
    expect(leads.nameSimilarity('José  Pérez', 'jose perez')).toBe(1);
    expect(leads.nameSimilarity('Ana Ruiz', 'Ana Ruíz Gómez')).toBeLessThan(0.85);
    expect(leads.nameSimilarity('Mario Lopez Cano', 'Mario López Cano')).toBeGreaterThanOrEqual(0.85);
  });

  test('phones compare by their last 8 digits', () => {
    expect(leads.phonesOf({ mobile: '+57 300 111 2222', phones: [{ number: '0300-111-2222' }] })).toEqual(['01112222']);
    expect(leads.phonesOf({ mobile: '123' })).toEqual([]);
  });

  test('delays become milliseconds; periods become whole months', () => {
    expect(leads.parseDelay('3d')).toBe(259200000);
    expect(leads.parseDelay('2h')).toBe(7200000);
    expect(leads.parseDelay('30m')).toBe(1800000);
    expect(() => leads.parseDelay('soon')).toThrow(/Invalid delay/);
    expect(leads.periodOf({ period: '2028-02' })).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(() => leads.periodOf({ period: '2026-13' })).toThrow(/Invalid period/);
  });

  test('the board picks the country protocol, then the generic one', () => {
    const p = [{ _id: 'x', stages: [STAGE_CONTACT], country: 'MX' }, { _id: 'y', stages: [STAGE_CONTACT] }];
    expect(leads.pickProtocol(p, STAGE_CONTACT, 'MX').protocol._id).toBe('x');
    expect(leads.pickProtocol(p, STAGE_CONTACT, 'CO').protocol._id).toBe('y');
    expect(leads.pickProtocol([p[0]], STAGE_CONTACT, 'CO').protocol).toBeNull();
  });

  test('the badge reads a time below 1000 as hours and flags the first pending step', () => {
    expect(leads.badgeDelayMs(5)).toBe(5 * 3600000);
    expect(leads.badgeDelayMs(86400000)).toBe(86400000);
    const moved = new Date('2026-11-01T00:00:00Z');
    const flow = [{ actionType: 'call', time: 0 }, { actionType: 'email', time: 86400000 }];
    const steps = leads.walkBadge(flow, moved, { calls: [{ channel: 'Phone', createdAt: '2026-11-01T01:00:00Z' }], emails: [] }, new Date('2026-11-03T00:00:00Z'));
    expect(steps.map((s) => s.state)).toEqual(['done', 'overdue']);
  });

  test('round robin keeps the given order and wraps', () => {
    const pairs = leads.roundRobin(['l1', 'l2', 'l3'], ['u1', 'u2'], 1);
    expect(pairs.map((p) => p.user)).toEqual(['u2', 'u1', 'u2']);
  });
});

describe('leads and duplicates', () => {
  test('show finds a contact with the same phone that the server would not block', async () => {
    state.contact.push({ _id: newId(), email: 'other@example.com', firstName: 'Ann', lastName: 'Ruiz', phonesText: '573001112222', searchText: 'ann ruiz' });
    const { code, json } = await run(['show', 'ana@example.com']);
    expect(code).toBe(0);
    expect(json.duplicates.exact).toEqual([]);
    expect(json.duplicates.similar[0].why).toMatch(/same phone/);
    expect(json.verdict).toMatch(/Possible duplicates/);
  });

  test('convert is blocked by an exact e-mail and by a similar name until the user tells them apart', async () => {
    state.contact.push({ _id: newId(), email: 'bob@example.com', firstName: 'Bob', lastName: 'Stone', searchText: 'bob stone' });
    const twin = newId();
    state.contact.push({ _id: twin, email: 'cy.m@example.com', firstName: 'Cy', lastName: 'Moss', searchText: 'cy moss' });
    let r = await run(['preview', JSON.stringify({ kind: 'convert', leads: ['bob@example.com'] })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers[0]).toMatch(/already has this e-mail/);
    r = await run(['preview', JSON.stringify({ kind: 'convert', leads: ['cy@example.com'] })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers[0]).toMatch(/similar name/);
    r = await run(['preview', JSON.stringify({ kind: 'convert', leads: ['cy@example.com'], differentFrom: [twin] })]);
    expect(r.code).toBe(0);
  });

  test('convert needs --reaches-people and keeps the lead owner by handing the contact back', async () => {
    const plan = { kind: 'convert', leads: ['ana@example.com'] };
    const p = await run(['preview', JSON.stringify(plan)]);
    expect(p.json.recipients.map((x) => x.user)).toEqual(['me@example.com', 'seller@example.com']);
    calls = [];
    let r = await run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(r.code).toBe(2);
    expect(calls).toEqual([]);
    r = await run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed', '--reaches-people']);
    expect(r.code).toBe(0);
    const w = writes();
    expect(w[0]).toMatchObject({ method: 'PATCH', body: { converted: true } });
    expect(w[0].path).toMatch(/^\/v2\/lead\//);
    expect(w[1]).toMatchObject({ method: 'PATCH', body: { assignee: SELLER } });
    expect(w[1].path).toMatch(/^\/v2\/contact\//);
    expect(r.json.converted[0]).toMatchObject({ owner: SELLER, notes: 1 });
    expect(r.json.nextStep).toMatch(/user's language/);
  });

  test('a converted lead cannot be converted, moved or un-converted', async () => {
    let r = await run(['preview', JSON.stringify({ kind: 'convert', leads: ['old@example.com'] })]);
    expect(r.code).toBe(3);
    r = await run(['preview', JSON.stringify({ kind: 'triage', leads: ['old@example.com'], stage: 'reviewing' })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers[0]).toMatch(/already converted/);
    r = await run(['preview', JSON.stringify({ kind: 'triage', leads: ['bob@example.com'], stage: 'converted' })]);
    expect(r.code).toBe(3);
    expect(stderr).toMatch(/convert/);
  });

  test('triage moves leads and back to New with a null stage; a changed lead needs a new preview', async () => {
    const r = await previewThenApply({ kind: 'triage', leads: ['bob@example.com'], stage: 'reviewing' });
    expect(r.code).toBe(0);
    expect(writes()[0].body).toEqual({ stage: STAGE_REVIEW });
    const back = await previewThenApply({ kind: 'triage', leads: ['bob@example.com'], stage: 'new' });
    expect(back.code).toBe(0);
    expect(writes()[0].body).toEqual({ stage: null });
    const p = await run(['preview', JSON.stringify({ kind: 'triage', leads: ['cy@example.com'], stage: 'qualified' })]);
    state.lead[2].updatedAt = 'changed';
    const stale = await run(['apply', JSON.stringify({ kind: 'triage', leads: ['cy@example.com'], stage: 'qualified' }), '--version', p.json.version, '--confirmed']);
    expect(stale.code).toBe(3);
  });

  test('assign rotates over active group members and never writes the group', async () => {
    const r = await previewThenApply({ kind: 'assign', filter: { source: 'fair' }, group: 'Sales team' });
    expect(r.code).toBe(0);
    const w = writes();
    expect(w.every((c) => c.path.startsWith('/v2/lead/'))).toBe(true);
    const owners = state.lead.slice(0, 3).map((l) => l.assignee);
    expect(owners).toEqual([SELLER, ME, SELLER]);
    expect(calls.some((c) => c.path.includes('usergroup') && c.method !== 'GET')).toBe(false);
  });
});

describe('protocols, pause and goals', () => {
  const flow = [
    { actionType: 'call', actionName: 'Call', delay: '0d' },
    {
      actionType: 'email', actionName: 'Mail', delay: '3d', subject: 'Hi', messageTemplate: TPL_EMAIL,
    },
  ];

  test('a new protocol is sent with active:false; turning it on is its own plan', async () => {
    let r = await previewThenApply({ kind: 'protocol', set: { contactProtocolName: 'Follow', stages: ['Qualified contact'], flow } });
    expect(r.code).toBe(0);
    expect(writes()[0].body.active).toBe(false);
    expect(writes()[0].body.flow[1].time).toBe(259200000);
    const id = state.contactprotocol[0]._id;
    r = await run(['preview', JSON.stringify({ kind: 'protocol', id, set: { active: true, contactProtocolName: 'X' } })]);
    expect(r.code).toBe(3);
    r = await previewThenApply({ kind: 'protocol', id, set: { active: true } });
    expect(r.code).toBe(0);
    expect(writes()[0].body).toEqual({ active: true });
  });

  test('protocol lints block short delays, e-mail steps without subject and unapproved WhatsApp templates', async () => {
    const bad = [
      { actionType: 'call', time: 5 },
      { actionType: 'email', delay: '1d', messageTemplate: TPL_EMAIL },
      { actionType: 'whatsapp', delay: '1d', messageTemplate: TPL_WA },
    ];
    const r = await run(['preview', JSON.stringify({ kind: 'protocol', set: { contactProtocolName: 'Bad', stages: [STAGE_CONTACT], flow: bad, active: true } })]);
    expect(r.code).toBe(3);
    const text = r.json.blockers.join('\n');
    expect(text).toMatch(/created inactive/);
    expect(text).toMatch(/under one minute/);
    expect(text).toMatch(/own subject/);
    expect(text).toMatch(/approved WhatsApp/);
  });

  test('turning on a protocol that clashes with an active one on the same stage is blocked', async () => {
    state.contactprotocol.push({ _id: PROTOCOL, contactProtocolName: 'Live', entity: 'Contact', stages: [STAGE_CONTACT], active: true, flow: [] });
    state.contactprotocol.push({ _id: newId(), contactProtocolName: 'New', entity: 'Contact', stages: [STAGE_CONTACT], active: false, flow: [], updatedAt: 'P2' });
    const r = await run(['preview', JSON.stringify({ kind: 'protocol', id: state.contactprotocol[1]._id, set: { active: true } })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers[0]).toMatch(/board shows only one/);
  });

  test('pause stops a running cadence and nothing ever calls enroll', async () => {
    state.contact.push({ _id: newId(), email: 'run@example.com', protocolRun: { contactProtocol: PROTOCOL, status: 'active', runId: 'r1', currentStep: 1 } });
    let r = await run(['preview', JSON.stringify({ kind: 'pause', contact: 'old@example.com' })]);
    expect(r.code).toBe(3);
    r = await previewThenApply({ kind: 'pause', contact: 'run@example.com' });
    expect(r.code).toBe(0);
    expect(r.json.status).toBe('stopped');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', path: '/v2/contactprotocol/pause' })]);
    expect(calls.some((c) => /enroll/i.test(c.path))).toBe(false);
  });

  test('goals: same seller and month updates, an overlap blocks, a new month creates', async () => {
    state.goal.push({
      _id: GOAL, goalCode: 'GOL-1', goalName: 'Sel Ler · 2026-11', assignee: SELLER, startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-30T00:00:00.000Z', targetValue: 10, updatedAt: 'G1',
    });
    let r = await previewThenApply({ kind: 'goal', goals: [{ assignee: 'seller@example.com', period: '2026-11', targetValue: 20 }] });
    expect(r.code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: `/v2/goal/${GOAL}` });
    r = await run(['preview', JSON.stringify({ kind: 'goal', goals: [{ assignee: 'seller@example.com', startDate: '2026-11-15', endDate: '2026-12-14', targetValue: 1 }] })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers[0]).toMatch(/overlaps/);
    r = await previewThenApply({ kind: 'goal', goals: [{ assignee: 'seller@example.com', period: '2026-12', targetValue: 5 }] });
    expect(r.code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/v2/goal', body: { assignee: SELLER, startDate: '2026-12-01', endDate: '2026-12-31' } });
  });
});

describe('guards', () => {
  test('apply without --confirmed or --version writes nothing', async () => {
    const plan = JSON.stringify({ kind: 'triage', leads: ['bob@example.com'], stage: 'reviewing' });
    expect((await run(['apply', plan, '--version', 'x'])).code).toBe(2);
    expect((await run(['apply', plan, '--confirmed'])).code).toBe(2);
    expect(writes()).toEqual([]);
  });

  test('--profile reads profile.<name>.json, and a 403 stops at once with a clear message', async () => {
    fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
    forbid = (method, p) => p === '/v2/user';
    const r = await run(['preview', JSON.stringify({ kind: 'goal', goals: [{ assignee: 'seller@example.com', period: '2026-12', targetValue: 5 }] }), '--profile', 'seller']);
    expect(r.code).toBe(1);
    expect(calls.every((c) => c.auth === `Bearer ${SELLER_KEY}`)).toBe(true);
    expect(calls.filter((c) => c.path === '/v2/user')).toHaveLength(1);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('did not retry it or try another profile');
    expect(stderr).not.toContain(SELLER_KEY);
  });
});
