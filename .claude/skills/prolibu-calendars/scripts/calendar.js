#!/usr/bin/env node
'use strict';

// Bookable calendars the way the Prolibu booking page does them: set up a calendar (policies,
// exceptions, round-robin group, units), check availability and cross-check what the server's
// availability call leaves out, book / reschedule / cancel / confirm through the booking routes,
// and diagnose bookings made from a deal's quote. Run with no arguments for the command list.
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const moment = require('moment-timezone');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const START_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED = 3;

const DURATIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 120, 240, 480, 1440, 2880, 7200];
const INCREMENTS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 240, 480, 1440];
const TYPES = ['oneOnOne', 'roundRobin', 'overNight'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GROUP_TYPE = 'Calendar Load Balancer';

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. ';

// What each kind of setup record is, and the fields a plan may set on it.
const KINDS = {
  policy: {
    object: 'calendarpolicy',
    nameField: 'calendarPolicyName',
    fields: ['calendarPolicyName', 'description', 'rules', 'bookingCutoffs'],
  },
  exception: {
    object: 'calendarexception',
    nameField: 'calendarExceptionsName',
    fields: ['calendarExceptionsName', 'description', 'dates'],
  },
  roundRobinGroup: {
    object: 'usergroup',
    nameField: 'userGroupName',
    fields: ['userGroupName', 'users', 'timeZone'],
  },
  unit: {
    object: 'itemstock',
    nameField: 'name',
    fields: ['name', 'description', 'active', 'capacity', 'attributes', 'blocks'],
  },
  calendar: {
    object: 'calendar',
    nameField: 'calendarName',
    fields: [
      'calendarName', 'description', 'type', 'bookingType', 'eventDuration', 'eventDurations', 'startTimeIncrements',
      'timeZone', 'policies', 'calendarExceptions', 'userGroups', 'assignee', 'dateRange', 'minimumNotice', 'dailyLimit',
      'weeklyLimit', 'inviteesLimit', 'slotCapacity', 'bufferBefore', 'bufferAfter', 'cancellationDeadline',
      'holdDurationMinutes', 'requireConfirmation', 'externalSyncEnabled', 'locations', 'active',
    ],
  },
};
const APPLY_ORDER = ['policy', 'exception', 'roundRobinGroup', 'unit', 'calendar'];
const REF_FIELDS = { calendar: { policies: 'policy', calendarExceptions: 'exception', userGroups: 'roundRobinGroup' } };

// Fields the platform ignores or the skill never sets, with the reason given to the user.
const REFUSED_FIELDS = {
  isPublic: 'is stored but never checked: every calendar can be booked by its id',
  slug: 'is stored but never used',
  product: 'is a dead field; the product points to the calendar (Product.calendar), set it with prolibu-catalog',
  isPrimary: 'marks a user\'s personal calendar, created by the platform',
  allowEveryone: 'changes who can see the record; set it in the app',
  currentBranch: 'is set by the platform',
  homeBranch: 'belongs to the test-drive vertical, out of scope for this skill',
  setups: 'only works with the unit-setups preference; set it in the app',
  userGroupType: 'is always "Calendar Load Balancer" for a round-robin group',
};

class Blocked extends Error {}

// ── API helpers ──────────────────────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const msg = typeof body.error === 'string' ? body.error : body.message || JSON.stringify(body.error || 'no message');
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return sp.toString();
}

async function list(client, object, xquery, select, limit = 200) {
  const body = await call(client, 'GET', `/v2/${object}?${qs({ xquery, select, limit })}`);
  return { data: (body && body.data) || [], count: body && body.pagination ? body.pagination.count : 0 };
}

async function getOne(client, object, id, select) {
  if (!ID_RE.test(String(id))) throw new UsageError(`"${id}" is not a valid ${object} id (24 hex characters).`);
  return call(client, 'GET', `/v2/${object}/${id}${select ? `?${qs({ select })}` : ''}`);
}

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : String(v || ''));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

async function userContact(client, userId) {
  if (!ID_RE.test(idOf(userId))) return null;
  try {
    const u = await call(client, 'GET', `/v2/user/${idOf(userId)}?${qs({ select: 'email firstName lastName active' })}`);
    return { _id: idOf(userId), email: u.email || null, name: [u.firstName, u.lastName].filter(Boolean).join(' '), active: u.active !== false };
  } catch {
    return { _id: idOf(userId), email: null, name: null, active: null };
  }
}

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = (body && body.profile) || {};
  return { _id: idOf(p._id), email: p.email || null };
}

// ── Plans and validation ─────────────────────────────────────────────────────────────────────────

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    if (!text) throw new UsageError('Missing the plan (inline JSON in single quotes, or a temp file path).');
    assertDataFileAllowed(text, rootDir);
    text = fs.readFileSync(text, 'utf8');
  }
  try {
    const plan = JSON.parse(text);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('not an object');
    return plan;
  } catch {
    throw new UsageError('The plan is not a valid JSON object.');
  }
}

const isTz = (tz) => typeof tz === 'string' && !!moment.tz.zone(tz) && moment.tz.names().includes(tz);
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Policy rules: the engine matches `rule.wday === <number>`, so a text weekday never matches and the
// calendar shows no slots for that day. The server stores anything; this is the only check.
function validateRules(rules, problems) {
  if (!Array.isArray(rules) || !rules.length) {
    problems.push('rules must be a non-empty list: a policy without rules gives the calendar no free slots.');
    return;
  }
  const byDay = {};
  rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if (!rule || typeof rule !== 'object') {
      problems.push(`${at} must be an object.`);
      return;
    }
    const type = rule.type || (rule.wday !== undefined ? 'wday' : undefined);
    if (!['wday', 'date', 'overNight'].includes(type)) {
      problems.push(`${at}.type must be "wday", "date" or "overNight".`);
      return;
    }
    if (!TIME_RE.test(String(rule.from)) || !TIME_RE.test(String(rule.to))) {
      problems.push(`${at}: from and to must be "HH:mm" (24 h).`);
      return;
    }
    if (type === 'wday') {
      if (typeof rule.wday !== 'number' || !Number.isInteger(rule.wday) || rule.wday < 0 || rule.wday > 6) {
        problems.push(`${at}.wday must be an integer 0-6 (0 = Sunday, 1 = Monday … 6 = Saturday), not ${JSON.stringify(rule.wday)}. `
          + 'A text weekday is stored but never matches, and that day shows no free slots.');
        return;
      }
    }
    if (type === 'date' && !DAY_RE.test(String(rule.date))) problems.push(`${at}.date must be "YYYY-MM-DD".`);
    if (type !== 'overNight') {
      if (toMinutes(rule.from) >= toMinutes(rule.to)) {
        problems.push(`${at}: from (${rule.from}) must be before to (${rule.to}).`);
        return;
      }
      const key = type === 'wday' ? `wday ${rule.wday}` : `date ${rule.date}`;
      (byDay[key] = byDay[key] || []).push([toMinutes(rule.from), toMinutes(rule.to), at]);
    }
  });
  for (const [key, ranges] of Object.entries(byDay)) {
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i][0] < ranges[i - 1][1]) problems.push(`${ranges[i][2]} overlaps ${ranges[i - 1][2]} on ${key}.`);
    }
  }
}

function validateCutoffs(rows, problems) {
  if (!Array.isArray(rows)) {
    problems.push('bookingCutoffs must be a list.');
    return;
  }
  rows.forEach((row, i) => {
    const at = `bookingCutoffs[${i}]`;
    if (!row || !WEEKDAYS.includes(String(row.weekday).toLowerCase())) problems.push(`${at}.weekday must be one of ${WEEKDAYS.join(', ')}.`);
    const days = Number(row && row.daysBefore);
    if (!Number.isInteger(days) || days < 0 || days > 7) problems.push(`${at}.daysBefore must be 0-7.`);
    if (!row || !TIME_RE.test(String(row.cutoffTime))) problems.push(`${at}.cutoffTime must be "HH:mm".`);
    if (row && row.appliesTo !== undefined && !['everyone', 'publicOnly'].includes(row.appliesTo)) {
      problems.push(`${at}.appliesTo must be "everyone" or "publicOnly".`);
    }
  });
}

