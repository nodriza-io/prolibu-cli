#!/usr/bin/env node
'use strict';

// Projects (task groups with a shared timeline) and work orders, the way the Prolibu app
// handles them.
//
//   projects.js find    <domain> <project|workorder> <text>
//   projects.js status  <domain> <project|workorder> <id> [--at <ISO date>]
//   projects.js options <domain>
//   projects.js preview <domain> '<plan>'                         writes nothing; returns a version
//   projects.js apply   <domain> '<plan>' --version <v> --confirmed
//
// Plan kinds: project | tasks | workorder | link | reschedule | unshare (see SKILL.md).
// Stage moves (work order to In execution, a task to Done) belong to prolibu-stages.
// Plans are inline JSON or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
const { plainText } = require('../../prolibu-activities/scripts/activity');
const { humanDuration, FACTORY } = require('../../prolibu-stages/scripts/stages');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;
const BLOCKED = 3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MAX_TASKS_PER_PLAN = 60;
const MAX_TASKS_READ = 1000;
const MAX_SHIFT_DAYS = 365;
const TITLE_MAX = 250;
// Dates before this are broken data (some imports saved 1970 timestamps): never "overdue".
const SANE_DATE = Date.UTC(2000, 0, 1);
const PROGRESS_METHODS = ['By Task Completion', 'By Task Duration', 'By Stage'];
const WO_NAME_POSTFIX = ' - Work Order'; // server default for operations.workOrders.namePostfix

const STOP = 'Show this to the user in plain words. STOP HERE and end your turn; never write in the same turn as '
  + 'this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version.';

const PLAN_KEYS = {
  project: ['kind', 'name', 'description', 'members', 'workingDays', 'offset', 'tasks', 'workOrder'],
  tasks: ['kind', 'project', 'offset', 'tasks'],
  workorder: ['kind', 'name', 'deal', 'contact', 'assignee', 'observations', 'progressMethod', 'project'],
  link: ['kind', 'workOrder', 'project'],
  reschedule: ['kind', 'project', 'offset', 'shiftWorkingDays', 'newStart', 'includeDone'],
  unshare: ['kind', 'project'],
};
const TASK_KEYS = new Set(['title', 'description', 'assignee', 'startAt', 'dueAt', 'workingDays', 'after']);

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const fullName = (u) => (u && typeof u === 'object' ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || null : null);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))).toString();
const saneTime = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) && t >= SANE_DATE ? t : null;
};

function offsetMinutes(offset) {
  const m = OFFSET_RE.exec(String(offset || ''));
  if (!m) {
    throw new UsageError('"offset" must be the UTC offset of the project\'s time zone, like "-05:00". '
      + 'Ask the user for their time zone; the script never guesses it.');
  }
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

// The local calendar day (YYYY-MM-DD) of an instant, in the plan's offset.
function dayKey(time, offMin) {
  return new Date(time + offMin * 60e3).toISOString().slice(0, 10);
}

// Instant of a local wall-clock time on a given day, in the plan's offset.
function localTime(day, hh, mm, offMin) {
  const [y, mo, d] = day.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm) - offMin * 60e3;
}

function addDays(day, n) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// The app's gantt reads a holiday as the first 10 characters of its ISO date.
function holidaySet(workingDays) {
  const wd = workingDays || {};
  if (!wd.excludeHolidays) return new Set();
  return new Set((wd.holidays || []).map((h) => String(h).slice(0, 10)).filter((h) => DAY_RE.test(h)));
}

function isWorkingDay(day, workingDays, holidays = holidaySet(workingDays)) {
  const wd = workingDays || {};
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 6 && wd.excludeSaturday) return false;
  if (weekday === 0 && wd.excludeSunday) return false;
  return !holidays.has(day);
}

// Moves a day by n working days (n may be negative). A non-working start counts from there.
function shiftDay(day, n, workingDays) {
  const holidays = holidaySet(workingDays);
  let current = day;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  let guard = 0;
  while (left > 0) {
    current = addDays(current, step);
    if (isWorkingDay(current, workingDays, holidays)) left -= 1;
    guard += 1;
    if (guard > 3 * MAX_SHIFT_DAYS) throw new UsageError('The calendar has no working days to move into.');
  }
  return current;
}

// Signed count of working days from one day to another (0 when equal).
function workingDaysBetween(from, to, workingDays) {
  if (from === to) return 0;
  const holidays = holidaySet(workingDays);
  const step = to > from ? 1 : -1;
  let n = 0;
  let current = from;
  let guard = 0;
  while (current !== to) {
    current = addDays(current, step);
    if (isWorkingDay(current, workingDays, holidays)) n += step;
    guard += 1;
    if (guard > 3 * MAX_SHIFT_DAYS) throw new UsageError('The new start is too far from the current one (over a year).');
  }
  return n;
}

// Working days in [first, last], both included: what the gantt stores as time.duration / 24.
function workingDaysInRange(first, last, workingDays) {
  const holidays = holidaySet(workingDays);
  let n = 0;
  for (let d = first, i = 0; d <= last && i < 3 * MAX_SHIFT_DAYS; d = addDays(d, 1), i += 1) {
    if (isWorkingDay(d, workingDays, holidays)) n += 1;
  }
  return n;
}

// "2026-11-05" → local 00:00 (start) or 23:59 (due), like the gantt's day bars.
// A full date-time keeps its own instant.
function parseWhen(value, field, offMin, edge) {
  const v = String(value || '').trim();
  if (DAY_RE.test(v)) return edge === 'start' ? localTime(v, 0, 0, offMin) : localTime(v, 23, 59, offMin);
  if (DATETIME_RE.test(v)) {
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return t;
  }
  throw new UsageError(`"${field}" must be a day (2026-11-05) or a date-time with its offset (2026-11-05T09:00:00-05:00).`);
}

function cleanTitle(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new UsageError(`${label} needs a "title".`);
  if (/[<>]/.test(text)) throw new UsageError(`${label}: write the title as plain text, without < or >.`);
  if (text.length > TITLE_MAX) throw new UsageError(`${label}: the title is too long (${text.length} of ${TITLE_MAX}). Put details in "description".`);
  return text;
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    if (!text.trim()) throw new UsageError('Give the plan as inline JSON or the path of a JSON file.');
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
  const kind = String(plan.kind || '').toLowerCase();
  if (!PLAN_KEYS[kind]) throw new UsageError(`The plan needs "kind": ${Object.keys(PLAN_KEYS).join(', ')}.`);
  const unknown = Object.keys(plan).filter((k) => !PLAN_KEYS[kind].includes(k));
  if (unknown.length) throw new UsageError(`A ${kind} plan does not take: ${unknown.join(', ')}. Allowed: ${PLAN_KEYS[kind].join(', ')}.`);
  for (const key of ['project', 'workOrder', 'deal', 'contact']) {
    if (plan[key] !== undefined && !ID_RE.test(String(plan[key]))) {
      throw new UsageError(`"${key}" must be the record _id (24 hex characters). Use find to get it.`);
    }
  }
  return { ...plan, kind };
}

