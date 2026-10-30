#!/usr/bin/env node
'use strict';

// Creates, changes and checks a Prolibu web Form the way the app's form builder does:
// fields in the builder's format, one mapping per target object, keys that match, every
// required field of the target fed, an explicit access mode, and a read-back after saving.
//
//   form.js list        <domain> [<part of the name>]
//   form.js show        <domain> <formId | formCode>
//   form.js fields      <domain> <Object>                  (e.g. Contact, Deal, Ticket)
//   form.js preview     <domain> '<form json>' [--form <formId>]
//   form.js create      <domain> '<form json>' --confirmed
//   form.js update      <domain> <formId> '<changes json>' --form-version <v> --confirmed
//   form.js submit-test <domain> <formId> '<data json>' --confirmed
//   form.js submissions <domain> <formId> [--limit <n>]
//
// JSON input is inline, or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
class Blocked extends Error {}

// What a form definition may set. type, endings, metaMapping and formCode are left out on purpose.
const FORM_KEYS = new Set([
  'formName', 'description', 'formSchema', 'mappings', 'access', 'thankYou', 'submissions',
  'assignmentGroup', 'uploads', 'active',
]);
// Plain sub-objects: a PATCH merges them key by key. formSchema and mappings are replaced whole.
const MERGED_KEYS = new Set(['access', 'thankYou', 'submissions', 'uploads']);
const SCHEMA_META_KEYS = new Set(['title', 'description', 'mode', 'theme', 'pages']);
// The server's own list (validated case-insensitively when the form is saved).
const VALID_TYPES = new Set([
  'string', 'number', 'boolean', 'date', 'objectid', 'mixed', 'array', 'text', 'select', 'email',
  'phone', 'url', 'textarea', 'rating', 'slider', 'color', 'file', 'html', 'section',
]);
// Types the server accepts but the hosted page does not understand: it draws a plain text box.
const BUILDER_EQUIVALENT = {
  email: '{"type":"String","format":"email"}',
  textarea: '{"type":"String","uiCom":"TextArea"}',
  phone: '{"type":"String","uiCom":"PhoneWithIndicative"}',
  rating: '{"type":"Number","uiCom":"Rating","max":5}',
  slider: '{"type":"Number","uiCom":"Slider","min":0,"max":100}',
  color: '{"type":"String","uiCom":"ColorPicker"}',
  section: '{"uiCom":"Section","label":"…"}',
  html: '{"type":"String","uiCom":"HtmlEditor"}',
  text: '{"type":"String"}',
  url: '{"type":"String"}',
  select: '{"type":"String","enum":["A","B"]}',
};
// Filled by the server, never by a form (same list the app's mapping tab skips).
const TECHNICAL = new Set([
  '_id', 'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', '__v', 'deletedAt', 'deletedBy',
  'isDeleted', 'workspace',
]);
// The app's type compatibility (form value type → object field types it may fill).
const COMPATIBLE = {
  string: ['string', 'mixed', 'objectid'],
  number: ['number', 'mixed'],
  boolean: ['boolean', 'mixed'],
  date: ['date', 'mixed'],
  objectid: ['objectid', 'string', 'mixed'],
};
const ID_RE = /^[a-f0-9]{24}$/i;

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSchema(schema) {
  if (typeof schema !== 'string') return schema;
  try {
    return JSON.parse(schema);
  } catch {
    throw new UsageError('formSchema is a string that is not valid JSON.');
  }
}

// Same flattening as the server: a paged schema merges every page's fields (a later page
// overwrites an earlier key); a flat schema is every object key except the meta keys.
function flattenFields(schema) {
  const fields = {};
  const duplicates = [];
  if (!isPlainObject(schema)) return { fields, duplicates, paged: false };
  if (Array.isArray(schema.pages)) {
    for (const page of schema.pages) {
      for (const [key, def] of Object.entries((page && page.fields) || {})) {
        if (key in fields) duplicates.push(key);
        fields[key] = def;
      }
    }
    return { fields, duplicates, paged: true };
  }
  const reserved = [];
  for (const [key, def] of Object.entries(schema)) {
    if (!SCHEMA_META_KEYS.has(key) && isPlainObject(def)) fields[key] = def;
    else if (SCHEMA_META_KEYS.has(key) && isPlainObject(def) && (def.type || def.uiCom)) reserved.push(key);
  }
  return { fields, duplicates, reserved, paged: false };
}

