/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const moment = require('moment-timezone');
const cal = require('../.claude/skills/prolibu-calendars/scripts/calendar');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const TZ = 'America/Bogota';
const USER = 'a'.repeat(24);
const OTHER_USER = 'b'.repeat(24);
const CAL = 'c'.repeat(24);
const POLICY = 'd'.repeat(24);
const EXC = 'e'.repeat(24);
const EVENT = 'f'.repeat(24);
const DEAL = '1'.repeat(24);
const PRODUCT = '2'.repeat(24);
const UNIT = '3'.repeat(24);
const FOREIGN_UNIT = '4'.repeat(24);
const ATT = '5'.repeat(24);
const DAY = moment.tz(TZ).add(10, 'days').format('YYYY-MM-DD');
const HOLIDAY = moment.tz(TZ).add(11, 'days').format('YYYY-MM-DD');

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let state;
let seq;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : String(v));
const utc = (day, hhmm) => moment.tz(`${day} ${hhmm}`, 'YYYY-MM-DD HH:mm', TZ).toISOString();

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    if (k === '$and') return true;
    const field = record[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.$in) return [].concat(field || []).some((f) => v.$in.map(String).includes(idOf(f)));
      if (v.$ne !== undefined) return field !== v.$ne;
      if (v.$regex) return true;
      return true;
    }
    if (Array.isArray(field)) return field.map(idOf).includes(String(v));
    return idOf(field) === String(v);
  });
}

const COLLECTIONS = ['calendar', 'calendarpolicy', 'calendarexception', 'usergroup', 'itemstock', 'product', 'calendarevent', 'attendee', 'user', 'deal'];

