#!/usr/bin/env node
'use strict';

// Moves configuration from one Prolibu account to another (usually a dev or sandbox account to
// production) without pushing profiles: export a bundle of chosen objects with their
// dependencies, rewrite every reference by a stable key (codes, e-mails, never _id), diff it
// against the target, preview, apply with --version and --confirmed, and read back.
//
//   promote.js kinds
//   promote.js list    <domain> <kind> [text]
//   promote.js export  <source> '<selection json>' [--out <temp file>]
//   promote.js diff    <target> <bundle file> [--map '<json>'] [--override '<json>']
//   promote.js preview <target> <bundle file> [--map …] [--override …] [--to-production]
//   promote.js apply   <target> <bundle file> [--map …] [--override …] --version <v> --confirmed [--to-production]
//
// Selection: {"items": [{"kind": "endpoint", "key": "orders-push"}], "kinds": ["stage"], "dependencies": true}
// --map renames stable keys in the target: {"script:orders-push-dev": "orders-push"}.
// --override sets target-only values: {"webhook:WHK-1": {"endpoint": "https://hooks.example.com/x"}}.
// Secrets (script variable values, webhook header values, form passwords, credentials) are
// never exported; the preview lists them under "setByHand".
// Every command accepts --profile <name>. Exit codes: 0 ok, 1 API error, 2 usage, 3 blocked.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createClient, assertDataFileAllowed, isLikelyProduction, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
const { checkForm } = require('../../prolibu-forms/scripts/form');
const { checkEndpoint, normalizeEvents, unknownFields } = require('../../prolibu-webhooks/scripts/webhook');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const FORMAT = 'prolibu-config-bundle';
const KIND_CAP = 200;
const BIG_TEXT = 400;

class Blocked extends Error {}
class Forbidden extends Error {}

// Fields the platform sets, or that only mean something on the account they came from.
const COMMON_DROP = ['_id', '__v', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'deletedAt', 'deletedBy',
  'isDeleted', 'refId', 'refUrl', 'workspace'];

// Records outside the bundle that configuration points at, and the stable key used to find
// them on the target.
const REF_MODELS = {
  User: { path: 'user', key: 'email' },
  UserGroup: { path: 'usergroup', key: 'userGroupCode' },
  Role: { path: 'role', key: 'keyname' },
  Stage: { path: 'stage', key: 'stageCode', kind: 'stage' },
  Script: { path: 'script', key: 'scriptCode', kind: 'script' },
  ContentTemplate: { path: 'contenttemplate', key: 'contentTemplateCode', kind: 'contentTemplate' },
  MessageTemplate: { path: 'messagetemplate', key: 'messageTemplateCode', kind: 'messageTemplate' },
  Form: { path: 'form', key: 'formCode', kind: 'form' },
};
// Order used to identify an id found where no reference was expected (filters, defaults).
const PROBE_ORDER = ['Stage', 'User', 'UserGroup', 'Role', 'Script', 'ContentTemplate', 'MessageTemplate', 'Form', 'File'];

const KINDS = {
  script: {
    path: 'script', key: 'scriptCode', name: 'scriptName', order: 1, apply: true,
    refs: { assignee: 'User', 'collaborators[]': 'User' },
  },
  contentTemplate: {
    path: 'contenttemplate', key: 'contentTemplateCode', name: 'contentTemplateName', order: 1, apply: true,
    drop: ['library', 'defaultLayout'],
    refs: { assignee: 'User', 'collaborators[]': 'User' },
    strip: { 'assets[]': 'image files attached to the template (re-upload them in the target if the design needs them)' },
  },
  stage: {
    path: 'stage', key: 'stageCode', name: 'stageName', order: 1, apply: true, drop: ['protected'],
  },
  customFilter: {
    path: 'customfilter', key: 'customFilterCode', name: 'customFilterName', order: 2, apply: true,
  },
  messageTemplate: {
    path: 'messagetemplate', key: 'messageTemplateCode', name: 'messageTemplateName', order: 2, apply: true,
    drop: ['whatsappStatus', 'syncStatus', 'rejectionReason', 'bodyPreview', 'contentText', 'externalName', 'meta'],
    refs: { assignee: 'User', 'collaborators[]': 'User', 'presentation.layout': 'ContentTemplate' },
    strip: {
      channel: 'the WhatsApp channel (pick it in the target app; saving a channel submits the template to WhatsApp review)',
      'assets[]': 'image files attached to the template (the HTML still points to the source account\'s files)',
    },
  },
  endpoint: {
    path: 'endpoint', key: 'routeName', name: 'endpointName', order: 3, apply: true, drop: ['endpointCode'],
    refs: { script: 'Script', 'authentication.requiredRoles[]': 'Role', 'collaborators[]': 'User' },
  },
  form: {
    path: 'form', key: 'formCode', name: 'formName', order: 3, apply: true, drop: ['endings', 'metaMapping'],
    refs: {
      assignmentGroup: 'UserGroup', 'mappings[].assignmentGroup': 'UserGroup', 'submissions.notifyOnSubmit[]': 'User',
    },
  },
  webhook: {
    path: 'webhook', key: 'webhookCode', name: 'webhookName', order: 4, apply: true,
  },
  customUi: {
    path: 'customui', key: 'customUiCode', name: 'customUiName', order: 4, apply: true,
    refs: { assignee: 'User', 'collaborators[]': 'User' },
  },
  report: {
    path: 'report', key: 'reportCode', name: 'reportName', order: 9, apply: false,
    why: 'Reports are rebuilt in the target with prolibu-dashboards (its tools validate them); this skill only exports and compares them.',
  },
  dashboard: {
    path: 'dashboard', key: 'dashboardCode', name: 'dashboardName', order: 9, apply: false,
    why: 'Dashboards point to widgets of reports by id; rebuild them in the target with prolibu-dashboards.',
  },
  customField: {
    path: 'customfield', key: 'objectAssigned', name: 'objectAssigned', order: 0, apply: false,
    why: 'Saving custom fields restarts the account\'s servers: an admin adds them by hand (or with prolibu-custom-fields, with its own yes).',
  },
  cob: {
    path: 'cob', key: 'modelName', name: 'modelName', order: 0, apply: false,
    why: 'Saving a custom object restarts the account\'s servers: an admin creates it by hand (or with prolibu-custom-fields, with its own yes).',
  },
};

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