// The type of value a field sends, as the app's builder means it.
function valueType(def) {
  if (!isPlainObject(def)) return null;
  const ui = def.uiCom;
  if (ui === 'Section') return null;
  if (ui === 'Rating' || ui === 'Slider') return 'number';
  if (ui === 'CheckboxGroup' || ui === 'Ordering') return 'array';
  if (ui === 'Matching') return 'object';
  if (ui === 'File' || ui === 'FileUpload') return 'objectid';
  const type = typeof def.type === 'string' ? def.type.toLowerCase() : '';
  if (['string', 'number', 'boolean', 'date', 'objectid', 'array', 'mixed'].includes(type)) return type;
  if (type === 'rating' || type === 'slider') return 'number';
  if (type === 'section') return null;
  if (type === 'file') return 'objectid';
  return type ? 'string' : null;
}

function isSection(def) {
  return isPlainObject(def) && (def.uiCom === 'Section' || String(def.type || '').toLowerCase() === 'section');
}

function normalizeDefinition(input, { forCreate }) {
  if (!isPlainObject(input)) throw new UsageError('The form must be a JSON object.');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!FORM_KEYS.has(key)) {
      const hint = key === 'endings' ? ' Endings are deprecated: use thankYou.redirectURL and submissions.notifyOnSubmit.' : '';
      throw new UsageError(`"${key}" cannot be set by this script. Allowed: ${[...FORM_KEYS].join(', ')}.${hint}`);
    }
    out[key] = key === 'formSchema' ? parseSchema(value) : value;
  }
  for (const key of MERGED_KEYS) {
    if (key in out && !isPlainObject(out[key])) throw new UsageError(`"${key}" must be an object.`);
  }
  if ('mappings' in out && !Array.isArray(out.mappings)) throw new UsageError('"mappings" must be an array.');
  if (forCreate && (typeof out.formName !== 'string' || !out.formName.trim())) {
    throw new UsageError('A new form needs "formName".');
  }
  return out;
}

// What the stored form looks like after a PATCH with `changes`.
function mergeForm(stored, changes) {
  const merged = clone(stored) || {};
  for (const [key, value] of Object.entries(changes)) {
    merged[key] = MERGED_KEYS.has(key) && isPlainObject(merged[key]) ? { ...merged[key], ...value } : clone(value);
  }
  return merged;
}

function accessSummary(access) {
  const a = access || {};
  return {
    mode: a.mode || '',
    enableCaptcha: a.enableCaptcha !== false,
    ...(a.mode === 'password' ? { hasPassword: Boolean(a.password) } : {}),
    ...(a.serviceCredential ? { serviceCredential: a.serviceCredential } : {}),
  };
}

function links(domain, form) {
  if (!form || !form._id) return null;
  return {
    view: `https://${domain}/v2/form/view/${form._id}`,
    ...(form.formCode ? { viewByCode: `https://${domain}/v2/form/view/${form.formCode}` } : {}),
    thanks: `https://${domain}/v2/form/thanks/${form._id}`,
  };
}

function formSummary(domain, form) {
  const { fields } = flattenFields(form.formSchema);
  return {
    _id: form._id || null,
    formCode: form.formCode || null,
    formName: form.formName,
    type: form.type || 'web',
    active: form.active !== false,
    updatedAt: form.updatedAt || null,
    fields: Object.entries(fields).map(([key, def]) => ({
      key,
      label: def.label || null,
      type: def.type || null,
      ...(def.uiCom ? { uiCom: def.uiCom } : {}),
      ...(def.format ? { format: def.format } : {}),
      required: Boolean(def.required),
      ...(Array.isArray(def.enum) ? { options: def.enum } : {}),
    })),
    mappings: (form.mappings || []).map((m) => ({
      modelName: m.modelName,
      fieldMap: m.fieldMap || {},
      ...(m.defaults ? { defaults: m.defaults } : {}),
      ...(m.assignmentGroup ? { assignmentGroup: m.assignmentGroup } : {}),
    })),
    access: accessSummary(form.access),
    afterSubmit: form.thankYou && form.thankYou.redirectURL
      ? { redirectURL: form.thankYou.redirectURL }
      : { title: (form.thankYou && form.thankYou.title) || null, message: (form.thankYou && form.thankYou.message) || null },
    submissions: {
      persist: Boolean(form.submissions && form.submissions.persist),
      notifyOnSubmit: (form.submissions && form.submissions.notifyOnSubmit) || [],
    },
    ...(form.assignmentGroup ? { assignmentGroup: form.assignmentGroup } : {}),
    links: links(domain, form),
  };
}

