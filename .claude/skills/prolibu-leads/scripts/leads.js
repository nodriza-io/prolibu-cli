#!/usr/bin/env node
'use strict';

// Leads, follow-up protocols and sales goals, the way the Prolibu app handles them.
//
//   leads.js leads        <domain> [--stage new|reviewing|qualified|discarded|converted] [--source <s>] [--assignee <email>] [--search <text>] [--limit <n>]
//   leads.js show         <domain> <lead e-mail | id>          lead + duplicate check against contacts
//   leads.js submissions  <domain> <contact e-mail | id> [--limit <n>]
//   leads.js protocols    <domain> [--entity Contact|Deal|Call]
//   leads.js diagnose     <domain> <record id | contact e-mail> [--entity Contact|Deal|Call]
//   leads.js goals        <domain> [--period YYYY-MM] [--assignee <email>]
//   leads.js preview      <domain> '<plan>'                    writes nothing; returns a version
//   leads.js apply        <domain> '<plan>' --version <v> --confirmed [--reaches-people]
//
// Plan kinds: triage | assign | convert | protocol | pause | goal (see SKILL.md for each shape).
// Plans are inline JSON or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED = 3;
const MAX_LEADS = 200;
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_STEP_MS = 10 * 365 * DAY;
const ENTITIES = ['Contact', 'Deal', 'Call'];
const ACTION_TYPES = ['call', 'whatsapp', 'email'];
const LEAD_STAGE_CODES = {
  reviewing: 'lead-stage-reviewing',
  qualified: 'lead-stage-qualified',
  discarded: 'lead-stage-discarded',
  converted: 'lead-stage-converted',
};
const LEAD_SELECT = 'firstName lastName email mobile whatsapp phones otherEmails companyName description stage assignee '
  + 'converted convertedAt convertedTo source tags adCampaignMeta createdAt updatedAt';