function hashOf(v) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 16);
}

// A populated reference ({_id, …}) compares as its id.
function idsOnly(v) {
  if (Array.isArray(v)) return v.map(idsOnly);
  if (isPlainObject(v)) {
    if (typeof v._id === 'string' && ID_RE.test(v._id) && !('$ref' in v)) return v._id;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = idsOnly(x);
    return out;
  }
  return v;
}

// True when every key of `sent` is in `saved` with the same value (arrays exact).
function contains(saved, sent) {
  if (isPlainObject(sent)) {
    if (!isPlainObject(saved)) return false;
    return Object.entries(sent).every(([k, v]) => contains(saved[k], v));
  }
  if (Array.isArray(sent)) {
    return Array.isArray(saved) && saved.length === sent.length && sent.every((v, i) => contains(saved[i], v));
  }
  if (sent === null || sent === undefined) return saved === null || saved === undefined;
  return JSON.stringify(saved) === JSON.stringify(sent);
}

function rowsOf(body) {
  return Array.isArray(body) ? body : (body && body.data) || [];
}

function refKey(kind, key) {
  return `${kind}:${key}`;
}

function isRef(v) {
  return isPlainObject(v) && isPlainObject(v.$ref);
}

// Walks a value and calls visit(pattern, value) on every 24-hex string. The pattern is the
// dotted path with [] for array items ("mappings[].assignmentGroup"). visit returns
// undefined (keep), STRIP (remove) or a replacement.
const STRIP = Symbol('strip');
function walkIds(value, visit, pattern = '') {
  if (typeof value === 'string') return ID_RE.test(value) ? visit(pattern, value) : undefined;
  if (Array.isArray(value)) {
    const out = [];
    let changed = false;
    for (const item of value) {
      const r = walkIds(item, visit, `${pattern}[]`);
      if (r === STRIP) { changed = true; continue; }
      if (r !== undefined) { changed = true; out.push(r); } else out.push(item);
    }
    return changed ? out : undefined;
  }
  if (isPlainObject(value)) {
    if (isRef(value)) return undefined;
    const out = { ...value };
    let changed = false;
    for (const [k, v] of Object.entries(value)) {
      const r = walkIds(v, visit, pattern ? `${pattern}.${k}` : k);
      if (r === STRIP) { delete out[k]; changed = true; } else if (r !== undefined) { out[k] = r; changed = true; }
    }
    return changed ? out : undefined;
  }
  return undefined;
}

// Replaces every $ref with what resolve(ref) returns (an id, or a placeholder string).
function mapRefs(value, resolve) {
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, resolve));
  if (isRef(value)) return resolve(value.$ref);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapRefs(v, resolve);
    return out;
  }
  return value;
}

function collectRefs(value, list = []) {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, list));
  else if (isRef(value)) list.push(value.$ref);
  else if (isPlainObject(value)) Object.values(value).forEach((v) => collectRefs(v, list));
  return list;
}

// What changed, without printing long texts (code, HTML) in full.
function describeValue(v) {
  if (typeof v === 'string' && v.length > BIG_TEXT) return { text: true, lines: v.split('\n').length, hash: hashOf(v) };
  const s = JSON.stringify(v);
  if (s !== undefined && s.length > BIG_TEXT) return { json: true, size: s.length, hash: hashOf(v) };
  return v === undefined ? null : v;
}

// Code and HTML may carry things that only fit the source account.
function contentWarnings(label, text, sourceDomain) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  if (sourceDomain && text.toLowerCase().includes(String(sourceDomain).toLowerCase())) {
    out.push(`${label} mentions the source account (${sourceDomain}); check that address before going live.`);
  }
  if (/(api[_-]?key|secret|token|password|bearer)["']?\s*[:=]\s*["'`][^"'`\s]{12,}/i.test(text) || /\bBearer\s+[A-Za-z0-9._-]{20,}/.test(text)) {
    out.push(`${label} seems to contain a key or token written in the code. It was not printed; move it to the script's variables and set it by hand.`);
  }
  return out;
}

// Removes secrets and account-only values from one exported record. Returns the clean data,
// what the target needs by hand, and notes.
function sanitize(kind, doc) {
  const def = KINDS[kind];
  const data = clone(doc);
  for (const f of [...COMMON_DROP, ...(def.drop || [])]) delete data[f];
  const setByHand = [];
  const notes = [];
  if (kind === 'script') {
    const keys = (Array.isArray(doc.variables) ? doc.variables : []).map((v) => v && v.key).filter(Boolean);
    data.variables = keys;
    if (keys.length) setByHand.push(`values of the script variables ${keys.join(', ')} (never copied)`);
  }
  if (kind === 'webhook') {
    const names = (Array.isArray(doc.headers) ? doc.headers : []).map((h) => h && h.name).filter(Boolean);
    data.headers = names;
    if (names.length) setByHand.push(`values of the headers ${names.join(', ')} (never copied; set them with prolibu-webhooks)`);
    delete data.endpoint;
    data.sourceEndpointHost = (() => { try { return new URL(doc.endpoint).host; } catch { return null; } })();
  }
  if (kind === 'form') {
    if (data.access) {
      if (data.access.password) setByHand.push('the form password (never copied)');
      if (data.access.serviceCredential) setByHand.push('the captcha credential of the target, if it uses a specific one');
      delete data.access.password;
      delete data.access.serviceCredential;
    }
  }
  if (kind === 'customField' || kind === 'cob') {
    delete data.status;
  }
  return { data, setByHand, notes };
}

function parseJsonArg(arg, rootDir, what) {
  if (arg === undefined) return undefined;
  let text = String(arg);
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the ${what} file.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`The ${what} is not valid JSON.`);
  }
}

function checkKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) {
    throw new UsageError(`Unknown kind "${kind}". Kinds: ${Object.keys(KINDS).join(', ')}.`);
  }
  return KINDS[kind];
}

