#!/usr/bin/env node
'use strict';

// Imports contacts, companies or deals from a CSV/Excel file the way the Prolibu app does:
// through the account's importer (PUT /v2/service/importdata), without duplicates.
//
//   imports.js inspect <domain> <object> <file> [--sheet <name>] [--header-row <n>]
//   imports.js preview <domain> '<plan json>'                    writes nothing; returns a version
//   imports.js apply   <domain> '<plan json>' --version <v> --confirmed [--chunk <n>]
//   imports.js export  <domain> '<plan json>' --version <v>      JSON file for the app's Import (big files)
//   imports.js jobs    <domain> [--limit <n>]                    imports run from the app
//   imports.js job     <domain> <jobId>                          one of them, with its row errors
//
// <object> is contact, company or deal. The plan is inline JSON, or a JSON file in a temp folder:
//   { "object": "contact", "file": "/path/contacts.xlsx", "sheet": "Sheet1",
//     "mapping": { "Correo": "email", "Nombre": "firstName", "Notas": null },
//     "match": "email", "existing": "skip" | "update", "updateFields": ["address.city"], "missing": "create" | "skip",
//     "defaults": { "source": "Fair 2026" }, "timeZone": "America/Bogota", "dateOrder": "DMY" }
// Every command accepts --profile <name>. Output is JSON.
// Exit codes: 0 ok, 1 API error or rows not saved, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const moment = require('moment-timezone');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
const { readTable, tableFromRows, serialToText, SheetError } = require('./sheet');
const refs = require('../../prolibu-external-refs/scripts/refs');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ROWS = 5000;
const MAX_APPLY_ROWS = 300;
const DEFAULT_CHUNK = 20;
const MAX_CHUNK = 50;
const SHOW_ROWS = 60;

const OBJECTS = {
  contact: {
    model: 'Contact', matchKeys: ['email', 'refId', '_id'], defaultMatch: 'email', labelKeys: ['email', 'firstName', 'lastName'],
  },
  company: {
    model: 'Company', matchKeys: ['companyName', 'identification.docId', 'companyCode', 'refId', '_id'], defaultMatch: 'companyName', labelKeys: ['companyName', 'companyCode'],
  },
  deal: {
    model: 'Deal', matchKeys: ['refId', 'dealCode', 'dealName', '_id'], defaultMatch: 'dealName', labelKeys: ['dealName', 'dealCode'],
  },
};

// Fields the platform computes, or that belong to another skill (quote, files, scoring…).
const NOT_IMPORTABLE = new Set([
  'proposal', 'proposalVersions', 'proposalWizard', 'pipelineStages', 'scoreDetail', 'signals', 'tracking',
  'protocolRun', 'submissions', 'emailStatus', 'consent', 'firstContact', 'adCampaignMeta', 'allowEveryone',
  'indented', 'lost', 'denied', 'meta', 'searchText', 'phonesText', 'otherEmailsText', 'thumbnail',
  'profilePicture', 'brand', 'invoices', 'contracts', 'pinnedBy', 'isAccountOwner', 'stageMovedMethod',
  'termsAndConditionsAcceptedAt', 'termsAndConditionsEvidence', 'otherEmails', 'phones',
]);
const SYSTEM = new Set(['_id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', '__v']);
const EMAIL_FIELDS = new Set(['email', 'primaryEmail']);

const SYNONYMS = {
  contact: {
    email: ['email', 'correo', 'correoelectronico', 'mail', 'emailaddress', 'correoe'],
    firstName: ['nombre', 'nombres', 'firstname', 'primernombre', 'name'],
    lastName: ['apellido', 'apellidos', 'lastname', 'surname'],
    mobile: ['celular', 'movil', 'mobile', 'telefono', 'telefonomovil', 'phone', 'cel', 'tel'],
    whatsapp: ['whatsapp'],
    jobTitle: ['cargo', 'puesto', 'jobtitle', 'titulo', 'title'],
    company: ['empresa', 'compania', 'company', 'organizacion', 'cuenta'],
    website: ['web', 'sitioweb', 'website', 'paginaweb'],
    'address.street': ['direccion', 'address', 'street', 'calle'],
    'address.city': ['ciudad', 'city'],
    'address.state': ['estado', 'departamento', 'provincia', 'state', 'region'],
    'address.country': ['pais', 'country'],
    'address.postalCode': ['codigopostal', 'cp', 'zip', 'postalcode'],
    'identification.docId': ['documento', 'cedula', 'dni', 'docid', 'identificacion', 'rut', 'cuit', 'curp'],
    source: ['origen', 'fuente', 'source'],
    numberOfEmployees: ['empleados', 'numeroempleados', 'employees', 'numerodeempleados'],
    clientSince: ['clientedesde', 'clientsince', 'fechacliente'],
    refId: ['idexterno', 'externalid', 'refid', 'idcrm', 'iderp', 'id'],
  },
  company: {
    companyName: ['empresa', 'nombre', 'company', 'companyname', 'nombreempresa', 'compania', 'cuenta'],
    legalName: ['razonsocial', 'legalname'],
    'identification.docId': ['nit', 'rfc', 'rut', 'cuit', 'taxid', 'documento', 'identificacion', 'ruc', 'cnpj'],
    primaryEmail: ['email', 'correo', 'correoelectronico'],
    primaryPhone: ['telefono', 'phone', 'tel'],
    website: ['web', 'sitioweb', 'website', 'paginaweb'],
    'address.street': ['direccion', 'address', 'street', 'calle'],
    'address.city': ['ciudad', 'city'],
    'address.state': ['estado', 'departamento', 'provincia', 'state', 'region'],
    'address.country': ['pais', 'country'],
    numberOfEmployees: ['empleados', 'numeroempleados', 'employees', 'numerodeempleados'],
    refId: ['idexterno', 'externalid', 'refid', 'idcrm', 'iderp', 'id'],
  },
  deal: {
    dealName: ['negocio', 'nombre', 'oportunidad', 'deal', 'dealname', 'nombrenegocio', 'titulo'],
    contact: ['contacto', 'emailcontacto', 'correocontacto', 'contact', 'email', 'correo'],
    closeDate: ['fechacierre', 'fechadecierre', 'closedate', 'cierre', 'fechaestimadadecierre'],
    stage: ['etapa', 'stage', 'fase'],
    source: ['origen', 'fuente', 'source'],
    observations: ['observaciones', 'notas', 'comentarios', 'notes'],
    refId: ['idexterno', 'externalid', 'refid', 'idcrm', 'iderp', 'id'],
  },
};
const DEAL_VALUE_WORDS = ['valor', 'monto', 'importe', 'amount', 'value', 'precio', 'total'];