function validateCalendarFields(set, problems, warnings, isCreate) {
  if (set.type !== undefined && !TYPES.includes(set.type)) problems.push(`type must be one of ${TYPES.join(', ')}.`);
  if (set.bookingType !== undefined && !['appointment', 'room'].includes(set.bookingType)) {
    problems.push('bookingType must be "appointment" or "room" (test drive is out of scope for this skill).');
  }
  if (set.eventDuration !== undefined && !DURATIONS.includes(set.eventDuration)) {
    problems.push(`eventDuration must be one of ${DURATIONS.join(', ')} (minutes).`);
  }
  if (set.eventDurations !== undefined && (!Array.isArray(set.eventDurations) || set.eventDurations.some((d) => !DURATIONS.includes(Number(d))))) {
    problems.push(`eventDurations must be a list of ${DURATIONS.join(', ')} (minutes).`);
  }
  if (set.startTimeIncrements !== undefined && !INCREMENTS.includes(set.startTimeIncrements)) {
    problems.push(`startTimeIncrements must be one of ${INCREMENTS.join(', ')} (minutes).`);
  }
  if (set.timeZone !== undefined && !isTz(set.timeZone)) problems.push(`timeZone "${set.timeZone}" is not a valid IANA time zone (e.g. America/Bogota).`);
  for (const f of ['bufferBefore', 'bufferAfter']) {
    if (set[f] !== undefined && (!Number.isInteger(set[f]) || set[f] < 0 || set[f] > 720)) problems.push(`${f} must be whole minutes 0-720.`);
  }
  for (const f of ['dailyLimit', 'weeklyLimit', 'inviteesLimit', 'slotCapacity', 'holdDurationMinutes']) {
    if (set[f] !== undefined && set[f] !== null && (!Number.isInteger(set[f]) || set[f] < 0)) problems.push(`${f} must be a whole number.`);
  }
  if (set.policies !== undefined && (!Array.isArray(set.policies) || !set.policies.length)) {
    problems.push('policies must list at least one policy: a calendar without policies has no free slots.');
  }
  if (isCreate) {
    for (const f of ['calendarName', 'eventDuration', 'timeZone', 'policies']) {
      if (set[f] === undefined) problems.push(`A new calendar needs ${f}.`);
    }
    if (set.externalSyncEnabled === undefined) {
      problems.push('Ask the user whether confirmed bookings should go to the responsible person\'s Google/Outlook calendar '
        + '(the platform default is yes; the provider then e-mails the guests), and set externalSyncEnabled to true or false.');
    }
  }
  if (set.active === false) {
    warnings.push('active: false does NOT stop bookings: the booking page and the booking route never check it. '
      + 'To stop bookings, remove its policies or add an exception covering the dates.');
  }
  if (set.reminders !== undefined) problems.push('reminders are not a calendar field.');
}

function resolveRef(value, refs) {
  if (typeof value === 'string' && value.startsWith('@')) return refs[value.slice(1)] || null;
  return value;
}

// Validates the setup plan without touching the account; returns per-item problems.
function checkSetupPlan(plan) {
  const problems = [];
  const warnings = [];
  if (!Array.isArray(plan.items) || !plan.items.length) throw new UsageError('The setup plan needs "items": [{"kind": …, "set": {…}}].');
  const refs = new Set();
  plan.items.forEach((item, i) => {
    const at = `items[${i}]`;
    const kind = KINDS[item && item.kind];
    if (!kind) {
      problems.push(`${at}.kind must be one of ${Object.keys(KINDS).join(', ')}. Linking a calendar or units to a product is done with prolibu-catalog.`);
      return;
    }
    if (item.id !== undefined && !ID_RE.test(String(item.id))) problems.push(`${at}.id must be 24 hex characters.`);
    if (item.ref !== undefined) {
      if (item.id) problems.push(`${at}: use "ref" only on new records.`);
      if (refs.has(item.ref)) problems.push(`${at}.ref "${item.ref}" is repeated.`);
      refs.add(item.ref);
    }
    const set = item.set;
    if (!set || typeof set !== 'object' || !Object.keys(set).length) {
      problems.push(`${at}: "set" is empty.`);
      return;
    }
    for (const field of Object.keys(set)) {
      if (REFUSED_FIELDS[field]) problems.push(`${at}.set.${field} ${REFUSED_FIELDS[field]}.`);
      else if (!kind.fields.includes(field)) problems.push(`${at}.set.${field} is not a field this skill sets on a ${item.kind}.`);
    }
    const isCreate = !item.id;
    if (isCreate && set[kind.nameField] === undefined) problems.push(`${at}: a new ${item.kind} needs ${kind.nameField}.`);
    const local = [];
    if (item.kind === 'policy') {
      if (set.rules !== undefined || isCreate) validateRules(set.rules, local);
      if (set.bookingCutoffs !== undefined) validateCutoffs(set.bookingCutoffs, local);
    }
    if (item.kind === 'exception' && (set.dates !== undefined || isCreate)) {
      if (!Array.isArray(set.dates) || !set.dates.length || set.dates.some((d) => !DAY_RE.test(String(d)))) {
        local.push('dates must be a non-empty list of "YYYY-MM-DD".');
      }
    }
    if (item.kind === 'roundRobinGroup') {
      if ((set.users !== undefined || isCreate) && (!Array.isArray(set.users) || !set.users.length || set.users.some((u) => !ID_RE.test(String(u))))) {
        local.push('users must be a non-empty list of user ids (the order is the rotation; the platform rewrites it on every booking).');
      }
      if (set.timeZone !== undefined && !isTz(set.timeZone)) local.push(`timeZone "${set.timeZone}" is not a valid IANA time zone.`);
    }
    if (item.kind === 'unit') {
      if (set.blocks !== undefined) {
        if (!Array.isArray(set.blocks)) local.push('blocks must be a list of {from, to, reason}.');
        else {
          set.blocks.forEach((b, j) => {
            if (!b || Number.isNaN(Date.parse(b.from)) || Number.isNaN(Date.parse(b.to)) || Date.parse(b.from) >= Date.parse(b.to)) {
              local.push(`blocks[${j}] needs from < to (ISO dates).`);
            }
          });
        }
      }
      if (set.active === false) warnings.push(`${at}: an inactive unit is left out of availability and cannot be booked.`);
    }
    if (item.kind === 'calendar') {
      validateCalendarFields(set, local, warnings, isCreate);
      for (const [field] of Object.entries(REF_FIELDS.calendar)) {
        for (const v of [].concat(set[field] || [])) {
          if (typeof v === 'string' && v.startsWith('@')) {
            if (!plan.items.some((it) => it.ref === v.slice(1))) local.push(`${field}: "${v}" names no item of this plan.`);
          } else if (!ID_RE.test(String(v))) local.push(`${field}: "${v}" is not an id or an "@ref".`);
        }
      }
      if (set.assignee !== undefined && !ID_RE.test(String(set.assignee))) local.push('assignee must be a user id.');
    }
    local.forEach((p) => problems.push(`${at}: ${p}`));
  });
  return { problems, warnings };
}

// Lints a stored calendar together with its policies: the traps that silently leave no slots.
function lintCalendar(calendar, policies, exceptions) {
  const lints = [];
  const policyDocs = policies.filter(Boolean);
  if (!policyDocs.length) lints.push('No policies: the calendar has no free slots at all.');
  for (const p of policyDocs) {
    const rules = Array.isArray(p.rules) ? p.rules : [];
    if (!rules.length) lints.push(`Policy "${p.calendarPolicyName}" has no rules: it opens no hours.`);
    const textDays = rules.filter((r) => r && r.wday !== undefined && typeof r.wday !== 'number');
    if (textDays.length) {
      lints.push(`Policy "${p.calendarPolicyName}" stores weekdays as text (${[...new Set(textDays.map((r) => JSON.stringify(r.wday)))].join(', ')}): `
        + 'those days never show slots. Rewrite its rules with wday as integers 0-6.');
    }
  }
  if (calendar.active === false) lints.push('Marked inactive, but bookings still go through: the booking route does not check active.');
  if (calendar.type === 'roundRobin' && !(calendar.userGroups || []).length) lints.push('Round robin without a user group: every booking fails.');
  const owner = idOf(calendar.createdBy);
  if (calendar.type === 'oneOnOne' && calendar.assignee && owner && idOf(calendar.assignee) !== owner) {
    lints.push('The responsible person is not the calendar\'s creator: the availability call only counts the creator\'s bookings, '
      + 'so booked slots look free (the booking itself is rejected). The availability command cross-checks this.');
  }
  if (calendar.externalSyncEnabled !== false) {
    lints.push('External sync is on: confirmed bookings go to the responsible person\'s Google/Outlook (if connected), '
      + 'and the provider sends its own invitation to the guests.');
  }
  const today = moment().format('YYYY-MM-DD');
  for (const ex of exceptions.filter(Boolean)) {
    const dates = (ex.dates || []).map((d) => String(d).slice(0, 10));
    if (dates.length && dates.every((d) => d < today)) lints.push(`Exception "${ex.calendarExceptionsName}" only has past dates.`);
  }
  return lints;
}

// ── Reading a calendar ───────────────────────────────────────────────────────────────────────────

async function loadCalendar(client, calendarId) {
  const calendar = await getOne(client, 'calendar', calendarId);
  const policyIds = (calendar.policies || []).map(idOf);
  const exceptionIds = (calendar.calendarExceptions || []).map(idOf);
  const groupIds = (calendar.userGroups || []).map(idOf);
  const [policies, exceptions, groups] = await Promise.all([
    policyIds.length ? list(client, 'calendarpolicy', { _id: { $in: policyIds } }, 'calendarPolicyName rules bookingCutoffs updatedAt').then((r) => r.data) : [],
    exceptionIds.length ? list(client, 'calendarexception', { _id: { $in: exceptionIds } }, 'calendarExceptionsName dates updatedAt').then((r) => r.data) : [],
    groupIds.length ? list(client, 'usergroup', { _id: { $in: groupIds } }, 'userGroupName userGroupType users timeZone updatedAt').then((r) => r.data) : [],
  ]);
  return { calendar, policies, exceptions, groups };
}

