#!/usr/bin/env node
'use strict';

// Customize the app's lists and menu the way the V2 app does: saved filters (CustomFilter)
// and CustomUi records (default table columns, sidebar links, row actions, cell and field
// widgets). Every write is preview → apply; code that runs in every user's browser needs
// its own flag.
//
//   ui.js ui      <domain> [--type columns|sidebar|rowAction|cellWidget|fieldWidget] [--model M] [--all]
//   ui.js ui-show <domain> <id|code>
//   ui.js filters <domain> [--model M] [--search text]
//   ui.js filter  <domain> <id|code>            check one saved filter (fields, ids, matches for this profile)
//   ui.js fields  <domain> <Model> [--search text]
//   ui.js preview <domain> '<plan>'  →  apply <domain> '<plan>' --version <v> --confirmed [--runs-code]
//
// Exit codes: 0 ok, 1 request failed, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const MODEL_RE = /^[A-Z][A-Za-z0-9]{0,60}$/;
const PATH_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const BLOCKED = 3;
const MARKER = '// CustomUi v2';
const MARKER_RE = /customui v2/i;
const MAX_CODE = 20000;
const COLUMN_WIDTH = 180;

const TYPES = {
  columns: { type: 'Default Table Columns', key: 'defaultColumns' },
  sidebar: { type: 'Sidebar', key: 'sideBar' },
  rowAction: { type: 'Table Row Action', key: 'rowAction' },
  cellWidget: { type: 'Table Cell Widget', key: 'cellWidget' },
  fieldWidget: { type: 'Field Widget', key: 'fieldWidget' },
};
const KIND_OF_TYPE = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v.type, k]));
const SLOTS = ['rowActionsPrefix', 'rowActionsMiddle', 'rowActionsSuffix'];
const TARGETS = ['_blank', '_self', '_parent', '_top'];
// Operators the V2 filter editor writes (filterOperators.js) plus the logic keys.
const FIELD_OPS = new Set(['$eq', '$ne', '$regex', '$in', '$nin', '$exists', '$gt', '$gte', '$lt', '$lte']);
const LOGIC_OPS = new Set(['$and', '$or']);
const DATE_PRESETS = ['today', 'yesterday', 'last7Days', 'last30Days', 'last90Days', 'thisWeek', 'thisMonth', 'lastMonth', 'thisYear'];

const STOP = 'Show this to the user in plain words (what changes, who gets it, warnings). STOP HERE and end your turn; '
  + 'never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, '
  + 'run apply with the same plan and this --version';

class Blocked extends Error {}

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (v) => (isObj(v) ? String(v._id) : v === null || v === undefined ? null : String(v));
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = isObj(res.body) ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function optional(client, path, warnings, what) {
  const res = await client.request('GET', path);
  if (res.ok) return res.body;
  warnings.push(`Could not check ${what} (${res.status}).`);
  return null;
}

// ─── Account context ───────────────────────────────────────────────────────────

async function loadMe(client, cache) {
  if (!cache.me) {
    const body = await call(client, 'GET', '/v2/user/me');
    const p = (body && body.profile) || {};
    cache.me = {
      id: String(p._id || ''),
      isAdmin: !!p.isAdmin,
      email: p.email || null,
      schemas: (body && body.modelSchemas) || {},
      menu: (body && body.uiSchemas && body.uiSchemas.sideBar) || {},
      permissions: Array.isArray(body && body.permissions) ? body.permissions : [],
    };
  }
  return cache.me;
}

function can(me, model, action) {
  return me.isAdmin || me.permissions.some((p) => p === `Resource@${model}.${action}` || p === `Resource@${model}.*` || p === 'Resource@*.*');
}

function restOf(model) {
  return model.toLowerCase();
}

// Walks a dotted path through the account's schema (GET /v2/user/me → modelSchemas).
function walkSchema(schemas, model, path) {
  let node = schemas[model];
  let current = model;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i += 1) {
    const attr = node ? node[segs[i]] : undefined;
    const last = i === segs.length - 1;
    if (!attr || typeof attr !== 'object') return { ok: false, reason: `${current} has no field "${segs.slice(0, i + 1).join('.')}"` };
    const isArray = Array.isArray(attr.type);
    const type = isArray ? attr.type[0] : attr.type;
    if (attr.ref) {
      if (last) return { ok: true, ref: attr.ref, type: type || 'objectid', array: isArray };
      if (!schemas[attr.ref]) return { ok: true, unchecked: true };
      current = attr.ref;
      node = schemas[attr.ref];
      continue;
    }
    if (type === 'mixed') return { ok: true, type: 'mixed', array: isArray };
    if (typeof type === 'string') {
      if (last) return { ok: true, type, array: isArray, enum: attr.enum || null };
      return { ok: false, reason: `${current} field "${segs.slice(0, i + 1).join('.')}" has no sub-fields` };
    }
    if (last) return { ok: true, type: 'object' };
    node = attr;
  }
  return { ok: true };
}

function modelSchema(me, model) {
  if (!MODEL_RE.test(String(model || ''))) throw new UsageError('Give the object as its model name, e.g. Deal, Contact.');
  if (!me.schemas[model]) {
    throw new Blocked(`The object "${model}" does not exist on this account or this profile cannot read it. Use the singular model name (Deal, not deals).`);
  }
  return me.schemas[model];
}

async function findUsers(client, emails) {
  const list = emails.map((e) => String(e).trim().toLowerCase());
  const body = await call(client, 'GET', `/v2/user?${qs({
    xquery: JSON.stringify({ email: { $in: list } }), select: 'email firstName lastName', limit: String(list.length + 5),
  })}`);
  const found = new Map((body.data || []).map((u) => [String(u.email).toLowerCase(), u]));
  const missing = list.filter((e) => !found.has(e));
  if (missing.length) throw new Blocked(`No user with e-mail ${missing.join(', ')}.`);
  return list.map((e) => found.get(e));
}