class Blocked extends Error {}

// ─── Small helpers ─────────────────────────────────────────────────────────────

function fold(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameKey(text) {
  return String(text).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive, whole value, any run of spaces: "Acme  SAS" finds "ACME SAS".
function nameRegex(text) {
  return `(?i)^\\s*${nameKey(text).split(' ').map(escapeRegex).join('\\s+')}\\s*$`;
}

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, p, value) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function idOf(value) {
  if (value && typeof value === 'object') return value._id ? String(value._id) : null;
  return value === undefined || value === null ? null : String(value);
}

function tempDir() {
  const dir = path.join(process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), 'prolibu-imports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeReport(name, rows) {
  const header = ['row', 'result', 'key', 'recordId', 'details'];
  const lines = [header.join(',')].concat(rows.map((r) => [r.row, r.result, r.key, r.recordId, r.details].map(csvCell).join(',')));
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, `\uFEFF${lines.join('\r\n')}\r\n`);
  return file;
}

async function call(client, method, p, opts) {
  const res = await client.request(method, p, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${p.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function listRows(body) {
  if (Array.isArray(body)) return body;
  return body && Array.isArray(body.data) ? body.data : [];
}

async function list(client, object, xquery, select, limit = 500) {
  const q = new URLSearchParams({ xquery: JSON.stringify(xquery), limit: String(limit) });
  if (select) q.set('select', select);
  return listRows(await call(client, 'GET', `/v2/${object}?${q}`));
}

// ─── Schema ────────────────────────────────────────────────────────────────────

function isLeaf(def) {
  return def && (typeof def.type === 'string' || Array.isArray(def.type));
}

function leafFields(schema, prefix = '') {
  const out = [];
  for (const [key, def] of Object.entries(schema || {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!def || typeof def !== 'object') continue;
    if (isLeaf(def)) out.push({ path: p, def });
    else out.push(...leafFields(def, p));
  }
  return out;
}

function fieldKind(p, def) {
  if (p === 'refId') return 'refId';
  if (p === 'refUrl') return 'refUrl';
  const t = def.type;
  if (Array.isArray(t)) {
    const inner = String(t[0]).toLowerCase();
    if (inner === 'objectid') return 'refList';
    if (inner === 'string') return 'stringList';
    return null;
  }
  const type = String(t).toLowerCase();
  if (type === 'objectid') return 'ref';
  if (['string', 'number', 'boolean', 'date'].includes(type)) return type;
  return null;
}

// The fields a file may fill, with what the script needs to convert and check them.
function importableFields(schema) {
  const fields = {};
  for (const { path: p, def } of leafFields(schema)) {
    const top = p.split('.')[0];
    if (SYSTEM.has(p) || NOT_IMPORTABLE.has(top) || def.avoid === 'always') continue;
    const kind = fieldKind(p, def);
    if (!kind) continue;
    fields[p] = {
      kind,
      ref: def.ref || null,
      enum: Array.isArray(def.enum) ? def.enum : null,
      required: Boolean(def.required) && !(def.primaryKey && def.hidden),
    };
  }
  return fields;
}

async function loadContext(client) {
  const me = await call(client, 'GET', '/v2/user/me');
  let prefs = {};
  try {
    prefs = await call(client, 'GET', '/v2/user/preferences');
  } catch {
    prefs = {};
  }
  return { me, prefs };
}

function schemaFor(ctx, model) {
  const schema = ctx.me && ctx.me.modelSchemas && ctx.me.modelSchemas[model];
  if (!schema) throw new Blocked(`${model} is not available on this account, or this user cannot see it.`);
  return schema;
}

// ─── Plan ──────────────────────────────────────────────────────────────────────

function checkObject(object) {
  if (!OBJECTS[object]) {
    throw new UsageError('This skill imports contact, company or deal records. For other objects use the app\'s Import '
      + '(its Excel template), or the prolibu-platform-map skill for a few records.');
  }
  return object;
}

function checkSourceFile(file, rootDir) {
  const resolved = path.resolve(String(file || ''));
  const accounts = path.resolve(rootDir, 'accounts');
  if (resolved === accounts || resolved.startsWith(`${accounts}${path.sep}`)) {
    throw new UsageError('Refusing to read that file: nothing under accounts/ (where the API keys live) is imported.');
  }
  return resolved;
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
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  checkObject(plan.object);
  if (Boolean(plan.file) === Boolean(plan.rows)) throw new UsageError('The plan needs "file" (a .csv or .xlsx path) or "rows" (a list), not both.');
  if (plan.rows && (!Array.isArray(plan.rows) || !plan.rows.length)) throw new UsageError('"rows" must be a non-empty list of objects.');
  if (!plan.mapping || typeof plan.mapping !== 'object' || Array.isArray(plan.mapping)) {
    throw new UsageError('The plan needs "mapping": { "<column>": "<field>" | null }. Run inspect for a suggestion.');
  }
  const conf = OBJECTS[plan.object];
  plan.match = plan.match || conf.defaultMatch;
  if (!conf.matchKeys.includes(plan.match)) {
    throw new UsageError(`"match" for ${plan.object} must be one of: ${conf.matchKeys.join(', ')}.`);
  }
  plan.existing = plan.existing || 'skip';
  plan.missing = plan.missing || 'create';
  if (!['skip', 'update'].includes(plan.existing)) throw new UsageError('"existing" must be "skip" or "update".');
  if (!['create', 'skip'].includes(plan.missing)) throw new UsageError('"missing" must be "create" or "skip".');
  if (plan.match === '_id' && plan.missing === 'create') {
    throw new UsageError('With "match": "_id" the rows point at existing records: set "missing": "skip".');
  }
  if (plan.dateOrder && !['DMY', 'MDY'].includes(plan.dateOrder)) throw new UsageError('"dateOrder" must be "DMY" or "MDY".');
  if (plan.decimalSeparator && !['.', ','].includes(plan.decimalSeparator)) throw new UsageError('"decimalSeparator" must be "." or ",".');
  if (plan.timeZone && !moment.tz.zone(plan.timeZone)) throw new UsageError(`Unknown time zone "${plan.timeZone}". Use an IANA name such as America/Bogota.`);
  if (plan.defaults && (typeof plan.defaults !== 'object' || Array.isArray(plan.defaults))) throw new UsageError('"defaults" must be an object of field → value.');
  if (plan.updateFields !== undefined) {
    if (!Array.isArray(plan.updateFields) || !plan.updateFields.length) throw new UsageError('"updateFields" must be a non-empty list of fields.');
    if (plan.existing !== 'update') throw new UsageError('"updateFields" only applies with "existing": "update".');
  }
  if (plan.file) plan.file = checkSourceFile(plan.file, rootDir);
  return plan;
}

function loadTable(plan) {
  try {
    const table = plan.rows ? tableFromRows(plan.rows) : readTable(plan.file, { sheet: plan.sheet, headerRow: plan.headerRow });
    if (table.rows.length > MAX_ROWS) throw new UsageError(`The file has ${table.rows.length} rows; the limit is ${MAX_ROWS}. Split it.`);
    return table;
  } catch (err) {
    if (err instanceof SheetError) throw new UsageError(err.message);
    throw err;
  }
}

function checkMapping(plan, table, fields, schema) {
  const known = new Set(leafFields(schema).map((f) => f.path));
  const used = new Map();
  const mapped = {};
  for (const [column, field] of Object.entries(plan.mapping)) {
    if (!table.headers.includes(column)) {
      throw new UsageError(`The mapping names a column the file does not have: "${column}". Columns: ${table.headers.join(', ')}.`);
    }
    if (field === null || field === '') continue;
    if (typeof field !== 'string') throw new UsageError(`Map "${column}" to a field name (text) or null.`);
    if (field !== '_id' && !fields[field]) {
      const top = field.split('.')[0];
      const why = known.has(field) || NOT_IMPORTABLE.has(top) || SYSTEM.has(field)
        ? 'it is set by the platform, belongs to another skill, or is a list of objects this script cannot fill'
        : 'it is not a field of this object (check the spelling with inspect)';
      throw new UsageError(`"${column}" cannot go to "${field}": ${why}.`);
    }
    if (used.has(field)) throw new UsageError(`"${used.get(field)}" and "${column}" both go to "${field}". Map only one.`);
    used.set(field, column);
    mapped[field] = column;
  }
  for (const field of plan.updateFields || []) {
    if (!mapped[field]) throw new UsageError(`"updateFields" names "${field}", but no column is mapped to it.`);
  }
  for (const field of Object.keys(plan.defaults || {})) {
    if (!fields[field] || field === '_id') throw new UsageError(`"defaults" names "${field}", which is not an importable field.`);
  }
  if (plan.match !== '_id' && !mapped[plan.match]) {
    throw new UsageError(`The rows are matched by "${plan.match}", but no column is mapped to it.`);
  }
  if (plan.match === '_id' && !mapped._id) throw new UsageError('"match" is "_id": map the column that holds the record ids to "_id".');
  const ignored = table.headers.filter((h) => !Object.values(mapped).includes(h));
  return { mapped, ignored };
}

// ─── Values ────────────────────────────────────────────────────────────────────

function parseNumber(value, decimalSep, explicit) {
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : { error: 'not a number' };
  let text = String(value).replace(/[\s$€£%]/g, '');
  if (!/^-?[\d.,]+$/.test(text)) return { error: `"${value}" is not a number` };
  const hasDot = text.includes('.');
  const hasComma = text.includes(',');
  if (hasDot && hasComma) {
    const dec = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    text = text.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const grouped = new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(text);
    // "1.200" is 1200 in Colombia and 1.2 in Mexico: only the user knows.
    if (grouped && !explicit) return { error: `"${value}" could be thousands or decimals`, ambiguousNumber: true };
    text = grouped && sep !== decimalSep ? text.split(sep).join('') : text.replace(sep, '.');
  }
  const n = Number(text);
  return Number.isFinite(n) ? { value: n } : { error: `"${value}" is not a number` };
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return { value };
  const t = fold(value);
  if (['true', 'verdadero', 'si', 'yes', 'y', '1', 'x'].includes(t)) return { value: true };
  if (['false', 'falso', 'no', 'n', '0'].includes(t)) return { value: false };
  return { error: `"${value}" is not yes/no` };
}

// Dates are read in the account's time zone, like the app's Excel import does.
function parseDate(value, opts) {
  let text = value;
  if (typeof value === 'number') {
    if (value <= 0 || value > 200000) return { error: `"${value}" is not a date` };
    text = serialToText(value, false);
  }
  text = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const m = moment.parseZone(text, moment.ISO_8601, true);
    return m.isValid() ? { value: m.toISOString() } : { error: `"${value}" is not a valid date` };
  }
  let iso = null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) iso = { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6] };
  m = m ? null : /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let order = opts.dateOrder;
    if (!order && a > 12) order = 'DMY';
    if (!order && b > 12) order = 'MDY';
    if (!order) return { error: `"${value}" could be day/month or month/day`, ambiguousDate: true };
    const [d, mo] = order === 'DMY' ? [m[1], m[2]] : [m[2], m[1]];
    iso = { y: m[3], mo, d, h: m[4], mi: m[5], s: m[6] };
  }
  if (!iso) return { error: `"${value}" is not a date (use YYYY-MM-DD)` };
  if (!opts.timeZone) return { error: 'no time zone', needsZone: true };
  const local = `${iso.y}-${String(iso.mo).padStart(2, '0')}-${String(iso.d).padStart(2, '0')} ${String(iso.h || 0).padStart(2, '0')}:${iso.mi || '00'}:${iso.s || '00'}`;
  const parsed = moment.tz(local, 'YYYY-MM-DD HH:mm:ss', true, opts.timeZone);
  return parsed.isValid() ? { value: parsed.toISOString() } : { error: `"${value}" is not a valid date` };
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(/[,;|]/).map((v) => v.trim()).filter(Boolean);
}

