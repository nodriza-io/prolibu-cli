#!/usr/bin/env node
'use strict';

// Creates and updates prices (price-list entries) by the thousand through the account's
// importer, without overloading the shared database or hitting the per-key request limit.
//
//   bulk-prices.js preview <domain> <file.csv|file.xlsx|file.json> [--map '<json>'] [--sheet <name>]
//   bulk-prices.js preview <domain> --pricebooks <code,code> --factor <n> [--round <step>] [--fields price,cost]
//                                          [--include-inactive]
//   bulk-prices.js apply   <domain> --version <v> --confirmed [--chunk 100] [--pause-ms 500] [--max-rows <n>]
//
// preview reads the account once (price lists, products and taxes by code; the entries of the
// target price lists with a cursor on _id), checks every row, and saves the job in a temp
// folder under its version. apply re-reads the target price lists, skips rows already written
// (so it resumes after an interruption) and rows someone changed since the preview, and sends
// the rest to PUT /v2/service/importdata in sequential chunks, existing entries by _id.
// Every command accepts --profile <name>.
// Exit codes: 0 ok, 1 API error or rows not written, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
const sheetReader = require('./sheet-reader');
const { toNumber, toBool, toList } = require('./catalog');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const PAGE = 500;
const IN_BATCH = 100;
const DEFAULT_CHUNK = 100;
const MAX_CHUNK = 250;
const DEFAULT_PAUSE_MS = 500;
// The server answers 429 to a key once it made 2,500 calls without a full minute's gap
// between two of them. Stay well under it, then wait more than a minute.
const REQUEST_BUDGET = 2000;
const LIMIT_PAUSE_MS = 65000;
const MAX_ROWS = 200000;
const MAX_ENTRIES_READ = 400000;
const SAMPLE = 20;
const SHOW_ERRORS = 40;
const FACTOR_RANGE = [0.5, 2];
const FIELDS = ['currency', 'price', 'cost', 'discountAmount', 'taxes', 'active'];
const NUMBER_FIELDS = ['price', 'cost', 'discountAmount'];
const ENTRY_SELECT = '_id pricebook product pricebookEntryCode currency price cost discountAmount taxes active pricingMethod';
const MAP_KEYS = ['product', 'pricebook', 'price', 'currency', 'cost', 'discountAmount', 'taxes', 'taxRate', 'active', 'pricebookEntryCode'];

class Blocked extends Error {}

// ─── Small helpers ─────────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function idOf(value) {
  if (value && typeof value === 'object' && value._id) return String(value._id);
  return value === undefined || value === null ? value : String(value);
}

function sameValue(field, a, b) {
  if (field === 'taxes') {
    const norm = (v) => JSON.stringify([...(v || []).map(idOf)].sort());
    return norm(a) === norm(b);
  }
  if (NUMBER_FIELDS.includes(field)) return Number(a || 0) === Number(b || 0);
  if (field === 'active') return (a !== false) === (b !== false);
  return (a === undefined || a === null ? '' : String(a)) === (b === undefined || b === null ? '' : String(b));
}

function round(value, step) {
  if (!step) return Math.round(value * 100) / 100;
  return Math.round(Math.round(value / step) * step * 100) / 100;
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, header, rows, append = false) {
  const lines = rows.map((r) => header.map((h) => csvCell(r[h])).join(','));
  if (!append || !fs.existsSync(file)) fs.writeFileSync(file, `${header.join(',')}\n`);
  if (lines.length) fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function normHeader(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function jobsRoot() {
  return path.join(os.tmpdir(), 'prolibu-catalog-bulk');
}

function jobDir(version, root = jobsRoot()) {
  if (!/^[a-f0-9]{16}$/.test(String(version))) throw new UsageError('--version must be the 16-character version from preview.');
  return path.join(root, version);
}

function readJsonArg(arg, rootDir, what) {
  const text = String(arg || '').trim();
  if (!text) return undefined;
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new UsageError(`The ${what} is not valid JSON.`);
    }
  }
  assertDataFileAllowed(text, rootDir);
  try {
    return JSON.parse(fs.readFileSync(text, 'utf8'));
  } catch {
    throw new UsageError(`Cannot read the ${what} file ${arg}.`);
  }
}

// ─── API, paced ────────────────────────────────────────────────────────────────

