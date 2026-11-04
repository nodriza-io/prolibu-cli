/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cleanup = require('../.claude/skills/prolibu-data-cleanup/scripts/cleanup');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const WS = 'a'.repeat(24);
const OTHER_WS = 'b'.repeat(24);
const SELLER = 'c'.repeat(24);
const ME = 'd'.repeat(24);
const P_CO = '1'.repeat(24);
const D_CO = '2'.repeat(24);
const P_CT = '3'.repeat(24);
const D_CT = '4'.repeat(24);
const X_CT = '5'.repeat(24);
const TAG_OLD = '6'.repeat(24);

let rootDir;
let scratch;
let calls;
let state;
let seq;
let forbid;
let unfilterable;
let prevScratch;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v === null || v === undefined ? null : String(v));
const newId = () => `9${String(seq++).padStart(23, '0')}`;
const getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    const field = getPath(record, k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.$in) return [].concat(field ?? []).some((f) => v.$in.map(String).includes(idOf(f)));
      if (v.$lt !== undefined) return String(field || '') < v.$lt;
      if (v.$gte !== undefined) return String(field || '') >= v.$gte;
      return true;
    }
    if (Array.isArray(field)) return field.map(idOf).includes(String(v));
    return idOf(field) === String(v) || field === v;
  });
}

// Verified server behaviour: an origin PATCH appends the child to the new parent's list and
// leaves it on the old one; an unknown filter field is dropped (query echoed without it) and
// every record comes back; GET by id answers 404 for a missing record.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const [, , object, id] = u.pathname.split('/');
  if (forbid && forbid(init.method, u.pathname)) return respond(403, { error: 'Forbidden. User has no permission.' });
  const coll = state[object];
  if (!coll) return respond(404, '<html>Error</html>');
  if (init.method === 'GET') {
    if (id) {
      const r = coll.find((x) => x._id === id);
      return r ? respond(200, r) : respond(404, { error: 'not found' });
    }
    let xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    if (unfilterable.has(object)) xquery = {};
    const limit = Number(u.searchParams.get('limit') || 50);
    const page = Number(u.searchParams.get('page') || 1);
    const rows = coll.filter((r) => matches(r, xquery));
    return respond(200, { pagination: { count: rows.length }, query: xquery, data: rows.slice((page - 1) * limit, page * limit) });
  }
  if (init.method === 'POST') {
    const rec = { _id: newId(), ...body, updatedAt: `N${seq++}` };
    coll.push(rec);
    if (body.origin) {
      const parent = state[body.origin.modelName.toLowerCase()].find((x) => x._id === body.origin.docId);
      const list = `${object}s`;
      parent[list] = [rec._id, ...(parent[list] || [])];
    }
    return respond(201, rec);
  }
  if (init.method === 'PATCH') {
    const rec = coll.find((x) => x._id === id);
    if (!rec) return respond(404, { error: 'not found' });
    Object.assign(rec, body, { updatedAt: `U${seq++}` });
    if (body.origin) {
      const parent = state[body.origin.modelName.toLowerCase()].find((x) => x._id === body.origin.docId);
      const list = `${object}s`;
      if (!(parent[list] || []).includes(id)) parent[list] = [id, ...(parent[list] || [])];
    }
    return respond(200, rec);
  }
  return respond(405, { error: 'unexpected' });
}

let stdout;
let stderr;
async function run(args) {
  stdout = '';
  stderr = '';
  const code = await cleanup.main([args[0], D, ...args.slice(1)], {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } },
  });
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Errors go to stderr.
  }
  return { code, json };
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const COMPANY_MERGE = { kind: 'merge', object: 'company', primary: P_CO, duplicates: [D_CO] };
const CONTACT_MERGE = { kind: 'merge', object: 'contact', primary: P_CT, duplicates: [D_CT] };

