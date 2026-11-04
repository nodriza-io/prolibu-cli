#!/usr/bin/env node
'use strict';

// Adds, changes and removes custom fields on a Prolibu object, and creates custom objects, the
// way the app does it: one Custom Field record per object, both field blocks sent whole on every
// save, one grouped write, then wait for the account's servers to restart and read the result back.
//
//   customfields.js list    <domain>
//   customfields.js show    <domain> <Object>
//   customfields.js preview <domain> '<plan json>'
//   customfields.js apply   <domain> '<plan json>' --version <version from preview> --confirmed [--timeout <seconds>]
//
// The plan is inline JSON, or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error or failed check, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const {
  createClient, assertDataFileAllowed, isLikelyProduction, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const SECTIONS = ['customFields', 'overrides'];

// Types the server accepts (string form). A list can also be written ['string'], as the app does.
const TYPES = new Set([
  'string', 'number', 'boolean', 'date', 'objectid', 'mixed', 'decimal128', 'buffer', 'map', 'array',
  '[string]', '[number]', '[date]', '[boolean]', '[objectid]', '[mixed]',
]);
const LIST_ITEM_TYPES = new Set(['string', 'number', 'boolean', 'date', 'objectid', 'mixed']);
const NO_EDITOR_TYPES = new Set(['decimal128', 'buffer', 'map', 'array']);
const NAME_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
// The server rejects these in any letter case.
const JS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);
// The app refuses these too: names that break the database schema, and system fields.
const APP_RESERVED = new Set([
  'arguments', 'await', 'enum', 'eval', 'false', 'implements', 'interface', 'null', 'package', 'private',
  'protected', 'public', 'static', 'true',
  '_id', '__v', 'id', 'type', 'schema', 'collection', 'db', 'errors', 'isNew', 'get', 'set', 'init', 'save',
  'remove', 'on', 'once', 'emit', 'listeners', 'removeListener', 'toObject', 'toJSON', 'validate', 'modelName',
  'populated', 'isModified', 'isSelected', '_pres', '_posts',
  'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'workspace', 'customFields',
]);
// Keys a plan may not set: the script and the server own them.
const OWNED_KEYS = new Set(['name', 'in', 'isCustomField', 'sparse', 'overrideBuiltIn']);
const COB_RESERVED = new Set([
  'u', 'u2', 'logger', 'skem', 'Db', 'Core', 'playground', '_', 'lodash', 'mongoose',
  'Test', 'Calc', 'Err', 'Res', 'Validator', 'Dict', 'Cache', 'Attrs', 'Msg',
]);
const UNIQUE_SCAN_CAP = 2000;
const UNIQUE_PAGE = 500;

const RESTART_NOTE = 'Saving restarts every server of the account to load the new schema. The app and the API '
  + 'stop answering for about half a minute on a dev account (it can take longer on production); requests made '
  + 'meanwhile, by anyone, can fail, and unsaved work in open forms can be lost.';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.keys(value).sort().reduce((acc, key) => { acc[key] = stable(value[key]); return acc; }, {});
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

// A node is a field when it carries isCustomField or a type; any other object is a group of fields.
function isFieldNode(node) {
  return isPlainObject(node) && ('isCustomField' in node || typeof node.type === 'string' || Array.isArray(node.type));
}

function listFields(block, prefix = '') {
  const out = new Map();
  for (const [key, node] of Object.entries(block || {})) {
    const route = prefix ? `${prefix}.${key}` : key;
    if (isFieldNode(node)) out.set(route, node);
    else if (isPlainObject(node)) for (const [r, n] of listFields(node, route)) out.set(r, n);
  }
  return out;
}