// Every call of this run goes through here, one at a time. It pauses a full minute before the
// key reaches the server's limit, and once more (then retries the same call) on a 429: the
// server refuses a call with 429 before running it, so the retry cannot write twice.
function pacedApi(client, { sleep = defaultSleep, budget = REQUEST_BUDGET, stderr } = {}) {
  let sinceGap = 0;
  let total = 0;
  let pauses = 0;
  async function wait(reason) {
    pauses += 1;
    if (stderr) stderr.write(`Pausing 65 s (${reason}).\n`);
    await sleep(LIMIT_PAUSE_MS);
    sinceGap = 0;
  }
  async function request(method, reqPath, opts) {
    if (sinceGap >= budget) await wait(`${sinceGap} calls in a row; the key's limit is 2,500 without a minute's gap`);
    sinceGap += 1;
    total += 1;
    let res = await client.request(method, reqPath, opts);
    if (res.status === 429) {
      await wait('the server answered 429 Too many requests');
      sinceGap += 1;
      total += 1;
      res = await client.request(method, reqPath, opts);
    }
    return res;
  }
  return { request, stats: () => ({ calls: total, limitPauses: pauses }) };
}

function apiError(method, reqPath, res) {
  const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
  const err = new Error(`${method} ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
  err.status = res.status;
  return err;
}

async function getJson(api, reqPath) {
  const res = await api.request('GET', reqPath);
  if (!res.ok) throw apiError('GET', reqPath, res);
  return res.body;
}

// Every record matching `filter`, walking the _id index: sort=_id, and each next page asks for
// _id greater than the last one seen (inside $and, so the filter is kept as sent).
async function cursorAll(api, object, filter, select, cap = MAX_ENTRIES_READ) {
  const out = [];
  let last = null;
  for (;;) {
    const parts = [filter, last ? { _id: { $gt: last } } : null].filter(Boolean);
    const xquery = parts.length > 1 ? { $and: parts } : parts[0];
    const params = new URLSearchParams({ limit: String(PAGE), sort: '_id', select });
    if (xquery) params.set('xquery', JSON.stringify(xquery));
    const body = await getJson(api, `/v2/${object}?${params}`);
    const data = Array.isArray(body && body.data) ? body.data : [];
    out.push(...data);
    if (out.length > cap) throw new Blocked(`More than ${cap} ${object} records match; split the load.`);
    if (data.length < PAGE) break;
    last = data[data.length - 1]._id;
  }
  return out;
}

async function readIn(api, object, field, values, select) {
  const out = [];
  for (const part of chunk([...new Set(values)], IN_BATCH)) {
    out.push(...await cursorAll(api, object, { [field]: { $in: part } }, select));
  }
  return out;
}

async function loadCurrencies(api) {
  const me = await getJson(api, '/v2/user/me');
  const schema = me && me.modelSchemas && me.modelSchemas.PricebookEntry;
  if (!schema) throw new Blocked('The account has no PricebookEntry object (the pricing module may be off).');
  const leaf = schema.currency || {};
  return Array.isArray(leaf.enum) ? leaf.enum : null;
}

async function loadPricebooks(api, refs) {
  const ids = refs.filter((r) => ID_RE.test(r));
  const codes = refs.filter((r) => !ID_RE.test(r));
  const found = [];
  if (ids.length) found.push(...await readIn(api, 'pricebook', '_id', ids, '_id pricebookCode pricebookName active'));
  if (codes.length) found.push(...await readIn(api, 'pricebook', 'pricebookCode', codes, '_id pricebookCode pricebookName active'));
  const byRef = new Map();
  for (const pb of found) {
    byRef.set(String(pb._id), pb);
    byRef.set(pb.pricebookCode, pb);
  }
  return byRef;
}

async function loadEntries(api, pricebookIds) {
  if (!pricebookIds.length) return [];
  return cursorAll(api, 'pricebookentry', { pricebook: { $in: pricebookIds } }, ENTRY_SELECT);
}

// Who else reacts to every price saved: webhooks, lifecycle scripts and AI agent triggers run
// once per row in the importer too. A key that may not read them gets "unknown".
async function sideEffects(api) {
  const probe = async (object, filter) => {
    // heavy-read-ok: three fixed counts on small configuration objects, not one per group
    const params = new URLSearchParams({ limit: '1', select: '_id', xquery: JSON.stringify(filter) });
    const res = await api.request('GET', `/v2/${object}?${params}`);
    if (!res.ok) return 'unknown (this key may not read them)';
    return res.body && res.body.pagination ? res.body.pagination.count : (res.body.data || []).length;
  };
  return {
    webhooks: await probe('webhook', { $and: [{ active: true }, { eventNames: { $in: ['PricebookEntry.create', 'PricebookEntry.update', 'PricebookEntry.*'] } }] }),
    lifecycleScripts: await probe('script', { $and: [{ active: true }, { lifecycleHooks: { $in: ['PricebookEntry'] } }] }),
    agentTriggers: await probe('eventtrigger', { $and: [{ active: true }, { modelName: 'PricebookEntry' }] }),
  };
}

// Whether the key's user may create and change prices (an admin, or a role with both
// PricebookEntry permissions). null when the answer does not say.
async function writeAccess(api) {
  const res = await api.request('GET', '/v2/user/me');
  if (!res.ok || !res.body || typeof res.body !== 'object') return null;
  const me = res.body.profile || res.body;
  if (me.isAdmin === true) return true;
  const text = JSON.stringify(res.body);
  if (!text.includes('Resource@')) return null;
  return ['create', 'update'].every((a) => text.includes(`Resource@PricebookEntry.${a}`) || text.includes('Resource@PricebookEntry.*'));
}

// ─── Input rows ────────────────────────────────────────────────────────────────

function readInputFile(file, flags, rootDir) {
  const ext = path.extname(String(file)).toLowerCase();
  const resolved = path.resolve(file);
  const accounts = path.resolve(rootDir, 'accounts');
  if (resolved === accounts || resolved.startsWith(accounts + path.sep)) throw new UsageError('Files under accounts/ cannot be read.');
  if (!fs.existsSync(resolved)) throw new UsageError(`File not found: ${file}`);
  if (ext === '.json') {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch {
      throw new UsageError('The JSON file is not valid JSON.');
    }
    if (!Array.isArray(data)) throw new UsageError('The JSON file must be an array of rows.');
    return data.map((values, i) => ({ rowNumber: i + 1, values: values && typeof values === 'object' ? values : {} }));
  }
  if (!['.xlsx', '.xlsm', '.csv', '.txt'].includes(ext)) throw new UsageError('Only .xlsx, .csv and .json files can be read.');
  let sheets;
  try {
    sheets = sheetReader.readWorkbook(resolved);
  } catch (err) {
    throw new UsageError(err.message);
  }
  const sheet = flags.sheet ? sheets.find((s) => s.name === flags.sheet) : sheets[0];
  if (!sheet) throw new UsageError(`No sheet named ${flags.sheet}. Sheets: ${sheets.map((s) => s.name).join(', ')}`);
  return sheetReader.sheetRows(sheet).rows;
}

// The mapping says which column holds each field ({"value": x} = the same for every row).
// "wide" turns one row with a price column per price list into one row per list.
function mapRows(rows, mapping = {}) {
  for (const key of Object.keys(mapping)) {
    if (key !== 'wide' && !MAP_KEYS.includes(key)) throw new UsageError(`Unknown mapping key "${key}". Use: ${MAP_KEYS.join(', ')}, wide.`);
  }
  const lookup = (values, spec, field) => {
    if (spec && typeof spec === 'object' && 'value' in spec) return spec.value;
    const wanted = normHeader(typeof spec === 'string' ? spec : field);
    const key = Object.keys(values).find((k) => normHeader(k) === wanted);
    return key === undefined ? undefined : values[key];
  };
  const out = [];
  for (const row of rows) {
    const base = {};
    for (const field of MAP_KEYS) {
      if (mapping.wide && (field === 'pricebook' || field === 'price')) continue;
      const value = lookup(row.values, mapping[field], field);
      if (value !== undefined && !(typeof value === 'string' && !value.trim())) base[field] = value;
    }
    if (mapping.wide) {
      for (const [column, pricebook] of Object.entries(mapping.wide)) {
        const price = lookup(row.values, column, column);
        if (price === undefined || (typeof price === 'string' && !price.trim())) continue;
        out.push({ row: `${row.rowNumber}/${column}`, fields: { ...base, pricebook, price } });
      }
    } else out.push({ row: String(row.rowNumber), fields: base });
  }
  return out;
}

function toRate(value) {
  const text = String(value).trim();
  const number = toNumber(text.replace(/%$/, ''));
  if (number === undefined) return undefined;
  return text.endsWith('%') || number > 1 ? Math.round((number / 100) * 1e6) / 1e6 : number;
}

// ─── Preview ───────────────────────────────────────────────────────────────────

function emptyResult() {
  return { decided: [], blockers: [], warnings: [] };
}

function addWarning(list, text) {
  if (!list.includes(text)) list.push(text);
}

// Turns file rows into decided rows: create, update, unchanged or error, each with the values
// before and after. Reads the account once.
async function planFromFile(api, inputRows) {
  const r = emptyResult();
  const currencies = await loadCurrencies(api);
  const pbRefs = [...new Set(inputRows.map((x) => String(x.fields.pricebook || '').trim()).filter(Boolean))];
  const pricebooks = await loadPricebooks(api, pbRefs);
  const prodRefs = [...new Set(inputRows.map((x) => String(x.fields.product || '').trim()).filter(Boolean))];
  const products = new Map();
  const prodIds = prodRefs.filter((v) => ID_RE.test(v));
  const prodCodes = prodRefs.filter((v) => !ID_RE.test(v));
  const prodSelect = '_id productCode productName active';
  for (const p of [...await readIn(api, 'product', '_id', prodIds, prodSelect), ...await readIn(api, 'product', 'productCode', prodCodes, prodSelect)]) {
    products.set(String(p._id), p);
    products.set(p.productCode, p);
  }
  const taxes = await cursorAll(api, 'tax', null, '_id taxCode taxName rate');
  const taxByRef = new Map();
  for (const t of taxes) {
    taxByRef.set(String(t._id), t);
    taxByRef.set(t.taxCode, t);
  }
  const pbIds = [...new Set([...pricebooks.values()].map((pb) => String(pb._id)))];
  const entries = await loadEntries(api, pbIds);
  const byPair = new Map(entries.map((e) => [`${idOf(e.pricebook)}|${idOf(e.product)}`, e]));
  const byCode = new Map(entries.map((e) => [e.pricebookEntryCode, e]));

  // A code that is not in these price lists may belong to another list: the importer would
  // then change that entry's product and list. Look those codes up (indexed) to refuse them.
  const givenCodes = [...new Set(inputRows.map((x) => x.fields.pricebookEntryCode).filter(Boolean).map((c) => String(c).trim()))];
  const foreignCodes = new Set();
  const missing = givenCodes.filter((c) => !byCode.has(c));
  if (missing.length) {
    for (const e of await readIn(api, 'pricebookentry', 'pricebookEntryCode', missing, '_id pricebookEntryCode pricebook')) foreignCodes.add(e.pricebookEntryCode);
  }

  const seenPairs = new Map();
  for (const input of inputRows) {
    const f = input.fields;
    const errors = [];
    const pb = pricebooks.get(String(f.pricebook || '').trim());
    const prod = products.get(String(f.product || '').trim());
    if (!f.pricebook) errors.push('no price list');
    else if (!pb) errors.push(`price list "${f.pricebook}" not found (or this user cannot see it)`);
    if (!f.product) errors.push('no product');
    else if (!prod) errors.push(`product "${f.product}" not found (or this user cannot see it)`);
    const after = {};
    for (const field of NUMBER_FIELDS) {
      if (f[field] === undefined) continue;
      const n = toNumber(f[field]);
      if (n === undefined) errors.push(`${field} "${f[field]}" is not a number (1.234 alone is ambiguous: write 1234 or 1.234,00)`);
      else if (n < 0) errors.push(`${field} is negative`);
      else after[field] = n;
    }
    if (f.currency !== undefined) {
      const cur = String(f.currency).trim().toUpperCase();
      if (currencies && !currencies.includes(cur)) errors.push(`currency "${f.currency}" is not one the account accepts`);
      else after.currency = cur;
    }
    if (f.active !== undefined) {
      const b = toBool(f.active);
      if (b === undefined) errors.push(`active "${f.active}" is not yes/no`);
      else after.active = b;
    }
    if (f.taxes !== undefined && f.taxRate !== undefined) errors.push('give taxes or taxRate, not both');
    else if (f.taxes !== undefined) {
      const list = toList(String(f.taxes)) || [];
      const ids = [];
      for (const ref of list) {
        const t = taxByRef.get(String(ref).trim());
        if (!t) errors.push(`tax "${ref}" not found`);
        else if (!(Number(t.rate) > 0 && Number(t.rate) <= 1)) errors.push(`tax "${ref}" has rate ${t.rate}: 0 breaks quotes and above 1 charges over 100%`);
        else ids.push(String(t._id));
      }
      after.taxes = ids;
    } else if (f.taxRate !== undefined) {
      const ids = [];
      for (const raw of toList(String(f.taxRate)) || []) {
        const rate = toRate(raw);
        if (rate === undefined) { errors.push(`tax rate "${raw}" is not a number`); continue; }
        if (rate === 0) continue;
        const match = taxes.filter((t) => Math.abs(Number(t.rate) - rate) < 1e-9);
        if (match.length !== 1) errors.push(match.length ? `${match.length} taxes have rate ${rate}; use the taxes column with codes` : `no tax with rate ${rate}`);
        else ids.push(String(match[0]._id));
      }
      after.taxes = ids;
    }
    const code = f.pricebookEntryCode !== undefined ? String(f.pricebookEntryCode).trim() : undefined;
    let existing = null;
    if (pb && prod) {
      const pair = `${pb._id}|${prod._id}`;
      if (seenPairs.has(pair)) errors.push(`same product and price list as row ${seenPairs.get(pair)}`);
      else seenPairs.set(pair, input.row);
      existing = byPair.get(pair) || null;
      if (code && existing && existing.pricebookEntryCode !== code) errors.push(`code "${code}" differs from the existing price's code "${existing.pricebookEntryCode}"`);
      if (code && !existing && (byCode.has(code) || foreignCodes.has(code))) errors.push(`code "${code}" belongs to another price; the importer would move it`);
      if (!existing && after.currency === undefined) errors.push('a new price needs a currency (the server would silently use the account default)');
      if (!existing && after.price === undefined) errors.push('a new price needs a price');
      if (existing && existing.pricingMethod === 'Percent Of Total' && after.price !== undefined) errors.push('this price is a percent of the total; its price is not used');
      if (prod.active === false) addWarning(r.warnings, 'Some products are inactive: their prices are saved but cannot be quoted.');
      if (pb.active === false) addWarning(r.warnings, 'Some price lists are inactive: their prices cannot be quoted.');
    }
    const d = {
      row: input.row,
      product: prod ? prod.productCode : f.product,
      productId: prod ? String(prod._id) : undefined,
      pricebook: pb ? pb.pricebookCode : f.pricebook,
      pricebookId: pb ? String(pb._id) : undefined,
    };
    if (errors.length) {
      r.decided.push({ ...d, action: 'error', error: errors.join('; ') });
      continue;
    }
    if (existing) {
      const changes = {};
      const before = {};
      for (const field of FIELDS) {
        if (after[field] === undefined) continue;
        if (!sameValue(field, existing[field], after[field])) {
          changes[field] = after[field];
          before[field] = field === 'taxes' ? (existing.taxes || []).map(idOf) : existing[field];
        }
      }
      if (!Object.keys(changes).length) r.decided.push({ ...d, action: 'unchanged', entryId: String(existing._id), price: existing.price });
      else r.decided.push({ ...d, action: 'update', entryId: String(existing._id), before, changes });
    } else {
      r.decided.push({ ...d, action: 'create', changes: { ...after, ...(code ? { pricebookEntryCode: code } : {}) } });
    }
  }
  return r;
}

