/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const activity = require('../.claude/skills/prolibu-activities/scripts/activity');

const D = 'dev99.example.com';
const ME = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const CONTACT = 'c'.repeat(24);
const DEAL = 'd'.repeat(24);
const COMPANY = 'e'.repeat(24);
const OPEN = '1'.repeat(24);
const CLOSED = '2'.repeat(24);
const HIGH = '3'.repeat(24);
const CONNECTED = '4'.repeat(24);

let rootDir;
let out;
let err;
let calls;
let state;
let nextId;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const ARRAYS = { contact: ['tasks', 'notes', 'meetings', 'calls'], company: ['tasks', 'notes'], deal: ['tasks', 'notes'] };

// A small fake of the endpoints the script uses, shaped after the verified server behavior:
// the child is saved first, then its id is appended to the parent's `<model>s` array (only when
// the parent has that array), and a failure there answers an error without undoing the save.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const [, , col, id] = u.pathname.split('/');
  if (init.method === 'GET' && u.pathname === '/v2/user/me') {
    return respond(200, { profile: { _id: ME, firstName: 'Ana', lastName: 'Test', email: 'ana@example.com', locale: {} } });
  }
  if (init.method === 'GET' && u.pathname === '/v2/user/preferences') return respond(200, { locale: { timeZone: 'America/Bogota' } });
  if (init.method === 'GET' && col === 'stage' && id) return respond(200, state.stages.find((s) => s._id === id) || {});
  if (init.method === 'GET' && col === 'stage') {
    const type = u.searchParams.get('stageType');
    return respond(200, { data: state.stages.filter((s) => !type || s.stageType === type) });
  }
  if (init.method === 'GET' && col === 'stagehistory') return respond(200, { data: state.moves || [] });
  if (init.method === 'GET' && ['contact', 'company', 'deal'].includes(col) && id) {
    const rec = state[col][id];
    if (!rec) return respond(404, { error: 'Not found' });
    if (u.searchParams.get('outputFormat') === 'activity') {
      if (col === 'contact') return respond(200, { ...rec, activity: state.activity || {} });
      return respond(200, { ...rec, contacts: state.companyContacts || [] });
    }
    if (u.searchParams.get('populatePath')) {
      return respond(200, { ...rec, notes: rec.notes.map((n) => state.note[n]), tasks: rec.tasks.map((t) => state.task[t]) });
    }
    return respond(200, rec);
  }
  if (init.method === 'GET' && ['task', 'note', 'meeting', 'call'].includes(col) && id) return respond(200, state[col][id]);
  if (init.method === 'GET' && ['task', 'note', 'meeting', 'call'].includes(col)) {
    const xq = JSON.parse(u.searchParams.get('xquery'));
    return respond(200, { data: Object.values(state[col]).filter((r) => r.origin && r.origin.docId === xq['origin.docId']) });
  }
  if (init.method === 'POST' && ['task', 'note', 'meeting', 'call'].includes(col)) {
    if (state.postStatus && !state.saveDespiteError) return respond(state.postStatus, { statusCode: state.postStatus, error: 'rejected before saving' });
    nextId += 1;
    const childId = String(nextId).padStart(24, 'f');
    const saved = { _id: childId, ...body, createdAt: 'T9', updatedAt: 'T9' };
    if (col === 'task' && body.dates && body.dates.dueReminder) saved.dates = { ...body.dates, dueReminderAt: 'R' };
    state[col][childId] = saved;
    const parentCol = body.origin.modelName.toLowerCase();
    const parent = state[parentCol][body.origin.docId];
    if (state.saveDespiteError) return respond(400, { statusCode: 400, error: 'This deal is in a closed stage and cannot be edited.' });
    if (parent && ARRAYS[parentCol].includes(`${col}s`) && !state.dropLink) {
      parent[`${col}s`] = [childId, ...parent[`${col}s`]];
      parent.updatedAt = 'T2';
    }
    return respond(201, saved);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => activity.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const plan = (p) => JSON.stringify(p);
const posts = () => calls.filter((c) => c.method === 'POST');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-activities-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  nextId = 0;
  state = {
    stages: [
      { _id: OPEN, stageName: 'Open', stageType: 'Deal.stage' },
      { _id: CLOSED, stageName: 'Won', stageType: 'Deal.stage', endFlowStage: true },
      { _id: HIGH, stageName: 'High', stageCode: 'task-priority-high', stageType: 'Task.priority' },
      { _id: CONNECTED, stageName: 'Connected', stageType: 'Call.stage' },
    ],
    contact: {
      [CONTACT]: {
        _id: CONTACT, firstName: 'Lucía', lastName: 'Gómez', updatedAt: 'T1', notes: [], tasks: [], meetings: [], calls: [],
      },
    },
    company: { [COMPANY]: { _id: COMPANY, companyName: 'Acme', updatedAt: 'T1', notes: [], tasks: [] } },
    deal: {
      [DEAL]: {
        _id: DEAL, dealName: 'Acme 2027', stage: OPEN, contact: CONTACT, assignee: OTHER, updatedAt: 'T1', notes: [], tasks: [],
      },
    },
    task: {},
    note: {},
    meeting: {},
    call: {},
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('pure helpers', () => {
  test('plain text becomes escaped HTML paragraphs', () => {
    expect(activity.toHtml('Call <Ana> & co\nnow\n\nThen send it')).toBe('<p>Call &lt;Ana&gt; &amp; co<br>now</p><p>Then send it</p>');
    expect(activity.plainText('<p>a &amp; b</p><p>c</p>')).toBe('a & b c');
  });

  test('dates need an explicit offset; due dates are kept to the minute', () => {
    expect(() => activity.parseDateTime('2026-11-05T09:00', 'dueAt')).toThrow('UTC offset');
    expect(() => activity.parseDateTime('2026-11-05', 'dueAt')).toThrow('UTC offset');
    expect(activity.parseDateTime('2026-11-05T09:00:00-05:00', 'startAt')).toBe('2026-11-05T14:00:00.000Z');
    expect(activity.parseDateTime('2026-11-05T09:00:45-05:00', 'dueAt', { toMinute: true })).toBe('2026-11-05T14:00:00.000Z');
  });

  test('a plan is refused when it carries keys of another activity, a provider, or a bad parent', () => {
    const base = { type: 'note', parent: { model: 'Contact', id: CONTACT }, content: 'x' };
    expect(() => activity.readPlan(plan({ ...base, assignee: 'me' }))).toThrow('does not take');
    expect(() => activity.readPlan(plan({ ...base, type: 'meeting', provider: 'google' }))).toThrow('Calendar invitations');
    expect(() => activity.readPlan(plan({ ...base, type: 'meeting', inviteParticipants: true }))).toThrow('Calendar invitations');
    expect(() => activity.readPlan(plan({ ...base, parent: { model: 'Ticket', id: CONTACT } }))).toThrow('"parent"');
    expect(() => activity.readPlan(plan({ ...base, type: 'email' }))).toThrow('"type"');
  });
});

describe('buildActivity', () => {
  const ctx = (over = {}) => ({
    parent: state.deal[DEAL], parentKey: 'deal', me: { _id: ME, email: 'ana@example.com' }, stages: {}, now: Date.parse('2026-11-01T00:00:00Z'), ...over,
  });
  const p = (over) => activity.readPlan(plan({ type: 'task', parent: { model: 'Deal', id: DEAL }, title: 'Send it', ...over }));

  test('links the activity through origin with the canonical model name', () => {
    const { body } = activity.buildActivity(p({}), ctx());
    expect(body.origin).toEqual({ modelName: 'Deal', docId: DEAL });
    expect(body.title).toBe('<p>Send it</p>');
  });

  test('a start after the due date is refused (the server accepts it)', () => {
    expect(() => activity.buildActivity(p({ startAt: '2026-11-10T09:00:00Z', dueAt: '2026-11-09T09:00:00Z' }), ctx())).toThrow('after');
  });

  test('a reminder needs a due date, and one already past is flagged', () => {
    expect(() => activity.buildActivity(p({ reminder: '1 Hour' }), ctx())).toThrow('needs "dueAt"');
    const past = activity.buildActivity(p({ dueAt: '2026-10-31T10:00:00Z', reminder: '1 day' }), ctx());
    expect(past.body.dates.dueReminder).toBe('1 Day');
    expect(past.warnings.join(' ')).toContain('already passed');
    const future = activity.buildActivity(p({ dueAt: '2026-11-20T10:00:00Z', reminder: '1 hour' }), ctx());
    expect(future.summary.reminderAt).toBe('2026-11-20T09:00:00.000Z');
  });

  test('assignee: "me" and e-mails resolve; an unknown raw id is refused; someone else is notified', () => {
    expect(activity.buildActivity(p({ assignee: 'me' }), ctx()).body.assignee).toBe(ME);
    expect(activity.buildActivity(p({ assignee: 'ANA@example.com' }), ctx()).body.assignee).toBe(ME);
    expect(() => activity.buildActivity(p({ assignee: 'f'.repeat(24) }), ctx())).toThrow('"me" or the user');
    const other = activity.buildActivity(p({ assignee: 'Bo@Example.com' }), ctx());
    expect(other.body.assignee).toBe('bo@example.com');
    expect(other.notifies.join(' ')).toContain('bo@example.com');
    expect(activity.buildActivity(p({}), ctx()).warnings.join(' ')).toContain('Nobody is responsible');
  });

  test('a long title is refused before the server cuts it', () => {
    expect(() => activity.buildActivity(p({ title: 'x'.repeat(250) }), ctx())).toThrow('too long');
  });

  test('stages and priorities resolve by name, code or id', () => {
    const stages = { priority: state.stages.filter((s) => s.stageType === 'Task.priority') };
    expect(activity.buildActivity(p({ priority: 'high' }), ctx({ stages })).body.priority).toBe(HIGH);
    expect(activity.buildActivity(p({ priority: 'task-priority-high' }), ctx({ stages })).body.priority).toBe(HIGH);
    expect(() => activity.buildActivity(p({ priority: 'Urgent' }), ctx({ stages }))).toThrow('not a stage');
  });

  test('meetings and calls are blocked on deals and companies', () => {
    const meeting = activity.readPlan(plan({
      type: 'meeting', parent: { model: 'Deal', id: DEAL }, title: 'Demo', startAt: '2026-11-10T09:00:00Z', endAt: '2026-11-10T10:00:00Z', mode: 'virtual',
    }));
    const built = activity.buildActivity(meeting, ctx());
    expect(built.blockers.join(' ')).toContain(CONTACT);
    const callPlan = activity.readPlan(plan({ type: 'call', parent: { model: 'Company', id: COMPANY }, summary: 'x' }));
    expect(activity.buildActivity(callPlan, ctx({ parent: state.company[COMPANY], parentKey: 'company' })).blockers).toHaveLength(1);
  });

  test('a meeting defaults its assignee like the app and never carries a provider', () => {
    const meeting = activity.readPlan(plan({
      type: 'meeting', parent: { model: 'Contact', id: CONTACT }, title: 'Demo', startAt: '2026-11-10T09:00:00Z', endAt: '2026-11-10T10:00:00Z', mode: 'in-person', address: 'HQ',
    }));
    const built = activity.buildActivity(meeting, ctx({ parent: state.contact[CONTACT], parentKey: 'contact' }));
    expect(built.body.assignee).toBe(ME);
    expect(built.body.attendance).toEqual({ mode: 'In-person', address: 'HQ' });
    expect(built.body).not.toHaveProperty('provider');
    expect(built.body).not.toHaveProperty('attendees');
    const reversed = activity.readPlan(plan({
      type: 'meeting', parent: { model: 'Contact', id: CONTACT }, title: 'Demo', startAt: '2026-11-10T10:00:00Z', endAt: '2026-11-10T09:00:00Z', mode: 'Virtual',
    }));
    expect(() => activity.buildActivity(reversed, ctx({ parent: state.contact[CONTACT], parentKey: 'contact' }))).toThrow('after "startAt"');
  });

  test('a call on a contact carries the contact and the app defaults', () => {
    const c = activity.readPlan(plan({ type: 'call', parent: { model: 'Contact', id: CONTACT }, summary: 'Talked' }));
    const { body } = activity.buildActivity(c, ctx({ parent: state.contact[CONTACT], parentKey: 'contact' }));
    expect(body).toMatchObject({ contact: CONTACT, channel: 'Phone', direction: 'Outbound', summary: '<p>Talked</p>' });
  });

  test('a closed deal is flagged for notes and tasks', () => {
    const built = activity.buildActivity(p({}), ctx({ closedStage: { stageName: 'Won' } }));
    expect(built.warnings.join(' ')).toContain('closed');
    expect(built.blockers).toHaveLength(0);
  });
});

describe('preview and apply', () => {
  const taskPlan = plan({
    type: 'task', parent: { model: 'Deal', id: DEAL }, title: 'Send the proposal', assignee: 'me', dueAt: '2026-12-01T17:00:00-05:00', reminder: '1 Hour', priority: 'High',
  });

  test('preview writes nothing and returns the parent version', async () => {
    expect(await run(['preview', D, taskPlan])).toBe(0);
    const res = JSON.parse(out);
    expect(res.version).toBe('T1');
    expect(res.body.priority).toBe(HIGH);
    expect(posts()).toHaveLength(0);
  });

  test('apply needs --version and --confirmed, and sends nothing without them', async () => {
    expect(await run(['apply', D, taskPlan, '--confirmed'])).toBe(2);
    expect(await run(['apply', D, taskPlan, '--version', 'T1'])).toBe(2);
    expect(posts()).toHaveLength(0);
  });

  test('apply creates the task, reads it back and checks the parent lists it', async () => {
    expect(await run(['apply', D, taskPlan, '--version', 'T1', '--confirmed'])).toBe(0);
    const res = JSON.parse(out);
    expect(res).toMatchObject({ saved: true, linked: true, problems: [] });
    expect(posts()[0].body).toMatchObject({ origin: { modelName: 'Deal', docId: DEAL }, assignee: ME, dates: { dueAt: '2026-12-01T22:00:00.000Z', dueReminder: '1 Hour' } });
    expect(state.deal[DEAL].tasks).toContain(res.created.id);
  });

  test('apply refuses when the parent changed since the preview (also a second apply)', async () => {
    expect(await run(['apply', D, taskPlan, '--version', 'T1', '--confirmed'])).toBe(0);
    expect(await run(['apply', D, taskPlan, '--version', 'T1', '--confirmed'])).toBe(3);
    expect(posts()).toHaveLength(1);
  });

  test('apply refuses a blocked plan without writing', async () => {
    const meeting = plan({
      type: 'meeting', parent: { model: 'Deal', id: DEAL }, title: 'Demo', startAt: '2026-11-10T09:00:00Z', endAt: '2026-11-10T10:00:00Z', mode: 'Virtual',
    });
    expect(await run(['apply', D, meeting, '--version', 'T1', '--confirmed'])).toBe(3);
    expect(err).toContain('BLOCKED');
    expect(posts()).toHaveLength(0);
  });

  test('a missing parent blocks before any write', async () => {
    const p = plan({ type: 'note', parent: { model: 'Deal', id: 'f'.repeat(24) }, content: 'x' });
    expect(await run(['preview', D, p])).toBe(3);
    expect(posts()).toHaveLength(0);
  });

  test('a saved activity that the parent does not list is reported', async () => {
    state.dropLink = true;
    const p = plan({ type: 'note', parent: { model: 'Contact', id: CONTACT }, content: 'Hello' });
    expect(await run(['apply', D, p, '--version', 'T1', '--confirmed'])).toBe(1);
    const res = JSON.parse(out);
    expect(res.linked).toBe(false);
    expect(res.problems.join(' ')).toContain('does not list it');
  });

  test('an error after the save is reported with the orphan it left', async () => {
    state.saveDespiteError = true;
    const p = plan({ type: 'note', parent: { model: 'Deal', id: DEAL }, content: 'Closed deal note' });
    expect(await run(['apply', D, p, '--version', 'T1', '--confirmed'])).toBe(1);
    const res = JSON.parse(out);
    expect(res.saved).toBe(false);
    expect(res.orphan).toMatchObject({ type: 'note' });
    expect(res.problems[0]).toContain('without linking it');
  });

  test('an error before the save is reported as nothing saved', async () => {
    state.postStatus = 400;
    const p = plan({ type: 'note', parent: { model: 'Deal', id: DEAL }, content: 'x' });
    expect(await run(['apply', D, p, '--version', 'T1', '--confirmed'])).toBe(1);
    const res = JSON.parse(out);
    expect(res.orphan).toBeNull();
    expect(res.problems[0]).toContain('nothing was saved');
  });

  test('the key never reaches the output', async () => {
    await run(['preview', D, taskPlan]);
    expect(out + err).not.toContain('SECRET123');
  });
});

describe('history', () => {
  test('a contact uses the app feed, newest first, and lists activities missing from its lists', async () => {
    state.activity = {
      notes: [{ _id: 'n1', createdAt: '2026-10-01T10:00:00Z', content: '<p>Old</p>', createdBy: { firstName: 'Ana' } }],
      calls: [{ _id: 'c1', createdAt: '2026-10-05T10:00:00Z', summary: '<p>New</p>', stage: { stageName: 'Connected' } }],
    };
    state.contact[CONTACT].notes = ['n1'];
    state.contact[CONTACT].calls = ['c1'];
    state.note.orphan = { _id: 'orphan', contentText: 'Lost', createdAt: 'T', origin: { modelName: 'Contact', docId: CONTACT } };
    expect(await run(['history', D, 'contact', CONTACT])).toBe(0);
    const res = JSON.parse(out);
    expect(calls.some((c) => c.query.outputFormat === 'activity')).toBe(true);
    expect(res.items.map((i) => i.id)).toEqual(['c1', 'n1']);
    expect(res.items[0].status).toBe('Connected');
    expect(res.unlinked).toEqual([expect.objectContaining({ type: 'note', id: 'orphan' })]);
  });

  test('a deal shows its notes, tasks and stage moves, and meetings that point at it as unlinked', async () => {
    state.note.n1 = { _id: 'n1', content: '<p>Note</p>', createdAt: '2026-10-02T00:00:00Z', origin: { modelName: 'Deal', docId: DEAL } };
    state.deal[DEAL].notes = ['n1'];
    state.meeting.m1 = { _id: 'm1', title: 'Demo', createdAt: 'T', origin: { modelName: 'Deal', docId: DEAL } };
    state.moves = [{ _id: 's1', movedAt: '2026-10-03T00:00:00Z', fromStage: { stageName: 'Open' }, toStage: { stageName: 'Won' } }];
    expect(await run(['history', D, 'deal', DEAL])).toBe(0);
    const res = JSON.parse(out);
    expect(res.items.map((i) => i.type)).toEqual(['stage', 'note']);
    expect(res.items[0].text).toBe('Open → Won');
    expect(res.unlinked).toEqual([expect.objectContaining({ type: 'meeting', id: 'm1' })]);
  });
});
