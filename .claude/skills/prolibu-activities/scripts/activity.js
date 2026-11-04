#!/usr/bin/env node
'use strict';

// Logs activities (tasks, notes, meetings, calls) on a contact, company or deal the way the
// Prolibu app does it, and reads a record's activity history.
//
//   activity.js find    <domain> <contact|company|deal> <text>
//   activity.js options <domain>
//   activity.js history <domain> <contact|company|deal> <id> [--limit <n>]
//   activity.js preview <domain> '<plan json>'                 writes nothing; returns a version
//   activity.js apply   <domain> '<plan json>' --version <v> --confirmed
//
// The plan is inline JSON, or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A date and time with an explicit offset: the script never guesses a time zone.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const BLOCKED = 3;
const TITLE_MAX = 250; // Task.title max length on the server, HTML included.

// Parents the app logs activities on, and the id arrays it keeps for each kind of child.
// The server appends the child's id to `<child model>s` on the parent after saving it.
// Meetings and calls only have an array (and a tab in the app) on contacts.
const PARENTS = {
  contact: {
    model: 'Contact',
    path: 'contact',
    select: 'firstName lastName email company assignee updatedAt notes tasks meetings calls',
    arrays: { task: 'tasks', note: 'notes', meeting: 'meetings', call: 'calls' },
    name: (r) => [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || r._id,
  },
  company: {
    model: 'Company',
    path: 'company',
    select: 'companyName assignee updatedAt notes tasks',
    arrays: { task: 'tasks', note: 'notes' },
    name: (r) => r.companyName || r._id,
  },
  deal: {
    model: 'Deal',
    path: 'deal',
    select: 'dealName stage contact company assignee updatedAt notes tasks',
    arrays: { task: 'tasks', note: 'notes' },
    name: (r) => r.dealName || r._id,
  },
};

const TYPES = {
  task: { model: 'Task', path: 'task', text: 'title', textPlain: 'titleText' },
  note: { model: 'Note', path: 'note', text: 'content', textPlain: 'contentText' },
  meeting: { model: 'Meeting', path: 'meeting', text: 'title', textPlain: 'title' },
  call: { model: 'Call', path: 'call', text: 'summary', textPlain: 'summaryText' },
};

const PLAN_KEYS = {
  task: ['title', 'description', 'assignee', 'startAt', 'dueAt', 'reminder', 'stage', 'priority'],
  note: ['content'],
  meeting: ['title', 'description', 'assignee', 'startAt', 'endAt', 'mode', 'address', 'videoLink', 'attendees'],
  call: ['summary', 'assignee', 'channel', 'direction', 'stage', 'duration', 'scheduledAt'],
};

// Server enum for Task.dates.dueReminder and the offset each one applies to dueAt.
// 'Custom' needs its own date and is left to the app.
const REMINDERS = {
  'On Due Date': 0,
  '1 Minute': 60e3,
  '5 Minutes': 5 * 60e3,
  '10 Minutes': 10 * 60e3,
  '15 Minutes': 15 * 60e3,
  '30 Minutes': 30 * 60e3,
  '1 Hour': 3600e3,
  '6 Hours': 6 * 3600e3,
  '1 Day': 24 * 3600e3,
  '1 Week': 7 * 24 * 3600e3,
};

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The app's rich-text fields (task title, note, call summary, meeting description) store HTML.
// Plain text becomes paragraphs; blank lines split them, single line breaks become <br>.
function toHtml(text) {
  return String(text)
    .trim()
    .split(/\n\s*\n/)
    .map((para) => `<p>${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

function plainText(html, max = 160) {
  const text = String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function idOf(value) {
  if (value && typeof value === 'object') return value._id ? String(value._id) : null;
  return value ? String(value) : null;
}

function personName(user) {
  if (!user || typeof user !== 'object') return user ? String(user) : null;
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
}

// "2026-11-05T09:00:00-05:00" → ISO in UTC. The server keeps task due dates to the minute.
function parseDateTime(value, field, { toMinute = false } = {}) {
  if (typeof value !== 'string' || !DATETIME_RE.test(value.trim())) {
    throw new UsageError(`"${field}" must be a date and time with its UTC offset, like 2026-11-05T09:00:00-05:00. Ask the user for the time and their time zone.`);
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) throw new UsageError(`"${field}" is not a valid date.`);
  if (toMinute) date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function requireText(plan, field) {
  const value = plan[field];
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`The ${plan.type} needs "${field}".`);
  return value.trim();
}

function pickEnum(value, allowed, field) {
  const found = allowed.find((a) => a.toLowerCase() === String(value).trim().toLowerCase());
  if (!found) throw new UsageError(`"${field}" must be one of: ${allowed.join(', ')}.`);
  return found;
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
  if (!plan || typeof plan !== 'object') throw new UsageError('The plan must be a JSON object.');
  const type = String(plan.type || '').toLowerCase();
  if (!TYPES[type]) throw new UsageError('The plan needs "type": task, note, meeting or call.');
  const parent = plan.parent || {};
  const parentKey = String(parent.model || '').toLowerCase();
  if (!PARENTS[parentKey]) throw new UsageError('The plan needs "parent": {"model": "Contact" | "Company" | "Deal", "id": "<24 hex>"}.');
  if (!ID_RE.test(String(parent.id))) throw new UsageError('"parent.id" must be the record _id (24 hex characters).');
  if ('provider' in plan || 'inviteParticipants' in plan) {
    throw new UsageError('Calendar invitations (Google or Microsoft) are not sent from here: they e-mail every participant. The user creates those meetings in the app.');
  }
  const allowed = new Set(['type', 'parent', ...PLAN_KEYS[type]]);
  const unknown = Object.keys(plan).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new UsageError(`A ${type} plan does not take: ${unknown.join(', ')}. Allowed: ${PLAN_KEYS[type].join(', ')}.`);
  }
  return { ...plan, type, parent: { key: parentKey, id: String(parent.id) } };
}

function findStage(stages, value, field) {
  const wanted = String(value).trim().toLowerCase();
  const matches = stages.filter((s) => String(s._id) === wanted
    || String(s.stageCode || '').toLowerCase() === wanted
    || String(s.stageName || '').toLowerCase() === wanted);
  if (matches.length !== 1) {
    const names = stages.map((s) => s.stageName).join(', ');
    throw new UsageError(matches.length
      ? `"${field}" "${value}" matches several stages; use its id.`
      : `"${field}" "${value}" is not a stage here. Options: ${names}.`);
  }
  return matches[0];
}

// ctx: { parent (record), parentKey, closedStage (stage or null), me ({_id}), stages: {task, priority, call},
//        attendees: [{_id, name, email}] }. Returns the exact body, what to tell the user, and blockers.
function buildActivity(plan, ctx) {
  const { type } = plan;
  const T = TYPES[type];
  const P = PARENTS[ctx.parentKey];
  const parentId = String(ctx.parent._id);
  const body = { origin: { modelName: P.model, docId: parentId } };
  const warnings = [];
  const blockers = [];
  const notifies = [];
  const summary = { type, parent: { model: P.model, id: parentId, name: P.name(ctx.parent) } };

  if ((type === 'meeting' || type === 'call') && ctx.parentKey !== 'contact') {
    const contactId = idOf(ctx.parent.contact);
    blockers.push(`In the app, ${type}s are logged on contacts, not on a ${ctx.parentKey}: a ${ctx.parentKey} has no ${type}s list and would never show it.`
      + (contactId ? ` Log it on the deal's contact (${contactId}) instead.` : ' Log it on the contact who took part.'));
  }

  const meId = ctx.me ? String(ctx.me._id) : null;
  const parentAssignee = idOf(ctx.parent.assignee);
  function resolveAssignee(value) {
    const v = String(value).trim();
    if (v.toLowerCase() === 'me') return { value: meId, label: 'you', isMe: true };
    if (EMAIL_RE.test(v)) {
      const isMe = !!(ctx.me && ctx.me.email && ctx.me.email.toLowerCase() === v.toLowerCase());
      return { value: isMe ? meId : v.toLowerCase(), label: isMe ? `you (${v})` : v.toLowerCase(), isMe };
    }
    if (ID_RE.test(v) && (v === meId || v === parentAssignee)) {
      return { value: v, label: v === meId ? 'you' : 'the record\'s owner', isMe: v === meId };
    }
    throw new UsageError('"assignee" must be "me" or the user\'s e-mail (the server checks e-mails; a wrong id would be saved silently).');
  }
  function assign(value) {
    const a = resolveAssignee(value);
    body.assignee = a.value;
    summary.assignee = a.label;
    return a;
  }

  if (type === 'task') {
    const html = toHtml(requireText(plan, 'title'));
    if (html.length > TITLE_MAX) throw new UsageError(`The title is too long (${html.length} of ${TITLE_MAX} characters). Put the details in "description".`);
    body.title = html;
    summary.title = plainText(html);
    if (plan.description) body.description = String(plan.description).trim();
    if (plan.assignee) {
      const a = assign(plan.assignee);
      if (!a.isMe) notifies.push(`${a.label} is told the task was assigned to them (in the app, and by e-mail where their settings say so).`);
    } else {
      warnings.push('Nobody is responsible for this task. The app allows it, but ask the user who should do it.');
    }
    const dates = {};
    if (plan.startAt) dates.startAt = parseDateTime(plan.startAt, 'startAt');
    if (plan.dueAt) dates.dueAt = parseDateTime(plan.dueAt, 'dueAt', { toMinute: true });
    if (dates.startAt && dates.dueAt && dates.startAt > dates.dueAt) {
      throw new UsageError('"startAt" is after "dueAt". The server would accept it, so the script stops here: check the dates with the user.');
    }
    if (plan.reminder) {
      if (!dates.dueAt) throw new UsageError('A reminder needs "dueAt".');
      const reminder = pickEnum(plan.reminder, Object.keys(REMINDERS), 'reminder');
      dates.dueReminder = reminder;
      const at = new Date(new Date(dates.dueAt).getTime() - REMINDERS[reminder]);
      summary.reminderAt = at.toISOString();
      if (at.getTime() <= (ctx.now || Date.now())) {
        warnings.push(`The reminder time (${at.toISOString()}) has already passed: it will never be sent.`);
      } else {
        notifies.push(`At ${at.toISOString()} the assignee and you get a reminder (in the app, and by e-mail where their settings say so).`);
      }
    }
    if (Object.keys(dates).length) body.dates = dates;
    summary.dates = dates;
    if (plan.stage) {
      const s = findStage(ctx.stages.task || [], plan.stage, 'stage');
      body.stage = String(s._id);
      summary.stage = s.stageName;
    }
    if (plan.priority) {
      const s = findStage(ctx.stages.priority || [], plan.priority, 'priority');
      body.priority = String(s._id);
      summary.priority = s.stageName;
    }
  }

  if (type === 'note') {
    body.content = toHtml(requireText(plan, 'content'));
    summary.content = plainText(body.content);
  }

  if (type === 'meeting') {
    body.title = requireText(plan, 'title');
    summary.title = body.title;
    if (plan.description) body.description = toHtml(plan.description);
    if (!plan.startAt || !plan.endAt) throw new UsageError('A meeting needs "startAt" and "endAt".');
    body.dates = { startAt: parseDateTime(plan.startAt, 'startAt'), endAt: parseDateTime(plan.endAt, 'endAt') };
    if (body.dates.endAt <= body.dates.startAt) throw new UsageError('"endAt" must be after "startAt".');
    summary.dates = body.dates;
    const mode = pickEnum(plan.mode || '', ['In-person', 'Virtual'], 'mode');
    body.attendance = { mode };
    if (mode === 'In-person' && plan.address) body.attendance.address = String(plan.address).trim();
    if (mode === 'Virtual' && plan.videoLink) body.attendance.videoLink = String(plan.videoLink).trim();
    if (mode === 'In-person' && plan.videoLink) throw new UsageError('"videoLink" is for virtual meetings.');
    if (mode === 'Virtual' && plan.address) throw new UsageError('"address" is for in-person meetings.');
    summary.attendance = body.attendance;
    // Required by the server. The app defaults to the record's owner, else the current user.
    const a = assign(plan.assignee || (parentAssignee || 'me'));
    if (!plan.assignee) warnings.push(`Nobody was named as responsible: the app's default is used (${a.label}).`);
    if (Array.isArray(plan.attendees) && plan.attendees.length) {
      const ids = plan.attendees.map(String);
      if (ids.some((id) => !ID_RE.test(id))) throw new UsageError('"attendees" are contact ids (24 hex characters).');
      body.attendees = ids;
      const known = new Set((ctx.attendees || []).map((c) => String(c._id)));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) blockers.push(`These attendees are not contacts you can see: ${missing.join(', ')}.`);
      summary.attendees = (ctx.attendees || []).map((c) => c.name);
      warnings.push('Attendees are only listed on the meeting: no invitation or e-mail is sent from here.');
    }
  }

  if (type === 'call') {
    body.summary = toHtml(requireText(plan, 'summary'));
    summary.summary = plainText(body.summary);
    body.contact = parentId;
    body.channel = pickEnum(plan.channel || 'Phone', ['Phone', 'WhatsApp'], 'channel');
    body.direction = pickEnum(plan.direction || 'Outbound', ['Outbound', 'Inbound'], 'direction');
    summary.channel = body.channel;
    summary.direction = body.direction;
    if (plan.assignee) assign(plan.assignee);
    if (plan.stage) {
      const s = findStage(ctx.stages.call || [], plan.stage, 'stage');
      body.stage = String(s._id);
      summary.stage = s.stageName;
    }
    if (plan.duration !== undefined) {
      const seconds = Number(plan.duration);
      if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError('"duration" is the length of the call in seconds.');
      body.duration = Math.round(seconds);
      summary.durationSeconds = body.duration;
    }
    if (plan.scheduledAt) body.scheduledAt = parseDateTime(plan.scheduledAt, 'scheduledAt');
  }

  if (ctx.closedStage && !blockers.length) {
    warnings.push(`The deal is closed ("${ctx.closedStage.stageName}"). The app still lets you add notes and tasks to a closed deal, `
      + 'but some servers reject the link to the deal after saving the activity. apply checks the link and reports an unlinked activity if that happens.');
  }

  summary.textField = T.text;
  return { body, summary, warnings, blockers, notifies };
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

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();
}