// The yearly update: every entry of the given price lists, its price (and optionally cost)
// times a factor, rounded to a step.
async function planFromFactor(api, flags) {
  const r = emptyResult();
  const factor = Number(flags.factor);
  if (!Number.isFinite(factor) || factor <= 0) throw new UsageError('--factor must be a positive number (new value / old value).');
  if (factor < FACTOR_RANGE[0] || factor > FACTOR_RANGE[1]) throw new Blocked(`A factor of ${factor} changes prices by more than half; check the reference values with the user.`);
  const step = flags.round !== undefined ? Number(flags.round) : 0;
  if (!Number.isFinite(step) || step < 0) throw new UsageError('--round must be a step such as 1, 100 or 0.01.');
  const fields = String(flags.fields || 'price').split(',').map((s) => s.trim()).filter(Boolean);
  if (!fields.length || fields.some((x) => !NUMBER_FIELDS.includes(x))) throw new UsageError(`--fields takes ${NUMBER_FIELDS.join(', ')}.`);
  const refs = String(flags.pricebooks || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!refs.length) throw new UsageError('--factor needs --pricebooks <code,code>.');
  const pricebooks = await loadPricebooks(api, refs);
  const unknown = refs.filter((x) => !pricebooks.has(x));
  if (unknown.length) throw new Blocked(`Price lists not found: ${unknown.join(', ')}.`);
  const pbById = new Map([...pricebooks.values()].map((pb) => [String(pb._id), pb]));
  const entries = await loadEntries(api, [...pbById.keys()]);
  const productIds = [...new Set(entries.map((e) => idOf(e.product)))];
  const products = new Map((await readIn(api, 'product', '_id', productIds, '_id productCode')).map((p) => [String(p._id), p]));
  let skippedInactive = 0;
  let skippedPercent = 0;
  for (const e of entries) {
    const pb = pbById.get(idOf(e.pricebook));
    const prod = products.get(idOf(e.product));
    const d = {
      row: e.pricebookEntryCode, product: prod ? prod.productCode : idOf(e.product), productId: idOf(e.product), pricebook: pb.pricebookCode, pricebookId: String(pb._id), entryId: String(e._id),
    };
    if (e.pricingMethod === 'Percent Of Total') { skippedPercent += 1; continue; }
    if (e.active === false && !flags.includeInactive) { skippedInactive += 1; continue; }
    const changes = {};
    const before = {};
    for (const field of fields) {
      const old = Number(e[field] || 0);
      const next = round(old * factor, step);
      if (next !== old) { changes[field] = next; before[field] = old; }
    }
    if (Object.keys(changes).length) r.decided.push({ ...d, action: 'update', before, changes });
    else r.decided.push({ ...d, action: 'unchanged', price: e.price });
  }
  if (skippedInactive) r.warnings.push(`${skippedInactive} inactive prices left as they are (add --include-inactive to change them too).`);
  if (skippedPercent) r.warnings.push(`${skippedPercent} prices that are a percent of the total left as they are.`);
  r.factor = { factor, round: step || 0.01, fields, pricebooks: refs };
  return r;
}