const CONTACT_SELECT = 'firstName lastName email mobile phonesText assignee createdAt';
const PROTOCOL_KEYS = new Set(['contactProtocolName', 'entity', 'stages', 'country', 'flow', 'tags', 'allowEveryone', 'active']);
const STEP_KEYS = new Set(['actionType', 'actionName', 'time', 'delay', 'subject', 'messageTemplate', 'conversationFlow']);
const GOAL_KEYS = new Set(['id', 'assignee', 'period', 'startDate', 'endDate', 'targetValue', 'currency', 'goalName']);

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
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normName = (s) => deaccent(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');

// A regex that matches the text with or without accents (the server's searchText keeps them).
function accentInsensitive(text) {
  const groups = { a: '[aáàäâ]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöô]', u: '[uúùüû]', n: '[nñ]' };
  return [...normName(text)].map((ch) => groups[ch] || escapeRegex(ch)).join('');
}

function bigrams(s) {
  const t = normName(s).replace(/ /g, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

// Dice coefficient on letter pairs: 1 = same name, ignoring accents, case and spacing.
function nameSimilarity(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.length || !y.length) return normName(a) === normName(b) && normName(a) ? 1 : 0;
  const pool = [...y];
  let hits = 0;
  for (const g of x) {
    const at = pool.indexOf(g);
    if (at !== -1) {
      hits += 1;
      pool.splice(at, 1);
    }
  }
  return (2 * hits) / (x.length + y.length);
}

function phonesOf(record) {
  const list = [record.mobile, record.whatsapp, ...((record.phones || []).map((p) => p && p.number))];
  // The last 8 digits match with or without country code or a leading 0.
  return [...new Set(list.map(digits).filter((d) => d.length >= 7).map((d) => d.slice(-8)))];
}

// "30m", "2h", "3d" or a number of milliseconds → milliseconds.
function parseDelay(value) {
  if (typeof value === 'number') return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|hrs?|d|days?)\s*$/i.exec(String(value));
  if (!m) throw new UsageError(`Invalid delay "${value}". Use 30m, 2h, 3d or a number of milliseconds in "time".`);
  const unit = m[2].toLowerCase();
  const factor = unit.startsWith('m') ? MINUTE : unit.startsWith('h') ? HOUR : DAY;
  return Math.round(Number(m[1]) * factor);
}

function humanDelay(ms) {
  if (!ms) return 'immediately';
  if (ms % DAY === 0) return `${ms / DAY} day(s)`;
  if (ms % HOUR === 0) return `${ms / HOUR} hour(s)`;
  if (ms % MINUTE === 0) return `${ms / MINUTE} minute(s)`;
  return `${ms} ms`;
}

// Period "YYYY-MM" → first and last day; or explicit start/end dates.
function periodOf(item) {
  if (item.period !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(item.period));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new UsageError(`Invalid period "${item.period}". Use YYYY-MM.`);
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return { startDate: `${m[1]}-${m[2]}-01`, endDate: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
  }
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (!ok(item.startDate) || !ok(item.endDate)) throw new UsageError('Each goal needs "period": "YYYY-MM", or "startDate" and "endDate" as YYYY-MM-DD.');
  if (item.endDate < item.startDate) throw new UsageError(`Goal for ${item.assignee}: endDate is before startDate.`);
  return { startDate: item.startDate, endDate: item.endDate };
}

const day = (d) => (d ? String(d).slice(0, 10) : null);

// Who the app shows on a board card: the protocols whose stages include the card's stage, then
// one for the contact's country, else one without country, else none.
function pickProtocol(protocols, stageId, country) {
  const flows = protocols.filter((p) => (p.stages || []).map(idOf).includes(String(stageId)));
  if (!flows.length) return { protocol: null, candidates: [] };
  const byCountry = country ? flows.find((p) => p.country === country) : null;
  return { protocol: byCountry || flows.find((p) => !p.country) || null, candidates: flows };
}

// The badge's delay: a time below 1000 is read as hours, anything else as milliseconds.
const badgeDelayMs = (t) => (t > 0 && t < 1000 ? t * HOUR : t || 0);

// Walks the flow like the board badge: each step is done by the next call/WhatsApp call/e-mail
// created after the stage move; the first pending step is overdue once its delay has passed.
function walkBadge(flow, movedAt, activities, now = new Date()) {
  const lists = {
    call: activities.calls.filter((c) => c.channel === 'Phone'),
    whatsapp: activities.calls.filter((c) => c.channel === 'WhatsApp'),
    email: activities.emails,
  };
  const after = (list) => list.filter((a) => new Date(a.createdAt) >= movedAt).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const done = { call: after(lists.call), whatsapp: after(lists.whatsapp), email: after(lists.email) };
  const used = { call: 0, whatsapp: 0, email: 0 };
  let last = movedAt;
  const steps = [];
  let stopped = false;
  for (let i = 0; i < flow.length; i += 1) {
    const step = flow[i] || {};
    const type = step.actionType;
    if (!ACTION_TYPES.includes(type)) {
      steps.push({ step: i + 1, actionType: type, state: 'ignored', note: 'Unknown action type: the badge skips it.' });
      continue;
    }
    if (stopped) {
      steps.push({ step: i + 1, actionType: type, actionName: step.actionName, state: 'later' });
      continue;
    }
    if (used[type] < done[type].length) {
      last = new Date(done[type][used[type]].createdAt);
      used[type] += 1;
      steps.push({ step: i + 1, actionType: type, actionName: step.actionName, state: 'done', at: last.toISOString() });
      continue;
    }
    const due = new Date(last.getTime() + badgeDelayMs(step.time));
    steps.push({
      step: i + 1, actionType: type, actionName: step.actionName, state: now >= due ? 'overdue' : 'pending', dueAt: due.toISOString(),
    });
    stopped = true;
  }
  return steps;
}

// Lints of one protocol flow (the same checks the preview blocks on).
function flowProblems(flow) {
  const blockers = [];
  const warnings = [];
  (flow || []).forEach((step, i) => {
    const n = i + 1;
    const t = Number(step && step.time);
    if (!step || !ACTION_TYPES.includes(step.actionType)) blockers.push(`Step ${n}: actionType must be call, whatsapp or email.`);
    if (!Number.isFinite(t) || t < 0 || t > MAX_STEP_MS) blockers.push(`Step ${n}: the delay must be between 0 and 10 years.`);
    else if (t > 0 && t < MINUTE) blockers.push(`Step ${n}: a delay under one minute (${t}) is read as hours on the board when below 1000. Use 30m, 2h or 3d.`);
    if (step && step.actionType === 'email' && !String(step.subject || '').trim()) {
      blockers.push(`Step ${n}: an e-mail step needs its own subject. Without it the cadence skips the step (the template's subject is not used).`);
    }
    if (step && step.actionType === 'email' && !step.messageTemplate) blockers.push(`Step ${n}: an e-mail step needs a messageTemplate (the e-mail body).`);
    if (step && step.actionType !== 'email') warnings.push(`Step ${n} (${step && step.actionType}): a reminder for the seller on the board; nothing is sent automatically.`);
    if (!step || !String(step.actionName || '').trim()) warnings.push(`Step ${n}: no actionName; the board tooltip will be generic.`);
  });
  return { blockers, warnings };
}

// Round robin: lead i goes to user (start + i) mod n, in the order given. The group itself is never rewritten.
function roundRobin(leads, users, startAt = 0) {
  return leads.map((lead, i) => ({ lead, user: users[(startAt + i) % users.length] }));
}

// ─── API helpers ───────────────────────────────────────────────────────────────

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim()) throw new UsageError('Missing the plan (inline JSON or a temp file path).');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the plan file ${arg}.`);
    }
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  return plan;
}

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

async function list(client, object, params) {
  return rowsOf(await call(client, 'GET', `/v2/${object}?${qs(params)}`));
}

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || body;
  return { _id: idOf(p), email: p.email, name: fullName(p) };
}

async function preferences(client) {
  const body = await call(client, 'GET', '/v2/user/preferences');
  const p = body.preferences || body;
  const get = (path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), p);
  return {
    leads: get('modules.directory.leads.enabled') === true,
    contactProtocols: get('modules.directory.contacts.contactProtocols.enabled') === true,
    goals: get('modules.sales.goals.enabled') === true,
    habeasData: get('modules.sales.emailCampaigns.habeasData') || {},
  };
}

const PREF_NOTE = {
  leads: 'The Leads menu is hidden on this account (preference Leads off). The API works anyway; an admin turns it on in the app settings.',
  contactProtocols: 'Follow-up badges are off on this account (preference Contact protocols off): boards show no badge. An admin turns it on in the app settings.',
  goals: 'The Goals menu is hidden on this account (preference Goals off). Goals still feed reports; an admin turns the menu on in the app settings.',
};

async function users(client, query) {
  return list(client, 'user', { xquery: query, select: 'firstName lastName email status', limit: '200' });
}

async function userByEmail(client, email) {
  const rows = await users(client, { email: String(email).toLowerCase().trim() });
  if (!rows.length) throw new Blocked(`No user with e-mail ${email}.`);
  return rows[0];
}

const userView = (u) => (u ? { _id: idOf(u), email: u.email || null, name: fullName(u), status: u.status || null } : null);

async function leadStages(client) {
  const rows = await list(client, 'stage', { xquery: { stageType: 'Lead.stage' }, select: 'stageName stageCode endFlowStage', limit: '50' });
  const byKey = {};
  for (const [key, code] of Object.entries(LEAD_STAGE_CODES)) byKey[key] = rows.find((s) => s.stageCode === code) || null;
  return { rows, byKey };
}

function resolveLeadStage(stages, ref) {
  if (ref === null || ref === 'new' || ref === '') return { key: 'new', _id: null, name: 'New (no stage)' };
  const text = normName(ref);
  const hit = Object.entries(stages.byKey).find(([key, s]) => s && (key === text || idOf(s) === String(ref) || s.stageCode === ref || normName(s.stageName) === text));
  if (hit) return { key: hit[0], _id: idOf(hit[1]), name: hit[1].stageName };
  const other = stages.rows.find((s) => idOf(s) === String(ref) || s.stageCode === ref || normName(s.stageName) === text);
  if (other) return { key: other.stageCode, _id: idOf(other), name: other.stageName };
  throw new Blocked(`"${ref}" is not a stage of the Lead pipeline. Use new, reviewing, qualified or discarded.`);
}

const stageName = (stages, id) => {
  if (!id) return 'New (no stage)';
  const s = stages.rows.find((r) => idOf(r) === idOf(id));
  return s ? s.stageName : `${idOf(id)} (not a Lead stage)`;
};

async function findLead(client, ref) {
  const r = String(ref || '').trim();
  if (!r) throw new UsageError('A lead is given by its e-mail or id.');
  const query = ID_RE.test(r) ? { _id: r } : { email: r.toLowerCase() };
  const rows = await list(client, 'lead', {
    xquery: query, select: LEAD_SELECT, limit: '1', populatePath: [{ path: 'assignee', select: 'firstName lastName email' }],
  });
  if (!rows.length) throw new Blocked(`No lead ${r} visible to this profile.`);
  return rows[0];
}

function leadView(lead, stages) {
  return {
    _id: idOf(lead),
    name: fullName(lead),
    email: lead.email,
    companyName: lead.companyName || null,
    phones: phonesOf(lead),
    stage: stageName(stages, lead.stage),
    assignee: userView(lead.assignee && typeof lead.assignee === 'object' ? lead.assignee : null) || (lead.assignee ? { _id: idOf(lead.assignee) } : null),
    source: lead.source || null,
    converted: lead.converted === true,
    convertedTo: lead.convertedTo ? idOf(lead.convertedTo) : null,
    hasDescription: Boolean(String(lead.description || '').trim()),
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

const contactView = (c, why) => ({
  _id: idOf(c), name: fullName(c), email: c.email || null, phones: phonesOf(c), why,
});

// The server only refuses a conversion when a contact has the exact same e-mail. This adds the
// checks it lacks: other e-mails, phone and a similar name. Only contacts the profile can see count.
async function duplicates(client, lead) {
  const exact = await list(client, 'contact', { xquery: { email: String(lead.email || '').toLowerCase() }, select: CONTACT_SELECT, limit: '5' });
  const similar = new Map();
  const add = (c, why) => {
    if (exact.some((e) => idOf(e) === idOf(c))) return;
    const prev = similar.get(idOf(c));
    similar.set(idOf(c), prev ? { ...prev, why: `${prev.why}; ${why}` } : contactView(c, why));
  };
  const otherEmails = (lead.otherEmails || []).map((o) => o && String(o.email || '').toLowerCase()).filter(Boolean);
  if (otherEmails.length) {
    for (const c of await list(client, 'contact', { xquery: { email: { $in: otherEmails } }, select: CONTACT_SELECT, limit: '10' })) add(c, 'its e-mail is one of the lead\'s other e-mails');
  }
  if (lead.email) {
    for (const c of await list(client, 'contact', { xquery: { otherEmailsText: { $regex: `(?i)${escapeRegex(lead.email)}` } }, select: CONTACT_SELECT, limit: '10' })) add(c, 'it has the lead\'s e-mail as another e-mail');
  }
  for (const tail of phonesOf(lead)) {
    for (const c of await list(client, 'contact', { xquery: { phonesText: { $regex: escapeRegex(tail) } }, select: CONTACT_SELECT, limit: '10' })) add(c, `same phone (…${tail})`);
  }
  const name = fullName(lead);
  if (name && normName(lead.lastName || lead.firstName || '').length >= 3) {
    const key = normName(lead.lastName || '').split(' ')[0] || normName(lead.firstName).split(' ')[0];
    const rows = await list(client, 'contact', { xquery: { searchText: { $regex: `(?i)${accentInsensitive(key)}` } }, select: CONTACT_SELECT, limit: '100' });
    for (const c of rows) {
      const score = nameSimilarity(name, fullName(c) || '');
      if (score >= 0.85) add(c, `similar name (${Math.round(score * 100)}%)`);
    }
  }
  return { exact: exact.map((c) => contactView(c, 'same e-mail')), similar: [...similar.values()] };
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdLeads(client, args, flags) {
  const stages = await leadStages(client);
  const query = {};
  if (flags.stage) {
    const s = resolveLeadStage(stages, flags.stage);
    query.stage = s._id;
    if (s.key !== 'converted') query.converted = { $ne: true };
  }
  if (flags.source) query.source = flags.source;
  if (flags.assignee) query.assignee = idOf(await userByEmail(client, flags.assignee));
  const params = {
    xquery: query, select: LEAD_SELECT, sort: 'createdAt', limit: String(flags.limit || 50),
    populatePath: [{ path: 'assignee', select: 'firstName lastName email' }],
  };
  const body = flags.search
    ? await call(client, 'GET', `/v2/lead/search?${qs({ ...params, term: flags.search })}`)
    : await call(client, 'GET', `/v2/lead?${qs(params)}`);
  const prefs = await preferences(client);
  return {
    count: (body.pagination && body.pagination.count) ?? rowsOf(body).length,
    leads: rowsOf(body).map((l) => leadView(l, stages)),
    notes: prefs.leads ? [] : [PREF_NOTE.leads],
  };
}

async function cmdShow(client, [ref]) {
  const stages = await leadStages(client);
  const lead = await findLead(client, ref);
  const view = leadView(lead, stages);
  if (lead.converted) return { lead: view, note: 'Already converted: the lead is a historical record and cannot be moved or un-converted.' };
  const dupes = await duplicates(client, lead);
  return {
    lead: view,
    duplicates: dupes,
    verdict: dupes.exact.length ? 'A contact with this e-mail already exists: the server refuses the conversion. Update that contact instead.'
      : dupes.similar.length ? 'Possible duplicates found: ask the user whether this is the same person before converting.'
        : 'No duplicate found among the contacts this profile can see.',
  };
}

async function findContact(client, ref, select) {
  const r = String(ref || '').trim();
  if (!r) throw new UsageError('A contact is given by its e-mail or id.');
  const query = ID_RE.test(r) ? { _id: r } : { email: r.toLowerCase() };
  const rows = await list(client, 'contact', { xquery: query, select, limit: '1' });
  if (!rows.length) throw new Blocked(`No contact ${r} visible to this profile.`);
  return rows[0];
}

async function cmdSubmissions(client, [ref], flags) {
  const contact = await findContact(client, ref, 'firstName lastName email submissions source adCampaign');
  const body = await call(client, 'GET', `/v2/contactsubmission?${qs({
    xquery: { contact: idOf(contact) }, select: 'sequence source adCampaign refId createdAt', sort: '-sequence', limit: String(flags.limit || 50),
    populatePath: [{ path: 'adCampaign', select: 'adCampaignName' }],
  })}`);
  const rows = rowsOf(body);
  const total = (body.pagination && body.pagination.count) ?? rows.length;
  const again = await call(client, 'GET', `/v2/contactsubmission?${qs({ xquery: { contact: idOf(contact), sequence: { $gt: 1 } }, select: '_id', limit: '1' })}`);
  return {
    contact: { _id: idOf(contact), name: fullName(contact), email: contact.email },
    summary: contact.submissions || null,
    total,
    reContacts: (again.pagination && again.pagination.count) ?? rowsOf(again).length,
    submissions: rows.map((s) => ({
      sequence: s.sequence, at: s.createdAt, source: s.source || null,
      campaign: s.adCampaign ? (s.adCampaign.adCampaignName || idOf(s.adCampaign)) : null, platformLeadId: s.refId ? 'yes' : 'no',
    })),
    notes: [
      'sequence 1 is the first time the person arrived; 2+ are re-contacts. Each row keeps the campaign of that submission.',
      'A lead converted to a contact creates no submission; submissions come from forms and ad campaigns.',
      ...(total > rows.length ? [`Showing the latest ${rows.length} of ${total}.`] : []),
    ],
  };
}

async function entityStages(client, entity) {
  return list(client, 'stage', { xquery: { stageType: `${entity}.stage` }, select: 'stageName stageCode stageType', limit: '200' });
}

async function resolveEntityStage(client, entity, ref, cache) {
  const rows = cache || await entityStages(client, entity);
  const text = normName(ref);
  const hit = rows.find((s) => idOf(s) === String(ref) || s.stageCode === ref || normName(s.stageName) === text);
  if (hit) return hit;
  if (ID_RE.test(String(ref))) {
    const res = await client.request('GET', `/v2/stage/${ref}?${qs({ select: 'stageName stageCode stageType' })}`);
    if (res.ok && res.body && String(res.body.stageType || '').startsWith(`${entity}.`)) return res.body;
  }
  const names = rows.map((s) => s.stageName).slice(0, 30).join(', ');
  throw new Blocked(`"${ref}" is not a stage of the ${entity} pipeline. Stages: ${names || 'none found'}.`);
}

function protocolView(p, stagesById) {
  return {
    _id: idOf(p),
    code: p.contactProtocolCode,
    name: p.contactProtocolName,
    entity: p.entity || 'Contact',
    active: p.active !== false,
    country: p.country || null,
    visibleToEveryone: !(p.allowEveryone && p.allowEveryone.view === false),
    stages: (p.stages || []).map((s) => (stagesById && stagesById.get(idOf(s))) || (s && s.stageName) || idOf(s)),
    steps: (p.flow || []).map((s, i) => ({
      step: i + 1, actionType: s && s.actionType, actionName: s && s.actionName, after: humanDelay(Number(s && s.time) || 0),
      subject: (s && s.subject) || null, messageTemplate: s && s.messageTemplate ? idOf(s.messageTemplate) : null,
    })),
    updatedAt: p.updatedAt,
  };
}

async function cmdProtocols(client, args, flags) {
  const query = flags.entity ? { entity: checkEntity(flags.entity) } : {};
  const rows = await list(client, 'contactprotocol', {
    xquery: query, sort: 'contactProtocolName', limit: '200',
    populatePath: [{ path: 'stages', select: 'stageName' }],
  });
  const prefs = await preferences(client);
  const out = rows.map((p) => ({ ...protocolView(p), lints: flowProblems(p.flow) }));
  // Two active protocols on the same entity, stage and country: the board shows only the first.
  const clashes = [];
  const active = rows.filter((p) => p.active !== false);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      const shared = (a.stages || []).map(idOf).filter((s) => (b.stages || []).map(idOf).includes(s));
      if ((a.entity || 'Contact') === (b.entity || 'Contact') && (a.country || '') === (b.country || '') && shared.length) {
        clashes.push(`${a.contactProtocolName} and ${b.contactProtocolName} share a stage and country: the board shows only one.`);
      }
    }
  }
  return { count: out.length, protocols: out, clashes, notes: prefs.contactProtocols ? [] : [PREF_NOTE.contactProtocols] };
}

function checkEntity(entity) {
  const e = ENTITIES.find((x) => x.toLowerCase() === String(entity).toLowerCase());
  if (!e) throw new UsageError('--entity must be Contact, Deal or Call.');
  return e;
}

const ACTIVITY_POPULATE = [
  { path: 'calls', select: 'channel createdAt' },
  { path: 'emails', select: 'createdAt subject status contactProtocol stepIndex runId error' },
];

async function loadRecord(client, entity, ref) {
  if (entity === 'Contact') {
    const r = String(ref || '').trim();
    const query = ID_RE.test(r) ? { _id: r } : { email: r.toLowerCase() };
    const rows = await list(client, 'contact', {
      xquery: query, limit: '1', populatePath: ACTIVITY_POPULATE,
      select: 'firstName lastName email stage pipelineStages address assignee createdAt protocolRun emailStatus consent calls emails',
    });
    if (!rows.length) throw new Blocked(`No contact ${r} visible to this profile.`);
    return { record: rows[0], activities: rows[0] };
  }
  if (!ID_RE.test(String(ref))) throw new UsageError(`A ${entity} is given by its id.`);
  if (entity === 'Deal') {
    const rows = await list(client, 'deal', {
      xquery: { _id: ref }, limit: '1', populatePath: ACTIVITY_POPULATE, select: 'dealName stage pipelineStages address createdAt calls emails',
    });
    if (!rows.length) throw new Blocked(`No deal ${ref} visible to this profile.`);
    return { record: rows[0], activities: rows[0] };
  }
  const rows = await list(client, 'call', {
    xquery: { _id: ref }, limit: '1', select: 'stage pipelineStages createdAt contactProtocol contact',
    populatePath: [{ path: 'contactProtocol' }, { path: 'contact', select: 'firstName lastName calls emails', populate: ACTIVITY_POPULATE }],
  });
  if (!rows.length) throw new Blocked(`No call ${ref} visible to this profile.`);
  return { record: rows[0], activities: rows[0].contact && typeof rows[0].contact === 'object' ? rows[0].contact : {} };
}

// Why a board badge shows (or not) and, for contacts, why a cadence step was or was not e-mailed.
async function cmdDiagnose(client, [ref], flags) {
  const entity = checkEntity(flags.entity || 'Contact');
  const prefs = await preferences(client);
  const { record, activities } = await loadRecord(client, entity, ref);
  const findings = [];
  const stageId = idOf(record.stage);
  const movedAtRaw = (record.pipelineStages && record.pipelineStages.stage && record.pipelineStages.stage.movedAt) || record.createdAt;
  const movedAt = movedAtRaw ? new Date(movedAtRaw) : null;
  if (!prefs.contactProtocols) findings.push(PREF_NOTE.contactProtocols);
  if (!stageId) findings.push('The record has no stage: no badge can show.');

  let chosen = null;
  let candidates = [];
  if (entity === 'Call') {
    const p = record.contactProtocol && typeof record.contactProtocol === 'object' ? record.contactProtocol : null;
    if (!p) findings.push('Call boards only use the protocol set on the call itself, and this call has none.');
    else if (!(p.stages || []).map(idOf).includes(stageId)) findings.push(`The call's protocol "${p.contactProtocolName}" does not include the call's current stage.`);
    else chosen = p;
  } else {
    const active = await list(client, 'contactprotocol', { xquery: { entity, active: true }, limit: '200' });
    const country = (record.address && record.address.country) || null;
    ({ protocol: chosen, candidates } = pickProtocol(active, stageId, country));
    if (stageId && !candidates.length) findings.push(`No active ${entity} protocol includes this record's stage.`);
    if (candidates.length && !chosen) findings.push(`The protocols for this stage are all for other countries (${candidates.map((p) => p.country).join(', ')}); the record's country is ${country || 'empty (the app then uses the viewer\'s country)'}.`);
    if (!country && candidates.length) findings.push('The record has no country: the app uses the viewer\'s own country, so two users can see different badges.');
    if (candidates.length > 1) findings.push(`${candidates.length} active protocols include this stage; the board shows only "${chosen && chosen.contactProtocolName}".`);
  }
  if (chosen && chosen.allowEveryone && chosen.allowEveryone.view === false) {
    findings.push('The protocol is visible only to its owner and collaborators (allowEveryone.view false): other users see no badge.');
  }
  const badge = chosen && movedAt ? walkBadge(chosen.flow || [], movedAt, {
    calls: (activities.calls || []).filter((c) => c && typeof c === 'object'),
    emails: (activities.emails || []).filter((e) => e && typeof e === 'object'),
  }) : [];
  if (chosen) {
    (chosen.flow || []).forEach((s, i) => {
      if (s && s.time > 0 && s.time < 1000) findings.push(`Step ${i + 1} has time ${s.time}: the board reads it as ${s.time} hour(s) but the e-mail engine as ${s.time} ms.`);
      if (s && s.actionType === 'email' && !String(s.subject || '').trim()) findings.push(`Step ${i + 1} is an e-mail without its own subject: a cadence skips it.`);
    });
  }

  let cadence = null;
  if (entity === 'Contact') {
    const run = record.protocolRun || {};
    if (!run.contactProtocol) {
      cadence = { running: false, note: 'This contact was never enrolled in an e-mail cadence. Cadences start only from an e-mail campaign with a sequence; board badges send nothing.' };
    } else {
      const protocolRes = await client.request('GET', `/v2/contactprotocol/${idOf(run.contactProtocol)}`);
      const protocol = protocolRes.ok ? protocolRes.body : null;
      const emails = await list(client, 'email', {
        xquery: { contact: idOf(record), contactProtocol: idOf(run.contactProtocol) },
        select: 'subject status stepIndex runId createdAt sentAt error', sort: 'createdAt', limit: '100',
      });
      const thisRun = run.runId ? emails.filter((e) => e.runId === run.runId) : emails;
      const steps = ((protocol && protocol.flow) || []).map((s, i) => {
        const sent = thisRun.find((e) => e.stepIndex === i);
        let state;
        if (s.actionType !== 'email') state = 'never sends: call and WhatsApp steps are reminders for the seller; only their delay counts';
        else if (sent) state = `e-mail ${sent.status || 'created'}${sent.error ? ` (${sent.error})` : ''}`;
        else if (!String(s.subject || '').trim()) state = 'skipped: e-mail step without its own subject (the template subject is not used)';
        else if (i >= (run.currentStep || 0)) state = 'not reached yet';
        else state = 'no e-mail found for this step';
        return { step: i + 1, actionType: s.actionType, actionName: s.actionName, after: humanDelay(Number(s.time) || 0), state };
      });
      const reasons = [];
      if (run.status === 'replied') reasons.push('The contact replied: the cadence stopped on purpose.');
      if (run.status === 'stopped') reasons.push('The cadence is stopped (paused by someone, three failed attempts, a suppressed e-mail or no marketing consent).');
      const state = record.emailStatus && record.emailStatus.state;
      if (['unsubscribed', 'bounced', 'complained'].includes(state)) reasons.push(`The contact's e-mail is ${state}: e-mail steps stop the cadence.`);
      const habeas = prefs.habeasData || {};
      const consent = record.consent && record.consent.state;
      if (habeas.enabled && (habeas.includePending ? consent === 'rejected' : consent !== 'accepted')) reasons.push(`Marketing consent is ${consent || 'missing'} and the account requires it: e-mail steps stop the cadence.`);
      if (protocol && protocol.active === false && ['active', 'processing'].includes(run.status)) reasons.push('The protocol is inactive but this cadence keeps running: deactivating does not stop running cadences. Pause it.');
      if (!protocol) reasons.push('The protocol was deleted (or this profile cannot see it).');
      cadence = {
        running: ['active', 'processing'].includes(run.status),
        status: run.status || null,
        protocol: protocol ? protocol.contactProtocolName : idOf(run.contactProtocol),
        currentStep: (run.currentStep || 0) + 1,
        nextDueAt: run.nextDueAt || null,
        sender: 'E-mails go out from the contact owner\'s connected mailbox.',
        steps,
        reasons,
      };
    }
  }
  return {
    entity,
    record: { _id: idOf(record), name: fullName(record) || record.dealName || null, stage: stageId || null, stageSince: movedAt ? movedAt.toISOString() : null },
    badge: chosen ? { protocol: chosen.contactProtocolName, protocolId: idOf(chosen), steps: badge } : null,
    findings,
    cadence,
    nextStep: 'Explain the findings to the user. To fix a protocol, preview a "protocol" plan; to stop a running cadence, preview a "pause" plan. Never enroll.',
  };
}