async function loadParent(client, key, id) {
  const P = PARENTS[key];
  try {
    return await call(client, 'GET', `/v2/${P.path}/${id}?${qs({ select: P.select })}`);
  } catch (err) {
    if (err.status === 404) throw new Blocked(`No ${P.model} with id ${id} (or this user cannot see it). Nothing was written.`);
    if (err.status === 403) throw new Blocked(`This user may not read that ${P.model}. Nothing was written.`);
    throw err;
  }
}

async function loadStage(client, id) {
  if (!id) return null;
  try {
    return await call(client, 'GET', `/v2/stage/${idOf(id)}?${qs({ select: 'stageName endFlowStage' })}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function loadStages(client, stageType) {
  const body = await call(client, 'GET', `/v2/stage?${qs({ stageType, select: 'stageName stageCode endFlowStage active index', sort: 'index', limit: 100 })}`);
  return (body.data || []).filter((s) => s.active !== false);
}

async function loadMe(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || {};
  return {
    _id: p._id, firstName: p.firstName, lastName: p.lastName, email: p.email, timeZone: (p.locale && p.locale.timeZone) || null,
  };
}

async function gather(client, plan) {
  const parent = await loadParent(client, plan.parent.key, plan.parent.id);
  const ctx = {
    parent, parentKey: plan.parent.key, stages: {}, now: Date.now(), closedStage: null,
  };
  if (plan.parent.key === 'deal' && parent.stage) {
    const stage = await loadStage(client, parent.stage);
    if (stage && stage.endFlowStage) ctx.closedStage = stage;
  }
  const needsMe = String(plan.assignee || '').trim().toLowerCase() === 'me' || EMAIL_RE.test(String(plan.assignee || ''))
    || ID_RE.test(String(plan.assignee || '')) || (plan.type === 'meeting' && !plan.assignee);
  if (needsMe) ctx.me = await loadMe(client);
  if (plan.type === 'task' && plan.stage) ctx.stages.task = await loadStages(client, 'Task.stage');
  if (plan.type === 'task' && plan.priority) ctx.stages.priority = await loadStages(client, 'Task.priority');
  if (plan.type === 'call' && plan.stage) ctx.stages.call = await loadStages(client, 'Call.stage');
  if (plan.type === 'meeting' && Array.isArray(plan.attendees) && plan.attendees.length) {
    ctx.attendees = [];
    for (const id of plan.attendees.map(String).filter((x) => ID_RE.test(x))) {
      try {
        const c = await call(client, 'GET', `/v2/contact/${id}?${qs({ select: 'firstName lastName email' })}`);
        ctx.attendees.push({ _id: c._id, name: PARENTS.contact.name(c), email: c.email });
      } catch (err) {
        if (err.status !== 404 && err.status !== 403) throw err;
      }
    }
  }
  return ctx;
}

// Children that point at the parent through origin.docId, newest first.
async function listByOrigin(client, typeKey, parentId, select, limit = 50) {
  const T = TYPES[typeKey];
  const body = await call(client, 'GET', `/v2/${T.path}?${qs({
    xquery: JSON.stringify({ 'origin.docId': parentId }), select, sort: '-createdAt', limit,
  })}`);
  return body.data || [];
}

function sameInstant(a, b) {
  if (!a || !b) return a === b;
  return Math.floor(new Date(a).getTime() / 60e3) === Math.floor(new Date(b).getTime() / 60e3);
}

function checkSaved(type, body, saved) {
  const problems = [];
  const T = TYPES[type];
  if (!saved.origin || String(saved.origin.docId) !== body.origin.docId) problems.push('origin did not save as sent.');
  if (saved[T.text] !== body[T.text]) problems.push(`${T.text} did not save as sent.`);
  if (body.assignee && !saved.assignee) problems.push('assignee did not save.');
  if (body.assignee && ID_RE.test(body.assignee) && idOf(saved.assignee) !== body.assignee) problems.push('assignee did not save as sent.');
  for (const field of ['startAt', 'dueAt', 'endAt']) {
    const sent = body.dates && body.dates[field];
    if (sent && !sameInstant(sent, saved.dates && saved.dates[field])) problems.push(`dates.${field} did not save as sent.`);
  }
  if (body.dates && body.dates.dueReminder && !(saved.dates && saved.dates.dueReminderAt)) problems.push('The reminder time was not set.');
  for (const field of ['stage', 'priority', 'contact']) {
    if (body[field] && idOf(saved[field]) !== body[field]) problems.push(`${field} did not save as sent.`);
  }
  if (type === 'meeting' && saved.provider) problems.push('The meeting has a calendar provider set.');
  return problems;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdFind(client, [kind, ...words]) {
  const key = String(kind || '').toLowerCase();
  const term = words.join(' ').trim();
  if (!PARENTS[key] || !term) throw new UsageError('Usage: find <domain> <contact|company|deal> <text>');
  const P = PARENTS[key];
  const select = { contact: 'firstName lastName email company', company: 'companyName', deal: 'dealName stage contact company' }[key];
  const body = await call(client, 'GET', `/v2/${P.path}/search?${qs({ term, limit: 10, select })}`);
  const rows = body.data || [];
  const stageIds = [...new Set(rows.map((r) => idOf(r.stage)).filter(Boolean))];
  const stages = {};
  if (stageIds.length) {
    const s = await call(client, 'GET', `/v2/stage?${qs({ xquery: JSON.stringify({ _id: { $in: stageIds } }), select: 'stageName endFlowStage', limit: 100 })}`);
    for (const st of s.data || []) stages[String(st._id)] = st;
  }
  return {
    model: P.model,
    matches: rows.map((r) => {
      const out = { id: r._id, name: P.name(r) };
      if (key === 'contact') out.email = r.email || null;
      if (key === 'deal') {
        const st = stages[idOf(r.stage)];
        out.stage = st ? st.stageName : null;
        out.closed = !!(st && st.endFlowStage);
        out.contact = idOf(r.contact);
      }
      return out;
    }),
  };
}

async function cmdOptions(client) {
  const me = await loadMe(client);
  const prefs = await call(client, 'GET', '/v2/user/preferences');
  const stage = (s) => ({ id: s._id, name: s.stageName, closes: !!s.endFlowStage });
  return {
    me: { id: me._id, name: personName(me), email: me.email },
    timeZone: me.timeZone || (prefs.locale && prefs.locale.timeZone) || null,
    taskStages: (await loadStages(client, 'Task.stage')).map(stage),
    taskPriorities: (await loadStages(client, 'Task.priority')).map(stage),
    callStages: (await loadStages(client, 'Call.stage')).map(stage),
    reminders: Object.keys(REMINDERS),
    meetingModes: ['In-person', 'Virtual'],
    callChannels: ['Phone', 'WhatsApp'],
    callDirections: ['Outbound', 'Inbound'],
  };
}

const ACTIVITY_KINDS = {
  notes: { type: 'note', text: (x) => x.content },
  tasks: { type: 'task', text: (x) => x.title, status: (x) => x.stage && x.stage.stageName },
  emails: { type: 'email', text: (x) => x.subject || x.message },
  calls: { type: 'call', text: (x) => x.summary, status: (x) => (x.stage && x.stage.stageName) || x.channel },
  meetings: { type: 'meeting', text: (x) => x.title, status: (x) => x.status, when: (x) => x.dates && x.dates.startAt },
  deals: { type: 'deal', text: (x) => x.dealName, status: (x) => x.stage && x.stage.stageName },
  contracts: { type: 'contract', text: (x) => x.contractName, status: (x) => x.status },
  presentations: { type: 'presentation', text: (x) => x.title },
};

function feedItems(activity, extra = {}) {
  const items = [];
  for (const [kind, cfg] of Object.entries(ACTIVITY_KINDS)) {
    for (const x of (activity && activity[kind]) || []) {
      const item = {
        type: cfg.type, id: x._id, date: x.updatedAt || x.createdAt, by: personName(x.createdBy), text: plainText(cfg.text(x)), ...extra,
      };
      if (cfg.status && cfg.status(x)) item.status = cfg.status(x);
      if (cfg.when && cfg.when(x)) item.scheduledFor = cfg.when(x);
      items.push(item);
    }
  }
  return items;
}

const POPULATE_BY = [{ path: 'createdBy', select: 'firstName lastName' }];

async function cmdHistory(client, [kind, id], flags) {
  const key = String(kind || '').toLowerCase();
  if (!PARENTS[key] || !ID_RE.test(String(id))) throw new UsageError('Usage: history <domain> <contact|company|deal> <id> [--limit <n>]');
  const limit = flags.limit ? Number(flags.limit) : 30;
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive whole number.');
  const P = PARENTS[key];
  const parent = await loadParent(client, key, id);
  let items = [];
  const out = { parent: { model: P.model, id: parent._id, name: P.name(parent) } };

  if (key === 'contact') {
    // The app's Activity tab: one findOne with outputFormat=activity.
    const doc = await call(client, 'GET', `/v2/contact/${id}?${qs({ outputFormat: 'activity' })}`);
    items = feedItems(doc.activity);
  } else if (key === 'company') {
    // The app's Activity tab groups the activity of the company's contacts;
    // its own notes and tasks live in their own tabs.
    const doc = await call(client, 'GET', `/v2/company/${id}?${qs({ outputFormat: 'activity', select: P.select })}`);
    for (const c of doc.contacts || []) items.push(...feedItems(c.activity, { contact: PARENTS.contact.name(c) }));
  } else {
    // A deal has Notes and Tasks tabs, and its history is the stage history.
    const stage = await loadStage(client, parent.stage);
    out.parent.stage = stage ? stage.stageName : null;
    out.parent.closed = !!(stage && stage.endFlowStage);
    const moves = await call(client, 'GET', `/v2/stagehistory?${qs({
      xquery: JSON.stringify({ 'origin.docId': id, stageField: 'stage' }),
      sort: '-movedAt',
      limit: 100,
      populatePath: JSON.stringify([{ path: 'fromStage', select: 'stageName' }, { path: 'toStage', select: 'stageName' }, { path: 'movedBy', select: 'firstName lastName' }]),
    })}`);
    for (const m of moves.data || []) {
      items.push({
        type: 'stage', id: m._id, date: m.movedAt, by: personName(m.movedBy), text: `${(m.fromStage && m.fromStage.stageName) || '—'} → ${(m.toStage && m.toStage.stageName) || '—'}`,
      });
    }
  }

  if (key !== 'contact') {
    const doc = await call(client, 'GET', `/v2/${P.path}/${id}?${qs({
      select: 'notes tasks',
      populatePath: JSON.stringify([
        { path: 'notes', select: 'content createdAt updatedAt createdBy', populate: POPULATE_BY },
        { path: 'tasks', select: 'title createdAt updatedAt createdBy stage assignee dates', populate: [...POPULATE_BY, { path: 'stage', select: 'stageName' }] },
      ]),
    })}`);
    items.push(...feedItems({ notes: (doc.notes || []).filter(Boolean), tasks: (doc.tasks || []).filter(Boolean) }));
  }

  // Activities that point at this record but are missing from its lists: the app never shows them.
  const unlinked = [];
  for (const typeKey of Object.keys(TYPES)) {
    const T = TYPES[typeKey];
    const linked = new Set(((P.arrays[typeKey] && parent[P.arrays[typeKey]]) || []).map(idOf));
    const rows = await listByOrigin(client, typeKey, id, `${T.textPlain} createdAt`);
    for (const r of rows) {
      if (!linked.has(String(r._id))) unlinked.push({ type: typeKey, id: r._id, date: r.createdAt, text: plainText(r[T.textPlain]) });
    }
  }

  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const counts = {};
  for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
  return {
    ...out,
    total: items.length,
    counts,
    items: items.slice(0, limit),
    unlinked,
    note: unlinked.length
      ? 'unlinked: activities that point at this record but are not in its lists, so the app does not show them here.'
      : undefined,
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const data = await gather(client, plan);
  const built = buildActivity(plan, data);
  return {
    activity: built.summary,
    body: built.body,
    notifies: built.notifies,
    warnings: built.warnings,
    blockers: built.blockers,
    version: data.parent.updatedAt,
    nextStep: built.blockers.length
      ? 'Blocked: tell the user why; do not apply.'
      : 'Show this to the user in plain words. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version.',
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const data = await gather(client, plan);
  if (data.parent.updatedAt !== flags.version) {
    throw new Blocked('The record changed since the preview (or this activity was already saved). Run history to check, then preview again.');
  }
  const built = buildActivity(plan, data);
  if (built.blockers.length) throw new Blocked(built.blockers.join(' '));

  const T = TYPES[plan.type];
  const P = PARENTS[plan.parent.key];
  const res = await client.request('POST', `/v2/${T.path}`, { data: built.body, confirmed: true });
  if (!res.ok) {
    // The server saves the activity first and links it to the record afterwards, without undoing
    // the save when the link fails. Look for what it may have left behind.
    const error = (res.body && (res.body.error || res.body.message)) || `status ${res.status}`;
    const rows = await listByOrigin(client, plan.type, plan.parent.id, `${T.text} ${T.textPlain} createdAt`, 10).catch(() => []);
    const orphan = rows.find((r) => r[T.text] === built.body[T.text]);
    return {
      saved: false,
      error,
      orphan: orphan ? { type: plan.type, id: orphan._id } : null,
      problems: [orphan
        ? `The server answered an error but kept the ${plan.type} (${orphan._id}) without linking it to the ${P.model}. Tell the user; removing it needs its own yes.`
        : `The server answered an error and no ${plan.type} was found: nothing was saved.`],
    };
  }

  const created = res.body;
  const saved = await call(client, 'GET', `/v2/${T.path}/${created._id}`);
  const problems = checkSaved(plan.type, built.body, saved);
  const after = await loadParent(client, plan.parent.key, plan.parent.id);
  const arrayField = P.arrays[plan.type];
  const linked = !!arrayField && (after[arrayField] || []).map(idOf).includes(String(created._id));
  if (arrayField && !linked) {
    problems.push(`The ${plan.type} was saved but the ${P.model} does not list it, so the app will not show it there.`);
  }
  return {
    saved: problems.length === 0,
    created: { type: plan.type, id: created._id, code: saved.taskCode || saved.noteCode || saved.meetingCode || saved.callCode },
    parent: { model: P.model, id: plan.parent.id, name: P.name(after) },
    linked,
    savedValues: {
      text: plainText(saved[T.text]),
      assignee: idOf(saved.assignee),
      dates: saved.dates,
      stage: idOf(saved.stage),
      priority: idOf(saved.priority),
      attendees: saved.attendees,
      participantsEmails: plan.type === 'meeting' ? (saved.participantsEmails || []).length : undefined,
    },
    notifies: built.notifies,
    problems,
  };
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
    else if (arg === '--limit') flags.limit = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  find: cmdFind, options: cmdOptions, history: cmdHistory, preview: cmdPreview, apply: cmdApply,
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
    if (!handler || !domain) throw new UsageError('Usage: activity.js <find|options|history|preview|apply> <domain> …');
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
  main, buildActivity, readPlan, toHtml, plainText, parseDateTime, checkSaved,
};
