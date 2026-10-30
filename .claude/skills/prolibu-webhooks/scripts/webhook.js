#!/usr/bin/env node
'use strict';

// Creates and changes Prolibu outbound webhooks the way the app does it, with the checks the
// server skips: exact event names, field paths the server accepts, `_id` always in the trimmed
// payload, an explicit on/off, a public https destination, and header values never printed.
//
//   webhook.js list    <domain>
//   webhook.js show    <domain> <webhookId>
//   webhook.js events  <domain> <object>
//   webhook.js fields  <domain> <object> [filter]
//   webhook.js preview <domain> '<plan json>'
//   webhook.js apply   <domain> '<plan json>' --confirmed [--webhook-version <v>]
//
// The plan is inline JSON, or the path of a JSON file in a temp folder. A plan with "id"
// changes that webhook; without it, a new one is created.
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const ACTIONS = ['create', 'update', 'delete', '*'];
const PLAN_KEYS = new Set(['id', 'webhookName', 'endpoint', 'eventNames', 'selectedFields', 'headers', 'timeoutMs', 'active']);
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 60000;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'keep-alive']);
const INTERNAL_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'svc', 'arpa'];
const FIELD_LIST_CAP = 300;

const BLOCK = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .forEach(([a, p]) => BLOCK.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8]]
  .forEach(([a, p]) => BLOCK.addSubnet(a, p, 'ipv6'));

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  return BLOCK.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

// Why an endpoint cannot be used, as { blocker } or { host, warnings }. The server accepts any
// http(s) URL, internal addresses included; this script only allows public https destinations.
function checkEndpoint(raw, { ownDomain } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { blocker: 'The endpoint is not a valid URL.' };
  }
  if (url.protocol !== 'https:') return { blocker: 'The endpoint must use https: the shared-secret header would travel in clear text.' };
  if (url.username || url.password) return { blocker: 'The endpoint must not carry a user or password; put the secret in a header.' };
  if (url.hash) return { blocker: 'The endpoint must not have a #fragment.' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) return { blocker: `${host} is a private or reserved address. Webhooks only go to public hosts.` };
    return { blocker: 'The endpoint is an IP address. Use a public host name with a valid certificate.' };
  }
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !l) || INTERNAL_SUFFIXES.includes(labels[labels.length - 1])) {
    return { blocker: `${host} is not a public host name.` };
  }
  const warnings = [];
  if (ownDomain && host === String(ownDomain).toLowerCase()) {
    warnings.push('The endpoint is this same account. If the receiver writes back to the same object, every write fires the webhook again: guard against loops.');
  }
  return { host, url: url.href, warnings };
}

// Maps each requested event to the exact name the server accepts (case fixed), or explains why not.
function normalizeEvents(requested, catalog) {
  if (!Array.isArray(requested) || !requested.length) throw new UsageError('"eventNames" needs at least one event, such as "Contact.create".');
  const byLower = new Map(catalog.map((e) => [e.toLowerCase(), e]));
  const out = [];
  const normalized = [];
  for (const raw of requested) {
    const text = String(raw || '').trim();
    const exact = byLower.get(text.toLowerCase());
    if (!exact) {
      const [model, action] = text.split('.');
      const near = catalog.filter((e) => e.toLowerCase().startsWith(`${String(model || '').toLowerCase()}.`));
      let hint = near.length ? ` Valid for that object: ${near.join(', ')}.` : ' Run "events <domain> <object>" to find the object\'s exact name.';
      if (action && !ACTIONS.includes(action.toLowerCase())) hint = ` The action must be one of ${ACTIONS.join(', ')}.${hint}`;
      throw new UsageError(`Unknown event "${text}".${hint}`);
    }
    if (exact !== text) normalized.push(`${text} → ${exact}`);
    if (!out.includes(exact)) out.push(exact);
  }
  const blocked = out.filter((e) => e.startsWith('Webhook.'));
  if (blocked.length) {
    throw new UsageError('Webhook events are refused: their payload carries other webhooks\' secret headers.');
  }
  return { eventNames: out, normalized };
}

