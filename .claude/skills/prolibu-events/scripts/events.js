#!/usr/bin/env node
'use strict';

// Business events (Event Manager), the way the Prolibu app handles them: events, their
// expenses, the contacts and deals attributed to them through the event's campaign, and
// candidate events ("event prospects") promoted into real events.
//
//   events.js find      <domain> [text]                 events by name, newest first
//   events.js show      <domain> <event id | code>      event, budget, totals, expenses, checks
//   events.js results   <domain> <event id | code>      attributed contacts and deals (won / lost / open)
//   events.js prospects <domain> [text]                 candidate events (EventProspect)
//   events.js stages    <domain>                        event and candidate-event stages
//   events.js preview   <domain> '<plan>'               writes nothing; returns a version
//   events.js apply     <domain> '<plan>' --version <v> --confirmed
//
// Plan kinds: createEvent | updateEvent | addExpense | attributeContacts | promoteProspect |
// recomputeMetrics (see SKILL.md). Plans are inline JSON or a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,80}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const BLOCKED = 3;
const FORMATS = ['In-Person', 'Virtual', 'Hybrid'];
const PAYMENT_METHODS = ['Bank Transfer', 'Credit Card', 'Cash', 'Check', 'Other'];
const MAX_CONTACTS = 50;
const MAX_EXPENSES = 2000;
const MAX_RESULTS = 1000;
const WON_CODE = 'deal-stage-approved';
const LOST_CODE = 'deal-stage-denied';
const PROMOTED_CODE = 'eventProspect-stage-promoted';
const EVENT_SELECT = 'eventName eventCode description format eventType dates venue address website currency budget '
  + 'adCampaign stage assignee attendees collaborators metrics workspace createdBy updatedAt';
const EVENT_FIELDS = ['eventName', 'description', 'format', 'eventType', 'dates', 'venue', 'address', 'website', 'currency', 'budget'];
const ADDRESS_KEYS = ['street', 'city', 'state', 'country', 'postalCode', 'neighborhood'];
const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const fullName = (r) => (r && typeof r === 'object' ? [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null : null);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayOf = (d) => (d ? String(new Date(d).toISOString()).slice(0, 10) : null);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    if (res.status === 403) {
      err.message += ' — the key\'s user lacks permission for this (the Event Manager needs the "Event Business Assistant" or "Event Business Manager" profile). Say so and stop; do not retry another way.';
    }
    throw err;
  }
  return res.body;
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    text = fs.readFileSync(text, 'utf8');
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  if (!PLANNERS[plan.kind]) throw new UsageError(`Unknown plan kind "${plan.kind}". Use one of: ${Object.keys(PLANNERS).join(', ')}.`);
  return plan;
}

function checkDate(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new UsageError(`${field} must be a date like 2027-03-15 or 2027-03-15T09:00:00-05:00.`);
  }
  if (value.length > 10 && !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new UsageError(`${field} needs its time-zone offset.`);
  return value;
}

// Validates the event fields a plan sets and returns the body to send.
function eventBody(fields, { creating }) {
  const body = {};
  const unknown = Object.keys(fields).filter((k) => !EVENT_FIELDS.includes(k));
  if (unknown.length) {
    throw new UsageError(`Fields not allowed here: ${unknown.join(', ')}. Allowed: ${EVENT_FIELDS.join(', ')} (plus assignee, attendees, stage).`);
  }
  if (creating || fields.eventName !== undefined) {
    if (typeof fields.eventName !== 'string' || !fields.eventName.trim() || fields.eventName.length > 200) {
      throw new UsageError('eventName is required (text, up to 200 characters).');
    }
    body.eventName = fields.eventName.trim();
  }
  for (const k of ['description', 'eventType', 'venue', 'website']) {
    if (fields[k] === undefined) continue;
    if (typeof fields[k] !== 'string' || fields[k].length > 5000) throw new UsageError(`${k} must be text.`);
    body[k] = fields[k];
  }
  if (fields.website !== undefined && fields.website && !/^https?:\/\//i.test(fields.website)) {
    throw new UsageError('website must start with http:// or https://.');
  }
  if (fields.format !== undefined) {
    if (!FORMATS.includes(fields.format)) throw new UsageError(`format must be one of ${FORMATS.join(', ')}.`);
    body.format = fields.format;
  }
  if (fields.currency !== undefined) {
    if (typeof fields.currency !== 'string' || !CURRENCY_RE.test(fields.currency)) throw new UsageError('currency must be a 3-letter ISO code (COP, USD…).');
    body.currency = fields.currency;
  }
  if (fields.budget !== undefined) {
    if (typeof fields.budget !== 'number' || !Number.isFinite(fields.budget) || fields.budget < 0) throw new UsageError('budget must be a number ≥ 0.');
    body.budget = fields.budget;
  }
  if (fields.dates !== undefined) {
    if (!fields.dates || typeof fields.dates !== 'object') throw new UsageError('dates must be {"startAt": …, "endAt": …}.');
    const extra = Object.keys(fields.dates).filter((k) => !['startAt', 'endAt'].includes(k));
    if (extra.length) throw new UsageError('dates only takes startAt and endAt.');
    const startAt = checkDate(fields.dates.startAt, 'dates.startAt');
    const endAt = checkDate(fields.dates.endAt, 'dates.endAt');
    if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) throw new UsageError('dates.endAt is before dates.startAt.');
    body.dates = { ...(startAt ? { startAt } : {}), ...(endAt ? { endAt } : {}) };
  }
  if (fields.address !== undefined) {
    if (!fields.address || typeof fields.address !== 'object') throw new UsageError('address must be an object.');
    const extra = Object.keys(fields.address).filter((k) => !ADDRESS_KEYS.includes(k));
    if (extra.length) throw new UsageError(`address only takes ${ADDRESS_KEYS.join(', ')}.`);
    for (const [k, v] of Object.entries(fields.address)) {
      if (typeof v !== 'string') throw new UsageError(`address.${k} must be text.`);
    }
    if (fields.address.country && !/^[A-Z]{2}$/.test(fields.address.country)) throw new UsageError('address.country must be ISO-2 (CO, US…).');
    body.address = { ...fields.address };
  }
  return body;
}