async function cmdCalendars(client, [term]) {
  const xquery = term ? { calendarName: { $regex: `(?i)${String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } : undefined;
  const { data, count } = await list(client, 'calendar', xquery,
    'calendarName type bookingType eventDuration timeZone policies assignee createdBy active externalSyncEnabled requireConfirmation', 50);
  return {
    count,
    calendars: data.map((c) => ({
      _id: c._id, calendarName: c.calendarName, type: c.type, bookingType: c.bookingType, eventDuration: c.eventDuration,
      timeZone: c.timeZone, policies: (c.policies || []).length, assignee: idOf(c.assignee) || null,
      active: c.active !== false, externalSyncEnabled: c.externalSyncEnabled !== false, requireConfirmation: !!c.requireConfirmation,
    })),
    shown: data.length,
  };
}

async function cmdShow(client, [calendarId]) {
  if (!calendarId) throw new UsageError('Usage: show <domain> <calendarId>');
  const { calendar, policies, exceptions, groups } = await loadCalendar(client, calendarId);
  const [products, responsible] = await Promise.all([
    list(client, 'product', { calendar: calendar._id }, 'productName allocationMode itemStock active', 50).then((r) => r.data),
    userContact(client, calendar.assignee || calendar.createdBy),
  ]);
  const unitIds = [...new Set(products.flatMap((p) => (p.itemStock || []).map(idOf)))];
  const units = unitIds.length
    ? (await list(client, 'itemstock', { _id: { $in: unitIds } }, 'name active blocks capacity', 200)).data
    : [];
  return {
    calendar: {
      _id: calendar._id, calendarName: calendar.calendarName, type: calendar.type, bookingType: calendar.bookingType,
      eventDuration: calendar.eventDuration, eventDurations: calendar.eventDurations, startTimeIncrements: calendar.startTimeIncrements,
      timeZone: calendar.timeZone, dateRange: calendar.dateRange, minimumNotice: calendar.minimumNotice,
      dailyLimit: calendar.dailyLimit, weeklyLimit: calendar.weeklyLimit, inviteesLimit: calendar.inviteesLimit,
      slotCapacity: calendar.slotCapacity, bufferBefore: calendar.bufferBefore, bufferAfter: calendar.bufferAfter,
      cancellationDeadline: calendar.cancellationDeadline, holdDurationMinutes: calendar.holdDurationMinutes,
      requireConfirmation: !!calendar.requireConfirmation, externalSyncEnabled: calendar.externalSyncEnabled !== false,
      active: calendar.active !== false, locations: calendar.locations, updatedAt: calendar.updatedAt,
    },
    responsible,
    bookingPage: `https://${client.domain}/v2/calendar/view/${calendar._id}`,
    policies: policies.map((p) => ({ _id: p._id, calendarPolicyName: p.calendarPolicyName, rules: p.rules, bookingCutoffs: p.bookingCutoffs })),
    exceptions: exceptions.map((e) => ({ _id: e._id, calendarExceptionsName: e.calendarExceptionsName, dates: (e.dates || []).map((d) => String(d).slice(0, 10)) })),
    userGroups: groups.map((g) => ({ _id: g._id, userGroupName: g.userGroupName, userGroupType: g.userGroupType, users: (g.users || []).map(idOf), timeZone: g.timeZone })),
    products: products.map((p) => ({ _id: p._id, productName: p.productName, allocationMode: p.allocationMode || 'specific', units: (p.itemStock || []).map(idOf) })),
    units: units.map((u) => ({ _id: u._id, name: u.name, active: u.active !== false, capacity: u.capacity, blocks: u.blocks || [] })),
    lints: lintCalendar(calendar, policies, exceptions),
    note: 'The booking page is public: anyone with the link can book. Linking products and units to this calendar is done with prolibu-catalog.',
  };
}

// ── Availability and the cross-check ─────────────────────────────────────────────────────────────

async function eventsInRange(client, xquery, fromUtc, toUtc) {
  const { data, count } = await list(client, 'calendarevent', {
    ...xquery,
    status: { $ne: 'Cancelled' },
    $and: [{ startDate: { $lt: toUtc } }, { endDate: { $gt: fromUtc } }],
  }, 'title status startDate endDate assignee seatsTaken itemStock product calendar deal lineItemUuid', 500);
  return { events: data, truncated: count > data.length };
}

// Applies the rules the availability call leaves out and the booking enforces (verified in the
// booking code): exception dates by UTC day, daily/weekly limits counting every non-cancelled
// booking, Confirmed bookings of ANY assignee (availability only counts the creator's), and unit
// blocks. Returns the reasons a booking of [start, end) would be rejected.
function bookingRejections(ctx, start, end, { itemStock, excludeEventId } = {}) {
  const { calendar, exceptions, events } = ctx;
  const reasons = [];
  const tz = ctx.limitTimeZone || calendar.timeZone;
  const others = events.filter((e) => String(e._id) !== String(excludeEventId || ''));
  const startDay = moment.utc(start).format('YYYY-MM-DD');
  const endDay = moment.utc(end).format('YYYY-MM-DD');
  const hit = exceptions.find((ex) => (ex.dates || []).some((d) => {
    const day = moment.utc(d).format('YYYY-MM-DD');
    return day >= startDay && day <= endDay;
  }));
  if (hit) reasons.push(`exception "${hit.calendarExceptionsName}" ("Event is in exception date")`);
  if (calendar.dailyLimit) {
    const day = moment.tz(start, tz).format('YYYY-MM-DD');
    const n = others.filter((e) => String(e.calendar || '') === String(calendar._id) && moment.tz(e.startDate, tz).format('YYYY-MM-DD') === day).length;
    if (n >= calendar.dailyLimit) reasons.push(`daily limit of ${calendar.dailyLimit} reached ("Daily limit exceeded")`);
  }
  if (calendar.weeklyLimit) {
    const wStart = moment.tz(start, tz).startOf('week');
    const wEnd = moment.tz(start, tz).endOf('week');
    const n = others.filter((e) => String(e.calendar || '') === String(calendar._id) && moment(e.startDate).isBetween(wStart, wEnd, null, '[]')).length;
    if (n >= calendar.weeklyLimit) reasons.push(`weekly limit of ${calendar.weeklyLimit} reached ("Weekly limit exceeded")`);
  }
  if (calendar.type !== 'roundRobin') {
    const before = Number(calendar.bufferBefore) || 0;
    const after = Number(calendar.bufferAfter) || 0;
    const winStart = moment(start).subtract(before, 'minutes');
    const winEnd = moment(end).add(after, 'minutes');
    const clashing = others.filter((e) => e.status === 'Confirmed'
      && String(e.calendar || '') === String(calendar._id)
      && (!itemStock || idOf(e.itemStock) === String(itemStock))
      && moment(e.startDate).subtract(before, 'minutes').isBefore(winEnd)
      && moment(e.endDate).add(after, 'minutes').isAfter(winStart));
    const seats = clashing.reduce((s, e) => s + (e.seatsTaken || 1), 0);
    if (seats + 1 > (calendar.slotCapacity || 1)) {
      reasons.push(`a Confirmed booking already takes this time ("Event already exists in this time range"): ${clashing.map((e) => e.title).join(', ')}`);
    }
  }
  if (itemStock && ctx.units) {
    const unit = ctx.units.find((u) => String(u._id) === String(itemStock));
    if (!unit) reasons.push('the unit does not belong to the product');
    else {
      if (unit.active === false) reasons.push(`unit "${unit.name}" is inactive`);
      const block = (unit.blocks || []).find((b) => moment(b.from).isBefore(end) && moment(b.to).isAfter(start));
      if (block) reasons.push(`unit "${unit.name}" is blocked${block.reason ? ` (${block.reason})` : ''}`);
      const elsewhere = (ctx.unitEvents || []).filter((e) => e.status === 'Confirmed' && idOf(e.itemStock) === String(itemStock)
        && String(e.calendar || '') !== String(calendar._id) && moment(e.startDate).isBefore(end) && moment(e.endDate).isAfter(start));
      if (elsewhere.length) {
        reasons.push(`unit "${unit.name}" is booked in another calendar at that time (the booking will NOT stop it: units are shared across calendars)`);
      }
    }
  }
  return reasons;
}

function slotInstant(day, slot, which, tz) {
  // dateTimeStart/End are local wall clock in the requested zone with a literal Z; the end of an
  // overNight slot carries the start's date, so it is rebuilt from the duration instead.
  const text = String(slot[which === 'start' ? 'dateTimeStart' : 'dateTimeEnd'] || '').slice(0, 19).replace('T', ' ');
  return moment.tz(text || `${day} ${slot[which]}`, 'YYYY-MM-DD HH:mm:ss', tz);
}

async function availabilityContext(client, calendarId, { from, to, tz, group, duration, productId }) {
  const loaded = await loadCalendar(client, calendarId);
  const { calendar } = loaded;
  const zone = tz || calendar.timeZone;
  if (!isTz(zone)) throw new UsageError(`"${zone}" is not a valid time zone.`);
  if (calendar.type === 'roundRobin' && !group) {
    if (loaded.groups.length === 1) group = loaded.groups[0]._id;
    else throw new UsageError(`This is a round-robin calendar: pass --group <id> (${loaded.groups.map((g) => `${g._id} ${g.userGroupName}`).join('; ') || 'it has no group'}).`);
  }
  const fromUtc = moment.tz(from, zone).subtract(8, 'days').toISOString();
  const toUtc = moment.tz(to, zone).add(9, 'days').toISOString();
  const query = qs({ startDate: from, endDate: to, timeZone: zone, userGroupId: group, duration });
  const [server, ev] = await Promise.all([
    productId
      ? call(client, 'GET', `/v2/calendar/getavailabilityproduct/${productId}?${qs({ startDate: from, endDate: to, timeZone: zone })}`)
      : call(client, 'GET', `/v2/calendar/getavailability/${calendar._id}?${query}`),
    eventsInRange(client, { calendar: calendar._id }, fromUtc, toUtc),
  ]);
  let limitTimeZone = calendar.timeZone;
  const groupDoc = loaded.groups.find((g) => String(g._id) === String(group));
  if (groupDoc && groupDoc.timeZone) limitTimeZone = groupDoc.timeZone;
  return { ...loaded, zone, group, server, events: ev.events, truncated: ev.truncated, limitTimeZone };
}

function summarizeDays(ctx, days, extra = {}) {
  return (Array.isArray(days) ? days : []).map((day) => {
    const free = [];
    const rejected = [];
    let taken = 0;
    for (const slot of day.slots || []) {
      if (!slot.availability) {
        taken += 1;
        continue;
      }
      const start = slotInstant(day.date, slot, 'start', ctx.zone);
      const end = ctx.durationMinutes ? start.clone().add(ctx.durationMinutes, 'minutes') : slotInstant(day.date, slot, 'end', ctx.zone);
      const reasons = bookingRejections(ctx, start, end, extra);
      if (reasons.length) rejected.push({ start: slot.start, reasons });
      else free.push(slot.start);
    }
    return {
      date: day.date,
      freeStarts: compactStarts(free, ctx.calendar.startTimeIncrements),
      freeCount: free.length,
      rejectedByBooking: groupRejections(rejected, ctx.calendar.startTimeIncrements),
      takenOrClosed: taken,
      ...(day.bookingDeadline ? { bookingDeadline: day.bookingDeadline } : {}),
    };
  });
}

// Slots the server offers but a booking would reject, grouped by reason.
function groupRejections(rejected, step) {
  const byReason = new Map();
  for (const r of rejected) {
    const key = r.reasons.join('; ');
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(r.start);
  }
  return [...byReason.entries()].map(([reason, starts]) => ({ starts: compactStarts(starts, step), reason }));
}

// "08:00", "08:15", "08:30" with a 15-minute step → "08:00-08:30 every 15 min".
function compactStarts(starts, step) {
  const minutes = starts.map(toMinutes);
  const out = [];
  let i = 0;
  while (i < minutes.length) {
    let j = i;
    while (j + 1 < minutes.length && minutes[j + 1] - minutes[j] === step) j += 1;
    out.push(j > i ? `${starts[i]}-${starts[j]} every ${step} min` : starts[i]);
    i = j + 1;
  }
  return out;
}

function parseRangeFlags(flags, tz) {
  const zone = tz || 'UTC';
  const from = flags.from || moment.tz(zone).format('YYYY-MM-DD');
  const to = flags.to || moment.tz(from, zone).add(6, 'days').format('YYYY-MM-DD');
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new UsageError('--from and --to must be YYYY-MM-DD.');
  if (to < from) throw new UsageError('--to is before --from.');
  if (moment(to).diff(moment(from), 'days') > 31) throw new UsageError('Ask for 31 days or fewer at a time.');
  return { from, to };
}

const AVAILABILITY_CAVEATS = [
  'Tentative bookings never block a slot (only Confirmed ones do).',
  'Round-robin availability is an approximation; the booking is the final word ("All users are busy").',
  'Busy time in the responsible person\'s Google/Outlook is included only when that account is connected and external sync is on.',
];

async function cmdAvailability(client, [calendarId], flags) {
  if (!calendarId) throw new UsageError('Usage: availability <domain> <calendarId> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tz <zone>] [--group <id>] [--duration <min>] [--product <id> [--unit <id>]]');
  const head = await getOne(client, 'calendar', calendarId, 'timeZone');
  const range = parseRangeFlags(flags, flags.tz || head.timeZone);
  const ctx = await availabilityContext(client, calendarId, { ...range, tz: flags.tz, group: flags.group, duration: flags.duration, productId: flags.product });
  ctx.durationMinutes = flags.duration ? Number(flags.duration) : 0;
  const lints = lintCalendar(ctx.calendar, ctx.policies, ctx.exceptions);
  const out = {
    calendar: { _id: ctx.calendar._id, calendarName: ctx.calendar.calendarName, type: ctx.calendar.type, timeZone: ctx.calendar.timeZone },
    timeZone: ctx.zone,
    lints,
    caveats: AVAILABILITY_CAVEATS,
  };
  if (ctx.truncated) out.caveats.push('More than 500 bookings in range: the cross-check saw only the first 500.');
  if (!flags.product) {
    out.days = summarizeDays(ctx, ctx.server.days);
    return out;
  }
  const product = await getOne(client, 'product', flags.product, 'productName calendar itemStock allocationMode');
  if (idOf(product.calendar) !== String(ctx.calendar._id)) throw new UsageError('That product does not use this calendar.');
  const unitIds = (product.itemStock || []).map(idOf);
  ctx.units = unitIds.length ? (await list(client, 'itemstock', { _id: { $in: unitIds } }, 'name active blocks', 200)).data : [];
  ctx.unitEvents = unitIds.length
    ? (await eventsInRange(client, { itemStock: { $in: unitIds } }, moment.tz(range.from, ctx.zone).toISOString(), moment.tz(range.to, ctx.zone).add(1, 'day').toISOString())).events
    : [];
  out.product = { _id: product._id, productName: product.productName, allocationMode: product.allocationMode || 'specific' };
  out.units = ctx.units.map((unit) => ({
    _id: unit._id,
    name: unit.name,
    days: (Array.isArray(ctx.server) ? ctx.server : []).map((day) => {
      const p = (day.products || []).find((x) => String(x._id) === String(product._id)) || {};
      const entry = (p.itemStock || []).find((x) => String(x._id) === String(unit._id));
      return summarizeDays(ctx, [{ date: day.date, slots: entry ? entry.slots : [] }], { itemStock: unit._id })[0];
    }),
  })).filter((u) => !flags.unit || String(u._id) === String(flags.unit));
  return out;
}

// Checks one slot the way a booking would. Exported so prolibu-quotes can pre-check a reserved line.
async function checkSlot(client, {
  calendarId, productId, itemStockId, start, timeZone, duration, userGroupId, excludeEventId,
}) {
  const m = START_RE.exec(String(start || ''));
  if (!m) throw new UsageError('start must be "YYYY-MM-DD HH:mm" (wall clock in the time zone).');
  let calId = calendarId;
  let product = null;
  if (productId) {
    product = await getOne(client, 'product', productId, 'productName calendar itemStock allocationMode');
    if (!product.calendar) return { ok: false, reasons: ['The product has no calendar.'] };
    if (calId && idOf(product.calendar) !== String(calId)) return { ok: false, reasons: ['The product uses another calendar.'] };
    calId = idOf(product.calendar);
  }
  if (!calId) throw new UsageError('Give calendarId or productId.');
  const head = await getOne(client, 'calendar', calId, 'timeZone');
  const zone = timeZone || head.timeZone;
  const ctx = await availabilityContext(client, calId, {
    from: m[1], to: m[1], tz: zone, group: userGroupId, duration, productId: product ? product._id : undefined,
  });
  const dur = Number(duration) || ctx.calendar.eventDuration;
  const startAt = moment.tz(String(start), 'YYYY-MM-DD HH:mm', zone);
  const endAt = startAt.clone().add(dur, 'minutes');
  const hhmm = `${m[2]}:${m[3]}`;
  const reasons = [];
  let slot;
  if (product) {
    const unitIds = (product.itemStock || []).map(idOf);
    ctx.units = unitIds.length ? (await list(client, 'itemstock', { _id: { $in: unitIds } }, 'name active blocks', 200)).data : [];
    ctx.unitEvents = itemStockId
      ? (await eventsInRange(client, { itemStock: itemStockId }, startAt.toISOString(), endAt.toISOString())).events
      : [];
    if (!itemStockId && product.allocationMode !== 'pool') reasons.push('This product books a specific unit: say which one.');
    const day = (Array.isArray(ctx.server) ? ctx.server : []).find((d) => d.date === m[1]) || {};
    const p = (day.products || []).find((x) => String(x._id) === String(product._id)) || {};
    const entry = itemStockId ? (p.itemStock || []).find((x) => String(x._id) === String(itemStockId)) : null;
    const slots = entry ? entry.slots : (p.poolSlots || []);
    slot = (slots || []).find((s) => s.start === hhmm);
  } else {
    const day = ((ctx.server && ctx.server.days) || []).find((d) => d.date === m[1]) || {};
    slot = (day.slots || []).find((s) => s.start === hhmm);
  }
  if (!slot) reasons.push(`${hhmm} is not a start time the calendar offers that day (outside the hours, a closed day, past the booking cut-off or too soon).`);
  else if (!slot.availability) reasons.push(`${hhmm} is already taken.`);
  reasons.push(...bookingRejections(ctx, startAt, endAt, { itemStock: itemStockId, excludeEventId }));
  return {
    ok: reasons.length === 0,
    reasons,
    startUtc: startAt.toISOString(),
    endUtc: endAt.toISOString(),
    timeZone: zone,
    calendar: ctx.calendar,
    lints: lintCalendar(ctx.calendar, ctx.policies, ctx.exceptions),
    groups: ctx.groups,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────────────────────────

async function planSetup(client, plan) {
  const { problems, warnings } = checkSetupPlan(plan);
  const touched = {};
  const changes = [];
  const keyUser = await me(client).catch(() => ({}));
  for (const item of plan.items) {
    const kind = KINDS[item.kind];
    if (!kind) continue;
    if (item.id) {
      let record;
      try {
        record = await getOne(client, kind.object, item.id);
      } catch (e) {
        problems.push(`${item.kind} ${item.id}: ${e.status === 404 ? 'not found' : e.message}.`);
        continue;
      }
      touched[item.id] = record.updatedAt;
      if (item.kind === 'roundRobinGroup' && record.userGroupType !== GROUP_TYPE) {
        problems.push(`${item.id} is a "${record.userGroupType}" group, not a round-robin group: leave it alone.`);
      }
      if (item.kind === 'roundRobinGroup' && item.set.users) {
        warnings.push('Every booking rewrites the group\'s user order (the rotation). Saving "users" replaces that order with yours.');
      }
      const diff = {};
      for (const [f, v] of Object.entries(item.set)) {
        if (JSON.stringify(record[f]) !== JSON.stringify(v)) diff[f] = { before: record[f] === undefined ? null : record[f], after: v };
      }
      changes.push({ action: 'update', kind: item.kind, id: item.id, name: record[kind.nameField], fields: diff });
    } else {
      changes.push({ action: 'create', kind: item.kind, ref: item.ref || null, name: item.set[kind.nameField], set: item.set });
    }
  }
  // Existing records the plan points to: they must exist, and policies must not carry text weekdays.
  for (const item of plan.items.filter((it) => it.kind === 'calendar')) {
    for (const [field, refKind] of Object.entries(REF_FIELDS.calendar)) {
      for (const v of [].concat(item.set[field] || []).filter((x) => ID_RE.test(String(x)))) {
        try {
          const rec = await getOne(client, KINDS[refKind].object, v);
          touched[v] = rec.updatedAt;
          if (refKind === 'policy') lintCalendar({ externalSyncEnabled: false }, [rec], []).forEach((l) => problems.push(l));
          if (refKind === 'roundRobinGroup' && rec.userGroupType !== GROUP_TYPE) problems.push(`${v} is not a "${GROUP_TYPE}" group.`);
        } catch (e) {
          problems.push(`${field}: ${v} ${e.status === 404 ? 'was not found' : e.message}.`);
        }
      }
    }
    const set = item.set;
    let stored = {};
    if (item.id) stored = await getOne(client, 'calendar', item.id);
    const type = set.type || stored.type || 'oneOnOne';
    const groups = set.userGroups !== undefined ? set.userGroups : stored.userGroups;
    if (type === 'roundRobin' && !(groups || []).length) problems.push('A round-robin calendar needs userGroups (a "roundRobinGroup" item or an existing group id).');
    const assignee = set.assignee !== undefined ? set.assignee : idOf(stored.assignee);
    const owner = item.id ? idOf(stored.createdBy) : keyUser._id;
    if (type === 'oneOnOne' && assignee && owner && String(assignee) !== String(owner)) {
      warnings.push('The responsible person is not the calendar\'s creator (the API key\'s user): the availability call will show booked slots as free. '
        + 'Bookings are still checked correctly, and this skill\'s availability command cross-checks it.');
    }
    const responsible = await userContact(client, assignee || owner);
    if (responsible) {
      changes.push({ action: 'note', kind: 'calendar', responsible: { email: responsible.email, name: responsible.name, active: responsible.active } });
      if (responsible.active === false) problems.push('The responsible person is inactive.');
    }
  }
  for (const item of plan.items.filter((it) => it.kind === 'roundRobinGroup' && it.set.users)) {
    for (const uid of item.set.users) {
      const u = await userContact(client, uid);
      if (!u || !u.email) problems.push(`User ${uid} was not found.`);
      else if (u.active === false) problems.push(`User ${u.email} is inactive: round robin would still assign bookings to them.`);
    }
  }
  const version = hash({ plan, touched });
  return { problems, warnings, changes, version };
}

function subsetMatches(sent, stored, field) {
  if (field === 'dates') return JSON.stringify((sent || []).map((d) => String(d).slice(0, 10)).sort()) === JSON.stringify((stored || []).map((d) => moment.utc(d).format('YYYY-MM-DD')).sort());
  if (field === 'eventDurations') return JSON.stringify((sent || []).map(Number)) === JSON.stringify((stored || []).map(Number));
  if (field === 'blocks') return (sent || []).length === (stored || []).length;
  if (Array.isArray(sent)) {
    if (!Array.isArray(stored) || stored.length !== sent.length) return false;
    return sent.every((v, i) => subsetMatches(v, stored[i]));
  }
  if (sent && typeof sent === 'object') {
    if (!stored || typeof stored !== 'object') return false;
    return Object.entries(sent).every(([k, v]) => subsetMatches(v, stored[k], k));
  }
  if (stored && typeof stored === 'object' && stored._id) return String(stored._id) === String(sent);
  if (typeof sent === 'string' && DAY_RE.test(sent) && stored) return String(stored).slice(0, 10) === sent;
  if (field === 'weekday' || typeof sent === 'string') return String(sent).toLowerCase() === String(stored).toLowerCase();
  return String(sent) === String(stored);
}

async function cmdSetupPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await planSetup(client, plan);
  return {
    ...result,
    blockers: result.problems,
    nextStep: result.problems.length
      ? 'Blocked: fix the plan (or tell the user why) and preview again. Nothing was written.'
      : `${STOP}Only after the user answers with an explicit yes in a later message, run setup-apply with the same plan and --version ${result.version} --confirmed.`,
  };
}

async function cmdSetupApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run setup-preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const planned = await planSetup(client, plan);
  if (planned.problems.length) throw new Blocked(planned.problems.join(' '));
  if (planned.version !== flags.version) throw new Blocked('The plan or a record it touches changed since the preview. Preview again and show the user.');
  const refs = {};
  const written = [];
  const problems = [];
  const items = [...plan.items].sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind));
  for (const item of items) {
    const kind = KINDS[item.kind];
    const body = { ...item.set };
    for (const field of Object.keys(REF_FIELDS[item.kind] || {})) {
      if (Array.isArray(body[field])) body[field] = body[field].map((v) => resolveRef(v, refs));
    }
    if (item.kind === 'policy' && Array.isArray(body.rules)) body.rules = body.rules.map((r) => (r.type ? r : { type: 'wday', ...r }));
    if (item.kind === 'roundRobinGroup' && !item.id) body.userGroupType = GROUP_TYPE;
    if (item.kind === 'policy' && Array.isArray(body.bookingCutoffs)) {
      body.bookingCutoffs = body.bookingCutoffs.map((c) => ({ ...c, weekday: String(c.weekday).toLowerCase() }));
    }
    let saved;
    try {
      saved = item.id
        ? await call(client, 'PATCH', `/v2/${kind.object}/${item.id}`, { data: body, confirmed: true })
        : await call(client, 'POST', `/v2/${kind.object}`, { data: body, confirmed: true });
    } catch (e) {
      return {
        saved: false,
        written,
        problems: [`${item.kind} "${item.set[kind.nameField] || item.id}": ${e.message}`],
        nextStep: 'Stopped at the first failure. The records in "written" exist now: put their ids as "id" in the plan (instead of "ref") before trying again.',
      };
    }
    const id = String(saved._id || item.id);
    if (item.ref) refs[item.ref] = id;
    const after = await getOne(client, kind.object, id);
    const bad = Object.keys(body).filter((f) => !subsetMatches(body[f], after[f], f));
    bad.forEach((f) => problems.push(`${item.kind} ${id}: ${f} did not save as sent.`));
    written.push({ action: item.id ? 'updated' : 'created', kind: item.kind, id, name: after[kind.nameField] });
  }
  // Probe: what the booking page will offer in the next 7 days, cross-checked.
  const probes = [];
  for (const w of written.filter((x) => x.kind === 'calendar')) {
    try {
      const cal = await getOne(client, 'calendar', w.id, 'timeZone');
      const from = moment.tz(cal.timeZone || 'UTC').format('YYYY-MM-DD');
      const to = moment.tz(from, cal.timeZone || 'UTC').add(6, 'days').format('YYYY-MM-DD');
      const res = await cmdAvailability(client, [w.id], { from, to });
      probes.push({ calendarId: w.id, days: res.days.map((d) => ({ date: d.date, freeStarts: d.freeStarts, rejectedByBooking: d.rejectedByBooking })), lints: res.lints });
    } catch (e) {
      probes.push({ calendarId: w.id, error: e.message });
    }
  }
  return { saved: problems.length === 0, written, problems, availabilityProbe: probes };
}

