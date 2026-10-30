/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const support = require('../.claude/skills/prolibu-support/scripts/support');

const D = 'dev99.example.com';
const ME = 'c'.repeat(24);
const T_APP = 'a'.repeat(24);
const T_MAIL = 'b'.repeat(24);
const CONTACT = 'd'.repeat(24);
const HUB = 'e'.repeat(24);
const CT = '1'.repeat(24);
const CT_TEAM = '2'.repeat(24);
const TEAM = '3'.repeat(24);
const ART = '4'.repeat(24);
const ART_PUB = '5'.repeat(24);
const PORTAL = '6'.repeat(24);
const S = {
  open: '64e6f53079d82378f83fc101',
  reopened: '9'.repeat(24),
  pending: '64e6f53079d82378f83fc102',
  resolved: '64e6f53079d82378f83fc103',
  low: '16b7f53079d82378f83fc312',
};

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function pick(doc, select) {
  if (!select) return JSON.parse(JSON.stringify(doc));
  const keys = select.split(' ');
  const outDoc = { _id: doc._id };
  for (const k of keys) if (doc[k] !== undefined) outDoc[k] = JSON.parse(JSON.stringify(doc[k]));
  return outDoc;
}

let seq = 0;
const newId = () => `f${String(seq++).padStart(23, '0')}`;