// Validates the plan's tasks and turns them into gantt-shaped rows (no ids yet).
// ctx: { offMin, workingDays, resolveUser(value) → {id,label,isMe} }
function buildTasks(rawTasks, ctx) {
  if (!Array.isArray(rawTasks) || !rawTasks.length) throw new UsageError('"tasks" must be a non-empty list.');
  if (rawTasks.length > MAX_TASKS_PER_PLAN) throw new UsageError(`At most ${MAX_TASKS_PER_PLAN} tasks per plan; split it.`);
  const warnings = [];
  const notifies = [];
  const rows = [];
  rawTasks.forEach((t, i) => {
    const label = `Task ${i + 1}`;
    if (!t || typeof t !== 'object') throw new UsageError(`${label} must be an object.`);
    const unknown = Object.keys(t).filter((k) => !TASK_KEYS.has(k));
    if (unknown.length) throw new UsageError(`${label} does not take: ${unknown.join(', ')}. Allowed: ${[...TASK_KEYS].join(', ')}.`);
    const row = { index: i, title: cleanTitle(t.title, label) };
    if (t.description) row.description = String(t.description).trim();
    if (t.after !== undefined) {
      const a = Number(t.after);
      if (!Number.isInteger(a) || a < 1 || a > i) throw new UsageError(`${label}: "after" is the number of an earlier task in this plan (1 to ${i}).`);
      row.after = a - 1;
    }
    if (t.assignee) {
      const user = ctx.resolveUser(t.assignee);
      row.assignee = user.id;
      row.assigneeLabel = user.label;
      if (!user.isMe) notifies.push(`${user.label} is told that "${row.title}" was assigned to them (in the app, and by e-mail where their settings say so).`);
    }
    let start = null;
    if (t.startAt) start = parseWhen(t.startAt, `${label} startAt`, ctx.offMin, 'start');
    else if (row.after !== undefined && rows[row.after].dueAt) {
      // Starts on the next working day after its predecessor, like the gantt's successor rule.
      const prevDay = dayKey(rows[row.after].dueAt, ctx.offMin);
      start = localTime(shiftDay(prevDay, 1, ctx.workingDays), 0, 0, ctx.offMin);
    }
    let due = null;
    if (t.dueAt && t.workingDays !== undefined) throw new UsageError(`${label}: give "dueAt" or "workingDays", not both.`);
    if (t.dueAt) due = parseWhen(t.dueAt, `${label} dueAt`, ctx.offMin, 'due');
    if (t.workingDays !== undefined) {
      const n = Number(t.workingDays);
      if (!Number.isInteger(n) || n < 1 || n > MAX_SHIFT_DAYS) throw new UsageError(`${label}: "workingDays" is a whole number of working days (1 to ${MAX_SHIFT_DAYS}).`);
      if (start === null) throw new UsageError(`${label}: "workingDays" needs a start ("startAt" or "after").`);
      const firstDay = dayKey(start, ctx.offMin);
      if (!isWorkingDay(firstDay, ctx.workingDays)) throw new UsageError(`${label} starts on ${firstDay}, a non-working day of this project. Pick another start.`);
      due = localTime(shiftDay(firstDay, n - 1, ctx.workingDays), 23, 59, ctx.offMin);
    }
    if (start !== null && due !== null && start > due) throw new UsageError(`${label}: the start is after the due date. The server would accept it; check the dates with the user.`);
    if (start !== null) row.startAt = start;
    if (due !== null) row.dueAt = due;
    if (start !== null && due !== null) {
      const days = workingDaysInRange(dayKey(start, ctx.offMin), dayKey(due, ctx.offMin), ctx.workingDays);
      row.durationHours = days * 24;
      row.workingDays = days;
      if (!days) warnings.push(`${label} ("${row.title}") falls entirely on non-working days.`);
    } else {
      warnings.push(`${label} ("${row.title}") has no ${start === null ? 'start' : 'due date'}: the timeline shows it unscheduled.`);
    }
    if (!row.assignee) warnings.push(`${label} ("${row.title}") has nobody responsible.`);
    rows.push(row);
  });
  return { rows, warnings, notifies };
}

// The body the app's gantt posts for a new task (useGanttEvents onBeforeTaskUpdate).
function taskBody(row, groupId, timelineIndex) {
  const body = { title: row.title, group: groupId, timelineIndex };
  if (row.description) body.description = row.description;
  if (row.assignee) body.assignee = row.assignee;
  if (row.durationHours) body.time = { duration: row.durationHours };
  const dates = {};
  if (row.startAt !== undefined) dates.startAt = new Date(row.startAt).toISOString();
  if (row.dueAt !== undefined) dates.dueAt = new Date(row.dueAt).toISOString();
  if (Object.keys(dates).length) body.dates = dates;
  return body;
}

function describeRow(row, offMin) {
  const fmt = (t) => (t === undefined ? null : new Date(t + offMin * 60e3).toISOString().slice(0, 16).replace('T', ' '));
  return {
    n: row.index + 1,
    title: row.title,
    assignee: row.assigneeLabel || null,
    start: fmt(row.startAt),
    due: fmt(row.dueAt),
    workingDays: row.workingDays || null,
    after: row.after !== undefined ? row.after + 1 : undefined,
  };
}

// Plans the shift of every open, dated task by n working days. Pure.
function planShift(tasks, n, workingDays, offMin, { includeDone = false, doneStageIds = new Set() } = {}) {
  const changes = [];
  const skipped = [];
  for (const t of tasks) {
    const isDone = t.stage && doneStageIds.has(idOf(t.stage));
    if (isDone && !includeDone) { skipped.push({ id: t._id, title: t.titleText || plainText(t.title), reason: 'done' }); continue; }
    const start = saneTime(t.dates && t.dates.startAt);
    const due = saneTime(t.dates && t.dates.dueAt);
    if (start === null && due === null) {
      const broken = (t.dates && (t.dates.startAt || t.dates.dueAt));
      skipped.push({ id: t._id, title: t.titleText || plainText(t.title), reason: broken ? 'broken dates (before 2000)' : 'no dates' });
      continue;
    }
    const move = (time) => {
      const day = dayKey(time, offMin);
      const msInDay = time - localTime(day, 0, 0, offMin);
      return localTime(shiftDay(day, n, workingDays), 0, 0, offMin) + msInDay;
    };
    const dates = {};
    if (start !== null) dates.startAt = new Date(move(start)).toISOString();
    if (due !== null) dates.dueAt = new Date(move(due)).toISOString();
    // The server only recomputes the reminder when its choice changes: move it with the due date.
    const reminderAt = saneTime(t.dates && t.dates.dueReminderAt);
    if (due !== null && reminderAt !== null) dates.dueReminderAt = new Date(new Date(dates.dueAt).getTime() - (due - reminderAt)).toISOString();
    const body = { dates };
    if (start !== null && due !== null && t.time && t.time.duration) {
      const days = workingDaysInRange(dayKey(new Date(dates.startAt).getTime(), offMin), dayKey(new Date(dates.dueAt).getTime(), offMin), workingDays);
      if (days * 24 !== t.time.duration) body.time = { duration: days * 24 };
    }
    changes.push({
      id: String(t._id),
      title: t.titleText || plainText(t.title),
      from: { startAt: t.dates.startAt || null, dueAt: t.dates.dueAt || null },
      to: { startAt: dates.startAt || null, dueAt: dates.dueAt || null },
      body,
    });
  }
  return { changes, skipped };
}