async function countUsers(client, warnings) {
  const body = await optional(client, `/v2/user?${qs({ select: '_id', limit: '1' })}`, warnings, 'how many users the account has');
  return body && body.pagination ? body.pagination.count : null;
}

// ─── CustomUi helpers ─────────────────────────────────────────────────────────

const UI_SELECT = 'customUiCode customUiName customUiType active allowEveryone assignee collaborators createdBy updatedAt workspace sideBar rowAction cellWidget fieldWidget defaultColumns code';

async function loadUiList(client) {
  const body = await call(client, 'GET', `/v2/customui?${qs({ select: UI_SELECT, sort: '-updatedAt', limit: '500' })}`);
  return { records: body.data || [], total: body.pagination ? body.pagination.count : (body.data || []).length };
}

async function loadUi(client, ref) {
  if (!ID_RE.test(String(ref)) && !CODE_RE.test(String(ref))) throw new UsageError('Give the CustomUi id or code.');
  return call(client, 'GET', `/v2/customui/${encodeURIComponent(ref)}?${qs({ select: UI_SELECT })}`);
}

function uiModel(r) {
  const kind = KIND_OF_TYPE[r.customUiType];
  if (!kind || kind === 'sidebar') return null;
  return (r[TYPES[kind].key] || {}).modelName || null;
}

function urlsIn(text) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s'"`<>)]+/gi) || [])];
}

function audienceOf(r) {
  const everyone = !r.allowEveryone || r.allowEveryone.view !== false;
  return {
    everyone,
    users: everyone ? [] : [r.assignee, ...(r.collaborators || [])].filter(Boolean).map(idOf),
    note: everyone ? 'every user of the account (the app shows it to everyone unless view is off)' : 'admins plus the listed users',
  };
}

function summarizeUi(r) {
  const kind = KIND_OF_TYPE[r.customUiType] || r.customUiType;
  const sub = r[(TYPES[kind] || {}).key] || {};
  const code = String(r.code || '');
  const out = {
    _id: r._id, code: r.customUiCode, name: r.customUiName, kind, active: r.active !== false, model: uiModel(r), updatedAt: r.updatedAt,
    audience: audienceOf(r),
  };
  if (kind === 'columns') out.columns = (sub.columns || []).map((c) => (isObj(c) ? c.path || c.name : c));
  if (kind === 'sidebar') Object.assign(out, { label: sub.label, url: sub.url, target: sub.target || '_blank', insertBefore: sub.insertBefore || null });
  if (kind === 'rowAction') Object.assign(out, { label: sub.label, slot: sub.slot, order: sub.order });
  if (kind === 'cellWidget' || kind === 'fieldWidget') out.field = sub.fieldName || null;
  if (['rowAction', 'cellWidget', 'fieldWidget'].includes(kind)) {
    out.codeLines = code ? code.split('\n').length : 0;
    out.runsInV2 = MARKER_RE.test(code.split('\n').find((l) => l.trim()) || '');
    out.urlsInCode = urlsIn(code);
  }
  return out;
}

// Which record the app uses when several target the same place (newest updatedAt wins).
function conflicts(records) {
  const groups = new Map();
  for (const r of records.filter((x) => x.active !== false)) {
    const kind = KIND_OF_TYPE[r.customUiType];
    let key = null;
    if (kind === 'columns') key = `columns:${uiModel(r)}`;
    if (kind === 'cellWidget' || kind === 'fieldWidget') key = `${kind}:${uiModel(r)}:${(r[TYPES[kind].key] || {}).fieldName}`;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => {
    const sorted = [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { place: key, wins: sorted[0]._id, ignored: sorted.slice(1).map((x) => x._id) };
  });
}

// ─── Plan validation per kind ──────────────────────────────────────────────────

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
  if (!isObj(plan)) throw new UsageError('The plan must be a JSON object.');
  const kinds = ['filter', ...Object.keys(TYPES), 'deactivate', 'activate', 'audience'];
  if (!kinds.includes(plan.kind)) throw new UsageError(`"kind" must be one of ${kinds.join(', ')}.`);
  if (isObj(plan.set) && plan.set.id !== undefined) throw new UsageError('"id" goes at the top of the plan, next to "kind", not inside "set".');
  if (plan.id !== undefined && !ID_RE.test(String(plan.id)) && !CODE_RE.test(String(plan.id))) throw new UsageError('"id" must be an id or a code.');
  return plan;
}

function checkName(name, fallback) {
  const value = name === undefined ? fallback : name;
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new UsageError('"name" must be a text of 1–120 characters.');
  return value.trim();
}