function modelsOf(eventNames) {
  return [...new Set(eventNames.map((e) => e.split('.')[0]))];
}

// A field is valid when it is one of the server's columns, or the parent of some (the server
// sends the whole subtree), exactly as Webhook.validateSelectedFields checks it.
function unknownFields(fields, columns) {
  return fields.filter((f) => !columns.some((c) => c === f || c.startsWith(`${f}.`)));
}

function suggestFields(field, columns) {
  const leaf = String(field).split('.').pop().toLowerCase();
  return columns.filter((c) => c.toLowerCase().includes(leaf)).slice(0, 8);
}

// Merges the plan's selectedFields into the stored ones, per object. An entry with an empty
// "fields" list removes the trimming for that object (the full record is sent). `_id` is added
// to every entry the plan touches. Entries for objects without events are dropped, as the app does.
function buildSelectedFields(stored, planned, { models, columnsOf }) {
  const result = new Map();
  const notes = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!entry || !entry.entity) continue;
    // The server matches the entity case-sensitively at delivery: a wrong case is ignored and the
    // full record goes out. Fix the case so the stored trimming starts to apply.
    const model = models.find((m) => m.toLowerCase() === String(entry.entity).toLowerCase()) || entry.entity;
    if (model !== entry.entity) notes.push(`stored entity ${entry.entity} → ${model}: with the wrong case the server ignored it and sent the full record.`);
    result.set(model, { entity: model, fields: [...(entry.fields || [])] });
  }
  for (const [i, entry] of (planned || []).entries()) {
    if (!entry || typeof entry !== 'object' || !entry.entity) throw new UsageError(`selectedFields[${i}] needs "entity" and "fields".`);
    const model = models.find((m) => m.toLowerCase() === String(entry.entity).toLowerCase());
    if (!model) {
      throw new UsageError(`selectedFields[${i}]: "${entry.entity}" has no event in this webhook. Objects with events: ${models.join(', ')}.`);
    }
    if (model !== entry.entity) notes.push(`selectedFields entity ${entry.entity} → ${model}`);
    if (!Array.isArray(entry.fields)) throw new UsageError(`selectedFields[${i}].fields must be a list of field paths.`);
    const fields = [...new Set(entry.fields.map((f) => String(f).trim()).filter(Boolean))];
    if (!fields.length) {
      result.delete(model);
      notes.push(`${model}: no trimming, the full record is sent.`);
      continue;
    }
    const columns = columnsOf(model);
    const bad = unknownFields(fields, columns);
    if (bad.length) {
      const hints = bad.map((f) => {
        const s = suggestFields(f, columns);
        return s.length ? `${f} (did you mean ${s.join(', ')}?)` : f;
      });
      throw new UsageError(`selectedFields for ${model}: unknown field ${hints.join('; ')}. Run "fields <domain> ${model} <filter>".`);
    }
    if (!fields.includes('_id')) fields.unshift('_id');
    result.set(model, { entity: model, fields });
  }
  for (const entity of [...result.keys()]) {
    if (!models.includes(entity)) {
      result.delete(entity);
      notes.push(`${entity}: its field list was dropped, the webhook has no ${entity} event any more.`);
    }
  }
  return { selectedFields: [...result.values()], notes };
}