function userRef(value, me, field) {
  if (value === 'me') return me;
  if (typeof value === 'string' && EMAIL_RE.test(value)) return value.toLowerCase();
  throw new UsageError(`${field} takes "me" or a user's sign-in e-mail (never a raw id).`);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || {};
  return { _id: p._id, email: p.email, name: fullName(p), isAdmin: !!p.isAdmin };
}

async function accountCurrency(client) {
  const prefs = await call(client, 'GET', '/v2/user/preferences');
  return {
    // The server converts and sums in the ACCOUNT currency (globalLocale). `locale` is the
    // caller's own override and may differ (a user set to MXN on a COP account).
    currency: (prefs.globalLocale && prefs.globalLocale.currency)
      || (prefs.locale && prefs.locale.currency) || null,
    autoCreateAdCampaign: !(prefs.modules && prefs.modules.sales && prefs.modules.sales.events
      && prefs.modules.sales.events.autoCreateAdCampaign === false),
  };
}

async function loadEvent(client, ref) {
  const key = String(ref || '').trim();
  if (!ID_RE.test(key) && !CODE_RE.test(key)) throw new UsageError('Give the event _id or its code (BEV-…). Use find to look it up.');
  return call(client, 'GET', `/v2/businessevent/${encodeURIComponent(key)}?${qs({ select: EVENT_SELECT, populate: 'stage' })}`);
}

async function stagesOf(client, types) {
  // heavy-read-ok: stages are a short configuration list, read once.
  const body = await call(client, 'GET', `/v2/stage?${qs({
    xquery: { stageType: { $in: types }, active: true },
    select: 'stageName stageCode stageType index endFlowStage',
    sort: '_id',
    limit: 200, // heavy-read-ok: stages are a short configuration list
  })}`);
  return rowsOf(body);
}

function pickStage(stages, type, wanted) {
  const w = norm(wanted);
  const found = stages.filter((s) => s.stageType === type
    && (String(s._id) === String(wanted) || norm(s.stageCode) === w || norm(s.stageName) === w));
  if (found.length !== 1) {
    const names = stages.filter((s) => s.stageType === type).map((s) => s.stageName).join(', ');
    throw new Blocked(`Stage "${wanted}" not found for ${type}. Choices: ${names}.`);
  }
  return found[0];
}

async function sameNameEvents(client, name) {
  const body = await call(client, 'GET', `/v2/businessevent/search?${qs({ term: name, limit: 20, select: 'eventName eventCode dates stage' })}`);
  return rowsOf(body).filter((e) => norm(e.eventName) === norm(name));
}

// Expenses of one event, cursor on _id (HEAVY-READS), capped.
async function expensesOf(client, eventId) {
  const rows = [];
  let last = null;
  for (;;) {
    const cond = [{ businessEvent: eventId }];
    if (last) cond.push({ _id: { $gt: last } });
    // heavy-read-ok: cursor on _id over one event's expenses, one page at a time, capped.
    const body = await call(client, 'GET', `/v2/eventexpense?${qs({
      xquery: { $and: cond },
      select: 'expenseCode concept amount currency exchangeRate convertedAmount expenseDate paymentMethod',
      sort: '_id',
      limit: 500, // heavy-read-ok: cursor on _id over one event's expenses
    })}`);
    const page = rowsOf(body);
    rows.push(...page);
    if (page.length < 500 || rows.length >= MAX_EXPENSES) break;
    last = page[page.length - 1]._id;
  }
  return rows.slice(0, MAX_EXPENSES);
}

// Records by _id, 100 per call (index on _id), one call at a time.
async function byIds(client, object, ids, select) {
  const out = [];
  for (const part of chunk(ids.slice(0, MAX_RESULTS), 100)) {
    const body = await call(client, 'GET', `/v2/${object}?${qs({ xquery: { _id: { $in: part } }, select, limit: 100, sort: '_id' })}`);
    out.push(...rowsOf(body));
  }
  return out;
}

