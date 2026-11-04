#!/usr/bin/env node
'use strict';

// Creates and updates a Prolibu catalog the way the app's own import does it (one POST or
// PATCH per record, matched by its code, references by code), with what the import lacks:
// a preview against the account, checks for the values the server accepts silently but
// that break quotes, and a read-back that proves each price can be quoted.
//
//   catalog.js find      <domain> <object> <term>
//   catalog.js product   <domain> <productCode> [--quantity 1,10]  product, its prices, priced by the server
//   catalog.js sheet     <file.xlsx|file.csv> [--sheet <name>] [--rows <n>]
//   catalog.js from-sheet <file> ['<mapping json>'] [--out <temp file>]
//   catalog.js preview   <domain> '<plan json>'                  writes nothing; returns a version
//   catalog.js apply     <domain> '<plan json>' --version <v> --confirmed
//
// The plan (and the mapping) is inline JSON or the path of a JSON file in a temp folder.
// Every command that calls the account accepts --profile <name>.
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
const sheetReader = require('./sheet-reader');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const PAGE = 500;
const CHECK_LIMIT = 300;
const SHOW_LIMIT = 40;

class Blocked extends Error {}

// Plan sections, in the order they are written (a record may point to records above it).
const SECTIONS = [
  { key: 'taxes', title: 'Tax', model: 'Tax', object: 'tax', code: 'taxCode', name: 'taxName' },
  { key: 'families', title: 'Family', model: 'ProductFamily', object: 'productfamily', code: 'productFamilyCode', name: 'productFamilyName' },
  { key: 'categories', title: 'Category', model: 'ProductCategory', object: 'productcategory', code: 'productCategoryCode', name: 'productCategoryName' },
  { key: 'groups', title: 'Group', model: 'ProductGroup', object: 'productgroup', code: 'productGroupCode', name: 'productGroupName' },
  { key: 'discountSchedules', title: 'Discount schedule', model: 'DiscountSchedule', object: 'discountschedule', code: 'discountScheduleCode', name: 'discountScheduleName' },
  { key: 'coupons', title: 'Coupon', model: 'Coupon', object: 'coupon', code: 'couponCode', name: 'couponName' },
  { key: 'pricebooks', title: 'Price list', model: 'Pricebook', object: 'pricebook', code: 'pricebookCode', name: 'pricebookName' },
  { key: 'products', title: 'Product', model: 'Product', object: 'product', code: 'productCode', name: 'productName' },
];
const ENTRY = { key: 'entries', title: 'Price', model: 'PricebookEntry', object: 'pricebookentry', code: 'pricebookEntryCode' };
const BY_MODEL = Object.fromEntries(SECTIONS.map((s) => [s.model, s]));
// Models a plan may point to by code or name without having a section of their own.
const LOOKUP_ONLY = { ProductRule: { model: 'ProductRule', object: 'productrule', code: 'productRuleCode', name: 'productRuleName' } };
const FIXED_FIELDS = new Set(['_id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);
const DATAMAP_TYPES = {
  tax: 'taxes', productfamily: 'families', productcategory: 'categories', productgroup: 'groups',
  discountschedule: 'discountSchedules', coupon: 'coupons', pricebook: 'pricebooks', product: 'products', pricebookentry: 'entries',
};

// ─── Values ────────────────────────────────────────────────────────────────────

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'si', 'sí', 'verdadero', 'vrai', 'verdadeiro', 'x', 'activo', 'active']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'falso', 'faux', 'inactivo', 'inactive']);

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  const word = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

// Numbers from spreadsheets. "1.234,56" and "1,234.56" are read; "1.234" alone is
// ambiguous (one thousand two hundred, or one point two) and is refused.
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  let text = String(value).trim().replace(/[\s$€£¥]|[A-Z]{3}$/g, '');
  if (!text) return undefined;
  const negative = /^-/.test(text);
  text = text.replace(/^-/, '');
  if (!/^[\d.,]+$/.test(text)) return undefined;
  const dots = (text.match(/\./g) || []).length;
  const commas = (text.match(/,/g) || []).length;
  let normal;
  if (dots && commas) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    if ((text.split(decimal).length - 1) > 1) return undefined;
    normal = text.split(thousands).join('').replace(decimal, '.');
  } else if (dots + commas === 1) {
    const sep = dots ? '.' : ',';
    const [, after] = text.split(sep);
    if (after.length === 3) return undefined;
    normal = text.replace(sep, '.');
  } else if (dots + commas > 1) {
    const sep = dots ? '.' : ',';
    const groups = text.split(sep);
    if (groups.slice(1).some((g) => g.length !== 3)) return undefined;
    normal = groups.join('');
  } else normal = text;
  const number = Number(normal);
  if (!Number.isFinite(number)) return undefined;
  return negative ? -number : number;
}