// Merges plan headers into the stored ones by name (case-insensitive). Each plan entry is
// { name, value } to set, { name, generate: true } for a new random secret, or { name, remove: true }.
// Values never leave this function except through `generated` (shown once after saving).
function buildHeaders(stored, planned, { generate = false, newSecret = () => crypto.randomBytes(32).toString('hex') } = {}) {
  const result = (Array.isArray(stored) ? stored : []).map((h) => ({ name: h.name, value: h.value }));
  const generated = [];
  const pending = [];
  const changes = [];
  const seen = new Set();
  for (const [i, entry] of (planned || []).entries()) {
    const name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!HEADER_TOKEN.test(name)) throw new UsageError(`headers[${i}]: "${name}" is not a valid header name.`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw new UsageError(`headers[${i}]: ${name} is set by the platform; use another name.`);
    if (seen.has(name.toLowerCase())) throw new UsageError(`headers[${i}]: ${name} appears twice.`);
    seen.add(name.toLowerCase());
    const modes = ['value', 'generate', 'remove'].filter((k) => entry[k] !== undefined && entry[k] !== false);
    if (modes.length !== 1) throw new UsageError(`headers[${i}]: give exactly one of "value", "generate": true or "remove": true.`);
    const at = result.findIndex((h) => String(h.name).toLowerCase() === name.toLowerCase());
    if (entry.remove) {
      if (at === -1) throw new UsageError(`headers[${i}]: there is no stored header ${name} to remove.`);
      result.splice(at, 1);
      changes.push({ name, change: 'removed' });
      continue;
    }
    let { value } = entry;
    if (entry.generate) {
      pending.push(name);
      value = generate ? newSecret() : '<generated on apply>';
      if (generate) generated.push({ name, value });
    } else if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
      throw new UsageError(`headers[${i}]: the value must be a non-empty single-line string.`);
    }
    const what = entry.generate ? 'new random value, shown once after saving' : 'value from the plan';
    if (at === -1) {
      result.push({ name, value });
      changes.push({ name, change: `added (${what})` });
    } else {
      result[at] = { name, value };
      changes.push({ name, change: `replaced (${what})` });
    }
  }
  return { headers: result, generated, pending, changes };
}

function maskHeaders(headers) {
  return (Array.isArray(headers) ? headers : []).map((h) => ({ name: h && h.name, value: '***' }));
}

// Problems a stored webhook has today, in plain words (for list and show).
function issuesOf(w, { ownDomain } = {}) {
  const issues = [];
  const models = modelsOf(w.eventNames || []);
  for (const entry of w.selectedFields || []) {
    if (!entry || !entry.entity) continue;
    if (models.includes(entry.entity)) {
      if (!(entry.fields || []).includes('_id')) issues.push(`The ${entry.entity} field list has no _id: the receiver cannot tell which record changed.`);
    } else if (models.some((m) => m.toLowerCase() === String(entry.entity).toLowerCase())) {
      issues.push(`selectedFields entity "${entry.entity}" has the wrong case: it is ignored and the full record is sent.`);
    } else {
      issues.push(`selectedFields has a list for ${entry.entity}, which has no event here: it is never used.`);
    }
  }
  const check = checkEndpoint(w.endpoint, { ownDomain });
  if (check.blocker) issues.push(`Endpoint: ${check.blocker}`);
  if ((w.eventNames || []).some((e) => e.startsWith('Quote.'))) {
    issues.push('Quote events cover the quote library only, not the quote inside a deal (that is Deal.update).');
  }
  if ((w.eventNames || []).some((e) => e.startsWith('Webhook.'))) {
    issues.push('Webhook events send other webhooks\' secret headers to this endpoint.');
  }
  return issues;
}