// Accepts https URLs and app paths (/deals). Anything that can run script is refused.
function checkUrl(raw, { allowPath = true } = {}) {
  const url = String(raw || '').trim();
  if (!url) throw new Blocked('The URL is empty.');
  if (/[\s<>"'`]/.test(url)) throw new Blocked('The URL has spaces or quotes.');
  if (/^(javascript|data|vbscript|file|blob):/i.test(url)) throw new Blocked('The URL runs code or reads local files; it is refused.');
  if (url.startsWith('//') || url.startsWith('\\')) throw new Blocked('Write the link as https://host/… or as an app path such as /deals.');
  if (url.startsWith('/')) {
    if (!allowPath) throw new Blocked('Use a full https:// URL here.');
    return { url, external: false, host: null };
  }
  const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  let parsed;
  try {
    parsed = new URL(full);
  } catch {
    throw new Blocked(`"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Blocked('Only https:// URLs are allowed (or an app path such as /deals).');
  if (parsed.username || parsed.password) throw new Blocked('The URL carries a user or password; put no credentials in a link.');
  return { url: full, external: true, host: parsed.host };
}

function menuKeys(menu) {
  const keys = new Set();
  const walk = (node) => {
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      keys.add(k.toLowerCase());
      if (isObj(v)) {
        if (v.modelName) keys.add(String(v.modelName).toLowerCase());
        walk(v);
      }
    }
  };
  walk(menu);
  return keys;
}

function columnEntry(entry, schemas, model, blockers, warnings) {
  const raw = typeof entry === 'string' ? { path: entry } : entry;
  if (!isObj(raw)) throw new UsageError('Each column is a field path ("stage") or {"path": "...", "width": 200}.');
  const path = String(raw.path || raw.name || '');
  if (!PATH_RE.test(path)) throw new UsageError(`"${path}" is not a field path.`);
  const res = walkSchema(schemas, model, path);
  if (!res.ok) blockers.push(`Column "${path}": ${res.reason}. The app would show an empty column.`);
  else if (res.ref === 'File') warnings.push(`Column "${path}" is a file; the app drops file columns.`);
  if (/password|token|secret|apikey/i.test(path)) blockers.push(`Column "${path}" looks sensitive; the app hides it.`);
  const width = raw.width === undefined ? COLUMN_WIDTH : Number(raw.width);
  if (!Number.isInteger(width) || width < 60 || width > 800) throw new UsageError(`Column "${path}": width must be 60–800.`);
  const segs = path.split('.');
  const name = raw.name ? String(raw.name) : segs[segs.length - 1];
  const col = { name, width };
  if (segs.length > 1) {
    col.path = path;
    col.selectKey = raw.selectKey ? String(raw.selectKey) : segs[0];
    if (col.selectKey === name) delete col.selectKey;
  }
  return col;
}

function buildColumns(plan, me, blockers, warnings) {
  const model = plan.model;
  modelSchema(me, model);
  if (!Array.isArray(plan.columns) || !plan.columns.length || plan.columns.length > 40) throw new UsageError('"columns" needs 1–40 entries.');
  const cols = plan.columns.map((c) => columnEntry(c, me.schemas, model, blockers, warnings));
  const names = cols.map((c) => c.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) blockers.push(`Two columns are named "${dup}"; give one a different "name".`);
  const stickyName = plan.sticky === undefined ? cols[0].name : String(plan.sticky);
  const sticky = cols.find((c) => c.name === stickyName || c.path === stickyName);
  if (!sticky) throw new UsageError(`"sticky" must be one of the columns (${names.join(', ')}).`);
  sticky.stickyColumn = true;
  return [sticky, ...cols.filter((c) => c !== sticky)];
}

function placeholders(template) {
  return [...String(template).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
}

// A row action that only opens a link. The host is fixed; record values go only into the
// path or query, URL-encoded, so a record cannot send the user to another site.
function rowActionCode(template) {
  return [
    `${MARKER} · opens a link (prolibu-ui-customization)`,
    `const template = ${JSON.stringify(template)};`,
    'const pick = (path) => path.split(\'.\').reduce((o, k) => (o == null ? o : o[k]), ctx.row);',
    'const url = template.replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, (m, p) => {',
    '  const v = pick(p);',
    '  return encodeURIComponent(v == null ? \'\' : (typeof v === \'object\' ? String(v._id || \'\') : String(v)));',
    '});',
    'ctx.openUrl(url);',
    '',
  ].join('\n');
}

function checkOpenUrl(template, me, model, blockers) {
  const fields = placeholders(template);
  const probe = String(template).replace(/\{\{\s*[\w.]+\s*\}\}/g, 'x');
  const { host } = checkUrl(probe, { allowPath: false });
  const hostPart = String(template).replace(/^https:\/\//i, '').split(/[/?#]/)[0];
  if (/\{\{/.test(hostPart)) blockers.push('Record values may go only in the path or query of the link, never in its host.');
  for (const f of fields) {
    const res = walkSchema(me.schemas, model, f);
    if (!res.ok) blockers.push(`{{${f}}}: ${res.reason}.`);
  }
  return { host, fields };
}

function reviewCode(code) {
  const text = String(code || '');
  const first = text.split('\n').find((l) => l.trim()) || '';
  return {
    lines: text.split('\n').length,
    sha: hash(text),
    runsInV2: MARKER_RE.test(first),
    urls: urlsIn(text),
    calls: {
      externalFetch: /ctx\.fetch\s*\(/.test(text),
      writesRecords: /\.(create|update)\s*\(/.test(text),
      opensLinks: /ctx\.openUrl\s*\(/.test(text),
      escapesSandbox: /constructor\s*\.\s*constructor|constructor\s*\[|\bimport\s*\(/.test(text),
    },
  };
}

function buildCode(plan, kind, me, blockers, warnings) {
  if (typeof plan.code !== 'string' || !plan.code.trim()) throw new UsageError('"code" is empty.');
  if (plan.code.length > MAX_CODE) throw new UsageError(`"code" is longer than ${MAX_CODE} characters.`);
  const review = reviewCode(plan.code);
  if (!review.runsInV2) blockers.push(`The first line of the code must be "${MARKER}"; without it the V2 app ignores the record.`);
  if (review.calls.escapesSandbox) blockers.push('The code reaches outside the widget sandbox (constructor.constructor / import()); refused.');
  if (review.calls.writesRecords) warnings.push('The code creates or changes records with the permissions of whoever uses it.');
  if (review.calls.externalFetch || review.urls.length) warnings.push(`The code talks to: ${review.urls.join(', ') || 'a URL built at run time'}.`);
  if (kind === 'rowAction' && /<template|<script/i.test(plan.code)) blockers.push('A row action is a plain async JS body (it gets ctx), not a <template>.');
  return review;
}

// Audience of a CustomUi record: everyone, or a list of users (admins always see it).
async function buildAudience(client, audience, body, out) {
  if (audience === undefined) return;
  if (audience === 'everyone') {
    body.allowEveryone = { view: true, edit: false };
    body.assignee = null;
    body.collaborators = [];
    return;
  }
  if (!isObj(audience) || !Array.isArray(audience.users) || !audience.users.length || audience.users.length > 50) {
    throw new UsageError('"audience" is "everyone" or {"users": ["e-mail", …]} (1–50).');
  }
  const users = await findUsers(client, audience.users);
  body.allowEveryone = { view: false, edit: false };
  body.assignee = String(users[0]._id);
  body.collaborators = users.slice(1).map((u) => String(u._id));
  out.audienceUsers = users.map((u) => u.email);
}

async function recipientsOf(client, body, current, warnings) {
  const view = body.allowEveryone ? body.allowEveryone.view : (current ? audienceOf(current).everyone : true);
  if (view !== false) {
    const n = await countUsers(client, warnings);
    return { everyone: true, users: n, text: `every user of the account${n ? ` (${n})` : ''}` };
  }
  return { everyone: false, text: 'admins plus the listed users' };
}

async function planUi(client, plan, me, cache) {
  const blockers = [];
  const warnings = [];
  const out = {};
  const action = plan.id ? 'update' : 'create';
  if (!can(me, 'CustomUi', action)) {
    const err = new Error(`This profile has no CustomUi.${action} permission (only admins customize the app's lists and menu).`);
    err.status = 403;
    throw err;
  }
  let current = null;
  if (plan.id) current = await loadUi(client, plan.id);

  if (['deactivate', 'activate', 'audience'].includes(plan.kind)) {
    if (!current) throw new UsageError(`A ${plan.kind} plan needs "id".`);
    const body = {};
    if (plan.kind === 'audience') await buildAudience(client, plan.audience, body, out);
    else body.active = plan.kind === 'activate';
    return finishUi(client, plan, current, body, { blockers, warnings, out });
  }

  const spec = TYPES[plan.kind];
  if (current && current.customUiType !== spec.type) throw new Blocked(`Record ${plan.id} is a "${current.customUiType}", not a "${spec.type}".`);
  const body = {};
  const sub = {};
  const model = plan.model || (current && uiModel(current));

  if (plan.kind === 'columns') {
    sub.modelName = model;
    sub.columns = buildColumns({ ...plan, model }, me, blockers, warnings);
    if (!current) {
      // The app keeps one default per object: update the one it uses instead of adding another.
      const list = cache.uiList || (cache.uiList = await loadUiList(client));
      const same = list.records.filter((r) => r.customUiType === spec.type && r.active !== false && uiModel(r) === model);
      if (same.length) {
        current = same[0];
        out.updates = current._id;
        if (same.length > 1) warnings.push(`There are ${same.length} active defaults for ${model}; the app uses the newest (${same[0]._id}) and ignores ${same.slice(1).map((r) => r._id).join(', ')}. Deactivate those.`);
      }
    }
    warnings.push('Users who already changed their own columns for this list keep theirs until they press "Restablecer"; the default reaches users with no saved columns.');
  } else if (plan.kind === 'sidebar') {
    const set = plan.set || {};
    const merged = { ...(current ? current.sideBar : {}), ...set };
    const target = merged.target || '_blank';
    if (!TARGETS.includes(target)) throw new UsageError(`"target" must be one of ${TARGETS.join(', ')}.`);
    const { url, external, host } = checkUrl(merged.url);
    if (!merged.label || String(merged.label).length > 60) throw new UsageError('"label" is required (≤ 60 characters).');
    Object.assign(sub, { label: String(merged.label), url, target });
    if (merged.insertBefore) {
      sub.insertBefore = String(merged.insertBefore);
      if (!menuKeys(me.menu).has(sub.insertBefore.toLowerCase())) warnings.push(`"${sub.insertBefore}" is not in this profile's menu; the link goes at the end.`);
    }
    if (external) {
      out.opens = host;
      if (target === '_self') warnings.push('An external link with target _self takes users out of the app; _blank opens a new tab.');
    }
  } else if (plan.kind === 'rowAction') {
    modelSchema(me, model);
    sub.modelName = model;
    const merged = { ...(current ? current.rowAction : {}), ...(plan.label ? { label: plan.label } : {}) };
    if (!merged.label || String(merged.label).length > 60) throw new UsageError('"label" is required (≤ 60 characters).');
    sub.label = String(merged.label);
    sub.slot = plan.slot || merged.slot || 'rowActionsSuffix';
    if (!SLOTS.includes(sub.slot)) throw new UsageError(`"slot" must be one of ${SLOTS.join(', ')}.`);
    sub.order = plan.order === undefined ? (merged.order || 0) : Number(plan.order);
    if (!Number.isInteger(sub.order)) throw new UsageError('"order" must be an integer.');
    if (plan.openUrl !== undefined && plan.code !== undefined) throw new UsageError('Use "openUrl" or "code", not both.');
    if (plan.openUrl !== undefined) {
      const { host, fields } = checkOpenUrl(plan.openUrl, me, model, blockers);
      body.code = rowActionCode(String(plan.openUrl).trim());
      out.opens = host;
      out.dataSentOut = fields;
      if (fields.length) warnings.push(`Clicking it sends ${fields.join(', ')} of the record to ${host}. A field the list did not load goes empty.`);
    } else if (plan.code !== undefined) {
      out.codeReview = buildCode(plan, 'rowAction', me, blockers, warnings);
      body.code = plan.code;
    } else if (!current) {
      throw new UsageError('A new row action needs "openUrl" (a link) or "code".');
    }
  } else {
    modelSchema(me, model);
    const field = plan.field || (current && current[spec.key].fieldName);
    if (!field || !PATH_RE.test(String(field))) throw new UsageError('"field" is required (a field path of the object).');
    const res = walkSchema(me.schemas, model, field);
    if (!res.ok) blockers.push(`"${field}": ${res.reason}. The widget would never show.`);
    Object.assign(sub, { modelName: model, fieldName: field });
    if (plan.code !== undefined) {
      out.codeReview = buildCode(plan, plan.kind, me, blockers, warnings);
      body.code = plan.code;
    } else if (!current) {
      throw new UsageError('A new widget needs "code".');
    }
  }

  body.customUiType = spec.type;
  body[spec.key] = sub;
  if (!current) {
    const label = sub.label || (sub.modelName ? `${sub.modelName}${sub.fieldName ? `.${sub.fieldName}` : ''}` : 'link');
    body.customUiName = checkName(plan.name, `${plan.kind} · ${label}`);
    body.active = true;
  } else if (plan.name !== undefined) {
    body.customUiName = checkName(plan.name);
  }
  await buildAudience(client, plan.audience, body, out);
  // Hand-written code needs its own yes; the link template above is fixed and reviewed here.
  if (plan.code !== undefined) out.runsCode = true;
  return finishUi(client, plan, current, body, { blockers, warnings, out });
}

async function finishUi(client, plan, current, body, { blockers, warnings, out }) {
  const changes = [];
  const send = {};
  for (const [k, v] of Object.entries(body)) {
    const before = current ? current[k] : undefined;
    const same = current && (k === 'assignee' ? idOf(before) === idOf(v)
      : k === 'collaborators' ? JSON.stringify((before || []).map(idOf)) === JSON.stringify(v)
        : JSON.stringify(before) === JSON.stringify(v));
    if (same) continue;
    send[k] = v;
    changes.push({ field: k, before: before === undefined ? null : (k === 'code' ? reviewCode(before) : before), after: k === 'code' ? reviewCode(v) : v });
  }
  const recipients = await recipientsOf(client, body, current, warnings);
  const target = current ? { action: 'update', _id: current._id, name: current.customUiName } : { action: 'create' };
  const version = current ? current.updatedAt : hash(send);
  return {
    object: 'CustomUi', target, changes, recipients, ...out, warnings, blockers, version, body: send,
  };
}

// ─── CustomFilter helpers ──────────────────────────────────────────────────────

const FILTER_SELECT = 'customFilterCode customFilterName modelName filter allowEveryone createdBy workspace updatedAt';

async function loadFilter(client, ref) {
  if (!ID_RE.test(String(ref)) && !CODE_RE.test(String(ref))) throw new UsageError('Give the filter id or code (CSF-…).');
  return call(client, 'GET', `/v2/customfilter/${encodeURIComponent(ref)}?${qs({ select: FILTER_SELECT })}`);
}

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function presetRange(preset, now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = new Date(Date.UTC(y, m, now.getUTCDate()));
  const add = (d, days) => new Date(d.getTime() + days * 86400000);
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  switch (preset) {
    case 'today': return [today, add(today, 1)];
    case 'yesterday': return [add(today, -1), today];
    case 'last7Days': return [add(today, -6), add(today, 1)];
    case 'last30Days': return [add(today, -29), add(today, 1)];
    case 'last90Days': return [add(today, -89), add(today, 1)];
    case 'thisWeek': return [add(today, -dow), add(today, 7 - dow)];
    case 'thisMonth': return [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 1))];
    case 'lastMonth': return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
    case 'thisYear': return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1))];
    default: throw new UsageError(`Unknown date preset "${preset}". Use ${DATE_PRESETS.join(', ')}.`);
  }
}

