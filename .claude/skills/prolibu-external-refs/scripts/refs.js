#!/usr/bin/env node
'use strict';

// Links Prolibu records to records in another system through the built-in refId/refUrl
// fields, without creating duplicates: search by refId first, then update the one match,
// link an existing record found by a natural key, or create a new one.
//
//   refs.js find    <domain> <object> <refId>
//   refs.js check   <domain> <object>
//   refs.js preview <domain> <object> '<plan json>'
//   refs.js upsert  <domain> <object> '<plan json>' --expect <create|recordId> --confirmed [--allow-end-flow-stage]
//
// <object> is the API path of the object: contact, company, deal, product, ticket…
// The plan is inline JSON, or the path of a JSON file in a temp folder:
//   { "refId": "CUS-10482", "refUrl": "https://…", "fields": { … }, "match": { "email": "…" } }
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const OBJECT_RE = /^[a-z][a-z0-9]*$/;
// Objects that hold keys, access or sign-in rules, or are written only by the platform.
const REFUSED = new Set([
  'token', 'servicecredential', 'user', 'role', 'authenticationrule', 'oauthapp', 'oauthgrant',
  'mcpsession', 'syncconnection', 'channelprovider', 'confirmationcode', 'emailhub', 'contactsubmission',
  'account', 'deployment', 'pool', 'subscriptionplan',
]);
// The account rejects a second record with the same text refId on these objects.
const UNIQUE_OBJECTS = new Set(['contact', 'company', 'deal', 'product']);
// Objects a built-in CRM sync connection can own (SyncConnection objectType values).
const SYNC_MODELS = { contact: 'Contact', company: 'Company', deal: 'Deal', product: 'Product' };
const RESERVED_FIELDS = new Set(['_id', 'refId', 'refUrl', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', '__v']);
const LABEL_KEYS = [
  'dealName', 'companyName', 'productName', 'firstName', 'lastName', 'email', 'name', 'title', 'subject',
  'ticketName', 'taskName', 'pricebookName', 'productCode', 'dealCode', 'companyCode',
];
const SECRET_QUERY_RE = /token|secret|signature|sig$|password|passwd|apikey|api_key|key$|auth|credential/i;

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkObject(object) {
  if (!OBJECT_RE.test(String(object || ''))) {
    throw new UsageError('The object is its API path in lowercase, for example contact, company, deal or ticket.');
  }
  if (REFUSED.has(object)) {
    throw new UsageError(`${object} records hold keys, access rules or platform logs; this skill does not write them. `
      + 'Tell the user to use the Prolibu app or ask an admin.');
  }
  return object;
}

function checkRefId(refId) {
  if (typeof refId !== 'string') {
    throw new UsageError('refId must be text. Send the external id as a string ("900001", not 900001): '
      + 'a number is stored as a number, ?refId= cannot find it, and the duplicate check skips it.');
  }
  if (!refId.length) throw new UsageError('refId is empty.');
  if (refId.trim() !== refId) throw new UsageError('refId has spaces at the start or end; send the id exactly as the other system has it.');
  if (refId.length > 500) throw new UsageError('refId is longer than 500 characters; store an id, not a document.');
  return refId;
}

// A link that opens the record in the other system. Anyone who can read the record sees it,
// so it must not carry credentials.
function checkRefUrl(refUrl) {
  if (refUrl === undefined) return undefined;
  if (typeof refUrl !== 'string' || !refUrl.trim()) throw new UsageError('refUrl must be a non-empty https:// link, or be left out.');
  let url;
  try {
    url = new URL(refUrl);
  } catch {
    throw new UsageError(`refUrl is not a valid link: ${refUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError('refUrl must start with https:// (or http://).');
  if (url.username || url.password) throw new UsageError('refUrl must not contain a user name or password.');
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) {
      throw new UsageError(`refUrl carries "${key}" in its query string; it looks like a credential. Store a plain link to the record.`);
    }
  }
  return refUrl;
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
  if (!isPlainObject(plan)) throw new UsageError('The plan must be a JSON object.');
  for (const key of Object.keys(plan)) {
    if (!['refId', 'refUrl', 'fields', 'match'].includes(key)) {
      throw new UsageError(`Unknown plan key "${key}". Use refId, refUrl, fields and match.`);
    }
  }
  checkRefId(plan.refId);
  checkRefUrl(plan.refUrl);
  const fields = plan.fields === undefined ? {} : plan.fields;
  if (!isPlainObject(fields)) throw new UsageError('"fields" must be an object of the record fields to write.');
  for (const key of Object.keys(fields)) {
    if (RESERVED_FIELDS.has(key) || key.startsWith('$') || key.includes('.')) {
      throw new UsageError(`fields.${key} cannot be set here. refId and refUrl go at the top of the plan; `
        + 'system fields are set by the platform; nested values go as nested objects.');
    }
  }
  let match;
  if (plan.match !== undefined) {
    if (!isPlainObject(plan.match) || !Object.keys(plan.match).length) {
      throw new UsageError('"match" must be an object such as {"email": "ana@acme.com"}.');
    }
    match = {};
    for (const [key, value] of Object.entries(plan.match)) {
      if (key.startsWith('$') || RESERVED_FIELDS.has(key)) throw new UsageError(`match.${key} is not allowed.`);
      if (!['string', 'number', 'boolean'].includes(typeof value) || value === '') {
        throw new UsageError(`match.${key} must be a plain text, number or true/false value.`);
      }
      // Emails are stored in lowercase by the platform.
      match[key] = key === 'email' && typeof value === 'string' ? value.trim().toLowerCase() : value;
    }
  }
  return {
    refId: plan.refId, refUrl: plan.refUrl, fields, match,
  };
}

function label(record) {
  const parts = [];
  for (const key of LABEL_KEYS) {
    const value = record && record[key];
    if (typeof value === 'string' && value.trim() && parts.length < 3) parts.push(value.trim());
  }
  return parts.join(' · ') || null;
}

function summarize(record) {
  return {
    _id: record._id,
    label: label(record),
    refId: record.refId === undefined ? null : record.refId,
    refUrl: record.refUrl || null,
    updatedAt: record.updatedAt || null,
  };
}

// What an update would change: only the fields whose stored value differs.
function diffFields(record, plan, { link = false } = {}) {
  const changes = {};
  for (const [key, value] of Object.entries(plan.fields)) {
    const current = record[key];
    // The platform merges plain objects key by key, so compare only the keys sent.
    if (isPlainObject(value) && isPlainObject(current)) {
      const sub = {};
      for (const [k, v] of Object.entries(value)) {
        if (!sameValue(current[k], v)) sub[k] = { from: current[k] === undefined ? null : current[k], to: v };
      }
      if (Object.keys(sub).length) changes[key] = sub;
    } else if (!sameValue(current, value)) {
      changes[key] = { from: current === undefined ? null : current, to: value };
    }
  }
  if (link || record.refId !== plan.refId) changes.refId = { from: record.refId === undefined ? null : record.refId, to: plan.refId };
  if (plan.refUrl !== undefined && record.refUrl !== plan.refUrl) {
    changes.refUrl = { from: record.refUrl || null, to: plan.refUrl };
  }
  return changes;
}

function updateBody(changes, plan) {
  const body = {};
  for (const key of Object.keys(changes)) {
    if (key === 'refId') body.refId = plan.refId;
    else if (key === 'refUrl') body.refUrl = plan.refUrl;
    else body[key] = plan.fields[key];
  }
  return body;
}

// Chooses what an upsert does from what the account holds now.
function decide({ object, plan, byRef, numericTwins, byMatch }) {
  if (byRef.length > 1) {
    return {
      action: 'stop',
      reason: `${byRef.length} ${object} records already have refId "${plan.refId}". Show them to the user and let them decide; do not pick one.`,
      records: byRef.map(summarize),
    };
  }
  if (byRef.length === 1) {
    const record = byRef[0];
    const changes = diffFields(record, plan);
    if (!Object.keys(changes).length) return { action: 'none', record: summarize(record), changes };
    return { action: 'update', record: summarize(record), changes, body: updateBody(changes, plan) };
  }
  if (numericTwins.length) {
    return {
      action: 'stop',
      reason: `No record has refId "${plan.refId}" as text, but ${numericTwins.length} store it as a number `
        + `(${plan.refId}). Ask the user whether to fix that record's refId to text instead of creating another.`,
      records: numericTwins.map(summarize),
    };
  }
  if (byMatch) {
    if (byMatch.length > 1) {
      return {
        action: 'stop',
        reason: `${byMatch.length} ${object} records match ${JSON.stringify(plan.match)}. Ask the user which one to link.`,
        records: byMatch.map(summarize),
      };
    }
    if (byMatch.length === 1) {
      const record = byMatch[0];
      const linkedElsewhere = record.refId !== undefined && record.refId !== null && record.refId !== '';
      if (linkedElsewhere) {
        return {
          action: 'stop',
          reason: `The record that matches ${JSON.stringify(plan.match)} is already linked to refId "${record.refId}". `
            + 'It may belong to another integration. Ask the user before replacing it.',
          records: [summarize(record)],
        };
      }
      const changes = diffFields(record, plan, { link: true });
      return { action: 'link', record: summarize(record), changes, body: updateBody(changes, plan) };
    }
  }
  const body = { ...plan.fields, refId: plan.refId };
  if (plan.refUrl !== undefined) body.refUrl = plan.refUrl;
  return { action: 'create', body };
}

// ─── API steps ─────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.body;
}

function rows(body) {
  if (Array.isArray(body)) return body;
  return (body && Array.isArray(body.data)) ? body.data : [];
}

async function findByRef(client, object, refId) {
  // ?refId= compares text: the query string value always arrives as text.
  const query = new URLSearchParams({ refId, limit: '3' });
  return rows(await call(client, 'GET', `/v2/${object}?${query}`));
}

// The same id stored as a number is invisible to ?refId= and to the duplicate check.
async function findNumericTwins(client, object, refId) {
  if (!/^-?\d{1,15}(\.\d+)?$/.test(refId)) return [];
  const query = new URLSearchParams({ xquery: JSON.stringify({ refId: Number(refId) }), limit: '3' });
  return rows(await call(client, 'GET', `/v2/${object}?${query}`));
}

async function findByMatch(client, object, match) {
  // One condition per field: equality only, which the API keeps as sent.
  const query = new URLSearchParams({ xquery: JSON.stringify(match), limit: '3' });
  return rows(await call(client, 'GET', `/v2/${object}?${query}`));
}

// Whether a built-in CRM sync connection owns refId on this object.
async function syncCoverage(client, object) {
  const model = SYNC_MODELS[object];
  if (!model) return { owned: false, connections: [], note: 'Built-in sync connections do not cover this object.' };
  const query = new URLSearchParams({ select: 'connectionName connector active scope workspace objects', limit: '100' });
  let body;
  try {
    body = await call(client, 'GET', `/v2/syncconnection?${query}`);
  } catch (err) {
    return {
      owned: null,
      connections: [],
      note: `Could not read the sync connections (${err.status || 'network error'}). You cannot tell whether a sync owns refId: ask an admin.`,
    };
  }
  const connections = rows(body)
    .filter((c) => c.active !== false)
    .filter((c) => (c.objects || []).some((o) => o.objectType === model && o.active !== false && o.direction && o.direction !== 'off'))
    .map((c) => ({
      _id: c._id,
      connectionName: c.connectionName || null,
      connector: c.connector || null,
      scope: c.scope || null,
      direction: (c.objects.find((o) => o.objectType === model) || {}).direction,
    }));
  return {
    owned: connections.length > 0,
    connections,
    note: connections.length
      ? `An active ${connections[0].connector || 'CRM'} sync owns refId on ${model}: it writes its own id there and uses it to update the external record.`
      : `No active sync connection covers ${model}.`,
  };
}

async function endFlowBlocker(client, object, recordId) {
  if (object !== 'deal' || !recordId) return null;
  const deal = await call(client, 'GET', `/v2/deal/${recordId}?${new URLSearchParams({ select: 'stage' })}`);
  const stageId = deal.stage && typeof deal.stage === 'object' ? deal.stage._id : deal.stage;
  if (!stageId) return null;
  const stage = await call(client, 'GET', `/v2/stage/${stageId}?${new URLSearchParams({ select: 'stageName endFlowStage' })}`);
  if (!stage.endFlowStage) return null;
  return `The deal is in "${stage.stageName}", an end-of-flow stage: the account rejects edits there, refId and refUrl `
    + 'included, unless an admin allowed edits in end-flow stages.';
}

async function prepare(client, object, plan, flags = {}) {
  const sync = await syncCoverage(client, object);
  const byRef = await findByRef(client, object, plan.refId);
  const numericTwins = byRef.length ? [] : await findNumericTwins(client, object, plan.refId);
  const byMatch = !byRef.length && !numericTwins.length && plan.match ? await findByMatch(client, object, plan.match) : null;
  const decision = decide({
    object, plan, byRef, numericTwins, byMatch,
  });
  const blockers = [];
  if (sync.owned === true) blockers.push(`${sync.note} Writing refId here would point the sync at the wrong record. Use a custom field for this id.`);
  if (sync.owned === null) blockers.push(sync.note);
  if (decision.action === 'stop') blockers.push(decision.reason);
  if (['update', 'link'].includes(decision.action) && !flags.allowEndFlowStage) {
    const blocker = await endFlowBlocker(client, object, decision.record._id);
    if (blocker) blockers.push(blocker);
  }
  const warnings = [];
  if (!UNIQUE_OBJECTS.has(object)) {
    warnings.push(`${object} does not reject duplicate refIds: this search is the only guard, so never create ${object} records with refId another way.`);
  }
  if (decision.action === 'create' && !plan.match) {
    warnings.push('No "match" was given: if this record may already exist in the account without a refId, '
      + 'add a match (for example the email) so it is linked instead of created again.');
  }
  return {
    sync, decision, blockers, warnings,
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdFind(client, [object, refId]) {
  checkObject(object);
  if (refId === undefined) throw new UsageError('Usage: refs.js find <domain> <object> <refId>');
  checkRefId(refId);
  const byRef = await findByRef(client, object, refId);
  const twins = await findNumericTwins(client, object, refId);
  return {
    object,
    refId,
    count: byRef.length,
    records: byRef.map(summarize),
    numericTwins: twins.map(summarize),
    note: byRef.length > 1 ? 'Several records share this refId: show them to the user; do not pick one.' : undefined,
  };
}

async function cmdCheck(client, [object]) {
  checkObject(object);
  const sync = await syncCoverage(client, object);
  return {
    object,
    canWriteRefId: sync.owned === false,
    sync,
    uniqueRule: UNIQUE_OBJECTS.has(object)
      ? 'The account rejects a second record with the same text refId on this object (across all workspaces), '
        + 'unless the rule was left off because of older duplicates. Search first anyway.'
      : 'None: two records of this object can share a refId. Search before every create.',
  };
}

async function cmdPreview(client, [object, planArg], flags, ctx) {
  checkObject(object);
  if (!planArg) throw new UsageError("Usage: refs.js preview <domain> <object> '<plan json>'");
  const plan = readPlan(planArg, ctx.rootDir);
  const { sync, decision, blockers, warnings } = await prepare(client, object, plan, flags);
  const expect = decision.action === 'create' ? 'create' : (decision.record && decision.record._id) || null;
  let nextStep = `Show this to the user. Only after an explicit yes, run upsert with the same plan, --expect ${expect} and --confirmed.`;
  if (decision.action === 'none') nextStep = 'Nothing to change: the record already holds these values.';
  if (blockers.length) nextStep = 'Blocked: explain why to the user; do not upsert.';
  return {
    object,
    refId: plan.refId,
    action: decision.action,
    record: decision.record || null,
    records: decision.records,
    changes: decision.changes,
    body: decision.body,
    sync: sync.note,
    warnings,
    blockers,
    expect: blockers.length || decision.action === 'none' ? null : expect,
    nextStep,
  };
}

async function cmdUpsert(client, [object, planArg], flags, ctx) {
  checkObject(object);
  if (!planArg) throw new UsageError("Usage: refs.js upsert <domain> <object> '<plan json>' --expect <create|recordId> --confirmed");
  if (!flags.expect) throw new UsageError('Missing --expect. Run preview first and pass its "expect" value: upsert only does what the user saw.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const { decision, blockers } = await prepare(client, object, plan, flags);
  if (blockers.length) throw new Blocked(blockers.join(' '));
  if (decision.action === 'none') {
    return { saved: true, action: 'none', record: decision.record, problems: [] };
  }
  const now = decision.action === 'create' ? 'create' : decision.record._id;
  if (now !== flags.expect) {
    throw new Blocked(`The account changed since the preview (it now means "${decision.action}"${decision.record ? ` on ${decision.record._id}` : ''}). `
      + 'Nothing was written. Run preview again and show the user the new result.');
  }

  let recordId;
  if (decision.action === 'create') {
    try {
      const created = await call(client, 'POST', `/v2/${object}`, { data: decision.body, confirmed: true });
      recordId = created && created._id;
    } catch (err) {
      // On contact, company, deal and product a 400 here is often "this refId already exists":
      // someone created it between the preview and now.
      if (err.status === 400) {
        const winner = await findByRef(client, object, plan.refId);
        if (winner.length) {
          throw new Blocked(`Another process created a ${object} with refId "${plan.refId}" in the meantime `
            + `(${winner.map((r) => r._id).join(', ')}). Nothing was written. Run preview again to update it instead.`);
        }
      }
      throw err;
    }
  } else {
    recordId = decision.record._id;
    await call(client, 'PATCH', `/v2/${object}/${recordId}`, { data: decision.body, confirmed: true });
  }

  // Read back: exactly one record must answer to this refId, and it must be ours.
  const after = await findByRef(client, object, plan.refId);
  const problems = [];
  if (after.length !== 1) problems.push(`${after.length} ${object} records answer to refId "${plan.refId}" after the write; expected exactly 1.`);
  const mine = after.find((r) => String(r._id) === String(recordId));
  const saved = {};
  if (!mine) {
    problems.push(`The written record ${recordId} is not found by refId "${plan.refId}".`);
  } else {
    if (mine.refId !== plan.refId) problems.push(`refId was saved as ${JSON.stringify(mine.refId)}, not "${plan.refId}".`);
    if (plan.refUrl !== undefined && mine.refUrl !== plan.refUrl) problems.push(`refUrl was saved as ${JSON.stringify(mine.refUrl)}.`);
    for (const key of Object.keys(decision.body)) saved[key] = mine[key] === undefined ? null : mine[key];
  }
  return {
    saved: problems.length === 0,
    action: decision.action,
    record: mine ? summarize(mine) : { _id: recordId },
    savedValues: saved,
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
    else if (arg === '--allow-end-flow-stage') flags.allowEndFlowStage = true;
    else if (arg === '--expect') flags.expect = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return {
    command: positional[0], domain: positional[1], rest: positional.slice(2), flags,
  };
}

const COMMANDS = {
  find: cmdFind, check: cmdCheck, preview: cmdPreview, upsert: cmdUpsert,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const {
      command, domain, rest, flags,
    } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) {
      throw new UsageError('Usage: refs.js <find|check|preview|upsert> <domain> <object> … (see the header of this file)');
    }
    client = createClient({
      domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr,
    });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'upsert' && !result.saved) return 1;
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
  main, readPlan, decide, diffFields, checkRefUrl, checkRefId,
};