function modelFieldMap(list) {
  const map = new Map();
  for (const field of list || []) map.set(field.attrPath, field);
  return map;
}

// Checks a form definition. `models` maps modelName → Map(attrPath → field) or null when the
// object does not exist. `captchaReady` is true, false or null (unknown).
// errors: the server rejects the save, or the form can never create its record.
// warnings: it saves, but something will not work the way the user expects.
function checkForm(form, models, { captchaReady = null, isNew = !form._id } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const schema = form.formSchema;
  if (schema !== undefined && schema !== null && !isPlainObject(schema)) errors.push('formSchema must be a JSON object.');
  const { fields, duplicates, reserved = [] } = flattenFields(schema);
  const keys = Object.keys(fields);
  for (const key of reserved) warnings.push(`A field named "${key}" is ignored: in a one-page form that name is reserved. Rename it.`);

  // Fields: the server's rules, then what the hosted page needs.
  for (const [key, def] of Object.entries(fields)) {
    if (!def.type && !def.uiCom && !(def.sourceModel && def.sourceAttr)) errors.push(`Field "${key}" has no "type".`);
    if (def.type !== undefined && (typeof def.type !== 'string' || !VALID_TYPES.has(def.type.toLowerCase()))) {
      errors.push(`Field "${key}" has invalid type ${JSON.stringify(def.type)}.`);
    } else if (typeof def.type === 'string' && BUILDER_EQUIVALENT[def.type] && !(def.type === 'select' && Array.isArray(def.enum))) {
      warnings.push(`Field "${key}" uses type "${def.type}": the server accepts it, but the hosted page draws a plain text box `
        + `with no check. Write it as the app's builder does: ${BUILDER_EQUIVALENT[def.type]}.`);
    }
    if (key.startsWith('_')) warnings.push(`Field "${key}" starts with "_": the builder reserves those names and the server skips them.`);
  }
  for (const key of new Set(duplicates)) {
    warnings.push(`Field "${key}" is on more than one page: the submission keeps only one value for it.`);
  }
  if (!keys.length) warnings.push('The form has no fields.');

  // Mappings.
  const mappings = Array.isArray(form.mappings) ? form.mappings : [];
  const fed = [];
  mappings.forEach((m, i) => {
    const where = `mappings[${i}]`;
    if (!isPlainObject(m)) { errors.push(`${where} must be an object.`); return; }
    if (!m.modelName) { errors.push(`${where} has no "modelName".`); return; }
    const target = models[m.modelName];
    if (target === null) errors.push(`${where}: "${m.modelName}" is not an object of this account.`);
    if (m.action && m.action !== 'create') errors.push(`${where}: action "${m.action}" is not supported; only "create".`);
    const fieldMap = isPlainObject(m.fieldMap) ? m.fieldMap : null;
    if (!fieldMap || !Object.keys(fieldMap).length) errors.push(`${where} needs a non-empty "fieldMap".`);
    const defaults = isPlainObject(m.defaults) ? m.defaults : {};
    if (m.defaults !== undefined && !isPlainObject(m.defaults)) errors.push(`${where}.defaults must be an object.`);
    const fills = {};

    const checkPath = (path, label) => {
      if (typeof path !== 'string' || !path.trim()) { errors.push(`${where}: ${label} has no target field.`); return null; }
      if (TECHNICAL.has(path.split('.')[0])) { errors.push(`${where}: ${label} targets "${path}", which the server sets.`); return null; }
      if (!target) return null;
      const attr = target.get(path);
      if (attr) return attr;
      if ([...target.keys()].some((p) => p.startsWith(`${path}.`))) {
        warnings.push(`${where}: ${label} fills the whole group "${path}" of ${m.modelName}; map its parts instead (for example "${path}.…").`);
        return null;
      }
      errors.push(`${where}: ${label} targets "${path}", which is not a field of ${m.modelName}; the value would be dropped. `
        + `Run "fields" to see the field paths.`);
      return null;
    };

    for (const [key, path] of Object.entries(fieldMap || {})) {
      const label = `form field "${key}"`;
      if (keys.length && !(key in fields)) {
        errors.push(`${where}: fieldMap key "${key}" is not a field of the form (keys are form field keys; values are ${m.modelName} field paths).`);
        continue;
      }
      const def = fields[key];
      fills[path] = { fromField: key };
      if (def && isSection(def)) warnings.push(`${where}: "${key}" is a section title and sends no value.`);
      const attr = checkPath(path, label);
      if (!attr || !def) continue;
      const from = valueType(def);
      const to = String(attr.type || '').toLowerCase();
      const allowed = COMPATIBLE[from];
      if (from && to && allowed && !allowed.includes(to)) {
        warnings.push(`${where}: "${key}" sends a ${from} into ${m.modelName}.${path}, which is a ${to}.`);
      }
      if (Array.isArray(attr.enum) && attr.enum.length) {
        const options = Array.isArray(def.enum) ? def.enum : null;
        const bad = options ? options.filter((o) => !attr.enum.includes(o)) : [];
        if (!options) {
          warnings.push(`${where}: ${m.modelName}.${path} only takes ${JSON.stringify(attr.enum.slice(0, 12))}; "${key}" is free text, `
            + 'so any other answer makes the record fail. Give the field the same options.');
        } else if (bad.length) {
          warnings.push(`${where}: options ${JSON.stringify(bad)} of "${key}" are not values of ${m.modelName}.${path}; choosing them makes the record fail.`);
        }
      }
      if (attr.required && !def.required) {
        warnings.push(`${where}: ${m.modelName}.${path} is required but "${key}" is optional; a visitor who leaves it empty creates nothing. Make "${key}" required.`);
      }
      if (m.modelName === 'Contact' && path === 'email' && def.format !== 'email' && String(def.type).toLowerCase() !== 'email') {
        warnings.push(`${where}: "${key}" fills Contact.email but has no email check on the page; add "format": "email".`);
      }
    }
    for (const [path, value] of Object.entries(defaults)) {
      fills[path] = fills[path] ? { ...fills[path], default: value } : { default: value };
      const attr = checkPath(path, `default "${path}"`);
      if (attr && Array.isArray(attr.enum) && attr.enum.length && !attr.enum.includes(value)) {
        errors.push(`${where}: default ${JSON.stringify(value)} is not a value of ${m.modelName}.${path} ${JSON.stringify(attr.enum.slice(0, 12))}.`);
      }
    }
    const missing = [];
    if (target) {
      for (const [path, attr] of target) {
        if (attr.required && !TECHNICAL.has(path.split('.')[0]) && !(path in fills)) missing.push(path);
      }
    }
    if (missing.length) {
      errors.push(`${where}: ${m.modelName} requires ${missing.join(', ')}, and no form field or default fills it; `
        + 'every submission would fail to create the record.');
    }
    if (m.assignmentGroup) notes.push(`${where}: new ${m.modelName} records go to user group ${m.assignmentGroup}.`);
    fed.push({ modelName: m.modelName, fills, ...(missing.length ? { missingRequired: missing } : {}) });
  });
  if (!mappings.length) {
    warnings.push(form.submissions && form.submissions.persist
      ? 'No mappings: a submission creates no record; it is only kept as a form submission.'
      : 'No mappings and submissions are not stored: every submission is lost.');
  }

  // Who may submit.
  const access = form.access || {};
  const mode = access.mode || '';
  const captcha = access.enableCaptcha !== false;
  let submittable = { ok: true };
  if (!['', 'public', 'authenticated', 'password'].includes(mode)) {
    errors.push(`access.mode "${mode}" is not valid: use public, authenticated or password.`);
  } else if (!mode && captcha) {
    errors.push('access.mode is empty: the server then asks for a captcha, but the hosted page only shows one for "public", '
      + 'so nobody can send the form. Set access.mode to public, authenticated or password.');
    submittable = { ok: false, reason: 'access.mode is empty' };
  } else if (!mode) {
    warnings.push('access.mode is empty; it works as public without captcha. Set it explicitly.');
  }
  if (mode === 'public' && captcha) {
    if (captchaReady === false) {
      warnings.push('Public with captcha, but the account has no active Cloudflare Turnstile credential: the page shows no captcha '
        + 'and every submission fails ("Captcha token required"). An admin adds one under Service credentials, or turn captcha off.');
      submittable = { ok: false, reason: 'no captcha credential' };
    } else if (captchaReady === null) {
      notes.push('Could not check the captcha credential; after saving, "show" checks it.');
    }
  }
  if (mode === 'public' && !captcha) warnings.push('Public with captcha off: anyone can post to it; only the rate limit stops spam.');
  if (mode === 'password' && !access.password) {
    if (isNew) notes.push('Password mode with no password: the server generates one when it creates the form. The user reads it in the app.');
    else errors.push('Password mode with no password: the server only generates one when the form is created, so nobody could open it. Set access.password.');
  }
  if (mode === 'authenticated') notes.push('Only signed-in users of this account can send it; others see a sign-in button.');

  // After submit, storage, notifications.
  const thankYou = form.thankYou || {};
  if (thankYou.redirectURL && !/^https?:\/\//i.test(thankYou.redirectURL)) {
    warnings.push('thankYou.redirectURL should be a full address starting with https://.');
  }
  if (!thankYou.redirectURL && !thankYou.title && !thankYou.message) {
    notes.push('No thank-you text: the page shows the default Spanish text "¡Gracias!". Set thankYou.title and thankYou.message.');
  }
  const notify = (form.submissions && form.submissions.notifyOnSubmit) || [];
  if (notify.length) notes.push(`${notify.length} user(s) get an email for every submission.`);
  if (form.assignmentGroup) notes.push(`New records go to user group ${form.assignmentGroup}.`);
  if (!(form.submissions && form.submissions.persist)) notes.push('Submissions are not stored (submissions.persist is false); a failed one leaves no trace.');
  if (form.uploads && typeof form.uploads.maxFileSizeMB === 'number' && form.uploads.maxFileSizeMB > 5) {
    warnings.push('uploads.maxFileSizeMB above 5 has no effect: public uploads are capped at 5 MB.');
  }
  if (form.active === false) {
    warnings.push('The form is inactive: every public link answers 404.');
    submittable = { ok: false, reason: 'inactive' };
  }
  return { errors, warnings, notes, mappings: fed, submittable };
}