// A fake of the endpoints the script uses, shaped after the server behavior verified in code and
// on a live account: comments and notes link themselves to the ticket through origin, a comment on
// an App ticket in a closing stage reopens it, keynames and e-mails work as references, the e-mail
// hub returns its authorization header unless the select leaves it out.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: q, body });
  const p = u.pathname;
  if (p === '/v2/stage') return respond(200, { data: state.stages });
  if (p === '/v2/casetype') return respond(200, { data: state.caseTypes });
  if (p.startsWith('/v2/usergroup/')) return respond(200, state.teams[p.split('/').pop()] || {});
  if (p === '/v2/preference/read') return state.prefs ? respond(200, { preference: { modules: { support: { tickets: state.prefs } } } }) : respond(403, { error: 'Forbidden' });
  if (p === '/v2/emailhub') return respond(200, { data: state.hubs.map((h) => pick(h, q.select)) });
  if (p.startsWith('/v2/emailhub/')) {
    const hub = state.hubs.find((h) => h._id === p.split('/').pop());
    return hub ? respond(200, pick(hub, q.select)) : respond(404, { error: 'Not found' });
  }
  if (p === '/v2/routingrule') return respond(200, { data: state.rules });
  if (p === '/v2/user/me') return respond(200, { profile: { _id: ME, email: 'me@example.com', firstName: 'Me' } });
  if (p.startsWith('/v2/contact/')) {
    const ref = decodeURIComponent(p.split('/').pop());
    const c = state.contacts.find((x) => x._id === ref || x.email === ref);
    return c ? respond(200, c) : respond(404, { error: 'Not found' });
  }
  if (p === '/v2/company') return respond(200, { data: state.companies });
  if (p === '/v2/ticket' && init.method === 'GET') {
    const found = Object.values(state.tickets).filter((t) => t.ticketNumber === q.ticketNumber);
    return respond(200, { data: found.map((t) => pick(t, q.select)) });
  }
  if (p === '/v2/ticket' && init.method === 'POST') {
    const t = { _id: newId(), ticketNumber: `TIC-${seq}`, channel: 'App', updatedAt: 'U1', ...JSON.parse(JSON.stringify(body)) };
    const ct = state.caseTypes.find((c) => c._id === t.caseType);
    const team = ct && state.teams[ct.assignmentGroup];
    if (team && team.enableLoadBalancing && !t.assignee) t.assignee = team.users[0];
    if (t.assignee && t.assignee.includes('@')) t.assignee = t.assignee === 'me@example.com' ? ME : null;
    state.tickets[t._id] = t;
    return respond(201, t);
  }
  const tm = /^\/v2\/ticket\/([a-f0-9]{24})$/.exec(p);
  if (tm && init.method === 'GET') {
    const t = state.tickets[tm[1]];
    return t ? respond(200, pick(t, q.select)) : respond(404, { error: 'Not found' });
  }
  if (tm && init.method === 'PATCH') {
    const t = state.tickets[tm[1]];
    if (body.assignee && body.assignee.includes('@') && body.assignee !== 'me@example.com') {
      return respond(400, { error: `Document not found by primaryKey '${body.assignee}' in 'assignee'` });
    }
    for (const [k, v] of Object.entries(body)) {
      if (k === 'dates') t.dates = { ...(t.dates || {}), ...v };
      else t[k] = v === 'me@example.com' ? ME : v;
    }
    t.updatedAt = `${t.updatedAt}+`;
    return respond(200, t);
  }
  if ((p === '/v2/comment' || p === '/v2/note') && init.method === 'POST') {
    const id = newId();
    const t = state.tickets[body.origin.docId];
    const key = p === '/v2/comment' ? 'comments' : 'notes';
    t[key] = [id, ...(t[key] || [])];
    const closing = state.stages.find((s) => s._id === t.stage && s.endFlowStage);
    if (key === 'comments' && closing && state.prefs.reopenTicketsWithComments) t.stage = S.reopened;
    if (key === 'comments' && t.channel === 'Email') state.emails.push({ to: t.to, cc: body.ccRecipients || [] });
    t.updatedAt = `${t.updatedAt}+`;
    return respond(201, { _id: id, ...body });
  }
  if (p === '/v2/article' && init.method === 'GET') return respond(200, { data: Object.values(state.articles) });
  if (p === '/v2/article' && init.method === 'POST') {
    const a = { _id: newId(), articleCode: 'slug-1', status: 'draft', updatedAt: 'A1', ...body };
    state.articles[a._id] = a;
    return respond(201, a);
  }
  if (p.startsWith('/v2/article/feed/')) {
    const a = Object.values(state.articles).find((x) => x.articleCode === decodeURIComponent(p.split('/').pop()));
    return a && a.status === 'published' ? respond(200, a) : respond(404, { error: 'Not found' });
  }
  const am = /^\/v2\/article\/(.+)$/.exec(p);
  if (am && init.method === 'GET') {
    const ref = decodeURIComponent(am[1]);
    const a = Object.values(state.articles).find((x) => x._id === ref || x.articleCode === ref);
    return a ? respond(200, pick(a, q.select)) : respond(404, { error: 'Not found' });
  }
  if (am && init.method === 'PATCH') {
    const a = state.articles[am[1]];
    Object.assign(a, body, { updatedAt: `${a.updatedAt}+` });
    if (a.status === 'published' && !a.publishedAt) a.publishedAt = 'now';
    return respond(200, a);
  }
  if (p === '/v2/portal') return respond(200, { data: Object.values(state.portals).filter((x) => !q.xquery || (x.articles || []).includes(JSON.parse(q.xquery).$or[0].articles)) });
  const pm = /^\/v2\/portal\/(.+)$/.exec(p);
  if (pm && init.method === 'GET') {
    const x = Object.values(state.portals).find((y) => y._id === pm[1] || y.portalCode === pm[1]);
    return x ? respond(200, pick(x, q.select)) : respond(404, { error: 'Not found' });
  }
  if (pm && init.method === 'PATCH') {
    Object.assign(state.portals[pm[1]], body, { updatedAt: 'P2' });
    return respond(200, state.portals[pm[1]]);
  }
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

const run = (argv) => support.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET');