function priceTotals(decided) {
  const updates = decided.filter((d) => d.action === 'update' && d.changes.price !== undefined);
  let sumBefore = 0;
  let sumAfter = 0;
  let up = 0;
  let down = 0;
  let minPct = null;
  let maxPct = null;
  for (const d of updates) {
    const a = Number(d.before.price || 0);
    const b = Number(d.changes.price);
    sumBefore += a;
    sumAfter += b;
    if (b > a) up += 1; else if (b < a) down += 1;
    if (a > 0) {
      const pct = Math.round(((b - a) / a) * 10000) / 100;
      minPct = minPct === null ? pct : Math.min(minPct, pct);
      maxPct = maxPct === null ? pct : Math.max(maxPct, pct);
    }
  }
  return {
    pricesChanged: updates.length,
    raised: up,
    lowered: down,
    sumBefore: Math.round(sumBefore * 100) / 100,
    sumAfter: Math.round(sumAfter * 100) / 100,
    changePercent: { min: minPct, max: maxPct },
  };
}

function counts(decided) {
  const out = {
    create: 0, update: 0, unchanged: 0, error: 0,
  };
  for (const d of decided) out[d.action] = (out[d.action] || 0) + 1;
  return out;
}

function previewRow(d) {
  return {
    row: d.row,
    product: d.product,
    pricebook: d.pricebook,
    action: d.action,
    entryId: d.entryId || '',
    before: d.before ? JSON.stringify(d.before) : '',
    after: d.changes ? JSON.stringify(d.changes) : '',
    error: d.error || '',
  };
}