function readSelection(sel) {
  if (!isPlainObject(sel)) throw new UsageError('The selection must be a JSON object: {"items": [{"kind": "…", "key": "…"}]}.');
  const allowed = new Set(['items', 'kinds', 'dependencies']);
  for (const k of Object.keys(sel)) if (!allowed.has(k)) throw new UsageError(`Unknown selection field "${k}".`);
  const items = Array.isArray(sel.items) ? sel.items : [];
  const kinds = Array.isArray(sel.kinds) ? sel.kinds : [];
  if (!items.length && !kinds.length) throw new UsageError('The selection has no "items" and no "kinds".');
  for (const [i, it] of items.entries()) {
    if (!isPlainObject(it) || typeof it.kind !== 'string' || typeof it.key !== 'string' || !it.key.trim()) {
      throw new UsageError(`items[${i}] needs "kind" and "key" (the stable key or the _id).`);
    }
    checkKind(it.kind);
  }
  kinds.forEach((k) => checkKind(String(k)));
  return { items, kinds: kinds.map(String), dependencies: sel.dependencies !== false };
}

function readMap(map) {
  if (map === undefined) return {};
  if (!isPlainObject(map)) throw new UsageError('--map must be a JSON object {"kind:oldKey": "newKey"}.');
  for (const [from, to] of Object.entries(map)) {
    const [kind, ...rest] = from.split(':');
    checkKind(kind);
    if (!rest.length || typeof to !== 'string' || !KEY_RE.test(to)) {
      throw new UsageError(`--map entry "${from}" must map "kind:key" to a new key (letters, digits, . _ - @ +).`);
    }
  }
  return map;
}

function readOverride(ov) {
  if (ov === undefined) return {};
  if (!isPlainObject(ov)) throw new UsageError('--override must be a JSON object {"kind:key": {"field": value}}.');
  for (const [k, v] of Object.entries(ov)) {
    checkKind(k.split(':')[0]);
    if (!isPlainObject(v)) throw new UsageError(`--override "${k}" must be an object of fields.`);
    for (const f of Object.keys(v)) {
      if (COMMON_DROP.includes(f) || f === KINDS[k.split(':')[0]].key) throw new UsageError(`--override cannot set "${f}".`);
      if (['variables', 'headers'].includes(f)) throw new UsageError(`--override cannot set "${f}": secrets are set by hand in the target.`);
    }
  }
  return ov;
}

function readBundle(file, rootDir) {
  if (!file) throw new UsageError('Missing the bundle file (from export).');
  const bundle = parseJsonArg(file, rootDir, 'bundle');
  if (!isPlainObject(bundle) || bundle.format !== FORMAT || !Array.isArray(bundle.objects)) {
    throw new UsageError('This file is not a promotion bundle made by export.');
  }
  if (bundle.hash !== hashOf(bundle.objects)) {
    throw new UsageError('The bundle was edited after export (its hash does not match). Export it again.');
  }
  return bundle;
}

function defaultOut(source) {
  const dir = process.env.CLAUDE_SCRATCHPAD || os.tmpdir();
  return path.join(dir, `prolibu-bundle-${source}-${Date.now()}.json`);
}

// ─── API helpers ───────────────────────────────────────────────────────────────