async function previewThen(argv, extra = []) {
  expect(await run(argv)).toBe(0);
  const { version } = json();
  out = '';
  return run([...argv, '--version', version, '--confirmed', ...extra]);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-support-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    stages: [
      { _id: S.open, stageName: 'Abierto', stageCode: 'ticket-stage-open', stageType: 'Ticket.stage', index: 100, active: true },
      { _id: S.reopened, stageName: 'Reabierto', stageCode: 'ticket-stage-reopened', stageType: 'Ticket.stage', index: 200, active: true },
      { _id: S.pending, stageName: 'Pendiente', stageCode: 'ticket-stage-pending', stageType: 'Ticket.stage', index: 300, active: true },
      { _id: S.resolved, stageName: 'Resuelto', stageCode: 'ticket-stage-resolved', stageType: 'Ticket.stage', index: 600, active: true, endFlowStage: true },
      { _id: S.low, stageName: 'Baja', stageCode: 'ticket-priority-low', stageType: 'Ticket.priority', index: 100, active: true },
    ],
    caseTypes: [
      { _id: CT, caseTypeCode: 'billing', resolutionArea: 'Facturación' },
      { _id: CT_TEAM, caseTypeCode: 'tech', resolutionArea: 'Soporte técnico', assignmentGroup: TEAM },
    ],
    teams: { [TEAM]: { _id: TEAM, userGroupName: 'Nivel 1', users: [ME, 'x'.repeat(24)], enableLoadBalancing: true } },
    prefs: { reopenTicketsWithComments: true, caseTypeIsRequired: false, companyAutoAssignation: { byRequesterCompanyDomains: true } },
    hubs: [{
      _id: HUB, emailHubCode: 'EMH-1', emailHubName: 'Soporte', caseType: CT, adProvider: 'Google', state: 'Connected', active: true, routingRules: [], authorizationHeader: 'HUBSECRET',
    }],
    rules: [],
    contacts: [{ _id: CONTACT, firstName: 'Ana', lastName: 'Ruiz', email: 'ana@acme.com' }],
    companies: [],
    emails: [],
    tickets: {
      [T_APP]: { _id: T_APP, ticketNumber: 'TIC-1', subject: 'App', channel: 'App', stage: S.open, updatedAt: 'V1', comments: [], notes: [], requester: { contact: CONTACT } },
      [T_MAIL]: {
        _id: T_MAIL, ticketNumber: 'TIC-2', subject: 'Mail', channel: 'Email', stage: S.open, updatedAt: 'V2', comments: [], notes: [],
        emailHubCode: HUB, to: 'ana@acme.com', ccEmails: ['boss@acme.com', 'ana@acme.com'], requester: { contact: CONTACT },
      },
    },
    articles: {
      [ART]: { _id: ART, articleCode: 'draft-art', articleTitle: 'Draft', summary: 's', status: 'draft', active: true, updatedAt: 'A1' },
      [ART_PUB]: { _id: ART_PUB, articleCode: 'pub-art', articleTitle: 'Pub', summary: 's', status: 'published', active: true, updatedAt: 'A2' },
    },
    portals: {
      [PORTAL]: { _id: PORTAL, portalCode: 'POR-1', portalName: 'Inicio', status: 'published', active: true, articles: [ART_PUB], slides: [], updatedAt: 'P1' },
    },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('pure rules', () => {
  test('plain text becomes escaped paragraphs; HTML is kept', () => {
    expect(support.toHtml('a < b\n\nsecond\nline')).toBe('<p>a &lt; b</p><p>second<br>line</p>');
    expect(support.toHtml('<p>x</p>')).toBe('<p>x</p>');
  });

  test('CC is split, lowercased, deduplicated, never holds the requester, and all-or-nothing', () => {
    expect(support.cleanEmails('Boss@Acme.com; ana@acme.com, boss@acme.com  x@y.co', 'ana@acme.com')).toEqual(['boss@acme.com', 'x@y.co']);
    expect(() => support.cleanEmails(['ok@example.com', 'nope'], '')).toThrow('nope');
  });

  test('routing takes the first hit in the server order and falls back to the mailbox case type', () => {
    const rules = [
      { routingRuleName: 'R1', ruleType: 'Subject Matching', pattern: 'invoice, bill', caseType: 'CT1' },
      { routingRuleName: 'R2', ruleType: 'Subject Matching', pattern: 'bill', caseType: 'CT2' },
      { routingRuleName: 'D1', ruleType: 'Domain Matching Group', domains: 'Acme.com', ticketGroup: 'G1' },
    ];
    const hit = support.routeEmail({ rules, hub: { caseType: 'DEF' }, subject: 'My BILL', from: 'a@ACME.com' });
    expect(hit).toMatchObject({ caseType: 'CT1', group: 'G1' });
    expect(support.routeEmail({ rules, hub: { caseType: 'DEF' }, subject: 'hello', from: 'a@b.com' })).toMatchObject({ caseType: 'DEF', group: null });
  });

  test('routing warns about a stray comma (matches everything), "@" domains and empty subjects', () => {
    const rules = [
      { routingRuleName: 'Loose', ruleType: 'Subject Matching', pattern: 'refund,', caseType: 'CT1' },
      { routingRuleName: 'At', ruleType: 'Domain Matching Group', domains: '@acme.com', ticketGroup: 'G1' },
    ];
    const r = support.routeEmail({ rules, hub: { caseType: 'DEF' }, subject: 'anything', from: 'a@acme.com' });
    expect(r.caseType).toBe('CT1');
    expect(r.group).toBe(null);
    expect(r.warnings.join(' ')).toMatch(/every subject/);
    expect(r.warnings.join(' ')).toMatch(/never matches/);
    expect(support.routeEmail({ rules: [], hub: null, subject: '', from: '' }).warnings.join(' ')).toMatch(/without a subject/);
  });

  test('articles: summary limit, scheduled needs a date, going live is flagged', () => {
    expect(support.checkArticle({}, { articleTitle: 't' }).blockers.join(' ')).toMatch(/needs "articleTitle" and "summary"/);
    expect(support.checkArticle({ _id: 1, summary: 's' }, { summary: 'x'.repeat(301) }).blockers.join(' ')).toMatch(/limit is 300/);
    expect(support.checkArticle({ _id: 1, summary: 's' }, { status: 'scheduled' }).blockers.join(' ')).toMatch(/needs "publishAt"/);
    expect(support.checkArticle({ _id: 1, summary: 's', status: 'draft' }, { status: 'published' }).goesLive).toBe(true);
    expect(support.checkArticle({ _id: 1, summary: 's', status: 'published' }, { summary: 'new' }).goesLive).toBe(false);
    expect(() => support.checkArticle({}, { publishedAt: 'x' })).toThrow('cannot be set');
  });

  test('portal lists keep what is there, skip duplicates and respect the limit', () => {
    expect(support.changePortalList(['a', 'b'], { add: ['b', 'c'], remove: ['a'] }, 'articles').next).toEqual(['b', 'c']);
    expect(support.changePortalList(['a'], { add: ['c'], position: 'start' }, 'articles').next).toEqual(['c', 'a']);
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(support.changePortalList(many, { add: ['x'] }, 'slides').blockers.join(' ')).toMatch(/at most 20/);
  });
});

describe('reads', () => {
  test('setup never asks for the mailbox authorization header', async () => {
    expect(await run(['setup', D])).toBe(0);
    expect(out).not.toContain('HUBSECRET');
    const hubCall = calls.find((c) => c.path === '/v2/emailhub');
    expect(hubCall.query.select).not.toMatch(/authorizationHeader/);
    expect(json().caseTypes[1].onNewTicket).toMatch(/next active member of "Nivel 1"/);
  });

  test('read commands refuse --confirmed', async () => {
    expect(await run(['setup', D, '--confirmed'])).toBe(2);
  });
});

describe('create', () => {
  const plan = (extra = {}) => JSON.stringify({ subject: 'Cannot log in', description: 'Hello\n\nThanks', requester: 'ana@acme.com', ...extra });

  test('preview writes nothing; the write needs the version and --confirmed', async () => {
    expect(await run(['create', D, plan()])).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(json().summary.stage).toBe('Abierto');
    expect(await run(['create', D, plan(), '--confirmed'])).toBe(2);
    expect(await run(['create', D, plan(), '--version', 'old', '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('posts the contact id, the first open stage and HTML, then reads back', async () => {
    expect(await previewThen(['create', D, plan({ priority: 'baja', caseType: 'billing' })])).toBe(0);
    const post = writes()[0];
    expect(post.path).toBe('/v2/ticket');
    expect(post.body).toMatchObject({ requester: { contact: CONTACT }, stage: S.open, priority: S.low, caseType: CT, description: '<p>Hello</p><p>Thanks</p>' });
    expect(post.body.channel).toBeUndefined();
    expect(json().saved).toBe(true);
  });

  test('a case type with a rotating team assigns by itself, and an explicit assignee skips it', async () => {
    expect(await run(['create', D, plan({ caseType: 'tech' })])).toBe(0);
    expect(json().effects.join(' ')).toMatch(/next active member/);
    out = '';
    expect(await run(['create', D, plan({ caseType: 'tech', assignee: 'me' })])).toBe(0);
    expect(json().warnings.join(' ')).toMatch(/rotation is skipped/);
  });

  test('blocks a closing stage and an unknown contact', async () => {
    expect(await run(['create', D, plan({ stage: 'resuelto' })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/closing stage/);
    out = '';
    expect(await run(['create', D, plan({ requester: 'nobody@acme.com' })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/No contact/);
  });
});

describe('update', () => {
  test('stage, priority and platform fields are refused before anything is sent', async () => {
    expect(await run(['update', D, JSON.stringify({ ticket: 'TIC-1', set: { stage: S.pending } })])).toBe(2);
    expect(err).toMatch(/prolibu-stages/);
    expect(await run(['update', D, JSON.stringify({ ticket: 'TIC-1', set: { channel: 'Email' } })])).toBe(2);
    expect(await run(['update', D, JSON.stringify({ ticket: 'TIC-1', set: { ccEmails: ['a@b.com'] } })])).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  test('sends only what changes; the due date travels nested', async () => {
    const p = JSON.stringify({ ticket: T_APP, set: { assignee: 'me', subject: 'App', dueAt: '2026-11-05T15:00:00Z' } });
    expect(await previewThen(['update', D, p])).toBe(0);
    expect(writes()[0].body).toEqual({ assignee: ME, dates: { dueAt: '2026-11-05T15:00:00.000Z' } });
    expect(json().saved).toBe(true);
  });

  test('an assignee e-mail that matches no user is reported, not hidden', async () => {
    const p = JSON.stringify({ ticket: T_APP, set: { assignee: 'ghost@acme.com' } });
    expect(await previewThen(['update', D, p])).toBe(1);
    expect(err).toMatch(/primaryKey/);
  });
});

describe('reply', () => {
  test('a note goes to /v2/note with origin and never e-mails', async () => {
    expect(await previewThen(['reply', D, JSON.stringify({ ticket: T_MAIL, as: 'note', content: 'internal' })])).toBe(0);
    expect(writes().map((c) => c.path)).toEqual(['/v2/note']);
    expect(writes()[0].body.origin).toEqual({ modelName: 'Ticket', docId: T_MAIL });
    expect(state.emails).toHaveLength(0);
    expect(json().noteId).toBeTruthy();
  });

  test('a reply on an e-mail ticket is blocked without --sends-email', async () => {
    const p = JSON.stringify({ ticket: T_MAIL, content: 'Hi' });
    expect(await run(['reply', D, p])).toBe(0);
    expect(json().requires).toEqual(['--sends-email']);
    expect(json().effects.join(' ')).toMatch(/CC boss@acme\.com/);
    out = '';
    expect(await previewThen(['reply', D, p])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('with --sends-email it copies the ticket CC without the requester, and updates the CC only when it changes', async () => {
    expect(await previewThen(['reply', D, JSON.stringify({ ticket: T_MAIL, content: 'Hi' })], ['--sends-email'])).toBe(0);
    expect(writes().map((c) => c.path)).toEqual(['/v2/comment']);
    expect(writes()[0].body.ccRecipients).toEqual(['boss@acme.com']);
    expect(json().emailed).toBe(true);
    calls = [];
    out = '';
    expect(await previewThen(['reply', D, JSON.stringify({ ticket: T_MAIL, content: 'Hi', cc: ['new@acme.com'] })], ['--sends-email'])).toBe(0);
    expect(writes().map((c) => c.path)).toEqual(['/v2/comment', `/v2/ticket/${T_MAIL}`]);
    expect(writes()[1].body).toEqual({ ccEmails: ['new@acme.com'] });
    calls = [];
    out = '';
    expect(await previewThen(['reply', D, JSON.stringify({ ticket: T_MAIL, content: 'Only Ana', cc: [] })], ['--sends-email'])).toBe(0);
    expect(writes()[0].body.ccRecipients).toEqual([]);
  });

  test('a reply on an App ticket sends no CC and says when it reopens a closed ticket', async () => {
    state.tickets[T_APP].stage = S.resolved;
    const p = JSON.stringify({ ticket: T_APP, content: 'Back' });
    expect(await run(['reply', D, p])).toBe(0);
    expect(json().effects.join(' ')).toMatch(/back to "Reopened"/);
    out = '';
    expect(await run(['reply', D, p, '--version', 'V1', '--confirmed'])).toBe(0);
    expect(writes()[0].body.ccRecipients).toBeUndefined();
    expect(json()).toMatchObject({ reopened: true, emailed: false });
    expect(await run(['reply', D, JSON.stringify({ ticket: T_APP, content: 'x', cc: ['a@b.com'] })])).toBe(2);
  });

  test('a reply on a ticket whose mailbox is gone is blocked', async () => {
    state.hubs = [];
    expect(await run(['reply', D, JSON.stringify({ ticket: T_MAIL, content: 'Hi' })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/mailbox no longer exists/);
  });
});

describe('articles and portal', () => {
  test('a new article is a draft; publishing needs --publish', async () => {
    expect(await previewThen(['article', D, JSON.stringify({ set: { articleTitle: 'How to', summary: 'Steps', body: 'One' } })])).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/v2/article', body: { body: '<p>One</p>' } });
    expect(json().liveNow).toBe(false);
    calls = [];
    out = '';
    const pub = JSON.stringify({ article: 'draft-art', set: { status: 'published' } });
    expect(await previewThen(['article', D, pub])).toBe(3);
    expect(writes()).toHaveLength(0);
    out = '';
    expect(await previewThen(['article', D, pub], ['--publish'])).toBe(0);
    expect(json()).toMatchObject({ status: 'published', liveNow: true });
  });

  test('adding to a published portal keeps its list, warns about drafts and needs --publish', async () => {
    const p = JSON.stringify({ portal: 'POR-1', add: ['draft-art'] });
    expect(await run(['portal', D, p])).toBe(0);
    expect(json().result).toEqual([ART_PUB, ART]);
    expect(json().warnings.join(' ')).toMatch(/will not show until it is published/);
    out = '';
    expect(await previewThen(['portal', D, p], ['--publish'])).toBe(0);
    expect(writes()[0].body).toEqual({ articles: [ART_PUB, ART] });
  });

  test('an unknown article blocks the portal change', async () => {
    expect(await run(['portal', D, JSON.stringify({ portal: PORTAL, add: ['missing-code'] })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/No article missing-code/);
  });
});