function getIn(obj, route) {
  return route.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function setIn(obj, route, value) {
  const keys = route.split('.');
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

// Deletes a field and any group it leaves empty.
function deleteIn(obj, route) {
  const keys = route.split('.');
  const parents = [];
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    parents.push([node, key]);
    node = node[key];
    if (!isPlainObject(node)) return;
  }
  delete node[keys[keys.length - 1]];
  for (let i = parents.length - 1; i >= 0; i -= 1) {
    const [parent, key] = parents[i];
    if (isPlainObject(parent[key]) && !Object.keys(parent[key]).length) delete parent[key];
  }
}

// The key the app derives from a label: accents removed, then camelCase ("Año de creación" -> "anoDeCreacion").
function keyFromLabel(label) {
  const words = String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
}

function validateRoute(route, where, { existing = false } = {}) {
  if (typeof route !== 'string' || !route) throw new UsageError(`${where}: "name" is required (or a "label" to derive it from).`);
  // An existing field keeps whatever name the server accepted; only new names follow the app's rules.
  if (existing) return;
  for (const key of route.split('.')) {
    if (!NAME_RE.test(key)) {
      throw new UsageError(`${where}: "${key}" is not a valid field name. Use letters, digits, _ or $, not starting with a digit.`);
    }
    if (JS_RESERVED.has(key.toLowerCase()) || APP_RESERVED.has(key)) {
      throw new UsageError(`${where}: "${key}" is a reserved word. Pick another name.`);
    }
  }
}

function typeName(type) {
  if (typeof type === 'string') return TYPES.has(type) ? type : null;
  if (Array.isArray(type) && type.length === 1 && LIST_ITEM_TYPES.has(type[0])) return `[${type[0]}]`;
  return null;
}

function hasEnumBase(name) {
  return ['string', 'number', '[string]', '[number]'].includes(name);
}

// Checks one field definition against the server's rules and the app's. Returns warnings; throws on errors.
function validateField(attrs, { where, needsType, knownModels, isNew = false }) {
  const warnings = [];
  if (!isPlainObject(attrs)) throw new UsageError(`${where}: the field definition must be an object.`);
  for (const key of Object.keys(attrs)) {
    if (key.startsWith('$')) throw new UsageError(`${where}: "${key}" is not allowed.`);
  }
  let name = null;
  if (attrs.type !== undefined) {
    name = typeName(attrs.type);
    if (!name) {
      throw new UsageError(`${where}: type ${JSON.stringify(attrs.type)} is not valid. Use one of ${[...TYPES].join(', ')}, `
        + 'or a one-item list such as ["string"].');
    }
    if (NO_EDITOR_TYPES.has(name)) warnings.push(`${where}: type "${name}" has no editor in the app; prefer string, number, date, boolean or objectid.`);
  } else if (needsType) {
    throw new UsageError(`${where}: "type" is required.`);
  }
  if (attrs.enum !== undefined) {
    if (!Array.isArray(attrs.enum) || !attrs.enum.length) throw new UsageError(`${where}: "enum" must be a non-empty list of options.`);
    if (attrs.enum.some((o) => (typeof o !== 'string' && typeof o !== 'number') || o === '')) {
      throw new UsageError(`${where}: every option in "enum" must be a non-empty text or a number.`);
    }
    if (new Set(attrs.enum.map(String)).size !== attrs.enum.length) throw new UsageError(`${where}: "enum" repeats an option.`);
    if (name && !hasEnumBase(name)) throw new UsageError(`${where}: "enum" only works on text or number fields.`);
  }
  if (attrs.ref !== undefined) {
    if (typeof attrs.ref !== 'string' || !attrs.ref) throw new UsageError(`${where}: "ref" must be an object name such as "User".`);
    if (name && name !== 'objectid' && name !== '[objectid]') throw new UsageError(`${where}: "ref" needs type "objectid" (or ["objectid"]).`);
    if (knownModels && knownModels.size && !knownModels.has(attrs.ref)) {
      warnings.push(`${where}: no object named "${attrs.ref}" was found on this account. Check the spelling (it is case-sensitive).`);
    }
  } else if (name === 'objectid' || name === '[objectid]') {
    warnings.push(`${where}: a link without "ref" cannot be shown or looked up. Add the object it points to.`);
  }
  if (attrs.index === true && (name !== 'string' || attrs.uiCom === 'PasswordInput')) {
    throw new UsageError(`${where}: only plain text fields can be indexed (index: true). Not lists, numbers, dates or passwords.`);
  }
  for (const key of ['required', 'unique', 'index', 'displayName', 'hidden']) {
    if (attrs[key] !== undefined && typeof attrs[key] !== 'boolean') throw new UsageError(`${where}: "${key}" must be true or false.`);
  }
  if ('objectShape' in attrs && (!isPlainObject(attrs.objectShape) || !Object.keys(attrs.objectShape).length)) {
    throw new UsageError(`${where}: "objectShape" needs at least one field; an empty one is lost on save.`);
  }
  if (isNew && attrs.label === undefined) warnings.push(`${where}: no "label"; the app will show the key as the field name.`);
  return warnings;
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
  for (const key of ['add', 'update', 'remove']) {
    if (plan[key] !== undefined && !Array.isArray(plan[key])) throw new UsageError(`"${key}" must be a list.`);
  }
  if (plan.reactivate !== undefined && typeof plan.reactivate !== 'boolean') throw new UsageError('"reactivate" must be true or false.');
  if (plan.createObject !== undefined) {
    if (plan.object !== undefined) throw new UsageError('Use "object" (existing) or "createObject" (new), not both.');
    if (typeof plan.createObject !== 'string' || !/^[A-Z][A-Za-z0-9]*$/.test(plan.createObject)) {
      throw new UsageError('"createObject" must be a PascalCase singular name with letters and digits only, such as "Vehicle".');
    }
    if ((plan.update || []).length || (plan.remove || []).length || plan.reactivate !== undefined) {
      throw new UsageError('A new object only takes "add" entries.');
    }
    return plan;
  }
  if (typeof plan.object !== 'string' || !plan.object.trim()) throw new UsageError('The plan needs "object" (for example "Deal") or "createObject".');
  if (!(plan.add || []).length && !(plan.update || []).length && !(plan.remove || []).length && plan.reactivate !== true) {
    throw new UsageError('The plan changes nothing: add "add", "update", "remove" or "reactivate": true.');
  }
  return plan;
}

function findField(current, route, preferred) {
  const sections = preferred ? [preferred] : SECTIONS;
  const hits = sections.filter((s) => isFieldNode(getIn(current[s], route)));
  if (hits.length > 1) throw new UsageError(`"${route}" exists in both customFields and overrides; add "in" to say which one.`);
  return hits[0] || null;
}

// Builds the next definition: the stored blocks untouched, plus the plan's changes.
// `liveSchema` is the object's live schema (or null), used to tell built-in fields from new ones.
function buildDefinition(record, plan, { liveSchema = null, knownModels = null, newObject = false } = {}) {
  const current = { customFields: clone(record && record.customFields) || {}, overrides: clone(record && record.overrides) || {} };
  const next = clone(current);
  const changes = [];
  const warnings = [];

  for (const [i, entry] of (plan.update || []).entries()) {
    const where = `update[${i}]`;
    if (!isPlainObject(entry)) throw new UsageError(`${where}: must be an object.`);
    validateRoute(entry.name, where, { existing: true });
    const section = findField(next, entry.name, entry.in);
    if (!section) throw new UsageError(`${where}: no field "${entry.name}". Run "show" for the current fields.`);
    const before = clone(getIn(next[section], entry.name));
    const set = entry.set === undefined ? {} : entry.set;
    if (!isPlainObject(set)) throw new UsageError(`${where}: "set" must be an object.`);
    for (const key of Object.keys(set)) {
      if (OWNED_KEYS.has(key)) throw new UsageError(`${where}: "${key}" cannot be set.`);
    }
    const unset = entry.unset === undefined ? [] : entry.unset;
    if (!Array.isArray(unset) || unset.some((k) => typeof k !== 'string')) throw new UsageError(`${where}: "unset" must be a list of property names.`);
    if (unset.includes('type') || unset.includes('isCustomField')) throw new UsageError(`${where}: "type" and "isCustomField" cannot be removed.`);
    const after = { ...before, ...clone(set) };
    for (const key of unset) delete after[key];
    after.isCustomField = true;
    warnings.push(...validateField(after, { where, needsType: section === 'customFields', knownModels }));
    if (set.type !== undefined && !sameJson(set.type, before.type)) {
      warnings.push(`${where}: changing the type of "${entry.name}" does not convert values already saved; treat it as a data change.`);
      if (section === 'overrides') warnings.push(`${where}: if "${entry.name}" is a built-in field, the server keeps its original type.`);
    }
    if (sameJson(before, after)) continue;
    setIn(next[section], entry.name, after);
    changes.push({ change: 'update', in: section, name: entry.name, before, after });
  }

  for (const [i, entry] of (plan.remove || []).entries()) {
    const where = `remove[${i}]`;
    if (!isPlainObject(entry)) throw new UsageError(`${where}: must be an object.`);
    validateRoute(entry.name, where, { existing: true });
    const section = findField(next, entry.name, entry.in);
    if (!section) throw new UsageError(`${where}: no field "${entry.name}".`);
    const before = clone(getIn(next[section], entry.name));
    deleteIn(next[section], entry.name);
    changes.push({ change: 'remove', in: section, name: entry.name, before });
    warnings.push(`${where}: values already saved in "${entry.name}" stay in the database, but the app stops showing them.`);
    if (section === 'overrides') {
      warnings.push(`${where}: if "${entry.name}" overrides a built-in field, the built-in field stays, with its original rules.`);
    }
  }

  for (const [i, entry] of (plan.add || []).entries()) {
    const where = `add[${i}]`;
    if (!isPlainObject(entry)) throw new UsageError(`${where}: must be an object.`);
    const name = entry.name === undefined ? keyFromLabel(entry.label) : entry.name;
    validateRoute(name, where);
    const section = newObject ? 'overrides' : (entry.in || 'customFields');
    if (!SECTIONS.includes(section)) throw new UsageError(`${where}: "in" must be "customFields" or "overrides".`);
    if (findField(next, name, section) || findField(current, name, section)) {
      throw new UsageError(`${where}: "${name}" already exists in ${section}. Use "update" to change it.`);
    }
    const parentRoute = name.split('.').slice(0, -1);
    for (let k = 1; k <= parentRoute.length; k += 1) {
      if (isFieldNode(getIn(next[section], parentRoute.slice(0, k).join('.')))) {
        throw new UsageError(`${where}: "${parentRoute.slice(0, k).join('.')}" is a field, not a group; "${name}" cannot go inside it.`);
      }
    }
    if (isPlainObject(getIn(next[section], name))) throw new UsageError(`${where}: "${name}" is a group of fields.`);
    const attrs = { isCustomField: true };
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'name' || key === 'in' || key === 'overrideBuiltIn') continue;
      if (OWNED_KEYS.has(key)) throw new UsageError(`${where}: "${key}" cannot be set; the script and the server set it.`);
      attrs[key] = clone(value);
    }
    let builtIn = false;
    if (section === 'overrides' && !newObject) {
      if (liveSchema) {
        const live = getIn(liveSchema, name);
        if (isPlainObject(live) && !isFieldNode(live)) {
          throw new UsageError(`${where}: "${name}" is a group of built-in fields. Name one field inside it, such as "${name}.<field>".`);
        }
        builtIn = isFieldNode(live);
      } else if (attrs.type === undefined) {
        throw new UsageError(`${where}: "type" is required (the live schema could not be read to tell whether "${name}" is a built-in field).`);
      }
      if (builtIn && entry.overrideBuiltIn !== true) {
        throw new UsageError(`${where}: "${name}" is already a built-in field of this object. To change its rules (for example make it `
          + 'required) add "overrideBuiltIn": true; to add a new field, pick another name.');
      }
      if (builtIn && attrs.type !== undefined) {
        warnings.push(`${where}: "${name}" is built in; the server keeps its original type and ignores "type".`);
        delete attrs.type;
      }
    }
    if (section === 'overrides' && name.split('.')[0] === 'customFields') throw new UsageError(`${where}: put nested fields in "customFields", not in overrides.`);
    warnings.push(...validateField(attrs, { where, needsType: !builtIn, knownModels, isNew: !builtIn }));
    setIn(next[section], name, attrs);
    changes.push({ change: 'add', in: section, name, ...(builtIn ? { overridesBuiltIn: true } : {}), after: attrs });
  }

  return { current, next, changes, warnings };
}

