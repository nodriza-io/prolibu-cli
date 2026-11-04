/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../.claude/skills/prolibu-projects/scripts/projects');

const D = 'dev99.example.com';
const ME = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const CONTACT = 'c'.repeat(24);
const DEAL = 'd'.repeat(24);
const GROUP = 'e'.repeat(24);
const WO = 'f'.repeat(24);
const CONTACT_GROUP = '9'.repeat(24);
const DONE = '76a7f53079d82378f83fc203';
const TODO = '76a7f53079d82378f83fc201';
const APPROVED = '76a6f41079d81268f83fede4';
const WEEKDAYS = { excludeSaturday: true, excludeSunday: true };

let rootDir;
let out;
let err;
let calls;
let state;
let nextId;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

// A fake of the endpoints the script uses, shaped after the verified server behavior: groups and
// work orders are plain records; a task saved into a work order's group recalculates its counts;
// work orders answer 403 for users without the WorkOrder permissions.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const [, , col, id] = u.pathname.split('/');
  const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
  if (col === 'workorder' && state.noWorkOrders) return respond(403, { error: 'Forbidden. User has no permission to perform "find" on "WorkOrder".' });
  if (init.method === 'GET' && u.pathname === '/v2/user/me') return respond(200, { profile: { _id: ME, firstName: 'Ana', lastName: 'Test', email: 'ana@example.com', isAdmin: true } });
  if (init.method === 'GET' && u.pathname === '/v2/user/preferences') return respond(200, { locale: {} });
  if (init.method === 'GET' && col === 'user' && !id) {
    const all = [{ _id: OTHER, firstName: 'Bea', lastName: 'Ruiz', email: 'bea@example.com' }, { _id: ME, firstName: 'Ana', lastName: 'Test', email: 'ana@example.com' }];
    return respond(200, { data: all.filter((x) => (xq.email ? x.email === xq.email : true)) });
  }
  if (init.method === 'GET' && col === 'user' && id) return respond(200, { _id: id, firstName: 'Bea', lastName: 'Ruiz', email: 'bea@example.com' });
  if (init.method === 'GET' && col === 'stage' && !id) {
    const type = u.searchParams.get('stageType');
    return respond(200, { data: state.stages.filter((s) => s.stageType === type) });
  }
  if (init.method === 'GET' && col === 'stage' && id) return respond(200, state.stages.find((s) => s._id === id) || {});
  if (init.method === 'GET' && col === 'group' && id === 'search') {
    return respond(200, { data: Object.values(state.group).filter((g) => g.groupName.includes(u.searchParams.get('term'))) });
  }
  if (init.method === 'GET' && col === 'workorder' && id === 'search') return respond(200, { data: Object.values(state.workorder) });
  if (init.method === 'GET' && ['group', 'workorder', 'deal', 'contact', 'task'].includes(col) && id) {
    const rec = state[col][id];
    return rec ? respond(200, rec) : respond(404, { error: 'Not found' });
  }
  if (init.method === 'GET' && col === 'task') {
    return respond(200, { data: Object.values(state.task).filter((t) => t.group === xq.group), pagination: { lastPage: 1 } });
  }
  if (init.method === 'GET' && col === 'workorder') {
    const rows = Object.values(state.workorder).filter((w) => Object.entries(xq).every(([k, v]) => String(w[k]) === String(v)));
    return respond(200, { data: rows });
  }
  if (init.method === 'POST' && ['group', 'task', 'workorder'].includes(col)) {
    if (state.failTaskAt !== undefined && col === 'task' && Object.keys(state.task).length >= state.failTaskAt) return respond(400, { error: 'boom' });
    nextId += 1;
    const newId = String(nextId).padStart(24, '0');
    const saved = { _id: newId, ...body, updatedAt: `T${nextId}` };
    if (col === 'group') saved.groupCode = 'GRP-1';
    if (col === 'task') saved.taskCode = `TSK-${nextId}`;
    if (col === 'workorder') saved.workOrderCode = 'WO-1';
    state[col][newId] = saved;
    return respond(201, saved);
  }
  if (init.method === 'PATCH' && ['group', 'task', 'workorder'].includes(col)) {
    const rec = state[col][id];
    if (!rec) return respond(404, { error: 'Not found' });
    if (state.forbidPatch) return respond(403, { error: 'Prohibido' });
    Object.assign(rec, body, { updatedAt: `P${(nextId += 1)}` });
    if (body.dates) rec.dates = { ...body.dates };
    return respond(200, rec);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => projects.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET');
const plan = (p) => JSON.stringify(p);

async function previewThenApply(p) {
  expect(await run(['preview', D, plan(p)])).toBe(0);
  const { version } = json();
  out = '';
  const code = await run(['apply', D, plan(p), '--version', version, '--confirmed']);
  return code;
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-projects-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  nextId = 100;
  state = {
    stages: [
      { _id: TODO, stageName: 'To do', stageType: 'Task.stage' },
      { _id: DONE, stageName: 'Done', stageType: 'Task.stage', endFlowStage: true },
      { _id: APPROVED, stageName: 'Approved', stageType: 'Deal.stage', endFlowStage: true },
      { _id: '88a8f53079d82378f83fc409', stageName: 'In execution', stageType: 'WorkOrder.stage' },
    ],
    group: {
      [GROUP]: {
        _id: GROUP, groupName: 'Rollout Acme', modelName: 'Task', collaborators: [ME], workingDays: { ...WEEKDAYS, excludeHolidays: true, holidays: ['2026-11-16T12:00:00.000Z'] }, updatedAt: 'G1',
      },
      [CONTACT_GROUP]: { _id: CONTACT_GROUP, groupName: 'VIP list', modelName: 'Contact', updatedAt: 'G1' },
    },
    task: {
      t1: {
        _id: 't1', group: GROUP, titleText: 'Kickoff', assignee: ME, stage: DONE, dates: { startAt: '2026-11-09T05:00:00.000Z', dueAt: '2026-11-10T04:59:00.000Z' }, time: { duration: 24 }, updatedAt: 'A',
      },
      t2: {
        _id: 't2', group: GROUP, titleText: 'Configure', assignee: OTHER, dates: { startAt: '2026-11-12T05:00:00.000Z', dueAt: '2026-11-14T04:59:00.000Z', dueReminderAt: '2026-11-13T04:59:00.000Z' }, time: { duration: 48 }, updatedAt: 'B',
      },
      t3: { _id: 't3', group: GROUP, titleText: 'Old import', dates: { startAt: '1970-01-01T00:00:46.002Z', dueAt: '1970-01-01T00:00:00.000Z' }, updatedAt: 'C' },
      t4: { _id: 't4', group: GROUP, titleText: 'Train users', dates: {}, updatedAt: 'D' },
    },
    workorder: {
      [WO]: {
        _id: WO, workOrderName: 'Acme - Work Order', deal: DEAL, contact: CONTACT, updatedAt: 'W1', progress: 0,
      },
    },
    deal: { [DEAL]: { _id: DEAL, dealName: 'Acme 2027', contact: CONTACT, stage: APPROVED, updatedAt: 'D1' } },
    contact: { [CONTACT]: { _id: CONTACT, firstName: 'Lucía', lastName: 'Gómez' } },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('working-day calendar', () => {
  test('shifting skips weekends and holidays, both ways', () => {
    const wd = { ...WEEKDAYS, excludeHolidays: true, holidays: ['2026-11-16T12:00:00.000Z'] };
    expect(projects.shiftDay('2026-11-13', 1, wd)).toBe('2026-11-17'); // Fri → Tue (Mon is a holiday)
    expect(projects.shiftDay('2026-11-17', -1, wd)).toBe('2026-11-13');
    expect(projects.shiftDay('2026-11-13', 1, {})).toBe('2026-11-14');
    expect(projects.workingDaysBetween('2026-11-10', '2026-11-17', wd)).toBe(4);
    expect(projects.workingDaysBetween('2026-11-17', '2026-11-10', wd)).toBe(-4);
    expect(projects.workingDaysInRange('2026-11-13', '2026-11-17', wd)).toBe(2);
  });

  test('holidays only count when the project excludes them', () => {
    expect(projects.isWorkingDay('2026-11-16', { holidays: ['2026-11-16T12:00:00.000Z'] })).toBe(true);
    expect(projects.isWorkingDay('2026-11-16', { excludeHolidays: true, holidays: ['2026-11-16T12:00:00.000Z'] })).toBe(false);
  });

  test('the calendar in a plan defaults to Monday–Friday and stores holidays at noon UTC', () => {
    expect(projects.cleanWorkingDays(undefined)).toEqual(WEEKDAYS);
    expect(projects.cleanWorkingDays({ excludeSaturday: true, holidays: ['2026-12-25'] }))
      .toEqual({ excludeSaturday: true, excludeSunday: false, excludeHolidays: true, holidays: ['2026-12-25T12:00:00.000Z'] });
    expect(() => projects.cleanWorkingDays({ holidays: ['25/12/2026'] })).toThrow('holidays');
    expect(() => projects.cleanWorkingDays({ hours: 8 })).toThrow('does not take');
  });

  test('an offset is required and never guessed', () => {
    expect(() => projects.offsetMinutes(undefined)).toThrow('time zone');
    expect(projects.offsetMinutes('-05:00')).toBe(-300);
    expect(projects.offsetMinutes('+0530')).toBe(330);
  });
});

describe('building tasks like the gantt', () => {
  const resolveUser = (v) => (v === 'me' ? { id: ME, label: 'you', isMe: true } : { id: OTHER, label: 'Bea', isMe: false });

  test('day bars run from local 00:00 to 23:59 and duration is 24 h per working day', () => {
    const { rows } = projects.buildTasks([
      { title: 'Kickoff', assignee: 'me', startAt: '2026-11-12', workingDays: 2 },
      { title: 'Setup', assignee: 'bea@example.com', after: 1, workingDays: 2 },
    ], { offMin: -300, workingDays: WEEKDAYS, resolveUser });
    const body = projects.taskBody(rows[0], GROUP, 1000000);
    expect(body).toEqual({
      title: 'Kickoff', group: GROUP, timelineIndex: 1000000, assignee: ME, time: { duration: 48 },
      dates: { startAt: '2026-11-12T05:00:00.000Z', dueAt: '2026-11-14T04:59:00.000Z' },
    });
    // Starts on the next working day after its predecessor (Fri 13 → Mon 16) and skips the weekend.
    expect(projects.taskBody(rows[1], GROUP, 2).dates).toEqual({ startAt: '2026-11-16T05:00:00.000Z', dueAt: '2026-11-18T04:59:00.000Z' });
    expect(body).not.toHaveProperty('origin');
  });

  test('refuses bad tasks before anything is sent', () => {
    const ctx = { offMin: -300, workingDays: WEEKDAYS, resolveUser };
    expect(() => projects.buildTasks([{ title: '<b>x</b>' }], ctx)).toThrow('plain text');
    expect(() => projects.buildTasks([{ title: 'x', after: 1 }], ctx)).toThrow('"after"');
    expect(() => projects.buildTasks([{ title: 'x', workingDays: 2 }], ctx)).toThrow('needs a start');
    expect(() => projects.buildTasks([{ title: 'x', startAt: '2026-11-14', workingDays: 2 }], ctx)).toThrow('non-working day');
    expect(() => projects.buildTasks([{ title: 'x', startAt: '2026-11-14', dueAt: '2026-11-12' }], ctx)).toThrow('start is after');
    expect(() => projects.buildTasks([{ title: 'x', origin: {} }], ctx)).toThrow('does not take');
  });
});

describe('status', () => {
  test('counts overdue open tasks, never done ones or broken 1970 dates', async () => {
    expect(await run(['status', D, 'project', GROUP, '--at', '2026-11-20T12:00:00Z', '--offset', '-05:00'])).toBe(0);
    const s = json();
    expect(s.total).toBe(4);
    expect(s.done).toBe(1);
    expect(s.overdue.map((t) => t.id)).toEqual(['t2']);
    expect(s.overdue[0].daysLate).toBe(6);
    expect(s.brokenDates).toBe(1);
    expect(s.unscheduled).toBe(1);
    expect(writes()).toEqual([]);
  });

  test('a contact group is not a project', async () => {
    expect(await run(['status', D, 'project', CONTACT_GROUP])).toBe(3);
    expect(err).toContain('not a project of tasks');
  });

  test('a 403 stops with FORBIDDEN and is not retried', async () => {
    state.noWorkOrders = true;
    expect(await run(['status', D, 'workorder', WO])).toBe(1);
    expect(err).toContain('FORBIDDEN');
    expect(calls.filter((c) => c.path.includes('workorder'))).toHaveLength(1);
  });
});

describe('project and tasks plans', () => {
  const projectPlan = {
    kind: 'project', name: 'Implementation Beta', offset: '-05:00', members: ['bea@example.com'],
    tasks: [{ title: 'Kickoff', assignee: 'me', startAt: '2026-11-12', workingDays: 1 }, { title: 'Setup', assignee: 'bea@example.com', after: 1, workingDays: 1 }],
  };

  test('preview writes nothing and tells the agent to stop', async () => {
    expect(await run(['preview', D, plan(projectPlan)])).toBe(0);
    const p = json();
    expect(writes()).toEqual([]);
    expect(p.nextStep).toContain('STOP HERE');
    expect(p.notifies.join(' ')).toContain('Bea');
    expect(p.plan.sharedPublicly).toBe(false);
  });

  test('apply creates the group, the tasks in order and the link on the predecessor', async () => {
    expect(await previewThenApply(projectPlan)).toBe(0);
    const r = json();
    expect(r.saved).toBe(true);
    const [g, t1, t2, link] = writes();
    expect(g).toMatchObject({ method: 'POST', path: '/v2/group' });
    expect(g.body).toEqual({ groupName: 'Implementation Beta', modelName: 'Task', collaborators: [ME, OTHER], workingDays: WEEKDAYS });
    expect(g.body).not.toHaveProperty('shareTimeline');
    expect(t1.body.group).toBe(r.project.id);
    expect(t2.body.timelineIndex).toBeGreaterThan(t1.body.timelineIndex);
    // The gantt keeps successors in the predecessor's `dependencies`.
    expect(link).toMatchObject({ method: 'PATCH', path: `/v2/task/${r.created[0].id}`, body: { dependencies: [r.created[1].id] } });
  });

  test('apply without --confirmed or with a stale version writes nothing', async () => {
    expect(await run(['apply', D, plan(projectPlan), '--version', 'x'])).toBe(2);
    expect(await run(['apply', D, plan(projectPlan), '--version', 'stale', '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
  });

  test('a second apply of the same project is blocked by its name', async () => {
    expect(await previewThenApply(projectPlan)).toBe(0);
    const before = writes().length;
    out = '';
    expect(await run(['preview', D, plan(projectPlan)])).toBe(3);
    expect(json().blockers.join(' ')).toContain('already exists');
    expect(writes()).toHaveLength(before);
  });

  test('adding tasks: the version covers the task list, so a repeat is refused', async () => {
    const p = { kind: 'tasks', project: GROUP, offset: '-05:00', tasks: [{ title: 'Go live', assignee: 'me', startAt: '2026-11-19', workingDays: 1 }] };
    expect(await run(['preview', D, plan(p)])).toBe(0);
    const { version } = json();
    out = '';
    expect(await run(['apply', D, plan(p), '--version', version, '--confirmed'])).toBe(0);
    expect(json().created).toHaveLength(1);
    expect(await run(['apply', D, plan(p), '--version', version, '--confirmed'])).toBe(3);
    expect(writes().filter((w) => w.method === 'POST')).toHaveLength(1);
  });

  test('a failed task stops the batch and is reported', async () => {
    state.failTaskAt = 5; // the fourth task created fails
    const p = { kind: 'tasks', project: GROUP, offset: '-05:00', tasks: [{ title: 'A' }, { title: 'B' }] };
    expect(await previewThenApply(p)).toBe(1);
    const r = json();
    expect(r.saved).toBe(false);
    expect(r.created).toHaveLength(1);
    expect(r.problems.join(' ')).toContain('failed');
  });
});

describe('reschedule', () => {
  test('moves open dated tasks by working days, keeps reminders aligned, skips done and broken ones', async () => {
    const p = { kind: 'reschedule', project: GROUP, offset: '-05:00', shiftWorkingDays: 1 };
    expect(await previewThenApply(p)).toBe(0);
    const patches = writes();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ method: 'PATCH', path: '/v2/task/t2' });
    // Thu 12 → Fri 13; due Fri 13 23:59 → Tue 17 (weekend and the Monday holiday skipped).
    expect(patches[0].body.dates).toEqual({
      startAt: '2026-11-13T05:00:00.000Z', dueAt: '2026-11-18T04:59:00.000Z', dueReminderAt: '2026-11-17T04:59:00.000Z',
    });
    expect(patches[0].body.time).toBeUndefined(); // still 2 working days
  });

  test('newStart counts working days from the earliest open task', async () => {
    const p = { kind: 'reschedule', project: GROUP, offset: '-05:00', newStart: '2026-11-17' };
    expect(await run(['preview', D, plan(p)])).toBe(0);
    expect(json().plan.workingDaysMoved).toBe(2);
    out = '';
    expect(await run(['preview', D, plan({ ...p, newStart: '2026-11-16' })])).toBe(2);
    expect(err).toContain('not a working day');
  });

  test('a task edited after the preview invalidates it', async () => {
    const p = { kind: 'reschedule', project: GROUP, offset: '-05:00', shiftWorkingDays: 2 };
    expect(await run(['preview', D, plan(p)])).toBe(0);
    const { version } = json();
    state.task.t2.updatedAt = 'changed';
    expect(await run(['apply', D, plan(p), '--version', version, '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('work orders', () => {
  test('a deal that already has a work order is blocked; the deal is never written', async () => {
    expect(await run(['preview', D, plan({ kind: 'workorder', deal: DEAL })])).toBe(3);
    expect(json().blockers.join(' ')).toContain('already has a work order');
    expect(writes()).toEqual([]);
  });

  test('creates the work order with the deal\'s contact and no stage; only /v2/workorder is written', async () => {
    delete state.workorder[WO];
    expect(await previewThenApply({ kind: 'workorder', deal: DEAL, assignee: 'me', project: GROUP })).toBe(0);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'POST', path: '/v2/workorder' });
    expect(w[0].body).toEqual({ workOrderName: 'Acme 2027 - Work Order', deal: DEAL, contact: CONTACT, assignee: ME, taskGroup: GROUP });
    expect(calls.some((c) => c.path.startsWith('/v2/deal') && c.method !== 'GET')).toBe(false);
  });

  test('a user without work order permission is stopped at the preview', async () => {
    state.noWorkOrders = true;
    expect(await run(['preview', D, plan({ kind: 'workorder', name: 'X' })])).toBe(1);
    expect(err).toContain('FORBIDDEN');
    expect(writes()).toEqual([]);
  });

  test('link sets taskGroup and refuses a no-op', async () => {
    expect(await previewThenApply({ kind: 'link', workOrder: WO, project: GROUP })).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: `/v2/workorder/${WO}`, body: { taskGroup: GROUP } });
    out = '';
    expect(await run(['preview', D, plan({ kind: 'link', workOrder: WO, project: GROUP })])).toBe(3);
  });
});

describe('sharing', () => {
  test('unshare turns the public timeline off; there is no plan to turn it on', async () => {
    state.group[GROUP].shareTimeline = { enabled: true, timelineUrl: 'https://example.com/s/x' };
    expect(await previewThenApply({ kind: 'unshare', project: GROUP })).toBe(0);
    expect(writes()[0].body).toEqual({ shareTimeline: { enabled: false } });
    expect(() => projects.readPlan(plan({ kind: 'share', project: GROUP }))).toThrow('"kind"');
    expect(() => projects.readPlan(plan({ kind: 'project', name: 'x', shareTimeline: { enabled: true } }))).toThrow('does not take');
  });
});

test('the API key never reaches the output', async () => {
  state.group[GROUP].groupName = 'SECRET123';
  expect(await run(['status', D, 'project', GROUP])).toBe(0);
  expect(out).not.toContain('SECRET123');
});