// Same wire shape as the app: one operator per entry inside $and (the server keeps only the
// last operator of an object), `to` as $lt of the next day.
function dateClauses(dates, now) {
  if (dates === undefined) return [];
  if (!Array.isArray(dates)) throw new UsageError('"dates" is a list of {"field", "preset"} or {"field", "from", "to"}.');
  const out = [];
  for (const d of dates) {
    if (!isObj(d) || !PATH_RE.test(String(d.field || ''))) throw new UsageError('Each date needs "field".');
    let from;
    let to;
    if (d.preset) [from, to] = presetRange(d.preset, now);
    else {
      const ok = (v) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v);
      if (!ok(d.from) || !ok(d.to) || (!d.from && !d.to)) throw new UsageError('"from"/"to" are YYYY-MM-DD.');
      from = d.from ? new Date(`${d.from}T00:00:00Z`) : undefined;
      to = d.to ? new Date(new Date(`${d.to}T00:00:00Z`).getTime() + 86400000) : undefined;
    }
    if (from) out.push({ [d.field]: { $gte: dayKey(from) } });
    if (to) out.push({ [d.field]: { $lt: dayKey(to) } });
  }
  return out;
}

// Replaces "$me" with the key user's id, as the app does before saving.
function resolveMe(value, meId, found) {
  if (value === '$me') {
    found.me = true;
    return meId;
  }
  if (Array.isArray(value)) return value.map((v) => resolveMe(v, meId, found));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveMe(v, meId, found)]));
  return value;
}