function summarizeEvent(ev) {
  const m = ev.metrics || {};
  const stage = ev.stage && typeof ev.stage === 'object' ? ev.stage.stageName : ev.stage || null;
  return {
    _id: ev._id,
    eventCode: ev.eventCode,
    eventName: ev.eventName,
    stage,
    dates: ev.dates || null,
    venue: ev.venue || null,
    city: (ev.address && ev.address.city) || null,
    format: ev.format || null,
    currency: ev.currency || null,
    budget: ev.budget === undefined ? null : ev.budget,
    hasCampaign: !!ev.adCampaign,
    totals: {
      currency: m.metricsCurrency || null,
      totalExpense: m.totalExpense || 0,
      contacts: (m.contacts || []).length,
      deals: (m.deals || []).length,
      wonDeals: m.wonDealsCount || 0,
      wonValue: m.wonValue || 0,
      openValue: m.openValue || 0,
      lostValue: m.lostValue || 0,
      netResult: m.netResult || 0,
      roiPercent: m.roi === undefined ? null : m.roi,
      costPerContact: m.costPerContact === undefined ? null : m.costPerContact,
      costPerDeal: m.costPerDeal === undefined ? null : m.costPerDeal,
      computedAt: m.computedAt || null,
    },
  };
}

// Checks the server does not make: stale totals, failed currency conversion, budget in another currency.
function eventChecks(ev, expenses, acct) {
  const warnings = [];
  const m = ev.metrics || {};
  const metricsCurrency = m.metricsCurrency || acct.currency;
  if (!ev.adCampaign) {
    warnings.push('The event has no attribution campaign: no contact or deal can count for it. The account may have "auto-create campaign" turned off; ask an admin.');
  }
  if (expenses) {
    const sum = round2(expenses.reduce((s, e) => s + (Number(e.convertedAmount) || 0), 0));
    if (Math.abs(sum - round2(m.totalExpense)) > 0.01) {
      warnings.push(`The stored total expense (${round2(m.totalExpense)}) differs from the sum of its expenses (${sum}): totals are recalculated in the background after each change and may lag; read again in a few seconds, or ask a manager to recalculate (recomputeMetrics).`);
    }
    const fx = expenses.filter((e) => e.currency && metricsCurrency && e.currency !== metricsCurrency && Number(e.exchangeRate) === 1);
    if (fx.length) {
      warnings.push(`${fx.length} expense(s) in another currency were counted 1:1 (${fx.map((e) => `${e.expenseCode || e.concept}: ${e.amount} ${e.currency}`).join('; ')}): the currency conversion failed when they were saved. Their converted amount is wrong.`);
    }
  }
  if (ev.budget && ev.currency && metricsCurrency && ev.currency !== metricsCurrency) {
    warnings.push(`The budget is in ${ev.currency} but totals are in ${metricsCurrency}; the app compares them as plain numbers.`);
  }
  return warnings;
}

// ─── Read commands ────────────────────────────────────────────────────────────

async function cmdFind(client, rest) {
  const term = rest.join(' ').trim();
  const select = 'eventName eventCode dates stage venue metrics.totalExpense metrics.metricsCurrency';
  const body = term
    ? await call(client, 'GET', `/v2/businessevent/search?${qs({ term, limit: 20, select })}`)
    : await call(client, 'GET', `/v2/businessevent?${qs({ sort: '-_id', limit: 20, select })}`);
  const names = new Map((await stagesOf(client, ['BusinessEvent.stage'])).map((s) => [String(s._id), s.stageName]));
  const events = rowsOf(body).map((e) => ({
    _id: e._id,
    eventCode: e.eventCode,
    eventName: e.eventName,
    stage: names.get(idOf(e.stage)) || idOf(e.stage) || null,
    startAt: e.dates && e.dates.startAt ? e.dates.startAt : null,
    venue: e.venue || null,
  }));
  return { events, count: events.length };
}

async function cmdShow(client, [ref]) {
  const ev = await loadEvent(client, ref);
  const acct = await accountCurrency(client);
  const expenses = await expensesOf(client, ev._id);
  const summary = summarizeEvent(ev);
  const budgetUsedPercent = ev.budget ? round2((summary.totals.totalExpense / ev.budget) * 100) : null;
  return {
    event: summary,
    budgetUsedPercent,
    expenses: expenses.map((e) => ({
      expenseCode: e.expenseCode, concept: e.concept, amount: e.amount, currency: e.currency,
      convertedAmount: e.convertedAmount, expenseDate: e.expenseDate, paymentMethod: e.paymentMethod || null,
    })),
    expensesCapped: expenses.length >= MAX_EXPENSES,
    captureLink: `https://${client.domain}/event?event=${ev._id}`,
    captureLinkNote: 'Staff page to log contacts and expenses at the event from a phone. It asks for sign-in; never add an apiKey to the link.',
    warnings: eventChecks(ev, expenses, acct),
    version: ev.updatedAt,
  };
}