async function cmdGoals(client, args, flags) {
  const query = {};
  if (flags.assignee) query.assignee = idOf(await userByEmail(client, flags.assignee));
  if (flags.period) {
    const p = periodOf({ period: flags.period });
    query.startDate = { $lte: `${p.endDate}T23:59:59.999Z` };
    query.endDate = { $gte: `${p.startDate}T00:00:00.000Z` };
  }
  const rows = await list(client, 'goal', {
    xquery: query, sort: '-startDate', limit: '200', select: 'goalCode goalName assignee startDate endDate targetValue currency updatedAt',
    populatePath: [{ path: 'assignee', select: 'firstName lastName email' }],
  });
  const prefs = await preferences(client);
  const legacy = rows.filter((g) => !g.goalName);
  return {
    count: rows.length - legacy.length,
    goals: rows.filter((g) => g.goalName).map((g) => ({
      _id: idOf(g), code: g.goalCode, name: g.goalName, assignee: userView(g.assignee && typeof g.assignee === 'object' ? g.assignee : null) || idOf(g.assignee) || null,
      from: day(g.startDate), to: day(g.endDate), targetValue: g.targetValue, currency: g.currency || null,
    })),
    legacyWithoutName: legacy.length,
    notes: [
      ...(legacy.length ? [`${legacy.length} old goal rows without name or values (from an earlier version) are left out.`] : []),
      ...(prefs.goals ? [] : [PREF_NOTE.goals]),
    ],
  };
}

