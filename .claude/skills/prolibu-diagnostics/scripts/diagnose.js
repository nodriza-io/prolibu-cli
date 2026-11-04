#!/usr/bin/env node
'use strict';

// Read-only traces of "why didn't X happen" and "who changed Y" on a Prolibu account.
//
//   diagnose.js record  <domain> <Model> <recordId> [--from <date>] [--to <date>] [--values]
//   diagnose.js script  <domain> <scriptCode|scriptId> [--model <Model>] [--from <date>] [--to <date>]
//   diagnose.js webhook <domain> <Model.event>
//   diagnose.js email   <domain> (--recipient <e-mail> | --contact <contactId> | --code <emailCode>) [--from] [--to]
//   diagnose.js notice  <domain> --user <e-mail> --event <group.onEvent> [--record <id>] [--actor <e-mail>] [--from] [--to]
//   diagnose.js login   <domain> <e-mail> [--from] [--to] [--ip]
//   diagnose.js audit   <domain> [--from] [--to] [--event <e>] [--actor <e-mail>] [--model <Model>] [--id <targetId>] [--values] [--ip]
//
// Every command only reads (GET). Dates are ISO (2026-11-03 or 2026-11-03T15:00:00Z).
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (feature off).

const {
  createClient, isLikelyProduction, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const MODEL_RE = /^[A-Z][A-Za-z0-9]{1,60}$/;
const EMAIL_RE = /^[^\s@"'<>]{1,128}@[^\s@"'<>]{1,128}\.[a-z0-9-]{2,}$/i;
const CODE_RE = /^[A-Za-z0-9._-]{1,120}$/;
const EVENT_RE = /^[A-Z][A-Za-z0-9]*\.([a-z][A-Za-z]*|\*)$/;
const NOTICE_EVENT_RE = /^[a-z][A-Za-z]*\.on[A-Z][A-Za-z]*$/;
const AUDIT_EVENT_RE = /^[a-z]+\.[A-Za-z]+$/;
const BLOCKED = 3;
const DAY_MS = 24 * 3600 * 1000;
const AUDIT_PAGE = 500;
const AUDIT_MAX_ROWS = 2000;
const CHANNELS = ['notificationCenter', 'email', 'ultramsg', 'slack', 'telegram', 'discord'];
// Models whose audit payloads carry credentials or security settings: never print their values.
const NO_VALUES_MODELS = new Set(['User', 'Role', 'Token', 'Preference', 'ApiKey']);
// Keys never printed, at any depth, whatever the flags.
const DROP_KEY_RE = /pass(word)?|token|apikey|api_key|secret|authorization|^headers$|^variables$|cookie|^otp|mfa|^code$/i;

class Blocked extends Error {}

// ─── Read-only guard ───────────────────────────────────────────────────────────

// Reads that change something on the server (they write, delete, or record fake engagement)
// and exports that skip output filtering. The script never calls them.
const NEVER_CALL = [
  /^\/v2\/eventsubscription\/(getmine|updatemine)(\/|\?|$)/i,
  /^\/v2\/email\/(view|click|unsubscribe|consent)(\/|\?|$)/i,
  /^\/v2\/log\/clear(\/|\?|$)/i,
  /^\/v2\/notification\/clean(\/|\?|$)/i,
  /[?&]format=(csv|xlsx)(&|$)/i,
];

function assertReadOnly(method, reqPath) {
  if (String(method).toUpperCase() !== 'GET') {
    throw new UsageError('This script is read-only: it only sends GET requests.');
  }
  if (NEVER_CALL.some((re) => re.test(reqPath))) {
    throw new UsageError('Refusing this read: it changes data on the server or exports unfiltered rows.');
  }
}

async function get(client, reqPath) {
  assertReadOnly('GET', reqPath);
  const res = await client.request('GET', reqPath);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: String(res.body || '').slice(0, 200) };
    const err = new Error(`GET ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    err.serverMessage = String(body.error || body.message || '');
    throw err;
  }
  return res.body;
}

const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const countOf = (body) => (body && body.pagination && typeof body.pagination.count === 'number' ? body.pagination.count : rowsOf(body).length);
const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const pathOf = (model) => model.toLowerCase();
const fullName = (u) => (u && typeof u === 'object' ? [u.firstName, u.lastName].filter(Boolean).join(' ') || null : null);
const who = (u) => (u && typeof u === 'object' ? { _id: idOf(u), name: fullName(u), email: u.email || null } : u ? { _id: String(u) } : null);
const trim = (s, n = 400) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
const getPath = (obj, p) => p.split('.').reduce((a, k) => (a === null || a === undefined ? a : a[k]), obj);

// A section that the profile may not read: listed, never retried another way.
function forbiddenNote(sections, name, err) {
  sections.push({ read: name, status: 403, message: trim(err.serverMessage || err.message, 200) });
}

async function optional(forbidden, name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status === 403) {
      forbiddenNote(forbidden, name, err);
      return undefined;
    }
    throw err;
  }
}

// ─── Values filtering ──────────────────────────────────────────────────────────

function dropSecrets(value, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => dropSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!DROP_KEY_RE.test(k)) out[k] = dropSecrets(v, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? trim(value, 300) : value;
}

function maskIp(ip) {
  if (typeof ip !== 'string' || !ip) return ip || null;
  if (ip.includes('.')) return `${ip.split('.')[0]}.x.x.x`;
  return `${ip.split(':')[0]}:…`;
}

function maskAgent(agent) {
  if (typeof agent !== 'string' || !agent) return agent || null;
  const m = agent.match(/^[A-Za-z-]+/);
  return m ? `${m[0]}/…` : '…';
}

// ─── Windows ───────────────────────────────────────────────────────────────────

function parseDate(text, name) {
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    throw new UsageError(`${name} must be an ISO date such as 2026-11-03 or 2026-11-03T15:00:00Z.`);
  }
  const d = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(d.getTime())) throw new UsageError(`${name} is not a valid date.`);
  return d;
}

// The window of a command. `defaultMs` is used when --from is missing.
function windowOf(flags, defaultMs, now = new Date()) {
  const to = flags.to ? parseDate(flags.to, '--to') : now;
  if (flags.to && flags.to.length === 10) to.setTime(to.getTime() + DAY_MS - 1);
  const from = flags.from ? parseDate(flags.from, '--from') : (defaultMs ? new Date(to.getTime() - defaultMs) : null);
  if (from && from > to) throw new UsageError('--from must be before --to.');
  return { from, to, defaulted: !flags.from };
}

const inWindow = (date, w) => {
  const t = new Date(date).getTime();
  return !Number.isNaN(t) && (!w.from || t >= w.from.getTime()) && t <= w.to.getTime();
};
const windowOut = (w, note) => ({ from: w.from ? w.from.toISOString() : null, to: w.to.toISOString(), defaulted: w.defaulted, ...(note ? { note } : {}) });

// ─── Shared reads ──────────────────────────────────────────────────────────────

const SWITCHES = {
  lifecycleHooks: 'integrations.lifecycleHooks.enabled',
  lifecycleEntities: 'integrations.lifecycleHooks.enabledEntities',
  webhooks: 'integrations.webhooks.enabled',
  stageHistory: 'modules.system.stage.stageHistory.enabled',
  trackedStageFields: 'modules.system.stage.stageHistory.trackedStageFields',
  ultramsg: 'integrations.thirdParty.ultramsg.enabled',
  sendgrid: 'integrations.thirdParty.sendgrid.enabled',
  slack: 'integrations.thirdParty.slack.enabled',
  telegram: 'integrations.thirdParty.telegram.enabled',
  discord: 'integrations.thirdParty.discord.enabled',
};

// Only the switches diagnostics needs; nothing else of the preferences leaves this function.
async function switches(client) {
  const prefs = await get(client, '/v2/user/preferences');
  const out = {};
  for (const [name, p] of Object.entries(SWITCHES)) {
    const v = getPath(prefs, p);
    out[name] = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : v === true;
  }
  return out;
}

async function me(client) {
  const body = await get(client, '/v2/user/me');
  const p = body.profile || body;
  return { _id: idOf(p), email: String(p.email || '').toLowerCase(), isAdmin: p.isAdmin === true, status: p.status || null };
}

async function usersByIds(client, ids) {
  const wanted = [...new Set(ids.filter((x) => ID_RE.test(x)))];
  if (!wanted.length) return new Map();
  const body = await get(client, `/v2/user?${qs({ xquery: { _id: { $in: wanted } }, select: 'firstName lastName email', limit: wanted.length })}`);
  return new Map(rowsOf(body).map((u) => [idOf(u), who(u)]));
}

// Ids (or e-mails) of the list that exist on this account, checked in batches.
async function existing(client, model, field, values) {
  const found = new Set();
  const list = [...new Set(values)];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const body = await get(client, `/v2/${pathOf(model)}?${qs({ xquery: { [field]: { $in: chunk } }, select: field === '_id' ? '_id' : `_id ${field}`, limit: chunk.length })}`);
    for (const row of rowsOf(body)) found.add(field === '_id' ? idOf(row) : String(row[field] || '').toLowerCase());
  }
  return found;
}

// ─── Audit log ─────────────────────────────────────────────────────────────────

const FEATURE_OFF_RE = /not enabled/i;

async function fetchAudit(client, { window, event, actor, model }) {
  const rows = [];
  let total = 0;
  for (let page = 1; rows.length < AUDIT_MAX_ROWS; page += 1) {
    const params = {
      startTime: window.from.toISOString(), endTime: window.to.toISOString(), limit: String(AUDIT_PAGE), page: String(page), event, actorEmail: actor, targetModel: model,
    };
    let body;
    try {
      body = await get(client, `/v2/auditlog/getlogs?${qs(params)}`);
    } catch (err) {
      if ((err.status === 400 || err.status === 500) && FEATURE_OFF_RE.test(err.serverMessage)) {
        return { enabled: false };
      }
      throw err;
    }
    const data = rowsOf(body);
    total = countOf(body);
    rows.push(...data);
    const last = body && body.pagination ? body.pagination.lastPage : 1;
    if (!data.length || page >= last) break;
  }
  return { enabled: true, rows, total, truncated: total > rows.length };
}

const isDeleteEvent = (e) => /\.delete$/.test(String(e.event || ''));

// Keeps only rows that belong to this account: the target exists here, or (when there is no
// target, or it was deleted) the actor is a user of this account. Everything else is dropped.
async function keepAccountRows(client, rows) {
  const byModel = new Map();
  const actorIds = [];
  const emails = [];
  const plan = rows.map((e) => {
    const target = idOf(e.targetId);
    if (target && ID_RE.test(target) && e.targetModel && MODEL_RE.test(e.targetModel) && !isDeleteEvent(e)) {
      if (!byModel.has(e.targetModel)) byModel.set(e.targetModel, []);
      byModel.get(e.targetModel).push(target);
      return { kind: 'target', model: e.targetModel, key: target };
    }
    if (ID_RE.test(idOf(e.actor))) {
      actorIds.push(idOf(e.actor));
      return { kind: 'actor', key: idOf(e.actor) };
    }
    if (typeof e.actorEmail === 'string' && EMAIL_RE.test(e.actorEmail)) {
      emails.push(e.actorEmail.toLowerCase());
      return { kind: 'email', key: e.actorEmail.toLowerCase() };
    }
    return { kind: 'none' };
  });
  const found = new Map();
  for (const [model, ids] of byModel) {
    try {
      found.set(`target:${model}`, await existing(client, model, '_id', ids));
    } catch (err) {
      if (err.status !== 403 && err.status !== 404 && err.status !== 400) throw err;
      found.set(`target:${model}`, new Set());
    }
  }
  const users = actorIds.length ? await existing(client, 'User', '_id', actorIds) : new Set();
  const userEmails = emails.length ? await existing(client, 'User', 'email', emails) : new Set();
  const kept = [];
  let dropped = 0;
  rows.forEach((e, i) => {
    const p = plan[i];
    const ok = (p.kind === 'target' && found.get(`target:${p.model}`).has(p.key))
      || (p.kind === 'actor' && users.has(p.key))
      || (p.kind === 'email' && userEmails.has(p.key));
    if (ok) kept.push(e);
    else dropped += 1;
  });
  return { kept, dropped };
}

function auditRow(e, flags) {
  const changes = e.detail && e.detail.changes && typeof e.detail.changes === 'object' ? e.detail.changes : null;
  const row = {
    at: e.occurredAt || null,
    event: e.event || null,
    result: e.result || null,
    actorEmail: e.actorEmail || null,
    actor: idOf(e.actor) || null,
    targetModel: e.targetModel || null,
    targetId: idOf(e.targetId) || null,
    fields: changes ? Object.keys(changes).filter((k) => !DROP_KEY_RE.test(k)) : [],
    reason: e.reason ? trim(String(e.reason), 200) : undefined,
    ip: flags.ip ? e.ip || null : maskIp(e.ip),
    userAgent: flags.ip ? trim(e.userAgent || null, 200) : maskAgent(e.userAgent),
  };
  if (flags.values) {
    if (NO_VALUES_MODELS.has(e.targetModel) || /^(user|role|token|security|auth)\./.test(String(e.event || ''))) {
      row.values = 'not shown for users, roles, tokens or security settings';
    } else if (changes) {
      row.values = dropSecrets(changes);
    } else if (e.detail && e.detail.displayName) {
      row.values = { displayName: trim(String(e.detail.displayName), 200) };
    }
  }
  return row;
}

async function auditSection(client, { window, event, actor, model, id }, flags) {
  const fetched = await fetchAudit(client, { window, event, actor, model });
  if (!fetched.enabled) {
    return { enabled: false, note: 'The audit log is not enabled on this account: there is no change history besides stage moves and the last updatedAt/updatedBy.' };
  }
  const rows = id ? fetched.rows.filter((e) => idOf(e.targetId) === id) : fetched.rows;
  const { kept, dropped } = await keepAccountRows(client, rows);
  return {
    enabled: true,
    window: windowOut(window, window.defaulted ? 'No --from given: the audit log answers only the last 24 hours. Pass --from for an older change.' : undefined),
    matched: fetched.total,
    read: fetched.rows.length,
    truncated: fetched.truncated,
    droppedNotOnThisAccount: dropped,
    rows: kept.map((e) => auditRow(e, flags)),
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

const LOG_NOTE = 'A script that ran without errors and without console.info/warn/error leaves no log. No log does not mean it did not run. Logs are kept 7 to 14 days.';

async function cmdRecord(client, [model, id], flags) {
  if (!MODEL_RE.test(model || '')) throw new UsageError('Usage: record <domain> <Model> <recordId>. Model is the object name, e.g. Deal.');
  if (!ID_RE.test(id || '')) throw new UsageError('The record id must be a 24-character id.');
  const forbidden = [];
  const record = await get(client, `/v2/${pathOf(model)}/${id}?${qs({ select: 'createdAt createdBy updatedAt updatedBy stage assignee contact' })}`);
  const window = windowOf(flags, DAY_MS);
  const timeline = [];
  if (record.createdAt) timeline.push({ at: record.createdAt, what: 'created', by: idOf(record.createdBy) || null, source: 'record' });
  if (record.updatedAt && record.updatedAt !== record.createdAt) timeline.push({ at: record.updatedAt, what: 'last saved', by: idOf(record.updatedBy) || null, source: 'record' });

  const prefs = await switches(client);
  const tracked = prefs.stageHistory && prefs.trackedStageFields.some((f) => f.startsWith(`${model}.`));
  let stageMoves = null;
  if (tracked) {
    const body = await optional(forbidden, 'stage history', () => get(client, `/v2/stagehistory?${qs({
      xquery: { origin: { modelName: model, docId: id } },
      sort: '-movedAt',
      limit: '50',
      populatePath: [{ path: 'movedBy', select: 'firstName lastName email' }, { path: 'toStage', select: 'stageName' }, { path: 'fromStage', select: 'stageName' }],
    })}`));
    if (body) {
      stageMoves = rowsOf(body).map((h) => ({
        at: h.movedAt, field: h.stageField, from: h.fromStage && h.fromStage.stageName ? h.fromStage.stageName : idOf(h.fromStage) || null, to: h.toStage && h.toStage.stageName ? h.toStage.stageName : idOf(h.toStage) || null, by: who(h.movedBy),
      }));
      for (const m of stageMoves) timeline.push({ at: m.at, what: `stage ${m.from || '—'} → ${m.to || '—'}`, by: m.by, source: 'stageHistory' });
    }
  }

  const audit = await optional(forbidden, 'audit log', () => auditSection(client, { window, model, id }, flags));
  if (audit && audit.rows) {
    for (const r of audit.rows) timeline.push({ at: r.at, what: `${r.event}${r.fields.length ? ` (${r.fields.join(', ')})` : ''}`, by: { _id: r.actor, email: r.actorEmail }, source: 'auditLog' });
  }

  const notices = await optional(forbidden, 'notifications', () => get(client, `/v2/notification?${qs({
    xquery: { values: { docId: id } }, sort: '-createdAt', limit: '20', select: 'eventType assignee createdAt createdBy source',
    populatePath: [{ path: 'assignee', select: 'firstName lastName email' }],
  })}`));
  const noticeRows = notices ? rowsOf(notices).map((n) => ({ at: n.createdAt, eventType: n.eventType, to: who(n.assignee), source: n.source || null })) : null;
  if (noticeRows) for (const n of noticeRows) timeline.push({ at: n.at, what: `in-app notice ${n.eventType}`, to: n.to, source: 'notification' });

  const contactId = model === 'Contact' ? id : idOf(record.contact);
  let emails = null;
  if (contactId && ID_RE.test(contactId)) {
    const body = await optional(forbidden, 'e-mails', () => get(client, `/v2/email?${qs({ xquery: { contact: contactId }, sort: '-createdAt', limit: '20', select: EMAIL_SELECT })}`));
    if (body) {
      emails = rowsOf(body).map((e) => emailRow(e, flags));
      for (const e of emails) timeline.push({ at: e.sentAt || e.createdAt, what: `e-mail "${e.subject}" ${e.status}`, to: e.to, source: 'email' });
    }
  }

  const names = await optional(forbidden, 'user names', () => usersByIds(client, timeline.map((t) => (typeof t.by === 'string' ? t.by : null)).filter(Boolean)));
  for (const t of timeline) if (typeof t.by === 'string') t.by = (names && names.get(t.by)) || { _id: t.by };
  timeline.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const notes = [];
  if (!tracked) notes.push(`Stage moves of ${model} are not recorded on this account (stage history off or not tracked for this object).`);
  if (audit && audit.enabled && !audit.rows.length) notes.push(`No audit rows for this record in the window. Record operations are audited only for the objects the account chose; ${model} may not be one of them, and changes made by scripts inside the server are not audited.`);
  notes.push('Audit "fields" are the fields sent in that save, not a before/after comparison.');
  return {
    record: { model, _id: id, createdAt: record.createdAt || null, updatedAt: record.updatedAt || null },
    timeline,
    stageMoves,
    audit: audit || null,
    notices: noticeRows,
    emails,
    notes,
    ...forbiddenOut(forbidden),
  };
}

function forbiddenOut(forbidden) {
  return forbidden.length ? { forbidden, forbiddenHint: FORBIDDEN_HINT } : {};
}

async function findScript(client, ref) {
  if (ID_RE.test(ref)) return get(client, `/v2/script/${ref}?${qs({ select: 'scriptCode scriptName active lifecycleHooks runOnQuoteCalculate scheduledTask' })}`);
  if (!CODE_RE.test(ref)) throw new UsageError('Give the script code or its 24-character id.');
  const rows = rowsOf(await get(client, `/v2/script?${qs({ xquery: { scriptCode: ref }, limit: '2', select: 'scriptCode scriptName active lifecycleHooks runOnQuoteCalculate scheduledTask' })}`));
  if (!rows.length) throw new Blocked(`No script with code ${ref} on this account.`);
  return rows[0];
}

async function cmdScript(client, [ref], flags) {
  if (!ref) throw new UsageError('Usage: script <domain> <scriptCode|scriptId> [--model <Model>].');
  if (flags.model && !MODEL_RE.test(flags.model)) throw new UsageError('--model is the object name, e.g. Contact.');
  const forbidden = [];
  const script = await findScript(client, ref);
  const prefs = await switches(client);
  const hooks = Array.isArray(script.lifecycleHooks) ? script.lifecycleHooks : [];
  const gates = [
    { gate: 'script is active', ok: script.active === true },
    { gate: 'lifecycle hooks are on for the account', ok: prefs.lifecycleHooks },
  ];
  const models = flags.model ? [flags.model] : hooks;
  for (const m of models) {
    gates.push({ gate: `${m} is enabled for lifecycle hooks on the account`, ok: prefs.lifecycleEntities.includes(m) });
    gates.push({ gate: `the script listens to ${m}`, ok: hooks.includes(m) });
  }
  const window = windowOf(flags, 14 * DAY_MS);
  const logs = await optional(forbidden, 'script logs', async () => {
    const seen = new Map();
    for (const meta of [{ scriptId: idOf(script) }, { scriptCode: script.scriptCode }]) {
      const body = await get(client, `/v2/log?${qs({ xquery: { logType: 'Script', meta }, sort: '-createdAt', limit: '100', select: 'status message meta createdAt' })}`);
      for (const row of rowsOf(body)) seen.set(idOf(row), row);
    }
    return [...seen.values()].filter((l) => inWindow(l.createdAt, window))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((l) => ({
        at: l.createdAt,
        status: l.status,
        event: (l.meta && l.meta.eventName) || null,
        timeMs: (l.meta && l.meta.executionTimeMs) || null,
        message: trim(l.message, 500),
        errorStack: l.meta && typeof l.meta.errorStack === 'string' ? l.meta.errorStack.split('\n').slice(0, 4).join('\n') : undefined,
      }));
  });
  const blockedBy = gates.filter((g) => !g.ok).map((g) => g.gate);
  return {
    script: {
      _id: idOf(script), scriptCode: script.scriptCode, scriptName: script.scriptName, active: script.active === true, listensTo: hooks, runOnQuoteCalculate: script.runOnQuoteCalculate === true, schedule: (script.scheduledTask && script.scheduledTask.periodicity) || null,
    },
    gates,
    verdict: blockedBy.length ? `It cannot run on record events. These checks fail: ${blockedBy.join('; ')}. Its code is not the cause until they pass.` : 'The switches allow it to run; check its logs and its code.',
    window: windowOut(window),
    logs: logs || null,
    notes: [LOG_NOTE, 'To fix, deploy, run or read the full logs of a script, use prolibu-scripts.'],
    ...forbiddenOut(forbidden),
  };
}

const hostOf = (endpoint) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid URL';
  }
};

async function cmdWebhook(client, [event]) {
  if (!EVENT_RE.test(event || '')) throw new UsageError('Usage: webhook <domain> <Model.event>, e.g. Deal.update.');
  const [model] = event.split('.');
  const prefs = await switches(client);
  const body = await get(client, `/v2/webhook?${qs({ limit: '100', select: 'webhookName endpoint eventNames active selectedFields timeoutMs' })}`);
  const hooks = rowsOf(body).map((w) => {
    const names = Array.isArray(w.eventNames) ? w.eventNames : [];
    const listens = names.includes(event) || names.includes(`${model}.*`);
    return {
      _id: idOf(w), name: w.webhookName || null, host: hostOf(w.endpoint), active: w.active === true, listens, fires: listens && w.active === true && prefs.webhooks, selectedFields: Array.isArray(w.selectedFields) ? w.selectedFields.length : 0, timeoutMs: w.timeoutMs || 5000,
    };
  });
  const firing = hooks.filter((h) => h.fires);
  return {
    event,
    webhooksEnabled: prefs.webhooks,
    wouldFire: firing,
    listeningButInactive: hooks.filter((h) => h.listens && !h.active),
    totalWebhooks: hooks.length,
    verdict: !prefs.webhooks ? 'Webhooks are off for the account: nothing is sent for any event.'
      : firing.length ? `${firing.length} active webhook(s) receive ${event}.` : `No active webhook listens to ${event}.`,
    notes: [
      'The platform keeps no delivery history: no status, response or timing is stored. Only the receiver\'s own logs can prove a delivery.',
      'Sandbox copies of an account never send webhooks.',
      'Webhooks are sent one after another; a slow receiver delays the next ones.',
      'To create or change a webhook, use prolibu-webhooks.',
    ],
  };
}

const EMAIL_SELECT = 'from to cc subject status error provider sentAt createdAt views lastView delivered bounced complained events contact emailCampaign emailCode retries';

function emailRow(e, flags) {
  const events = Array.isArray(e.events) ? e.events : [];
  const byType = {};
  for (const ev of events) byType[ev.type] = (byType[ev.type] || 0) + 1;
  return {
    _id: idOf(e),
    emailCode: e.emailCode || null,
    to: e.to || null,
    subject: trim(e.subject || '', 150),
    status: e.status || null,
    error: e.error ? trim(String(e.error), 300) : null,
    provider: e.provider || null,
    createdAt: e.createdAt || null,
    sentAt: e.sentAt || null,
    retries: e.retries || 0,
    delivered: e.delivered === undefined ? null : e.delivered,
    bounced: e.bounced === undefined ? null : e.bounced,
    views: e.views || 0,
    events: byType,
    lastEvents: events.slice(-5).map((ev) => ({ type: ev.type, at: ev.at || null, machine: ev.machine === true, ...(flags.ip ? { ip: ev.ip || null } : {}) })),
    campaign: idOf(e.emailCampaign) || null,
  };
}

async function contactStatus(client, xquery) {
  const rows = rowsOf(await get(client, `/v2/contact?${qs({ xquery, limit: '2', select: 'email emailStatus firstName lastName' })}`));
  if (!rows.length) return null;
  const c = rows[0];
  const state = c.emailStatus && c.emailStatus.state ? c.emailStatus.state : null;
  return { _id: idOf(c), name: fullName(c), email: c.email || null, emailState: state, suppressed: ['unsubscribed', 'bounced', 'complained'].includes(state) };
}

async function cmdEmail(client, rest, flags) {
  const given = ['recipient', 'contact', 'code'].filter((k) => flags[k]);
  if (given.length !== 1) throw new UsageError('Usage: email <domain> with exactly one of --recipient <e-mail>, --contact <contactId> or --code <emailCode>.');
  if (flags.recipient && !EMAIL_RE.test(flags.recipient)) throw new UsageError('--recipient must be an e-mail address.');
  if (flags.contact && !ID_RE.test(flags.contact)) throw new UsageError('--contact must be a 24-character id.');
  if (flags.code && !CODE_RE.test(flags.code)) throw new UsageError('--code is the emailCode of one e-mail.');
  const window = windowOf(flags, 30 * DAY_MS);
  const recipient = flags.recipient ? flags.recipient.toLowerCase() : null;
  const xquery = flags.code ? { emailCode: flags.code } : flags.contact ? { contact: flags.contact } : { to: recipient };
  const body = await get(client, `/v2/email?${qs({ xquery, sort: '-createdAt', limit: '50', select: EMAIL_SELECT })}`);
  const all = rowsOf(body);
  const rows = (flags.code ? all : all.filter((e) => inWindow(e.createdAt, window))).map((e) => emailRow(e, flags));
  const contact = flags.contact ? await contactStatus(client, { _id: flags.contact })
    : recipient ? await contactStatus(client, { email: recipient })
      : rows[0] && rows[0].to ? await contactStatus(client, { email: String(rows[0].to).toLowerCase() }) : null;
  const notes = [
    'Only e-mails sent through SendGrid get delivered/bounced data. Gmail and Microsoft sends end at "sent" (the provider accepted it); a later bounce goes to the sender\'s mailbox.',
    'Opens and clicks come from tracking; "machine" marks security scanners, which are not real opens.',
    'System notices (assignments, approvals…) are not stored as e-mail records; use the notice command.',
  ];
  if (contact && contact.suppressed) notes.unshift(`The contact is ${contact.emailState}: new e-mails to it are refused before they are created, so no e-mail record exists for those attempts.`);
  if (!rows.length) notes.unshift('No e-mail record matches in the window. Either it was never created (suppressed contact, error at send time, a system notice) or it is outside the window.');
  return {
    window: windowOut(window), matched: rows.length, emails: rows, contact, notes, nextSteps: 'Campaign statistics and templates: prolibu-messaging. WhatsApp or SMS conversations: prolibu-conversations.',
  };
}

async function findUser(client, email, self, forbidden) {
  if (email === self.email) return { _id: self._id, email, status: self.status, isSelf: true };
  const body = await optional(forbidden, 'users', () => get(client, `/v2/user?${qs({ xquery: { email }, limit: '2', select: 'firstName lastName email status whatsapp mobile' })}`));
  if (!body) return null;
  const u = rowsOf(body)[0];
  if (!u) throw new Blocked(`No user with e-mail ${email} on this account.`);
  return { _id: idOf(u), name: fullName(u), email, status: u.status || null, hasPhone: !!(u.whatsapp || u.mobile) };
}

async function cmdNotice(client, rest, flags) {
  if (!flags.user || !EMAIL_RE.test(flags.user)) throw new UsageError('Usage: notice <domain> --user <e-mail> --event <group.onEvent>.');
  if (!NOTICE_EVENT_RE.test(flags.event || '')) throw new UsageError('--event is the notice type, e.g. deals.onSetAsAssignee.');
  if (flags.record && !ID_RE.test(flags.record)) throw new UsageError('--record must be a 24-character id.');
  if (flags.actor && !EMAIL_RE.test(flags.actor)) throw new UsageError('--actor must be an e-mail address.');
  const forbidden = [];
  const self = await me(client);
  const email = flags.user.toLowerCase();
  const user = await findUser(client, email, self, forbidden);
  if (!user) {
    return { user: null, gates: [], notes: ['This profile cannot look up other users.'], ...forbiddenOut(forbidden) };
  }
  const prefs = await switches(client);
  const [group, name] = flags.event.split('.');
  const subscription = await optional(forbidden, 'notice settings', async () => {
    const body = await get(client, `/v2/eventsubscription?${qs({ xquery: { user: user._id }, limit: '1', select: 'user events' })}`);
    const row = rowsOf(body)[0];
    if (!row) return { exists: false };
    const ch = getPath(row, `events.${group}.${name}`) || {};
    return { exists: true, channels: Object.fromEntries(CHANNELS.filter((c) => c in ch).map((c) => [c, ch[c] === true])) };
  });
  const window = windowOf(flags, 14 * DAY_MS);
  const nq = { assignee: user._id, eventType: flags.event, ...(flags.record ? { values: { docId: flags.record } } : {}) };
  const notices = await optional(forbidden, 'notifications', () => get(client, `/v2/notification?${qs({ xquery: nq, sort: '-createdAt', limit: '20', select: 'eventType createdAt createdBy source values' })}`));
  const noticeRows = notices ? rowsOf(notices).filter((n) => inWindow(n.createdAt, window)).map((n) => ({
    at: n.createdAt, eventType: n.eventType, createdBy: idOf(n.createdBy) || null, source: n.source || null, record: n.values ? { docId: n.values.docId || null, modelName: n.values.modelName || null } : null,
  })) : null;
  const production = isLikelyProduction(client.domain);
  const channels = subscription && subscription.channels ? subscription.channels : null;
  const gates = [
    { gate: 'user is Active', ok: user.status ? user.status === 'Active' : null },
    { gate: 'the user did not cause the event (own actions are not notified)', ok: flags.actor ? flags.actor.toLowerCase() !== email : null },
    {
      gate: 'notice settings have a channel on for this event',
      ok: subscription === undefined ? null : !subscription.exists ? true : channels ? Object.values(channels).some(Boolean) : false,
    },
  ];
  const perChannel = channels ? {
    notificationCenter: channels.notificationCenter ? 'on: leaves an in-app notice record' : 'off',
    email: channels.email ? (production ? 'on' : 'on, but notice e-mails are sent only from production accounts') : 'off',
    ultramsg: channels.ultramsg ? (prefs.ultramsg ? (user.hasPhone === false ? 'on, but the user has no WhatsApp or mobile number' : 'on: WhatsApp is sent') : 'on, but WhatsApp is off for the account') : 'off',
    slack: channels.slack ? (prefs.slack ? 'on' : 'on, but Slack is off for the account') : 'off',
    telegram: channels.telegram ? (prefs.telegram ? 'on' : 'on, but Telegram is off for the account') : 'off',
    discord: channels.discord ? (prefs.discord ? 'on' : 'on, but Discord is off for the account') : 'off',
  } : null;
  const notes = [
    'Only the in-app channel leaves a record. E-mail, WhatsApp and other channels leave no trace that can be read through the API.',
    'A notice is skipped when the person who caused the event is the same user who would receive it.',
    'The same notice for the same record and channel is sent at most once every 24 hours.',
  ];
  if (subscription && !subscription.exists) notes.push('The user has no notice settings yet: the defaults apply and are created on the first notice.');
  if (noticeRows && !noticeRows.length && channels && channels.notificationCenter) notes.push('No in-app notice in the window although the in-app channel is on: the event did not reach this user (self-caused, user inactive, or the event never happened for them).');
  return {
    user: { _id: user._id, name: user.name || null, email, status: user.status },
    event: flags.event,
    gates,
    channels: perChannel,
    notices: noticeRows,
    window: windowOut(window),
    notes,
    nextSteps: 'Commercial-exception notices: prolibu-commercial-exceptions. Contract reminders: prolibu-contracts. Changing someone\'s notice settings is done by that user in the app.',
    ...forbiddenOut(forbidden),
  };
}

async function cmdLogin(client, [emailArg], flags) {
  if (!emailArg || !EMAIL_RE.test(emailArg)) throw new UsageError('Usage: login <domain> <e-mail>.');
  const email = emailArg.toLowerCase();
  const self = await me(client);
  if (!self.isAdmin && email !== self.email) {
    return {
      email, rows: [], notes: ['This profile only sees its own sign-ins. Ask an admin to run this for another user.'],
    };
  }
  const forbidden = [];
  const window = windowOf(flags, 7 * DAY_MS);
  const body = await get(client, `/v2/loginactivity?${qs({ xquery: { email }, sort: '-createdAt', limit: '50' })}`);
  // Keep only the asked e-mail: the server may answer with another filter than the one sent.
  const rows = rowsOf(body).filter((r) => String(r.email || '').toLowerCase() === email && inWindow(r.createdAt, window)).map((r) => ({
    at: r.createdAt, status: r.loginStatus || null, reason: r.reason ? trim(String(r.reason), 200) : null, country: r.country || null, city: r.city || null, browser: r.browser || null, os: r.os || null, device: r.device || null, ip: flags.ip ? r.ip || null : maskIp(r.ip),
  }));
  const user = await findUser(client, email, self, forbidden);
  const failures = rows.filter((r) => r.status === 'Failure');
  const reasons = {};
  for (const r of failures) reasons[r.reason || 'no reason'] = (reasons[r.reason || 'no reason'] || 0) + 1;
  return {
    email,
    user: user ? { status: user.status, exists: true } : null,
    window: windowOut(window),
    summary: { total: rows.length, failures: failures.length, lastSuccess: (rows.find((r) => r.status === 'Success') || {}).at || null, reasons },
    rows,
    notes: [
      'The step that asks for a second factor (MFA) and failed MFA codes are not recorded here.',
      'Repeated failures lock the sign-in for about 5 minutes; suspicious activity can block the IP.',
      'Passwords, users and sign-in rules are changed by an admin in the app, never by this skill.',
    ],
    ...forbiddenOut(forbidden),
  };
}

async function cmdAudit(client, rest, flags) {
  if (flags.event && !AUDIT_EVENT_RE.test(flags.event)) throw new UsageError('--event is an audit event such as operation.update or auth.signinFailed.');
  if (flags.actor && !EMAIL_RE.test(flags.actor)) throw new UsageError('--actor must be an e-mail address.');
  if (flags.model && !MODEL_RE.test(flags.model)) throw new UsageError('--model is the object name, e.g. Deal.');
  if (flags.id && !ID_RE.test(flags.id)) throw new UsageError('--id must be a 24-character id.');
  const window = windowOf(flags, DAY_MS);
  const result = await auditSection(client, {
    window, event: flags.event, actor: flags.actor ? flags.actor.toLowerCase() : undefined, model: flags.model, id: flags.id,
  }, flags);
  if (!result.enabled) throw new Blocked(result.note);
  const notes = ['"fields" lists what each save sent, not a before/after comparison. Values only with --values, and never for users, roles, tokens or security settings.'];
  if (result.truncated) notes.push(`Only the newest ${result.read} of ${result.matched} rows were read. Narrow the window or filter by --event, --actor or --model.`);
  if (result.droppedNotOnThisAccount) notes.push(`${result.droppedNotOnThisAccount} row(s) were left out because their record or person is not on this account (or was deleted).`);
  return { ...result, notes };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = ['profile', 'from', 'to', 'model', 'recipient', 'contact', 'code', 'user', 'event', 'record', 'actor', 'id'];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--values') flags.values = true;
    else if (arg === '--ip') flags.ip = true;
    else if (arg.startsWith('--') && valued.includes(arg.slice(2))) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[arg.slice(2)] = argv[i];
    } else if (arg === '--confirmed' || arg === '--reaches-people') {
      throw new UsageError('This script is read-only: it has no --confirmed or --reaches-people.');
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  record: cmdRecord,
  script: cmdScript,
  webhook: cmdWebhook,
  email: cmdEmail,
  notice: cmdNotice,
  login: cmdLogin,
  audit: cmdAudit,
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
    if (!handler || !domain) throw new UsageError(`Usage: diagnose.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags);
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
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
  main, assertReadOnly, dropSecrets, auditRow, keepAccountRows, windowOf, maskIp, NEVER_CALL,
};