// A list cell: JSON array, quoted items, or plain comma-separated text.
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return [value];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Falls through to the plain forms.
    }
  }
  const quoted = [...text.matchAll(/(["'`])(.*?)\1/g)].map((m) => m[2]);
  if (quoted.length) return quoted;
  return text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function normName(value) {
  return String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isBlankValue(value) {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

// A finding about one record. Findings with the same text are grouped in the output, so a
// load of 300 products shows one line per problem, not 300.
function note(where, text) {
  return { where, text };
}

function grouped(list) {
  const byText = new Map();
  for (const item of list) {
    const { where, text } = typeof item === 'string' ? { where: null, text: item } : item;
    if (!byText.has(text)) byText.set(text, []);
    if (where) byText.get(text).push(where);
  }
  return [...byText].map(([text, wheres]) => {
    if (!wheres.length) return text;
    if (wheres.length === 1) return `${wheres[0]}: ${text}`;
    const shown = wheres.slice(0, 3).join('; ');
    return `${text} (${wheres.length} records: ${shown}${wheres.length > 3 ? `; and ${wheres.length - 3} more` : ''})`;
  });
}

function same(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function money(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

// ─── Input ─────────────────────────────────────────────────────────────────────

function readJsonArg(arg, rootDir, what) {
  let text = String(arg || '');
  if (!text.trim()) throw new UsageError(`Missing the ${what}.`);
  if (!text.trim().startsWith('{')) {
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

function assertSheetAllowed(file, rootDir) {
  const ext = path.extname(String(file)).toLowerCase();
  if (!['.xlsx', '.xlsm', '.csv', '.txt', '.xls'].includes(ext)) {
    throw new UsageError('Only .xlsx and .csv files can be read.');
  }
  const resolved = path.resolve(file);
  const accounts = path.resolve(rootDir, 'accounts');
  if (resolved === accounts || resolved.startsWith(accounts + path.sep)) {
    throw new UsageError('Files under accounts/ cannot be read.');
  }
  if (!fs.existsSync(resolved)) throw new UsageError(`File not found: ${file}`);
}

function tempOut(file, fallbackName, rootDir) {
  const target = file || path.join(os.tmpdir(), fallbackName);
  assertDataFileAllowed(target, rootDir);
  return target;
}

// ─── API ───────────────────────────────────────────────────────────────────────

async function call(client, method, reqPath, opts) {
  const res = await client.request(method, reqPath, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    err.serverMessage = body.error || body.message;
    throw err;
  }
  return res.body;
}

async function listAll(client, object, xquery, select) {
  const out = [];
  for (let page = 1; page < 1000; page += 1) {
    const params = new URLSearchParams({ limit: String(PAGE), page: String(page), sort: '_id' });
    if (xquery) params.set('xquery', JSON.stringify(xquery));
    if (select) params.set('select', select);
    const body = await call(client, 'GET', `/v2/${object}?${params}`);
    const data = Array.isArray(body.data) ? body.data : [];
    out.push(...data);
    const last = body.pagination ? body.pagination.lastPage : 1;
    if (!data.length || page >= last) break;
  }
  return out;
}

async function listIn(client, object, field, values, select) {
  const out = [];
  for (const part of chunk([...new Set(values)], 200)) {
    if (!part.length) continue;
    out.push(...await listAll(client, object, { [field]: { $in: part } }, select));
  }
  return out;
}

async function loadSchemas(client) {
  const me = await call(client, 'GET', '/v2/user/me');
  const all = (me && me.modelSchemas) || {};
  const schemas = {};
  for (const model of [...SECTIONS.map((s) => s.model), ENTRY.model]) {
    if (!all[model]) throw new Blocked(`The account has no ${model} object (the pricing module may be off).`);
    schemas[model] = all[model];
  }
  return schemas;
}

// ─── Schema ────────────────────────────────────────────────────────────────────

function isLeaf(node) {
  return node && typeof node === 'object' && 'type' in node && (typeof node.type === 'string' || Array.isArray(node.type));
}

function leafAt(schema, route) {
  let node = schema;
  for (const part of route.split('.')) {
    if (!node || typeof node !== 'object' || isLeaf(node)) return undefined;
    node = node[part];
  }
  return isLeaf(node) ? node : undefined;
}

// Flattens a plan record into leaf routes of the schema. Keys may be nested objects or
// dotted paths. Returns {fields: {route: value}, unknown: [route]}.
function flatten(schema, record, prefix = '', out = { fields: {}, unknown: [] }) {
  for (const [key, value] of Object.entries(record)) {
    if (!prefix && (key.startsWith('_') || key === 'entries' || key === 'tiers' || key === 'taxRates')) continue;
    const route = prefix ? `${prefix}.${key}` : key;
    const leaf = leafAt(schema, route);
    if (leaf) out.fields[route] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const node = route.split('.').reduce((n, p) => (n && typeof n === 'object' ? n[p] : undefined), schema);
      if (node && typeof node === 'object' && !isLeaf(node)) flatten(schema, value, route, out);
      else out.unknown.push(route);
    } else out.unknown.push(route);
  }
  return out;
}

function leafType(leaf) {
  if (Array.isArray(leaf.type)) return { array: true, base: String(leaf.type[0]).toLowerCase() };
  return { array: false, base: String(leaf.type).toLowerCase() };
}

// ─── Lookups ───────────────────────────────────────────────────────────────────

// Index of existing records of one catalog object, by code and by normalized name.
function indexRecords(def, records) {
  const byCode = new Map();
  const byName = new Map();
  const byId = new Map();
  for (const r of records) {
    byId.set(String(r._id), r);
    if (r[def.code] !== undefined) byCode.set(String(r[def.code]), r);
    if (def.name && r[def.name] !== undefined) {
      const key = normName(r[def.name]);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(r);
    }
  }
  return { byCode, byName, byId };
}

// ─── Plan analysis ─────────────────────────────────────────────────────────────

function keyOf(def, record) {
  if (record[def.code] !== undefined && record[def.code] !== null && String(record[def.code]).trim()) return String(record[def.code]).trim();
  if (def.name && record[def.name] !== undefined) return `name:${normName(record[def.name])}`;
  return undefined;
}

function label(def, record) {
  const code = record[def.code];
  const name = def.name ? record[def.name] : undefined;
  if (code && name) return `${name} (${code})`;
  return String(code || name || '?');
}

function rowsNote(record) {
  return Array.isArray(record._rows) && record._rows.length ? ` [row ${record._rows.join(', ')}]` : '';
}

// Everything preview and apply need: the account's matching records, the actions, the
// blockers and warnings, and a version over the records involved.
async function analyze(client, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  const allowed = new Set([...SECTIONS.map((s) => s.key), 'note']);
  for (const key of Object.keys(plan)) {
    if (!allowed.has(key)) throw new UsageError(`Unknown plan section "${key}". Sections: ${SECTIONS.map((s) => s.key).join(', ')}.`);
    if (key !== 'note' && !Array.isArray(plan[key])) throw new UsageError(`"${key}" must be a list.`);
  }
  const total = SECTIONS.reduce((n, s) => n + (plan[s.key] || []).length, 0);
  if (!total) throw new UsageError('The plan is empty.');

  const blockers = [];
  const warnings = [];
  const schemas = await loadSchemas(client);

  // 1. Existing records of the small catalog objects, and of the plan's products.
  const existing = {};
  for (const def of SECTIONS.filter((s) => s.key !== 'products')) {
    existing[def.model] = indexRecords(def, await listAll(client, def.object));
  }
  const planProducts = plan.products || [];
  const productCodes = planProducts.map((p) => p.productCode).filter((c) => c !== undefined && c !== null).map((c) => String(c).trim());
  const referencedProducts = [];
  for (const p of planProducts) {
    for (const field of ['includedProducts']) for (const v of toList(p[field]) || []) referencedProducts.push(String(v));
  }
  const products = await listIn(client, 'product', 'productCode', [...productCodes, ...referencedProducts.filter((v) => !ID_RE.test(v))]);
  existing.Product = indexRecords(BY_MODEL.Product, products);
  existing.ProductRule = null;

  // 2. Match each plan record to an existing one.
  const actions = [];
  const planIndex = {};
  for (const def of SECTIONS) {
    const list = plan[def.key] || [];
    const seen = new Map();
    planIndex[def.model] = { byCode: new Map(), byName: new Map() };
    list.forEach((record, i) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        blockers.push(`${def.key}[${i}] is not an object.`);
        return;
      }
      const key = keyOf(def, record);
      if (!key) {
        blockers.push(`${def.key}[${i}] needs "${def.code}"${def.name ? ` or "${def.name}"` : ''}.`);
        return;
      }
      if (def.key === 'products' && key.startsWith('name:')) {
        blockers.push(`Product "${record.productName}"${rowsNote(record)} has no productCode. Every product needs a code: it is how a later load finds it again.`);
        return;
      }
      if (seen.has(key)) {
        blockers.push(`${label(def, record)} appears twice in "${def.key}"${rowsNote(record)}.`);
        return;
      }
      seen.set(key, i);
      const idx = existing[def.model];
      let match;
      if (!key.startsWith('name:')) match = idx.byCode.get(key);
      if (!match && def.name && record[def.name] !== undefined && def.key !== 'products') {
        const found = idx.byName.get(normName(record[def.name])) || [];
        if (found.length > 1) {
          blockers.push(`${def.key}: ${found.length} records are named "${record[def.name]}" (${found.map((r) => r[def.code]).join(', ')}). Use the code of the one you mean.`);
          return;
        }
        if (found.length === 1 && (key.startsWith('name:') || found[0][def.code] === undefined)) [match] = found;
        else if (found.length === 1 && String(found[0][def.code]) !== key) {
          warnings.push(`${def.key}: "${record[def.name]}" already exists with code ${found[0][def.code]}; a second one with code ${key} will be created.`);
        }
      }
      if (!match && key.startsWith('name:')) {
        const byCode = idx.byCode.get(String(record[def.name]).trim());
        if (byCode) match = byCode;
      }
      const action = {
        section: def.key, def, index: i, record, key, existing: match || null, label: label(def, match ? { ...match, ...record } : record),
      };
      actions.push(action);
      planIndex[def.model].byCode.set(key, action);
      if (def.name && record[def.name] !== undefined) planIndex[def.model].byName.set(normName(record[def.name]), action);
      if (match) {
        planIndex[def.model].byCode.set(String(match[def.code]), action);
        if (def.name) planIndex[def.model].byName.set(normName(match[def.name]), action);
      }
    });
  }

  const otherRefs = new Map();
  // Resolves a reference to an _id, or to a placeholder for a record the plan creates.
  async function resolveRef(model, value, where) {
    if (value === null) return { value: null };
    if (value && typeof value === 'object' && value._id) value = value._id;
    const text = String(value).trim();
    if (!text) return { value: null };
    if (ID_RE.test(text)) {
      const known = existing[model] && existing[model].byId.get(text);
      const def = BY_MODEL[model] || LOOKUP_ONLY[model];
      return { value: text, display: known && def ? label(def, known) : undefined };
    }
    const fromPlan = planIndex[model] && (planIndex[model].byCode.get(text) || planIndex[model].byName.get(normName(text)));
    if (fromPlan) return { value: fromPlan.existing ? String(fromPlan.existing._id) : { $new: fromPlan }, display: fromPlan.label };
    let idx = existing[model];
    const def = BY_MODEL[model] || LOOKUP_ONLY[model];
    if (!def) {
      // Any other object (a workspace, a template…) is read by its own primary key.
      const cacheKey = `${model}|${text}`;
      if (!otherRefs.has(cacheKey)) {
        let id = null;
        try {
          const res = await client.request('GET', `/v2/${model.toLowerCase()}/${encodeURIComponent(text)}`);
          if (res.ok && res.body && res.body._id) id = String(res.body._id);
        } catch (err) {
          if (!(err instanceof UsageError)) throw err;
        }
        otherRefs.set(cacheKey, id);
      }
      const id = otherRefs.get(cacheKey);
      if (!id) blockers.push(note(where, `no ${model} "${text}". Use its code or _id.`));
      return { value: id || undefined, display: id ? text : undefined };
    }
    if (idx === null || (idx === undefined)) {
      idx = indexRecords(def, await listAll(client, def.object));
      existing[model] = idx;
    }
    if (model === 'Product' && !idx.byCode.has(text)) {
      const more = await listIn(client, 'product', 'productCode', [text]);
      more.forEach((r) => { idx.byCode.set(String(r.productCode), r); idx.byId.set(String(r._id), r); });
    }
    const byCode = idx.byCode.get(text);
    if (byCode) return { value: String(byCode._id), display: label(def, byCode) };
    const byName = def.name ? idx.byName.get(normName(text)) || [] : [];
    if (byName.length === 1) return { value: String(byName[0]._id), display: label(def, byName[0]) };
    if (byName.length > 1) {
      blockers.push(note(where, `${byName.length} ${model} records are named "${text}" (${byName.map((r) => r[def.code]).join(', ')}). Use the code.`));
      return { value: undefined };
    }
    blockers.push(note(where, `no ${model} with code or name "${text}".`));
    return { value: undefined };
  }

  // Coerces one plan value to the schema type; references are resolved.
  async function coerce(model, leaf, route, value, where) {
    const { array, base } = leafType(leaf);
    if (value === null) return { value: null };
    if (typeof value === 'string' && value.trim().toLowerCase() === 'null') return { value: null };
    if (array) {
      const list = toList(value);
      if (!Array.isArray(list)) {
        blockers.push(note(where, `${route} must be a list.`));
        return { value: undefined };
      }
      if (base === 'mixed') return { value: list };
      const out = [];
      const display = [];
      for (const item of list) {
        // eslint-disable-next-line no-await-in-loop
        const one = await coerce(model, { ...leaf, type: base }, route, item, where);
        if (one.value === undefined) return { value: undefined };
        out.push(one.value);
        display.push(one.display || (one.value && one.value.$new ? one.value.$new.label : one.value));
      }
      return { value: out, display };
    }
    if (base === 'objectid') {
      if (!leaf.ref) return { value: String(value) };
      return resolveRef(leaf.ref, value, `${where} ${route}`);
    }
    if (base === 'number') {
      const n = toNumber(value);
      if (n === undefined) {
        blockers.push(note(where, `${route} "${value}" is not a number. Write it plainly (5000 or 5000.50).`));
        return { value: undefined };
      }
      return { value: n };
    }
    if (base === 'boolean') {
      const b = toBool(value);
      if (b === undefined) {
        blockers.push(note(where, `${route} "${value}" is not yes/no.`));
        return { value: undefined };
      }
      return { value: b };
    }
    if (base === 'date') {
      const d = new Date(typeof value === 'number' ? sheetReader.serialToDate(value) : value);
      if (Number.isNaN(d.getTime())) {
        blockers.push(note(where, `${route} "${value}" is not a date (use YYYY-MM-DD).`));
        return { value: undefined };
      }
      return { value: d.toISOString() };
    }
    if (base === 'string') {
      const text = typeof value === 'string' ? value.trim() : String(value);
      if (leaf.enum && !leaf.enum.includes(text)) {
        const upper = leaf.enum.find((e) => e.toLowerCase() === text.toLowerCase());
        if (upper) return { value: upper };
        blockers.push(note(where, `${route} "${text}" is not one of ${leaf.enum.length > 12 ? 'the allowed values' : leaf.enum.join(', ')}.`));
        return { value: undefined };
      }
      return { value: text };
    }
    return { value };
  }

  function storedValue(leaf, value) {
    if (value === undefined || value === null) return null;
    const { array, base } = leafType(leaf);
    const one = (v) => {
      if (v && typeof v === 'object' && v._id && base === 'objectid') return String(v._id);
      if (base === 'date') return new Date(v).toISOString();
      if (base === 'objectid') return String(v);
      return v;
    };
    if (array) return Array.isArray(value) ? value.map(one) : [one(value)];
    return one(value);
  }

  // 3. Build each record's body and changes.
  // Stored references shown by name, so the user sees "Drinks (drinks)" and not an _id.
  function refLabels(leaf, value) {
    const { base } = leafType(leaf);
    if (base !== 'objectid' || !leaf.ref || value === null) return value;
    const def = BY_MODEL[leaf.ref] || LOOKUP_ONLY[leaf.ref];
    const idx = existing[leaf.ref];
    const one = (v) => {
      const rec = def && idx && idx.byId.get(String(v));
      return rec ? label(def, rec) : v;
    };
    return Array.isArray(value) ? value.map(one) : one(value);
  }

  const ignoredColumns = new Map();
  async function buildBody(model, record, stored, where) {
    const schema = schemas[model];
    const { fields, unknown } = flatten(schema, record);
    for (const route of unknown) {
      if (record._datamap) {
        if (!ignoredColumns.has(model)) ignoredColumns.set(model, new Set());
        ignoredColumns.get(model).add(route);
      } else blockers.push(note(where, `"${route}" is not a field of ${model}.`));
    }
    const body = {};
    const changes = [];
    for (const [route, raw] of Object.entries(fields)) {
      const leaf = leafAt(schema, route);
      if (FIXED_FIELDS.has(route) || leaf.avoid === 'always') {
        blockers.push(note(where, `${route} is set by the platform.`));
        continue;
      }
      if (isBlankValue(raw)) continue;
      // eslint-disable-next-line no-await-in-loop
      const coerced = await coerce(model, leaf, route, raw, where);
      const { display } = coerced;
      let { value } = coerced;
      if (value === undefined) continue;
      if (route === 'refId' && typeof value === 'number') value = String(value);
      const before = stored ? storedValue(leaf, route.split('.').reduce((o, p) => (o ? o[p] : undefined), stored)) : null;
      const hasNew = JSON.stringify(value, (k, v) => (k === '$new' ? 'new' : v)).includes('"$new"');
      if (stored && !hasNew && same(before, value)) continue;
      if (stored && before === null && (value === null || (Array.isArray(value) && !value.length))) continue;
      body[route] = value;
      changes.push({ field: route, from: refLabels(leaf, before), to: display !== undefined ? display : value });
    }
    return { body, changes };
  }

  for (const action of actions) {
    const { def, record } = action;
    const where = `${def.title} ${action.label}${rowsNote(record)}`;
    const extra = {};
    if (def.key === 'discountSchedules' && record.tiers !== undefined) Object.assign(extra, tiersToSettings(record.tiers, where, blockers, warnings));
    const merged = { ...record, ...extra };
    if (!action.existing && def.code && record[def.code] === undefined && action.key.startsWith('name:')) delete merged[def.code];
    // eslint-disable-next-line no-await-in-loop
    const { body, changes } = await buildBody(def.model, merged, action.existing, where);
    action.body = body;
    action.changes = changes;
    action.type = action.existing ? (Object.keys(body).length ? 'update' : 'unchanged') : 'create';
    checkRecord(action, { blockers, warnings, existingTaxes: existing.Tax.byId });
  }

  // 4. Price-list entries: one per product and price list (the server's unique pair).
  const entryActions = [];
  const productActions = actions.filter((a) => a.section === 'products');
  const productIds = productActions.filter((a) => a.existing).map((a) => String(a.existing._id));
  const storedEntries = await listIn(client, 'pricebookentry', 'product', productIds);
  const entryByPair = new Map(storedEntries.map((e) => [`${e.pricebook}|${e.product}`, e]));
  const planEntryCodes = [];
  for (const pa of productActions) {
    const list = pa.record.entries === undefined ? [] : pa.record.entries;
    if (!Array.isArray(list)) {
      blockers.push(`Product ${pa.label}: "entries" must be a list.`);
      continue;
    }
    const pairs = new Set();
    for (const [i, entry] of list.entries()) {
      const where = `Price of ${pa.label}${rowsNote(entry && entry._rows ? entry : pa.record)}`;
      if (!entry || typeof entry !== 'object') {
        blockers.push(note(where, `entry ${i} is not an object.`));
        continue;
      }
      if (entry.product !== undefined) {
        blockers.push(note(where, `leave "product" out of an entry; it belongs to the product it is listed under.`));
        continue;
      }
      if (isBlankValue(entry.pricebook)) {
        blockers.push(note(where, `say which price list ("pricebook": code or name).`));
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const pb = await resolveRef('Pricebook', entry.pricebook, where);
      if (pb.value === undefined) continue;
      const pbKey = typeof pb.value === 'string' ? pb.value : `new:${pb.value.$new.key}`;
      if (pairs.has(pbKey)) {
        blockers.push(note(where, `the price list ${pb.display || entry.pricebook} is listed twice for this product. A product has one price per price list.`));
        continue;
      }
      pairs.add(pbKey);
      const stored = pa.existing && typeof pb.value === 'string' ? entryByPair.get(`${pb.value}|${pa.existing._id}`) || null : null;
      const record = { ...entry };
      delete record.pricebook;
      if (entry.taxRates !== undefined) {
        if (entry.taxes !== undefined) blockers.push(note(where, `use "taxes" or "taxRates", not both.`));
        // eslint-disable-next-line no-await-in-loop
        record.taxes = await taxesForRates(entry.taxRates, where);
      }
      const label2 = `${pa.label} in ${pb.display || entry.pricebook}`;
      // eslint-disable-next-line no-await-in-loop
      const { body, changes } = await buildBody('PricebookEntry', record, stored, `Price of ${label2}${rowsNote(entry._rows ? entry : pa.record)}`);
      const action = {
        section: 'entries', def: ENTRY, record: entry, existing: stored, product: pa, pricebook: pb, label: label2, body, changes,
      };
      action.type = stored ? (Object.keys(body).length ? 'update' : 'unchanged') : 'create';
      if (entry.pricebookEntryCode !== undefined) planEntryCodes.push({ code: String(entry.pricebookEntryCode), action });
      checkEntry(action, { blockers, warnings, existing, planIndex });
      entryActions.push(action);
    }
  }
  if (planEntryCodes.length) {
    const taken = await listIn(client, 'pricebookentry', 'pricebookEntryCode', planEntryCodes.map((c) => c.code));
    for (const { code, action } of planEntryCodes) {
      const other = taken.find((e) => String(e.pricebookEntryCode) === code && (!action.existing || String(e._id) !== String(action.existing._id)));
      if (other) blockers.push(`Price of ${action.label}: the entry code ${code} is already used by another price-list entry.`);
    }
  }

  // Taxes given as rates (from a spreadsheet's "VAT %" column) map to the one tax with that rate.
  async function taxesForRates(rates, where) {
    const list = toList(rates) || [];
    const ids = [];
    for (const raw of list) {
      const rate = toNumber(raw);
      if (rate === undefined) {
        blockers.push(note(where, `tax rate "${raw}" is not a number.`));
        continue;
      }
      if (rate === 0) continue;
      const fromPlan = (plan.taxes || []).map((t, i) => ({ t, i })).filter(({ t }) => toNumber(t.rate) === rate);
      const stored = [...existing.Tax.byId.values()].filter((t) => t.rate === rate);
      const options = fromPlan.length ? fromPlan.map(({ t }) => t.taxCode || t.taxName) : stored.map((t) => String(t._id));
      if (options.length === 1) ids.push(options[0]);
      else if (!options.length) blockers.push(note(where, `no tax has the rate ${rate} (${Math.round(rate * 10000) / 100}%). Add it under "taxes" with the name the user wants, or pick an existing one.`));
      else blockers.push(note(where, `${options.length} taxes have the rate ${rate}: ${stored.map((t) => `${t.taxName} (${t.taxCode})`).join(', ')}. Say which one in "taxes".`));
    }
    return ids;
  }

  // refId on products: text only, and unique among products (the server rejects a second one).
  const refIds = productActions.filter((a) => a.body.refId !== undefined && a.body.refId !== null).map((a) => a);
  if (refIds.length) {
    const holders = await listIn(client, 'product', 'refId', refIds.map((a) => String(a.body.refId)), '_id productCode refId');
    for (const a of refIds) {
      const other = holders.find((h) => String(h.refId) === String(a.body.refId) && (!a.existing || String(h._id) !== String(a.existing._id)));
      if (other) blockers.push(`Product ${a.label}: refId "${a.body.refId}" already belongs to product ${other.productCode}. Products cannot share a refId.`);
    }
  }

  for (const [model, routes] of ignoredColumns) {
    warnings.push(`Columns that are not fields of ${model} were ignored, as the app's import does: ${[...routes].join(', ')}.`);
  }
  const all = [...actions, ...entryActions];
  const version = versionOf(plan, all);
  return {
    actions: all, blockers: grouped(blockers), warnings: grouped(warnings), version, schemas,
  };
}

// Discount tiers in plain form → the server's formulaSettings.tiers.segments.
function tiersToSettings(tiers, where, blockers, warnings) {
  if (!Array.isArray(tiers) || !tiers.length) {
    blockers.push(note(where, `"tiers" must be a non-empty list of {from, to, rate}.`));
    return {};
  }
  const segments = [];
  for (const t of tiers) {
    const from = t.from === undefined ? undefined : toNumber(t.from);
    const to = t.to === undefined || t.to === null ? undefined : toNumber(t.to);
    const rate = toNumber(t.rate);
    if (rate === undefined || rate < 0 || rate > 1) {
      blockers.push(note(where, `tier rate ${t.rate} must be a decimal between 0 and 1 (10% is 0.1).`));
      continue;
    }
    if (!from || from < 1) {
      blockers.push(note(where, `every tier needs "from" of 1 or more (a tier from 0 never applies).`));
      continue;
    }
    if (to !== undefined && to < from) {
      blockers.push(note(where, `tier ${from}–${to} ends before it starts.`));
      continue;
    }
    segments.push({ from, to, segmentDiscountRate: rate });
  }
  const sorted = [...segments].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    if (prev.to === undefined || prev.to >= sorted[i].from) warnings.push(note(where, `tiers overlap at ${sorted[i].from}; the first one listed wins.`));
  }
  return { formula: 'tiers', formulaSettings: { tiers: { segments: segments.map((s) => (s.to === undefined ? { from: s.from, segmentDiscountRate: s.segmentDiscountRate } : s)) } } };
}

function checkRecord(action, { blockers, warnings, existingTaxes = new Map() }) {
  const { def, body, record, existing } = action;
  const where = `${def.title} ${action.label}${rowsNote(record)}`;
  const finalValue = (field) => (field in body ? body[field] : existing ? existing[field] : undefined);
  if (action.type === 'create' && def.name && isBlankValue(record[def.name])) blockers.push(note(where, `a new record needs "${def.name}".`));
  if (def.key === 'taxes') {
    const rate = finalValue('rate');
    if (action.type === 'create' && rate === undefined) blockers.push(note(where, `a new tax needs "rate" (a decimal: 19% is 0.19).`));
    if (typeof rate === 'number' && (rate === 0)) blockers.push(note(where, `a 0% tax breaks every quote that uses it. For exempt products leave the taxes empty.`));
    if (typeof rate === 'number' && Math.abs(rate) > 1) blockers.push(note(where, `rate ${rate} means ${rate * 100}%. Rates are decimals: 19% is 0.19.`));
    const twins = action.type === 'create' && typeof rate === 'number'
      ? [...existingTaxes.values()].filter((t) => t.rate === rate) : [];
    if (twins.length) {
      warnings.push(note(where, `a tax with rate ${rate} already exists: ${twins.map((t) => `${t.taxName} (${t.taxCode})`).join(', ')}. Offer to use it instead of creating a second one.`));
    }
  }
  if (def.key === 'pricebooks') {
    const from = finalValue('validFrom');
    const to = finalValue('validTo');
    if (from && to && new Date(from) > new Date(to)) blockers.push(note(where, `validFrom is after validTo.`));
    if (to && new Date(to) < new Date()) warnings.push(note(where, `valid only until ${String(to).slice(0, 10)}; its prices cannot be quoted after that date.`));
    if (from && new Date(from) > new Date()) warnings.push(note(where, `valid from ${String(from).slice(0, 10)}; its prices cannot be quoted before that date.`));
    if ('discountSchedule' in body && body.discountSchedule) warnings.push(note(where, `a discount schedule on the price list is stored but not applied by the quote calculation. Put it on each price ("discountSchedules" of the entry).`));
    if (finalValue('active') === false) warnings.push(note(where, `an inactive price list cannot be quoted.`));
  }
  if (def.key === 'coupons') {
    warnings.push(note(where, `coupons are only redeemed when an account signs up for a subscription; they never discount a deal's quote.`));
    const type = finalValue('discountType') || 'percentage';
    const value = finalValue('discountValue');
    if (action.type === 'create' && value === undefined) blockers.push(note(where, `a new coupon needs "discountValue".`));
    if (type === 'percentage' && typeof value === 'number' && value > 100) blockers.push(note(where, `a percentage coupon is 0–100 (15% is 15).`));
    if (type === 'percentage' && typeof value === 'number' && value > 0 && value <= 1) warnings.push(note(where, `discountValue ${value} means ${value}%, not ${value * 100}%: coupons take whole percentages.`));
    if (finalValue('duration') === 'repeating' && !finalValue('durationInMonths')) blockers.push(note(where, `a repeating coupon needs "durationInMonths".`));
    const from = finalValue('validFrom');
    const to = finalValue('validTo');
    if (from && to && new Date(from) > new Date(to)) blockers.push(note(where, `validFrom is after validTo.`));
  }
  if (def.key === 'products') {
    if ('refId' in body && typeof record.refId === 'number') warnings.push(note(where, `refId ${record.refId} is saved as text, as external ids must be.`));
    if (finalValue('active') === false) warnings.push(note(where, `an inactive product cannot be quoted.`));
    if ('rules' in body && body.rules && body.rules.length) warnings.push(note(where, `product rules are checked on every quote with this product; a price's own rules replace them.`));
  }
}

function checkEntry(action, { blockers, warnings, existing, planIndex }) {
  const { body, existing: stored, record } = action;
  const where = `Price of ${action.label}${rowsNote(record._rows ? record : action.product.record)}`;
  const finalValue = (field) => (field in body ? body[field] : stored ? stored[field] : undefined);
  if (action.type === 'create') {
    if (!('currency' in body)) blockers.push(note(where, `say the currency of this price. Without it the server silently uses the account's default currency, which may not be the one your user sees.`));
    if (!('price' in body) && finalValue('pricingMethod') !== 'Percent Of Total') warnings.push(note(where, `no price given; it is saved as 0.`));
  }
  const price = finalValue('price');
  if (typeof price === 'number' && price < 0) warnings.push(note(where, `the price is negative.`));
  const discount = finalValue('discountAmount');
  if (typeof price === 'number' && typeof discount === 'number' && discount > price) warnings.push(note(where, `the list discount (${discount}) is larger than the price (${price}).`));
  if (finalValue('pricingMethod') === 'Percent Of Total') {
    if (!finalValue('percentOfTotal') || !finalValue('percentOfTotalBase')) blockers.push(note(where, `a "Percent Of Total" price needs percentOfTotal (decimal) and percentOfTotalBase (subTotal, netTotal or total).`));
    if (typeof price === 'number' && price !== 0) warnings.push(note(where, `with "Percent Of Total" the server sets the price to 0.`));
  }
  const pot = finalValue('percentOfTotal');
  if (typeof pot === 'number' && pot > 1) blockers.push(note(where, `percentOfTotal ${pot} is a decimal (10% is 0.1).`));
  // Taxes must exist with a non-zero numeric rate, or every quote with this price fails.
  const taxes = 'taxes' in body ? body.taxes : stored ? stored.taxes : [];
  for (const t of taxes || []) {
    if (t && t.$new) {
      const rate = toNumber(t.$new.record.rate);
      if (!rate) blockers.push(note(where, `tax ${t.$new.label} has no usable rate.`));
      continue;
    }
    const tax = existing.Tax.byId.get(String(t));
    if (!tax) blockers.push(note(where, `tax ${t} does not exist.`));
    else {
      const planTax = planIndex.Tax.byCode.get(String(tax.taxCode));
      const rate = planTax && 'rate' in planTax.body ? planTax.body.rate : tax.rate;
      if (typeof rate !== 'number' || rate === 0) blockers.push(note(where, `tax ${tax.taxName} has rate ${rate}; quotes with this price would fail. Exempt products have no tax.`));
    }
  }
  const pbStored = typeof action.pricebook.value === 'string' ? existing.Pricebook.byId.get(action.pricebook.value) : null;
  if (pbStored && pbStored.active === false) warnings.push(note(where, `the price list ${pbStored.pricebookName} is inactive; this price cannot be quoted.`));
  if (finalValue('active') === false) warnings.push(note(where, `an inactive price cannot be quoted.`));
}

function versionOf(plan, actions) {
  const state = actions.map((a) => [a.section, a.existing ? String(a.existing._id) : null, a.existing ? a.existing.updatedAt : null]);
  return crypto.createHash('sha256').update(JSON.stringify([plan, state])).digest('hex').slice(0, 16);
}

// ─── Summary ───────────────────────────────────────────────────────────────────

function display(value) {
  if (value && typeof value === 'object' && value.$new) return `(new) ${value.$new.label}`;
  if (Array.isArray(value)) return value.map(display);
  return value;
}

function summarize(result) {
  const counts = {};
  for (const a of result.actions) {
    counts[a.section] = counts[a.section] || { create: 0, update: 0, unchanged: 0 };
    counts[a.section][a.type] += 1;
  }
  const changes = result.actions.filter((a) => a.type !== 'unchanged').map((a) => ({
    section: a.section,
    action: a.type,
    record: a.label,
    fields: Object.fromEntries(a.changes.map((c) => [c.field, a.type === 'create' ? display(c.to) : { from: c.from, to: display(c.to) }])),
  }));
  return { counts, changes };
}

function writeDetail(result, summary, rootDir) {
  try {
    const file = tempOut(null, `prolibu-catalog-preview-${result.version}.json`, rootDir);
    fs.writeFileSync(file, JSON.stringify({ ...summary, blockers: result.blockers, warnings: result.warnings }, null, 2));
    return file;
  } catch {
    return undefined;
  }
}

function capped(list, n = SHOW_LIMIT) {
  return list.length > n ? [...list.slice(0, n), `… and ${list.length - n} more (see detailFile)`] : list;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readJsonArg(planArg, ctx.rootDir, 'plan');
  const result = await analyze(client, plan);
  const summary = summarize(result);
  const detailFile = writeDetail(result, summary, ctx.rootDir);
  return {
    domain: client.domain,
    counts: summary.counts,
    changes: capped(summary.changes),
    blockers: capped(result.blockers),
    warnings: capped(result.warnings),
    detailFile,
    version: result.version,
    nextStep: result.blockers.length
      ? 'Blocked: explain each blocker to the user in plain words; fix the plan and preview again. Nothing was written.'
      : 'Tell the user the counts, the changes to existing records and every warning. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version.',
  };
}

function resolveNew(value) {
  if (value && typeof value === 'object' && value.$new) {
    if (!value.$new.createdId) throw new Blocked(`${value.$new.label} was not created, so it cannot be referenced.`);
    return value.$new.createdId;
  }
  if (Array.isArray(value)) return value.map(resolveNew);
  return value;
}

function nest(flat) {
  const out = {};
  for (const [route, value] of Object.entries(flat)) {
    const parts = route.split('.');
    let node = out;
    parts.slice(0, -1).forEach((p) => { node[p] = node[p] || {}; node = node[p]; });
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readJsonArg(planArg, ctx.rootDir, 'plan');
  const result = await analyze(client, plan);
  if (result.version !== flags.version) throw new Blocked('The account or the plan changed since the preview. Preview again and show the user.');
  if (result.blockers.length) throw new Blocked(result.blockers.join(' '));

  const written = [];
  const ordered = [...SECTIONS.map((s) => s.key), 'entries'];
  const todo = result.actions.filter((a) => a.type !== 'unchanged')
    .sort((a, b) => ordered.indexOf(a.section) - ordered.indexOf(b.section));
  for (const action of todo) {
    let body;
    try {
      body = {};
      for (const [route, value] of Object.entries(action.body)) body[route] = resolveNew(value);
      if (action.section === 'entries' && action.type === 'create') {
        body.product = action.product.existing ? String(action.product.existing._id) : action.product.createdId;
        body.pricebook = resolveNew(action.pricebook.value);
      }
      const nested = nest(body);
      // eslint-disable-next-line no-await-in-loop
      const saved = action.type === 'create'
        ? await call(client, 'POST', `/v2/${action.def.object}`, { data: nested, confirmed: true })
        : await call(client, 'PATCH', `/v2/${action.def.object}/${action.existing._id}`, { data: nested, confirmed: true });
      action.createdId = String(saved._id || (action.existing && action.existing._id));
      action.sent = body;
      written.push(action);
    } catch (err) {
      if (err instanceof Blocked) throw err;
      return {
        saved: false,
        written: written.map(brief),
        failed: { ...brief(action), error: err.serverMessage || err.message, status: err.status },
        notWritten: todo.length - written.length - 1,
        nextStep: 'Stop. Tell the user what was written and the error. After fixing the cause, run preview again: records already written show as unchanged.',
      };
    }
  }

  const problems = await readBack(client, written, result.schemas);
  const check = await checkQuotable(client, written.filter((a) => a.section === 'entries').map((a) => a.createdId));
  return {
    saved: problems.length === 0,
    written: capped(written.map(brief)),
    counts: summarize(result).counts,
    problems: capped(problems),
    quotable: check,
  };
}

function brief(action) {
  return {
    section: action.section, action: action.type, record: action.label, _id: action.createdId || (action.existing && String(action.existing._id)),
  };
}

async function readBack(client, written, schemas) {
  const problems = [];
  const byObject = new Map();
  for (const a of written) {
    if (!byObject.has(a.def.object)) byObject.set(a.def.object, []);
    byObject.get(a.def.object).push(a);
  }
  for (const [object, list] of byObject) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await listIn(client, object, '_id', list.map((a) => a.createdId));
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    for (const a of list) {
      const row = byId.get(a.createdId);
      if (!row) {
        problems.push(`${a.label}: not found after saving.`);
        continue;
      }
      for (const [route, value] of Object.entries(a.sent)) {
        const leaf = leafAt(schemas[a.def.model], route);
        if (!leaf) continue;
        const stored = route.split('.').reduce((o, p) => (o ? o[p] : undefined), row);
        const { base } = leafType(leaf);
        const norm = (v) => {
          if (v === undefined || v === null) return null;
          if (Array.isArray(v)) return v.map((x) => (x && x._id ? String(x._id) : base === 'objectid' ? String(x) : x));
          if (base === 'date') return new Date(v).toISOString();
          if (base === 'objectid') return String(v && v._id ? v._id : v);
          return v;
        };
        if (!same(norm(stored), norm(value))) problems.push(`${a.label}: ${route} saved as ${JSON.stringify(stored)}, sent ${JSON.stringify(value)}.`);
      }
      if (a.section === 'entries' && a.sent.pricingMethod !== 'Percent Of Total' && typeof row.price === 'number'
        && typeof row.netUnitPrice === 'number' && money(row.netUnitPrice) !== money(row.price - (row.discountAmount || 0))) {
        problems.push(`${a.label}: net unit price ${row.netUnitPrice} does not match price minus list discount.`);
      }
    }
  }
  return problems;
}

// Builds each price's quote line the way the quote editor does and prices one unit, so a
// price that cannot be quoted (inactive, out of its dates, a broken tax) shows up now.
async function checkQuotable(client, entryIds, quantities = [1]) {
  const ids = [...new Set(entryIds)];
  const checked = ids.slice(0, CHECK_LIMIT);
  const lines = [];
  const notQuotable = [];
  for (const id of checked) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const line = await call(client, 'GET', `/v2/quote/formatLineItem?${new URLSearchParams({ pricebookEntryId: id })}`);
      lines.push({ id, line });
    } catch (err) {
      notQuotable.push({ pricebookEntryId: id, reason: err.serverMessage || err.message });
    }
  }
  const results = [];
  const priced = new Set();
  const byCurrency = new Map();
  for (const l of lines) {
    const cur = l.line.currency || 'none';
    if (!byCurrency.has(cur)) byCurrency.set(cur, []);
    byCurrency.get(cur).push(l);
  }
  async function price(group) {
    const sentLines = group.flatMap((l) => quantities.map((quantity) => ({
      id: l.id, line: { ...l.line, uuid: crypto.randomUUID(), quantity },
    })));
    const quote = { quoteCurrency: group[0].line.currency, lineItems: sentLines.map((x) => x.line) };
    const calculated = await call(client, 'PUT', '/v2/quote/calculate', { data: quote });
    const byUuid = new Map((calculated.lineItems || []).map((li) => [li.uuid, li]));
    for (const { id, line: sent } of sentLines) {
      const li = byUuid.get(sent.uuid) || {};
      const total = money(li.total);
      if (total === null) {
        notQuotable.push({ pricebookEntryId: id, product: sent.productName, reason: 'the line total is not a number (missing price)' });
        continue;
      }
      const row = {
        product: sent.productName, currency: li.currency, quantity: sent.quantity, unitPrice: money(li.netUnitPrice), tax: money(li.netTotalTaxAmount), total,
      };
      if (typeof li.price === 'number' && money(li.specialPrice) !== null && money(li.specialPrice) !== money(li.price)) {
        row.listPrice = money(li.price);
        row.volumeDiscountedPrice = money(li.specialPrice);
      }
      results.push(row);
      priced.add(id);
    }
  }
  for (const group of byCurrency.values()) {
    for (const part of chunk(group, 20)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await price(part);
      } catch {
        for (const single of part) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await price([single]);
          } catch (err) {
            notQuotable.push({ pricebookEntryId: single.id, product: single.line.productName, reason: err.serverMessage || err.message });
          }
        }
      }
    }
  }
  return {
    checked: checked.length,
    of: ids.length,
    quotable: priced.size,
    samples: results.slice(0, quantities.length > 1 ? 30 : 10),
    notQuotable,
  };
}

async function cmdProduct(client, [code], flags) {
  if (!code) throw new UsageError('Usage: product <domain> <productCode> [--quantity 1,10,50]');
  const quantities = flags.quantity ? String(flags.quantity).split(',').map((q) => Number(q.trim())) : [1];
  if (quantities.some((q) => !Number.isFinite(q) || q <= 0) || quantities.length > 10) {
    throw new UsageError('--quantity takes up to 10 positive numbers separated by commas.');
  }
  const found = await listIn(client, 'product', 'productCode', [String(code)]);
  if (!found.length) {
    const params = new URLSearchParams({ term: String(code), limit: '10' });
    const search = await call(client, 'GET', `/v2/product/search?${params}`);
    return {
      found: false,
      didYouMean: (search.data || []).map((p) => ({ productCode: p.productCode, productName: p.productName, active: p.active })),
    };
  }
  const product = found[0];
  const entries = await listIn(client, 'pricebookentry', 'product', [String(product._id)]);
  const pricebooks = await listIn(client, 'pricebook', '_id', entries.map((e) => String(e.pricebook)), '_id pricebookCode pricebookName active validFrom validTo');
  const taxes = await listIn(client, 'tax', '_id', entries.flatMap((e) => (e.taxes || []).map(String)), '_id taxCode taxName rate');
  const pbById = new Map(pricebooks.map((p) => [String(p._id), p]));
  const taxById = new Map(taxes.map((t) => [String(t._id), t]));
  const named = async (model, ids) => {
    const def = BY_MODEL[model];
    const list = [].concat(ids || []).filter(Boolean).map(String);
    if (!list.length) return Array.isArray(ids) ? [] : null;
    const rows = await listIn(client, def.object, '_id', list, `_id ${def.code} ${def.name}`);
    const names = list.map((x) => {
      const r = rows.find((row) => String(row._id) === x);
      return r ? label(def, r) : `missing ${x}`;
    });
    return Array.isArray(ids) ? names : names[0];
  };
  const check = await checkQuotable(client, entries.filter((e) => e.active !== false).map((e) => String(e._id)), quantities);
  return {
    found: true,
    product: {
      _id: product._id,
      productCode: product.productCode,
      productName: product.productName,
      active: product.active,
      productFamily: await named('ProductFamily', product.productFamily),
      productCategories: await named('ProductCategory', product.productCategories || []),
      productGroup: await named('ProductGroup', product.productGroup),
      refId: product.refId,
      updatedAt: product.updatedAt,
    },
    prices: entries.map((e) => {
      const pb = pbById.get(String(e.pricebook)) || {};
      return {
        pricebookEntryId: e._id,
        pricebook: pb.pricebookName ? `${pb.pricebookName} (${pb.pricebookCode})` : `missing price list ${e.pricebook}`,
        pricebookActive: pb.active,
        validFrom: pb.validFrom,
        validTo: pb.validTo,
        currency: e.currency,
        price: e.price,
        cost: e.cost,
        discountAmount: e.discountAmount,
        taxes: (e.taxes || []).map((t) => {
          const tax = taxById.get(String(t));
          return tax ? `${tax.taxName} (${tax.rate})` : `missing tax ${t}`;
        }),
        discountSchedules: e.discountSchedules,
        active: e.active,
      };
    }),
    quotable: check,
  };
}

const FIND_OBJECTS = Object.fromEntries([...SECTIONS, LOOKUP_ONLY.ProductRule].map((d) => [d.object, d]));

async function cmdFind(client, [object, ...termParts]) {
  const def = FIND_OBJECTS[String(object || '').toLowerCase()];
  const term = termParts.join(' ').trim();
  if (!def) throw new UsageError(`Usage: find <domain> <object> <code, name or _id>. Objects: ${Object.keys(FIND_OBJECTS).join(', ')}.`);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let xquery;
  const asRate = /^\d+([.,]\d+)?\s*%?$/.test(term) ? toNumber(term.replace('%', '')) : undefined;
  if (ID_RE.test(term)) xquery = { _id: term };
  else if (def.object === 'tax' && asRate !== undefined) {
    // "19", "19%" and "0.19" all mean the same tax rate.
    xquery = { rate: term.includes('%') || asRate > 1 ? Math.round(asRate * 1e6) / 1e8 : asRate };
  }
  else if (term) xquery = { $or: [{ [def.code]: { $regex: `(?i)${escaped}` } }, { [def.name]: { $regex: `(?i)${escaped}` } }] };
  const params = new URLSearchParams({ limit: '50', sort: def.name });
  if (xquery) params.set('xquery', JSON.stringify(xquery));
  const body = await call(client, 'GET', `/v2/${def.object}?${params}`);
  const pick = ['_id', def.code, def.name, 'active', 'rate', 'validFrom', 'validTo', 'discountType', 'discountValue', 'formula', 'workspace'];
  return {
    object: def.object,
    count: body.pagination ? body.pagination.count : (body.data || []).length,
    data: (body.data || []).map((r) => Object.fromEntries(pick.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))),
  };
}

// ─── Spreadsheets ──────────────────────────────────────────────────────────────

function cmdSheet([file], flags, ctx) {
  if (!file) throw new UsageError('Usage: sheet <file.xlsx|file.csv> [--sheet <name>] [--rows <n>]');
  assertSheetAllowed(file, ctx.rootDir);
  const sheets = sheetReader.readWorkbook(file);
  const rowsWanted = flags.rows ? Number(flags.rows) : 5;
  const picked = flags.sheet ? sheets.filter((s) => s.name === flags.sheet) : sheets;
  if (flags.sheet && !picked.length) throw new UsageError(`No sheet named "${flags.sheet}". Sheets: ${sheets.map((s) => s.name).join(', ')}.`);
  return {
    file: path.basename(file),
    sheets: picked.map((s) => {
      const { headers, rows } = sheetReader.sheetRows(s, flags.headerRow ? Number(flags.headerRow) : 1);
      return {
        name: s.name, headers, rowCount: rows.length, firstRows: rows.slice(0, rowsWanted),
      };
    }),
    datamap: sheets.some((s) => s.name === 'datamap'),
  };
}

// The value of one mapped field in a row. `replace` turns the spreadsheet's words into
// what the account uses: {"Familia": {"Bebidas": "alimentos-y-bebidas"}}.
function cell(row, spec, replace = {}) {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec === 'object' && !Array.isArray(spec) && 'value' in spec) return spec.value;
  let column;
  if (typeof spec === 'object' && !Array.isArray(spec) && 'column' in spec) column = spec.column;
  else if (typeof spec === 'string') column = spec;
  else throw new UsageError(`Mapping value ${JSON.stringify(spec)} must be a column name or {"value": …}.`);
  const value = row.values[column];
  const table = replace[column];
  if (!table || value === undefined) return value;
  const key = Object.keys(table).find((k) => normName(k) === normName(value));
  return key === undefined ? value : table[key];
}