// ── Bookings ─────────────────────────────────────────────────────────────────────────────────────

const BOOK_FIELDS = ['calendarId', 'productId', 'itemStockId', 'start', 'timeZone', 'duration', 'name', 'email', 'attendees', 'title',
  'description', 'location', 'userGroupId', 'assigneeId', 'dealId', 'seats'];

function checkBookPlan(plan) {
  const problems = [];
  if (plan.contact !== undefined) problems.push('Never send "contact" on a booking: with an agreement template it e-mails a contract for signature. The booking route drops it anyway.');
  if (plan.reminders !== undefined) problems.push('"reminders" schedule extra e-mails and are not part of a booking; leave them out.');
  if (plan.status !== undefined) problems.push('Do not set "status": the booking asks for Confirmed like the booking page, and calendars that require confirmation make it Tentative.');
  for (const k of Object.keys(plan)) {
    if (!BOOK_FIELDS.includes(k) && !['contact', 'reminders', 'status'].includes(k)) problems.push(`"${k}" is not a booking field.`);
  }
  if (!plan.calendarId && !plan.productId) problems.push('Give calendarId (or productId for a product with units).');
  if (!START_RE.test(String(plan.start || ''))) problems.push('start must be "YYYY-MM-DD HH:mm", the wall-clock time in timeZone.');
  if (!plan.name || typeof plan.name !== 'string' || plan.name.length > 120 || /[<>]/.test(plan.name)) {
    problems.push('name (the person booking) is required, plain text, without < or >: it goes into the e-mails.');
  }
  if (!EMAIL_RE.test(String(plan.email || ''))) problems.push('email (the person booking) must be an e-mail address.');
  if (plan.attendees !== undefined && (!Array.isArray(plan.attendees) || plan.attendees.some((e) => !EMAIL_RE.test(String(e))))) {
    problems.push('attendees must be a list of e-mail addresses (extra guests).');
  }
  if (plan.timeZone !== undefined && !isTz(plan.timeZone)) problems.push(`timeZone "${plan.timeZone}" is not valid.`);
  for (const f of ['calendarId', 'productId', 'itemStockId', 'userGroupId', 'assigneeId', 'dealId']) {
    if (plan[f] !== undefined && !ID_RE.test(String(plan[f]))) problems.push(`${f} must be 24 hex characters.`);
  }
  if (problems.length) throw new UsageError(problems.join(' '));
}