function summarize(w, { ownDomain, withIssues = false } = {}) {
  if (!w) return null;
  return {
    _id: w._id,
    webhookCode: w.webhookCode,
    webhookName: w.webhookName,
    endpoint: w.endpoint,
    active: w.active,
    eventNames: w.eventNames || [],
    selectedFields: w.selectedFields || [],
    headers: maskHeaders(w.headers),
    timeoutMs: w.timeoutMs,
    updatedAt: w.updatedAt,
    ...(withIssues ? { issues: issuesOf(w, { ownDomain }) } : {}),
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readPlan(arg, rootDir) {
  let text = String(arg);
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
  const extra = Object.keys(plan).filter((k) => !PLAN_KEYS.has(k));
  if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}. Allowed: ${[...PLAN_KEYS].join(', ')}.`);
  if (plan.id !== undefined && !/^[a-f0-9]{24}$/i.test(String(plan.id))) throw new UsageError('"id" must be a webhook _id (24 hex characters).');
  if (plan.id === undefined) {
    for (const key of ['webhookName', 'endpoint', 'eventNames']) {
      if (plan[key] === undefined) throw new UsageError(`A new webhook needs "${key}".`);
    }
    if (typeof plan.active !== 'boolean') {
      throw new UsageError('A new webhook needs "active": true or false. The server turns it on by default, so say it explicitly.');
    }
  } else if (Object.keys(plan).length === 1) {
    throw new UsageError('The plan changes nothing: add the keys to change.');
  }
  if (plan.webhookName !== undefined && (typeof plan.webhookName !== 'string' || !plan.webhookName.trim())) {
    throw new UsageError('"webhookName" must be a non-empty string.');
  }
  if (plan.active !== undefined && typeof plan.active !== 'boolean') throw new UsageError('"active" must be true or false.');
  for (const key of ['selectedFields', 'headers', 'eventNames']) {
    if (plan[key] !== undefined && !Array.isArray(plan[key])) throw new UsageError(`"${key}" must be a list.`);
  }
  return plan;
}

// ─── API steps ─────────────────────────────────────────────────────────────────

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

// The account switch (Preferences → Integrations → Webhooks). Only admins can read it.
async function accountSwitch(client) {
  const res = await client.request('GET', '/v2/preference/read');
  if (!res.ok) return 'unknown';
  const pref = (res.body && (res.body.preference || res.body)) || {};
  const enabled = pref.integrations && pref.integrations.webhooks && pref.integrations.webhooks.enabled;
  return enabled === true;
}

async function eventCatalog(client) {
  const body = await call(client, 'GET', `/v2/service/getschema?${new URLSearchParams({ modelNames: 'Webhook', type: 'attrs' })}`);
  const schema = body.Webhook || body;
  const list = schema && schema.eventNames && schema.eventNames.enum;
  if (!Array.isArray(list) || !list.length) throw new Error('The server did not return the list of webhook events.');
  return list;
}

async function columnsFor(client, models) {
  if (!models.length) return {};
  const body = await call(client, 'GET', `/v2/service/getschema?${new URLSearchParams({ modelNames: models.join(','), type: 'columns' })}`);
  if (models.length === 1 && Array.isArray(body)) return { [models[0]]: body };
  return body || {};
}

async function loadWebhook(client, id) {
  return call(client, 'GET', `/v2/webhook/${id}`);
}

async function endpointTakenBy(client, endpoint, ownId) {
  const query = new URLSearchParams({ xquery: JSON.stringify({ endpoint }), select: 'webhookName endpoint', limit: '5' });
  const body = await call(client, 'GET', `/v2/webhook?${query}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  return rows.filter((w) => w.endpoint === endpoint && w._id !== ownId);
}

async function resolveHost(host, lookup) {
  try {
    const found = await lookup(host, { all: true, verbatim: true });
    return { addresses: (found || []).map((a) => a.address) };
  } catch (err) {
    return { error: err && err.code ? err.code : 'lookup failed' };
  }
}

// Validates the plan against the server's own lists and builds what would be written.
async function prepare(client, plan, { generate = false, lookup, newSecret } = {}) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  const stored = plan.id ? await loadWebhook(client, plan.id) : null;

  const endpoint = plan.endpoint !== undefined ? String(plan.endpoint).trim() : stored.endpoint;
  if (plan.endpoint === undefined && stored) {
    const check = checkEndpoint(endpoint, { ownDomain: client.domain });
    if (check.blocker) warnings.push(`The stored endpoint would not pass today's checks: ${check.blocker} Consider a new endpoint.`);
  } else {
    const check = checkEndpoint(endpoint, { ownDomain: client.domain });
    if (check.blocker) throw new Blocked(check.blocker);
    warnings.push(...check.warnings);
    const dnsResult = await resolveHost(check.host, lookup);
    const bad = (dnsResult.addresses || []).filter(isBlockedAddress);
    if (bad.length) throw new Blocked(`${check.host} resolves to a private or reserved address (${bad.join(', ')}). Webhooks only go to public hosts.`);
    if (dnsResult.error) warnings.push(`${check.host} does not resolve yet (${dnsResult.error}). Deliveries fail until it does.`);
    const taken = await endpointTakenBy(client, endpoint, plan.id);
    if (taken.length) {
      blockers.push(`The endpoint is already used by webhook "${taken[0].webhookName}" (${taken[0]._id}). Endpoints are unique: `
        + 'add the events to that webhook, or give this one a different path.');
    }
  }

  const catalog = await eventCatalog(client);
  let eventNames = stored ? stored.eventNames || [] : [];
  if (plan.eventNames !== undefined) {
    const result = normalizeEvents(plan.eventNames, catalog);
    eventNames = result.eventNames;
    notes.push(...result.normalized.map((n) => `event ${n}`));
  }
  const models = modelsOf(eventNames);
  const columns = await columnsFor(client, models);
  const built = buildSelectedFields(stored && stored.selectedFields, plan.selectedFields, {
    models, columnsOf: (m) => (Array.isArray(columns[m]) ? columns[m] : []),
  });
  notes.push(...built.notes);
  for (const entry of built.selectedFields) {
    if (!entry.fields.includes('_id')) warnings.push(`The ${entry.entity} field list has no _id: the receiver cannot tell which record changed.`);
  }

  const headers = buildHeaders(stored && stored.headers, plan.headers, { generate, newSecret });

  let { timeoutMs } = plan;
  if (timeoutMs === undefined) timeoutMs = stored ? stored.timeoutMs : 5000;
  else if (!Number.isInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    throw new UsageError(`"timeoutMs" must be a whole number of milliseconds from ${TIMEOUT_MIN_MS} to ${TIMEOUT_MAX_MS}, as in the app.`);
  }

  const after = {
    webhookName: plan.webhookName !== undefined ? plan.webhookName.trim() : stored.webhookName,
    endpoint,
    eventNames,
    selectedFields: built.selectedFields,
    headers: headers.headers,
    timeoutMs,
    active: plan.active !== undefined ? plan.active : stored.active,
  };

  // What the write sends: the whole record on create; on update only the keys that change.
  // PATCH replaces arrays whole, so a changed list always travels complete.
  let body = after;
  if (stored) {
    body = {};
    for (const key of Object.keys(after)) {
      const before = stored[key] === undefined && Array.isArray(after[key]) ? [] : stored[key];
      if (!sameJson(after[key], before)) body[key] = after[key];
    }
    if (!Object.keys(body).length) blockers.push('Nothing changes: the webhook already looks like this.');
  }

  const switchState = await accountSwitch(client);
  if (switchState === false) {
    blockers.push('Webhooks are disabled for this account: the server rejects any create or change and sends nothing. '
      + 'An admin turns them on in Preferences → Integrations → Webhooks. Do not change preferences yourself.');
  } else if (switchState === 'unknown') {
    notes.push('Could not read the account switch (only admins can). If saving answers "Webhooks are disabled", an admin must turn them on.');
  }

  if (eventNames.some((e) => e.startsWith('Quote.'))) {
    warnings.push('Quote events cover the quote library only. A deal\'s quote lives inside the deal: use Deal.update with proposal.quote fields.');
  }
  for (const model of models) {
    if (eventNames.some((e) => e === `${model}.update` || e === `${model}.*`) && !built.selectedFields.some((s) => s.entity === model)) {
      warnings.push(`${model} updates send the whole record twice (before and after). Consider listing the fields the receiver needs.`);
    }
  }
  if (after.active && (!stored || !stored.active)) {
    let host = endpoint;
    try { host = new URL(endpoint).host; } catch { /* reported above */ }
    warnings.push(`Once saved, every ${eventNames.join(', ')} sends real data to ${host}.`);
  }

  return {
    stored, after, body, blockers, warnings, notes, switchState,
    generated: headers.generated, pendingSecrets: headers.pending, headerChanges: headers.changes,
  };
}