async function call(client, method, reqPath, opts) {
  const res = await client.request(method, reqPath, opts);
  if (res.status === 403) {
    throw new Forbidden(`${method} ${reqPath.split('?')[0]} answered 403: this profile's user may not do this. Stop here; do not retry another way.`);
  }
  if (!res.ok) {
    const body = isPlainObject(res.body) ? res.body : { error: res.body };
    const err = new Error(`${method} ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function findByKey(client, pathName, keyField, key, select) {
  const qs = new URLSearchParams({ xquery: JSON.stringify({ [keyField]: key }), limit: '2' });
  if (select) qs.set('select', select);
  const rows = rowsOf(await call(client, 'GET', `/v2/${pathName}?${qs}`));
  // An unknown field in xquery is dropped and every record comes back: confirm the key.
  return rows.filter((r) => r && r[keyField] === key);
}

async function loadFull(client, pathName, id) {
  return call(client, 'GET', `/v2/${pathName}/${id}`);
}

async function findObject(client, kind, keyOrId) {
  const def = KINDS[kind];
  if (ID_RE.test(keyOrId)) {
    const res = await client.request('GET', `/v2/${def.path}/${keyOrId}`);
    if (res.status === 403) throw new Forbidden(`GET /v2/${def.path} answered 403: this profile's user may not read ${kind}. Stop here.`);
    if (res.ok && res.body && res.body._id === keyOrId) return res.body;
  }
  const rows = await findByKey(client, def.path, def.key, keyOrId, `_id ${def.key}`);
  if (rows.length > 1) throw new Blocked(`Two ${kind} records have ${def.key} "${keyOrId}"; fix that in the app first.`);
  return rows.length ? loadFull(client, def.path, rows[0]._id) : null;
}

// Identifies an id in the source account: which model it is and its stable key.
async function identify(client, id, model, cache) {
  const cacheKey = `${model || '*'}:${id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const candidates = model ? [model] : PROBE_ORDER;
  let found = null;
  for (const m of candidates) {
    const pathName = m === 'File' ? 'file' : REF_MODELS[m].path;
    const select = m === 'File' ? 'fileName' : REF_MODELS[m].key;
    const res = await client.request('GET', `/v2/${pathName}/${id}?${new URLSearchParams({ select })}`);
    if (res.ok && res.body && res.body._id === id) {
      found = m === 'File' ? { model: 'File' } : { model: m, key: REF_MODELS[m].key, value: res.body[REF_MODELS[m].key] };
      break;
    }
  }
  cache.set(cacheKey, found);
  return found;
}

// ─── Export ────────────────────────────────────────────────────────────────────

async function exportOne(client, kind, doc, ctx) {
  const def = KINDS[kind];
  const { data, setByHand, notes } = sanitize(kind, doc);
  const unresolved = [];
  const stripped = [];
  const pending = [];
  // Export-only kinds are compared, never written: their ids stay as they are (no lookups).
  if (def.apply) walkIds(data, (pattern, id) => { pending.push({ pattern, id }); return undefined; });
  const decisions = new Map();
  for (const { pattern, id } of pending) {
    if (decisions.has(`${pattern}|${id}`)) continue;
    const known = (def.refs || {})[pattern];
    const strip = (def.strip || {})[pattern];
    if (strip) { decisions.set(`${pattern}|${id}`, { strip }); continue; }
    const who = await identify(client, id, known, ctx.cache);
    decisions.set(`${pattern}|${id}`, who ? { who } : { unknown: true });
  }
  const rewritten = !def.apply ? undefined : walkIds(data, (pattern, id) => {
    const d = decisions.get(`${pattern}|${id}`);
    if (d.strip) { stripped.push(`${pattern}: ${d.strip}`); return STRIP; }
    if (d.unknown) { unresolved.push(`${pattern} = ${id}`); return { $ref: { model: null, id, at: pattern } }; }
    if (d.who.model === 'File') { stripped.push(`${pattern}: a file of the source account (re-upload it in the target)`); return STRIP; }
    return { $ref: { model: d.who.model, key: d.who.key, value: d.who.value, at: pattern } };
  });
  const clean = rewritten === undefined ? data : rewritten;
  const warnings = [];
  for (const f of ['code', 'content', 'html', 'subject']) {
    warnings.push(...contentWarnings(`${kind} ${doc[def.key]} ${f}`, doc[f], ctx.source));
  }
  if (stripped.length) setByHand.push(...stripped.map((s) => `${s}`));
  return {
    kind,
    key: doc[def.key],
    name: doc[def.name],
    sourceUpdatedAt: doc.updatedAt || null,
    data: clean,
    setByHand,
    notes,
    warnings,
    unresolved,
  };
}

// Only what an object owns travels with it: an endpoint's script, an e-mail template's layout.
// Stages, users, groups and forms it points to must already exist in the target (or be selected).
const OWNED = new Set(['Script', 'ContentTemplate']);

function dependenciesOf(obj) {
  return collectRefs(obj.data)
    .filter((r) => OWNED.has(r.model))
    .map((r) => ({ kind: REF_MODELS[r.model].kind, key: r.value }));
}

async function cmdExport(client, [selArg], flags, ctx) {
  const sel = readSelection(parseJsonArg(selArg, ctx.rootDir, 'selection'));
  const out = flags.out || defaultOut(client.domain);
  assertDataFileAllowed(out, ctx.rootDir);
  const exportCtx = { cache: new Map(), source: client.domain };
  const objects = [];
  const seen = new Set();
  const missing = [];
  const truncated = [];
  const queue = sel.items.map((it) => ({ ...it, requested: true }));

  for (const kind of sel.kinds) {
    const def = KINDS[kind];
    const qs = new URLSearchParams({ select: `_id ${def.key}`, limit: String(KIND_CAP), sort: def.key });
    const body = await call(client, 'GET', `/v2/${def.path}?${qs}`);
    const rows = rowsOf(body);
    if (body && body.pagination && body.pagination.count > rows.length) truncated.push(`${kind}: ${rows.length} of ${body.pagination.count}`);
    rows.forEach((r) => queue.push({ kind, key: r._id, requested: true }));
  }

  while (queue.length) {
    const it = queue.shift();
    const doc = await findObject(client, it.kind, it.key);
    if (!doc) {
      missing.push(`${it.kind} ${it.key}`);
      continue;
    }
    const id = refKey(it.kind, doc[KINDS[it.kind].key]);
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = await exportOne(client, it.kind, doc, exportCtx);
    obj.requested = Boolean(it.requested);
    objects.push(obj);
    if (sel.dependencies) dependenciesOf(obj).forEach((d) => queue.push({ ...d, requested: false }));
  }
  if (missing.length && !objects.length) throw new Blocked(`Nothing found in ${client.domain}: ${missing.join(', ')}.`);

  objects.sort((a, b) => KINDS[a.kind].order - KINDS[b.kind].order);
  const bundle = {
    format: FORMAT,
    formatVersion: 1,
    source: client.domain,
    exportedAt: new Date().toISOString(),
    selection: sel,
    objects,
    hash: hashOf(objects),
  };
  fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return {
    bundle: out,
    source: client.domain,
    objects: objects.map((o) => ({
      kind: o.kind, key: o.key, name: o.name, requested: o.requested, applies: KINDS[o.kind].apply,
      ...(o.unresolved.length ? { unresolved: o.unresolved } : {}),
      ...(o.setByHand.length ? { setByHand: o.setByHand } : {}),
      ...(o.warnings.length ? { warnings: o.warnings } : {}),
    })),
    missing,
    truncated,
    nextStep: 'The bundle holds no secrets. Run diff or preview against the target account with this file.',
  };
}

// ─── Plan against the target ───────────────────────────────────────────────────

async function targetPrefs(client) {
  const res = await client.request('GET', '/v2/preference/read');
  if (res.ok) return (res.body && res.body.preference) || res.body || {};
  const pub = await client.request('GET', '/v2/user/preferences');
  if (pub.ok) return (pub.body && pub.body.preference) || pub.body || {};
  return null;
}

async function columnsOf(client, model, cache) {
  if (cache.has(model)) return cache.get(model);
  const res = await client.request('GET', `/v2/service/getschema?${new URLSearchParams({ modelNames: model, type: 'columns' })}`);
  const cols = res.ok ? (Array.isArray(res.body) ? res.body : (res.body && res.body[model]) || null) : null;
  cache.set(model, cols);
  return cols;
}

function hasColumn(columns, field) {
  return columns.some((c) => c === field || c.startsWith(`${field}.`));
}

// Finds the target id of every reference. Objects of the bundle that will be created in this
// apply resolve to a placeholder ("<new script:orders>") until they exist.
async function resolveRefs(client, objects, mapKey, created, cache) {
  const results = new Map();
  const inBundle = new Set(objects.map((o) => refKey(o.kind, o.key)));
  for (const obj of objects) {
    for (const ref of collectRefs(obj.data)) {
      const id = JSON.stringify(ref);
      if (results.has(id)) continue;
      if (!ref.model) { results.set(id, { blocker: `an id at ${ref.at} that is not a stage, user, group, role, script or template of the source (${ref.id})` }); continue; }
      const m = REF_MODELS[ref.model];
      const bundleId = m.kind && inBundle.has(refKey(m.kind, ref.value)) ? refKey(m.kind, ref.value) : null;
      const value = m.kind ? mapKey(m.kind, ref.value) : ref.value;
      if (bundleId && created.has(bundleId)) { results.set(id, { id: created.get(bundleId) }); continue; }
      const cacheKey = `${ref.model}:${value}`;
      if (!cache.has(cacheKey)) {
        const rows = await findByKey(client, m.path, m.key, value, `_id ${m.key}`);
        cache.set(cacheKey, rows.length === 1 ? rows[0]._id : null);
      }
      const found = cache.get(cacheKey);
      if (found) results.set(id, { id: found });
      else if (bundleId) results.set(id, { placeholder: `<new ${refKey(m.kind, value)}>`, bundleId });
      else results.set(id, { blocker: `${ref.model} ${m.key} "${value}" (used at ${ref.at}) does not exist in the target` });
    }
  }
  return results;
}

function materialize(data, refs) {
  return mapRefs(data, (ref) => {
    const r = refs.get(JSON.stringify(ref));
    if (r.id) return r.id;
    if (r.placeholder) return r.placeholder;
    return `<missing ${ref.model || 'id'}>`;
  });
}

// The body a create sends, from the bundle data and the target-only overrides.
function desiredBody(obj, refs, override, mapKey) {
  const def = KINDS[obj.kind];
  const data = materialize(obj.data, refs);
  delete data.sourceEndpointHost;
  const body = { ...data, ...clone(override || {}) };
  body[def.key] = mapKey(obj.kind, obj.key);
  return body;
}

// Rules per kind for a create or an update. Returns { body, blockers, warnings, setByHand }.
async function planKind(client, obj, target, body, tctx) {
  const blockers = [];
  const warnings = [];
  const setByHand = [];
  const notes = [];
  const def = KINDS[obj.kind];
  const creating = !target;

  if (obj.kind === 'script') {
    const keys = Array.isArray(body.variables) ? body.variables : [];
    if (creating) {
      body.variables = keys.map((key) => ({ key, value: '' }));
    } else {
      delete body.variables;
      const have = new Set((target.variables || []).map((v) => v && v.key));
      const lacking = keys.filter((k) => !have.has(k));
      if (lacking.length) setByHand.push(`script variables missing in the target: ${lacking.join(', ')}`);
    }
    const runsAlone = (body.lifecycleHooks || []).length || (body.scheduledTask && body.scheduledTask.periodicity) || body.runOnQuoteCalculate;
    if (runsAlone) {
      if (creating) {
        body.active = false;
        setByHand.push(`turn the script ${body.scriptCode} on in the target once its variables are set (it runs by itself: hooks, schedule or quote calculation), as its own step`);
      } else {
        delete body.active;
      }
    } else if (creating && keys.length) {
      notes.push('Created with empty variable values: calls fail until they are set.');
    }
    const hooks = body.lifecycleHooks || [];
    if (hooks.length) {
      const prefs = tctx.prefs;
      const lh = prefs && prefs.integrations && prefs.integrations.lifecycleHooks;
      if (!prefs) warnings.push('Could not read whether lifecycle hooks are on in the target.');
      else if (!lh || !lh.enabled) blockers.push('Lifecycle hooks are off in the target: the server rejects a script with hooks. An admin turns them on first.');
      else {
        const off = hooks.filter((m) => !(lh.enabledEntities || []).includes(m));
        if (off.length) blockers.push(`The target does not have lifecycle hooks on for ${off.join(', ')}: the server rejects the script. An admin enables them first.`);
      }
    }
  }

  if (obj.kind === 'endpoint') {
    const auth = body.authentication || {};
    if (auth.enabled === false) warnings.push(`PUBLIC endpoint: anyone who knows https://${client.domain}/v2/endpoint/${String(body.method || 'post').toLowerCase()}/${body.routeName} can run the script.`);
    const scriptRef = collectRefs(obj.data).find((r) => r.model === 'Script');
    if (scriptRef && /-dev$/.test(tctx.mapKey('script', scriptRef.value)) && tctx.production) {
      warnings.push('The endpoint points to a "-dev" script in production; map the script to its production code with --map.');
    }
    if (creating) {
      const clash = await findByKey(client, 'endpoint', 'routeName', body.routeName, '_id routeName');
      if (clash.length) blockers.push(`routeName ${body.routeName} is already used in the target.`);
    }
  }

  if (obj.kind === 'stage') {
    if (body.setAsDefault) warnings.push('This stage is the default of its pipeline: new records in the target will start here.');
    if (!body.stageType) blockers.push('The stage has no stageType.');
    if (target && target.stageType && body.stageType && target.stageType !== body.stageType) {
      blockers.push(`In the target, stage ${body.stageCode} belongs to ${target.stageType}, not ${body.stageType}.`);
    }
    const model = String(body.stageType || '').split('.')[0];
    const fields = [...(body.requiredFields || []), ...(body.suggestedFields || [])];
    if (model && fields.length) {
      const cols = await columnsOf(client, model, tctx.columns);
      if (!cols) warnings.push(`Could not read the fields of ${model} in the target.`);
      else {
        const lacking = fields.filter((f) => !hasColumn(cols, f));
        if (lacking.length) blockers.push(`${model} in the target has no field ${lacking.join(', ')}: create those custom fields first (by hand, it restarts the servers).`);
      }
    }
  }

  if (obj.kind === 'form') {
    if (body.type === 'meta') blockers.push('Meta lead forms are tied to an ad hub of the source account; they are not promoted.');
    const models = {};
    for (const m of body.mappings || []) {
      if (!m || !m.modelName || m.modelName in models) continue;
      const res = await client.request('GET', `/v2/form/getmodelfields/${encodeURIComponent(m.modelName)}`);
      models[m.modelName] = res.ok ? new Map(rowsOf(res.body).map((f) => [f.attrPath, f])) : null;
    }
    const merged = target ? { ...target, ...body } : body;
    const check = checkForm(merged, models, { captchaReady: null, isNew: creating });
    blockers.push(...check.errors);
    warnings.push(...check.warnings);
    if (body.access && body.access.mode === 'password' && creating) setByHand.push('the form password: the server generates one; read it in the target app');
  }

  if (obj.kind === 'webhook') {
    const headerNames = Array.isArray(body.headers) ? body.headers : [];
    delete body.headers;
    if (creating) {
      body.active = false;
      if (!tctx.override || !tctx.override.endpoint) {
        blockers.push(`The webhook needs its destination in the target: --override '{"webhook:${obj.key}": {"endpoint": "https://…"}}'.`);
      }
      if (headerNames.length) setByHand.push(`header values ${headerNames.join(', ')}: set them with prolibu-webhooks, then turn the webhook on as its own step`);
      else setByHand.push('turn the webhook on in the target as its own step');
    } else {
      delete body.active;
      const have = new Set((target.headers || []).map((h) => String(h && h.name).toLowerCase()));
      const lacking = headerNames.filter((n) => !have.has(String(n).toLowerCase()));
      if (lacking.length) setByHand.push(`headers missing in the target: ${lacking.join(', ')}`);
    }
    if (body.endpoint) {
      const ep = checkEndpoint(body.endpoint, { ownDomain: client.domain });
      if (ep.blocker) blockers.push(ep.blocker);
      else warnings.push(...ep.warnings);
    }
    try {
      const catalogBody = await call(client, 'GET', `/v2/service/getschema?${new URLSearchParams({ modelNames: 'Webhook', type: 'attrs' })}`);
      const schema = catalogBody.Webhook || catalogBody;
      const catalog = (schema && schema.eventNames && schema.eventNames.enum) || [];
      body.eventNames = normalizeEvents(body.eventNames || [], catalog).eventNames;
    } catch (err) {
      if (err instanceof Forbidden) throw err;
      blockers.push(err.message);
    }
    for (const entry of body.selectedFields || []) {
      const cols = await columnsOf(client, entry.entity, tctx.columns);
      const bad = cols ? unknownFields(entry.fields || [], cols) : [];
      if (bad.length) blockers.push(`${entry.entity} in the target has no field ${bad.join(', ')} (selectedFields).`);
    }
  }

  if (obj.kind === 'messageTemplate') {
    if (body.modelName === 'Message' && target && (target.refId || target.channel) && body.content !== undefined && body.content !== target.content) {
      blockers.push('This WhatsApp template is already tied to a channel in the target: changing its text re-submits it to WhatsApp review and loses the approval. Change it in the target app.');
    }
  }

  if (obj.kind === 'customUi') {
    if (body.code) warnings.push('This custom UI runs its own code in the browser of every user who sees it; review it before turning it on.');
    if (creating) {
      body.active = false;
      setByHand.push(`turn the custom UI ${body.customUiCode} on in the target as its own step`);
    } else delete body.active;
  }

  // A protected record (factory stages) only accepts changes to the fields it unlocks.
  if (target && typeof target.protected === 'string' && target.protected) {
    const locked = Object.keys(body).filter((f) => f !== def.key && !target.protected.includes(`-${f}`));
    if (target.protected === '*' || locked.length) {
      const lockedChanged = locked.filter((f) => !contains(idsOnly(target[f]), body[f]));
      if (target.protected === '*' || lockedChanged.length) {
        blockers.push(`${obj.kind} ${obj.key} is protected in the target; the server refuses changes to ${target.protected === '*' ? 'any field' : lockedChanged.join(', ')}.`);
      }
    }
  }
  return { body, blockers, warnings, setByHand, notes };
}