function recipientsNote(calendar, outcome) {
  const notes = [];
  if (calendar.externalSyncEnabled !== false && outcome === 'Confirmed') {
    notes.push('If the responsible person has Google/Outlook connected, the booking goes to that calendar and the provider sends the guests its own invitation instead of the platform e-mail.');
  }
  notes.push('The responsible person also gets an in-app notification.');
  return notes;
}

async function planBooking(client, plan) {
  checkBookPlan(plan);
  const attendees = [...new Set([plan.email, ...(plan.attendees || [])].map((e) => String(e).trim().toLowerCase()))];
  const slot = await checkSlot(client, {
    calendarId: plan.calendarId, productId: plan.productId, itemStockId: plan.itemStockId, start: plan.start,
    timeZone: plan.timeZone, duration: plan.duration, userGroupId: plan.userGroupId,
  });
  const { calendar } = slot;
  const blockers = [...slot.reasons];
  if (attendees.length > (calendar.inviteesLimit || 1)) {
    blockers.push(`The calendar allows ${calendar.inviteesLimit || 1} e-mail(s) per booking, the person booking included ("Invitees limit exceeded").`);
  }
  // The booking route is public: the API key does not make it a staff booking.
  const outcome = calendar.requireConfirmation ? 'Tentative' : 'Confirmed';
  let responsible = [];
  if (plan.assigneeId) responsible = [await userContact(client, plan.assigneeId)];
  else if (calendar.type === 'roundRobin') {
    const group = slot.groups.find((g) => String(g._id) === String(plan.userGroupId)) || slot.groups[0];
    responsible = await Promise.all(((group && group.users) || []).map((u) => userContact(client, u)));
  } else responsible = [await userContact(client, calendar.assignee || calendar.createdBy)];
  const body = {
    title: plan.title || `${calendar.calendarName} — ${plan.name}`,
    description: plan.description,
    location: plan.location,
    timeZone: slot.timeZone,
    startDate: plan.start,
    creator: plan.email,
    creatorFullName: plan.name,
    attendees,
    status: 'Confirmed',
    idCalendar: plan.productId ? undefined : String(calendar._id),
    product: plan.productId,
    itemStock: plan.itemStockId,
    userGroupId: plan.userGroupId || (calendar.type === 'roundRobin' && slot.groups[0] ? String(slot.groups[0]._id) : undefined),
    assignee: plan.assigneeId,
    duration: plan.duration,
    deal: plan.dealId,
    seats: plan.seats,
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const version = hash({ body, calendar: calendar.updatedAt });
  body.idempotencyKey = `skill-${version}`;
  return {
    body,
    version,
    blockers,
    lints: slot.lints,
    summary: {
      calendar: calendar.calendarName,
      startsAt: `${plan.start} (${slot.timeZone})`,
      startUtc: slot.startUtc,
      endUtc: slot.endUtc,
      outcome,
      ...(outcome === 'Tentative' && calendar.holdDurationMinutes ? { holdExpiresAfterMinutes: calendar.holdDurationMinutes } : {}),
    },
    recipients: {
      invitationEmailTo: attendees,
      acceptOrRejectEmailTo: responsible.filter(Boolean).map((r) => r.email || `(user ${r._id}, e-mail unknown)`),
      ...(calendar.type === 'roundRobin' && !plan.assigneeId ? { note: 'Round robin: ONE of these people gets it, chosen at booking time.' } : {}),
      also: recipientsNote(calendar, outcome),
    },
  };
}

function eventSummary(e) {
  return {
    _id: e._id, title: e.title, status: e.status, startDate: e.startDate, endDate: e.endDate, timeZone: e.timeZone,
    attendees: (e.attendees || []).map((a) => (a && typeof a === 'object' ? a.email : a)),
    assignee: idOf(e.assignee) || null, rescheduledFrom: idOf(e.rescheduledFrom) || null, cancelReason: e.cancelReason,
    externalSync: e.externalSync ? e.externalSync.status : undefined,
  };
}

async function readEvent(client, id) {
  return call(client, 'GET', `/v2/calendarevent/${id}?${qs({ populate: 'attendees' })}`);
}

async function cmdBookPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planBooking(client, plan);
  return {
    ...p,
    body: undefined,
    nextStep: p.blockers.length
      ? 'Blocked: tell the user why in plain words; offer another time. Do not book.'
      : `${STOP}Tell the user exactly who will get e-mails (recipients) and whether it stays Tentative. `
        + `Only after an explicit yes to that, run book with the same plan, --version ${p.version} --confirmed --reaches-people.`,
  };
}