async function cmdResults(client, [ref]) {
  const ev = await loadEvent(client, ref);
  const m = ev.metrics || {};
  const dealIds = (m.deals || []).map(String);
  const contactIds = (m.contacts || []).map(String);
  const stages = await stagesOf(client, ['Deal.stage']);
  const byId = new Map(stages.map((s) => [String(s._id), s]));
  const won = stages.find((s) => s.stageCode === WON_CODE);
  const lost = stages.find((s) => s.stageCode === LOST_CODE);
  const deals = await byIds(client, 'deal', dealIds,
    'dealName dealCode stage assignee contact proposal.quote.convertedTotal proposal.quote.total proposal.quote.currency');
  const otherClosing = new Set();
  const rows = deals.map((d) => {
    const sid = idOf(d.stage);
    const s = byId.get(sid);
    let bucket = 'open';
    if (won && sid === String(won._id)) bucket = 'won';
    else if (lost && sid === String(lost._id)) bucket = 'lost';
    else if (s && s.endFlowStage) otherClosing.add(s.stageName);
    const q = (d.proposal && d.proposal.quote) || {};
    return {
      _id: d._id, dealCode: d.dealCode, dealName: d.dealName, stage: s ? s.stageName : sid || null, bucket,
      value: q.convertedTotal === undefined ? null : q.convertedTotal, quoteTotal: q.total === undefined ? null : q.total, quoteCurrency: q.currency || null,
    };
  });
  const contacts = await byIds(client, 'contact', contactIds, 'firstName lastName email companyName');
  const warnings = [];
  if (deals.length < Math.min(dealIds.length, MAX_RESULTS)) warnings.push(`${Math.min(dealIds.length, MAX_RESULTS) - deals.length} attributed deal(s) are not visible to this user.`);
  if (contacts.length < Math.min(contactIds.length, MAX_RESULTS)) warnings.push(`${Math.min(contactIds.length, MAX_RESULTS) - contacts.length} attributed contact(s) are not visible to this user.`);
  if (otherClosing.size) warnings.push(`Deals in the closing stage(s) ${[...otherClosing].join(', ')} count as OPEN in the event's totals: only the standard won and lost stages count as won or lost.`);
  if (!ev.adCampaign) warnings.push('The event has no attribution campaign, so nothing can be attributed to it.');
  return {
    event: { _id: ev._id, eventCode: ev.eventCode, eventName: ev.eventName },
    totals: summarizeEvent(ev).totals,
    deals: rows,
    contacts: contacts.map((c) => ({ _id: c._id, name: fullName(c), email: c.email || null, company: c.companyName || null })),
    capped: dealIds.length > MAX_RESULTS || contactIds.length > MAX_RESULTS,
    note: 'Attributed = the contact or deal carries the event\'s campaign. These are the contacts and deals as of the last recalculation (computedAt); they are not a list of who physically attended.',
    warnings,
  };
}

async function cmdProspects(client, rest) {
  const term = rest.join(' ').trim();
  const select = 'eventName prospectCode dates venue stage score businessEvent promotedAt source';
  const body = term
    ? await call(client, 'GET', `/v2/eventprospect/search?${qs({ term, limit: 20, select })}`)
    : await call(client, 'GET', `/v2/eventprospect?${qs({ sort: '-_id', limit: 20, select })}`);
  const names = new Map((await stagesOf(client, ['EventProspect.stage'])).map((s) => [String(s._id), s.stageName]));
  return {
    prospects: rowsOf(body).map((p) => ({
      _id: p._id, prospectCode: p.prospectCode, eventName: p.eventName,
      stage: names.get(idOf(p.stage)) || idOf(p.stage) || 'No stage',
      startAt: p.dates && p.dates.startAt ? p.dates.startAt : null, venue: p.venue || null, score: p.score === undefined ? null : p.score,
      promotedTo: p.businessEvent ? idOf(p.businessEvent) : null, source: p.source || null,
    })),
    note: 'An event prospect is a CANDIDATE EVENT the company may attend (often loaded by a crawler), not a person.',
  };
}

async function cmdStages(client) {
  const stages = await stagesOf(client, ['BusinessEvent.stage', 'EventProspect.stage']);
  const pick = (type) => stages.filter((s) => s.stageType === type)
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((s) => ({ _id: s._id, stageName: s.stageName, stageCode: s.stageCode, closing: !!s.endFlowStage }));
  return { eventStages: pick('BusinessEvent.stage'), prospectStages: pick('EventProspect.stage') };
}

// ─── Planners: each returns { summary, warnings, blockers, version, write } ────