// The request the app would send to make the stored record equal to `next`.
function buildRequest(record, next, { objectName, reactivate } = {}) {
  const has = (s) => Object.keys(next[s] || {}).length > 0;
  if (!record) {
    const body = { objectAssigned: objectName, active: true };
    if (has('customFields')) body.customFields = clone(next.customFields);
    if (has('overrides')) body.overrides = clone(next.overrides);
    return { method: 'POST', path: '/v2/customfield', body };
  }
  if (!has('customFields') && !has('overrides')) return { method: 'DELETE', path: `/v2/customfield/${record._id}` };
  // Both blocks go whole: the server replaces each block with what it receives, and {} clears one.
  const body = { customFields: clone(next.customFields || {}), overrides: clone(next.overrides || {}) };
  if (reactivate === true) body.active = true;
  return { method: 'PATCH', path: `/v2/customfield/${record._id}`, body };
}

const LOAD_WRITE_WINDOW_MS = 120000;

function statusKind(record) {
  if (!record) return 'none';
  const status = String(record.status || '');
  if (status.startsWith('Success')) return 'loaded';
  if (status.startsWith('Index sync error')) return 'indexError';
  if (status.startsWith('Error')) return 'loadError';
  return record.active === false ? 'off' : 'notLoadedYet';
}