// Plain sub-objects a PATCH merges key by key: compared as a subset (the server adds defaults).
// Every other object (filters, form schemas, Mixed fields) and every array is replaced whole,
// so it must match exactly.
const MERGED = new Set(['authentication', 'access', 'thankYou', 'submissions', 'uploads', 'presentation', 'scheduledTask',
  'allowEveryone', 'git', 'display', 'sideBar', 'rowAction', 'fieldWidget', 'cellWidget', 'defaultColumns', 'retargeting']);

function sameValue(field, before, value) {
  if (MERGED.has(field) && isPlainObject(value)) return contains(before, value);
  return JSON.stringify(canonical(before === undefined ? null : before)) === JSON.stringify(canonical(value === undefined ? null : value));
}

function diffFields(target, body, keyField) {
  const changes = [];
  const patch = {};
  for (const [field, value] of Object.entries(body)) {
    if (field === keyField) continue;
    const before = target ? idsOnly(target[field]) : undefined;
    if (target && sameValue(field, before, value)) continue;
    patch[field] = value;
    changes.push({ field, before: describeValue(before), after: describeValue(value) });
  }
  return { patch, changes };
}

// Custom fields compared one by one, so the user sees which fields the target lacks.
function customFieldChanges(target, body) {
  const changes = [];
  for (const group of ['customFields', 'overrides']) {
    const want = isPlainObject(body[group]) ? body[group] : {};
    const have = target && isPlainObject(target[group]) ? target[group] : {};
    for (const [name, def] of Object.entries(want)) {
      if (!(name in have)) changes.push({ field: `${group}.${name}`, change: 'missing in the target', after: describeValue(def) });
      else if (!sameValue('', idsOnly(have[name]), def)) changes.push({ field: `${group}.${name}`, change: 'different', before: describeValue(have[name]), after: describeValue(def) });
    }
    for (const name of Object.keys(have)) if (!(name in want)) changes.push({ field: `${group}.${name}`, change: 'only in the target' });
  }
  return changes;
}