// Summarises a project's tasks the way a manager reads them. Pure.
function summarize(tasks, { now, stagesById, offMin = 0, users = {} }) {
  const out = {
    total: tasks.length, done: 0, open: 0, overdue: [], dueSoon: [], unassigned: 0, unscheduled: 0, brokenDates: 0, byStage: {}, byAssignee: {},
  };
  for (const t of tasks) {
    const stage = stagesById[idOf(t.stage)];
    const stageName = stage ? stage.stageName : 'No stage (to do)';
    out.byStage[stageName] = (out.byStage[stageName] || 0) + 1;
    const done = !!(stage && stage.endFlowStage);
    if (done) out.done += 1; else out.open += 1;
    const who = users[idOf(t.assignee)] || (t.assignee ? idOf(t.assignee) : null);
    if (!t.assignee) out.unassigned += 1;
    if (!done) out.byAssignee[who || 'nobody'] = (out.byAssignee[who || 'nobody'] || 0) + 1;
    const rawDue = t.dates && t.dates.dueAt;
    const due = saneTime(rawDue);
    if (rawDue && due === null) out.brokenDates += 1;
    if (!rawDue && !(t.dates && t.dates.startAt)) out.unscheduled += 1;
    if (done || due === null) continue;
    const row = {
      id: t._id, code: t.taskCode, title: t.titleText || plainText(t.title), assignee: who, stage: stageName, dueAt: rawDue,
      dueLocal: dayKey(due, offMin),
    };
    if (due < now) out.overdue.push({ ...row, daysLate: Math.floor((now - due) / DAY) });
    else if (due - now <= 7 * DAY) out.dueSoon.push(row);
  }
  out.overdue.sort((a, b) => b.daysLate - a.daysLate);
  out.dueSoon.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  out.completion = out.total ? Math.round((out.done / out.total) * 100) : 0;
  return out;
}

// ─── API ───────────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function getOne(client, path, id, select, what) {
  try {
    return await call(client, 'GET', `/v2/${path}/${id}?${qs({ select })}`);
  } catch (err) {
    if (err.status === 404) throw new Blocked(`No ${what} with id ${id} (or this user cannot see it). Nothing was written.`);
    throw err;
  }
}

const GROUP_SELECT = 'groupName groupCode description modelName collaborators company workingDays shareTimeline customStages createdBy updatedAt';
const WO_SELECT = 'workOrderName workOrderCode deal contact company assignee stage taskGroup progress progressMethod tasksCount doneTasksCount '
  + 'time cancelled isTemplate observations pipelineStages updatedAt createdAt';
const TASK_SELECT = 'title titleText taskCode stage assignee dates time parent dependencies timelineIndex updatedAt';

async function loadProject(client, id) {
  const g = await getOne(client, 'group', id, GROUP_SELECT, 'project');
  if (g.modelName !== 'Task') {
    throw new Blocked(`"${g.groupName}" is a group of ${g.modelName} records, not a project of tasks. This skill only works with task groups.`);
  }
  return g;
}

async function loadTasks(client, groupId) {
  const rows = [];
  for (let page = 1; rows.length < MAX_TASKS_READ; page += 1) {
    const body = await call(client, 'GET', `/v2/task?${qs({
      xquery: { group: groupId }, select: TASK_SELECT, sort: 'timelineIndex', limit: 200, page,
    })}`);
    rows.push(...(body.data || []));
    const p = body.pagination || {};
    if (!p.lastPage || page >= p.lastPage) break;
  }
  return rows;
}

async function loadStages(client, stageType) {
  const body = await call(client, 'GET', `/v2/stage?${qs({
    stageType, select: 'stageName stageCode endFlowStage percentage active index', sort: 'index', limit: 100,
  })}`);
  return body.data || [];
}

async function loadMe(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || {};
  return { _id: String(p._id), email: p.email, name: fullName(p), isAdmin: !!p.isAdmin };
}

// "me", or a user's e-mail resolved to its id on the server (never a guessed id).
async function userResolver(client, values) {
  const me = await loadMe(client);
  const byEmail = {};
  const emails = [...new Set(values.filter((v) => v && String(v).toLowerCase() !== 'me').map((v) => String(v).trim().toLowerCase()))];
  for (const email of emails) {
    if (!EMAIL_RE.test(email)) throw new UsageError(`"${email}" is not "me" or an e-mail. Give the colleague's sign-in e-mail.`);
    if (email === String(me.email).toLowerCase()) continue;
    const body = await call(client, 'GET', `/v2/user?${qs({ xquery: { email }, select: 'firstName lastName email', limit: 2 })}`);
    const u = (body.data || [])[0];
    if (!u) throw new Blocked(`No user with the e-mail ${email} in this account. Ask for the colleague's sign-in e-mail.`);
    byEmail[email] = { id: String(u._id), label: `${fullName(u)} (${email})`, isMe: false };
  }
  const resolve = (value) => {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'me' || v === String(me.email).toLowerCase()) return { id: me._id, label: 'you', isMe: true };
    if (byEmail[v]) return byEmail[v];
    throw new UsageError(`"${value}" must be "me" or a user's e-mail.`);
  };
  return { me, resolve };
}

function planUsers(plan) {
  const list = [];
  for (const m of plan.members || []) list.push(m);
  for (const t of plan.tasks || []) if (t && t.assignee) list.push(t.assignee);
  if (plan.assignee) list.push(plan.assignee);
  return list;
}