const STATUS_TEXT = {
  loaded: 'Loaded: the fields are live.',
  loadError: 'Switched off by the server: the fields could not be built when the servers started, so none of them apply. '
    + 'Transient database errors cause this too; the status says which.',
  indexError: 'Switched off by the server: a database index could not be built (usually a unique field whose saved records '
    + 'repeat a value), so none of this object\'s custom fields apply.',
  off: 'Switched off by a person.',
  notLoadedYet: 'Saved, but the servers have not loaded it yet.',
  none: 'This object has no custom fields.',
};

function parseUptime(uptime) {
  const match = /^(\d+)d (\d+)h (\d+)m (\d+)s$/.exec(String(uptime || '').trim());
  if (!match) return null;
  const [d, h, m, s] = match.slice(1).map(Number);
  return ((d * 24 + h) * 60 + m) * 60 + s;
}

// A server answers from a new process when its uptime is shorter than the time since the write.
// Two durations, so the two clocks never need to agree.
function restartedSince(info, appliedAt, now) {
  const seconds = parseUptime(info && info.uptime);
  if (seconds === null) return false;
  const birth = Date.parse(info.podBirth);
  if (Number.isFinite(birth) && Math.abs(now - birth) > 24 * 3600 * 1000) return false;
  return seconds * 1000 < now - appliedAt + 2000;
}

function summarizeFields(definition) {
  const rows = [];
  for (const section of SECTIONS) {
    for (const [route, attrs] of listFields(definition && definition[section])) {
      const row = { name: route, in: section, recordPath: section === 'customFields' ? `customFields.${route}` : route, type: attrs.type };
      for (const key of ['label', 'required', 'unique', 'index', 'enum', 'ref', 'uiCom']) if (attrs[key] !== undefined) row[key] = attrs[key];
      rows.push(row);
    }
  }
  return rows;
}

// Which defined fields are (or are not) in the live schema the servers are running.
function liveCheck(definition, liveSchema) {
  if (!liveSchema) return { checked: false, note: 'The live schema of this object could not be read with this profile.' };
  const missing = [];
  for (const row of summarizeFields(definition)) {
    const live = getIn(liveSchema, row.recordPath);
    if (!isPlainObject(live) || !live.isCustomField) missing.push(row.recordPath);
  }
  return { checked: true, missing };
}