function columnsOf(spec) {
  if (typeof spec === 'string') return [spec];
  if (spec && typeof spec === 'object' && 'column' in spec) return [spec.column];
  return [];
}

const LIST_FIELDS = new Set(['productCategories', 'taxes', 'discountSchedules', 'includedProducts', 'rules', 'specialNotes', 'internalNotes']);
const CREATABLE = { productFamily: ['families', 'productFamilyName'], productCategories: ['categories', 'productCategoryName'], productGroup: ['groups', 'productGroupName'] };

function fromMapping(sheets, mapping, problems) {
  const sheet = mapping.sheet ? sheets.find((s) => s.name === mapping.sheet) : sheets[0];
  if (!sheet) throw new UsageError(`No sheet named "${mapping.sheet}".`);
  const { headers, rows } = sheetReader.sheetRows(sheet, mapping.headerRow || 1);
  if (!mapping.product || typeof mapping.product !== 'object' || !mapping.product.productCode) {
    throw new UsageError('The mapping needs "product" with at least "productCode": "<column>".');
  }
  const entrySpecs = mapping.entries === undefined ? [] : mapping.entries;
  if (!Array.isArray(entrySpecs)) throw new UsageError('"entries" in the mapping must be a list.');
  const used = [...Object.values(mapping.product), ...entrySpecs.flatMap((e) => Object.values(e))].flatMap(columnsOf);
  const missing = [...new Set(used)].filter((c) => !headers.includes(c));
  if (missing.length) throw new UsageError(`These columns are not in the sheet: ${missing.join(', ')}. Columns: ${headers.join(', ')}.`);

  // A tax-rate column is read as percentages when any value is above 1 (19 → 0.19).
  const percentColumns = new Set();
  for (const spec of entrySpecs) {
    for (const col of columnsOf(spec.taxRate)) {
      if (rows.some((r) => { const n = toNumber(String(r.values[col] ?? '').replace('%', '')); return n !== undefined && n > 1; })) percentColumns.add(col);
    }
  }
  const toRate = (raw, col) => {
    const text = String(raw).trim();
    const isPercent = text.endsWith('%') || percentColumns.has(col);
    const n = toNumber(text.replace('%', ''));
    if (n === undefined) return undefined;
    return isPercent ? Math.round(n * 1e6) / 1e8 : n;
  };

  const products = new Map();
  const created = { families: new Map(), categories: new Map(), groups: new Map() };
  const createWanted = mapping.create || {};
  for (const row of rows) {
    const replace = mapping.replace || {};
    const rawCode = cell(row, mapping.product.productCode, replace);
    if (isBlankValue(rawCode)) {
      problems.push(`Row ${row.rowNumber}: no product code; the row was left out.`);
      continue;
    }
    const code = String(rawCode).trim();
    const product = {};
    for (const [field, spec] of Object.entries(mapping.product)) {
      const value = cell(row, spec, replace);
      if (isBlankValue(value)) continue;
      product[field] = LIST_FIELDS.has(field) ? toList(value) : value;
      if (CREATABLE[field] && createWanted[field]) {
        const [section, nameField] = CREATABLE[field];
        for (const name of [].concat(product[field])) {
          const key = normName(name);
          if (!created[section].has(key)) created[section].set(key, { [nameField]: String(name).trim() });
        }
      }
    }
    product.productCode = code;
    const entries = [];
    for (const spec of entrySpecs) {
      const entry = {};
      let hasPrice = false;
      for (const [field, s] of Object.entries(spec)) {
        const value = cell(row, s, replace);
        if (isBlankValue(value)) continue;
        if (field === 'taxRate') {
          const rates = toList(String(value)).map((v) => toRate(v, columnsOf(s)[0]));
          if (rates.some((r) => r === undefined)) problems.push(`Row ${row.rowNumber}: tax rate "${value}" is not a number.`);
          else entry.taxRates = rates;
        } else entry[field] = LIST_FIELDS.has(field) ? toList(value) : value;
        if (!['pricebook', 'currency'].includes(field)) hasPrice = true;
      }
      if (!hasPrice) continue;
      entry._rows = [row.rowNumber];
      entries.push(entry);
    }
    if (!products.has(code)) {
      products.set(code, { ...product, entries, _rows: [row.rowNumber] });
      continue;
    }
    const prev = products.get(code);
    prev._rows.push(row.rowNumber);
    for (const [field, value] of Object.entries(product)) {
      if (prev[field] === undefined) prev[field] = value;
      else if (!same(prev[field], value)) problems.push(`Row ${row.rowNumber}: product ${code} has ${field} "${value}" here and "${prev[field]}" in row ${prev._rows[0]}; the first one is kept.`);
    }
    for (const entry of entries) {
      const twin = prev.entries.find((e) => String(e.pricebook) === String(entry.pricebook));
      if (!twin) prev.entries.push(entry);
      else {
        const a = { ...twin, _rows: undefined };
        const b = { ...entry, _rows: undefined };
        if (!same(a, b)) problems.push(`Row ${row.rowNumber}: product ${code} has a second, different price for price list "${entry.pricebook}" (first in row ${twin._rows[0]}); the first one is kept.`);
      }
    }
  }
  const plan = {};
  const include = mapping.include || {};
  if (typeof include !== 'object' || Array.isArray(include)) throw new UsageError('"include" in the mapping must be an object of plan sections.');
  for (const [section, list] of Object.entries(include)) {
    if (!SECTIONS.some((d) => d.key === section) || section === 'products') throw new UsageError(`"include" accepts ${SECTIONS.filter((d) => d.key !== 'products').map((d) => d.key).join(', ')}.`);
    if (!Array.isArray(list)) throw new UsageError(`include.${section} must be a list.`);
    plan[section] = [...list];
  }
  for (const section of ['families', 'categories', 'groups']) if (created[section].size) plan[section] = [...(plan[section] || []), ...created[section].values()];
  plan.products = [...products.values()].map((p) => (p.entries.length ? p : (({ entries, ...rest }) => rest)(p)));
  return { plan, sheet: sheet.name, rows: rows.length };
}