// ─── Plans ─────────────────────────────────────────────────────────────────────

function leadRefs(plan) {
  if (!Array.isArray(plan.leads) || !plan.leads.length) throw new UsageError('The plan needs "leads": a list of lead e-mails or ids.');
  if (plan.leads.length > MAX_LEADS) throw new UsageError(`At most ${MAX_LEADS} leads per plan; split it.`);
  for (const l of plan.leads) if (typeof l !== 'string' || !(ID_RE.test(l) || EMAIL_RE.test(l))) throw new UsageError(`Invalid lead reference ${JSON.stringify(l)}.`);
  return [...new Set(plan.leads.map((l) => (ID_RE.test(l) ? l : l.toLowerCase())))];
}

async function leadsOfPlan(client, plan, stages) {
  if (plan.filter) {
    if (plan.leads) throw new UsageError('Use either "leads" or "filter", not both.');
    const f = plan.filter;
    const query = { converted: { $ne: true } };
    if (f.stage !== undefined) query.stage = resolveLeadStage(stages, f.stage)._id;
    if (f.source !== undefined) query.source = String(f.source);
    if (f.unassigned === true) query.assignee = null;
    const limit = Math.min(Number(f.limit) || MAX_LEADS, MAX_LEADS);
    const body = await call(client, 'GET', `/v2/lead?${qs({ xquery: query, select: LEAD_SELECT, sort: 'createdAt', limit: String(limit) })}`);
    const total = (body.pagination && body.pagination.count) ?? rowsOf(body).length;
    return { leads: rowsOf(body), total };
  }
  const leads = [];
  for (const ref of leadRefs(plan)) leads.push(await findLead(client, ref));
  return { leads, total: leads.length };
}