// Checks a Mongo query the way the app and server read it. Returns refs to verify.
function lintQuery(query, schemas, model, blockers, warnings) {
  const refs = [];
  const dates = [];
  const walkCond = (node, depth) => {
    if (depth > 6) {
      blockers.push('The filter nests too deep.');
      return;
    }
    if (!isObj(node)) {
      blockers.push('Every part of the filter must be an object.');
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      if (key.startsWith('$')) {
        if (!LOGIC_OPS.has(key)) {
          blockers.push(`"${key}" is not allowed at this level (only $and / $or).`);
          continue;
        }
        if (!Array.isArray(val) || !val.length) blockers.push(`"${key}" needs a non-empty list.`);
        else val.forEach((v) => walkCond(v, depth + 1));
        continue;
      }
      if (!PATH_RE.test(key)) {
        blockers.push(`"${key}" is not a field path.`);
        continue;
      }
      const res = walkSchema(schemas, model, key);
      if (!res.ok) {
        blockers.push(`${res.reason}; the list would come back empty or ignore it.`);
        continue;
      }
      const values = [];
      if (isObj(val)) {
        const ops = Object.keys(val);
        if (ops.length !== 1) blockers.push(`"${key}" has ${ops.length} operators in one object; the server keeps only the last. Put each in its own entry inside $and.`);
        for (const op of ops) {
          if (op === '$options') blockers.push(`"${key}": use "(?i)" at the start of $regex instead of $options.`);
          else if (!FIELD_OPS.has(op)) blockers.push(`"${key}": operator "${op}" is not allowed.`);
          const v = val[op];
          if (isObj(v)) blockers.push(`"${key}.${op}" must be a value, not an object.`);
          if (op === '$regex' && typeof v !== 'string') blockers.push(`"${key}.$regex" must be text.`);
          if (op === '$regex' && typeof v === 'string') {
            try {
              RegExp(v.replace(/^\(\?i\)/, ''));
            } catch {
              blockers.push(`"${key}.$regex" is not a valid pattern.`);
            }
          }
          if (['$in', '$nin'].includes(op) && !Array.isArray(v)) blockers.push(`"${key}.${op}" must be a list.`);
          if (['$gt', '$gte', '$lt', '$lte'].includes(op) && res.type === 'date') dates.push(key);
          if (!['$regex', '$exists'].includes(op)) values.push(...[].concat(v));
        }
      } else if (Array.isArray(val)) {
        blockers.push(`"${key}" is a list; use {"$in": [...]}.`);
      } else {
        values.push(val);
      }
      if (res.ref) {
        for (const v of values) {
          if (v === null || v === '') continue;
          if (!ID_RE.test(String(v))) blockers.push(`"${key}" points to ${res.ref}: "${v}" is not an id.`);
          else refs.push({ field: key, ref: res.ref, id: String(v) });
        }
      }
      if (res.enum) {
        for (const v of values) if (v !== null && v !== '' && !res.enum.includes(v)) blockers.push(`"${key}": "${v}" is not one of ${res.enum.join(', ')}.`);
      }
    }
  };
  walkCond(query, 0);
  if (dates.length) warnings.push(`Dates are saved as fixed days (${[...new Set(dates)].join(', ')}): the filter will not move to next month by itself.`);
  return refs;
}