function cleanWorkingDays(raw) {
  if (raw === undefined) return { excludeSaturday: true, excludeSunday: true };
  if (!raw || typeof raw !== 'object') throw new UsageError('"workingDays" is {"excludeSaturday": true, "excludeSunday": true, "holidays": ["2026-12-25"]}.');
  const allowed = new Set(['excludeSaturday', 'excludeSunday', 'holidays']);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) throw new UsageError(`"workingDays" does not take: ${unknown.join(', ')}.`);
  const holidays = raw.holidays || [];
  if (!Array.isArray(holidays) || holidays.some((h) => !DAY_RE.test(String(h)))) throw new UsageError('"workingDays.holidays" is a list of days like "2026-12-25".');
  const out = { excludeSaturday: raw.excludeSaturday === true, excludeSunday: raw.excludeSunday === true };
  if (holidays.length) {
    out.excludeHolidays = true;
    // Noon UTC keeps the same calendar day in every time zone of the Americas and Europe.
    out.holidays = [...new Set(holidays)].sort().map((h) => `${h}T12:00:00.000Z`);
  }
  return out;
}

// ─── Planners (read, check, build; no writes) ─────────────────────────────────

async function planProject(client, plan) {
  const name = String(plan.name || '').trim();
  if (!name) throw new UsageError('A project plan needs "name".');
  const users = await userResolver(client, planUsers(plan));
  const workingDays = cleanWorkingDays(plan.workingDays);
  const members = [...new Set(['me', ...(plan.members || [])].map((m) => users.resolve(m).id))];
  const blockers = [];
  const warnings = [];
  const notifies = [];
  const existing = await call(client, 'GET', `/v2/group/search?${qs({ term: name, select: 'groupName modelName', limit: 20 })}`);
  const same = (existing.data || []).find((g) => g.modelName === 'Task' && String(g.groupName).trim().toLowerCase() === name.toLowerCase());
  if (same) blockers.push(`A project named "${same.groupName}" already exists (${same._id}). Use a "tasks" plan to add to it, or choose another name.`);
  let rows = [];
  if (plan.tasks) {
    const offMin = offsetMinutes(plan.offset);
    const built = buildTasks(plan.tasks, { offMin, workingDays, resolveUser: users.resolve });
    rows = built.rows;
    warnings.push(...built.warnings);
    notifies.push(...built.notifies);
  }
  let wo = null;
  if (plan.workOrder) {
    wo = await getOne(client, 'workorder', plan.workOrder, WO_SELECT, 'work order');
    if (wo.taskGroup) blockers.push(`The work order "${wo.workOrderName}" already has a project (${idOf(wo.taskGroup)}). Add the tasks there with a "tasks" plan.`);
    if (wo.isTemplate) warnings.push(`"${wo.workOrderName}" is a template: every work order cloned from it copies this project and its tasks.`);
  }
  const group = { groupName: name, modelName: 'Task', collaborators: members, workingDays };
  if (plan.description) group.description = String(plan.description).trim();
  const memberLabels = await labelsFor(client, members, users.me);
  return {
    summary: {
      kind: 'project',
      name,
      members: memberLabels,
      calendar: describeCalendar(workingDays),
      tasks: rows.map((r) => describeRow(r, plan.tasks ? offsetMinutes(plan.offset) : 0)),
      workOrder: wo ? { id: wo._id, name: wo.workOrderName } : undefined,
      sharedPublicly: false,
    },
    body: { group, tasks: rows },
    versionOf: { plan, me: users.me._id, wo: wo && wo.updatedAt },
    blockers,
    warnings,
    notifies: [...notifies, ...(members.length > 1 ? ['Project members see the project and every task in it (no notice is sent for joining the project).'] : [])],
    wo,
  };
}

async function labelsFor(client, ids, me) {
  const out = [];
  for (const id of ids) {
    if (id === me._id) { out.push('you'); continue; }
    try {
      const u = await call(client, 'GET', `/v2/user/${id}?${qs({ select: 'firstName lastName email' })}`);
      out.push(`${fullName(u)} (${u.email})`);
    } catch {
      out.push(id);
    }
  }
  return out;
}

function describeCalendar(wd) {
  const off = [];
  if (wd.excludeSaturday) off.push('Saturdays');
  if (wd.excludeSunday) off.push('Sundays');
  const holidays = [...holidaySet(wd)];
  if (holidays.length) off.push(`${holidays.length} holiday(s): ${holidays.slice(0, 12).join(', ')}${holidays.length > 12 ? '…' : ''}`);
  return off.length ? `Non-working: ${off.join('; ')}` : 'Every day is a working day';
}

async function planTasks(client, plan) {
  if (!plan.project) throw new UsageError('A tasks plan needs "project" (the project id).');
  const group = await loadProject(client, plan.project);
  const users = await userResolver(client, planUsers(plan));
  const offMin = offsetMinutes(plan.offset);
  const built = buildTasks(plan.tasks, { offMin, workingDays: group.workingDays, resolveUser: users.resolve });
  const current = await loadTasks(client, plan.project);
  const blockers = [];
  const titles = new Set(current.map((t) => String(t.titleText || '').trim().toLowerCase()));
  const dupes = built.rows.filter((r) => titles.has(r.title.toLowerCase()));
  if (dupes.length) built.warnings.push(`Already in the project with the same title: ${dupes.map((r) => `"${r.title}"`).join(', ')}. Make sure they are not duplicates.`);
  const wos = await linkedWorkOrders(client, plan.project);
  return {
    summary: {
      kind: 'tasks', project: { id: group._id, name: group.groupName }, currentTasks: current.length, calendar: describeCalendar(group.workingDays || {}),
      tasks: built.rows.map((r) => describeRow(r, offMin)), workOrders: wos.map((w) => w.workOrderName),
    },
    body: { group, tasks: built.rows, startIndex: nextIndex(current) },
    versionOf: { plan, group: group.updatedAt, tasks: current.map((t) => [t._id, t.updatedAt]) },
    blockers,
    warnings: [...built.warnings, ...(wos.length ? [`Adding tasks recalculates the progress of: ${wos.map((w) => w.workOrderName).join(', ')}.`] : [])],
    notifies: built.notifies,
  };
}

function nextIndex(tasks) {
  const max = tasks.reduce((m, t) => Math.max(m, Number(t.timelineIndex) || 0), 0);
  return max + 1000000;
}

async function linkedWorkOrders(client, groupId) {
  try {
    const body = await call(client, 'GET', `/v2/workorder?${qs({ xquery: { taskGroup: groupId }, select: 'workOrderName stage', limit: 10 })}`);
    return body.data || [];
  } catch (err) {
    if (err.status === 403) return [];
    throw err;
  }
}

