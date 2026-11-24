/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const polls = require('../.claude/skills/prolibu-polls/scripts/polls');

const D = 'dev99.example.com';
const KEY = 'SECRET123';
const DEAL = 'a'.repeat(24);
const TICKET = 'b'.repeat(24);
const STAGE = 'c'.repeat(24);
const CONTACT = 'd'.repeat(24);
const AGENT = 'e'.repeat(24);
const OTHER_AGENT = 'f'.repeat(24);
// Vote ids ordered by creation time, like real ObjectIds.
const vid = (n) => `6a${String(n).padStart(22, '0')}`;

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function vote(n, extra = {}) {
  return {
    _id: vid(n), rating: 4, annulled: false, voterName: `Voter ${n}`, candidateName: 'Ana Agent', title: 'Deal X',
    candidate: { modelName: 'User', docId: AGENT }, evaluation: { modelName: 'Deal', docId: DEAL },
    ip: '203.0.113.9', note: `note ${n}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: `U${n}`, ...extra,
  };
}

function project(doc, select) {
  if (!select) return doc;
  const keep = select.split(' ');
  return Object.fromEntries(Object.entries(doc).filter(([k]) => k === '_id' || keep.includes(k)));
}

// Fake of the routes the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  calls.push({ method: init.method, path: u.pathname, query: q });
  const p = u.pathname;
  if (p === '/v2/preference/read') {
    return state.admin ? respond(200, { preference: state.prefs }) : respond(403, { error: 'Forbidden' });
  }
  if (p === '/v2/user/preferences') {
    // The public copy carries agentRating (publicPreference) but not the survey switches.
    return respond(200, { modules: { sales: { deals: { agentRating: { enabled: true } } } } });
  }
  if (p === '/v2/poll' || p === '/v2/question') {
    return state.admin ? respond(200, { data: [], pagination: { count: 2 } }) : respond(403, { error: 'Forbidden' });
  }
  if (p === `/v2/deal/${DEAL}`) return respond(200, state.deal);
  if (p === `/v2/ticket/${TICKET}`) return respond(200, state.ticket);
  if (p === `/v2/stage/${STAGE}`) return respond(200, { _id: STAGE, stageName: 'Won', endFlowStage: true });
  if (p === `/v2/contact/${CONTACT}`) return respond(200, { firstName: 'Carla', lastName: 'Client', email: 'carla@example.com' });
  if (p === `/v2/user/${AGENT}`) return respond(200, { _id: AGENT, firstName: 'Ana', lastName: 'Agent', email: 'ana@example.com' });
  if (p === '/v2/user') {
    const email = JSON.parse(q.xquery).email;
    return respond(200, { data: email === 'ana@example.com' ? [{ _id: AGENT, firstName: 'Ana', lastName: 'Agent', email }] : [] });
  }
  if (p === '/v2/vote/status') return respond(200, state.status || { voteId: null, rating: null, note: null });
  if (p === '/v2/vote/report') return respond(200, { votesCount: 3, average: 4.333333, median: 5 });
  if (p === '/v2/vote' && init.method === 'GET') {
    if (!state.admin) return respond(403, { error: `Forbidden for key ${KEY}` });
    let rows = state.votes.slice();
    const x = q.xquery ? JSON.parse(q.xquery) : {};
    const conds = x.$and || [x];
    for (const c of conds) {
      if (c._id && c._id.$gt) rows = rows.filter((v) => v._id > c._id.$gt);
      if (c._id && c._id.$gte) rows = rows.filter((v) => v._id >= c._id.$gte);
      if (!state.serverIgnoresNested && c['candidate.docId']) rows = rows.filter((v) => v.candidate.docId === c['candidate.docId']);
    }
    rows.sort((a, b) => (a._id < b._id ? -1 : 1));
    const limit = Number(q.limit);
    return respond(200, { data: rows.slice(0, limit).map((v) => project(v, q.select)), pagination: { count: rows.length } });
  }
  const one = p.match(/^\/v2\/vote\/([a-f0-9]{24})$/);
  if (one) {
    const found = state.votes.find((v) => v._id === one[1]);
    if (init.method === 'DELETE') {
      if (state.deleteStatus) return respond(state.deleteStatus, { error: 'nope' });
      if (state.deleteNoop) return respond(200, { deleted: true });
      state.votes = state.votes.filter((v) => v._id !== one[1]);
      return respond(200, { deleted: true });
    }
    return found ? respond(200, project(found, q.select)) : respond(404, { error: 'No encontrado' });
  }
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

const run = (argv) => polls.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-polls-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  out = '';
  err = '';
  calls = [];
  state = {
    admin: true,
    prefs: { modules: { sales: { deals: { customerSatisfaction: { sendSurveyOnEndStage: true }, agentRating: { enabled: false } } }, support: { tickets: { customerSatisfaction: { sendSurveyOnEndStage: false } } } } },
    deal: { _id: DEAL, dealName: 'Deal X', stage: STAGE, contact: { _id: CONTACT }, assignee: AGENT, proposal: { enabled: true } },
    ticket: { _id: TICKET, subject: 'Printer', stage: STAGE, requester: { user: OTHER_AGENT }, assignee: null },
    votes: [],
  };
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('settings', () => {
  test('a non-admin key reports the survey switches as unknown, never as off', async () => {
    state.admin = false;
    expect(await run(['settings', D])).toBe(0);
    const r = json();
    expect(r.settings.dealSurveyOnClosingStage).toBeNull();
    expect(r.settings.ticketSurveyOnClosingStage).toBeNull();
    expect(r.settings.proposalViewerRating).toBe(true);
    expect(r.pollRecords).toBe('forbidden');
  });

  test('an admin key reads the real switches', async () => {
    expect(await run(['settings', D])).toBe(0);
    const r = json();
    expect(r.settings).toMatchObject({ dealSurveyOnClosingStage: true, ticketSurveyOnClosingStage: false, proposalViewerRating: false });
    expect(r.pollRecords).toBe(2);
  });
});

describe('survey-check', () => {
  test('a deal with a proposal, a contact and the switch on sends to the contact', async () => {
    expect(await run(['survey-check', D, 'deal', DEAL])).toBe(0);
    const r = json();
    expect(r.sendsOnNextClosingMove).toBe(true);
    expect(r.recipient).toEqual({ kind: 'Contact', name: 'Carla Client', email: 'carla@example.com' });
    expect(r.ratedAgentId).toBe(AGENT);
    const st = calls.find((c) => c.path === '/v2/vote/status');
    expect(st.query).toMatchObject({ voterModelName: 'Contact', voterDocId: CONTACT, candidateDocId: AGENT, evaluationModelName: 'Deal', evaluationDocId: DEAL });
  });

  test('a deal without an active proposal never sends', async () => {
    state.deal.proposal.enabled = false;
    await run(['survey-check', D, 'Deal', DEAL]);
    expect(json().sendsOnNextClosingMove).toBe(false);
  });

  test('a customer who already answered gets no second survey', async () => {
    state.status = { voteId: vid(1), rating: 2, note: null };
    await run(['survey-check', D, 'Deal', DEAL]);
    expect(json().sendsOnNextClosingMove).toBe(false);
    expect(json().alreadyAnswered).toEqual({ voteId: vid(1), rating: 2 });
  });

  test('a deal without an assignee rates its creator', async () => {
    state.deal.assignee = null;
    state.deal.createdBy = OTHER_AGENT;
    await run(['survey-check', D, 'Deal', DEAL]);
    expect(json().ratedAgentId).toBe(OTHER_AGENT);
  });

  test('a ticket without an assignee never sends, and its requester user would be the voter', async () => {
    state.prefs.modules.support.tickets.customerSatisfaction.sendSurveyOnEndStage = true;
    await run(['survey-check', D, 'Ticket', TICKET]);
    const r = json();
    expect(r.sendsOnNextClosingMove).toBe(false);
    expect(r.recipient.kind).toBe('User');
  });

  test('with a non-admin key the answer is unknown, not yes', async () => {
    state.admin = false;
    await run(['survey-check', D, 'Deal', DEAL]);
    expect(json().sendsOnNextClosingMove).toBe('unknown');
  });

  test('only Deal and Ticket are accepted', async () => {
    expect(await run(['survey-check', D, 'Contact', DEAL])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('results', () => {
  test('pages with a cursor on _id, one call at a time, and never reads the voter IP', async () => {
    state.votes = Array.from({ length: 1001 }, (_, i) => vote(i + 1, { rating: (i % 5) + 1 }));
    expect(await run(['results', D, '--model', 'Deal'])).toBe(0);
    const pages = calls.filter((c) => c.path === '/v2/vote');
    expect(pages).toHaveLength(3);
    for (const c of pages) {
      expect(c.query.sort).toBe('_id');
      expect(c.query.select).not.toMatch(/\bip\b/);
      expect(c.query.select).not.toMatch(/\bnote\b/);
    }
    expect(JSON.parse(pages[1].query.xquery).$and).toContainEqual({ _id: { $gt: vid(500) } });
    const r = json();
    expect(r.answers).toBe(1001);
    expect(r.respondents).toHaveLength(50);
    expect(out).not.toContain('203.0.113.9');
  });

  test('leaves annulled votes out and computes average and median like the server', async () => {
    state.votes = [vote(1, { rating: 5 }), vote(2, { rating: 3 }), vote(3, { rating: 4 }), vote(4, { rating: 1, annulled: true }), vote(5, { rating: 2 })];
    await run(['results', D]);
    const r = json();
    expect(r.answers).toBe(4);
    expect(r.annulledExcluded).toBe(1);
    expect(r.average).toBe(3.5);
    expect(r.median).toBe(3.5);
    expect(r.distribution).toEqual({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 1 });
  });

  test('re-applies the filter when the server ignores it, and says so', async () => {
    state.serverIgnoresNested = true;
    state.votes = [vote(1), vote(2, { candidate: { modelName: 'User', docId: OTHER_AGENT } })];
    await run(['results', D, '--agent', 'ana@example.com']);
    const r = json();
    expect(r.answers).toBe(1);
    expect(r.warning).toMatch(/did not match the filter/);
  });

  test('stops at --max and reports it was cut', async () => {
    state.votes = Array.from({ length: 1200 }, (_, i) => vote(i + 1));
    await run(['results', D, '--max', '500']);
    expect(json().truncated).toBe(true);
    expect(calls.filter((c) => c.path === '/v2/vote')).toHaveLength(1);
  });

  test('notes only with --with-notes', async () => {
    state.votes = [vote(1)];
    await run(['results', D, '--with-notes']);
    expect(calls.find((c) => c.path === '/v2/vote').query.select).toMatch(/\bnote\b/);
    expect(json().respondents[0].note).toBe('note 1');
  });

  test('a user without the vote permission is blocked, and the key never shows', async () => {
    state.admin = false;
    expect(await run(['results', D])).toBe(3);
    expect(err).toMatch(/agent-report/);
    expect(out + err).not.toContain(KEY);
  });

  test('rejects a malformed date before calling', async () => {
    expect(await run(['results', D, '--since', '1/11/2026'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('agent-report', () => {
  test('resolves the agent by e-mail and calls the app report once', async () => {
    expect(await run(['agent-report', D, 'ana@example.com', '--model', 'Ticket'])).toBe(0);
    const rep = calls.filter((c) => c.path === '/v2/vote/report');
    expect(rep).toHaveLength(1);
    expect(rep[0].query).toMatchObject({ candidateModelName: 'User', candidateDocId: AGENT, evaluationModelName: 'Ticket', type: '*' });
    expect(json()).toMatchObject({ answers: 3, average: 4.33, median: 5 });
  });

  test('needs the model', async () => {
    expect(await run(['agent-report', D, AGENT])).toBe(2);
  });

  test('an unknown e-mail is blocked', async () => {
    expect(await run(['agent-report', D, 'nobody@example.com', '--model', 'Deal'])).toBe(3);
  });
});

describe('remove', () => {
  const plan = (ids) => JSON.stringify({ voteIds: ids });

  test('preview writes nothing and tells the agent to stop', async () => {
    state.votes = [vote(1), vote(2)];
    expect(await run(['remove-preview', D, plan([vid(1)])])).toBe(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const r = json();
    expect(r.nextStep).toMatch(/STOP HERE/);
    expect(r.warnings.join(' ')).toMatch(/answer again/);
    expect(r.version).toMatch(/^[a-f0-9]{16}$/);
  });

  test('refuses without --version or --confirmed', async () => {
    state.votes = [vote(1)];
    expect(await run(['remove', D, plan([vid(1)]), '--confirmed'])).toBe(2);
    expect(await run(['remove', D, plan([vid(1)]), '--version', 'x'])).toBe(2);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('refuses when a vote changed since the preview', async () => {
    state.votes = [vote(1)];
    await run(['remove-preview', D, plan([vid(1)])]);
    const { version } = json();
    state.votes[0].updatedAt = 'changed';
    out = '';
    expect(await run(['remove', D, plan([vid(1)]), '--version', version, '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('deletes, reads back a 404 and reports each vote', async () => {
    state.votes = [vote(1), vote(2), vote(3)];
    await run(['remove-preview', D, plan([vid(1), vid(2)])]);
    const { version } = json();
    out = '';
    expect(await run(['remove', D, plan([vid(1), vid(2)]), '--version', version, '--confirmed'])).toBe(0);
    expect(json()).toEqual({ saved: true, removed: [vid(1), vid(2)], problems: [] });
    expect(state.votes.map((v) => v._id)).toEqual([vid(3)]);
  });

  test('stops at the first failed delete', async () => {
    state.votes = [vote(1), vote(2)];
    await run(['remove-preview', D, plan([vid(1), vid(2)])]);
    const { version } = json();
    out = '';
    state.deleteStatus = 403;
    expect(await run(['remove', D, plan([vid(1), vid(2)]), '--version', version, '--confirmed'])).toBe(1);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  test('a delete that answers 200 but leaves the vote is a problem, and the rest wait', async () => {
    state.votes = [vote(1), vote(2)];
    await run(['remove-preview', D, plan([vid(1), vid(2)])]);
    const { version } = json();
    out = '';
    state.deleteNoop = true;
    expect(await run(['remove', D, plan([vid(1), vid(2)]), '--version', version, '--confirmed'])).toBe(1);
    expect(json().problems[0]).toMatch(/still reads back/);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  test('validates the plan before calling', async () => {
    expect(await run(['remove-preview', D, plan(['nope'])])).toBe(2);
    expect(await run(['remove-preview', D, plan([vid(1), vid(1)])])).toBe(2);
    expect(await run(['remove-preview', D, plan(Array.from({ length: 51 }, (_, i) => vid(i)))])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('pure helpers', () => {
  test('date filters become _id bounds inside $and', () => {
    const f = polls.buildFilters({ since: '2026-01-01', until: '2026-01-31' });
    expect(f).toEqual([{ _id: { $gte: `6955b900${'0'.repeat(16)}` } }, { _id: { $lt: expect.any(String) } }]);
  });
});