function fromDatamap(sheets, problems) {
  const datamap = sheets.find((s) => s.name === 'datamap');
  const { rows: mapRows } = sheetReader.sheetRows(datamap);
  const plan = {};
  const productsByCode = new Map();
  const loose = [];
  for (const mr of mapRows) {
    const { sheetName, objectType, skip, drop } = mr.values;
    if (toBool(skip ?? false) === true) continue;
    if (drop !== undefined && toBool(drop) !== false) {
      throw new Blocked(`The datamap asks to drop (wipe) every ${objectType} before loading (sheet "${sheetName}", column "drop"). This skill never deletes records: remove the drop column, or load it in the app knowing it erases the whole collection.`);
    }
    const section = DATAMAP_TYPES[String(objectType || '').toLowerCase()];
    if (!section) {
      problems.push(`Datamap row ${mr.rowNumber}: ${objectType} is not a catalog object; sheet "${sheetName}" was left out.`);
      continue;
    }
    const sheet = sheets.find((s) => s.name === sheetName);
    if (!sheet) {
      problems.push(`Datamap row ${mr.rowNumber}: sheet "${sheetName}" does not exist.`);
      continue;
    }
    let { rows } = sheetReader.sheetRows(sheet);
    const from = toNumber(mr.values.from ?? '');
    const to = toNumber(mr.values.to ?? '');
    if (from || to) rows = rows.slice((from || 1) - 1, to || rows.length);
    for (const row of rows) {
      const values = { ...row.values };
      if (toBool(values.skip ?? false) === true) continue;
      delete values.skip;
      if (section === 'entries') {
        const code = values.product;
        if (isBlankValue(code)) {
          problems.push(`Sheet ${sheetName} row ${row.rowNumber}: no product code; left out.`);
          continue;
        }
        delete values.product;
        loose.push({ code: String(code).trim(), entry: { ...values, _rows: [row.rowNumber], _datamap: true } });
      } else if (section === 'products') {
        const code = String(values.productCode ?? '').trim();
        if (!code) {
          problems.push(`Sheet ${sheetName} row ${row.rowNumber}: no productCode; left out.`);
          continue;
        }
        productsByCode.set(code, {
          ...values, productCode: code, _rows: [row.rowNumber], _datamap: true, entries: [],
        });
      } else {
        plan[section] = plan[section] || [];
        plan[section].push({ ...values, _rows: [row.rowNumber], _datamap: true });
      }
    }
  }
  for (const { code, entry } of loose) {
    if (!productsByCode.has(code)) productsByCode.set(code, { productCode: code, _datamap: true, entries: [] });
    productsByCode.get(code).entries.push(entry);
  }
  if (productsByCode.size) plan.products = [...productsByCode.values()].map((p) => (p.entries.length ? p : (({ entries, ...rest }) => rest)(p)));
  return { plan, sheet: 'datamap' };
}