async function previewThenApply(plan, extra = []) {
  const p = await run(['preview', JSON.stringify(plan)]);
  expect(p.code).toBe(0);
  calls = [];
  return run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed', ...extra]);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-root-'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-out-'));
  prevScratch = process.env.CLAUDE_SCRATCHPAD;
  process.env.CLAUDE_SCRATCHPAD = scratch;
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  calls = [];
  seq = 0;
  forbid = null;
  unfilterable = new Set();
  state = {
    company: [
      { _id: P_CO, companyName: 'Acme SAS', companyCode: 'CMP-1', domains: ['acme.example.org'], website: null, notes: [], updatedAt: 'P1', createdAt: '2025-01-01' },
      {
        _id: D_CO, companyName: 'ACME Ltda.', companyCode: 'CMP-2', domains: ['acme.example.org', 'acme-co.example.org'], website: 'https://acme.example.org', address: { city: 'Bogotá' }, notes: ['n1'], updatedAt: 'D1', createdAt: '2025-02-01',
      },
    ],
    contact: [
      {
        _id: P_CT, firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.org', workspace: WS, assignee: ME, tags: [], notes: [], phones: [], updatedAt: 'P2', createdAt: '2025-01-01',
      },
      {
        _id: D_CT, firstName: 'Ana', lastName: 'Ruíz', email: 'ana.ruiz@example.org', mobile: '+57 300 111 2222', jobTitle: 'CEO', workspace: WS, assignee: SELLER, tags: [TAG_OLD], notes: ['n2'], updatedAt: 'D2', createdAt: '2025-03-01',
      },
      {
        _id: X_CT, firstName: 'Old', lastName: 'Timer', email: 'old@example.org', workspace: WS, tags: [], updatedAt: '2024-05-01', createdAt: '2024-01-01',
      },
    ],
    note: [
      { _id: 'n1', content: 'x', origin: { modelName: 'Company', docId: D_CO } },
      { _id: 'n2', content: 'y', origin: { modelName: 'Contact', docId: D_CT } },
    ],
    task: [],
    call: [],
    meeting: [{ _id: 'm1', attendees: [D_CT, SELLER], origin: { modelName: 'Contact', docId: X_CT } }],
    deal: [{ _id: 'deal1', contact: D_CT, company: D_CO, updatedAt: '2024-01-01' }],
    presentation: [],
    conversation: [],
    contactlist: [{ _id: 'l1', contacts: [P_CT, D_CT] }],
    email: [{ _id: 'e1', contact: D_CT, createdAt: '2025-01-01' }],
    contactsubmission: [],
    lead: [],
    contract: [],
    ticket: [],
    invoice: [],
    subscription: [],
    paymentmethod: [],
    emailcampaign: [],
    calendarevent: [],
    workorder: [],
    pricebook: [],
    asset: [],
    group: [],
    tag: [{ _id: TAG_OLD, tagName: 'VIP', modelName: 'Contact' }],
    webhook: [],
    script: [],
  };
});

afterEach(() => {
  if (prevScratch === undefined) delete process.env.CLAUDE_SCRATCHPAD;
  else process.env.CLAUDE_SCRATCHPAD = prevScratch;
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('detection (pure)', () => {
  const contacts = [
    { _id: 'a', firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.org', mobile: '+57 300 111 2222' },
    { _id: 'b', firstName: 'Pedro', lastName: 'Gil', email: 'p@example.org', otherEmails: [{ email: 'ANA@example.org' }] },
    { _id: 'c', firstName: 'Carla', lastName: 'Mendez', email: 'c@example.org', phones: [{ number: '3001112222' }] },
    { _id: 'd', firstName: 'Mariana', lastName: 'Gutierrez', email: 'm1@example.org' },
    { _id: 'e', firstName: 'Mariana', lastName: 'Gutiérrez', email: 'm2@sub.example.org' },
    { _id: 'f', firstName: 'Solo', lastName: 'Uno', email: 'solo@example.org' },
  ];

  test('groups by e-mail (also other e-mails), phone tail and similar name', () => {
    const { groups } = cleanup.findDuplicates('contact', contacts, ['email', 'phone', 'name']);
    const sets = groups.map((g) => g.records.map((r) => r._id).sort().join(''));
    expect(sets).toContain('abc');
    expect(sets).toContain('de');
    expect(groups.find((g) => g.records.length === 3).confidence).toBe('high');
    expect(groups.find((g) => g.records.length === 2).confidence).toBe('low');
  });

  test('a group joined by a shared phone across different names is flagged mixedNames', () => {
    const recs = [
      { _id: 'a', firstName: 'Juan', lastName: 'Perez', email: 'j@example.org', mobile: '555 5123 4567' },
      { _id: 'b', firstName: 'Felipe', lastName: 'Zuleta', email: 'f@example.org', mobile: '5123 4567' },
    ];
    const { groups } = cleanup.findDuplicates('contact', recs, ['phone']);
    expect(groups[0].mixedNames).toBe(true);
  });

  test('only the requested keys are used', () => {
    const { groups } = cleanup.findDuplicates('contact', contacts, ['email']);
    expect(groups.map((g) => g.records.map((r) => r._id).sort().join(''))).toEqual(['ab']);
  });

  test('a phone shared by too many records is skipped, not grouped', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ _id: `x${i}`, firstName: `N${i}`, email: `n${i}@example.org`, mobile: '601 0000000' }));
    const { groups, skippedKeys } = cleanup.findDuplicates('contact', many, ['phone']);
    expect(groups).toEqual([]);
    expect(skippedKeys[0]).toMatchObject({ by: 'phone', records: 12 });
  });

  test('companies match by domain and by name without the legal suffix; free mail is ignored', () => {
    const companies = [
      { _id: '1', companyName: 'Acme S.A.S.', domains: [] , website: 'https://www.acme.example.org/x' },
      { _id: '2', companyName: 'ACME Ltda', primaryEmail: 'info@acme.example.org' },
      { _id: '3', companyName: 'Beta', primaryEmail: 'beta@example.com' },
      { _id: '4', companyName: 'Gamma', primaryEmail: 'gamma@example.com' },
    ];
    const { groups } = cleanup.findDuplicates('company', companies, ['domain', 'name']);
    expect(groups).toHaveLength(1);
    expect(groups[0].why.join(' ')).toMatch(/same domain \(acme\.example\.org\)/);
    expect(cleanup.companyKey('Acme S.A. de C.V.')).toBe('acme');
    expect(cleanup.hostOf('x@example.com')).toBeNull();
  });
});