function textOf(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return String(value).trim();
}

// Converts one cell to what the API stores. Returns { value } or { error }.
function convert(field, info, raw, opts) {
  switch (info.kind) {
    case 'refId': {
      const text = textOf(raw);
      try {
        refs.checkRefId(text);
      } catch (err) {
        return { error: err.message };
      }
      return { value: text };
    }
    case 'refUrl': {
      try {
        return { value: refs.checkRefUrl(textOf(raw)) };
      } catch (err) {
        return { error: err.message };
      }
    }
    case 'string': {
      let text = textOf(raw);
      if (EMAIL_FIELDS.has(field)) {
        text = text.toLowerCase();
        if (!EMAIL_RE.test(text)) return { error: `"${raw}" is not a valid email` };
      }
      if (info.enum) {
        const hit = info.enum.find((e) => fold(e) === fold(text));
        if (!hit) return { error: `"${raw}" is not one of: ${info.enum.join(', ')}` };
        text = hit;
      }
      return { value: text };
    }
    case 'number': return parseNumber(raw, opts.decimalSep, opts.decimalExplicit);
    case 'boolean': return parseBoolean(raw);
    case 'date': return parseDate(raw, opts);
    case 'stringList': return { value: splitList(raw) };
    case 'ref': return { value: textOf(raw), unresolved: true };
    case 'refList': return { value: splitList(raw), unresolved: true };
    default: return { error: 'this kind of field cannot be imported' };
  }
}