function cmdFromSheet([file, mappingArg], flags, ctx) {
  if (!file) throw new UsageError('Usage: from-sheet <file> [\'<mapping json>\'] [--out <temp file>]');
  assertSheetAllowed(file, ctx.rootDir);
  const sheets = sheetReader.readWorkbook(file);
  const problems = [];
  let converted;
  if (mappingArg) converted = fromMapping(sheets, readJsonArg(mappingArg, ctx.rootDir, 'mapping'), problems);
  else if (sheets.some((s) => s.name === 'datamap')) converted = fromDatamap(sheets, problems);
  else throw new UsageError('Pass a mapping (which column is which field), or use a workbook with a "datamap" sheet.');
  const text = JSON.stringify(converted.plan, null, 2);
  const out = tempOut(flags.out, `prolibu-catalog-plan-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 10)}.json`, ctx.rootDir);
  fs.writeFileSync(out, text);
  const counts = Object.fromEntries(Object.entries(converted.plan).map(([k, v]) => [k, v.length]));
  counts.prices = (converted.plan.products || []).reduce((n, p) => n + (p.entries || []).length, 0);
  return {
    planFile: out,
    counts,
    problems: capped(problems),
    sample: (converted.plan.products || []).slice(0, 3),
    nextStep: problems.length
      ? 'Show the user the problems (rows left out or conflicting). Then run preview with planFile.'
      : 'Run preview with planFile.',
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valueFlags = {
    '--version': 'version', '--profile': 'profile', '--sheet': 'sheet', '--rows': 'rows', '--out': 'out', '--header-row': 'headerRow', '--quantity': 'quantity',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (valueFlags[arg]) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[valueFlags[arg]] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

const ACCOUNT_COMMANDS = {
  find: cmdFind, product: cmdProduct, preview: cmdPreview, apply: cmdApply,
};
const FILE_COMMANDS = { sheet: cmdSheet, 'from-sheet': cmdFromSheet };
const USAGE = 'Usage: catalog.js <find|product|preview|apply> <domain> … | catalog.js <sheet|from-sheet> <file> …';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, rest, flags } = parseCli(argv);
    let result;
    if (FILE_COMMANDS[command]) {
      result = FILE_COMMANDS[command](rest, flags, { rootDir });
    } else if (ACCOUNT_COMMANDS[command]) {
      const [domain, ...args] = rest;
      if (!domain) throw new UsageError(USAGE);
      client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
      result = await ACCOUNT_COMMANDS[command](client, args, flags, { rootDir });
    } else throw new UsageError(USAGE);
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
  main, toNumber, toBool, toList, tiersToSettings, fromMapping, fromDatamap, analyze,
};