function describe(prepared) {
  const view = (w) => ({ ...w, headers: maskHeaders(w.headers) });
  const changes = {};
  for (const key of Object.keys(prepared.body)) {
    changes[key] = {
      before: prepared.stored ? view({ [key]: prepared.stored[key] })[key] : undefined,
      after: view({ [key]: prepared.after[key] })[key],
    };
  }
  return changes;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(client) {
  const query = new URLSearchParams({ limit: '200', sort: 'webhookName' });
  const body = await call(client, 'GET', `/v2/webhook?${query}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  const switchState = await accountSwitch(client);
  return {
    accountSwitch: switchState === 'unknown' ? 'unknown (only admins can read it)' : (switchState ? 'on' : 'off: nothing is sent'),
    webhooks: rows.map((w) => summarize(w, { ownDomain: client.domain, withIssues: true })),
  };
}

async function cmdShow(client, [id]) {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw new UsageError('Usage: webhook.js show <domain> <webhookId>');
  const switchState = await accountSwitch(client);
  return {
    accountSwitch: switchState === 'unknown' ? 'unknown (only admins can read it)' : (switchState ? 'on' : 'off: nothing is sent'),
    webhook: summarize(await loadWebhook(client, id), { ownDomain: client.domain, withIssues: true }),
  };
}

async function cmdEvents(client, [object]) {
  if (!object) throw new UsageError('Usage: webhook.js events <domain> <object>');
  const catalog = await eventCatalog(client);
  const models = [...new Set(catalog.map((e) => e.split('.')[0]))];
  const term = String(object).trim().toLowerCase();
  const exact = models.find((m) => m.toLowerCase() === term);
  const similar = models.filter((m) => m !== exact && m.toLowerCase().includes(term)).slice(0, 15);
  return {
    object: exact || null,
    events: exact ? catalog.filter((e) => e.startsWith(`${exact}.`)) : [],
    similarObjects: similar,
    note: exact ? undefined : 'No object with that exact name. Pick one of similarObjects, or ask the user.',
  };
}

async function cmdFields(client, [object, filter]) {
  if (!object) throw new UsageError('Usage: webhook.js fields <domain> <object> [filter]');
  const models = [...new Set((await eventCatalog(client)).map((e) => e.split('.')[0]))];
  const name = models.find((m) => m.toLowerCase() === String(object).trim().toLowerCase());
  if (!name) {
    throw new UsageError(`"${object}" is not an object with webhook events. Run "events <domain> ${object}" for similar names.`);
  }
  const columns = await columnsFor(client, [name]);
  const all = Array.isArray(columns[name]) ? columns[name] : [];
  const f = String(filter || '').toLowerCase();
  const matches = f ? all.filter((c) => c.toLowerCase().includes(f)) : all;
  return {
    object: name,
    total: all.length,
    fields: matches.slice(0, FIELD_LIST_CAP),
    truncated: matches.length > FIELD_LIST_CAP ? `${matches.length - FIELD_LIST_CAP} more; pass a filter` : undefined,
    note: 'A parent path (for example "address") sends its whole subtree. _id is added for you.',
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  if (!planArg) throw new UsageError("Usage: webhook.js preview <domain> '<plan json>'");
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await prepare(client, plan, { lookup: ctx.lookup });
  return {
    action: plan.id ? 'update' : 'create',
    webhook: p.stored ? { _id: p.stored._id, webhookName: p.stored.webhookName } : undefined,
    webhookVersion: p.stored ? p.stored.updatedAt : undefined,
    after: summarize({ ...p.after, _id: plan.id }),
    changes: plan.id ? describe(p) : undefined,
    headerChanges: p.headerChanges.length ? p.headerChanges : undefined,
    warnings: p.warnings,
    notes: p.notes,
    blockers: p.blockers,
    nextStep: p.blockers.length
      ? 'Blocked: tell the user why; do not apply.'
      : `Show this to the user. Only after an explicit yes, run apply with the same plan${plan.id ? ' and --webhook-version set to webhookVersion' : ''}.`,
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!planArg) throw new UsageError("Usage: webhook.js apply <domain> '<plan json>' --confirmed [--webhook-version <v>]");
  const plan = readPlan(planArg, ctx.rootDir);
  if (plan.id && !flags.webhookVersion) {
    throw new UsageError('Missing --webhook-version. Run preview first and pass its webhookVersion: apply only saves what the user saw.');
  }
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and wait for a yes.');
  const p = await prepare(client, plan, { generate: true, lookup: ctx.lookup, newSecret: ctx.newSecret });
  if (p.stored && p.stored.updatedAt !== flags.webhookVersion) {
    throw new Blocked('The webhook changed since the preview. Run preview again and show the user the new result.');
  }
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));

  let id = plan.id;
  try {
    if (id) {
      await call(client, 'PATCH', `/v2/webhook/${id}`, { data: p.body, confirmed: true });
    } else {
      const created = await call(client, 'POST', '/v2/webhook', { data: p.body, confirmed: true });
      id = created && created._id;
    }
  } catch (err) {
    if (/disabled/i.test(err.message)) {
      throw new Blocked('Webhooks are disabled for this account; nothing was saved. An admin turns them on in Preferences → Integrations → Webhooks.');
    }
    throw err;
  }
  if (!id) throw new Error('The server did not return the new webhook id.');

  const saved = await loadWebhook(client, id);
  const problems = [];
  for (const key of ['webhookName', 'endpoint', 'timeoutMs', 'active']) {
    if (saved[key] !== p.after[key]) problems.push(`${key} was saved as ${JSON.stringify(saved[key])}.`);
  }
  if (!sameJson([...(saved.eventNames || [])].sort(), [...p.after.eventNames].sort())) problems.push('eventNames differ from what was sent.');
  if (!sameJson(saved.selectedFields || [], p.after.selectedFields)) problems.push('selectedFields differ from what was sent.');
  const savedHeaders = new Map((saved.headers || []).map((h) => [String(h.name).toLowerCase(), h.value]));
  if (savedHeaders.size !== p.after.headers.length
    || p.after.headers.some((h) => savedHeaders.get(String(h.name).toLowerCase()) !== h.value)) {
    problems.push('The stored headers differ from what was sent (values not shown).');
  }
  return {
    saved: problems.length === 0,
    action: plan.id ? 'update' : 'create',
    webhook: summarize(saved),
    newSecrets: p.generated.length ? p.generated : undefined,
    newSecretsNote: p.generated.length
      ? 'Show these values to the user once, to hand to the receiver\'s owner. They are not printed again.'
      : undefined,
    warnings: p.warnings,
    problems,
  };
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
    else if (arg === '--webhook-version') flags.webhookVersion = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = { list: cmdList, show: cmdShow, events: cmdEvents, fields: cmdFields, preview: cmdPreview, apply: cmdApply };

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) {
      throw new UsageError('Usage: webhook.js <list|show|events|fields|preview|apply> <domain> … (see the header of this file)');
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const ctx = { rootDir, lookup: opts.lookup || dns.promises.lookup, newSecret: opts.newSecret };
    const result = await handler(client, rest, flags, ctx);
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
  main, checkEndpoint, normalizeEvents, buildSelectedFields, buildHeaders, unknownFields, isBlockedAddress, maskHeaders, issuesOf,
};