function normalizeKey(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (field === 'email' || field === '_id') return String(value).trim().toLowerCase();
  if (field === 'companyName' || field === 'dealName') return nameKey(value);
  return textOf(value);
}

// ─── References ────────────────────────────────────────────────────────────────

// Values the script turns into _id before sending: a contact's company (name, code or _id),
// a deal's contact (email or _id) and stage fields (name, code or _id of that pipeline).
async function resolveRefs(client, ctx, model, rowsData, fields) {
  const resolvers = {};
  const notes = [];
  const wanted = (field) => [...new Set(rowsData.map((r) => r.values[field]).filter((v) => v !== undefined).map(String))];

  for (const [field, info] of Object.entries(fields)) {
    if (info.kind !== 'ref' || !rowsData.some((r) => r.values[field] !== undefined)) continue;
    const values = wanted(field);
    if (info.ref === 'Company') {
      const ids = values.filter((v) => ID_RE.test(v));
      const others = values.filter((v) => !ID_RE.test(v));
      const found = [];
      for (const part of chunks(ids, 100)) found.push(...await list(client, 'company', { _id: { $in: part } }, 'companyName companyCode'));
      for (const part of chunks(others, 100)) found.push(...await list(client, 'company', { companyCode: { $in: part } }, 'companyName companyCode'));
      for (const part of chunks(others, 25)) {
        found.push(...await list(client, 'company', { $or: part.map((n) => ({ companyName: { $regex: nameRegex(n) } })) }, 'companyName companyCode'));
      }
      resolvers[field] = (value) => {
        const v = String(value);
        const hits = [...new Map(found.filter((c) => c._id === v || c.companyCode === v || nameKey(c.companyName || '') === nameKey(v)).map((c) => [c._id, c])).values()];
        if (hits.length === 1) return { value: hits[0]._id };
        if (hits.length > 1) return { error: `${hits.length} companies are called "${v}" (${hits.map((h) => h.companyCode).join(', ')}): use the company code` };
        return { error: `no company "${v}" in the account: import the companies first, or map this column to companyName (text only)` };
      };
    } else if (info.ref === 'Contact') {
      const ids = values.filter((v) => ID_RE.test(v));
      const emails = values.filter((v) => !ID_RE.test(v)).map((v) => v.trim().toLowerCase());
      const found = [];
      for (const part of chunks(ids, 100)) found.push(...await list(client, 'contact', { _id: { $in: part } }, 'email firstName lastName'));
      for (const part of chunks(emails, 100)) found.push(...await list(client, 'contact', { email: { $in: part } }, 'email firstName lastName'));
      resolvers[field] = (value) => {
        const v = String(value).trim();
        const hits = found.filter((c) => c._id === v || (c.email || '') === v.toLowerCase());
        if (hits.length === 1) return { value: hits[0]._id };
        if (hits.length > 1) return { error: `${hits.length} contacts have the email "${v}" (one per workspace): use the contact's _id` };
        return { error: `no contact with email "${v}" in the account: import the contacts first` };
      };
    } else if (info.ref === 'Stage') {
      const stageType = `${model}.${field}`;
      const stages = await list(client, 'stage', { stageType }, 'stageName stageCode active index endFlowStage', 200);
      const active = stages.filter((s) => s.active !== false);
      resolvers[field] = (value) => {
        const v = String(value).trim();
        const hit = active.find((s) => s._id === v || s.stageCode === v || fold(s.stageName || '') === fold(v));
        if (hit) return { value: hit._id, closedStage: hit.endFlowStage ? hit.stageName : null };
        return { error: `"${v}" is not an active stage of the ${stageType} pipeline (${active.map((s) => s.stageName).join(', ')})` };
      };
    } else {
      notes.push(`"${field}" values that are not _ids are looked up by the server by the ${info.ref}'s key; a value it cannot find fails that row.`);
    }
  }
  return { resolvers, notes };
}

// ─── Matching against the account ──────────────────────────────────────────────

async function findExisting(client, object, match, keys, select) {
  const found = new Map();
  const add = (key, rec) => {
    if (!found.has(key)) found.set(key, []);
    if (!found.get(key).some((r) => r._id === rec._id)) found.get(key).push(rec);
  };
  const numericTwins = new Map();
  if (match === 'companyName' || match === 'dealName') {
    for (const part of chunks(keys, 25)) {
      const xq = { $or: part.map((k) => ({ [match]: { $regex: nameRegex(k) } })) };
      for (const rec of await list(client, object, xq, select)) add(nameKey(rec[match] || ''), rec);
    }
  } else {
    for (const part of chunks(keys, 100)) {
      for (const rec of await list(client, object, { [match]: { $in: part } }, select)) add(normalizeKey(match, getPath(rec, match)), rec);
    }
    if (match === 'refId') {
      const numeric = keys.filter((k) => /^-?\d{1,15}(\.\d+)?$/.test(k));
      for (const part of chunks(numeric, 100)) {
        for (const rec of await list(client, object, { refId: { $in: part.map(Number) } }, select)) numericTwins.set(String(rec.refId), rec);
      }
    }
  }
  return { found, numericTwins };
}

async function sideEffects(client, ctx, model, actions) {
  const events = [`${model}.*`, ...actions.map((a) => `${model}.${a}`)];
  const integrations = (ctx.prefs && ctx.prefs.integrations) || {};
  const out = { webhooks: [], scripts: [], aiTriggers: [], unknown: [] };
  if (integrations.webhooks && integrations.webhooks.enabled) {
    try {
      const hooks = await list(client, 'webhook', { active: true }, 'webhookName eventNames', 200);
      out.webhooks = hooks
        .filter((w) => (w.eventNames || []).some((e) => events.includes(e)))
        .map((w) => ({ name: w.webhookName, events: (w.eventNames || []).filter((e) => events.includes(e)) }));
    } catch (err) {
      out.unknown.push(`webhooks (${err.status || 'error'})`);
    }
  }
  const lh = integrations.lifecycleHooks || {};
  if (lh.enabled && (lh.enabledEntities || []).includes(model)) {
    try {
      out.scripts = (await list(client, 'script', { active: true, lifecycleHooks: { $in: [model] } }, 'scriptName', 200)).map((s) => s.scriptName);
    } catch (err) {
      out.unknown.push(`lifecycle scripts (${err.status || 'error'})`);
    }
  }
  try {
    out.aiTriggers = (await list(client, 'eventtrigger', { active: true, type: 'lifecycle', modelName: model }, 'eventTriggerName eventName', 200))
      .map((t) => `${t.eventTriggerName} (${t.eventName})`);
  } catch (err) {
    out.unknown.push(`AI agent triggers (${err.status || 'error'})`);
  }
  return out;
}