async function buildPlan(client, bundle, flags, { created = new Map() } = {}) {
  const map = readMap(flags.map);
  const override = readOverride(flags.override);
  const mapKey = (kind, key) => map[refKey(kind, key)] || key;
  const known = new Set(bundle.objects.map((o) => refKey(o.kind, o.key)));
  for (const k of [...Object.keys(map), ...Object.keys(override)]) {
    if (!known.has(k)) throw new UsageError(`"${k}" is not in the bundle. Objects: ${[...known].join(', ')}.`);
  }
  const production = isLikelyProduction(client.domain);
  const prefs = await targetPrefs(client);
  const tctx = { prefs, columns: new Map(), production, mapKey };
  const refs = await resolveRefs(client, bundle.objects, mapKey, created, new Map());
  const steps = [];
  for (const obj of bundle.objects) {
    const def = KINDS[obj.kind];
    const key = mapKey(obj.kind, obj.key);
    const target = await findObject(client, obj.kind, key);
    const step = {
      kind: obj.kind,
      key,
      ...(key !== obj.key ? { sourceKey: obj.key } : {}),
      name: obj.name,
      targetId: target ? target._id : null,
      targetUpdatedAt: target ? target.updatedAt || null : null,
      action: null,
      changes: [],
      blockers: [],
      warnings: [...obj.warnings],
      setByHand: [...obj.setByHand],
      notes: [...obj.notes],
    };
    for (const ref of collectRefs(obj.data)) {
      const r = refs.get(JSON.stringify(ref));
      if (r && r.blocker) step.blockers.push(r.blocker);
    }
    const body = desiredBody(obj, refs, override[refKey(obj.kind, obj.key)], mapKey);
    if (!def.apply) {
      const changes = obj.kind === 'customField' ? customFieldChanges(target, body) : diffFields(target, body, def.key).changes;
      step.action = target ? (changes.length ? 'differs' : 'same') : 'missing';
      step.changes = changes;
      step.exportOnly = def.why;
      step.blockers = [];
      steps.push(step);
      continue;
    }
    const planned = await planKind(client, obj, target, body, { ...tctx, override: override[refKey(obj.kind, obj.key)] });
    step.blockers.push(...planned.blockers);
    step.warnings.push(...planned.warnings);
    step.setByHand.push(...planned.setByHand);
    step.notes.push(...planned.notes);
    if (!target) {
      step.action = 'create';
      step.body = planned.body;
      step.fields = Object.keys(planned.body).filter((f) => f !== def.key);
      for (const f of ['active', 'script', 'stageType', 'modelName', 'authentication', 'access', 'eventNames', 'endpoint']) {
        if (f in planned.body) step.changes.push({ field: f, after: describeValue(planned.body[f]) });
      }
    } else {
      const { patch, changes } = diffFields(target, planned.body, def.key);
      step.action = changes.length ? 'update' : 'same';
      step.body = patch;
      step.changes = changes;
    }
    if (step.blockers.length) step.action = 'blocked';
    steps.push(step);
  }
  const version = hashOf({
    bundle: bundle.hash,
    target: client.domain,
    steps: steps.map((s) => ({ k: s.kind, key: s.key, a: s.action, b: s.body, t: s.targetUpdatedAt })),
  });
  return { steps, version, production, map, override };
}