async function checkRefs(client, refs, warnings, blockers) {
  const byRef = new Map();
  refs.forEach((r) => {
    if (!byRef.has(r.ref)) byRef.set(r.ref, new Set());
    byRef.get(r.ref).add(r.id);
  });
  const names = {};
  for (const [ref, ids] of byRef) {
    const list = [...ids];
    const nameKey = `${ref.charAt(0).toLowerCase()}${ref.slice(1)}Name`;
    const select = `_id email firstName lastName stageName tagName companyName ${nameKey}`;
    const res = await client.request('GET', `/v2/${restOf(ref)}?${qs({ xquery: JSON.stringify({ _id: { $in: list } }), select, limit: String(list.length) })}`);
    if (!res.ok) {
      warnings.push(`Could not check the ${ref} ids (${res.status}).`);
      continue;
    }
    const found = new Map((res.body.data || []).map((d) => [String(d._id), d]));
    for (const id of list) {
      const d = found.get(id);
      if (!d) blockers.push(`${ref} ${id} does not exist (or this profile cannot see it).`);
      else names[id] = d.stageName || d.email || [d.firstName, d.lastName].filter(Boolean).join(' ') || d.tagName || d.companyName || d[nameKey] || null;
    }
  }
  return names;
}

// Lets a plan name stages by code and users by e-mail; they are saved as ids, like the app does.
const LOOKUP = { Stage: 'stageCode', User: 'email' };

async function resolveRefValues(client, query, schemas, model) {
  const wanted = new Map();
  const visit = (node, fn) => {
    if (Array.isArray(node)) return node.map((n) => visit(n, fn));
    if (!isObj(node)) return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => {
      if (LOGIC_OPS.has(k)) return [k, visit(v, fn)];
      if (k.startsWith('$') || !PATH_RE.test(k)) return [k, v];
      const res = walkSchema(schemas, model, k);
      const by = res.ok && res.ref ? LOOKUP[res.ref] : null;
      if (!by) return [k, v];
      const map = (x) => (typeof x === 'string' && x && !ID_RE.test(x) ? fn(res.ref, x) : x);
      if (isObj(v)) return [k, Object.fromEntries(Object.entries(v).map(([op, ov]) => [op, Array.isArray(ov) ? ov.map(map) : map(ov)]))];
      return [k, map(v)];
    }));
  };
  visit(query, (ref, x) => {
    if (!wanted.has(ref)) wanted.set(ref, new Set());
    wanted.get(ref).add(x);
    return x;
  });
  if (!wanted.size) return query;
  const found = {};
  for (const [ref, values] of wanted) {
    const by = LOOKUP[ref];
    const list = [...values].map((v) => (by === 'email' ? v.toLowerCase() : v));
    const res = await client.request('GET', `/v2/${restOf(ref)}?${qs({ xquery: JSON.stringify({ [by]: { $in: list } }), select: `_id ${by}`, limit: String(list.length + 5) })}`);
    if (!res.ok) throw new Blocked(`Could not look up ${ref} by ${by} (${res.status}); give ids instead.`);
    found[ref] = new Map((res.body.data || []).map((d) => [String(d[by]).toLowerCase(), String(d._id)]));
  }
  return visit(query, (ref, x) => {
    const id = found[ref].get(x.toLowerCase());
    if (!id) throw new Blocked(`No ${ref} with ${LOOKUP[ref]} "${x}".`);
    return id;
  });
}

async function countMatches(client, model, query) {
  const res = await client.request('GET', `/v2/${restOf(model)}?${qs({ xquery: JSON.stringify(query), select: '_id', limit: '1' })}`);
  if (!res.ok) return { error: res.status };
  return { count: res.body.pagination ? res.body.pagination.count : (res.body.data || []).length };
}