async function refIdCheck(ctx, object) {
  const chunksOut = [];
  const sink = { write: (t) => chunksOut.push(String(t)) };
  const argv = ['check', ctx.domain, object];
  if (ctx.profile) argv.push('--profile', ctx.profile);
  const code = await refs.main(argv, {
    rootDir: ctx.rootDir, fetchImpl: ctx.fetchImpl, stdout: sink, stderr: sink,
  });
  try {
    return { code, ...JSON.parse(chunksOut.join('')) };
  } catch {
    return { code, canWriteRefId: null, error: chunksOut.join('').trim() };
  }
}

// ─── Build the dry run ─────────────────────────────────────────────────────────

function sameValue(field, info, stored, next) {
  if (info.kind === 'ref') return idOf(stored) === idOf(next);
  if (info.kind === 'refList') return JSON.stringify((stored || []).map(idOf)) === JSON.stringify(next);
  if (info.kind === 'date') return stored !== undefined && stored !== null && Date.parse(stored) === Date.parse(next);
  return JSON.stringify(stored) === JSON.stringify(next);
}

function labelOf(conf, values) {
  return conf.labelKeys.map((k) => values[k]).filter((v) => v !== undefined && v !== '').join(' · ');
}

async function buildPreview(client, ctx, plan) {
  const conf = OBJECTS[plan.object];
  const schema = schemaFor(ctx, conf.model);
  const fields = importableFields(schema);
  const table = loadTable(plan);
  const { mapped, ignored } = checkMapping(plan, table, fields, schema);
  const warnings = [...table.warnings];
  const notes = [];
  const blockers = [];

  const numberFormat = (ctx.prefs.locale && ctx.prefs.locale.numberFormat) || '0,000.00';
  const opts = {
    decimalSep: plan.decimalSeparator || (numberFormat.charAt(numberFormat.length - 3) === ',' ? ',' : '.'),
    decimalExplicit: Boolean(plan.decimalSeparator),
    dateOrder: plan.dateOrder,
    timeZone: plan.timeZone || (ctx.me.profile && ctx.me.profile.locale && ctx.me.profile.locale.timeZone)
      || (ctx.prefs.locale && ctx.prefs.locale.timeZone) || null,
  };

  // 1. Convert each cell.
  let ambiguousDates = 0;
  let ambiguousNumbers = 0;
  let needsZone = false;
  const rowsData = table.rows.map(({ row, values }) => {
    const out = { row, values: {}, errors: [] };
    for (const [field, column] of Object.entries(mapped)) {
      const raw = values[column];
      if (raw === undefined) continue;
      if (field === '_id') {
        const id = String(raw).trim().toLowerCase();
        if (!ID_RE.test(id)) out.errors.push(`${column}: "${raw}" is not a record id`);
        else out.values._id = id;
        continue;
      }
      const res = convert(field, fields[field], raw, opts);
      if (res.ambiguousDate) ambiguousDates += 1;
      if (res.ambiguousNumber) ambiguousNumbers += 1;
      if (res.needsZone) needsZone = true;
      if (res.error) out.errors.push(`${column}: ${res.error}`);
      else out.values[field] = res.value;
    }
    return out;
  });
  if (ambiguousDates) blockers.push(`${ambiguousDates} date(s) could be day/month or month/day (for example 03/04/2026). Ask the user and add "dateOrder": "DMY" or "MDY" to the plan.`);
  if (ambiguousNumbers) blockers.push(`${ambiguousNumbers} number(s) such as 1.200 could be thousands or decimals. Ask the user and add "decimalSeparator": "," or "." to the plan.`);
  if (needsZone) blockers.push('The file has dates and neither the user nor the account has a time zone. Ask the user for it and add "timeZone" (for example "America/Bogota") to the plan.');

  // 2. Resolve references the script can check.
  const { resolvers, notes: refNotes } = await resolveRefs(client, ctx, conf.model, rowsData, fields);
  notes.push(...refNotes);

  // 3. Duplicates inside the file.
  const firstByKey = new Map();
  for (const r of rowsData) {
    r.key = normalizeKey(plan.match, r.values[plan.match]);
    if (!r.key) {
      if (!r.errors.length) r.errors.push(`no value in the "${mapped[plan.match]}" column, which identifies the record`);
      continue;
    }
    if (r.errors.length) continue;
    if (firstByKey.has(r.key)) r.duplicateOf = firstByKey.get(r.key);
    else firstByKey.set(r.key, r.row);
  }

  // 4. Records that already exist.
  const tops = new Set(['_id', 'updatedAt', 'workspace', ...conf.labelKeys, plan.match.split('.')[0]]);
  for (const f of Object.keys(mapped)) tops.add(f.split('.')[0]);
  for (const f of Object.keys(plan.defaults || {})) tops.add(f.split('.')[0]);
  const keys = [...firstByKey.keys()];
  const { found, numericTwins } = await findExisting(client, plan.object, plan.match, keys, [...tops].join(' '));

  // 5. Decide each row.
  const assigneeSet = rowsData.some((r) => r.values.assignee !== undefined) || (plan.defaults && plan.defaults.assignee);
  const decided = [];
  const closedStages = new Set();
  for (const r of rowsData) {
    const base = { row: r.row, key: r.key, label: labelOf(conf, r.values) };
    if (r.errors.length) {
      decided.push({ ...base, action: 'error', errors: r.errors });
      continue;
    }
    if (r.duplicateOf) {
      decided.push({ ...base, action: 'duplicateInFile', reason: `same ${plan.match} as row ${r.duplicateOf}; only the first is imported` });
      continue;
    }
    const matches = found.get(r.key) || [];
    if (numericTwins.has(r.key)) {
      decided.push({
        ...base, action: 'ambiguous', recordIds: [numericTwins.get(r.key)._id], reason: 'a record holds this refId stored as a number; fix it with prolibu-external-refs first',
      });
      continue;
    }
    if (matches.length > 1) {
      decided.push({
        ...base, action: 'ambiguous', recordIds: matches.map((m) => m._id), reason: `${matches.length} records already have this ${plan.match}; the user must pick one (or merge them in the app)`,
      });
      continue;
    }
    const record = matches[0] || null;
    const rowErrors = [];
    const values = { ...r.values };
    delete values._id;
    if (!record) {
      for (const [f, v] of Object.entries(plan.defaults || {})) {
        if (values[f] === undefined) {
          const res = convert(f, fields[f], v, opts);
          if (res.error) rowErrors.push(`default ${f}: ${res.error}`);
          else values[f] = res.value;
        }
      }
    }
    for (const [f, resolve] of Object.entries(resolvers)) {
      if (values[f] === undefined) continue;
      const res = resolve(values[f]);
      if (res.error) rowErrors.push(`${mapped[f] || f}: ${res.error}`);
      else values[f] = res.value;
      if (res.closedStage && !record) closedStages.add(res.closedStage);
    }
    if (rowErrors.length) {
      decided.push({ ...base, action: 'error', errors: rowErrors });
      continue;
    }
    if (!record) {
      if (plan.match === '_id') {
        decided.push({ ...base, action: 'error', errors: [`no ${plan.object} with _id ${r.key} (the importer would create a new record with that id)`] });
        continue;
      }
      if (plan.missing === 'skip') {
        decided.push({ ...base, action: 'skip', reason: 'not in the account, and the plan does not create records' });
        continue;
      }
      const missing = Object.entries(fields).filter(([f, info]) => info.required && values[f] === undefined).map(([f]) => f);
      if (missing.length) {
        decided.push({ ...base, action: 'error', errors: [`a new ${plan.object} needs ${missing.join(', ')}`] });
        continue;
      }
      const body = {};
      for (const [f, v] of Object.entries(values)) setPath(body, f, v);
      decided.push({ ...base, action: 'create', body });
      continue;
    }
    const recordBase = { ...base, recordId: record._id, recordUpdatedAt: record.updatedAt || null };
    if (plan.existing === 'skip') {
      decided.push({ ...recordBase, action: 'skip', reason: 'already in the account; the plan leaves existing records as they are' });
      continue;
    }
    const changes = [];
    const body = { _id: record._id };
    const stageMoves = [];
    for (const [f, v] of Object.entries(values)) {
      if (f === plan.match) continue;
      if (plan.updateFields && !plan.updateFields.includes(f)) continue;
      const stored = getPath(record, f);
      if (sameValue(f, fields[f], stored, v)) continue;
      if (fields[f].ref === 'Stage') {
        stageMoves.push(f);
        continue;
      }
      changes.push({ field: f, from: stored === undefined ? null : stored, to: v });
      setPath(body, f, v);
    }
    if (stageMoves.length) {
      decided.push({ ...recordBase, action: 'error', errors: [`moving ${stageMoves.join(', ')} of an existing record is done with the prolibu-stages skill (required fields, history)`] });
      continue;
    }
    if (!changes.length) {
      decided.push({ ...recordBase, action: 'unchanged', reason: 'already has these values' });
      continue;
    }
    decided.push({
      ...recordBase, action: 'update', changes, body,
    });
  }

  // 6. Plan-level checks.
  const writes = decided.filter((d) => d.action === 'create' || d.action === 'update');
  if (mapped.refId || (plan.defaults && plan.defaults.refId)) {
    const check = await refIdCheck(ctx, plan.object);
    if (check.canWriteRefId === false) {
      blockers.push(`refId cannot be written on ${plan.object}: ${(check.sync && check.sync.note) || check.error || 'the sync check failed'}. Map the external id to a custom field instead (prolibu-custom-fields).`);
    } else if (check.canWriteRefId !== true) {
      blockers.push(`Could not check whether a sync owns refId on ${plan.object}: ${check.error || 'unknown'}. Ask an admin.`);
    }
  }
  if (plan.match === 'dealName') warnings.push('Deals are matched by name, and two deals can share a name. If the file has an id from another system, map it to refId and match by refId.');
  if (plan.match === 'companyName') notes.push('Companies are matched by name, ignoring upper/lower case and extra spaces. The importer itself would create a second company with the same name: this preview is the only guard.');
  if (plan.object === 'deal') {
    const valueColumns = ignored.filter((h) => DEAL_VALUE_WORDS.some((w) => fold(h).includes(w)));
    const amountField = Object.keys(fields).find((f) => DEAL_VALUE_WORDS.some((w) => fold(f).includes(w)));
    if (valueColumns.length && !amountField) {
      warnings.push(`This account's Deal has no amount field (custom fields included): a deal's value is its quote. Columns ${valueColumns.join(', ')} are not imported; add products with the prolibu-quotes skill.`);
    }
  }
  if (closedStages.size) warnings.push(`Some new records start in a closed stage (${[...closedStages].join(', ')}): they are locked for edits once created, and an approved deal may create a work order.`);
  if (assigneeSet) warnings.push('Rows set an owner (assignee): each owner gets the usual assignment notification.');
  if (ignored.length) notes.push(`Columns not imported: ${ignored.join(', ')}.`);
  if (writes.length > MAX_APPLY_ROWS) {
    warnings.push(`${writes.length} rows to write is more than this script sends in one run (${MAX_APPLY_ROWS}). Use export and the app's Import (JSON) for this file.`);
  }
  const effects = await sideEffects(client, ctx, conf.model, [...new Set(writes.map((d) => d.action))]);

  const counts = {};
  for (const d of decided) counts[d.action] = (counts[d.action] || 0) + 1;
  counts.toWrite = writes.length;
  const version = crypto.createHash('sha256').update(JSON.stringify({
    object: plan.object, rows: decided.map((d) => [d.row, d.action, d.recordId || null, d.recordUpdatedAt || null, d.body || null]),
  })).digest('hex').slice(0, 16);

  return {
    plan, conf, table, mapped, fields, decided, writes, counts, version, warnings, notes, blockers, effects, ignored, opts,
  };
}