function readJsonArg(arg, rootDir, what) {
  let text = String(arg);
  if (!/^\s*[{[]/.test(text)) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the ${what} file ${arg}.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`The ${what} is not valid JSON.`);
  }
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

async function loadForm(client, idOrCode) {
  if (!idOrCode || !/^[A-Za-z0-9_-]+$/.test(String(idOrCode))) throw new UsageError('Give the form _id or its formCode (FRM-…).');
  try {
    return await call(client, 'GET', `/v2/form/${encodeURIComponent(idOrCode)}`);
  } catch (err) {
    if (err.status === 404) throw new Blocked(`No form "${idOrCode}" on this account.`);
    throw err;
  }
}

async function loadModels(client, mappings) {
  const models = {};
  for (const m of Array.isArray(mappings) ? mappings : []) {
    const name = m && m.modelName;
    if (!name || name in models) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) { models[name] = null; continue; }
    try {
      models[name] = modelFieldMap(await call(client, 'GET', `/v2/form/getmodelfields/${encodeURIComponent(name)}`));
    } catch (err) {
      if (err.status === 404) models[name] = null;
      else throw err;
    }
  }
  return models;
}

// true / false / null (could not tell, e.g. the user may not read service credentials).
async function captchaCredentialExists(client) {
  const query = new URLSearchParams({
    xquery: JSON.stringify({ providerType: 'cloudflare', active: true }), select: '_id', limit: '1',
  });
  const res = await client.request('GET', `/v2/servicecredential?${query}`);
  if (!res.ok) return null;
  const rows = Array.isArray(res.body) ? res.body : (res.body && res.body.data) || [];
  return rows.length > 0;
}