async function prepareTriage(client, plan, stages) {
  if (plan.stage === undefined) throw new UsageError('A triage plan needs "stage": new, reviewing, qualified or discarded.');
  const target = resolveLeadStage(stages, plan.stage);
  if (target.key === 'converted') throw new Blocked('Moving a lead to Converted creates a contact. Use a "convert" plan, which checks duplicates first.');
  const { leads } = await leadsOfPlan(client, plan, stages);
  const blockers = [];
  const changes = [];
  for (const lead of leads) {
    if (lead.converted) {
      blockers.push(`${lead.email} is already converted: the server answers OK but never moves it.`);
      continue;
    }
    if (idOf(lead.stage) === (target._id || '')) continue;
    changes.push({ lead: idOf(lead), email: lead.email, from: stageName(stages, lead.stage), to: target.name, body: { stage: target._id } });
  }
  if (!changes.length && !blockers.length) throw new Blocked('Every lead is already in that stage.');
  return {
    changes, blockers, warnings: ['Moving a lead notifies nobody.'], recipients: [],
    version: hash({ k: 'triage', t: target._id, l: leads.map((l) => [idOf(l), l.updatedAt]) }),
  };
}

async function prepareAssign(client, plan, stages) {
  const { leads, total } = await leadsOfPlan(client, plan, stages);
  let group = null;
  let people;
  let missing = 0;
  if (plan.group && plan.users) throw new UsageError('Use either "group" or "users", not both.');
  if (plan.group) {
    const ref = String(plan.group);
    const rows = await list(client, 'usergroup', {
      xquery: ID_RE.test(ref) ? { _id: ref } : { userGroupName: ref }, select: 'userGroupName userGroupType users updatedAt', limit: '5',
    });
    if (!rows.length) throw new Blocked(`No user group "${ref}".`);
    if (rows.length > 1) throw new Blocked(`Several user groups are named "${ref}"; give its id.`);
    [group] = rows;
    const ids = (group.users || []).map(idOf);
    const found = await users(client, { _id: { $in: ids } });
    people = ids.map((id) => found.find((u) => idOf(u) === id)).filter(Boolean);
    missing = ids.length - people.length;
  } else if (Array.isArray(plan.users) && plan.users.length) {
    people = [];
    for (const email of plan.users) people.push(await userByEmail(client, email));
  } else {
    throw new UsageError('An assign plan needs "group" (name or id) or "users" (e-mails).');
  }
  // Same rule as the platform's own rotation: only users with status Active get records.
  const inactive = people.filter((u) => u.status !== 'Active');
  const active = people.filter((u) => u.status === 'Active');
  if (!active.length) throw new Blocked('No active user to assign to.');
  let start = 0;
  if (plan.startAt) {
    start = active.findIndex((u) => String(u.email).toLowerCase() === String(plan.startAt).toLowerCase());
    if (start < 0) throw new Blocked(`${plan.startAt} is not one of the active users of this plan.`);
  }
  const blockers = [];
  const open = [];
  for (const lead of leads) {
    if (lead.converted) blockers.push(`${lead.email} is already converted; its owner follows the contact now.`);
    else open.push(lead);
  }
  if (!open.length && !blockers.length) throw new Blocked('No lead matches.');
  const pairs = roundRobin(open, active, start);
  const changes = pairs.filter(({ lead, user }) => idOf(lead.assignee) !== idOf(user)).map(({ lead, user }) => ({
    lead: idOf(lead), email: lead.email, from: idOf(lead.assignee) || null, to: user.email, body: { assignee: idOf(user) },
  }));
  const perUser = active.map((u) => ({ user: u.email, name: fullName(u), leads: pairs.filter((p) => p.user === u).length }));
  const warnings = ['Assigning a lead notifies nobody. The user group is read only: its order is not changed, so forms and ad campaigns keep their own turn.'];
  if (inactive.length) warnings.push(`Skipped inactive users: ${inactive.map((u) => u.email).join(', ')}.`);
  if (missing) warnings.push(`${missing} member(s) of the group no longer exist and were skipped.`);
  if (plan.filter && total > leads.length) warnings.push(`${total} leads match; this plan takes the first ${leads.length}. Run it again for the rest.`);
  return {
    changes, blockers, warnings, recipients: [], perUser, group: group ? { _id: idOf(group), name: group.userGroupName } : null,
    version: hash({
      k: 'assign', u: active.map(idOf), s: start, g: group && group.updatedAt, l: leads.map((l) => [idOf(l), l.updatedAt]),
    }),
  };
}

async function livestreamFollowers(client, userIds) {
  const res = await client.request('GET', `/v2/livestream?${qs({ xquery: { publishers: { $in: userIds } }, select: 'shortName subscribers', limit: '50' })}`);
  if (!res.ok) return null;
  return rowsOf(res.body).map((l) => ({ stream: l.shortName, followers: (l.subscribers || []).length }));
}