describe('merge payloads (pure)', () => {
  test('fills only empty fields, never the owner, and adds e-mails, phones and tags', () => {
    const primary = { _id: 'p', firstName: 'Ana', email: 'a@example.org', assignee: 'u1', tags: ['t1'], phones: [{ number: '3001112222' }] };
    const dup = {
      _id: 'd', firstName: 'Anita', lastName: 'Ruiz', email: 'b@example.org', assignee: 'u2', tags: ['t1', 't2'], mobile: '+57 300 111 2222', whatsapp: '+57 311 999 8888',
    };
    const { payload } = cleanup.fillPayload('contact', primary, [dup]);
    expect(payload.firstName).toBeUndefined();
    expect(payload.lastName).toBe('Ruiz');
    expect(payload.assignee).toBeUndefined();
    expect(payload.otherEmails).toEqual([{ name: 'merged', email: 'b@example.org' }]);
    expect(payload.tags).toEqual(['t1', 't2']);
    // The duplicate's mobile has the same number as the primary's phone; its WhatsApp fills the empty field.
    expect(payload.whatsapp).toBe('+57 311 999 8888');
    expect(payload.phones).toBeUndefined();
  });

  test('companies union their domains', () => {
    const { payload } = cleanup.fillPayload('company', { domains: ['a.org'] }, [{ domains: ['A.org', 'b.org'] }]);
    expect(payload.domains).toEqual(['a.org', 'b.org']);
  });

  test('move bodies: field, origin and array without duplicates', () => {
    const ref = (label) => cleanup.REFS.contact.find((r) => r.label === label);
    const [deal, note, attendee] = [ref('deals'), ref('notes'), ref('meetings (attendee)')];
    expect(cleanup.moveBody(deal, {}, 'd', 'p')).toEqual({ contact: 'p' });
    expect(cleanup.moveBody(note, {}, 'd', 'p')).toEqual({ origin: { modelName: 'Contact', docId: 'p' } });
    expect(cleanup.moveBody(attendee, { attendees: ['p', 'd', 'u'] }, 'd', 'p')).toEqual({ attendees: ['p', 'u'] });
  });

  test('read-back accepts server defaults on top of what was sent', () => {
    expect(cleanup.contains({ city: 'X', location: {} }, { city: 'X' })).toBe(true);
    expect(cleanup.contains({ city: 'Y' }, { city: 'X' })).toBe(false);
    expect(cleanup.contains({ _id: 'c1' }, 'c1')).toBe(true);
  });
});

describe('read commands', () => {
  test('duplicates scans every page and writes the detail file', async () => {
    const { code, json } = await run(['duplicates', 'company']);
    expect(code).toBe(0);
    expect(json.groups).toBe(1);
    expect(json.shown[0].suggestedPrimary).toBe(D_CO);
    expect(fs.existsSync(json.detailFile)).toBe(true);
    expect(writes()).toEqual([]);
  });

  test('show lists what points at a contact and what would stay behind', async () => {
    const { code, json } = await run(['show', 'contact', D_CT]);
    expect(code).toBe(0);
    const by = Object.fromEntries(json.pointingAtIt.map((r) => [r.what, r]));
    expect(by.deals.count).toBe(1);
    expect(by['e-mails'].merge).toMatch(/stays on the duplicate/);
    expect(by['contact lists'].merge).toBe('moves to the primary');
  });

  test('inactive skips contacts with a recent deal or e-mail', async () => {
    state.contact.push({ _id: newId(), firstName: 'Busy', email: 'busy@example.org', updatedAt: '2024-02-01' });
    state.deal.push({ _id: 'deal2', contact: state.contact[3]._id, updatedAt: '2025-06-01' });
    const { code, json } = await run(['inactive', '--before', '2025-01-01']);
    expect(code).toBe(0);
    expect(json.contacts.map((c) => c.email)).toEqual(['old@example.org']);
  });

  test('inactive needs a date', async () => {
    expect((await run(['inactive'])).code).toBe(2);
  });
});