// For a saved, active form the public schema route says exactly what the page will get.
async function captchaReadyFor(client, form) {
  const access = form.access || {};
  if (access.mode !== 'public' || access.enableCaptcha === false) return null;
  if (form._id && form.active !== false) {
    const res = await client.request('GET', `/v2/form/jsonschema/${form._id}`);
    if (res.ok && res.body && typeof res.body === 'object') return Boolean(res.body.turnstileSiteKey);
  }
  return captchaCredentialExists(client);
}

async function analyze(client, form) {
  const models = await loadModels(client, form.mappings);
  const captchaReady = await captchaReadyFor(client, form);
  return checkForm(form, models, { captchaReady });
}

// The server drops keys set to null inside Mixed fields, so they do not count as a difference.
function sameJson(a, b) {
  const text = (v) => JSON.stringify(v === undefined ? null : v, (key, value) => (value === null && key ? undefined : value));
  return text(a) === text(b);
}

function normalizeMappings(list) {
  return (list || []).map((m) => ({ ...m, action: m.action || 'create' }));
}

function readBackProblems(sent, saved) {
  const problems = [];
  if ('formName' in sent && saved.formName !== sent.formName) problems.push('formName did not save.');
  if ('formSchema' in sent && !sameJson(sent.formSchema, saved.formSchema)) problems.push('formSchema came back different.');
  if ('mappings' in sent && !sameJson(normalizeMappings(sent.mappings), normalizeMappings(saved.mappings))) {
    problems.push('mappings came back different.');
  }
  if (sent.access && 'mode' in sent.access && (saved.access || {}).mode !== sent.access.mode) problems.push('access.mode did not save.');
  if ('active' in sent && (saved.active !== false) !== (sent.active !== false)) problems.push('active did not save.');
  return problems;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(client, [name]) {
  const xquery = { type: { $ne: 'meta' } };
  if (name && String(name).trim()) {
    // Case-insensitive goes inline as (?i): the API rejects a separate $options.
    xquery.formName = { $regex: `(?i)${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  }
  const query = new URLSearchParams({
    xquery: JSON.stringify(xquery),
    select: 'formName formCode active access.mode access.enableCaptcha mappings.modelName submissions.persist updatedAt',
    sort: '-updatedAt',
    limit: '20',
  });
  const body = await call(client, 'GET', `/v2/form?${query}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  return {
    forms: rows.map((f) => ({
      _id: f._id,
      formCode: f.formCode,
      formName: f.formName,
      active: f.active !== false,
      access: accessSummary(f.access),
      creates: (f.mappings || []).map((m) => m.modelName),
      storesSubmissions: Boolean(f.submissions && f.submissions.persist),
      updatedAt: f.updatedAt,
    })),
  };
}

async function cmdShow(client, [idOrCode]) {
  const form = await loadForm(client, idOrCode);
  const check = await analyze(client, form);
  let recent;
  if (form.submissions && form.submissions.persist) {
    recent = (await cmdSubmissions(client, [form._id], { limit: 5 })).submissions;
  }
  return {
    form: formSummary(client.domain, form),
    formVersion: form.updatedAt,
    ...check,
    ...(form.type === 'meta' ? { note: 'A Meta Lead Ads mirror: it is never served publicly and is changed from the Ad Hub.' } : {}),
    ...(recent ? { recentSubmissions: recent } : {}),
  };
}

async function cmdFields(client, [modelName]) {
  if (!modelName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(modelName)) throw new UsageError('Usage: form.js fields <domain> <Object>');
  const models = await loadModels(client, [{ modelName }]);
  if (!models[modelName]) throw new Blocked(`"${modelName}" is not an object of this account. Object names are singular, like Contact.`);
  const rows = [];
  for (const [path, f] of models[modelName]) {
    if (TECHNICAL.has(path.split('.')[0])) continue;
    rows.push({
      path,
      type: f.type,
      ...(f.required ? { required: true } : {}),
      ...(Array.isArray(f.enum) && f.enum.length ? { options: f.enum.length > 25 ? [...f.enum.slice(0, 25), `…${f.enum.length - 25} more`] : f.enum } : {}),
      ...(f.ref ? { ref: f.ref } : {}),
      ...(f.ref && f.type === 'string' ? { list: true } : {}),
      ...(f.isCustomField ? { customField: true } : {}),
    });
  }
  return { modelName, required: rows.filter((r) => r.required).map((r) => r.path), fields: rows };
}

async function cmdPreview(client, [defArg], flags, ctx) {
  if (!defArg) throw new UsageError("Usage: form.js preview <domain> '<form json>' [--form <formId>]");
  const changes = normalizeDefinition(readJsonArg(defArg, ctx.rootDir, 'form'), { forCreate: !flags.form });
  let stored = null;
  if (flags.form) stored = await loadForm(client, flags.form);
  if (stored && stored.type === 'meta') throw new Blocked('This is a Meta Lead Ads mirror; change it from the Ad Hub.');
  const form = stored ? mergeForm(stored, changes) : { active: true, ...changes };
  const check = await analyze(client, form);
  const result = {
    form: formSummary(client.domain, form),
    ...(stored ? { formVersion: stored.updatedAt, changes: Object.keys(changes) } : {}),
    ...check,
  };
  if (stored && 'formSchema' in changes && !('mappings' in changes)) {
    const { fields } = flattenFields(form.formSchema);
    const stale = [];
    for (const m of form.mappings || []) for (const key of Object.keys(m.fieldMap || {})) if (!(key in fields)) stale.push(key);
    if (stale.length) result.hint = `Send "mappings" too, without ${stale.join(', ')}: the saved mappings still use them.`;
  }
  result.nextStep = check.errors.length
    ? 'Fix the errors first; nothing can be saved like this.'
    : `Show this to the user. Only after an explicit yes, run ${stored ? `update with --form-version ${stored.updatedAt}` : 'create'} with the same JSON and --confirmed.`;
  return result;
}

async function cmdCreate(client, [defArg], flags, ctx) {
  if (!defArg) throw new UsageError("Usage: form.js create <domain> '<form json>' --confirmed");
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and wait for a yes.');
  const def = normalizeDefinition(readJsonArg(defArg, ctx.rootDir, 'form'), { forCreate: true });
  const check = await analyze(client, { active: true, ...def });
  if (check.errors.length) throw new Blocked(`Not saved: ${check.errors.join(' ')}`);
  const created = await call(client, 'POST', '/v2/form', { data: def, confirmed: true });
  const id = created && (created._id || (created.data && created.data._id));
  if (!id) throw new Error('The server did not return the new form id.');
  const saved = await loadForm(client, id);
  const after = await analyze(client, saved);
  const problems = readBackProblems(def, saved);
  return {
    saved: problems.length === 0,
    form: formSummary(client.domain, saved),
    formVersion: saved.updatedAt,
    warnings: after.warnings,
    notes: after.notes,
    submittable: after.submittable,
    problems,
  };
}

async function cmdUpdate(client, [id, defArg], flags, ctx) {
  if (!id || !defArg) throw new UsageError("Usage: form.js update <domain> <formId> '<changes json>' --form-version <v> --confirmed");
  if (!flags.formVersion) throw new UsageError('Missing --form-version. Run preview with --form first and pass its formVersion.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and wait for a yes.');
  const changes = normalizeDefinition(readJsonArg(defArg, ctx.rootDir, 'changes'), { forCreate: false });
  if (!Object.keys(changes).length) throw new UsageError('The changes are empty.');
  const stored = await loadForm(client, id);
  if (stored.type === 'meta') throw new Blocked('This is a Meta Lead Ads mirror; change it from the Ad Hub.');
  if (stored.updatedAt !== flags.formVersion) throw new Blocked('The form changed since the preview. Run preview again and show the user.');
  const merged = mergeForm(stored, changes);
  const check = await analyze(client, merged);
  if (check.errors.length) throw new Blocked(`Not saved: ${check.errors.join(' ')}`);
  // Sub-objects go whole (merged), so the result does not depend on how the server merges them.
  const body = {};
  for (const key of Object.keys(changes)) body[key] = MERGED_KEYS.has(key) ? merged[key] : changes[key];
  await call(client, 'PATCH', `/v2/form/${stored._id}`, { data: body, confirmed: true });
  const saved = await loadForm(client, stored._id);
  const after = await analyze(client, saved);
  const problems = readBackProblems(body, saved);
  return {
    saved: problems.length === 0,
    form: formSummary(client.domain, saved),
    formVersion: saved.updatedAt,
    warnings: after.warnings,
    notes: after.notes,
    submittable: after.submittable,
    problems,
  };
}

function explainFailure(result, mapping) {
  const error = String(result.error || '');
  if (error === 'Duplicated value') {
    return `A ${mapping.modelName} with that value (for a Contact, the email) already exists. No new record was made; `
      + 'the existing one got a note with the answers, and its owner may be notified.';
  }
  if (/required/i.test(error)) return `${mapping.modelName} is missing a required field: map it or add a default.`;
  if (/invalid|cast|enum/i.test(error)) return 'A value does not fit the field (format, type or allowed values).';
  return null;
}

async function cmdSubmitTest(client, [id, dataArg], flags, ctx) {
  if (!id || !dataArg) throw new UsageError("Usage: form.js submit-test <domain> <formId> '<data json>' --confirmed");
  if (!flags.confirmed) {
    throw new UsageError('Refusing to submit without --confirmed: a submission creates real records. Ask the user first.');
  }
  const data = readJsonArg(dataArg, ctx.rootDir, 'data');
  if (!isPlainObject(data)) throw new UsageError('The data must be a JSON object of form field key → value.');
  const form = await loadForm(client, id);
  if (form.type === 'meta') throw new Blocked('Meta Lead Ads forms are not submitted here.');
  if (form.active === false) throw new Blocked('The form is inactive; the server answers 404. Activate it first.');
  const access = form.access || {};
  const mode = access.mode || '';
  if ((mode === 'public' || !mode) && access.enableCaptcha !== false) {
    throw new Blocked('This form needs a captcha token, which only the hosted page can get. Ask the user to open '
      + `${links(client.domain, form).view} and send it by hand, then run "submissions" or search the created record.`);
  }
  const { fields } = flattenFields(form.formSchema);
  const missing = Object.entries(fields)
    .filter(([key, def]) => def.required && (data[key] === undefined || data[key] === null || data[key] === ''))
    .map(([key]) => key);
  if (missing.length) throw new UsageError(`The data lacks required fields: ${missing.join(', ')}.`);
  const unknown = Object.keys(data).filter((key) => Object.keys(fields).length && !(key in fields));

  const body = { id: form._id, data };
  if (mode === 'password') body.password = access.password;
  let response;
  try {
    response = await call(client, 'PUT', '/v2/form/register', { data: body, confirmed: true });
  } catch (err) {
    if (err.status === 429) throw new Blocked('Too many submissions right now (429). Wait a minute.');
    throw err;
  }
  // One result per mapping, in order; the server skips a mapping whose object no longer exists.
  const results = ((response && response.results) || []).filter((r) => r && r.modelName);
  const pending = [...(form.mappings || [])];
  const records = [];
  for (const result of results) {
    const at = pending.findIndex((m) => m && m.modelName === result.modelName);
    const mapping = at === -1 ? { modelName: result.modelName, fieldMap: {} } : pending.splice(at, 1)[0];
    if (result.status !== 'success' || !result.recordId) {
      records.push({ modelName: result.modelName, status: result.status, error: result.error, explanation: explainFailure(result, mapping) });
      continue;
    }
    const paths = [...new Set([...Object.values(mapping.fieldMap || {}), ...Object.keys(mapping.defaults || {})])];
    const query = new URLSearchParams({ select: paths.map((p) => p.split('.')[0]).join(' ') || '_id' });
    const record = await call(client, 'GET', `/v2/${result.modelName.toLowerCase()}/${result.recordId}?${query}`);
    const empty = [];
    const stored = {};
    for (const [key, path] of Object.entries(mapping.fieldMap || {})) {
      const value = path.split('.').reduce((node, part) => (node == null ? undefined : node[part]), record);
      stored[path] = value === undefined ? null : value;
      if (data[key] !== undefined && data[key] !== '' && (value === undefined || value === null || value === '')) empty.push(path);
    }
    records.push({ modelName: result.modelName, status: 'success', recordId: result.recordId, stored, ...(empty.length ? { cameBackEmpty: empty } : {}) });
  }
  let submission;
  if (form.submissions && form.submissions.persist) {
    submission = (await cmdSubmissions(client, [form._id], { limit: 1 })).submissions[0] || null;
  }
  return {
    sent: { formId: form._id, data, as: 'the profile user (a real visitor is anonymous, so createdBy differs)' },
    ok: results.length > 0 && results.every((r) => r.status === 'success'),
    records,
    redirectURL: (response && response.redirectURL) || null,
    ...(unknown.length ? { notInForm: unknown } : {}),
    ...(submission !== undefined ? { storedSubmission: submission } : {}),
  };
}

async function cmdSubmissions(client, [id], flags = {}) {
  if (!id || !ID_RE.test(String(id))) throw new UsageError('Usage: form.js submissions <domain> <formId> [--limit <n>]');
  const query = new URLSearchParams({
    xquery: JSON.stringify({ form: id }),
    select: 'status mappingResults source submittedBy data createdAt',
    sort: '-createdAt',
    limit: String(flags.limit || 10),
  });
  const body = await call(client, 'GET', `/v2/formsubmission?${query}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  return {
    total: (body.pagination && body.pagination.count) || rows.length,
    submissions: rows.map((s) => ({
      _id: s._id,
      createdAt: s.createdAt,
      status: s.status,
      results: s.mappingResults || [],
      data: s.data,
      ...(s.submittedBy ? { submittedBy: s.submittedBy } : {}),
    })),
    note: 'Only stored when the form has submissions.persist on.',
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
    else if (arg === '--form') flags.form = next();
    else if (arg === '--form-version') flags.formVersion = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 10, 1), 50);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  list: cmdList,
  show: cmdShow,
  fields: cmdFields,
  preview: cmdPreview,
  create: cmdCreate,
  update: cmdUpdate,
  'submit-test': cmdSubmitTest,
  submissions: cmdSubmissions,
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
    if (!handler || !domain) {
      throw new UsageError(`Usage: form.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if ((command === 'create' || command === 'update') && !result.saved) return 1;
    if (command === 'preview' && result.errors.length) return BLOCKED;
    if (command === 'submit-test' && !result.ok) return 1;
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
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, checkForm, flattenFields, mergeForm, normalizeDefinition, valueType, formSummary,
};