async function prepareConvert(client, plan) {
  const refs = leadRefs(plan);
  const owner = plan.owner === undefined ? 'keep' : plan.owner;
  if (typeof owner !== 'string') throw new UsageError('"owner" is "keep" (the lead\'s owner), "me" or a user e-mail.');
  const allowed = new Set((plan.differentFrom || []).map(String));
  const actor = await me(client);
  const fixedOwner = owner === 'me' ? actor : owner !== 'keep' ? userView(await userByEmail(client, owner)) : null;
  const blockers = [];
  const warnings = [];
  const items = [];
  for (const ref of refs) {
    const lead = await findLead(client, ref);
    if (lead.converted) {
      blockers.push(`${lead.email} is already converted (contact ${idOf(lead.convertedTo)}). Un-converting is not possible.`);
      continue;
    }
    const dupes = await duplicates(client, lead);
    for (const c of dupes.exact) blockers.push(`${lead.email}: contact ${c._id} (${c.name || c.email}) already has this e-mail. Update that contact instead of converting.`);
    for (const c of dupes.similar.filter((s) => !allowed.has(s._id))) {
      blockers.push(`${lead.email}: possible duplicate ${c._id} (${c.name || c.email}): ${c.why}. If the user says it is another person, add "${c._id}" to "differentFrom".`);
    }
    const leadOwner = lead.assignee ? userView(typeof lead.assignee === 'object' ? lead.assignee : { _id: lead.assignee }) : null;
    const target = fixedOwner || leadOwner || actor;
    if (owner === 'keep' && !leadOwner) warnings.push(`${lead.email} has no owner: the contact stays with the profile's user (${actor.email}).`);
    items.push({
      lead, target, dupes,
      view: {
        lead: idOf(lead), email: lead.email, name: fullName(lead), owner: target.email || target._id,
        descriptionBecomesNote: Boolean(String(lead.description || '').trim()),
        reassignAfter: idOf(target) !== actor._id,
      },
    });
  }
  const notified = [...new Map(items.map((i) => [idOf(i.target), i.target])).values()];
  const recipients = [{ user: actor.email, why: 'creates each contact: "new contact" and "you are the owner" notices, by their notification settings' }];
  for (const u of notified.filter((x) => idOf(x) !== actor._id)) recipients.push({ user: u.email || u._id, why: 'becomes the owner of the new contact: "you are the owner" notice' });
  const followers = await livestreamFollowers(client, [actor._id, ...notified.map(idOf)]);
  if (followers === null) warnings.push('Could not check activity-stream followers (no permission); they may also get the notices.');
  else if (followers.length) recipients.push(...followers.map((f) => ({ user: `${f.followers} follower(s) of stream "${f.stream}"`, why: 'follow these users\' activity' })));
  if (items.some((i) => i.view.reassignAfter)) {
    warnings.push(`The platform makes the converting user (${actor.email}) owner of the lead and the new contact; the script then hands each contact to the owner shown.`);
  }
  warnings.push(
    'Each conversion creates a contact (and runs its automations: company linked by e-mail domain, ad campaign created if its code is new, AI scoring, contact webhooks).',
    'The duplicate check only sees contacts this profile can see; the server still refuses an exact e-mail match it finds anywhere in the workspace.',
    'Converting cannot be undone: the lead stays as a converted record.',
  );
  return {
    items, blockers, warnings, recipients, actor,
    changes: items.map((i) => i.view),
    version: hash({ k: 'convert', a: actor._id, l: items.map((i) => [idOf(i.lead), i.lead.updatedAt, idOf(i.target), i.dupes.exact.map((c) => c._id), i.dupes.similar.map((c) => c._id)]) }),
  };
}

async function messageTemplate(client, ref) {
  const r = String(ref);
  const query = ID_RE.test(r) ? { _id: r } : { messageTemplateName: r };
  const rows = await list(client, 'messagetemplate', { xquery: query, select: 'messageTemplateName modelName whatsappStatus subject', limit: '2' });
  if (!rows.length) throw new Blocked(`No message template "${r}".`);
  if (rows.length > 1) throw new Blocked(`Several message templates are named "${r}"; give its id.`);
  return rows[0];
}

async function prepareProtocol(client, plan) {
  const set = plan.set;
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new UsageError('A protocol plan needs "set": the fields to write.');
  for (const k of Object.keys(set)) if (!PROTOCOL_KEYS.has(k)) throw new UsageError(`Unknown protocol field "${k}".`);
  let existing = null;
  if (plan.id !== undefined) {
    const ref = String(plan.id);
    const rows = await list(client, 'contactprotocol', { xquery: ID_RE.test(ref) ? { _id: ref } : { contactProtocolCode: ref }, limit: '1' });
    if (!rows.length) throw new Blocked(`No contact protocol ${ref}.`);
    [existing] = rows;
  }
  const blockers = [];
  const warnings = [];
  const body = {};
  const keys = Object.keys(set);
  if (set.active === true) {
    if (!existing) blockers.push('A new protocol is created inactive. Turning it on is a separate plan with its own yes.');
    else if (keys.length > 1) blockers.push('Turning a protocol on is its own plan: send only {"active": true}.');
  }
  const entity = checkEntity(set.entity || (existing && existing.entity) || 'Contact');
  if (set.entity !== undefined) body.entity = entity;
  if (set.contactProtocolName !== undefined) {
    if (!String(set.contactProtocolName).trim()) throw new UsageError('contactProtocolName cannot be empty.');
    body.contactProtocolName = String(set.contactProtocolName).trim();
  } else if (!existing) throw new UsageError('A new protocol needs "contactProtocolName".');
  let stageRows = null;
  let stageLabels = null;
  if (set.stages !== undefined || (set.entity !== undefined && existing)) {
    stageRows = await entityStages(client, entity);
    const refs = set.stages !== undefined ? set.stages : (existing.stages || []).map(idOf);
    if (!Array.isArray(refs) || !refs.length) throw new UsageError('"stages" is a non-empty list of stage names, codes or ids.');
    const resolved = [];
    for (const r of refs) resolved.push(await resolveEntityStage(client, entity, r, stageRows));
    body.stages = resolved.map(idOf);
    stageLabels = new Map(resolved.map((r) => [idOf(r), r.stageName]));
  } else if (!existing) throw new UsageError('A new protocol needs "stages".');
  if (set.country !== undefined) {
    if (set.country !== null && !/^[A-Za-z]{2}$/.test(String(set.country))) throw new UsageError('"country" is a 2-letter ISO code (CO, MX…) or null for every country.');
    body.country = set.country === null ? null : String(set.country).toUpperCase();
  }
  if (set.tags !== undefined) body.tags = set.tags;
  if (set.allowEveryone !== undefined) {
    if (typeof (set.allowEveryone && set.allowEveryone.view) !== 'boolean') throw new UsageError('"allowEveryone" is {"view": true|false}.');
    body.allowEveryone = { view: set.allowEveryone.view };
    if (set.allowEveryone.view === false) warnings.push('Only the owner and collaborators will see the badge.');
  }
  if (set.flow !== undefined) {
    if (!Array.isArray(set.flow) || !set.flow.length) throw new UsageError('"flow" is a non-empty list of steps.');
    body.flow = [];
    for (const [i, raw] of set.flow.entries()) {
      if (!raw || typeof raw !== 'object') throw new UsageError(`Step ${i + 1} must be an object.`);
      for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) throw new UsageError(`Step ${i + 1}: unknown field "${k}".`);
      const step = { actionType: String(raw.actionType || '').toLowerCase(), actionName: raw.actionName || '' };
      step.time = raw.delay !== undefined ? parseDelay(raw.delay) : Number(raw.time || 0);
      if (raw.subject !== undefined) step.subject = String(raw.subject);
      if (raw.conversationFlow !== undefined) step.conversationFlow = raw.conversationFlow;
      if (raw.messageTemplate !== undefined && raw.messageTemplate !== null) {
        const tpl = await messageTemplate(client, raw.messageTemplate);
        step.messageTemplate = idOf(tpl);
        if (step.actionType === 'whatsapp' && (tpl.modelName !== 'Message' || tpl.whatsappStatus !== 'approved')) {
          blockers.push(`Step ${i + 1}: template "${tpl.messageTemplateName}" is not an approved WhatsApp template (${tpl.whatsappStatus || 'no status'}).`);
        }
        if (step.actionType === 'email' && tpl.modelName && tpl.modelName !== 'Email') {
          blockers.push(`Step ${i + 1}: template "${tpl.messageTemplateName}" is a ${tpl.modelName} template, not an e-mail one.`);
        }
      }
      body.flow.push(step);
    }
    const lint = flowProblems(body.flow);
    blockers.push(...lint.blockers);
    warnings.push(...lint.warnings);
  } else if (!existing) throw new UsageError('A new protocol needs "flow".');
  // Created inactive, always sent explicitly: the server defaults `active` to true.
  if (!existing) body.active = false;
  else if (set.active !== undefined) body.active = set.active === true;

  // The board shows one protocol per stage and country: warn on create, block on turn-on.
  const country = body.country !== undefined ? body.country : (existing && existing.country) || null;
  const stagesOf = body.stages || (existing ? (existing.stages || []).map(idOf) : []);
  const others = (await list(client, 'contactprotocol', { xquery: { entity, active: true }, select: 'contactProtocolName stages country', limit: '200' }))
    .filter((p) => idOf(p) !== idOf(existing) && (p.country || null) === (country || null) && (p.stages || []).map(idOf).some((s) => stagesOf.includes(s)));
  if (others.length) {
    const msg = `Active protocol(s) ${others.map((p) => `"${p.contactProtocolName}"`).join(', ')} already cover a stage of this one for the same country: the board shows only one.`;
    if (body.active === true) blockers.push(msg);
    else warnings.push(`${msg} Fix it before turning this one on.`);
  }
  const changes = [];
  for (const [k, v] of Object.entries(body)) {
    const before = existing ? (k === 'stages' ? (existing.stages || []).map(idOf) : existing[k]) : undefined;
    if (JSON.stringify(before ?? null) !== JSON.stringify(v ?? null)) {
      changes.push({ field: k, from: before === undefined ? null : before, to: k === 'stages' && stageLabels ? v.map((id) => `${stageLabels.get(id)} (${id})`) : v });
    }
  }
  if (!changes.length) throw new Blocked('The plan changes nothing on this protocol.');
  if (body.active === true) warnings.push('Turning it on shows the badge on boards (when the account preference is on). It sends nothing and enrolls nobody.');
  if (existing && set.active === false) {
    const running = await call(client, 'GET', `/v2/contact?${qs({ xquery: { 'protocolRun.contactProtocol': idOf(existing), 'protocolRun.status': { $in: ['active', 'processing'] } }, select: '_id', limit: '1' })}`);
    const n = (running.pagination && running.pagination.count) ?? rowsOf(running).length;
    if (n) warnings.push(`${n} contact(s) have a running cadence on this protocol: turning it off does NOT stop them. Pause each one with a "pause" plan.`);
  }
  if (existing && body.flow) warnings.push('Cadences already running use the new steps from their next step on.');
  if (!existing) warnings.push('Created inactive: it shows nowhere until a separate "active": true plan. It is a follow-up guide on the boards; nothing is sent automatically.');
  return {
    existing, body, changes, blockers, warnings, recipients: [],
    version: hash({ k: 'protocol', e: existing && existing.updatedAt, b: body }),
  };
}