async function planWorkOrder(client, plan) {
  const blockers = [];
  const warnings = [];
  const notifies = [];
  // Work orders need their own permission (sellers often lack it): fail at the preview, not at apply.
  await call(client, 'GET', `/v2/workorder?${qs({ limit: 1, select: '_id' })}`);
  const users = await userResolver(client, planUsers(plan));
  const body = {};
  let deal = null;
  if (plan.deal) {
    // Read only: this skill never writes the deal (deal writes fire the account's webhooks).
    deal = await getOne(client, 'deal', plan.deal, 'dealName contact company stage updatedAt', 'deal');
    body.deal = String(deal._id);
    const existing = await call(client, 'GET', `/v2/workorder?${qs({ xquery: { deal: plan.deal }, select: 'workOrderName workOrderCode', limit: 5 })}`);
    if ((existing.data || []).length) {
      const w = existing.data[0];
      blockers.push(`The deal already has a work order: "${w.workOrderName}" (${w._id}). The app never creates a second one for a deal.`);
    }
    const stage = deal.stage ? await getOne(client, 'stage', idOf(deal.stage), 'stageName endFlowStage', 'stage').catch(() => null) : null;
    if (!stage || String(stage._id) !== FACTORY.dealApproved) {
      warnings.push(`The deal is in "${stage ? stage.stageName : 'no stage'}", not Approved. The app creates work orders when a deal is approved; check this is intended.`);
    }
  }
  const name = String(plan.name || '').trim() || (deal ? `${deal.dealName}${WO_NAME_POSTFIX}` : '');
  if (!name) throw new UsageError('A work order needs "name" (or a "deal" to name it after).');
  body.workOrderName = name;
  const contactId = plan.contact || (deal && idOf(deal.contact)) || null;
  let contact = null;
  if (contactId) {
    contact = await getOne(client, 'contact', contactId, 'firstName lastName email company', 'contact');
    body.contact = String(contact._id);
  } else {
    warnings.push('No contact: the work order will have no customer or company.');
  }
  if (plan.assignee) {
    const u = users.resolve(plan.assignee);
    body.assignee = u.id;
    if (!u.isMe) notifies.push(`${u.label} becomes responsible for the work order.`);
  } else {
    warnings.push('Nobody is responsible for the work order.');
  }
  if (plan.observations) body.observations = String(plan.observations).trim();
  if (plan.progressMethod) {
    const m = PROGRESS_METHODS.find((x) => x.toLowerCase() === String(plan.progressMethod).toLowerCase());
    if (!m) throw new UsageError(`"progressMethod" is one of: ${PROGRESS_METHODS.join(', ')}.`);
    body.progressMethod = m;
  }
  let group = null;
  if (plan.project) {
    group = await loadProject(client, plan.project);
    body.taskGroup = String(group._id);
    const others = await linkedWorkOrders(client, plan.project);
    if (others.length) warnings.push(`The project is already the task list of: ${others.map((w) => w.workOrderName).join(', ')}. Both work orders would share its tasks and progress.`);
  }
  warnings.push('It is created without a stage, like the work orders the app creates from approved deals. To start it, move it to "In execution" with prolibu-stages (that records the start time).');
  return {
    summary: {
      kind: 'workorder', name, deal: deal ? { id: deal._id, name: deal.dealName, written: false } : null,
      contact: contact ? { id: contact._id, name: fullName(contact) } : null, assignee: body.assignee ? users.resolve(plan.assignee).label : null,
      progressMethod: body.progressMethod || 'account default', project: group ? { id: group._id, name: group.groupName } : null,
    },
    body: { workOrder: body },
    versionOf: { plan, deal: deal && deal.updatedAt, group: group && group.updatedAt },
    blockers,
    warnings,
    notifies,
  };
}

async function planLink(client, plan) {
  if (!plan.workOrder || !plan.project) throw new UsageError('A link plan needs "workOrder" and "project".');
  const wo = await getOne(client, 'workorder', plan.workOrder, WO_SELECT, 'work order');
  const group = await loadProject(client, plan.project);
  const blockers = [];
  const warnings = [];
  if (idOf(wo.taskGroup) === String(group._id)) blockers.push('The work order already uses this project. Nothing to do.');
  else if (wo.taskGroup) warnings.push(`The work order already has another project (${idOf(wo.taskGroup)}): its tasks stop counting for this work order. They are not deleted.`);
  const tasks = await loadTasks(client, plan.project);
  warnings.push(`Progress is recalculated from the ${tasks.length} task(s) of "${group.groupName}".`);
  return {
    summary: { kind: 'link', workOrder: { id: wo._id, name: wo.workOrderName }, project: { id: group._id, name: group.groupName }, tasks: tasks.length },
    body: { taskGroup: String(group._id) },
    version: wo.updatedAt,
    blockers,
    warnings,
    notifies: [],
  };
}

function localSpan(span, offMin) {
  const fmt = (iso) => (iso ? new Date(new Date(iso).getTime() + offMin * 60e3).toISOString().slice(0, 16).replace('T', ' ') : null);
  return `${fmt(span.startAt) || '—'} → ${fmt(span.dueAt) || '—'}`;
}

async function planReschedule(client, plan) {
  if (!plan.project) throw new UsageError('A reschedule plan needs "project".');
  const hasShift = plan.shiftWorkingDays !== undefined;
  if (hasShift === (plan.newStart !== undefined)) throw new UsageError('Give "shiftWorkingDays" (e.g. 3 or -2) or "newStart" ("2026-11-16"), one of them.');
  const offMin = offsetMinutes(plan.offset);
  const group = await loadProject(client, plan.project);
  const wd = group.workingDays || {};
  const tasks = await loadTasks(client, plan.project);
  const stages = await loadStages(client, 'Task.stage');
  const doneStageIds = new Set(stages.filter((s) => s.endFlowStage).map((s) => String(s._id)));
  let n;
  const blockers = [];
  const warnings = [];
  if (hasShift) {
    n = Number(plan.shiftWorkingDays);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_SHIFT_DAYS) throw new UsageError(`"shiftWorkingDays" is a whole number of working days, not 0 (max ${MAX_SHIFT_DAYS}).`);
  } else {
    if (!DAY_RE.test(String(plan.newStart))) throw new UsageError('"newStart" is a day like "2026-11-16".');
    if (!isWorkingDay(plan.newStart, wd)) throw new UsageError(`${plan.newStart} is not a working day in this project's calendar. Pick a working day.`);
    const starts = tasks.filter((t) => plan.includeDone || !(t.stage && doneStageIds.has(idOf(t.stage))))
      .map((t) => saneTime(t.dates && t.dates.startAt)).filter((x) => x !== null);
    if (!starts.length) throw new Blocked('No open task has a start date, so there is no project start to move. Use "shiftWorkingDays".');
    const first = dayKey(Math.min(...starts), offMin);
    n = workingDaysBetween(first, plan.newStart, wd);
    if (n === 0) blockers.push(`The open tasks already start on ${first}. Nothing to move.`);
  }
  const { changes, skipped } = planShift(tasks, n, wd, offMin, { includeDone: !!plan.includeDone, doneStageIds });
  if (!changes.length) blockers.push('No task would move.');
  if (skipped.some((s) => s.reason.startsWith('broken'))) warnings.push('Some tasks have broken dates (before 2000); they are left as they are. Fix them in the app.');
  if (changes.some((c) => c.body.dates.dueReminderAt)) warnings.push('Reminders move with their due dates.');
  warnings.push('Each task is saved on its own (one change per task, like the app\'s timeline). Nobody is notified of date changes.');
  return {
    summary: {
      kind: 'reschedule', project: { id: group._id, name: group.groupName }, workingDaysMoved: n, calendar: describeCalendar(wd),
      moves: changes.length, skipped: skipped.length,
      sample: changes.slice(0, 15).map((c) => ({ title: c.title, from: localSpan(c.from, offMin), to: localSpan(c.to, offMin) })),
      skippedSample: skipped.slice(0, 10),
    },
    body: { changes },
    versionOf: { plan, group: group.updatedAt, tasks: tasks.map((t) => [t._id, t.updatedAt]) },
    blockers,
    warnings,
    notifies: [],
  };
}