function summarizePlan(client, bundle, plan) {
  const count = (a) => plan.steps.filter((s) => !s.exportOnly && s.action === a).length;
  const out = {
    source: bundle.source,
    target: client.domain,
    production: plan.production,
    ...(plan.production ? {
      WARNING: `${client.domain} LOOKS LIKE A PRODUCTION ACCOUNT. Writing here changes what real users and customers get. `
        + 'Apply needs --to-production on top of --confirmed, after the user says yes to production explicitly.',
    } : {}),
    totals: {
      create: count('create'), update: count('update'), same: count('same'), blocked: count('blocked'),
      exportOnly: plan.steps.filter((s) => s.exportOnly).length,
    },
    steps: plan.steps.map((s) => {
      const { body, ...rest } = s;
      for (const k of ['blockers', 'warnings', 'setByHand', 'notes', 'changes']) if (!rest[k] || !rest[k].length) delete rest[k];
      return rest;
    }),
    setByHand: plan.steps.flatMap((s) => (s.setByHand || []).map((h) => `${s.kind} ${s.key}: ${h}`)),
    version: plan.version,
  };
  return out;
}

async function cmdDiff(client, [bundleArg], flags, ctx) {
  const bundle = readBundle(bundleArg, ctx.rootDir);
  const plan = await buildPlan(client, bundle, flags);
  const out = summarizePlan(client, bundle, plan);
  delete out.version;
  const onlyInTarget = [];
  for (const kind of (bundle.selection && bundle.selection.kinds) || []) {
    const def = KINDS[kind];
    const rows = rowsOf(await call(client, 'GET', `/v2/${def.path}?${new URLSearchParams({ select: `_id ${def.key} ${def.name}`, limit: String(KIND_CAP), sort: def.key })}`));
    const have = new Set(plan.steps.filter((s) => s.kind === kind).map((s) => s.key));
    rows.filter((r) => !have.has(r[def.key])).forEach((r) => onlyInTarget.push({ kind, key: r[def.key], name: r[def.name] }));
  }
  if (onlyInTarget.length) out.onlyInTarget = onlyInTarget;
  out.nextStep = 'This is a comparison only. To copy, run preview with the same bundle.';
  return out;
}

async function cmdPreview(client, [bundleArg], flags, ctx) {
  const bundle = readBundle(bundleArg, ctx.rootDir);
  const plan = await buildPlan(client, bundle, flags);
  const out = summarizePlan(client, bundle, plan);
  const writes = out.totals.create + out.totals.update;
  if (out.totals.blocked) {
    out.nextStep = 'Blocked: tell the user what blocks each object and how to fix it. Nothing can be applied until preview shows no blocked step.';
  } else if (!writes) {
    out.nextStep = 'Nothing to write: the target already matches.';
  } else {
    out.nextStep = 'Show this to the user in plain words (what is created, what changes, what must be set by hand'
      + `${plan.production ? ', AND THAT THE TARGET IS PRODUCTION' : ''}). STOP HERE and end your turn; never write in the same turn `
      + 'as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same bundle, '
      + `--map and --override, --version ${plan.version} --confirmed${plan.production ? ' --to-production' : ''}.`;
  }
  out.blocked = out.totals.blocked > 0;
  return out;
}