async function cmdPreview(api, [file], flags, ctx) {
  if (file && flags.factor) throw new UsageError('Give a file or --factor, not both.');
  let r;
  let source;
  if (flags.factor) {
    r = await planFromFactor(api, flags);
    source = { kind: 'factor', ...r.factor };
  } else {
    if (!file) throw new UsageError('Give the file to load, or --pricebooks with --factor.');
    const mapping = readJsonArg(flags.map, ctx.rootDir, 'mapping') || {};
    const inputRows = mapRows(readInputFile(file, flags, ctx.rootDir), mapping);
    if (!inputRows.length) throw new Blocked('The file has no rows with a price.');
    if (inputRows.length > MAX_ROWS) throw new Blocked(`${inputRows.length} rows; split the file into parts of at most ${MAX_ROWS}.`);
    if (flags.pricebooks) {
      const allowed = new Set(String(flags.pricebooks).split(',').map((s) => s.trim()));
      const outside = inputRows.filter((x) => !allowed.has(String(x.fields.pricebook || '').trim()));
      if (outside.length) throw new Blocked(`${outside.length} rows are for price lists outside --pricebooks (first: row ${outside[0].row}).`);
    }
    r = await planFromFile(api, inputRows);
    source = { kind: 'file', file: path.basename(file), rows: inputRows.length };
  }
  const effects = await sideEffects(api);
  const access = await writeAccess(api);
  if (access === false) r.warnings.push('This user has no permission to create or change prices: every row would fail. Use a key of a user with a pricing role.');
  const writes = r.decided.filter((d) => d.action === 'create' || d.action === 'update');
  const c = counts(r.decided);
  if (c.error) r.warnings.push(`${c.error} rows have errors and will not be written (see the detail file).`);
  for (const [what, n] of Object.entries(effects)) {
    if (typeof n === 'number' && n > 0) r.warnings.push(`${n} active ${what} run on every price saved: ${writes.length} rows means ${writes.length} runs of each.`);
  }
  const job = {
    domain: api.domain,
    createdAt: new Date().toISOString(),
    source,
    pricebookIds: [...new Set(r.decided.map((d) => d.pricebookId).filter(Boolean))],
    decided: r.decided,
  };
  const version = crypto.createHash('sha256').update(JSON.stringify([job.domain, job.source, job.decided])).digest('hex').slice(0, 16);
  const dir = jobDir(version, ctx.jobsRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ ...job, version }));
  const detailFile = path.join(dir, 'preview.csv');
  writeCsv(detailFile, ['row', 'product', 'pricebook', 'action', 'entryId', 'before', 'after', 'error'], r.decided.map(previewRow));
  const chunks = Math.ceil(writes.length / DEFAULT_CHUNK);
  const updates = r.decided.filter((d) => d.action === 'update');
  return {
    domain: api.domain,
    version,
    source,
    counts: c,
    priceTotals: priceTotals(r.decided),
    sample: {
      updates: updates.slice(0, SAMPLE).map((d) => ({
        row: d.row, product: d.product, pricebook: d.pricebook, from: d.before, to: d.changes,
      })),
      creates: r.decided.filter((d) => d.action === 'create').slice(0, 10).map((d) => ({
        row: d.row, product: d.product, pricebook: d.pricebook, values: d.changes,
      })),
      errors: r.decided.filter((d) => d.action === 'error').slice(0, SHOW_ERRORS).map((d) => ({ row: d.row, error: d.error })),
    },
    sideEffects: effects,
    canWritePrices: access === null ? 'unknown' : access,
    plan: {
      importerCalls: chunks,
      rowsPerCall: DEFAULT_CHUNK,
      readsBefore: api.stats().calls,
      note: `apply re-reads the ${job.pricebookIds.length} price lists, sends ${chunks} calls one after another and reads them back. Existing prices are matched by _id.`,
    },
    warnings: r.warnings,
    blockers: r.blockers,
    detailFile,
    nextStep: writes.length
      ? 'STOP. Show the user the counts, the price totals, the sample and every warning, then end your turn. Run apply only after an explicit yes; changes to existing prices need their own yes.'
      : 'Nothing to write.',
  };
}