// ─── API steps ─────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = isPlainObject(res.body) ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function rows(body) {
  return Array.isArray(body) ? body : (body && body.data) || [];
}

async function loadRecords(client) {
  return rows(await call(client, 'GET', `/v2/customfield?${new URLSearchParams({ limit: '200', sort: 'objectAssigned' })}`));
}

async function loadCobs(client) {
  return rows(await call(client, 'GET', `/v2/cob?${new URLSearchParams({ limit: '200', sort: 'modelName' })}`));
}

// The app reads every object's live schema from /v2/user/me (modelSchemas). Admins see all objects.
async function loadLiveSchemas(client) {
  const res = await client.request('GET', '/v2/user/me');
  if (!res.ok || !isPlainObject(res.body) || !isPlainObject(res.body.modelSchemas)) return null;
  return res.body.modelSchemas;
}

// Public health endpoint (no key): which server process answers and how long it has been up.
async function serverInfo(ctx) {
  try {
    const res = await ctx.fetchImpl(`https://${ctx.domain}/prlversion`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 200) return null;
    const body = JSON.parse(await res.text());
    return { uptime: body.uptime, podBirth: body.podBirth };
  } catch {
    return null;
  }
}

function resolveObject(name, { liveSchemas, records, cobs }) {
  const wanted = String(name).trim().toLowerCase();
  const names = new Set([
    ...Object.keys(liveSchemas || {}),
    ...records.map((r) => r.objectAssigned),
    ...cobs.map((c) => c.modelName),
  ]);
  return [...names].find((n) => n.toLowerCase() === wanted) || null;
}

async function countMissing(client, objectName, dataPath) {
  const query = new URLSearchParams({ xquery: JSON.stringify({ [dataPath]: { $in: [null, ''] } }), select: '_id', limit: '1' });
  const body = await call(client, 'GET', `/v2/${objectName.toLowerCase()}?${query}`);
  return (body.pagination && body.pagination.count) || 0;
}

async function findDuplicates(client, objectName, dataPath) {
  const seen = new Set();
  const dup = new Set();
  let read = 0;
  let total = Infinity;
  for (let page = 1; read < Math.min(total, UNIQUE_SCAN_CAP); page += 1) {
    const query = new URLSearchParams({ select: dataPath, sort: '_id', limit: String(UNIQUE_PAGE), page: String(page) });
    const body = await call(client, 'GET', `/v2/${objectName.toLowerCase()}?${query}`);
    const list = rows(body);
    total = (body.pagination && body.pagination.count) || read + list.length;
    for (const row of list) {
      const value = getIn(row, dataPath);
      if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
      const key = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (seen.has(key)) dup.add(key);
      else seen.add(key);
    }
    read += list.length;
    if (list.length < UNIQUE_PAGE) break;
  }
  return { duplicates: [...dup].slice(0, 20), truncated: total > UNIQUE_SCAN_CAP };
}

// Read-only checks the app runs before applying: records left without a value by a new
// "required", and repeated values that would break a new "unique" index.
async function ruleChecks(client, objectName, current, next) {
  const checks = [];
  const blockers = [];
  const warnings = [];
  for (const section of SECTIONS) {
    const before = listFields(current[section]);
    for (const [route, attrs] of listFields(next[section])) {
      const old = before.get(route);
      const dataPath = section === 'customFields' ? `customFields.${route}` : route;
      for (const rule of ['required', 'unique']) {
        if (attrs[rule] !== true || (old && old[rule] === true)) continue;
        try {
          if (rule === 'required') {
            const count = await countMissing(client, objectName, dataPath);
            checks.push({ field: dataPath, rule, recordsWithoutValue: count });
            if (count) {
              warnings.push(`${count} saved ${objectName} record(s) have no value in ${dataPath}. They keep loading, but each one fails `
                + 'validation the next time someone saves it, until it gets a value.');
            }
          } else if (!old) {
            checks.push({ field: dataPath, rule, duplicates: [], note: 'New field: no saved values yet.' });
          } else {
            const result = await findDuplicates(client, objectName, dataPath);
            checks.push({ field: dataPath, rule, ...result });
            if (result.duplicates.length) {
              blockers.push(`Saved ${objectName} records repeat values in ${dataPath} (${result.duplicates.slice(0, 5).join(', ')}). `
                + 'A unique index would fail and switch off every custom field of the object. Fix the data first.');
            }
            if (result.truncated) warnings.push(`Only the first ${UNIQUE_SCAN_CAP} records were checked for repeated values in ${dataPath}.`);
          }
        } catch (err) {
          checks.push({ field: dataPath, rule, failed: true });
          warnings.push(`Could not check ${rule} on ${dataPath}: ${err.message}`);
        }
      }
    }
  }
  return { checks, blockers, warnings };
}