async function cmdApply(client, [bundleArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  if (isLikelyProduction(client.domain) && !flags.toProduction) {
    throw new UsageError(`${client.domain} looks like a production account. Apply needs --to-production on top of --confirmed, `
      + 'given only after the user said yes to writing in production.');
  }
  const bundle = readBundle(bundleArg, ctx.rootDir);
  const plan = await buildPlan(client, bundle, flags);
  if (plan.version !== flags.version) throw new Blocked('The bundle, the options or the target changed since the preview. Preview again.');
  const blocked = plan.steps.filter((s) => s.action === 'blocked');
  if (blocked.length) throw new Blocked(blocked.map((s) => `${s.kind} ${s.key}: ${s.blockers.join(' ')}`).join(' | '));

  const created = new Map();
  const results = [];
  const map = readMap(flags.map);
  const mapKey = (kind, key) => map[refKey(kind, key)] || key;
  const override = readOverride(flags.override);
  let failed = null;
  for (const step of plan.steps) {
    if (step.exportOnly || step.action === 'same') {
      results.push({ kind: step.kind, key: step.key, action: step.exportOnly ? 'skipped (export only)' : 'same' });
      continue;
    }
    const def = KINDS[step.kind];
    const obj = bundle.objects.find((o) => o.kind === step.kind && mapKey(o.kind, o.key) === step.key);
    try {
      // Placeholders of objects created earlier in this run become real ids now.
      const refs = await resolveRefs(client, [obj], mapKey, created, new Map());
      const missingRef = [...refs.values()].find((r) => r.blocker || r.placeholder);
      if (missingRef) throw new Blocked(`${step.kind} ${step.key}: ${missingRef.blocker || `${missingRef.placeholder} was not created`}`);
      const body = desiredBody(obj, refs, override[refKey(obj.kind, obj.key)], mapKey);
      const target = step.targetId ? await loadFull(client, def.path, step.targetId) : null;
      const planned = await planKind(client, obj, target, body, {
        prefs: await targetPrefs(client), columns: new Map(), production: plan.production, mapKey, override: override[refKey(obj.kind, obj.key)],
      });
      let sent;
      let saved;
      if (step.action === 'create') {
        sent = planned.body;
        saved = await call(client, 'POST', `/v2/${def.path}`, { data: sent, confirmed: true });
      } else {
        sent = diffFields(target, planned.body, def.key).patch;
        if (!Object.keys(sent).length) { results.push({ kind: step.kind, key: step.key, action: 'same' }); continue; }
        saved = await call(client, 'PATCH', `/v2/${def.path}/${step.targetId}`, { data: sent, confirmed: true });
      }
      const id = (saved && saved._id) || step.targetId;
      created.set(refKey(step.kind, obj.key), id);
      const after = await loadFull(client, def.path, id);
      const problems = Object.entries(sent)
        .filter(([f, v]) => f !== 'variables' && !contains(idsOnly(after[f]), v))
        .map(([f]) => `${f} did not save as sent`);
      if (step.kind === 'script' && step.action === 'create') {
        const keys = (after.variables || []).map((v) => v.key);
        const want = (sent.variables || []).map((v) => v.key);
        if (want.some((k) => !keys.includes(k))) problems.push('variables did not save as sent');
      }
      results.push({
        kind: step.kind, key: step.key, action: step.action, _id: id, saved: problems.length === 0, problems,
        ...(step.kind === 'endpoint' ? { url: `https://${client.domain}/v2/endpoint/${String(after.method).toLowerCase()}/${after.routeName}` } : {}),
        ...(after.active !== undefined ? { active: after.active } : {}),
      });
      if (problems.length) { failed = `${step.kind} ${step.key}: ${problems.join(', ')}`; break; }
    } catch (err) {
      if (err instanceof Forbidden) throw err;
      failed = `${step.kind} ${step.key}: ${err.message}`;
      results.push({ kind: step.kind, key: step.key, action: step.action, saved: false, error: err.message });
      break;
    }
  }
  const done = new Set(results.map((r) => refKey(r.kind, r.key)));
  return {
    saved: !failed,
    target: client.domain,
    results,
    notDone: plan.steps.filter((s) => !done.has(refKey(s.kind, s.key))).map((s) => `${s.kind} ${s.key}`),
    ...(failed ? { failed, nextStep: 'Stopped at the first failure. Fix it and run preview again: what was saved shows as "same".' } : {}),
    setByHand: plan.steps.flatMap((s) => (s.setByHand || []).map((h) => `${s.kind} ${s.key}: ${h}`)),
  };
}

async function cmdList(client, [kind, ...words]) {
  const def = checkKind(String(kind || ''));
  const qs = new URLSearchParams({ select: `_id ${def.key} ${def.name} updatedAt${['script', 'endpoint', 'webhook', 'form', 'customUi', 'stage'].includes(kind) ? ' active' : ''}${kind === 'stage' ? ' stageType' : ''}`, limit: String(KIND_CAP), sort: def.key });
  const text = words.join(' ').trim();
  if (text) qs.set('xquery', JSON.stringify({ $or: [{ [def.key]: { $regex: `(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }, { [def.name]: { $regex: `(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }] }));
  const body = await call(client, 'GET', `/v2/${def.path}?${qs}`);
  return {
    kind,
    key: def.key,
    count: body && body.pagination ? body.pagination.count : rowsOf(body).length,
    rows: rowsOf(body).map((r) => ({
      key: r[def.key], name: r[def.name], ...(r.stageType ? { stageType: r.stageType } : {}), ...(r.active !== undefined ? { active: r.active } : {}), updatedAt: r.updatedAt,
    })),
  };
}

function cmdKinds() {
  return {
    kinds: Object.entries(KINDS).map(([kind, d]) => ({
      kind, key: d.key, applies: d.apply, ...(d.why ? { exportOnly: d.why } : {}),
    })),
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

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
    else if (arg === '--to-production') flags.toProduction = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--out') flags.out = next();
    else if (arg === '--map') flags.mapArg = next();
    else if (arg === '--override') flags.overrideArg = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  list: cmdList, export: cmdExport, diff: cmdDiff, preview: cmdPreview, apply: cmdApply,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    if (command === 'kinds') {
      stdout.write(`${JSON.stringify(cmdKinds(), null, 2)}\n`);
      return 0;
    }
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError('Usage: promote.js <kinds|list|export|diff|preview|apply> <domain> …');
    flags.map = parseJsonArg(flags.mapArg, rootDir, '--map');
    flags.override = parseJsonArg(flags.overrideArg, rootDir, '--override');
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    return result.blocked ? BLOCKED : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    if (err instanceof Forbidden) {
      stderr.write(`FORBIDDEN: ${hide(err.message)}\n`);
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
  main, sanitize, walkIds, mapRefs, collectRefs, contentWarnings, contains, idsOnly, readSelection, readMap, readOverride,
  hashOf, diffFields, sameValue, KINDS, STRIP,
};