// ─── Apply ─────────────────────────────────────────────────────────────────────

function importerBody(d) {
  if (d.action === 'update') return { _id: d.entryId, ...d.changes };
  return { pricebook: d.pricebookId, product: d.productId, ...d.changes };
}

// What the account holds now for a planned row: written already, still pending, or changed
// by someone else since the preview (left alone).
function stateNow(d, current) {
  if (d.action === 'update') {
    const e = current.byId.get(d.entryId);
    if (!e) return 'changed';
    const fields = Object.keys(d.changes);
    if (fields.every((f) => sameValue(f, e[f], d.changes[f]))) return 'done';
    if (fields.every((f) => sameValue(f, e[f], d.before[f]))) return 'pending';
    return 'changed';
  }
  const e = current.byPair.get(`${d.pricebookId}|${d.productId}`);
  if (!e) return 'pending';
  const fields = Object.keys(d.changes).filter((f) => f !== 'pricebookEntryCode');
  return fields.every((f) => sameValue(f, e[f], d.changes[f])) ? 'done' : 'changed';
}

async function readCurrent(api, pricebookIds) {
  const entries = await loadEntries(api, pricebookIds);
  return {
    byId: new Map(entries.map((e) => [String(e._id), e])),
    byPair: new Map(entries.map((e) => [`${idOf(e.pricebook)}|${idOf(e.product)}`, e])),
  };
}