async function preparePause(client, plan) {
  if (!plan.contact) throw new UsageError('A pause plan needs "contact": the contact\'s e-mail or id.');
  const contact = await findContact(client, plan.contact, 'firstName lastName email protocolRun updatedAt');
  const run = contact.protocolRun || {};
  if (!run.contactProtocol || !['active', 'processing'].includes(run.status)) {
    throw new Blocked(`${contact.email} has no running cadence (status ${run.status || 'none'}). Nothing to pause.`);
  }
  return {
    contact,
    changes: [{ contact: idOf(contact), email: contact.email, cadence: idOf(run.contactProtocol), step: (run.currentStep || 0) + 1, from: run.status, to: 'stopped' }],
    blockers: [],
    warnings: ['Pausing stops the next e-mails of this cadence. It cannot be resumed from here: only a new campaign enrolls again, from step 1.'],
    recipients: [],
    version: hash({ k: 'pause', c: idOf(contact), r: run.runId, s: run.currentStep, st: run.status }),
  };
}

async function prepareGoal(client, plan) {
  if (!Array.isArray(plan.goals) || !plan.goals.length) throw new UsageError('A goal plan needs "goals": a list of {assignee, period, targetValue}.');
  const prefs = await preferences(client);
  const blockers = [];
  const warnings = [];
  const items = [];
  const seen = new Set();
  for (const raw of plan.goals) {
    if (!raw || typeof raw !== 'object') throw new UsageError('Each goal is an object.');
    for (const k of Object.keys(raw)) if (!GOAL_KEYS.has(k)) throw new UsageError(`Unknown goal field "${k}".`);
    if (typeof raw.assignee !== 'string' || !EMAIL_RE.test(raw.assignee)) throw new UsageError('Each goal needs "assignee": the seller\'s e-mail.');
    if (typeof raw.targetValue !== 'number' || !Number.isFinite(raw.targetValue) || raw.targetValue < 0) throw new UsageError(`Goal for ${raw.assignee}: targetValue must be a number >= 0.`);
    if (raw.currency !== undefined && !/^[A-Z]{3}$/.test(String(raw.currency))) throw new UsageError(`Goal for ${raw.assignee}: currency is a 3-letter code (COP, USD…).`);
    const period = periodOf(raw);
    const key = `${raw.assignee.toLowerCase()}|${period.startDate}`;
    if (seen.has(key)) throw new UsageError(`The plan has ${raw.assignee} twice for ${period.startDate}.`);
    seen.add(key);
    const user = await userByEmail(client, raw.assignee);
    if (user.status !== 'Active') warnings.push(`${user.email} is not an active user.`);
    const overlapping = await list(client, 'goal', {
      xquery: {
        assignee: idOf(user), startDate: { $lte: `${period.endDate}T23:59:59.999Z` }, endDate: { $gte: `${period.startDate}T00:00:00.000Z` },
      },
      select: 'goalCode goalName startDate endDate targetValue currency updatedAt',
      limit: '20',
    });
    let target = null;
    if (raw.id !== undefined) {
      target = overlapping.find((g) => idOf(g) === String(raw.id) || g.goalCode === raw.id);
      if (!target) {
        const res = await client.request('GET', `/v2/goal/${encodeURIComponent(String(raw.id))}`);
        if (!res.ok) throw new Blocked(`No goal ${raw.id}.`);
        target = res.body;
        if (idOf(target.assignee) !== idOf(user)) blockers.push(`Goal ${raw.id} belongs to another seller.`);
      }
    } else {
      const same = overlapping.filter((g) => day(g.startDate) === period.startDate && day(g.endDate) === period.endDate);
      if (same.length === 1) [target] = same;
      else if (same.length > 1) blockers.push(`${user.email} already has ${same.length} goals for ${period.startDate}…${period.endDate}: say which one to update ("id").`);
      const other = overlapping.filter((g) => !same.includes(g));
      if (!same.length && other.length) {
        blockers.push(`${user.email} already has a goal that overlaps ${period.startDate}…${period.endDate}: ${other.map((g) => `${g.goalName} (${day(g.startDate)}…${day(g.endDate)}, ${idOf(g)})`).join('; ')}. Update it ("id") or change the period.`);
      }
    }
    const body = {
      goalName: raw.goalName || `${fullName(user) || user.email} · ${period.startDate.slice(0, 7) === period.endDate.slice(0, 7) ? period.startDate.slice(0, 7) : `${period.startDate}…${period.endDate}`}`,
      assignee: idOf(user),
      startDate: period.startDate,
      endDate: period.endDate,
      targetValue: raw.targetValue,
    };
    if (raw.currency) body.currency = raw.currency;
    if (target && !raw.goalName) body.goalName = target.goalName || body.goalName;
    items.push({
      target, body,
      view: {
        action: target ? 'update' : 'create', goal: target ? idOf(target) : null, seller: user.email, from: period.startDate, to: period.endDate,
        targetValue: raw.targetValue, before: target ? target.targetValue : null, currency: raw.currency || (target && target.currency) || 'account default', goalName: body.goalName,
      },
    });
  }
  if (!prefs.goals) warnings.push(PREF_NOTE.goals);
  warnings.push('Goals notify nobody. Reports compare them with sales by seller and by the goal\'s start date.');
  return {
    items, blockers, warnings, recipients: [], changes: items.map((i) => i.view),
    version: hash({ k: 'goal', i: items.map((i) => [i.body, i.target && i.target.updatedAt]) }),
  };
}

async function prepare(client, plan) {
  const kinds = ['triage', 'assign', 'convert', 'protocol', 'pause', 'goal'];
  if (!kinds.includes(plan.kind)) throw new UsageError(`"kind" must be one of ${kinds.join(', ')}.`);
  if (plan.kind === 'protocol') return prepareProtocol(client, plan);
  if (plan.kind === 'pause') return preparePause(client, plan);
  if (plan.kind === 'goal') return prepareGoal(client, plan);
  const stages = await leadStages(client);
  if (plan.kind === 'triage') return prepareTriage(client, plan, stages);
  if (plan.kind === 'assign') return prepareAssign(client, plan, stages);
  return prepareConvert(client, plan);
}