async function cmdBook(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run book-preview first and pass its version.');
  if (!flags.confirmed || !flags.reachesPeople) {
    throw new UsageError('A booking e-mails the guests and the responsible person: it needs --confirmed and --reaches-people, given after the user said yes to exactly those recipients.');
  }
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planBooking(client, plan);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The plan or the calendar changed since the preview. Preview again and show the user.');
  const startedAt = Date.now();
  const created = await call(client, 'POST', '/v2/calendar/scheduleevent', { data: p.body, confirmed: true, reachesPeople: true });
  const event = await readEvent(client, created._id);
  const problems = [];
  if (Math.abs(Date.parse(event.startDate) - Date.parse(p.summary.startUtc)) > 60000) problems.push(`Saved start ${event.startDate} differs from ${p.summary.startUtc}.`);
  if (event.status === 'Cancelled') problems.push('The booking route returned an existing, cancelled booking (same plan booked before). Change the plan (e.g. the title) and preview again.');
  const repeated = Date.parse(event.createdAt) < startedAt - 5000;
  return { saved: problems.length === 0, repeated, event: eventSummary(event), problems };
}

async function loadEventForChange(client, eventId) {
  if (!ID_RE.test(String(eventId || ''))) throw new UsageError('eventId must be 24 hex characters.');
  const event = await readEvent(client, eventId);
  const calendar = event.calendar ? await getOne(client, 'calendar', idOf(event.calendar)) : null;
  const blockers = [];
  let linkedToLine = false;
  if (event.deal && (event.lineItemUuid || !(event.attendees || []).length)) {
    const deal = await getOne(client, 'deal', idOf(event.deal), 'proposal.quote.lineItems.calendarEvents').catch(() => null);
    const lines = (deal && deal.proposal && deal.proposal.quote && deal.proposal.quote.lineItems) || [];
    // An orphan (its line was removed) is never touched by the deal again; a listed one is.
    linkedToLine = !deal || lines.some((l) => (l.calendarEvents || []).map(String).includes(String(event._id)));
  }
  if (linkedToLine) {
    blockers.push('This booking was made from a deal\'s quote: the next save of the deal sets its status again from the deal\'s stage '
      + '(approved = Confirmed, denied = Cancelled, otherwise Tentative). Change the reserved line with prolibu-quotes, or move the deal\'s stage.');
  }
  if (!calendar) blockers.push('The booking has no calendar.');
  if (event.bookingType === 'testDrive') blockers.push('Test-drive bookings are handled in the app\'s test-drive screen.');
  return { event, calendar, blockers };
}

function deadlineCheck(event, calendar) {
  const type = calendar && calendar.cancellationDeadline && calendar.cancellationDeadline.deadlineType;
  if (!type) return { deadline: null, passed: false };
  let minutes = Number(calendar.cancellationDeadline.deadlineValue) || 0;
  if (type === 'hours') minutes *= 60;
  if (type === 'days') minutes *= 1440;
  const deadline = moment(event.startDate).subtract(minutes, 'minutes');
  return { deadline: deadline.toISOString(), passed: moment().isAfter(deadline) };
}