const RESULT_HEADER = ['row', 'product', 'pricebook', 'action', 'result', 'entryId', 'before', 'after', 'error', 'at'];

async function cmdApply(api, args, flags, ctx) {
  if (args.length) throw new UsageError('apply takes no file: it uses the job saved by preview (--version).');
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const chunkSize = flags.chunk ? Number(flags.chunk) : DEFAULT_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK) throw new UsageError(`--chunk must be between 1 and ${MAX_CHUNK}.`);
  const pauseMs = flags.pauseMs !== undefined ? Number(flags.pauseMs) : DEFAULT_PAUSE_MS;
  if (!Number.isFinite(pauseMs) || pauseMs < 0 || pauseMs > 60000) throw new UsageError('--pause-ms must be between 0 and 60000.');
  const maxRows = flags.maxRows !== undefined ? Number(flags.maxRows) : Infinity;
  if (!(maxRows > 0)) throw new UsageError('--max-rows must be a positive number.');
  const dir = jobDir(flags.version, ctx.jobsRoot);
  let job;
  try {
    job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  } catch {
    throw new Blocked('No saved preview with that version on this computer. Run preview again.');
  }
  if (job.domain !== api.domain) throw new Blocked(`That preview was for ${job.domain}, not ${api.domain}.`);
  const sleep = ctx.sleep || defaultSleep;
  const resultFile = path.join(dir, 'result.csv');
  const planned = job.decided.filter((d) => d.action === 'create' || d.action === 'update');

  // Resume: what is already in the account is skipped; what someone else changed is left alone.
  const current = await readCurrent(api, job.pricebookIds);
  const now = new Date().toISOString();
  const skipped = [];
  const pending = [];
  for (const d of planned) {
    const s = stateNow(d, current);
    if (s === 'pending') pending.push(d);
    else skipped.push({ d, result: s === 'done' ? 'already written' : 'changed since preview (not written)' });
  }
  writeCsv(resultFile, RESULT_HEADER, skipped.map(({ d, result }) => ({ ...previewRow(d), result, at: now })), true);

  const toSend = pending.slice(0, Number.isFinite(maxRows) ? maxRows : pending.length);
  const results = [];
  let stopped = null;
  const parts = chunk(toSend, chunkSize);
  const started = Date.now();
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const reqPath = '/v2/service/importdata?modelName=PricebookEntry&silent=true';
    let res;
    try {
      res = await api.request('PUT', reqPath, { data: part.map(importerBody), confirmed: true });
    } catch (err) {
      stopped = `The call for ${part.length} rows did not answer (${err && err.name === 'TimeoutError' ? 'timed out' : err.message}). The importer may still be writing them: wait a couple of minutes, then run apply again with the same version; it reads the account and skips what was written.`;
      results.push(...part.map((d) => ({ d, result: 'unknown', error: 'no answer' })));
      break;
    }
    if (!res.ok) {
      const msg = res.body && typeof res.body === 'object' ? (res.body.error || res.body.message) : res.body;
      stopped = `The importer refused a chunk: ${res.status} ${msg || ''}`.trim();
      results.push(...part.map((d) => ({ d, result: 'not sent', error: stopped })));
      break;
    }
    const body = res.body || {};
    const errors = new Map((Array.isArray(body.errors) ? body.errors : []).map((e) => [Number(e.row), e.error || 'error']));
    const answered = Number(body.created || 0) + Number(body.updated || 0) + errors.size;
    const chunkResults = part.map((d, j) => {
      if (errors.has(j)) return { d, result: 'failed', error: String(errors.get(j)) };
      if (answered !== part.length) return { d, result: 'unknown', error: 'the importer counts do not add up; checked in the read-back' };
      return { d, result: d.action === 'update' ? 'updated' : 'created' };
    });
    results.push(...chunkResults);
    const at = new Date().toISOString();
    writeCsv(resultFile, RESULT_HEADER, chunkResults.map((x) => ({
      ...previewRow(x.d), result: x.result, error: x.error || '', at,
    })), true);
    if (i < parts.length - 1 && pauseMs) await sleep(pauseMs);
  }

  // Read-back: every row sent must now hold its new values.
  const problems = [];
  let verified = 0;
  if (results.length) {
    const after = await readCurrent(api, job.pricebookIds);
    for (const x of results) {
      if (x.result === 'not sent') continue;
      const s = stateNow(x.d, after);
      if (s === 'done') {
        verified += 1;
        if (x.result === 'unknown') x.result = x.d.action === 'update' ? 'updated' : 'created';
      } else if (x.result === 'updated' || x.result === 'created') {
        problems.push(`Row ${x.d.row} (${x.d.product} in ${x.d.pricebook}): the importer reported it written but it does not hold the new values.`);
      }
    }
  }
  const tally = {};
  for (const x of results) tally[x.result] = (tally[x.result] || 0) + 1;
  for (const s of skipped) tally[s.result] = (tally[s.result] || 0) + 1;
  const remaining = pending.length - toSend.length;
  const failedRows = results.filter((x) => x.result === 'failed').slice(0, SHOW_ERRORS).map((x) => ({ row: x.d.row, product: x.d.product, pricebook: x.d.pricebook, error: x.error }));
  const saved = !stopped && !problems.length && !results.some((x) => !['updated', 'created'].includes(x.result)) && !remaining
    && !skipped.some((s) => s.result !== 'already written');
  return {
    saved,
    domain: api.domain,
    version: flags.version,
    counts: tally,
    sentThisRun: toSend.length,
    verified,
    remaining,
    failedRows,
    problems,
    stopped: stopped || undefined,
    calls: api.stats(),
    seconds: Math.round((Date.now() - started) / 1000),
    resultFile,
    nextStep: saved
      ? 'Tell the user how many prices were created and updated (verified by the read-back) and where the result file is.'
      : 'Tell the user what was written and what not (counts, failedRows, stopped, remaining). To continue, run apply again with the same --version: it skips what is already written.',
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valueFlags = {
    '--version': 'version', '--profile': 'profile', '--sheet': 'sheet', '--map': 'map', '--pricebooks': 'pricebooks', '--factor': 'factor',
    '--round': 'round', '--fields': 'fields', '--chunk': 'chunk', '--pause-ms': 'pauseMs', '--max-rows': 'maxRows',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--include-inactive') flags.includeInactive = true;
    else if (valueFlags[arg]) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[valueFlags[arg]] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

const COMMANDS = { preview: cmdPreview, apply: cmdApply };
const USAGE = 'Usage: bulk-prices.js preview <domain> <file> [--map <json>] | preview <domain> --pricebooks <codes> --factor <n> | apply <domain> --version <v> --confirmed';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, rest, flags } = parseCli(argv);
    if (!COMMANDS[command]) throw new UsageError(USAGE);
    const [domain, ...args] = rest;
    if (!domain) throw new UsageError(USAGE);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const api = { ...pacedApi(client, { sleep: opts.sleep, budget: opts.budget, stderr }), domain };
    const result = await COMMANDS[command](api, args, flags, { rootDir, sleep: opts.sleep, jobsRoot: opts.jobsRoot });
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
  main, mapRows, toRate, round, stateNow, pacedApi, jobsRoot,
};