function rowSummary(d) {
  const out = {
    row: d.row, action: d.action, key: d.key || undefined, label: d.label || undefined, recordId: d.recordId,
  };
  if (d.changes) out.changes = d.changes;
  if (d.action === 'create') out.values = d.body;
  if (d.errors) out.errors = d.errors;
  if (d.reason) out.reason = d.reason;
  if (d.recordIds) out.recordIds = d.recordIds;
  return out;
}

function pickRows(decided) {
  const order = ['error', 'ambiguous', 'duplicateInFile', 'update', 'create', 'skip', 'unchanged'];
  const sorted = [...decided].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || a.row - b.row);
  return sorted.slice(0, SHOW_ROWS).map(rowSummary);
}

function detailsOf(d) {
  if (d.errors) return d.errors.join(' | ');
  if (d.changes) return d.changes.map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join(' | ');
  return d.reason || '';
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdInspect(client, [object, file], flags, ctx) {
  checkObject(object);
  if (!file) throw new UsageError('Usage: imports.js inspect <domain> <contact|company|deal> <file> [--sheet <name>]');
  const conf = OBJECTS[object];
  const plan = { file: checkSourceFile(file, ctx.rootDir), sheet: flags.sheet, headerRow: flags.headerRow };
  const table = loadTable(plan);
  const { me } = await loadContext(client);
  const fields = importableFields(schemaFor({ me }, conf.model));
  const synonyms = SYNONYMS[object];
  const suggested = {};
  const taken = new Set();
  for (const header of table.headers) {
    const h = fold(header);
    let hit = Object.keys(fields).find((f) => fold(f) === h || fold(f.split('.').pop()) === h);
    if (!hit) hit = Object.keys(synonyms).find((f) => fields[f] && synonyms[f].includes(h));
    if (hit && !taken.has(hit)) {
      suggested[header] = hit;
      taken.add(hit);
    } else suggested[header] = null;
  }
  const notes = [];
  if (object === 'deal' && table.headers.some((h) => DEAL_VALUE_WORDS.some((w) => fold(h).includes(w)))) {
    notes.push('A deal has no amount field: its value comes from its quote (prolibu-quotes).');
  }
  if (object === 'contact' && suggested[table.headers.find((h) => suggested[h] === 'company')]) {
    notes.push('"company" links each contact to an existing company by name, code or _id. Companies that do not exist yet: import them first.');
  }
  return {
    object,
    file: {
      name: plan.file ? path.basename(plan.file) : null, format: table.format, sheets: table.sheets, sheet: table.sheet, delimiter: table.delimiter, encoding: table.encoding, rows: table.rows.length,
    },
    headers: table.headers,
    sample: table.rows.slice(0, 3),
    suggestedMapping: suggested,
    match: { default: conf.defaultMatch, options: conf.matchKeys },
    fields: Object.entries(fields).map(([f, i]) => ({
      field: f, kind: i.kind, required: i.required || undefined, ref: i.ref || undefined, options: i.enum ? i.enum.slice(0, 12) : undefined,
    })),
    warnings: table.warnings,
    notes,
    nextStep: 'Agree on the mapping, the match key and what to do with existing records with the user, then run preview.',
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const loaded = await loadContext(client);
  const p = await buildPreview(client, { ...ctx, ...loaded }, plan);
  const reportFile = writeReport(`${plan.object}-${p.version}-preview.csv`, p.decided.map((d) => ({
    row: d.row, result: d.action, key: d.key, recordId: d.recordId, details: detailsOf(d),
  })));
  return {
    object: plan.object,
    model: p.conf.model,
    file: {
      name: plan.file ? path.basename(plan.file) : '(inline rows)', format: p.table.format, sheet: p.table.sheet, rows: p.table.rows.length,
    },
    match: plan.match,
    existing: plan.existing,
    missing: plan.missing,
    timeZone: p.opts.timeZone,
    counts: p.counts,
    rows: pickRows(p.decided),
    rowsShown: Math.min(SHOW_ROWS, p.decided.length),
    reportFile,
    sideEffects: {
      ...p.effects,
      always: 'Each row is created or updated like a record saved by hand: webhooks, lifecycle scripts, AI agent triggers and the account\'s notifications run per row. Only the live refresh of other people\'s screens is skipped.',
    },
    notes: p.notes,
    warnings: p.warnings,
    blockers: p.blockers,
    version: p.version,
    nextStep: p.blockers.length
      ? 'Blocked: explain the blockers to the user and change the plan.'
      : 'Show the counts, every error, ambiguous and duplicate row, and each update with its changes. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message run apply with the same plan and --version.',
  };
}

async function prepareWrite(client, planArg, flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  const plan = readPlan(planArg, ctx.rootDir);
  const loaded = await loadContext(client);
  const p = await buildPreview(client, { ...ctx, ...loaded }, plan);
  if (p.version !== flags.version) throw new Blocked('The file or the account changed since the preview. Run preview again and show the user.');
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  return p;
}

function matchResults(chunkRows, response, matchField) {
  const errors = new Map((response.errors || []).map((e) => [Number(e.row), e.error]));
  const created = [...(response.created || [])];
  const updated = [...(response.updated || [])];
  const take = (list, pred) => {
    const i = list.findIndex(pred);
    return i < 0 ? null : list.splice(i, 1)[0];
  };
  return chunkRows.map((d, i) => {
    if (errors.has(i)) return { d, status: 'failed', error: errors.get(i) };
    const keyOf = (doc) => normalizeKey(matchField, getPath(doc, matchField));
    if (d.action === 'update') {
      const doc = take(updated, (x) => x._id === d.recordId);
      return doc ? { d, status: 'updated', doc } : { d, status: 'unknown', error: 'the importer did not report this row' };
    }
    const doc = take(created, (x) => keyOf(x) === d.key);
    if (doc) return { d, status: 'created', doc };
    const other = take(updated, (x) => keyOf(x) === d.key);
    if (other) return { d, status: 'updated', doc: other, problem: 'it matched an existing record and updated it instead of creating one' };
    return { d, status: 'unknown', error: 'the importer did not report this row' };
  });
}

async function readBack(client, object, results) {
  const problems = [];
  const ids = results.filter((r) => r.doc).map((r) => r.doc._id);
  const saved = new Map();
  for (const part of chunks(ids, 100)) {
    for (const rec of await list(client, object, { _id: { $in: part } }, null, 100)) saved.set(rec._id, rec);
  }
  for (const r of results.filter((x) => x.doc)) {
    const rec = saved.get(r.doc._id);
    if (!rec) {
      problems.push(`Row ${r.d.row}: record ${r.doc._id} cannot be read back.`);
      continue;
    }
    const flat = [];
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
        else flat.push([p, v]);
      }
    };
    walk(r.d.body, '');
    for (const [p, v] of flat) {
      if (p === '_id') continue;
      if (object === 'contact' && p === 'companyName' && r.d.body.company) continue;
      const stored = getPath(rec, p);
      const same = Array.isArray(v)
        ? JSON.stringify((stored || []).map((x) => idOf(x) || x)) === JSON.stringify(v)
        : (idOf(stored) === String(v) || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Date.parse(stored) === Date.parse(v)));
      if (!same) problems.push(`Row ${r.d.row}: ${p} was saved as ${JSON.stringify(stored === undefined ? null : stored)}, not ${JSON.stringify(v)}.`);
    }
  }
  return problems;
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const chunkSize = flags.chunk ? Number(flags.chunk) : DEFAULT_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK) throw new UsageError(`--chunk must be between 1 and ${MAX_CHUNK}.`);
  const p = await prepareWrite(client, planArg, flags, ctx);
  if (p.writes.length > MAX_APPLY_ROWS) {
    throw new Blocked(`${p.writes.length} rows to write; this script sends at most ${MAX_APPLY_ROWS} per run. Run export and import the file in the app.`);
  }
  if (!p.writes.length) return { saved: true, object: p.plan.object, counts: { created: 0, updated: 0 }, rows: [], problems: [], note: 'Nothing to write.' };

  const results = [];
  let stopped = null;
  const parts = chunks(p.writes, chunkSize);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const bodies = part.map((d) => d.body);
    let res;
    try {
      res = await client.request('PUT', `/v2/service/importdata?modelName=${p.conf.model}`, { data: bodies, confirmed: true });
    } catch (err) {
      stopped = `The call for rows ${part[0].row}–${part[part.length - 1].row} did not answer (${err.name === 'TimeoutError' ? 'timed out' : err.message}). The importer may still be writing them.`;
      results.push(...part.map((d) => ({ d, status: 'unknown', error: 'no answer; preview again to see whether it was written' })));
      parts.slice(i + 1).flat().forEach((d) => results.push({ d, status: 'notSent' }));
      break;
    }
    if (!res.ok) {
      const msg = res.body && typeof res.body === 'object' ? (res.body.error || res.body.message) : res.body;
      stopped = `The importer refused rows ${part[0].row}–${part[part.length - 1].row}: ${res.status} ${msg || ''}`.trim();
      parts.slice(i).flat().forEach((d) => results.push({ d, status: 'notSent' }));
      break;
    }
    results.push(...matchResults(part, res.body || {}, p.plan.match));
  }

  const problems = results.filter((r) => r.problem).map((r) => `Row ${r.d.row}: ${r.problem}.`);
  problems.push(...await readBack(client, p.plan.object, results));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const rows = results.map((r) => ({
    row: r.d.row,
    result: r.status,
    key: r.d.key,
    label: r.d.label || undefined,
    recordId: r.doc ? r.doc._id : (r.d.recordId || undefined),
    error: r.error,
  }));
  const reportFile = writeReport(`${p.plan.object}-${p.version}-result.csv`, rows.map((r) => ({
    row: r.row, result: r.result, key: r.key, recordId: r.recordId, details: r.error || '',
  })).concat(p.decided.filter((d) => !['create', 'update'].includes(d.action)).map((d) => ({
    row: d.row, result: `not imported (${d.action})`, key: d.key, recordId: d.recordId, details: detailsOf(d),
  }))).sort((a, b) => a.row - b.row));
  const saved = !stopped && !problems.length && !results.some((r) => r.status !== 'created' && r.status !== 'updated');
  return {
    saved,
    object: p.plan.object,
    counts,
    notImported: p.decided.length - p.writes.length,
    rows: rows.filter((r) => r.result !== 'created' && r.result !== 'updated').concat(rows.filter((r) => r.result === 'created' || r.result === 'updated')).slice(0, SHOW_ROWS),
    reportFile,
    stopped: stopped || undefined,
    problems,
    nextStep: saved
      ? 'Tell the user how many were created and updated, and where the report is.'
      : 'Tell the user what failed and why (rows, problems, stopped). Rows already written are safe to re-import: run preview again and they show as existing.',
  };
}