const needsReachesPeople = (plan) => plan.kind === 'convert';

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const prep = await prepare(client, plan);
  const reach = needsReachesPeople(plan) ? ' and --reaches-people (only after the user said yes to the recipients listed)' : '';
  const out = {
    kind: plan.kind,
    changes: prep.changes,
    ...(prep.perUser ? { perUser: prep.perUser, group: prep.group } : {}),
    recipients: prep.recipients,
    warnings: prep.warnings,
    blockers: prep.blockers,
    version: prep.version,
  };
  out.nextStep = prep.blockers.length
    ? 'Blocked: nothing can be written until every blocker is solved. Tell the user and ask how to proceed.'
    : `${STOP}apply with the same plan, --version ${prep.version}, --confirmed${reach}.`;
  return out;
}

async function applyConvert(client, prep) {
  const done = [];
  const problems = [];
  for (const item of prep.items) {
    const leadId = idOf(item.lead);
    const res = await client.request('PATCH', `/v2/lead/${leadId}`, { data: { converted: true }, confirmed: true });
    if (res.status === 403) {
      const err = new Error(`PATCH /v2/lead answered 403: ${(res.body && res.body.error) || 'forbidden'}`);
      err.status = 403;
      throw err;
    }
    if (!res.ok) {
      problems.push(`${item.lead.email}: the server refused the conversion (${res.status}: ${(res.body && res.body.error) || 'no message'}). Stopped here.`);
      break;
    }
    const back = await findLead(client, leadId);
    const contactId = idOf(back.convertedTo);
    if (!back.converted || !contactId) {
      problems.push(`${item.lead.email}: the lead does not read back as converted.`);
      break;
    }
    const entry = { lead: leadId, email: item.lead.email, contact: contactId, owner: null };
    if (idOf(item.target) !== prep.actor._id) {
      const r = await client.request('PATCH', `/v2/contact/${contactId}`, { data: { assignee: idOf(item.target) }, confirmed: true });
      if (!r.ok) problems.push(`${item.lead.email}: contact ${contactId} was created but could not be handed to ${item.target.email} (${r.status}). It stays with ${prep.actor.email}.`);
    }
    let contact;
    try {
      contact = await findContact(client, contactId, 'firstName lastName email assignee company notes');
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      entry.note = 'This profile can no longer see the contact (it now belongs to another seller).';
      done.push(entry);
      continue;
    }
    entry.owner = idOf(contact.assignee);
    entry.company = contact.company ? idOf(contact.company) : null;
    entry.notes = (contact.notes || []).length;
    if (entry.owner !== idOf(item.target)) problems.push(`${item.lead.email}: contact ${contactId} reads back with owner ${entry.owner}, expected ${idOf(item.target)}.`);
    done.push(entry);
  }
  return {
    converted: done,
    problems,
    nextStep: "Tell the user, in the user's language, each new contact id, its owner and the note count; list any problems.",
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview to the user and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  if (needsReachesPeople(plan) && !flags.reachesPeople) {
    throw new UsageError('A conversion notifies users (the new owner, and whoever follows them). It needs --reaches-people, given only after the user said yes to the recipients the preview listed.');
  }
  const prep = await prepare(client, plan);
  if (prep.blockers.length) return { applied: false, blockers: prep.blockers };
  if (prep.version !== flags.version) throw new Blocked('The records or the plan changed since the preview. Run preview again and show it to the user.');
  if (plan.kind === 'convert') return applyConvert(client, prep);
  if (plan.kind === 'protocol') {
    const saved = prep.existing
      ? await call(client, 'PATCH', `/v2/contactprotocol/${idOf(prep.existing)}`, { data: prep.body, confirmed: true })
      : await call(client, 'POST', '/v2/contactprotocol', { data: prep.body, confirmed: true });
    const back = await call(client, 'GET', `/v2/contactprotocol/${idOf(saved)}`);
    const problems = [];
    for (const [k, v] of Object.entries(prep.body)) {
      const got = k === 'stages' ? (back.stages || []).map(idOf) : k === 'flow' ? (back.flow || []).map((s) => ({ ...s, messageTemplate: s.messageTemplate ? idOf(s.messageTemplate) : s.messageTemplate })) : back[k];
      const want = k === 'flow' ? v.map((s) => ({ ...s })) : v;
      if (k === 'flow') {
        want.forEach((s, i) => Object.entries(s).forEach(([f, x]) => {
          if (JSON.stringify((got[i] || {})[f]) !== JSON.stringify(x)) problems.push(`flow step ${i + 1} ${f} reads back as ${JSON.stringify((got[i] || {})[f])}.`);
        }));
      } else if (JSON.stringify(got ?? null) !== JSON.stringify(want ?? null)) problems.push(`${k} reads back as ${JSON.stringify(got)}.`);
    }
    return { saved: !problems.length, protocol: protocolView(back), problems };
  }
  if (plan.kind === 'pause') {
    await call(client, 'PUT', '/v2/contactprotocol/pause', { data: { contactId: idOf(prep.contact) }, confirmed: true });
    const back = await findContact(client, idOf(prep.contact), 'email protocolRun');
    const status = back.protocolRun && back.protocolRun.status;
    return { paused: status === 'stopped', contact: idOf(back), status, problems: status === 'stopped' ? [] : [`The cadence reads back as ${status}.`] };
  }
  if (plan.kind === 'goal') {
    const saved = [];
    const problems = [];
    for (const item of prep.items) {
      const res = item.target
        ? await call(client, 'PATCH', `/v2/goal/${idOf(item.target)}`, { data: item.body, confirmed: true })
        : await call(client, 'POST', '/v2/goal', { data: item.body, confirmed: true });
      const back = await call(client, 'GET', `/v2/goal/${idOf(res)}`);
      if (back.targetValue !== item.body.targetValue || idOf(back.assignee) !== item.body.assignee || day(back.startDate) !== item.body.startDate || day(back.endDate) !== item.body.endDate) {
        problems.push(`Goal ${idOf(back)} reads back as ${back.targetValue} from ${day(back.startDate)} to ${day(back.endDate)}.`);
      }
      saved.push({ goal: idOf(back), code: back.goalCode, seller: item.view.seller, targetValue: back.targetValue, currency: back.currency, from: day(back.startDate), to: day(back.endDate) });
    }
    return { saved, problems };
  }
  // triage and assign: one PATCH per lead, then read back.
  const done = [];
  const problems = [];
  for (const ch of prep.changes) {
    await call(client, 'PATCH', `/v2/lead/${ch.lead}`, { data: ch.body, confirmed: true });
    const back = await findLead(client, ch.lead);
    const [field, want] = Object.entries(ch.body)[0];
    if ((idOf(back[field]) || null) !== (want || null)) problems.push(`${ch.email}: ${field} reads back as ${idOf(back[field]) || null}.`);
    done.push({ lead: ch.lead, email: ch.email, [field]: idOf(back[field]) || null });
  }
  return { updated: done, problems };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

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
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--stage') flags.stage = next();
    else if (arg === '--source') flags.source = next();
    else if (arg === '--assignee') flags.assignee = next();
    else if (arg === '--search') flags.search = next();
    else if (arg === '--entity') flags.entity = next();
    else if (arg === '--period') flags.period = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 50, 1), 200);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  leads: cmdLeads,
  show: cmdShow,
  submissions: cmdSubmissions,
  protocols: cmdProtocols,
  diagnose: cmdDiagnose,
  goals: cmdGoals,
  preview: cmdPreview,
  apply: cmdApply,
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
    if (!handler || !domain) throw new UsageError(`Usage: leads.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
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
  main, duplicates, nameSimilarity, phonesOf, parseDelay, periodOf, pickProtocol, walkBadge, flowProblems, roundRobin, badgeDelayMs, accentInsensitive,
};