async function planFilter(client, plan, me, ctx) {
  const blockers = [];
  const warnings = [];
  const set = plan.set || {};
  if (!isObj(set)) throw new UsageError('"set" must be an object.');
  let current = null;
  if (plan.id) current = await loadFilter(client, plan.id);
  else if (!can(me, 'CustomFilter', 'create')) warnings.push('This profile has no CustomFilter.create; the server will answer 403.');
  const model = set.model || (current && current.modelName);
  modelSchema(me, model);
  const body = {};
  if (!current) {
    body.customFilterName = checkName(set.name);
    body.modelName = model;
  } else {
    if (set.name !== undefined) body.customFilterName = checkName(set.name);
    if (set.model !== undefined) body.modelName = model;
  }
  const found = {};
  let query = null;
  if (set.query !== undefined || set.dates !== undefined) {
    const base = set.query === undefined ? {} : set.query;
    if (!isObj(base)) throw new UsageError('"query" must be a JSON object (a Mongo filter).');
    const resolved = await resolveRefValues(client, resolveMe(base, me.id, found), me.schemas, model);
    const extra = dateClauses(set.dates, ctx.now);
    query = extra.length ? { ...resolved, $and: [...(resolved.$and || []), ...extra] } : resolved;
    body.filter = query;
  } else if (!current) {
    throw new UsageError('A new filter needs "query" and/or "dates".');
  }
  const effective = query || (current && current.filter) || {};
  const refs = lintQuery(effective, me.schemas, model, blockers, warnings);
  const refNames = refs.length ? await checkRefs(client, refs, warnings, blockers) : {};
  if (set.editableByAll) blockers.push('Letting everyone edit a shared filter lets any user change what the team sees; it is refused. Share it to view only.');
  if (set.shared !== undefined) {
    if (typeof set.shared !== 'boolean') throw new UsageError('"shared" is true or false.');
    body.allowEveryone = { view: set.shared, edit: false };
  }
  const shared = body.allowEveryone ? body.allowEveryone.view : !!(current && current.allowEveryone && current.allowEveryone.view);
  const userIds = refs.filter((r) => r.ref === 'User').map((r) => r.id);
  if (found.me) warnings.push('"$me" was saved as your own user id: everyone who uses this filter sees YOUR records, not theirs.');
  if (shared && userIds.length) warnings.push(`Shared filter fixed to user(s) ${userIds.map((id) => refNames[id] || id).join(', ')}: every viewer sees those users' records (among the ones they may already see).`);
  if (!Object.keys(effective).length) warnings.push('The filter is empty: applying it shows the whole list.');
  const matches = blockers.length ? null : await countMatches(client, model, effective);

  const changes = Object.entries(body)
    .filter(([k, v]) => !current || JSON.stringify(current[k]) !== JSON.stringify(v))
    .map(([k, v]) => ({ field: k, before: current ? (current[k] === undefined ? null : current[k]) : null, after: v }));
  const send = Object.fromEntries(changes.map((c) => [c.field, c.after]));
  if (current && createdByOther(current, me)) warnings.push('You are changing a filter someone else created.');
  return {
    object: 'CustomFilter',
    target: current ? { action: 'update', _id: current._id, name: current.customFilterName } : { action: 'create' },
    model,
    changes,
    refNames,
    matchesForThisProfile: matches,
    recipients: shared
      ? { shared: true, text: `every user of the account who can open the ${model} list; each one still sees only the records they may see` }
      : { shared: false, text: 'only you (plus admins, and users who share your workspace)' },
    warnings,
    blockers,
    version: current ? current.updatedAt : hash(send),
    body: send,
  };
}