async function prepare(client, ctx, plan) {
  const [records, cobs, liveSchemas, info] = await Promise.all([
    loadRecords(client), loadCobs(client), loadLiveSchemas(client), serverInfo(ctx),
  ]);
  const knownModels = new Set([...Object.keys(liveSchemas || {}), ...cobs.map((c) => c.modelName)]);
  const blockers = [];
  const warnings = [];

  if (plan.createObject) {
    const name = plan.createObject;
    const clash = resolveObject(name, { liveSchemas, records, cobs });
    if (COB_RESERVED.has(name)) blockers.push(`"${name}" is reserved by the platform. Pick another name.`);
    if (clash) blockers.push(`An object named "${clash}" already exists. Use it, or pick another name.`);
    if (/s$/i.test(name)) warnings.push(`The server makes the name singular in English ("${name}" may be stored as "${name.replace(/s$/i, '')}"). Prefer a singular name.`);
    const built = buildDefinition(null, plan, { knownModels, newObject: true });
    warnings.push(...built.warnings);
    return {
      kind: 'createObject', objectName: name, record: null, version: 'new-object', info, liveSchemas, built, blockers, warnings,
      requests: [
        { method: 'POST', path: '/v2/cob', body: { modelName: name, active: true } },
        ...(built.changes.length ? [buildRequest(null, built.next, { objectName: '<stored name>' })] : []),
      ],
    };
  }

  const objectName = resolveObject(plan.object, { liveSchemas, records, cobs });
  if (!objectName) {
    throw new UsageError(`No object named "${plan.object}" on this account. Check the name, or use "createObject" for a new one.`);
  }
  const record = records.find((r) => r.objectAssigned === objectName) || null;
  const cob = cobs.find((c) => c.modelName === objectName);
  if (cob && cob.active === false) blockers.push(`The custom object ${objectName} is switched off; its fields cannot load.`);
  if (liveSchemas && !liveSchemas[objectName]) {
    warnings.push(`${objectName} is not in this profile's live schema list: the check against built-in fields and the live check after saving are skipped.`);
  }
  const liveSchema = (liveSchemas && liveSchemas[objectName]) || null;
  const built = buildDefinition(record, plan, { liveSchema, knownModels });
  warnings.push(...built.warnings);

  const kind = statusKind(record);
  if (record && record.active === false && plan.reactivate === undefined) {
    blockers.push(`The record is switched off (${record.status || 'no status'}). Decide with the user: add "reactivate": true `
      + 'to load the fields again once the cause is fixed, or "reactivate": false to keep it off.');
  }
  if (record && record.active === false && plan.reactivate === false) {
    warnings.push('The record stays switched off: the change is saved but none of its fields load.');
  }
  if (kind === 'indexError' && plan.reactivate === true) {
    warnings.push('The last start failed on an index. Reactivating without fixing the repeated values switches it off again.');
  }
  // When the servers start they write the load result (status) on the record, so an update
  // right after the start is that write, not a pending change.
  if (record && info && info.podBirth && record.updatedAt
    && Date.parse(record.updatedAt) > Date.parse(info.podBirth) + LOAD_WRITE_WINDOW_MS) {
    blockers.push('The last change to this record has not been loaded yet (the servers have not restarted since). Wait and run preview again.');
  }
  const request = buildRequest(record, built.next, { objectName, reactivate: plan.reactivate });
  if (request.method === 'DELETE') {
    warnings.push(`Every custom field of ${objectName} is removed, so the whole Custom Field record is deleted, as the app does.`);
  }
  const rules = await ruleChecks(client, objectName, built.current, built.next);
  blockers.push(...rules.blockers);
  warnings.push(...rules.warnings);
  return {
    kind: record ? (request.method === 'DELETE' ? 'delete' : 'update') : 'create',
    objectName, record, cob, version: record ? record.updatedAt : 'new', info, liveSchemas, liveSchema,
    built, blockers, warnings, checks: rules.checks, requests: [request],
  };
}