function slotsFor(day) {
  // The server offers the policy hours; it ignores exceptions and other assignees' bookings.
  return ['09:00', '09:30', '10:00'].map((start) => ({
    start,
    end: moment(start, 'HH:mm').add(30, 'minutes').format('HH:mm'),
    dateTimeStart: `${day}T${start}:00Z`,
    dateTimeEnd: `${day}T${moment(start, 'HH:mm').add(30, 'minutes').format('HH:mm')}:00Z`,
    availability: !(state.takenStarts || []).includes(`${day} ${start}`),
  }));
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const parts = u.pathname.split('/').filter(Boolean); // ['v2', object, id?]
  const [, object, id] = parts;
  if (u.pathname === '/v2/user/me') return respond(200, { profile: { _id: USER, email: 'owner@example.com', apiKey: KEY } });
  if (init.method === 'GET' && object === 'calendar' && id === 'getavailability') {
    const from = u.searchParams.get('startDate');
    const to = u.searchParams.get('endDate');
    const days = [];
    for (let d = moment(from); d.isSameOrBefore(to); d.add(1, 'day')) days.push({ date: d.format('YYYY-MM-DD'), slots: slotsFor(d.format('YYYY-MM-DD')) });
    return respond(200, { days, timeZone: TZ });
  }
  if (init.method === 'POST' && u.pathname === '/v2/calendar/scheduleevent') {
    const c = state.calendar.find((x) => x._id === body.idCalendar);
    const ev = {
      _id: `${'9'.repeat(20)}${String(seq += 1).padStart(4, '0')}`, calendar: body.idCalendar, title: body.title,
      status: c.requireConfirmation ? 'Tentative' : body.status, startDate: utc(...body.startDate.split(' ')),
      endDate: moment(utc(...body.startDate.split(' '))).add(30, 'minutes').toISOString(), timeZone: TZ,
      attendees: [{ _id: ATT, email: body.attendees[0] }], assignee: USER, createdAt: new Date().toISOString(), updatedAt: 'U1',
    };
    state.calendarevent.push(ev);
    return respond(200, ev);
  }
  if (init.method === 'PATCH' && u.pathname === '/v2/calendarevent/changestatus') {
    const ev = state.calendarevent.find((x) => x._id === body.id);
    ev.status = body.status;
    ev.updatedAt = 'U2';
    return respond(200, { ok: 1 });
  }
  if (init.method === 'POST' && u.pathname === '/v2/calendarevent/reschedule') {
    const old = state.calendarevent.find((x) => x._id === body.id);
    const ev = { ...old, _id: '8'.repeat(24), rescheduledFrom: old._id, startDate: utc(...body.startDate.split(' ')), endDate: moment(utc(...body.startDate.split(' '))).add(30, 'minutes').toISOString() };
    old.status = 'Cancelled';
    state.calendarevent.push(ev);
    return respond(200, ev);
  }
  if (!COLLECTIONS.includes(object)) return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
  const coll = state[object] = state[object] || [];
  if (init.method === 'GET' && id) {
    const rec = coll.find((x) => x._id === id);
    return rec ? respond(200, rec) : respond(404, { error: 'Not found' });
  }
  if (init.method === 'GET') {
    const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const data = coll.filter((r) => matches(r, xq));
    return respond(200, { data, pagination: { count: data.length } });
  }
  if (init.method === 'POST' && !id) {
    const rec = { _id: `${'7'.repeat(20)}${String(seq += 1).padStart(4, '0')}`, ...body, createdBy: USER, updatedAt: 'N1' };
    coll.push(rec);
    return respond(200, rec);
  }
  if (init.method === 'PATCH' && id) {
    const rec = coll.find((x) => x._id === id);
    Object.assign(rec, body, { updatedAt: 'N2' });
    return respond(200, rec);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => cal.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-tmp-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  out = '';
  err = '';
  calls = [];
  seq = 0;
  state = {
    calendar: [{
      _id: CAL, calendarName: 'Advice', type: 'oneOnOne', eventDuration: 30, startTimeIncrements: 30, timeZone: TZ, policies: [POLICY],
      calendarExceptions: [EXC], userGroups: [], createdBy: USER, assignee: USER, externalSyncEnabled: false, inviteesLimit: 2,
      slotCapacity: 1, updatedAt: 'C1',
    }],
    calendarpolicy: [{ _id: POLICY, calendarPolicyName: 'Hours', rules: [{ type: 'wday', wday: 1, from: '09:00', to: '12:00' }], updatedAt: 'P1' }],
    calendarexception: [{ _id: EXC, calendarExceptionsName: 'Holiday', dates: [`${HOLIDAY}T00:00:00.000Z`], updatedAt: 'E1' }],
    usergroup: [],
    user: [{ _id: USER, email: 'owner@example.com', firstName: 'Owner', active: true }, { _id: OTHER_USER, email: 'other@example.com', active: true }],
    calendarevent: [],
    attendee: [],
    product: [],
    itemstock: [],
    deal: [],
  };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('policy rules', () => {
  test('rejects text weekdays, accepts integers 0-6', () => {
    const problems = [];
    cal.validateRules([{ type: 'wday', wday: 'monday', from: '08:00', to: '12:00' }], problems);
    expect(problems.join(' ')).toMatch(/integer 0-6/);
    const ok = [];
    cal.validateRules([{ wday: 0, from: '08:00', to: '12:00' }, { wday: 6, from: '14:00', to: '18:00' }], ok);
    expect(ok).toEqual([]);
  });

  test('rejects from >= to, overlaps on a day, and empty rules', () => {
    const p = [];
    cal.validateRules([{ wday: 1, from: '12:00', to: '08:00' }], p);
    cal.validateRules([{ wday: 2, from: '08:00', to: '12:00' }, { wday: 2, from: '11:00', to: '13:00' }], p);
    cal.validateRules([], p);
    expect(p.join(' ')).toMatch(/must be before/);
    expect(p.join(' ')).toMatch(/overlaps/);
    expect(p.join(' ')).toMatch(/non-empty/);
  });
});

describe('setup', () => {
  const newCalendarPlan = (extra = {}) => JSON.stringify({
    items: [
      { kind: 'policy', ref: 'h', set: { calendarPolicyName: 'QA', rules: [{ wday: 1, from: '08:00', to: '12:00' }] } },
      { kind: 'exception', ref: 'x', set: { calendarExceptionsName: 'QA off', dates: ['2026-12-24'] } },
      {
        kind: 'calendar',
        set: {
          calendarName: 'QA cal', eventDuration: 30, timeZone: TZ, policies: ['@h'], calendarExceptions: ['@x'], externalSyncEnabled: false, ...extra,
        },
      },
    ],
  });

  test('a text weekday blocks the preview and nothing is written', async () => {
    const plan = JSON.stringify({ items: [{ kind: 'policy', set: { calendarPolicyName: 'Bad', rules: [{ wday: 'monday', from: '08:00', to: '12:00' }] } }] });
    expect(await run(['setup-preview', D, plan])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/integer 0-6/);
    expect(writes()).toEqual([]);
  });

  test('a new calendar needs an explicit externalSyncEnabled decision', async () => {
    const plan = JSON.parse(newCalendarPlan());
    delete plan.items[2].set.externalSyncEnabled;
    expect(await run(['setup-preview', D, JSON.stringify(plan)])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/externalSyncEnabled/);
  });

  test('refuses fields that do nothing and product links', async () => {
    const plan = JSON.stringify({ items: [{ kind: 'calendar', id: CAL, set: { isPublic: false } }, { kind: 'productLink', set: { calendar: CAL } }] });
    expect(await run(['setup-preview', D, plan])).toBe(3);
    const text = json().blockers.join(' ');
    expect(text).toMatch(/never checked/);
    expect(text).toMatch(/prolibu-catalog/);
  });

  test('active:false only warns that bookings still go through', async () => {
    expect(await run(['setup-preview', D, JSON.stringify({ items: [{ kind: 'calendar', id: CAL, set: { active: false } }] })])).toBe(0);
    expect(json().warnings.join(' ')).toMatch(/does NOT stop bookings/);
  });

  test('apply needs the version and --confirmed, creates in order and resolves refs', async () => {
    const plan = newCalendarPlan();
    expect(await run(['setup-apply', D, plan, '--confirmed'])).toBe(2);
    expect(await run(['setup-apply', D, plan, '--version', 'x'])).toBe(2);
    expect(writes()).toEqual([]);
    await run(['setup-preview', D, plan]);
    const { version } = json();
    out = '';
    expect(await run(['setup-apply', D, plan, '--version', 'stale', '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
    expect(await run(['setup-apply', D, plan, '--version', version, '--confirmed'])).toBe(0);
    const posts = writes().map((c) => c.path);
    expect(posts).toEqual(['/v2/calendarpolicy', '/v2/calendarexception', '/v2/calendar']);
    const calBody = writes()[2].body;
    expect(calBody.policies).toEqual([state.calendarpolicy[1]._id]);
    expect(calBody.calendarExceptions).toEqual([state.calendarexception[1]._id]);
    expect(writes()[0].body.rules[0]).toEqual({ type: 'wday', wday: 1, from: '08:00', to: '12:00' });
    expect(json().saved).toBe(true);
  });

  test('read-back reports a field the server did not keep', async () => {
    const plan = JSON.stringify({ items: [{ kind: 'calendar', id: CAL, set: { dailyLimit: 4 } }] });
    await run(['setup-preview', D, plan]);
    const { version } = json();
    out = '';
    const original = fakeFetch;
    const dropping = async (url, init) => {
      const res = await original(url, init);
      if (init.method === 'PATCH') state.calendar[0].dailyLimit = undefined;
      return res;
    };
    const code = await cal.main(['setup-apply', D, plan, '--version', version, '--confirmed'], {
      rootDir, fetchImpl: dropping, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    });
    expect(code).toBe(1);
    expect(json().problems.join(' ')).toMatch(/dailyLimit did not save/);
  });
});

describe('availability cross-check', () => {
  test('marks exception days and other assignees\' Confirmed bookings the server shows as free', async () => {
    state.calendarevent.push({
      _id: EVENT, calendar: CAL, status: 'Confirmed', title: 'Busy', assignee: OTHER_USER,
      startDate: utc(DAY, '09:00'), endDate: utc(DAY, '09:30'), seatsTaken: 1,
    });
    expect(await run(['availability', D, CAL, '--from', DAY, '--to', HOLIDAY])).toBe(0);
    const [day, holiday] = json().days;
    expect(day.freeStarts).toEqual(['09:30-10:00 every 30 min']);
    expect(day.rejectedByBooking[0]).toEqual(expect.objectContaining({ starts: ['09:00'] }));
    expect(day.rejectedByBooking[0].reason).toMatch(/Confirmed booking/);
    expect(holiday.freeStarts).toEqual([]);
    expect(holiday.rejectedByBooking[0].reason).toMatch(/exception "Holiday"/);
  });

  test('never calls myAvailability (it creates a calendar)', async () => {
    await run(['availability', D, CAL, '--from', DAY, '--to', DAY]);
    await run(['show', D, CAL]);
    expect(calls.some((c) => /myavailability/i.test(c.path))).toBe(false);
  });

  test('daily limit counts Tentative bookings too', () => {
    const calendar = { ...state.calendar[0], dailyLimit: 1 };
    const events = [{ _id: 'x', calendar: CAL, status: 'Tentative', startDate: utc(DAY, '15:00'), endDate: utc(DAY, '15:30') }];
    const reasons = cal.bookingRejections({ calendar, exceptions: [], events }, moment(utc(DAY, '09:00')), moment(utc(DAY, '09:30')));
    expect(reasons.join(' ')).toMatch(/Daily limit exceeded/);
  });

  test('unit blocks, inactive units and units of another product are rejected', () => {
    const calendar = state.calendar[0];
    const units = [{ _id: UNIT, name: 'Room 1', active: true, blocks: [{ from: utc(DAY, '08:00'), to: utc(DAY, '12:00'), reason: 'Paint' }] }];
    const s = moment(utc(DAY, '09:00'));
    const e = moment(utc(DAY, '09:30'));
    expect(cal.bookingRejections({ calendar, exceptions: [], events: [], units }, s, e, { itemStock: UNIT }).join(' ')).toMatch(/blocked \(Paint\)/);
    expect(cal.bookingRejections({ calendar, exceptions: [], events: [], units }, s, e, { itemStock: FOREIGN_UNIT }).join(' ')).toMatch(/does not belong/);
  });
});

describe('booking', () => {
  const plan = (extra = {}) => JSON.stringify({
    calendarId: CAL, start: `${DAY} 09:00`, timeZone: TZ, name: 'Ana', email: 'ana@example.com', ...extra,
  });

  test('preview lists recipients and writes nothing', async () => {
    expect(await run(['book-preview', D, plan()])).toBe(0);
    const p = json();
    expect(p.recipients.invitationEmailTo).toEqual(['ana@example.com']);
    expect(p.recipients.acceptOrRejectEmailTo).toEqual(['owner@example.com']);
    expect(p.summary.outcome).toBe('Confirmed');
    expect(p.nextStep).toMatch(/STOP HERE/);
    expect(writes()).toEqual([]);
  });

  test('a calendar that requires confirmation is booked Tentative even with an admin key', async () => {
    state.calendar[0].requireConfirmation = true;
    await run(['book-preview', D, plan()]);
    expect(json().summary.outcome).toBe('Tentative');
  });

  test('refuses contact, reminders and status', async () => {
    expect(await run(['book-preview', D, plan({ contact: USER })])).toBe(2);
    expect(err).toMatch(/Never send "contact"/);
    expect(await run(['book-preview', D, plan({ reminders: [{ minutesBefore: 10 }] })])).toBe(2);
    expect(await run(['book-preview', D, plan({ status: 'Confirmed' })])).toBe(2);
    expect(calls).toEqual([]);
  });

  test('a slot on an exception day is blocked', async () => {
    expect(await run(['book-preview', D, plan({ start: `${HOLIDAY} 09:00` })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/exception/);
  });

  test('too many guests is blocked', async () => {
    expect(await run(['book-preview', D, plan({ attendees: ['b@example.com', 'c@example.com'] })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/Invitees limit/);
  });

  test('book needs --reaches-people and uses the booking route with the field names the server reads', async () => {
    await run(['book-preview', D, plan()]);
    const { version } = json();
    out = '';
    expect(await run(['book', D, plan(), '--version', version, '--confirmed'])).toBe(2);
    expect(writes()).toEqual([]);
    expect(await run(['book', D, plan(), '--version', version, '--confirmed', '--reaches-people'])).toBe(0);
    const [post] = writes();
    expect(post.method).toBe('POST');
    expect(post.path).toBe('/v2/calendar/scheduleevent');
    expect(post.body).toEqual(expect.objectContaining({
      idCalendar: CAL, startDate: `${DAY} 09:00`, timeZone: TZ, attendees: ['ana@example.com'], creator: 'ana@example.com', creatorFullName: 'Ana',
    }));
    expect(post.body.idempotencyKey).toMatch(/^skill-/);
    expect(post.body).not.toHaveProperty('dateTime');
    expect(post.body).not.toHaveProperty('invitees');
    expect(post.body).not.toHaveProperty('contact');
    expect(json().saved).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v2/calendarevent')).toBe(false);
  });

  test('a stale version is refused', async () => {
    expect(await run(['book', D, plan(), '--version', 'old', '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('cancel, confirm, reschedule', () => {
  const addEvent = (extra = {}) => {
    state.calendarevent.push({
      _id: EVENT, calendar: CAL, status: 'Confirmed', title: 'Ana', assignee: USER, timeZone: TZ,
      startDate: utc(DAY, '09:00'), endDate: utc(DAY, '09:30'), attendees: [{ _id: ATT, email: 'ana@example.com' }], updatedAt: 'V1', ...extra,
    });
  };

  test('cancel goes through changeStatus, never DELETE or PATCH of the record', async () => {
    addEvent();
    const plan = JSON.stringify({ eventId: EVENT, reason: 'Client asked' });
    expect(await run(['cancel-preview', D, plan])).toBe(0);
    expect(json().recipients.cancellationEmailTo).toEqual(['ana@example.com', 'owner@example.com']);
    out = '';
    expect(await run(['cancel', D, plan, '--version', 'V1', '--confirmed', '--reaches-people'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: '/v2/calendarevent/changestatus', body: { id: EVENT, status: 'Cancelled', cancelReason: 'Client asked' } })]);
    expect(state.calendarevent[0].status).toBe('Cancelled');
  });

  test('a passed cancellation deadline blocks cancel and reschedule', async () => {
    const soon = moment().add(1, 'hour');
    addEvent({ startDate: soon.toISOString(), endDate: soon.clone().add(30, 'minutes').toISOString() });
    state.calendar[0].cancellationDeadline = { deadlineType: 'hours', deadlineValue: 2 };
    expect(await run(['cancel-preview', D, JSON.stringify({ eventId: EVENT })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/Cancellation deadline exceeded/);
    expect(await run(['cancel', D, JSON.stringify({ eventId: EVENT }), '--version', 'V1', '--confirmed', '--reaches-people'])).toBe(3);
    out = '';
    expect(await run(['reschedule-preview', D, JSON.stringify({ eventId: EVENT, start: `${DAY} 10:00` })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/deadline passed/);
    expect(writes()).toEqual([]);
  });

  test('a booking listed on a deal\'s quote line is not changed here; an orphan can be cancelled', async () => {
    addEvent({ deal: DEAL, lineItemUuid: 'line-1', attendees: [] });
    state.deal.push({ _id: DEAL, proposal: { quote: { lineItems: [{ uuid: 'line-1', calendarEvents: [EVENT] }] } } });
    expect(await run(['cancel-preview', D, JSON.stringify({ eventId: EVENT })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/prolibu-quotes/);
    state.deal[0].proposal.quote.lineItems = [];
    out = '';
    expect(await run(['cancel-preview', D, JSON.stringify({ eventId: EVENT })])).toBe(0);
  });

  test('confirm refuses a booking that is not Tentative', async () => {
    addEvent({ status: 'Confirmed' });
    expect(await run(['confirm-preview', D, JSON.stringify({ eventId: EVENT })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/Only a Tentative booking/);
  });

  test('confirm only takes a Tentative booking and refuses an overlap', async () => {
    addEvent({ status: 'Tentative' });
    state.calendarevent.push({ _id: '6'.repeat(24), calendar: CAL, status: 'Confirmed', title: 'Other', startDate: utc(DAY, '09:00'), endDate: utc(DAY, '09:30') });
    expect(await run(['confirm-preview', D, JSON.stringify({ eventId: EVENT })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/overlap/);
    state.calendarevent.pop();
    out = '';
    expect(await run(['confirm', D, JSON.stringify({ eventId: EVENT }), '--version', 'V1', '--confirmed', '--reaches-people'])).toBe(0);
    expect(writes()[0].body).toEqual({ id: EVENT, status: 'Confirmed' });
  });

  test('reschedule uses the reschedule route and checks the old booking is cancelled', async () => {
    addEvent();
    const plan = JSON.stringify({ eventId: EVENT, start: `${DAY} 10:00` });
    expect(await run(['reschedule-preview', D, plan])).toBe(0);
    expect(json().recipients.newInvitationTo).toEqual(['ana@example.com']);
    out = '';
    expect(await run(['reschedule', D, plan, '--version', 'V1', '--confirmed', '--reaches-people'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/v2/calendarevent/reschedule', body: { id: EVENT, startDate: `${DAY} 10:00` } })]);
    expect(json().oldEvent.status).toBe('Cancelled');
    expect(json().newEvent.rescheduledFrom).toBe(EVENT);
  });
});

describe('deal bookings', () => {
  test('finds orphans, units of another product and units shared across calendars', async () => {
    state.product.push({ _id: PRODUCT, productName: 'Room', itemStock: [UNIT], calendar: CAL });
    state.product.push({ _id: '0'.repeat(24), productName: 'Room B', itemStock: [UNIT], calendar: '9'.repeat(24) });
    state.itemstock.push({ _id: UNIT, name: 'R1' }, { _id: FOREIGN_UNIT, name: 'R2' });
    state.deal.push({
      _id: DEAL, dealName: 'D', stage: 'st',
      proposal: { enabled: true, quote: { lineItems: [{ uuid: 'l1', productName: 'Room', product: PRODUCT, itemStock: [UNIT, FOREIGN_UNIT], calendarEvents: [EVENT] }] } },
    });
    state.calendarevent.push(
      { _id: EVENT, deal: DEAL, lineItemUuid: 'l1', status: 'Tentative', itemStock: UNIT, product: PRODUCT },
      { _id: '6'.repeat(24), deal: DEAL, lineItemUuid: 'gone', status: 'Confirmed', itemStock: UNIT, product: PRODUCT },
    );
    expect(await run(['deal-bookings', D, 'D'])).toBe(0);
    expect(calls.some((c) => c.path === '/v2/deal' && /dealName/.test(c.query.xquery))).toBe(true);
    const r = json();
    const text = r.findings.join(' ');
    expect(text).toMatch(/not the product's: R2/);
    expect(text).toMatch(/no longer exist/);
    expect(text).toMatch(/2 different calendars/);
    expect(text).toMatch(/matched to units by position/);
    expect(r.orphanBookings).toHaveLength(1);
    expect(writes()).toEqual([]);
  });
});

describe('safety', () => {
  test('the API key never reaches the output, even when the server returns it', async () => {
    state.calendar[0].calendarName = `Leak ${KEY}`;
    await run(['show', D, CAL]);
    expect(out).not.toContain(KEY);
    expect(out).toContain('***');
  });

  test('plan files must be in a temp folder', async () => {
    const inside = path.join(rootDir, 'plan.json');
    fs.writeFileSync(inside, '{"items":[]}');
    expect(await run(['setup-preview', D, inside])).toBe(2);
    const ok = path.join(tmpDir, 'plan.json');
    fs.writeFileSync(ok, JSON.stringify({ items: [{ kind: 'calendar', id: CAL, set: { dailyLimit: 2 } }] }));
    expect(await run(['setup-preview', D, ok])).toBe(0);
  });

  test('unknown options and bad ids are usage errors', async () => {
    expect(await run(['availability', D, CAL, '--force'])).toBe(2);
    expect(await run(['availability', D, CAL, '--group', 'nope'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('--profile and 403', () => {
  test('--profile reads profile.<name>.json, and a 403 stops at once with a clear message', async () => {
    const SELLER_KEY = 'seller-key-not-the-admin-one';
    fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
    const seen = [];
    let stdout = '';
    let stderr = '';
    const code = await cal.main(['show', D, 'a'.repeat(24), '--profile', 'seller'], {
      rootDir,
      fetchImpl: async (url, init) => {
        seen.push({ path: new URL(url).pathname, auth: init.headers.Authorization });
        return { status: 403, text: async () => JSON.stringify({ statusCode: 403, error: 'Prohibido' }) };
      },
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^FORBIDDEN: .*403: Prohibido/);
    expect(stderr).toContain('did not retry it or try another profile');
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${SELLER_KEY}`);
    expect(stdout + stderr).not.toContain(SELLER_KEY);
  });
});