async function planUnshare(client, plan) {
  if (!plan.project) throw new UsageError('An unshare plan needs "project".');
  const group = await loadProject(client, plan.project);
  const blockers = [];
  if (!(group.shareTimeline && group.shareTimeline.enabled)) blockers.push('The project timeline is not shared. Nothing to do.');
  return {
    summary: { kind: 'unshare', project: { id: group._id, name: group.groupName }, link: group.shareTimeline && group.shareTimeline.timelineUrl ? 'set' : 'none' },
    body: { shareTimeline: { enabled: false } },
    version: group.updatedAt,
    blockers,
    warnings: ['The public link stops working at once (it answers "sharing is disabled"). Turning sharing on again revives the SAME link: it cannot be changed.'],
    notifies: [],
  };
}

const PLANNERS = {
  project: planProject, tasks: planTasks, workorder: planWorkOrder, link: planLink, reschedule: planReschedule, unshare: planUnshare,
};

async function planFor(client, plan) {
  const p = await PLANNERS[plan.kind](client, plan);
  p.version = p.version || hash(p.versionOf);
  return p;
}

// ─── Writers ───────────────────────────────────────────────────────────────────

async function createTasks(client, groupId, rows, startIndex) {
  const created = [];
  const problems = [];
  for (let i = 0; i < rows.length; i += 1) {
    const body = taskBody(rows[i], groupId, startIndex + i * 1000000);
    const res = await client.request('POST', '/v2/task', { data: body, confirmed: true });
    if (!res.ok) {
      problems.push(`Task ${i + 1} ("${rows[i].title}") failed: ${(res.body && (res.body.error || res.body.message)) || res.status}. The tasks before it were created; stop and tell the user.`);
      if (res.status === 403) { const e = new Error(`POST /v2/task answered 403: ${res.body && res.body.error}`); e.status = 403; e.partial = created; throw e; }
      break;
    }
    created.push({ row: rows[i], id: String(res.body._id), code: res.body.taskCode });
  }
  // The gantt stores a link on the predecessor: its `dependencies` lists the tasks that follow it.
  const successors = {};
  for (const c of created) {
    if (c.row.after === undefined) continue;
    const pred = created.find((x) => x.row.index === c.row.after);
    if (pred) (successors[pred.id] = successors[pred.id] || []).push(c.id);
  }
  for (const [predId, next] of Object.entries(successors)) {
    const res = await client.request('PATCH', `/v2/task/${predId}`, { data: { dependencies: next }, confirmed: true });
    if (!res.ok) problems.push(`Linking task ${predId} to the tasks after it failed: ${(res.body && res.body.error) || res.status}.`);
  }
  return { created, problems };
}

async function verifyTasks(client, groupId, created) {
  const problems = [];
  const saved = await loadTasks(client, groupId);
  const byId = Object.fromEntries(saved.map((t) => [String(t._id), t]));
  for (const c of created) {
    const t = byId[c.id];
    if (!t) { problems.push(`Task "${c.row.title}" does not show in the project.`); continue; }
    if (c.row.assignee && idOf(t.assignee) !== c.row.assignee) problems.push(`Task "${c.row.title}": assignee did not save as sent.`);
    if (c.row.dueAt !== undefined && saneTime(t.dates && t.dates.dueAt) !== Math.floor(c.row.dueAt / 60e3) * 60e3) problems.push(`Task "${c.row.title}": due date did not save as sent.`);
  }
  return { problems, total: saved.length };
}