async function changeRecipients(client, event) {
  const assignee = event.assignee ? await userContact(client, event.assignee) : null;
  return {
    guests: (event.attendees || []).map((a) => (a && typeof a === 'object' ? a.email : a)).filter(Boolean),
    responsible: assignee ? assignee.email : null,
    syncedExternally: !!event.sourceId,
  };
}

async function planStatusChange(client, plan, action) {
  const { event, calendar, blockers } = await loadEventForChange(client, plan.eventId);
  const out = { event: eventSummary(event), blockers, version: String(event.updatedAt) };
  const r = await changeRecipients(client, event);
  if (action === 'cancel') {
    if (event.status === 'Cancelled') blockers.push('Already cancelled.');
    const d = deadlineCheck(event, calendar);
    if (d.passed) blockers.push(`The calendar's cancellation deadline passed on ${d.deadline} ("Cancellation deadline exceeded"). Tell the user; the app's owner decides.`);
    out.cancellationDeadline = d.deadline;
    out.recipients = r.syncedExternally
      ? { note: 'Synced to the responsible person\'s Google/Outlook: the provider sends the cancellation to the guests.', inAppNotification: r.responsible }
      : { cancellationEmailTo: [...r.guests, ...(r.responsible ? [r.responsible] : [])], inAppNotification: r.responsible };
  }
  if (action === 'confirm') {
    if (event.status !== 'Tentative') blockers.push(`Only a Tentative booking can be confirmed; this one is ${event.status}.`);
    const others = (await eventsInRange(client, { calendar: idOf(event.calendar) }, event.startDate, event.endDate)).events;
    const ctx = { calendar, exceptions: [], events: others.filter((e) => e.status === 'Confirmed') };
    const clash = bookingRejections({ ...ctx, calendar: { ...calendar, dailyLimit: 0, weeklyLimit: 0 } }, moment(event.startDate), moment(event.endDate), { itemStock: idOf(event.itemStock), excludeEventId: event._id });
    if (calendar && calendar.type !== 'roundRobin' && clash.length) blockers.push(`Confirming would overlap: ${clash.join('; ')} ("Event overlap").`);
    out.recipients = {
      emails: 'None from the platform.',
      external: calendar && calendar.externalSyncEnabled !== false
        ? `If ${r.responsible || 'the responsible person'} has Google/Outlook connected, the booking is added there and the provider invites: ${r.guests.join(', ') || 'no guests'}.`
        : 'External sync is off: nothing is sent.',
    };
  }
  return out;
}

async function cmdStatusPreview(action, client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const out = await planStatusChange(client, plan, action);
  return {
    ...out,
    nextStep: out.blockers.length
      ? 'Blocked: tell the user why in plain words. Do not use another route (never PATCH the status or DELETE the booking).'
      : `${STOP}Tell the user who is notified. Only after an explicit yes, run ${action} with the same plan, --version ${out.version} --confirmed --reaches-people.`,
  };
}

async function cmdStatusApply(action, client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError(`Missing --version. Run ${action}-preview first.`);
  if (!flags.confirmed || !flags.reachesPeople) throw new UsageError(`${action} notifies people: it needs --confirmed and --reaches-people after the user's yes.`);
  const plan = readPlan(planArg, ctx.rootDir);
  const out = await planStatusChange(client, plan, action);
  if (out.blockers.length) throw new Blocked(out.blockers.join(' '));
  if (out.version !== flags.version) throw new Blocked('The booking changed since the preview. Preview again and show the user.');
  const status = action === 'cancel' ? 'Cancelled' : 'Confirmed';
  const data = { id: String(plan.eventId), status };
  if (action === 'cancel' && plan.reason) data.cancelReason = String(plan.reason).slice(0, 500);
  await call(client, 'PATCH', '/v2/calendarevent/changestatus', { data, confirmed: true, reachesPeople: true });
  const after = await readEvent(client, plan.eventId);
  const problems = after.status === status ? [] : [`Status is ${after.status}, expected ${status}.`];
  return { saved: problems.length === 0, event: eventSummary(after), problems };
}

async function planReschedule(client, plan) {
  if (!START_RE.test(String(plan.start || ''))) throw new UsageError('start must be "YYYY-MM-DD HH:mm" (wall clock in timeZone).');
  const { event, calendar, blockers } = await loadEventForChange(client, plan.eventId);
  if (event.status === 'Cancelled') blockers.push('A cancelled booking cannot be rescheduled: book a new one.');
  const d = deadlineCheck(event, calendar);
  if (d.passed) blockers.push(`The calendar's cancellation deadline passed on ${d.deadline}: rescheduling is refused too.`);
  const minutes = moment(event.endDate).diff(moment(event.startDate), 'minutes');
  let slot = { reasons: [], startUtc: null };
  if (calendar) {
    slot = await checkSlot(client, {
      calendarId: calendar._id, start: plan.start, timeZone: plan.timeZone || event.timeZone, duration: minutes,
      userGroupId: idOf(event.userGroupId) || undefined, itemStockId: idOf(event.itemStock) || undefined, excludeEventId: event._id,
      productId: idOf(event.product) || undefined,
    });
    // The server's availability still counts the booking being moved; a clash with itself is not one.
    const overlapsSelf = moment(slot.startUtc).isBefore(event.endDate) && moment(slot.endUtc).isAfter(event.startDate);
    slot.reasons.filter((x) => !(overlapsSelf && /already taken/.test(x))).forEach((x) => blockers.push(x));
  }
  const r = await changeRecipients(client, event);
  return {
    event: eventSummary(event),
    newStart: `${plan.start} (${plan.timeZone || event.timeZone})`,
    newStartUtc: slot.startUtc,
    outcome: event.status === 'Confirmed' ? 'A new booking is created and confirmed, then the old one is cancelled.' : 'A new Tentative booking is created and the old one is cancelled.',
    recipients: {
      newInvitationTo: r.guests,
      acceptOrRejectEmailTo: r.responsible,
      cancellationOfOldBookingTo: r.syncedExternally ? 'the provider notifies the guests' : [...r.guests, ...(r.responsible ? [r.responsible] : [])],
    },
    blockers,
    version: String(event.updatedAt),
  };
}

async function cmdReschedulePreview(client, [planArg], flags, ctx) {
  const out = await planReschedule(client, readPlan(planArg, ctx.rootDir));
  return {
    ...out,
    nextStep: out.blockers.length
      ? 'Blocked: tell the user why and offer another time. Do not cancel and re-book by hand.'
      : `${STOP}Tell the user who is notified. Only after an explicit yes, run reschedule with the same plan, --version ${out.version} --confirmed --reaches-people.`,
  };
}