describe('company merge', () => {
  test('preview writes nothing, lists fills, moves, what stays, and tells the agent to stop', async () => {
    const { code, json } = await run(['preview', JSON.stringify(COMPANY_MERGE)]);
    expect(code).toBe(0);
    expect(writes()).toEqual([]);
    expect(json.preview.moves).toEqual({ notes: 1 });
    expect(json.preview.fillsPrimary.map((f) => f.field)).toEqual(['website', 'address', 'domains']);
    expect(json.preview.staysOnDuplicate.map((s) => s.what)).toEqual(['deals']);
    expect(json.warnings.join(' ')).toMatch(/Deals keep the old company/);
    expect(json.nextStep).toMatch(/STOP HERE/);
  });

  test('apply fills, moves, marks the duplicate, leaves an audit note and reads back', async () => {
    const { code, json } = await previewThenApply(COMPANY_MERGE);
    expect(code).toBe(0);
    expect(json.problems).toEqual([]);
    const primary = state.company.find((c) => c._id === P_CO);
    const dup = state.company.find((c) => c._id === D_CO);
    expect(primary.website).toBe('https://acme.example.org');
    expect(primary.domains).toEqual(['acme.example.org', 'acme-co.example.org']);
    expect(state.note.find((n) => n._id === 'n1').origin.docId).toBe(P_CO);
    expect(dup.companyName).toBe('[FUSIONADA] ACME Ltda.');
    expect(dup.domains).toEqual([]);
    expect(writes().some((w) => w.method === 'DELETE')).toBe(false);
    const audit = writes().find((w) => w.path === '/v2/note' && w.method === 'POST');
    expect(audit.body.origin).toEqual({ modelName: 'Company', docId: P_CO });
    const log = JSON.parse(fs.readFileSync(json.logFile, 'utf8'));
    expect(log.log.find((l) => l.action === 'move')).toMatchObject({ model: 'note', _id: 'n1', from: D_CO, to: P_CO });
  });

  test('a second preview of the same group is blocked as already merged', async () => {
    await previewThenApply(COMPANY_MERGE);
    const again = await run(['preview', JSON.stringify(COMPANY_MERGE)]);
    expect(again.code).toBe(3);
    expect(again.json.blockers.join(' ')).toMatch(/Already merged/);
  });

  test('apply refuses without --confirmed and with a stale version', async () => {
    const p = await run(['preview', JSON.stringify(COMPANY_MERGE)]);
    calls = [];
    expect((await run(['apply', JSON.stringify(COMPANY_MERGE), '--version', p.json.version])).code).toBe(2);
    state.company[1].updatedAt = 'D9';
    expect((await run(['apply', JSON.stringify(COMPANY_MERGE), '--version', p.json.version, '--confirmed'])).code).toBe(3);
    expect(stderr).toMatch(/changed since the preview/);
    expect(writes()).toEqual([]);
  });

  test('a filter the server drops blocks the merge instead of moving every record', async () => {
    unfilterable.add('note');
    const { code, json } = await run(['preview', JSON.stringify(COMPANY_MERGE)]);
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toMatch(/notes .*unfilterable/);
  });

  test('the account owner company cannot be the duplicate', async () => {
    state.company[1].isAccountOwner = true;
    const { code, json } = await run(['preview', JSON.stringify(COMPANY_MERGE)]);
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toMatch(/account's own company/);
  });

  test('a 403 stops with FORBIDDEN and is not retried', async () => {
    forbid = (method, p) => p.startsWith('/v2/company');
    const { code } = await run(['preview', JSON.stringify(COMPANY_MERGE)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/FORBIDDEN/);
    expect(calls.filter((c) => c.path.startsWith('/v2/company'))).toHaveLength(1);
  });
});

describe('contact merge', () => {
  test('active webhooks on written models need --fires-webhooks', async () => {
    state.webhook.push({ _id: 'w1', webhookName: 'CRM sync', eventNames: ['Deal.update'], active: true });
    const p = await run(['preview', JSON.stringify(CONTACT_MERGE)]);
    expect(p.json.preview.triggers).toEqual([{ type: 'webhook', name: 'CRM sync', events: ['Deal.update'] }]);
    expect(p.json.nextStep).toMatch(/--fires-webhooks/);
    calls = [];
    const blocked = await run(['apply', JSON.stringify(CONTACT_MERGE), '--version', p.json.version, '--confirmed']);
    expect(blocked.code).toBe(3);
    expect(writes()).toEqual([]);
    const ok = await run(['apply', JSON.stringify(CONTACT_MERGE), '--version', p.json.version, '--confirmed', '--fires-webhooks']);
    expect(ok.code).toBe(0);
  });

  test('apply moves deals, notes, lists and attendees, tags the duplicate and keeps the owner', async () => {
    const { code, json } = await previewThenApply(CONTACT_MERGE);
    expect(code).toBe(0);
    expect(json.problems).toEqual([]);
    expect(state.deal[0].contact).toBe(P_CT);
    expect(state.note.find((n) => n._id === 'n2').origin.docId).toBe(P_CT);
    expect(state.contactlist[0].contacts).toEqual([P_CT]);
    expect(state.meeting[0].attendees).toEqual([P_CT, SELLER]);
    const primary = state.contact.find((c) => c._id === P_CT);
    expect(primary.assignee).toBe(ME);
    expect(primary.jobTitle).toBe('CEO');
    expect(primary.otherEmails).toEqual([{ name: 'merged', email: 'ana.ruiz@example.org' }]);
    const tag = state.tag.find((t) => t.tagName === 'Fusionado');
    expect(tag).toBeTruthy();
    expect(state.contact.find((c) => c._id === D_CT).tags).toEqual([TAG_OLD, tag._id]);
    // E-mails cannot be re-pointed: they stay on the duplicate.
    expect(state.email[0].contact).toBe(D_CT);
  });

  test('different workspaces block the merge', async () => {
    state.contact[1].workspace = OTHER_WS;
    const { code, json } = await run(['preview', JSON.stringify(CONTACT_MERGE)]);
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toMatch(/different workspaces/);
  });

  test('an opted-out duplicate is a warning the user must hear', async () => {
    state.contact[1].emailStatus = { state: 'unsubscribed' };
    const { json } = await run(['preview', JSON.stringify(CONTACT_MERGE)]);
    expect(json.warnings.join(' ')).toMatch(/unsubscribed, bounced or rejected/);
    expect(json.warnings.join(' ')).toMatch(/different owners/);
  });

  test('a seller that cannot read a movable reference gets FORBIDDEN, never a partial merge', async () => {
    forbid = (method, p) => method === 'GET' && p === '/v2/presentation';
    const { code } = await run(['preview', JSON.stringify(CONTACT_MERGE)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/FORBIDDEN/);
  });

  test('a report-only reference it cannot read is noted, not fatal', async () => {
    forbid = (method, p) => method === 'GET' && p === '/v2/invoice';
    const { code, json } = await run(['show', 'contact', D_CT]);
    expect(code).toBe(0);
    expect(json.pointingAtIt.find((r) => r.what === 'invoices').note).toMatch(/no permission/);
  });

  test('the primary cannot be its own duplicate', async () => {
    const plan = { ...CONTACT_MERGE, duplicates: [P_CT] };
    expect((await run(['preview', JSON.stringify(plan)])).code).toBe(2);
  });
});

describe('archive', () => {
  test('tags contacts (creating the tag) and reads back; nothing is deleted', async () => {
    const plan = { kind: 'archive', contacts: ['old@example.org'] };
    const p = await run(['preview', JSON.stringify(plan)]);
    expect(p.json.preview.toTag.map((c) => c.email)).toEqual(['old@example.org']);
    expect(writes()).toEqual([]);
    calls = [];
    const { code, json } = await run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(code).toBe(0);
    expect(json.archived).toBe(1);
    const tag = state.tag.find((t) => t.tagName === 'Archivado');
    expect(state.contact.find((c) => c._id === X_CT).tags).toEqual([tag._id]);
    expect(writes().map((w) => w.method)).toEqual(['POST', 'PATCH']);
  });

  test('companies cannot be archived', async () => {
    const { code } = await run(['preview', JSON.stringify({ kind: 'archive', object: 'company', contacts: ['x'] })]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/companies have no tags/);
  });
});