async function applyPlan(client, plan, p) {
  if (plan.kind === 'project') {
    const res = await client.request('POST', '/v2/group', { data: p.body.group, confirmed: true });
    if (!res.ok) {
      const err = new Error(`POST /v2/group answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
      err.status = res.status;
      throw err;
    }
    const groupId = String(res.body._id);
    const { created, problems } = await createTasks(client, groupId, p.body.tasks, 1000000);
    let linked = null;
    if (p.wo) {
      const r = await client.request('PATCH', `/v2/workorder/${p.wo._id}`, { data: { taskGroup: groupId }, confirmed: true });
      if (!r.ok) problems.push(`The project was created but linking it to the work order failed: ${(r.body && r.body.error) || r.status}.`);
      else linked = { id: p.wo._id, name: p.wo.workOrderName };
    }
    const group = await loadProject(client, groupId);
    const check = await verifyTasks(client, groupId, created);
    if (!group.collaborators || !p.body.group.collaborators.every((m) => group.collaborators.map(String).includes(m))) problems.push('Some members did not save.');
    return {
      saved: problems.length + check.problems.length === 0,
      project: { id: groupId, code: group.groupCode, name: group.groupName, tasks: check.total, shared: !!(group.shareTimeline && group.shareTimeline.enabled) },
      created: created.map((c) => ({ id: c.id, code: c.code, title: c.row.title })),
      workOrder: linked,
      problems: [...problems, ...check.problems],
    };
  }
  if (plan.kind === 'tasks') {
    const { created, problems } = await createTasks(client, plan.project, p.body.tasks, p.body.startIndex);
    const check = await verifyTasks(client, plan.project, created);
    const wos = await linkedWorkOrders(client, plan.project);
    let progress = [];
    if (wos.length) {
      const body = await call(client, 'GET', `/v2/workorder?${qs({ xquery: { taskGroup: plan.project }, select: 'workOrderName progress tasksCount doneTasksCount', limit: 10 })}`).catch(() => ({ data: [] }));
      progress = (body.data || []).map((w) => ({ name: w.workOrderName, progress: w.progress, tasks: w.tasksCount, done: w.doneTasksCount }));
    }
    return {
      saved: problems.length + check.problems.length === 0,
      project: { id: plan.project, tasks: check.total },
      created: created.map((c) => ({ id: c.id, code: c.code, title: c.row.title })),
      workOrders: progress,
      problems: [...problems, ...check.problems],
    };
  }
  if (plan.kind === 'workorder') {
    const res = await client.request('POST', '/v2/workorder', { data: p.body.workOrder, confirmed: true });
    if (!res.ok) {
      const err = new Error(`POST /v2/workorder answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
      err.status = res.status;
      throw err;
    }
    const wo = await getOne(client, 'workorder', res.body._id, WO_SELECT, 'work order');
    const problems = [];
    for (const k of ['deal', 'contact', 'assignee', 'taskGroup']) {
      if (p.body.workOrder[k] && idOf(wo[k]) !== p.body.workOrder[k]) problems.push(`${k} did not save as sent.`);
    }
    return {
      saved: !problems.length,
      workOrder: {
        id: wo._id, code: wo.workOrderCode, name: wo.workOrderName, company: idOf(wo.company) || null, progressMethod: wo.progressMethod, progress: wo.progress, stage: idOf(wo.stage) || null,
      },
      problems,
    };
  }
  if (plan.kind === 'link') {
    const res = await client.request('PATCH', `/v2/workorder/${plan.workOrder}`, { data: p.body, confirmed: true });
    if (!res.ok) {
      const err = new Error(`PATCH /v2/workorder answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
      err.status = res.status;
      throw err;
    }
    const wo = await getOne(client, 'workorder', plan.workOrder, WO_SELECT, 'work order');
    const ok = idOf(wo.taskGroup) === p.body.taskGroup;
    return {
      saved: ok, workOrder: { id: wo._id, name: wo.workOrderName, progress: wo.progress, tasks: wo.tasksCount, done: wo.doneTasksCount }, problems: ok ? [] : ['taskGroup did not save.'],
    };
  }
  if (plan.kind === 'reschedule') {
    const done = [];
    const problems = [];
    for (const c of p.body.changes) {
      const res = await client.request('PATCH', `/v2/task/${c.id}`, { data: c.body, confirmed: true });
      if (!res.ok) {
        if (res.status === 403) { const e = new Error(`PATCH /v2/task answered 403: ${res.body && res.body.error} (${done.length} task(s) had already moved)`); e.status = 403; throw e; }
        problems.push(`"${c.title}" did not move: ${(res.body && res.body.error) || res.status}. ${done.length} task(s) moved before it; the rest did not. Tell the user.`);
        break;
      }
      done.push(c);
    }
    const after = await loadTasks(client, plan.project);
    const byId = Object.fromEntries(after.map((t) => [String(t._id), t]));
    for (const c of done) {
      const t = byId[c.id];
      if (!t || (c.to.dueAt && saneTime(t.dates && t.dates.dueAt) !== Math.floor(new Date(c.to.dueAt).getTime() / 60e3) * 60e3)) problems.push(`"${c.title}": the new due date did not save as sent.`);
    }
    return { saved: !problems.length, moved: done.length, of: p.body.changes.length, problems };
  }
  if (plan.kind === 'unshare') {
    const res = await client.request('PATCH', `/v2/group/${plan.project}`, { data: p.body, confirmed: true });
    if (!res.ok) {
      const err = new Error(`PATCH /v2/group answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
      err.status = res.status;
      throw err;
    }
    const g = await loadProject(client, plan.project);
    const ok = !(g.shareTimeline && g.shareTimeline.enabled);
    return { saved: ok, project: { id: g._id, name: g.groupName, shared: !ok }, problems: ok ? [] : ['Sharing is still on.'] };
  }
  throw new UsageError(`Unknown plan kind ${plan.kind}.`);
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdFind(client, [kind, ...words]) {
  const k = String(kind || '').toLowerCase();
  const term = words.join(' ').trim();
  if (!['project', 'workorder'].includes(k) || !term) throw new UsageError('Usage: find <domain> <project|workorder> <text>');
  if (k === 'project') {
    const body = await call(client, 'GET', `/v2/group/search?${qs({ term, select: 'groupName groupCode modelName updatedAt', limit: 20 })}`);
    const rows = (body.data || []).filter((g) => g.modelName === 'Task');
    return { matches: rows.map((g) => ({ id: g._id, name: g.groupName, code: g.groupCode })), note: rows.length ? undefined : 'No project of tasks matches. Groups of contacts or deals are not projects.' };
  }
  const body = await call(client, 'GET', `/v2/workorder/search?${qs({ term, select: 'workOrderName workOrderCode deal stage taskGroup isTemplate', limit: 20 })}`);
  return {
    matches: (body.data || []).map((w) => ({
      id: w._id, name: w.workOrderName, code: w.workOrderCode, deal: idOf(w.deal) || null, project: idOf(w.taskGroup) || null, template: !!w.isTemplate,
    })),
  };
}

async function userNames(client, ids) {
  const unique = [...new Set(ids.filter((x) => ID_RE.test(x)))];
  if (!unique.length) return {};
  const body = await call(client, 'GET', `/v2/user?${qs({ xquery: { _id: { $in: unique } }, select: 'firstName lastName email', limit: 200 })}`).catch(() => ({ data: [] }));
  return Object.fromEntries((body.data || []).map((u) => [String(u._id), fullName(u)]));
}

async function projectStatus(client, groupId, now, offMin) {
  const group = await loadProject(client, groupId);
  const tasks = await loadTasks(client, groupId);
  const stages = await loadStages(client, 'Task.stage');
  const stagesById = Object.fromEntries(stages.map((s) => [String(s._id), s]));
  const users = await userNames(client, [...tasks.map((t) => idOf(t.assignee)), ...(group.collaborators || []).map(String)]);
  const sum = summarize(tasks, { now, stagesById, offMin, users });
  const share = group.shareTimeline || {};
  return {
    project: {
      id: group._id, code: group.groupCode, name: group.groupName, description: group.description || null,
      members: (group.collaborators || []).map((id) => users[String(id)] || String(id)),
      calendar: describeCalendar(group.workingDays || {}),
      sharedPublicly: !!share.enabled,
    },
    ...sum,
    tasks: tasks.slice(0, 60).map((t) => ({
      id: t._id,
      title: t.titleText || plainText(t.title),
      stage: (stagesById[idOf(t.stage)] || {}).stageName || 'No stage (to do)',
      assignee: users[idOf(t.assignee)] || null,
      start: saneTime(t.dates && t.dates.startAt) !== null ? dayKey(saneTime(t.dates.startAt), offMin) : null,
      due: saneTime(t.dates && t.dates.dueAt) !== null ? dayKey(saneTime(t.dates.dueAt), offMin) : null,
    })),
    overdue: sum.overdue.slice(0, 30),
    dueSoon: sum.dueSoon.slice(0, 15),
    workOrders: (await linkedWorkOrders(client, groupId)).map((w) => ({ id: w._id, name: w.workOrderName })),
    notes: [
      share.enabled ? 'The timeline is shared through a public link that needs no sign-in (tasks, members\' names and e-mails). An "unshare" plan turns it off.' : undefined,
      sum.brokenDates ? `${sum.brokenDates} task(s) have broken dates (before 2000) and are not counted as overdue.` : undefined,
      tasks.length >= MAX_TASKS_READ ? `Only the first ${MAX_TASKS_READ} tasks were read.` : undefined,
    ].filter(Boolean),
  };
}

async function workOrderStatus(client, id, now, offMin) {
  const wo = await getOne(client, 'workorder', id, WO_SELECT, 'work order');
  const stages = await loadStages(client, 'WorkOrder.stage');
  const stage = stages.find((s) => String(s._id) === idOf(wo.stage));
  const moved = wo.pipelineStages && wo.pipelineStages.stage && wo.pipelineStages.stage.movedAt;
  const t = wo.time || {};
  let deal = null;
  if (wo.deal) {
    deal = await call(client, 'GET', `/v2/deal/${idOf(wo.deal)}?${qs({ select: 'dealName' })}`).then((d) => ({ id: d._id, name: d.dealName })).catch(() => ({ id: idOf(wo.deal), name: null }));
  }
  let contact = null;
  if (wo.contact) {
    contact = await call(client, 'GET', `/v2/contact/${idOf(wo.contact)}?${qs({ select: 'firstName lastName' })}`).then((c) => ({ id: c._id, name: fullName(c) })).catch(() => ({ id: idOf(wo.contact), name: null }));
  }
  const users = await userNames(client, [idOf(wo.assignee)]);
  const out = {
    workOrder: {
      id: wo._id, code: wo.workOrderCode, name: wo.workOrderName, template: !!wo.isTemplate,
      stage: stage ? stage.stageName : null, stageId: idOf(wo.stage) || null, inStageFor: moved ? humanDuration(now - new Date(moved).getTime()) : null,
      progress: wo.progress, progressMethod: wo.progressMethod, tasks: wo.tasksCount, doneTasks: wo.doneTasksCount,
      assignee: users[idOf(wo.assignee)] || idOf(wo.assignee) || null, deal, contact,
      startedAt: t.startedAt || null, completedAt: t.completedAt || null, cancelledAt: t.cancelledAt || null,
      executionTime: t.executionTime ? humanDuration(t.executionTime) : null,
      suspended: t.suspendedCount ? { times: t.suspendedCount, total: humanDuration(t.suspendedTime || 0), since: t.suspendedAt || null } : null,
      cancelled: wo.cancelled && wo.cancelled.reason ? wo.cancelled : null,
    },
    stages: stages.filter((s) => s.active !== false).map((s) => ({ id: s._id, name: s.stageName, closes: !!s.endFlowStage, percentage: s.percentage })),
  };
  if (!wo.stage) out.notes = ['No stage yet (work orders created from approved deals start without one). Moving it is done with prolibu-stages.'];
  if (wo.taskGroup) out.project = await projectStatus(client, idOf(wo.taskGroup), now, offMin).catch((err) => ({ error: err.message }));
  return out;
}

async function cmdStatus(client, [kind, id], flags) {
  const k = String(kind || '').toLowerCase();
  if (!['project', 'workorder'].includes(k) || !ID_RE.test(String(id))) throw new UsageError('Usage: status <domain> <project|workorder> <id> [--at <ISO date>] [--offset -05:00]');
  const now = flags.at ? new Date(flags.at).getTime() : Date.now();
  if (!Number.isFinite(now)) throw new UsageError('--at must be a date.');
  const offMin = flags.offset ? offsetMinutes(flags.offset) : 0;
  const result = k === 'project' ? await projectStatus(client, id, now, offMin) : await workOrderStatus(client, id, now, offMin);
  return { asOf: new Date(now).toISOString(), ...result };
}

async function cmdOptions(client) {
  const me = await loadMe(client);
  const prefs = await call(client, 'GET', '/v2/user/preferences').catch(() => ({}));
  const st = (s) => ({ id: s._id, name: s.stageName, code: s.stageCode, closes: !!s.endFlowStage, percentage: s.percentage });
  const woStages = await loadStages(client, 'WorkOrder.stage').catch((err) => {
    if (err.status === 403) return null;
    throw err;
  });
  return {
    me: { id: me._id, name: me.name, email: me.email, admin: me.isAdmin },
    timeZone: (prefs.locale && prefs.locale.timeZone) || null,
    taskStages: (await loadStages(client, 'Task.stage')).filter((s) => s.active !== false).map(st),
    workOrderStages: woStages ? woStages.filter((s) => s.active !== false).map(st) : 'This user may not read work orders (403).',
    progressMethods: PROGRESS_METHODS,
    workOrderRules: (prefs.modules && prefs.modules.operations && prefs.modules.operations.workOrders)
      || 'Not readable from here: blockCompleteWithPendingTasks, requireCancellationReason, stageOnAllTasksCompleted and the rest are set in the app (Settings → Operations).',
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planFor(client, plan);
  return {
    plan: p.summary,
    notifies: p.notifies,
    warnings: p.warnings,
    blockers: p.blockers,
    version: p.version,
    nextStep: p.blockers.length ? 'Blocked: tell the user why; do not apply.' : STOP,
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planFor(client, plan);
  if (p.version !== flags.version) throw new Blocked('Something changed since the preview (or this plan was already applied). Run preview again and show the user the new result.');
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  const result = await applyPlan(client, plan, p);
  return { ...result, notifies: p.notifies };
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
    else if (arg === '--at') flags.at = next();
    else if (arg === '--offset') flags.offset = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  find: cmdFind, status: cmdStatus, options: cmdOptions, preview: cmdPreview, apply: cmdApply,
};

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
    if (!handler || !domain) throw new UsageError(`Usage: projects.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (result.blockers && result.blockers.length) return BLOCKED;
    if (result.problems && result.problems.length) return 1;
    return 0;
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
  main, readPlan, buildTasks, taskBody, planShift, summarize, shiftDay, workingDaysBetween, workingDaysInRange, isWorkingDay, dayKey, localTime, cleanWorkingDays, offsetMinutes,
};