// Polls until the account answers from new server processes (two in a row), then until the API answers.
async function waitForRestart(client, ctx, appliedAt) {
  let streak = 0;
  let sawNew = false;
  while (ctx.now() - appliedAt < ctx.timeoutMs) {
    await ctx.sleep(ctx.pollMs);
    const info = await serverInfo(ctx);
    if (info && restartedSince(info, appliedAt, ctx.now())) {
      sawNew = true;
      streak += 1;
      if (streak >= 2) {
        let res = null;
        try {
          res = await client.request('GET', '/v2/customfield?limit=1&select=_id');
        } catch {
          res = null;
        }
        if (res && res.ok) return { restarted: true, seconds: Math.round((ctx.now() - appliedAt) / 1000) };
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return { restarted: false, sawNewServer: sawNew, seconds: Math.round((ctx.now() - appliedAt) / 1000) };
}

// Sends one write. A dropped connection is not a failure: the restart can cut the answer off.
async function send(client, request) {
  try {
    const res = await client.request(request.method, request.path, { data: request.body, confirmed: true });
    if (!res.ok) {
      const body = isPlainObject(res.body) ? res.body : { error: res.body };
      const err = new Error(`${request.method} ${request.path} answered ${res.status}: ${body.error || body.message || 'no message'}`);
      err.status = res.status;
      throw err;
    }
    return { outcome: 'saved', body: res.body };
  } catch (err) {
    if (err instanceof UsageError || err.status) throw err;
    return { outcome: 'unknown', note: `The connection dropped (${err.message}); the write may have been saved. Reading back after the restart.` };
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(client) {
  const [records, cobs] = await Promise.all([loadRecords(client), loadCobs(client)]);
  return {
    customFieldRecords: records.map((r) => ({
      _id: r._id,
      object: r.objectAssigned,
      active: r.active !== false,
      state: statusKind(r),
      status: r.status || null,
      fields: listFields(r.customFields).size + listFields(r.overrides).size,
    })),
    customObjects: cobs.map((c) => ({
      _id: c._id,
      modelName: c.modelName,
      active: c.active !== false,
      restPath: `/v2/${String(c.modelName).toLowerCase()}`,
      hasCustomFieldRecord: records.some((r) => r.objectAssigned === c.modelName),
    })),
  };
}

async function cmdShow(client, [name], flags, ctx) {
  if (!name) throw new UsageError('Usage: customfields.js show <domain> <Object>');
  const [records, cobs, liveSchemas, info] = await Promise.all([loadRecords(client), loadCobs(client), loadLiveSchemas(client), serverInfo(ctx)]);
  const objectName = resolveObject(name, { liveSchemas, records, cobs });
  if (!objectName) throw new UsageError(`No object named "${name}" on this account.`);
  const record = records.find((r) => r.objectAssigned === objectName) || null;
  const cob = cobs.find((c) => c.modelName === objectName) || null;
  const kind = statusKind(record);
  const pending = Boolean(record && info && info.podBirth && record.updatedAt && Date.parse(record.updatedAt) > Date.parse(info.podBirth));
  return {
    object: objectName,
    customObject: cob ? { _id: cob._id, active: cob.active !== false, restPath: `/v2/${objectName.toLowerCase()}` } : null,
    record: record ? { _id: record._id, active: record.active !== false, state: kind, status: record.status || null, version: record.updatedAt } : null,
    meaning: STATUS_TEXT[kind],
    waitingForRestart: pending,
    fields: summarizeFields(record),
    definition: record ? { customFields: record.customFields || {}, overrides: record.overrides || {} } : null,
    live: record ? liveCheck(record, liveSchemas && liveSchemas[objectName]) : null,
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  if (!planArg) throw new UsageError("Usage: customfields.js preview <domain> '<plan json>'");
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await prepare(client, ctx, plan);
  const warnings = [...p.warnings];
  if (isLikelyProduction(ctx.domain)) warnings.unshift(`${ctx.domain} looks like a production account: agree on a quiet time with the user.`);
  const restarts = p.kind === 'createObject' && p.requests.length > 1 ? 2 : 1;
  return {
    object: p.objectName,
    action: p.kind,
    version: p.version,
    record: p.record ? { _id: p.record._id, active: p.record.active !== false, state: statusKind(p.record), status: p.record.status || null } : null,
    changes: p.built.changes,
    fieldsKept: summarizeFields(p.built.next).length - p.built.changes.filter((c) => c.change !== 'remove').length,
    fieldsAfter: summarizeFields(p.built.next),
    checks: p.checks || [],
    requests: p.requests,
    restart: `${RESTART_NOTE}${restarts > 1 ? ' A new object restarts twice: once for the object, once for its fields.' : ''}`,
    warnings,
    blockers: p.blockers,
    nextStep: p.blockers.length
      ? 'Blocked: explain why to the user; do not apply.'
      : 'Show the changes, the warnings and the restart to the user. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version set to version.',
  };
}

async function settle(client, ctx, recordId) {
  await ctx.sleep(ctx.settleMs);
  return call(client, 'GET', `/v2/customfield/${recordId}`);
}

function compareSaved(saved, next) {
  const problems = [];
  for (const section of SECTIONS) {
    const want = listFields(next[section]);
    const got = listFields(saved && saved[section]);
    for (const [route, attrs] of want) {
      const have = got.get(route);
      if (!have) {
        problems.push(`${section}.${route} is missing from the saved record.`);
        continue;
      }
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'type' && section === 'overrides') continue;
        if (!sameJson(have[key], value)) problems.push(`${section}.${route}.${key} was saved as ${JSON.stringify(have[key])}.`);
      }
    }
    for (const route of got.keys()) if (!want.has(route)) problems.push(`${section}.${route} is still in the saved record.`);
  }
  return problems;
}

async function applyCreateObject(client, ctx, p) {
  const appliedAt = ctx.now();
  const write = await send(client, p.requests[0]);
  const restart = await waitForRestart(client, ctx, appliedAt);
  const cobs = await loadCobs(client);
  const cob = (write.body && write.body._id && cobs.find((c) => c._id === write.body._id))
    || cobs.find((c) => c.modelName.toLowerCase() === p.objectName.toLowerCase() || c.modelName.toLowerCase() === p.objectName.toLowerCase().replace(/s$/, ''));
  const problems = [];
  if (!cob) {
    return { saved: false, object: p.objectName, restart, problems: ['The custom object was not found after the write. Nothing else was sent.'] };
  }
  if (!restart.restarted) problems.push('The restart could not be confirmed in time. Run "show" in a minute before anything else.');
  const restPath = `/v2/${cob.modelName.toLowerCase()}`;
  const probe = await client.request('GET', `${restPath}?limit=1`).catch(() => ({ ok: false }));
  if (!probe.ok) problems.push(`${restPath} does not answer yet.`);
  const result = { saved: false, object: cob.modelName, customObject: { _id: cob._id, restPath }, restarts: [restart] };
  if (problems.length || !p.built.changes.length) return { ...result, saved: !problems.length, problems };

  const cfRequest = buildRequest(null, p.built.next, { objectName: cob.modelName });
  const cfAppliedAt = ctx.now();
  await send(client, cfRequest);
  const cfRestart = await waitForRestart(client, ctx, cfAppliedAt);
  result.restarts.push(cfRestart);
  const records = await loadRecords(client);
  const record = records.find((r) => r.objectAssigned === cob.modelName);
  if (!record) return { ...result, problems: ['The custom object exists, but its Custom Field record was not saved.'] };
  return finish(client, ctx, { ...result, objectName: cob.modelName, recordId: record._id, next: p.built.next, restart: cfRestart, expectActive: true });
}

async function finish(client, ctx, { objectName, recordId, next, restart, expectActive, ...rest }) {
  const problems = [];
  if (!restart.restarted) problems.push('The restart could not be confirmed in time; what follows may be the state before it.');
  const saved = await settle(client, ctx, recordId);
  problems.push(...compareSaved(saved, next));
  const kind = statusKind(saved);
  if (expectActive && saved.active === false) problems.push(`The server switched the record off: ${saved.status}`);
  if (expectActive && kind !== 'loaded') problems.push(`The fields did not load: ${saved.status || 'no status yet'}.`);
  const liveSchemas = await loadLiveSchemas(client);
  const live = expectActive ? liveCheck(saved, liveSchemas && liveSchemas[objectName]) : { checked: false };
  if (live.checked && live.missing.length) problems.push(`Not live yet: ${live.missing.join(', ')}.`);
  return {
    ...rest,
    saved: problems.length === 0,
    object: objectName,
    record: { _id: saved._id, active: saved.active !== false, state: kind, status: saved.status || null, version: saved.updatedAt },
    meaning: STATUS_TEXT[kind],
    restart,
    live,
    fields: summarizeFields(saved),
    problems,
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!planArg) throw new UsageError("Usage: customfields.js apply <domain> '<plan json>' --version <v> --confirmed");
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version: apply only saves what the user saw.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await prepare(client, ctx, plan);
  if (p.version !== flags.version) throw new Blocked('The Custom Field record changed since the preview. Run preview again and show the user.');
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.kind === 'createObject') return applyCreateObject(client, ctx, p);

  const request = p.requests[0];
  const appliedAt = ctx.now();
  const write = await send(client, request);
  const restart = await waitForRestart(client, ctx, appliedAt);
  if (p.kind === 'delete') {
    const records = await loadRecords(client);
    const still = records.find((r) => r.objectAssigned === p.objectName);
    const problems = still ? ['The Custom Field record is still there.'] : [];
    if (!restart.restarted) problems.push('The restart could not be confirmed in time.');
    return { saved: problems.length === 0, object: p.objectName, deleted: !still, restart, problems };
  }
  let recordId = p.record && p.record._id;
  if (!recordId) {
    recordId = write.body && write.body._id;
    if (!recordId) {
      const created = (await loadRecords(client)).find((r) => r.objectAssigned === p.objectName);
      if (!created) return { saved: false, object: p.objectName, restart, problems: ['The Custom Field record was not created.'] };
      recordId = created._id;
    }
  }
  const expectActive = p.record ? (p.record.active !== false || plan.reactivate === true) : true;
  return finish(client, ctx, {
    objectName: p.objectName, recordId, next: p.built.next, restart, expectActive, write: write.outcome,
  });
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
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--timeout') {
      const seconds = Number(next());
      if (!Number.isFinite(seconds) || seconds < 30 || seconds > 900) throw new UsageError('--timeout is in seconds, between 30 and 900.');
      flags.timeout = seconds;
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = { list: cmdList, show: cmdShow, preview: cmdPreview, apply: cmdApply };

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError('Usage: customfields.js <list|show|preview|apply> <domain> … (see the header of this file)');
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl, stderr });
    const ctx = {
      rootDir,
      domain,
      fetchImpl,
      now: opts.now || Date.now,
      sleep: opts.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
      pollMs: opts.pollMs || 3000,
      settleMs: opts.settleMs === undefined ? 20000 : opts.settleMs,
      timeoutMs: (flags.timeout || 240) * 1000,
    };
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
  main, buildDefinition, buildRequest, validateField, keyFromLabel, listFields, statusKind, restartedSince, parseUptime, compareSaved,
};