async function cmdReschedule(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run reschedule-preview first.');
  if (!flags.confirmed || !flags.reachesPeople) throw new UsageError('reschedule notifies people: it needs --confirmed and --reaches-people after the user\'s yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const out = await planReschedule(client, plan);
  if (out.blockers.length) throw new Blocked(out.blockers.join(' '));
  if (out.version !== flags.version) throw new Blocked('The booking changed since the preview. Preview again and show the user.');
  const data = { id: String(plan.eventId), startDate: plan.start, timeZone: plan.timeZone || undefined, reason: plan.reason ? String(plan.reason).slice(0, 500) : undefined };
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
  const created = await call(client, 'POST', '/v2/calendarevent/reschedule', { data, confirmed: true, reachesPeople: true });
  const [next, old] = await Promise.all([readEvent(client, created._id), readEvent(client, plan.eventId)]);
  const problems = [];
  if (idOf(next.rescheduledFrom) !== String(plan.eventId)) problems.push('The new booking does not point to the old one.');
  if (old.status !== 'Cancelled') problems.push(`The old booking is ${old.status}, expected Cancelled.`);
  if (Math.abs(Date.parse(next.startDate) - Date.parse(out.newStartUtc)) > 60000) problems.push(`New start ${next.startDate} differs from ${out.newStartUtc}.`);
  return { saved: problems.length === 0, newEvent: eventSummary(next), oldEvent: eventSummary(old), problems };
}

async function cmdEvents(client, [calendarId], flags) {
  if (!calendarId) throw new UsageError('Usage: events <domain> <calendarId> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--email <guest e-mail>]');
  const cal = await getOne(client, 'calendar', calendarId, 'timeZone calendarName');
  const range = parseRangeFlags(flags, cal.timeZone);
  const xquery = {
    calendar: calendarId,
    $and: [{ startDate: { $gte: moment.tz(range.from, cal.timeZone).toISOString() } }, { startDate: { $lt: moment.tz(range.to, cal.timeZone).add(1, 'day').toISOString() } }],
  };
  if (flags.email) {
    const escaped = String(flags.email).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const att = await list(client, 'attendee', { email: { $regex: `(?i)^${escaped}$` } }, '_id', 200);
    xquery.attendees = { $in: att.data.map((a) => a._id) };
  }
  const { data, count } = await list(client, 'calendarevent', xquery, 'title status startDate endDate timeZone attendees assignee rescheduledFrom cancelReason deal lineItemUuid', 200);
  const attIds = [...new Set(data.flatMap((e) => (e.attendees || []).map(idOf)))];
  const atts = attIds.length ? (await list(client, 'attendee', { _id: { $in: attIds } }, 'email', 500)).data : [];
  const emailOf = Object.fromEntries(atts.map((a) => [String(a._id), a.email]));
  return {
    calendar: { _id: calendarId, calendarName: cal.calendarName, timeZone: cal.timeZone },
    count,
    events: data.map((e) => ({
      ...eventSummary({ ...e, attendees: (e.attendees || []).map((a) => ({ email: emailOf[idOf(a)] })) }),
      local: moment(e.startDate).tz(cal.timeZone).format('YYYY-MM-DD HH:mm'),
      fromQuote: !!e.lineItemUuid,
    })),
  };
}

// ── Diagnosis of a deal's quote bookings ─────────────────────────────────────────────────────────

async function cmdDealBookings(client, [dealArg]) {
  if (!dealArg) throw new UsageError('Usage: deal-bookings <domain> <dealId | part of the deal name>');
  let dealId = dealArg;
  if (!ID_RE.test(String(dealArg))) {
    const escaped = String(dealArg).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = (await list(client, 'deal', { dealName: { $regex: `(?i)${escaped}` } }, 'dealName', 10)).data;
    if (found.length !== 1) {
      return { matches: found.map((d) => ({ _id: d._id, dealName: d.dealName })), blockers: [found.length ? 'Several deals match: ask which one.' : 'No deal matches that name.'] };
    }
    dealId = found[0]._id;
  }
  const deal = await getOne(client, 'deal', dealId, 'dealName stage proposal.enabled proposal.quote.lineItems.uuid proposal.quote.lineItems.productName '
    + 'proposal.quote.lineItems.product proposal.quote.lineItems.itemStock proposal.quote.lineItems.calendarEvents proposal.quote.lineItems.startDate proposal.quote.lineItems.endDate');
  const lines = ((deal.proposal && deal.proposal.quote && deal.proposal.quote.lineItems) || []).filter((l) => (l.itemStock || []).length || (l.calendarEvents || []).length);
  const { data: events } = await list(client, 'calendarevent', { deal: dealId }, 'title status startDate endDate product itemStock calendar lineItemUuid attendees', 500);
  const productIds = [...new Set([...lines.map((l) => idOf(l.product)), ...events.map((e) => idOf(e.product))].filter(Boolean))];
  const products = productIds.length ? (await list(client, 'product', { _id: { $in: productIds } }, 'productName itemStock calendar', 200)).data : [];
  const productById = Object.fromEntries(products.map((p) => [String(p._id), p]));
  const unitIds = [...new Set([...lines.flatMap((l) => (l.itemStock || []).map(idOf)), ...events.map((e) => idOf(e.itemStock))].filter(Boolean))];
  const units = unitIds.length ? (await list(client, 'itemstock', { _id: { $in: unitIds } }, 'name active', 200)).data : [];
  const unitName = Object.fromEntries(units.map((u) => [String(u._id), u.name]));
  const sharing = unitIds.length ? (await list(client, 'product', { itemStock: { $in: unitIds } }, 'productName calendar itemStock', 200)).data : [];
  const findings = [];
  const lineUuids = new Set(lines.map((l) => l.uuid));
  const referenced = new Set(lines.flatMap((l) => (l.calendarEvents || []).map(String)));
  const report = lines.map((l) => {
    const product = productById[idOf(l.product)] || {};
    const own = new Set((product.itemStock || []).map(idOf));
    const lineEvents = events.filter((e) => e.lineItemUuid === l.uuid);
    const notOwn = (l.itemStock || []).map(idOf).filter((u) => !own.has(u));
    if (notOwn.length) findings.push(`Line "${l.productName}" books units that are not the product's: ${notOwn.map((u) => unitName[u] || u).join(', ')} (the deal save does not check it).`);
    if ((l.itemStock || []).length && !(l.calendarEvents || []).length) findings.push(`Line "${l.productName}" has units but no saved bookings: every save of the deal creates new ones.`);
    if ((l.calendarEvents || []).length && (l.calendarEvents || []).length !== (l.itemStock || []).length) {
      findings.push(`Line "${l.productName}" has ${(l.itemStock || []).length} unit(s) and ${(l.calendarEvents || []).length} booking(s): bookings are matched to units by position.`);
    }
    return {
      uuid: l.uuid, productName: l.productName, startDate: l.startDate, endDate: l.endDate,
      units: (l.itemStock || []).map((u) => ({ _id: idOf(u), name: unitName[idOf(u)] || null })),
      bookings: (l.calendarEvents || []).map(String),
      bookingsWithThisLine: lineEvents.map((e) => ({ _id: e._id, status: e.status, unit: unitName[idOf(e.itemStock)] || idOf(e.itemStock), linked: referenced.has(String(e._id)) })),
    };
  });
  const orphans = events.filter((e) => e.lineItemUuid && !lineUuids.has(e.lineItemUuid));
  if (orphans.length) findings.push(`${orphans.length} booking(s) belong to quote lines that no longer exist (removing a line does not cancel its bookings); they still hold their units if Confirmed.`);
  const unlinked = events.filter((e) => e.lineItemUuid && lineUuids.has(e.lineItemUuid) && !referenced.has(String(e._id)));
  if (unlinked.length) findings.push(`${unlinked.length} booking(s) point to a current line that no longer lists them (duplicates from saves that did not send back the bookings).`);
  for (const u of unitIds) {
    const owners = sharing.filter((p) => (p.itemStock || []).map(idOf).includes(u));
    const cals = new Set(owners.map((p) => idOf(p.calendar)).filter(Boolean));
    if (cals.size > 1) findings.push(`Unit ${unitName[u] || u} is in ${owners.length} products with ${cals.size} different calendars: bookings in one calendar do not block the other.`);
  }
  const byStatus = events.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }), {});
  return {
    deal: { _id: deal._id, dealName: deal.dealName, stage: idOf(deal.stage), proposalEnabled: !!(deal.proposal && deal.proposal.enabled) },
    statusRule: 'Each save of the deal sets every booking of its lines from the stage: approved = Confirmed, denied = Cancelled, any other stage = Tentative (Tentative blocks nobody).',
    bookingsByStatus: byStatus,
    lines: report,
    orphanBookings: orphans.map((e) => ({ _id: e._id, title: e.title, status: e.status, unit: unitName[idOf(e.itemStock)] || idOf(e.itemStock), lineItemUuid: e.lineItemUuid })),
    findings,
    nextStep: 'Read-only diagnosis. Fix reserved lines with prolibu-quotes or in the app. Orphan bookings can be cancelled one by one with cancel-preview / cancel '
      + '(they have no guests or responsible, so nobody is e-mailed); never delete them.',
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const USAGE = `Usage: calendar.js <command> <domain> …
  calendars        <domain> [part of the name]
  show             <domain> <calendarId>
  availability     <domain> <calendarId> [--from D] [--to D] [--tz Z] [--group id] [--duration min] [--product id [--unit id]]
  events           <domain> <calendarId> [--from D] [--to D] [--email guest]
  deal-bookings    <domain> <dealId>
  setup-preview    <domain> '<plan>'          setup-apply <domain> '<plan>' --version v --confirmed
  book-preview     <domain> '<plan>'          book        <domain> '<plan>' --version v --confirmed --reaches-people
  reschedule-preview <domain> '<plan>'        reschedule  <domain> '<plan>' --version v --confirmed --reaches-people
  cancel-preview   <domain> '<plan>'          cancel      <domain> '<plan>' --version v --confirmed --reaches-people
  confirm-preview  <domain> '<plan>'          confirm     <domain> '<plan>' --version v --confirmed --reaches-people`;

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = ['version', 'profile', 'from', 'to', 'tz', 'group', 'duration', 'product', 'unit', 'email'];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (arg.startsWith('--') && valued.includes(arg.slice(2))) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[arg.slice(2)] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (flags.duration !== undefined && !DURATIONS.includes(Number(flags.duration))) throw new UsageError('--duration must be one of the calendar durations (minutes).');
  for (const f of ['group', 'product', 'unit']) {
    if (flags[f] !== undefined && !ID_RE.test(flags[f])) throw new UsageError(`--${f} must be 24 hex characters.`);
  }
  if (flags.tz !== undefined && !isTz(flags.tz)) throw new UsageError(`--tz "${flags.tz}" is not a valid time zone.`);
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  calendars: cmdCalendars,
  show: cmdShow,
  availability: cmdAvailability,
  events: cmdEvents,
  'deal-bookings': cmdDealBookings,
  'setup-preview': cmdSetupPreview,
  'setup-apply': cmdSetupApply,
  'book-preview': cmdBookPreview,
  book: cmdBook,
  'reschedule-preview': cmdReschedulePreview,
  reschedule: cmdReschedule,
  'cancel-preview': (...a) => cmdStatusPreview('cancel', ...a),
  cancel: (...a) => cmdStatusApply('cancel', ...a),
  'confirm-preview': (...a) => cmdStatusPreview('confirm', ...a),
  confirm: (...a) => cmdStatusApply('confirm', ...a),
};
const WRITES = ['setup-apply', 'book', 'reschedule', 'cancel', 'confirm'];

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can grant the permission.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(USAGE);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (WRITES.includes(command) && !result.saved) return 1;
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
    if (err && err.status === 403) {
      stderr.write(`FORBIDDEN: ${hide(err.message)}\n${FORBIDDEN_HINT}\n`);
      return 1;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, checkSlot, checkSetupPlan, validateRules, bookingRejections, lintCalendar, checkBookPlan,
};
