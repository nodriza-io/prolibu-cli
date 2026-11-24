/* global describe, test, expect, beforeEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('../.claude/skills/prolibu-events/scripts/events');

const D = 'dev99.example.com';
const id = (ch) => ch.repeat(24);
const ME = id('a');
const EVENT = id('e');
const CAMPAIGN = id('c');
const OTHER_CAMPAIGN = id('9');
const OTHER_EVENT = id('8');
const PROSPECT = id('7');
const CONTACT1 = id('1');
const CONTACT2 = id('2');
const WON = id('3');
const LOST = id('4');
const OPEN = id('5');
const CUSTOM_CLOSED = id('6');
const PLANNED = id('b');
const PROMOTED = id('d');

let rootDir;
let out;
let err;
let calls;
let state;
let seq;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}
const newId = () => { seq += 1; return String(seq).padStart(24, 'f'); };
const xq = (u) => JSON.parse(u.searchParams.get('xquery') || '{}');

// Recalculates the event totals the way the server does after an expense or contact change.
function recompute(ev) {
  const exp = Object.values(state.expenses).filter((e) => e.businessEvent === ev._id);
  ev.metrics.totalExpense = Math.round(exp.reduce((s, e) => s + e.convertedAmount, 0) * 100) / 100;
  ev.metrics.contacts = Object.values(state.contacts).filter((c) => c.adCampaign === ev.adCampaign).map((c) => c._id);
}

// A small fake shaped after the verified server behavior: creating an event auto-creates its
// campaign; an expense is converted to the account currency (rate 1 when the conversion fails)
// and the event totals are recomputed after it; moving a prospect to Promoted creates the event.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const [, , col, key] = u.pathname.split('/');
  const m = init.method;
  if (m === 'GET' && u.pathname === '/v2/user/me') return respond(200, { profile: { _id: ME, email: 'ana@example.com', firstName: 'Ana' } });
  if (m === 'GET' && u.pathname === '/v2/user/preferences') return respond(200, { locale: { currency: 'COP' }, modules: { sales: { events: { autoCreateAdCampaign: true } } } });
  if (m === 'GET' && col === 'stage') {
    const types = xq(u).stageType.$in;
    return respond(200, { data: state.stages.filter((s) => types.includes(s.stageType)) });
  }
  if (col === 'businessevent') {
    if (m === 'GET' && key === 'search') {
      const t = u.searchParams.get('term').toLowerCase();
      return respond(200, { data: Object.values(state.events).filter((e) => e.eventName.toLowerCase().includes(t)) });
    }
    if (m === 'GET' && key) {
      const ev = state.events[key] || Object.values(state.events).find((e) => e.eventCode === key);
      if (!ev) return respond(404, { statusCode: 404, error: 'Not found' });
      const copy = JSON.parse(JSON.stringify(ev));
      if (u.searchParams.get('populate') === 'stage') copy.stage = state.stages.find((s) => s._id === ev.stage) || ev.stage;
      return respond(200, copy);
    }
    if (m === 'GET') {
      const q = xq(u);
      const list = Object.values(state.events).filter((e) => !q.adCampaign || q.adCampaign.$in.includes(e.adCampaign));
      return respond(200, { data: list });
    }
    if (m === 'POST' && key === 'recomputeMetrics') {
      const ev = state.events[body.eventId];
      recompute(ev);
      return respond(200, ev.metrics);
    }
    if (m === 'POST') {
      const _id = newId();
      const ev = {
        _id, eventCode: `BEV-${seq}`, stage: PLANNED, currency: 'COP', metrics: { totalExpense: 0, contacts: [], deals: [] },
        ...body, adCampaign: newId(), updatedAt: 'T1',
      };
      if (ev.assignee === 'ana@example.com') ev.assignee = ME;
      state.events[_id] = ev;
      return respond(201, ev);
    }
    if (m === 'PATCH') {
      const ev = state.events[key];
      Object.assign(ev, body, { updatedAt: `${ev.updatedAt}+` });
      return respond(200, ev);
    }
  }
  if (col === 'eventexpense') {
    if (m === 'GET' && key) return respond(200, state.expenses[key]);
    if (m === 'GET') {
      const q = xq(u);
      const evId = q.$and[0].businessEvent;
      return respond(200, { data: Object.values(state.expenses).filter((e) => e.businessEvent === evId) });
    }
    if (m === 'POST') {
      const _id = newId();
      const currency = body.currency || 'COP';
      const rate = currency === 'COP' || state.fxFails ? 1 : 4000;
      const exp = { _id, expenseCode: `EXP-${seq}`, currency, ...body, exchangeRate: rate, convertedAmount: body.amount * rate };
      state.expenses[_id] = exp;
      if (!state.lazyTotals) recompute(state.events[body.businessEvent]);
      return respond(201, exp);
    }
  }
  if (col === 'contact') {
    const c = state.contacts[key] || Object.values(state.contacts).find((x) => x.email === decodeURIComponent(key || ''));
    if (m === 'GET' && key && !c) return respond(404, { statusCode: 404, error: 'Not found' });
    if (m === 'GET' && key) return respond(200, c);
    if (m === 'GET') {
      const ids = xq(u)._id.$in;
      return respond(200, { data: ids.map((i) => state.contacts[i]).filter(Boolean) });
    }
    if (m === 'PATCH') {
      Object.assign(c, body, { updatedAt: `${c.updatedAt}+` });
      Object.values(state.events).filter((e) => e.adCampaign === c.adCampaign).forEach(recompute);
      return respond(200, c);
    }
  }
  if (col === 'deal' && m === 'GET') {
    const q = xq(u);
    if (q.contact) return respond(200, { data: state.deals.filter((d) => q.contact.$in.includes(d.contact)) });
    return respond(200, { data: state.deals.filter((d) => q._id.$in.includes(d._id) && !d.hidden) });
  }
  if (col === 'eventprospect') {
    const p = state.prospect;
    if (m === 'GET') return respond(200, p);
    if (m === 'PATCH') {
      Object.assign(p, body, { updatedAt: `${p.updatedAt}+` });
      if (body.stage === PROMOTED && !p.businessEvent) {
        const _id = newId();
        state.events[_id] = { _id, eventCode: `BEV-${seq}`, eventName: p.eventName, stage: PLANNED, adCampaign: newId(), metrics: { totalExpense: 0, contacts: [], deals: [] }, updatedAt: 'T1' };
        p.businessEvent = _id;
      }
      return respond(200, p);
    }
  }
  return respond(404, { statusCode: 404, error: `unexpected ${m} ${u.pathname}` });
}

const run = (argv) => events.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const plan = (p) => JSON.stringify(p);
const writes = () => calls.filter((c) => c.method !== 'GET');
const json = () => JSON.parse(out);

async function previewThenApply(p) {
  expect(await run(['preview', D, plan(p)])).toBe(0);
  const { version } = json();
  out = '';
  const code = await run(['apply', D, plan(p), '--version', version, '--confirmed']);
  return code;
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-events-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  seq = 0;
  state = {
    stages: [
      { _id: PLANNED, stageType: 'BusinessEvent.stage', stageCode: 'businessEvent-stage-planned', stageName: 'Planned' },
      { _id: PROMOTED, stageType: 'EventProspect.stage', stageCode: 'eventProspect-stage-promoted', stageName: 'Promoted', endFlowStage: true },
      { _id: WON, stageType: 'Deal.stage', stageCode: 'deal-stage-approved', stageName: 'Approved', endFlowStage: true },
      { _id: LOST, stageType: 'Deal.stage', stageCode: 'deal-stage-denied', stageName: 'Denied', endFlowStage: true },
      { _id: OPEN, stageType: 'Deal.stage', stageCode: 'deal-stage-negotiation', stageName: 'Negotiation' },
      { _id: CUSTOM_CLOSED, stageType: 'Deal.stage', stageCode: 'STG-1', stageName: 'Signed', endFlowStage: true },
    ],
    events: {
      [EVENT]: {
        _id: EVENT, eventCode: 'BEV-1', eventName: 'Feria Hotelera 2027', stage: PLANNED, currency: 'COP', budget: 10000000,
        dates: { startAt: '2027-03-15T14:00:00.000Z' }, adCampaign: CAMPAIGN, attendees: [ME], updatedAt: 'T1',
        metrics: { totalExpense: 0, contacts: [], deals: [], metricsCurrency: 'COP' },
      },
      [OTHER_EVENT]: {
        _id: OTHER_EVENT, eventCode: 'BEV-2', eventName: 'Expo Otra', stage: PLANNED, adCampaign: OTHER_CAMPAIGN, updatedAt: 'T1',
        metrics: { totalExpense: 0, contacts: [], deals: [] },
      },
    },
    expenses: {},
    contacts: {
      [CONTACT1]: { _id: CONTACT1, firstName: 'Lucía', lastName: 'Gómez', email: 'lucia@example.com', updatedAt: 'T1' },
      [CONTACT2]: { _id: CONTACT2, firstName: 'Pedro', lastName: 'Ruiz', email: 'pedro@example.com', adCampaign: OTHER_CAMPAIGN, updatedAt: 'T1' },
    },
    deals: [],
    prospect: { _id: PROSPECT, prospectCode: 'EVP-1', eventName: 'Expo Futuro', updatedAt: 'T1' },
  };
});

describe('reads', () => {
  test('show flags stale totals, failed currency conversion and a budget in another currency', async () => {
    const ev = state.events[EVENT];
    ev.currency = 'USD';
    state.expenses.x = { _id: id('x'), businessEvent: EVENT, expenseCode: 'EXP-9', concept: 'Stand', amount: 100, currency: 'USD', exchangeRate: 1, convertedAmount: 100 };
    expect(await run(['show', D, 'BEV-1'])).toBe(0);
    const r = json();
    expect(r.warnings.join(' ')).toMatch(/differs from the sum/);
    expect(r.warnings.join(' ')).toMatch(/counted 1:1/);
    expect(r.warnings.join(' ')).toMatch(/budget is in USD/);
    expect(r.captureLink).toBe(`https://${D}/event?event=${EVENT}`);
    expect(r.captureLink).not.toMatch(/apiKey/);
    const expCall = calls.find((c) => c.path === '/v2/eventexpense');
    expect(expCall.query.sort).toBe('_id');
    expect(writes()).toEqual([]);
  });

  test('results buckets deals like the server and warns about other closing stages and hidden deals', async () => {
    state.deals = [
      { _id: id('m'), dealName: 'A', stage: WON, proposal: { quote: { convertedTotal: 3000 } } },
      { _id: id('n'), dealName: 'B', stage: LOST, proposal: { quote: { convertedTotal: 500 } } },
      { _id: id('o'), dealName: 'C', stage: CUSTOM_CLOSED, proposal: { quote: { convertedTotal: 700 } } },
      { _id: id('p'), dealName: 'D', stage: OPEN, hidden: true },
    ];
    state.events[EVENT].metrics.deals = state.deals.map((d) => d._id);
    expect(await run(['results', D, EVENT])).toBe(0);
    const r = json();
    expect(r.deals.map((d) => d.bucket)).toEqual(['won', 'lost', 'open']);
    expect(r.warnings.join(' ')).toMatch(/Signed.*count as OPEN/);
    expect(r.warnings.join(' ')).toMatch(/1 attributed deal\(s\) are not visible/);
  });
});

describe('createEvent', () => {
  const p = { kind: 'createEvent', event: { eventName: 'Congreso Nuevo', dates: { startAt: '2027-05-10T09:00:00-05:00' }, budget: 5000000 }, assignee: 'me' };

  test('preview writes nothing and stops the agent; apply creates, reads back and needs version + confirmed', async () => {
    expect(await run(['preview', D, plan(p)])).toBe(0);
    const pre = json();
    expect(pre.nextStep).toMatch(/STOP HERE/);
    expect(pre.body.assignee).toBe(ME);
    expect(writes()).toEqual([]);
    out = '';
    expect(await run(['apply', D, plan(p), '--version', pre.version])).toBe(2);
    expect(await run(['apply', D, plan(p), '--confirmed'])).toBe(2);
    expect(writes()).toEqual([]);
    expect(await run(['apply', D, plan(p), '--version', pre.version, '--confirmed'])).toBe(0);
    const r = json();
    expect(r.saved).toBe(true);
    expect(r.event.hasCampaign).toBe(true);
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v2/businessevent']);
  });

  test('a same-name event on the same day blocks (also a second apply)', async () => {
    const dup = { kind: 'createEvent', event: { eventName: 'feria hotelera 2027', dates: { startAt: '2027-03-15T09:00:00-05:00' } } };
    expect(await run(['preview', D, plan(dup)])).toBe(3);
    expect(json().blockers[0]).toMatch(/already exists/);
    expect(await run(['apply', D, plan(dup), '--version', 'x', '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
  });

  test('server-owned and unknown fields are refused before any call', async () => {
    for (const event of [{ eventName: 'X', metrics: { roi: 1 } }, { eventName: 'X', adCampaign: CAMPAIGN }, { eventName: 'X', format: 'Online' },
      { eventName: 'X', dates: { startAt: '2027-03-16', endAt: '2027-03-15' } }, { eventName: 'X', dates: { startAt: '2027-03-16T09:00' } }]) {
      expect(await run(['preview', D, plan({ kind: 'createEvent', event })])).toBe(2);
    }
    expect(await run(['preview', D, plan({ ...p, assignee: ME })])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('addExpense', () => {
  const p = { kind: 'addExpense', eventId: 'BEV-1', concept: 'Transporte', amount: 2000000, currency: 'COP' };

  test('registers the expense and reports the recalculated total', async () => {
    expect(await previewThenApply(p)).toBe(0);
    const r = json();
    expect(r.saved).toBe(true);
    expect(r.totalExpenseBefore).toBe(0);
    expect(r.totalExpenseAfter).toBe(2000000);
    expect(writes()[0].body).toEqual({ businessEvent: EVENT, concept: 'Transporte', amount: 2000000, currency: 'COP' });
  }, 10000);

  test('a twin expense blocks unless allowDuplicate', async () => {
    state.expenses.x = { _id: id('x'), businessEvent: EVENT, expenseCode: 'EXP-9', concept: 'transporte', amount: 2000000, currency: 'COP', exchangeRate: 1, convertedAmount: 2000000 };
    expect(await run(['preview', D, plan(p)])).toBe(3);
    expect(json().blockers[0]).toMatch(/already has an expense/);
    out = '';
    expect(await run(['preview', D, plan({ ...p, allowDuplicate: true })])).toBe(0);
  });

  test('a failed currency conversion is reported as a problem', async () => {
    state.fxFails = true;
    expect(await previewThenApply({ ...p, amount: 500, currency: 'USD' })).toBe(1);
    expect(json().problems.join(' ')).toMatch(/conversion from USD to COP failed/);
  }, 10000);

  test('totals that lag are said, not hidden', async () => {
    state.lazyTotals = true;
    expect(await previewThenApply(p)).toBe(0);
    expect(json().totalsNote).toMatch(/not been recalculated yet/);
  }, 10000);

  test('a negative or text amount never reaches the server', async () => {
    expect(await run(['preview', D, plan({ ...p, amount: -1 })])).toBe(2);
    expect(await run(['preview', D, plan({ ...p, amount: '2 millones' })])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('attributeContacts', () => {
  test('a contact of another event blocks unless the user agrees to move it; existing deals are named', async () => {
    state.deals = [{ _id: id('q'), dealName: 'Old deal', contact: CONTACT1 }];
    const p = { kind: 'attributeContacts', eventId: EVENT, contacts: ['lucia@example.com', 'pedro@example.com'] };
    expect(await run(['preview', D, plan(p)])).toBe(3);
    const r = json();
    expect(r.blockers[0]).toMatch(/Pedro Ruiz → Expo Otra \(BEV-2\)/);
    expect(r.warnings.join(' ')).toMatch(/1 existing deal\(s\).*Old deal/);
    out = '';
    expect(await previewThenApply({ ...p, moveFromOtherCampaigns: true })).toBe(0);
    const a = json();
    expect(a.attributed).toEqual(['lucia@example.com', 'pedro@example.com']);
    expect(a.eventContactsNow).toBe(2);
    expect(a.staleEvents).toEqual(['Expo Otra (BEV-2)']);
    expect(writes().every((c) => c.method === 'PATCH' && c.body.adCampaign === CAMPAIGN && Object.keys(c.body).length === 1)).toBe(true);
  }, 10000);

  test('an unknown contact blocks', async () => {
    expect(await run(['preview', D, plan({ kind: 'attributeContacts', eventId: EVENT, contacts: ['nobody@example.com'] })])).toBe(3);
    expect(json().blockers[0]).toMatch(/No contact/);
  });

  test('an operator object instead of an e-mail is refused', async () => {
    expect(await run(['preview', D, plan({ kind: 'attributeContacts', eventId: EVENT, contacts: [{ $ne: null }] })])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('updateEvent', () => {
  test('addAttendees keeps the current attendees (PATCH replaces arrays whole)', async () => {
    expect(await previewThenApply({ kind: 'updateEvent', eventId: EVENT, addAttendees: ['luis@example.com'] })).toBe(0);
    expect(writes()[0].body.attendees).toEqual([ME, 'luis@example.com']);
  });

  test('a change made after the preview blocks the apply', async () => {
    const p = { kind: 'updateEvent', eventId: EVENT, set: { venue: 'Corferias' } };
    expect(await run(['preview', D, plan(p)])).toBe(0);
    const { version } = json();
    state.events[EVENT].updatedAt = 'T2';
    expect(await run(['apply', D, plan(p), '--version', version, '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('promoteProspect', () => {
  test('promotes by moving the card to Promoted, like the app, and returns the new event', async () => {
    expect(await previewThenApply({ kind: 'promoteProspect', prospectId: PROSPECT })).toBe(0);
    const r = json();
    expect(r.saved).toBe(true);
    expect(r.event.eventName).toBe('Expo Futuro');
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH /v2/eventprospect/${PROSPECT}`]);
    expect(writes()[0].body).toEqual({ stage: PROMOTED });
  }, 10000);

  test('an already promoted prospect is blocked', async () => {
    state.prospect.businessEvent = EVENT;
    expect(await run(['preview', D, plan({ kind: 'promoteProspect', prospectId: PROSPECT })])).toBe(3);
    expect(writes()).toEqual([]);
  });
});

test('the API key never reaches the output', async () => {
  state.events[EVENT].eventName = 'SECRET123';
  await run(['show', D, EVENT]);
  expect(out + err).not.toMatch(/SECRET123/);
  expect(out).toMatch(/\*\*\*/);
});