async function cmdExport(client, [planArg], flags, ctx) {
  const p = await prepareWrite(client, planArg, flags, ctx);
  if (!p.writes.length) throw new Blocked('Nothing to import: every row is an error, a duplicate, existing or unchanged.');
  const file = path.join(tempDir(), `${p.plan.object}-${p.version}.json`);
  fs.writeFileSync(file, JSON.stringify(p.writes.map((d) => d.body), null, 1));
  return {
    file,
    rows: p.writes.length,
    creates: p.writes.filter((d) => d.action === 'create').length,
    updates: p.writes.filter((d) => d.action === 'update').length,
    howTo: `In the Prolibu app open the ${p.conf.model} list, open the ⋯ menu, choose Import → JSON and pick this file. The import runs in the background with its own progress panel. Then run jobs to read the result.`,
    note: 'Import it soon: the file says which records to update as of this preview. If much time passes, preview and export again.',
  };
}

function jobSummary(job) {
  return {
    id: job._id,
    status: job.status,
    object: job.modelName,
    kind: /^bulk-edit-/.test(job.fileName || '') ? 'bulk edit' : 'import',
    fileName: job.fileName,
    sheet: job.sheetName || undefined,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    successRows: job.successRows,
    errorRows: job.errorRows,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    duration: job.duration,
    createdBy: job.createdBy,
  };
}