function createdByOther(record, me) {
  return record.createdBy && idOf(record.createdBy) !== me.id;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdUi(client, rest, flags) {
  if (flags.type && !TYPES[flags.type]) throw new UsageError(`--type must be one of ${Object.keys(TYPES).join(', ')}.`);
  const { records, total } = await loadUiList(client);
  let list = flags.all ? records : records.filter((r) => r.active !== false);
  if (flags.type) list = list.filter((r) => r.customUiType === TYPES[flags.type].type);
  if (flags.model) list = list.filter((r) => uiModel(r) === flags.model);
  return {
    total, shown: list.length, records: list.map(summarizeUi), conflicts: conflicts(records),
    note: total > 500 ? 'More than 500 records: the app reads only the newest 500.' : undefined,
  };
}

async function cmdUiShow(client, [ref]) {
  if (!ref) throw new UsageError('Usage: ui-show <domain> <id|code>');
  const r = await loadUi(client, ref);
  return { record: summarizeUi(r), raw: { ...r, code: r.code || '' }, version: r.updatedAt };
}

async function cmdFilters(client, rest, flags) {
  const me = await loadMe(client, {});
  const xquery = {};
  if (flags.model) xquery.modelName = { $in: [flags.model, `${flags.model}s`] };
  if (flags.search) xquery.customFilterName = { $regex: `(?i)${String(flags.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  // /search, not the list: roles that may use saved filters have search but not find.
  const body = await call(client, 'GET', `/v2/customfilter/search?${qs({
    xquery: JSON.stringify(xquery), select: FILTER_SELECT, populatePath: JSON.stringify([{ path: 'createdBy', select: 'email firstName lastName' }]), sort: '-createdAt', limit: '100',
  })}`);
  const data = body.data || [];
  return {
    shown: data.length,
    filters: data.map((f) => ({
      _id: f._id, code: f.customFilterCode, name: f.customFilterName, model: f.modelName,
      shared: !!(f.allowEveryone && f.allowEveryone.view), editableByAll: !!(f.allowEveryone && f.allowEveryone.edit),
      owner: isObj(f.createdBy) ? f.createdBy.email : idOf(f.createdBy), mine: idOf(f.createdBy) === me.id,
    })),
    note: 'These are the filters this profile can see. To check what a seller sees, run the same command with --profile <seller>.',
  };
}

async function cmdFilter(client, [ref], flags, ctx) {
  if (!ref) throw new UsageError('Usage: filter <domain> <id|code>');
  const me = await loadMe(client, {});
  let f;
  try {
    f = await loadFilter(client, ref);
  } catch (err) {
    // The server answers 404 or 403 when record access hides the filter from this user.
    if (err.status === 404 || err.status === 403) {
      return {
        visible: false,
        explain: 'This profile cannot see that filter: it is not shared (allowEveryone.view off) and was not created by this user. Ask its owner to share it, or create a copy.',
      };
    }
    throw err;
  }
  const blockers = [];
  const warnings = [];
  if (!me.schemas[f.modelName]) blockers.push(`This profile cannot open the ${f.modelName} list, so the filter is useless to it.`);
  const refs = me.schemas[f.modelName] ? lintQuery(f.filter || {}, me.schemas, f.modelName, blockers, warnings) : [];
  const refNames = refs.length ? await checkRefs(client, refs, warnings, blockers) : {};
  const shared = !!(f.allowEveryone && f.allowEveryone.view);
  if (shared && refs.some((r) => r.ref === 'User')) warnings.push('It is fixed to specific users: every viewer sees those users\' records, not their own.');
  if (f.allowEveryone && f.allowEveryone.edit) warnings.push('Anyone can edit this filter (allowEveryone.edit). Turn that off.');
  const matches = me.schemas[f.modelName] ? await countMatches(client, f.modelName, f.filter || {}) : null;
  void ctx;
  return {
    visible: true, _id: f._id, code: f.customFilterCode, name: f.customFilterName, model: f.modelName, filter: f.filter,
    shared, editableByAll: !!(f.allowEveryone && f.allowEveryone.edit), mine: idOf(f.createdBy) === me.id, workspace: idOf(f.workspace),
    refNames, matchesForThisProfile: matches, warnings, problems: blockers, version: f.updatedAt,
  };
}

async function cmdFields(client, [model], flags) {
  if (!model) throw new UsageError('Usage: fields <domain> <Model> [--search text]');
  const me = await loadMe(client, {});
  const schema = modelSchema(me, model);
  const rows = [];
  const walk = (node, prefix, depth) => {
    for (const [k, attr] of Object.entries(node)) {
      if (!isObj(attr)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      const isArray = Array.isArray(attr.type);
      const type = isArray ? attr.type[0] : attr.type;
      if (typeof type === 'string' || attr.ref) {
        if (!attr.hidden) rows.push({ path, type: attr.ref ? `ref ${attr.ref}` : type, list: isArray || undefined, enum: attr.enum || undefined });
      } else if (depth < 2) walk(attr, path, depth + 1);
    }
  };
  walk(schema, '', 0);
  const term = flags.search ? String(flags.search).toLowerCase() : null;
  const out = term ? rows.filter((r) => r.path.toLowerCase().includes(term)) : rows;
  return { model, count: out.length, fields: out.slice(0, 300) };
}

async function buildPlan(client, plan, ctx) {
  const cache = {};
  const me = await loadMe(client, cache);
  return plan.kind === 'filter' ? planFilter(client, plan, me, ctx) : planUi(client, plan, me, cache);
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await buildPlan(client, plan, ctx);
  let nextStep;
  if (result.blockers.length) nextStep = 'Blocked: tell the user why in plain words; do not apply.';
  else if (!result.changes.length) nextStep = 'Nothing to change: tell the user it is already like that.';
  else {
    const extra = result.runsCode ? ' plus --runs-code (this code runs in the browser of every user listed in recipients: the user must approve that too)' : '';
    nextStep = `${STOP}, --confirmed${extra}.`;
  }
  return { ...result, nextStep };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await buildPlan(client, plan, ctx);
  if (result.blockers.length) throw new Blocked(result.blockers.join(' '));
  if (result.version !== flags.version) throw new Blocked('The record or the plan changed since the preview. Preview again and show the user.');
  if (result.runsCode && !flags.runsCode) throw new Blocked('This plan saves code that runs in users\' browsers: it needs --runs-code after the user approved it.');
  if (!result.changes.length) return { saved: true, unchanged: true, problems: [] };

  const base = result.object === 'CustomUi' ? '/v2/customui' : '/v2/customfilter';
  const saved = result.target.action === 'create'
    ? await call(client, 'POST', base, { data: result.body, confirmed: true })
    : await call(client, 'PATCH', `${base}/${result.target._id}`, { data: result.body, confirmed: true });
  const id = result.target._id || (saved && saved._id);
  const after = result.object === 'CustomUi' ? await loadUi(client, id) : await loadFilter(client, id);
  const problems = Object.entries(result.body)
    .filter(([k, v]) => {
      const got = after[k];
      if (k === 'assignee') return idOf(got) !== idOf(v);
      if (k === 'collaborators') return JSON.stringify((got || []).map(idOf)) !== JSON.stringify(v);
      if (isObj(v) && k !== 'filter') return Object.entries(v).some(([sk, sv]) => JSON.stringify(got && got[sk]) !== JSON.stringify(sv));
      return JSON.stringify(got) !== JSON.stringify(v);
    })
    .map(([k]) => `${k} did not save as sent.`);
  return {
    saved: problems.length === 0,
    object: result.object,
    action: result.target.action,
    _id: id,
    code: after.customUiCode || after.customFilterCode,
    name: after.customUiName || after.customFilterName,
    version: after.updatedAt,
    recipients: result.recipients,
    problems,
    note: result.object === 'CustomUi' ? 'Open users see it after reloading the app (it caches CustomUi for the session).' : undefined,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = {
    '--version': 'version', '--profile': 'profile', '--type': 'type', '--model': 'model', '--search': 'search',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--runs-code') flags.runsCode = true;
    else if (arg === '--all') flags.all = true;
    else if (valued[arg]) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[valued[arg]] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  ui: cmdUi, 'ui-show': cmdUiShow, filters: cmdFilters, filter: cmdFilter, fields: cmdFields, preview: cmdPreview, apply: cmdApply,
};

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can do it or grant the permission.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: ui.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir, now: opts.now || new Date() });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (result.blockers && result.blockers.length) return BLOCKED;
    if (result.problems && result.problems.length && command === 'apply') return 1;
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
  main, walkSchema, checkUrl, lintQuery, dateClauses, presetRange, rowActionCode, reviewCode, conflicts, resolveMe,
};