const PLANNERS = {
  async createEvent(client, plan) {
    const body = eventBody(plan.event || {}, { creating: true });
    const extra = Object.keys(plan).filter((k) => !['kind', 'event', 'assignee', 'attendees', 'stage', 'allowDuplicate'].includes(k));
    if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
    if (plan.attendees !== undefined && (!Array.isArray(plan.attendees) || plan.attendees.length > 50)) {
      throw new UsageError('attendees is a list of up to 50 user e-mails or "me".');
    }
    [plan.assignee, ...(plan.attendees || [])].filter((v) => v !== undefined).forEach((v) => userRef(v, null, 'assignee/attendees'));
    const who = await me(client);
    const acct = await accountCurrency(client);
    if (plan.assignee !== undefined) body.assignee = userRef(plan.assignee, who._id, 'assignee');
    if (plan.attendees !== undefined) body.attendees = [...new Set(plan.attendees.map((a) => userRef(a, who._id, 'attendees')))];
    const warnings = [];
    const blockers = [];
    if (plan.stage !== undefined) {
      const st = pickStage(await stagesOf(client, ['BusinessEvent.stage']), 'BusinessEvent.stage', plan.stage);
      body.stage = st._id;
    }
    const dupes = await sameNameEvents(client, body.eventName);
    const start = body.dates && body.dates.startAt ? dayOf(body.dates.startAt) : null;
    const sameDay = dupes.filter((e) => !start || !e.dates || !e.dates.startAt || dayOf(e.dates.startAt) === start);
    if (sameDay.length && !plan.allowDuplicate) {
      blockers.push(`An event with this name already exists: ${sameDay.map((e) => `${e.eventCode} (${e.dates && e.dates.startAt ? dayOf(e.dates.startAt) : 'no date'})`).join(', ')}. Use it, or set "allowDuplicate": true after the user confirms it is a different event.`);
    } else if (dupes.length) {
      warnings.push(`Other events share this name: ${dupes.map((e) => e.eventCode).join(', ')}.`);
    }
    if (!body.dates || !body.dates.startAt) warnings.push('No start date: the event will not show a date on boards and the calendar of the module.');
    if (body.currency && acct.currency && body.currency !== acct.currency) {
      warnings.push(`Totals (expenses, won value, ROI) are always in the account currency ${acct.currency}; the budget in ${body.currency} is compared as a plain number.`);
    }
    if (!acct.autoCreateAdCampaign) warnings.push('This account does not auto-create the event campaign: contacts and deals cannot be attributed to the new event until one is set in the app.');
    if (body.attendees && body.attendees.length) warnings.push('Attendees are your team members going to the event; they also get access to the event and its expenses. They are not customers.');
    return {
      summary: { action: 'Create a business event', body, effects: ['A campaign with the event name is created and linked 1:1; contacts and deals that carry it count for the event.', 'Stage Planned unless another is set.', 'Nobody is e-mailed.'] },
      warnings,
      blockers,
      version: hash({ body, dupes: dupes.map((e) => e._id) }),
      async write() {
        const created = await call(client, 'POST', '/v2/businessevent', { data: body, confirmed: true });
        const back = await loadEvent(client, created._id);
        const problems = [];
        if (back.eventName !== body.eventName) problems.push('eventName did not save as sent.');
        if (acct.autoCreateAdCampaign && !back.adCampaign) problems.push('The event has no attribution campaign: contacts and deals cannot count for it. Report it; do not create the event again.');
        if (body.budget !== undefined && back.budget !== body.budget) problems.push('budget did not save as sent.');
        if (body.assignee && !back.assignee) problems.push('The assignee did not save: check the e-mail.');
        return { saved: problems.length === 0, event: summarizeEvent(back), problems, captureLink: `https://${client.domain}/event?event=${back._id}` };
      },
    };
  },

  async updateEvent(client, plan) {
    const extra = Object.keys(plan).filter((k) => !['kind', 'eventId', 'set', 'addAttendees', 'assignee', 'stage'].includes(k));
    if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
    const ev = await loadEvent(client, plan.eventId);
    const body = eventBody(plan.set || {}, { creating: false });
    const who = await me(client);
    const acct = await accountCurrency(client);
    const warnings = [];
    if (plan.assignee !== undefined) body.assignee = userRef(plan.assignee, who._id, 'assignee');
    if (plan.addAttendees !== undefined) {
      if (!Array.isArray(plan.addAttendees) || !plan.addAttendees.length) throw new UsageError('addAttendees is a non-empty list of user e-mails or "me".');
      const current = (ev.attendees || []).map(idOf);
      // PATCH replaces arrays whole: send the current attendees plus the new ones.
      body.attendees = [...new Set([...current, ...plan.addAttendees.map((a) => userRef(a, who._id, 'addAttendees'))])];
      warnings.push('New attendees also get access to the event and its future expenses.');
    }
    if (plan.stage !== undefined) {
      const st = pickStage(await stagesOf(client, ['BusinessEvent.stage']), 'BusinessEvent.stage', plan.stage);
      body.stage = st._id;
    }
    if (body.dates) body.dates = { ...(ev.dates || {}), ...body.dates };
    if (body.dates && body.dates.startAt && body.dates.endAt && Date.parse(body.dates.endAt) < Date.parse(body.dates.startAt)) {
      throw new UsageError('dates.endAt would end before dates.startAt.');
    }
    if (body.address) body.address = { ...(ev.address || {}), ...body.address };
    if (!Object.keys(body).length) throw new UsageError('The plan changes nothing: add "set", "assignee", "addAttendees" or "stage".');
    if (body.currency && acct.currency && body.currency !== acct.currency) warnings.push(`Totals stay in the account currency ${acct.currency}.`);
    const changes = Object.entries(body)
      .filter(([k, v]) => JSON.stringify(k === 'stage' ? idOf(ev.stage) : ev[k]) !== JSON.stringify(v))
      .map(([k, v]) => ({ field: k, before: k === 'stage' ? idOf(ev.stage) : ev[k] === undefined ? null : ev[k], after: v }));
    if (!changes.length) throw new Blocked('Nothing to change: the event already has these values.');
    const send = Object.fromEntries(changes.map((c) => [c.field, c.after]));
    return {
      summary: { action: 'Update the event', event: { eventCode: ev.eventCode, eventName: ev.eventName }, changes },
      warnings,
      blockers: [],
      version: ev.updatedAt,
      async write() {
        const fresh = await loadEvent(client, ev._id);
        if (fresh.updatedAt !== ev.updatedAt) throw new Blocked('The event changed since the preview. Preview again.');
        await call(client, 'PATCH', `/v2/businessevent/${ev._id}`, { data: send, confirmed: true });
        const back = await loadEvent(client, ev._id);
        const problems = changes.filter((c) => {
          const now = c.field === 'stage' ? idOf(back.stage) : back[c.field];
          if (c.field === 'attendees' || c.field === 'assignee') return !now || (Array.isArray(c.after) && now.length < c.after.length);
          if (c.field === 'dates') return ['startAt', 'endAt'].some((k) => c.after[k] && (!now || Date.parse(now[k]) !== Date.parse(c.after[k])));
          return JSON.stringify(now) !== JSON.stringify(c.after);
        }).map((c) => `${c.field} did not save as sent.`);
        return { saved: problems.length === 0, event: summarizeEvent(back), problems };
      },
    };
  },

  async addExpense(client, plan) {
    const extra = Object.keys(plan).filter((k) => !['kind', 'eventId', 'concept', 'amount', 'currency', 'expenseDate', 'paymentMethod', 'allowDuplicate'].includes(k));
    if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
    if (typeof plan.concept !== 'string' || !plan.concept.trim() || plan.concept.length > 300) throw new UsageError('concept is required (text).');
    if (typeof plan.amount !== 'number' || !Number.isFinite(plan.amount) || plan.amount < 0) throw new UsageError('amount must be a number ≥ 0 (2 millones = 2000000).');
    if (plan.currency !== undefined && (typeof plan.currency !== 'string' || !CURRENCY_RE.test(plan.currency))) throw new UsageError('currency must be a 3-letter ISO code.');
    if (plan.paymentMethod !== undefined && !PAYMENT_METHODS.includes(plan.paymentMethod)) throw new UsageError(`paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}.`);
    const expenseDate = checkDate(plan.expenseDate, 'expenseDate');
    const ev = await loadEvent(client, plan.eventId);
    const acct = await accountCurrency(client);
    const expenses = await expensesOf(client, ev._id);
    const body = { businessEvent: ev._id, concept: plan.concept.trim(), amount: plan.amount };
    if (plan.currency) body.currency = plan.currency;
    if (expenseDate) body.expenseDate = expenseDate;
    if (plan.paymentMethod) body.paymentMethod = plan.paymentMethod;
    const warnings = [];
    const blockers = [];
    const twin = expenses.filter((e) => norm(e.concept) === norm(body.concept) && Number(e.amount) === body.amount);
    if (twin.length && !plan.allowDuplicate) {
      blockers.push(`This event already has an expense "${twin[0].concept}" for ${twin[0].amount} ${twin[0].currency || ''} (${twin[0].expenseCode}). Set "allowDuplicate": true only if the user confirms it is a second, different expense.`);
    }
    const cur = body.currency || acct.currency;
    if (cur && acct.currency && cur !== acct.currency) warnings.push(`The amount is converted to ${acct.currency} at today's rate when saved; check the converted amount after saving.`);
    if (!body.currency) warnings.push(`No currency given: the server uses the account currency ${acct.currency || '(unknown)'}.`);
    const stage = ev.stage && typeof ev.stage === 'object' ? ev.stage : null;
    if (stage && stage.stageCode === 'businessEvent-stage-cancelled') warnings.push('The event is Cancelled; the expense still counts in its totals.');
    warnings.push('The expense is visible to everyone who can see the event (its owner, assignee and attendees inherit access). A receipt photo is added in the app or the event capture page.');
    const before = (ev.metrics && ev.metrics.totalExpense) || 0;
    return {
      summary: { action: 'Register an expense', event: { eventCode: ev.eventCode, eventName: ev.eventName }, body, totalExpenseBefore: before, totalsCurrency: acct.currency },
      warnings,
      blockers,
      version: hash({ body, event: ev.updatedAt, n: expenses.length }),
      async write() {
        const created = await call(client, 'POST', '/v2/eventexpense', { data: body, confirmed: true });
        const back = await call(client, 'GET', `/v2/eventexpense/${created._id}?${qs({ select: 'expenseCode concept amount currency exchangeRate convertedAmount businessEvent expenseDate' })}`);
        const problems = [];
        if (idOf(back.businessEvent) !== String(ev._id)) problems.push('The expense is not linked to the event.');
        if (Number(back.amount) !== body.amount) problems.push('amount did not save as sent.');
        if (back.currency && acct.currency && back.currency !== acct.currency && Number(back.exchangeRate) === 1) {
          problems.push(`The conversion from ${back.currency} to ${acct.currency} failed: the expense counts 1:1 (${back.convertedAmount} ${acct.currency}). Tell the user; fix the amount in the app or register it in ${acct.currency}.`);
        }
        // Totals are recalculated in the background after the save: wait for them briefly.
        let after = null;
        for (let i = 0; i < 4; i += 1) {
          await sleep(i ? 1000 : 300);
          const evNow = await loadEvent(client, ev._id);
          after = (evNow.metrics && evNow.metrics.totalExpense) || 0;
          if (round2(after) !== round2(before)) break;
        }
        return {
          saved: problems.length === 0,
          expense: { _id: back._id, expenseCode: back.expenseCode, concept: back.concept, amount: back.amount, currency: back.currency, convertedAmount: back.convertedAmount },
          totalExpenseBefore: before,
          totalExpenseAfter: after,
          totalsNote: round2(after) === round2(before) && body.amount > 0 ? 'The event total has not been recalculated yet; read it again with show in a few seconds.' : undefined,
          problems,
        };
      },
    };
  },

  async attributeContacts(client, plan) {
    const extra = Object.keys(plan).filter((k) => !['kind', 'eventId', 'contacts', 'moveFromOtherCampaigns'].includes(k));
    if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
    if (!Array.isArray(plan.contacts) || !plan.contacts.length || plan.contacts.length > MAX_CONTACTS) {
      throw new UsageError(`contacts is a list of 1–${MAX_CONTACTS} contact e-mails or ids.`);
    }
    for (const c of plan.contacts) {
      if (typeof c !== 'string' || (!ID_RE.test(c) && !EMAIL_RE.test(c))) throw new UsageError(`"${c}" is not a contact e-mail or id.`);
    }
    const ev = await loadEvent(client, plan.eventId);
    if (!ev.adCampaign) throw new Blocked('The event has no attribution campaign, so contacts cannot be attributed to it. Ask an admin to set one in the app.');
    const campaign = idOf(ev.adCampaign);
    const rows = [];
    const blockers = [];
    const warnings = [];
    for (const ref of [...new Set(plan.contacts)]) {
      const res = await client.request('GET', `/v2/contact/${encodeURIComponent(ref)}?${qs({ select: 'firstName lastName email adCampaign updatedAt' })}`);
      if (res.status === 404) { blockers.push(`No contact "${ref}" on this account. Create it first (or capture it from the event page).`); continue; }
      if (!res.ok) throw new Error(`GET /v2/contact answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
      const c = res.body;
      const cur = idOf(c.adCampaign);
      rows.push({ _id: c._id, name: fullName(c), email: c.email || null, currentCampaign: cur || null, updatedAt: c.updatedAt, action: cur === campaign ? 'unchanged' : cur ? 'move' : 'attribute' });
    }
    const moving = rows.filter((r) => r.action === 'move');
    if (moving.length) {
      const others = [...new Set(moving.map((r) => r.currentCampaign))];
      const owners = rowsOf(await call(client, 'GET', `/v2/businessevent?${qs({ xquery: { adCampaign: { $in: others } }, select: 'eventName eventCode adCampaign', limit: 100, sort: '_id' })}`));
      for (const r of moving) {
        const owner = owners.find((o) => idOf(o.adCampaign) === r.currentCampaign);
        r.currentEvent = owner ? `${owner.eventName} (${owner.eventCode})` : null;
      }
      const msg = `${moving.length} contact(s) already belong to another campaign or event (${moving.map((r) => `${r.name || r.email} → ${r.currentEvent || 'another campaign'}`).join('; ')}). Attribution is first-touch: moving them takes them out of that campaign's numbers.`;
      if (!plan.moveFromOtherCampaigns) blockers.push(`${msg} Set "moveFromOtherCampaigns": true only if the user agrees.`);
      else warnings.push(`${msg} The other event's totals are not recalculated by this change.`);
    }
    const toWrite = rows.filter((r) => r.action !== 'unchanged');
    if (!toWrite.length && !blockers.length) throw new Blocked('Every contact already counts for this event.');
    const ids = rows.map((r) => r._id);
    let deals = [];
    if (ids.length) {
      // heavy-read-ok: one call filtered on the indexed contact field, at most 50 contacts.
      deals = rowsOf(await call(client, 'GET', `/v2/deal?${qs({ xquery: { contact: { $in: ids } }, select: 'dealName dealCode contact adCampaign', limit: 200, sort: '_id' })}`))
        .filter((d) => idOf(d.adCampaign) !== campaign);
    }
    if (deals.length) {
      warnings.push(`${deals.length} existing deal(s) of these contacts stay outside the event (${deals.slice(0, 10).map((d) => d.dealName).join(', ')}${deals.length > 10 ? '…' : ''}). Only deals created from now on inherit the event from their contact.`);
    }
    warnings.push('Changing only the campaign of a contact notifies nobody.');
    return {
      summary: { action: 'Attribute contacts to the event (they count as event contacts)', event: { eventCode: ev.eventCode, eventName: ev.eventName }, contacts: rows.map(({ updatedAt, ...r }) => r) },
      warnings,
      blockers,
      version: hash({ plan, event: ev.updatedAt, contacts: rows.map((r) => [r._id, r.updatedAt]) }),
      async write() {
        const done = [];
        const problems = [];
        for (const r of toWrite) {
          const fresh = await call(client, 'GET', `/v2/contact/${r._id}?${qs({ select: 'adCampaign updatedAt' })}`);
          if (fresh.updatedAt !== r.updatedAt) { problems.push(`${r.name || r.email} changed since the preview; skipped.`); continue; }
          await call(client, 'PATCH', `/v2/contact/${r._id}`, { data: { adCampaign: campaign }, confirmed: true });
          const back = await call(client, 'GET', `/v2/contact/${r._id}?${qs({ select: 'adCampaign' })}`);
          if (idOf(back.adCampaign) !== campaign) problems.push(`${r.name || r.email} did not save the event campaign.`);
          else done.push(r.email || r._id);
        }
        await sleep(800);
        const evNow = await loadEvent(client, ev._id);
        return {
          saved: problems.length === 0, attributed: done, problems,
          eventContactsNow: ((evNow.metrics && evNow.metrics.contacts) || []).length,
          staleEvents: [...new Set(toWrite.filter((r) => r.action === 'move' && r.currentEvent).map((r) => r.currentEvent))],
        };
      },
    };
  },

  async promoteProspect(client, plan) {
    const extra = Object.keys(plan).filter((k) => !['kind', 'prospectId'].includes(k));
    if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
    const ref = String(plan.prospectId || '');
    if (!ID_RE.test(ref) && !CODE_RE.test(ref)) throw new UsageError('prospectId must be the prospect _id or its code (EVP-…).');
    const p = await call(client, 'GET', `/v2/eventprospect/${encodeURIComponent(ref)}?${qs({ select: 'eventName prospectCode dates venue stage businessEvent tags attendees updatedAt' })}`);
    if (p.businessEvent) throw new Blocked(`Already promoted: it became the event ${idOf(p.businessEvent)}. Use that event.`);
    const promoted = pickStage(await stagesOf(client, ['EventProspect.stage']), 'EventProspect.stage', PROMOTED_CODE);
    const warnings = [];
    const dupes = await sameNameEvents(client, p.eventName);
    if (dupes.length) warnings.push(`An event with this name already exists (${dupes.map((e) => e.eventCode).join(', ')}); promoting creates another one.`);
    warnings.push('Promoting creates a business event with its campaign (name, description, format, dates, venue, address, website, type, tags and attendees are copied; the budget is not).');
    return {
      summary: { action: 'Promote the candidate event into a business event', prospect: { prospectCode: p.prospectCode, eventName: p.eventName, startAt: p.dates && p.dates.startAt } },
      warnings,
      blockers: [],
      version: p.updatedAt,
      async write() {
        const fresh = await call(client, 'GET', `/v2/eventprospect/${p._id}?${qs({ select: 'businessEvent updatedAt' })}`);
        if (fresh.updatedAt !== p.updatedAt || fresh.businessEvent) throw new Blocked('The prospect changed since the preview. Preview again.');
        // The app promotes by moving the card to Promoted; the server then creates the event.
        await call(client, 'PATCH', `/v2/eventprospect/${p._id}`, { data: { stage: promoted._id }, confirmed: true });
        let back = null;
        for (let i = 0; i < 4; i += 1) {
          await sleep(i ? 1000 : 300);
          back = await call(client, 'GET', `/v2/eventprospect/${p._id}?${qs({ select: 'businessEvent stage promotedAt' })}`);
          if (back.businessEvent) break;
        }
        if (!back.businessEvent) {
          return { saved: false, problems: ['The prospect moved to Promoted but no event was created. Report it; do not promote again by hand.'] };
        }
        const ev = await loadEvent(client, idOf(back.businessEvent));
        return { saved: true, event: summarizeEvent(ev), problems: ev.adCampaign ? [] : ['The new event has no attribution campaign.'] };
      },
    };
  },

  async recomputeMetrics(client, plan) {
    const extra = Object.keys(plan).filter((k) => !['kind', 'eventId'].includes(k));
    if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
    const ev = await loadEvent(client, plan.eventId);
    return {
      summary: { action: 'Recalculate the event totals', event: { eventCode: ev.eventCode, eventName: ev.eventName }, totalsNow: summarizeEvent(ev).totals },
      warnings: ['Only users with the Event Business Manager profile (or an admin) may run this.'],
      blockers: [],
      version: ev.updatedAt,
      async write() {
        const metrics = await call(client, 'POST', '/v2/businessevent/recomputeMetrics', { data: { eventId: ev._id }, confirmed: true });
        const back = await loadEvent(client, ev._id);
        return { saved: true, totals: summarizeEvent(back).totals, returned: metrics ? { totalExpense: metrics.totalExpense, roi: metrics.roi } : null, problems: [] };
      },
    };
  },
};

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const built = await PLANNERS[plan.kind](client, plan);
  return {
    kind: plan.kind,
    ...built.summary,
    warnings: built.warnings,
    blockers: built.blockers,
    version: built.version,
    nextStep: built.blockers.length
      ? 'Blocked: tell the user why in plain words; do not apply.'
      : `${STOP}apply with the same plan and --version ${built.version} --confirmed.`,
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const built = await PLANNERS[plan.kind](client, plan);
  if (built.blockers.length) throw new Blocked(built.blockers.join(' '));
  if (built.version !== flags.version) throw new Blocked('Something changed since the preview. Preview again and show the user the new result.');
  return built.write();
}

function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  find: cmdFind, show: cmdShow, results: cmdResults, prospects: cmdProspects, stages: cmdStages, preview: cmdPreview, apply: cmdApply,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: events.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    return result.blockers && result.blockers.length ? BLOCKED : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, eventBody, eventChecks, summarizeEvent, readPlan, PLANNERS,
};