async function cmdJobs(client, args, flags) {
  const limit = flags.limit ? Number(flags.limit) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new UsageError('--limit must be between 1 and 50.');
  const body = await call(client, 'GET', `/v2/service/importjobs?${new URLSearchParams({ limit: String(limit), sort: '-createdAt' })}`);
  return { total: body.total, jobs: (body.docs || []).map(jobSummary) };
}

async function cmdJob(client, [id]) {
  if (!ID_RE.test(String(id || ''))) throw new UsageError('Usage: imports.js job <domain> <jobId>');
  const job = await call(client, 'GET', `/v2/service/importjob/${id}`);
  const errors = Array.isArray(job.errors) ? job.errors : [];
  return {
    ...jobSummary(job),
    errors,
    errorsNote: [
      job.errorRows > 0 && !errors.length ? 'This job did not keep its row errors (older imports only showed them live in the app\'s import panel).' : null,
      errors.length && job.errorRows > errors.length ? `The job keeps the first ${errors.length} of ${job.errorRows} row errors.` : null,
      'For an Excel file, row N is the Nth data row under the header (spreadsheet row N+1), counting only rows with data and not marked skip; for a JSON file it is the Nth item.',
    ].filter(Boolean),
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
    else if (arg === '--version') flags.version = next();
    else if (arg === '--chunk') flags.chunk = next();
    else if (arg === '--limit') flags.limit = next();
    else if (arg === '--sheet') flags.sheet = next();
    else if (arg === '--header-row') flags.headerRow = Number(next());
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return {
    command: positional[0], domain: positional[1], rest: positional.slice(2), flags,
  };
}

const COMMANDS = {
  inspect: cmdInspect, preview: cmdPreview, apply: cmdApply, export: cmdExport, jobs: cmdJobs, job: cmdJob,
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
    if (!handler || !domain) throw new UsageError('Usage: imports.js <inspect|preview|apply|export|jobs|job> <domain> … (see the header of this file)');
    client = createClient({
      domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr,
    });
    const ctx = {
      rootDir, domain, profile: flags.profile, fetchImpl: opts.fetchImpl,
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
  main, readPlan, convert, parseNumber, parseDate, parseBoolean, importableFields, normalizeKey, matchResults,
};
