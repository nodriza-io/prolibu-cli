/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const catalog = require('../.claude/skills/prolibu-catalog/scripts/catalog');
const reader = require('../.claude/skills/prolibu-catalog/scripts/sheet-reader');

const D = 'dev99.example.com';

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let db;
let fake;
let seq;

// ─── A minimal .xlsx writer, so the reader is tested on real workbook files ────

function xmlEscape(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function colName(i) {
  let s = '';
  let n = i + 1;
  while (n) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
// Strings go to the shared-string table, like Excel does; {date: serial} gets a date format.
function xlsx(sheets) {
  const names = Object.keys(sheets);
  const shared = [];
  const sheetXml = (rows) => `<worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    if (v === undefined || v === null) return '';
    const ref = `${colName(c)}${r + 1}`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (v.date) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
    shared.push(v);
    return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const bodies = names.map((n) => sheetXml(sheets[n]));
  return zip([
    ['xl/workbook.xml', `<workbook><sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
    ['xl/sharedStrings.xml', `<sst>${shared.map((t) => `<si><t xml:space="preserve">${xmlEscape(t)}</t></si>`).join('')}</sst>`],
    ['xl/styles.xml', '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'],
    ...names.map((n, i) => [`xl/worksheets/sheet${i + 1}.xml`, bodies[i]]),
  ]);
}

// ─── A fake account, shaped after the verified server behavior ─────────────────

const S = (type, extra = {}) => ({ type, ...extra });
const SCHEMAS = {
  Tax: { _id: S('objectid'), createdAt: S('date', { avoid: 'always' }), taxCode: S('string'), taxName: S('string'), rate: S('number'), description: S('string') },
  ProductFamily: { _id: S('objectid'), productFamilyCode: S('string'), productFamilyName: S('string') },
  ProductCategory: { _id: S('objectid'), productCategoryCode: S('string'), productCategoryName: S('string'), active: S('boolean') },
  ProductGroup: { _id: S('objectid'), productGroupCode: S('string'), productGroupName: S('string') },
  DiscountSchedule: {
    _id: S('objectid'), discountScheduleCode: S('string'), discountScheduleName: S('string'), formula: S('string', { enum: ['tiers', 'linear'] }), floorPrice: S('number'),
    formulaSettings: { tiers: { segments: S(['mixed']) } },
  },
  Coupon: {
    _id: S('objectid'), couponCode: S('string'), couponName: S('string'), discountType: S('string', { enum: ['percentage', 'fixed'] }), discountValue: S('number'),
    validFrom: S('date'), validTo: S('date'), duration: S('string', { enum: ['once', 'repeating', 'forever'] }), durationInMonths: S('number'), active: S('boolean'),
  },
  Pricebook: {
    _id: S('objectid'), pricebookCode: S('string'), pricebookName: S('string'), validFrom: S('date'), validTo: S('date'),
    discountSchedule: S('objectid', { ref: 'DiscountSchedule' }), active: S('boolean'), workspace: S('objectid', { ref: 'Workspace' }),
  },
  Product: {
    _id: S('objectid'), refId: S('mixed'), productCode: S('string'), productName: S('string'), unitName: S('string'), active: S('boolean'),
    productFamily: S('objectid', { ref: 'ProductFamily' }), productCategories: S(['objectid'], { ref: 'ProductCategory' }), productGroup: S('objectid', { ref: 'ProductGroup' }),
    allowEveryone: { view: S('boolean'), edit: S('boolean') },
  },
  PricebookEntry: {
    _id: S('objectid'), pricebook: S('objectid', { ref: 'Pricebook' }), product: S('objectid', { ref: 'Product' }), pricebookEntryCode: S('string'),
    currency: S('string', { enum: ['COP', 'USD', 'MXN'] }), price: S('number'), cost: S('number'), discountAmount: S('number'), netUnitPrice: S('number', { avoid: 'always' }),
    taxes: S(['objectid'], { ref: 'Tax' }), discountSchedules: S(['objectid'], { ref: 'DiscountSchedule' }),
    pricingMethod: S('string', { enum: ['List', 'Percent Of Total'] }), percentOfTotal: S('number'), percentOfTotalBase: S('string'), active: S('boolean'),
  },
};
const CODES = {
  tax: 'taxCode', productfamily: 'productFamilyCode', productcategory: 'productCategoryCode', productgroup: 'productGroupCode',
  discountschedule: 'discountScheduleCode', coupon: 'couponCode', pricebook: 'pricebookCode', product: 'productCode', pricebookentry: 'pricebookEntryCode',
};

function id(n) {
  return String(n).padStart(24, '0');
}

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function matches(doc, query) {
  return Object.entries(query).every(([field, cond]) => {
    if (field === '$or') return cond.some((q) => matches(doc, q));
    const value = doc[field];
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.map(String).includes(String(value));
    if (cond && typeof cond === 'object' && '$regex' in cond) return new RegExp(cond.$regex.replace('(?i)', ''), 'i').test(String(value || ''));
    return String(value) === String(cond);
  });
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const parts = u.pathname.split('/').filter(Boolean);
  const object = parts[1];
  if (init.method === 'GET' && u.pathname === '/v2/user/me') return respond(200, { profile: {}, modelSchemas: SCHEMAS });
  if (init.method === 'GET' && u.pathname === '/v2/quote/formatLineItem') {
    const entry = db.pricebookentry.find((e) => e._id === u.searchParams.get('pricebookEntryId'));
    const pb = entry && db.pricebook.find((p) => p._id === entry.pricebook);
    if (!entry || entry.active === false || !pb || pb.active === false) return respond(400, { statusCode: 400, error: 'Not found.' });
    const product = db.product.find((p) => p._id === entry.product);
    const taxes = (entry.taxes || []).map((t) => db.tax.find((x) => x._id === t));
    return respond(200, {
      productName: product.productName, product: product._id, pricebookEntry: entry._id, currency: entry.currency, price: entry.price, taxes,
    });
  }
  if (init.method === 'PUT' && u.pathname === '/v2/quote/calculate') {
    const lines = body.lineItems.map((l) => {
      if ((l.taxes || []).some((t) => !t.rate)) throw Object.assign(new Error('rate'), { bad: true });
      const net = l.price * l.quantity;
      const tax = (l.taxes || []).reduce((s, t) => s + net * t.rate, 0);
      return { ...l, netUnitPrice: l.price, netTotalTaxAmount: tax, total: net + tax };
    });
    return respond(200, { ...body, lineItems: lines });
  }
  const list = db[object];
  if (!list) return respond(404, { statusCode: 404, error: 'Not found' });
  if (init.method === 'GET' && parts.length === 2) {
    const xq = u.searchParams.get('xquery');
    const found = list.filter((d) => (xq ? matches(d, JSON.parse(xq)) : true));
    const limit = Number(u.searchParams.get('limit') || 20);
    const page = Number(u.searchParams.get('page') || 1);
    return respond(200, { pagination: { count: found.length, lastPage: Math.max(1, Math.ceil(found.length / limit)) }, data: found.slice((page - 1) * limit, page * limit) });
  }
  if (init.method === 'GET' && parts.length === 3) {
    const doc = list.find((d) => d._id === parts[2] || d[CODES[object]] === decodeURIComponent(parts[2]));
    return doc ? respond(200, doc) : respond(404, { statusCode: 404, error: 'Not found' });
  }
  if (init.method === 'POST') {
    if (fake.failOn && fake.failOn(object, body)) return respond(400, { statusCode: 400, error: 'boom' });
    const code = CODES[object];
    if (body[code] && list.some((d) => d[code] === body[code])) return respond(400, { statusCode: 400, error: `'${body[code]}' ya existe.` });
    if (object === 'pricebookentry' && list.some((d) => d.pricebook === body.pricebook && d.product === body.product)) {
      return respond(400, { statusCode: 400, error: `pricebook '${body.pricebook}' ya existe.` });
    }
    seq += 1;
    const doc = { _id: id(1000 + seq), updatedAt: `T${seq}`, active: true, ...body };
    if (!doc[code]) doc[code] = `${object}-${seq}`;
    if (object === 'pricebookentry') {
      doc.currency = doc.currency || 'COP';
      doc.price = doc.price || 0;
      doc.discountAmount = doc.discountAmount || 0;
      doc.netUnitPrice = doc.price - doc.discountAmount;
    }
    if (fake.dropField) delete doc[fake.dropField];
    list.push(doc);
    return respond(201, doc);
  }
  if (init.method === 'PATCH') {
    const doc = list.find((d) => d._id === parts[2]);
    seq += 1;
    Object.assign(doc, body, { updatedAt: `T${seq}` });
    if (object === 'pricebookentry') doc.netUnitPrice = doc.price - (doc.discountAmount || 0);
    return respond(200, doc);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

async function fetchImpl(url, init) {
  try {
    return await fakeFetch(url, init);
  } catch (e) {
    if (e.bad) return respond(400, { statusCode: 400, error: "The 'rate' is required in 'tax' object and must be a number" });
    throw e;
  }
}

const run = (argv) => catalog.main(argv, {
  rootDir, fetchImpl,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method === 'POST' || c.method === 'PATCH');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-catalog-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-catalog-tmp-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  seq = 0;
  fake = {};
  db = {
    tax: [
      { _id: id(1), taxCode: 'iva19', taxName: 'IVA 19%', rate: 0.19, updatedAt: 'T0' },
      { _id: id(2), taxCode: 'exento', taxName: 'Exento', rate: 0, updatedAt: 'T0' },
    ],
    productfamily: [
      { _id: id(3), productFamilyCode: 'ayb', productFamilyName: 'Alimentos y Bebidas', updatedAt: 'T0' },
      { _id: id(4), productFamilyCode: 'alimentos-y-bebidas', productFamilyName: 'ALIMENTOS Y BEBIDAS', updatedAt: 'T0' },
      { _id: id(5), productFamilyCode: 'sal', productFamilyName: 'Salones', updatedAt: 'T0' },
    ],
    productcategory: [],
    productgroup: [],
    discountschedule: [],
    coupon: [],
    pricebook: [
      { _id: id(6), pricebookCode: 'general', pricebookName: 'General', active: true, updatedAt: 'T0' },
      { _id: id(7), pricebookCode: 'old', pricebookName: 'Old list', active: false, updatedAt: 'T0' },
    ],
    product: [
      { _id: id(8), productCode: 'cafe', productName: 'Café', productFamily: id(5), active: true, updatedAt: 'T0', refId: 'ERP-1' },
    ],
    pricebookentry: [
      {
        _id: id(9), pricebook: id(6), product: id(8), pricebookEntryCode: 'e-cafe', currency: 'COP', price: 100, discountAmount: 0, netUnitPrice: 100, taxes: [id(1)], active: true, updatedAt: 'T0',
      },
    ],
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Values ────────────────────────────────────────────────────────────────────

describe('values from spreadsheets', () => {
  test('numbers in either decimal style, and refuses ambiguous ones', () => {
    expect(catalog.toNumber('1.234,56')).toBe(1234.56);
    expect(catalog.toNumber('1,234.56')).toBe(1234.56);
    expect(catalog.toNumber('$ 2.500,50')).toBe(2500.5);
    expect(catalog.toNumber('1.234.567')).toBe(1234567);
    expect(catalog.toNumber('5000')).toBe(5000);
    expect(catalog.toNumber('12,5')).toBe(12.5);
    expect(catalog.toNumber('1.234')).toBeUndefined();
    expect(catalog.toNumber('abc')).toBeUndefined();
  });

  test('lists and yes/no cells', () => {
    expect(catalog.toList('["19"]')).toEqual(['19']);
    expect(catalog.toList("['19', '8']")).toEqual(['19', '8']);
    expect(catalog.toList('a, b')).toEqual(['a', 'b']);
    expect(catalog.toBool('Sí')).toBe(true);
    expect(catalog.toBool(0)).toBe(false);
    expect(catalog.toBool('maybe')).toBeUndefined();
  });

  test('tiers become segments with decimal rates, and bad tiers are refused', () => {
    const blockers = [];
    const warnings = [];
    const out1 = catalog.tiersToSettings([{ from: 10, to: 49, rate: 0.05 }, { from: 50, rate: 0.1 }], 'DS', blockers, warnings);
    expect(out1.formula).toBe('tiers');
    expect(out1.formulaSettings.tiers.segments).toEqual([{ from: 10, to: 49, segmentDiscountRate: 0.05 }, { from: 50, segmentDiscountRate: 0.1 }]);
    catalog.tiersToSettings([{ from: 10, rate: 5 }], 'DS', blockers, warnings);
    catalog.tiersToSettings([{ from: 0, to: 9, rate: 0.1 }], 'DS', blockers, warnings);
    expect(blockers.map((b) => b.text).join(' ')).toMatch(/between 0 and 1/);
    expect(blockers.map((b) => b.text).join(' ')).toMatch(/from" of 1 or more/);
  });
});

describe('sheet reader', () => {
  test('reads shared strings, numbers, booleans and date-formatted cells by header', () => {
    const file = path.join(tmpDir, 'c.xlsx');
    fs.writeFileSync(file, xlsx({ Hoja: [['Código', 'Precio', 'Activo', 'Desde'], ['a-1', 1500.5, true, { date: 46327 }], [], ['a-2', 3, false, null]] }));
    const [sheet] = reader.readWorkbook(file);
    const { headers, rows } = reader.sheetRows(sheet);
    expect(sheet.name).toBe('Hoja');
    expect(headers).toEqual(['Código', 'Precio', 'Activo', 'Desde']);
    expect(rows).toEqual([
      { rowNumber: 2, values: { Código: 'a-1', Precio: 1500.5, Activo: true, Desde: '2026-11-01' } },
      { rowNumber: 4, values: { Código: 'a-2', Precio: 3, Activo: false } },
    ]);
  });

  test('reads a semicolon CSV with quotes', () => {
    const file = path.join(tmpDir, 'c.csv');
    fs.writeFileSync(file, '﻿Código;Nombre;Precio\na-1;"Café; molido";"2.500,50"\n');
    const [sheet] = reader.readWorkbook(file);
    expect(reader.sheetRows(sheet).rows[0].values).toEqual({ Código: 'a-1', Nombre: 'Café; molido', Precio: '2.500,50' });
  });
});

// ─── from-sheet ────────────────────────────────────────────────────────────────

describe('from-sheet', () => {
  const rows = [
    ['Código', 'Producto', 'Familia', 'Precio', 'IVA %'],
    ['p-1', 'Café', 'Bebidas', 18500, 19],
    ['p-2', 'Agua', 'Bebidas', '2.500,50', 0],
    [null, 'Sin código', 'Bebidas', 10, 19],
    ['p-1', 'Café', 'Bebidas', 19000, 19],
  ];
  const mapping = {
    product: { productCode: 'Código', productName: 'Producto', productFamily: 'Familia' },
    entries: [{ pricebook: { value: 'general' }, currency: { value: 'COP' }, price: 'Precio', taxRate: 'IVA %' }],
    replace: { Familia: { bebidas: 'ayb' } },
    include: { pricebooks: [{ pricebookCode: 'nueva', pricebookName: 'Nueva' }] },
  };

  test('merges rows by product code, reads percent tax columns, applies replace and include', async () => {
    const file = path.join(tmpDir, 'c.xlsx');
    fs.writeFileSync(file, xlsx({ Catálogo: rows }));
    const planFile = path.join(tmpDir, 'plan.json');
    expect(await run(['from-sheet', file, JSON.stringify(mapping), '--out', planFile])).toBe(0);
    const res = json();
    expect(res.counts).toMatchObject({ products: 2, prices: 2, pricebooks: 1 });
    expect(res.problems.join(' ')).toMatch(/Row 4: no product code/);
    expect(res.problems.join(' ')).toMatch(/Row 5: product p-1 has a second, different price/);
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    expect(plan.pricebooks).toEqual([{ pricebookCode: 'nueva', pricebookName: 'Nueva' }]);
    expect(plan.products[0]).toMatchObject({ productCode: 'p-1', productFamily: 'ayb' });
    expect(plan.products[0].entries[0]).toMatchObject({ pricebook: 'general', currency: 'COP', price: 18500, taxRates: [0.19] });
    expect(plan.products[1].entries[0]).toMatchObject({ price: '2.500,50', taxRates: [0] });
    expect(calls).toHaveLength(0);
  });

  test('refuses an output outside a temp folder and columns that do not exist', async () => {
    const file = path.join(tmpDir, 'c.xlsx');
    fs.writeFileSync(file, xlsx({ Catálogo: rows }));
    expect(await run(['from-sheet', file, JSON.stringify(mapping), '--out', path.join(os.homedir(), 'prolibu-catalog-plan.json')])).toBe(2);
    expect(await run(['from-sheet', file, JSON.stringify(mapping), '--out', path.join(rootDir, 'accounts', D, 'plan.json')])).toBe(2);
    expect(fs.existsSync(path.join(os.homedir(), 'prolibu-catalog-plan.json'))).toBe(false);
    expect(await run(['from-sheet', file, JSON.stringify({ product: { productCode: 'Code' } })])).toBe(2);
    expect(err).toMatch(/not in the sheet: Code/);
  });

  test('a datamap workbook is converted; a drop column is refused', async () => {
    const file = path.join(tmpDir, 'd.xlsx');
    const sheets = {
      datamap: [['sheetName', 'objectType', 'skip'], ['Prod', 'Product', false], ['Prod', 'PricebookEntry', false], ['Users', 'User', false]],
      Prod: [['productCode', 'productName', 'pricebook', 'product', 'price', 'currency', 'taxes', 'skip'],
        ['p-1', 'Café', 'general', 'p-1', 100, 'COP', '["iva19"]', null],
        ['p-2', 'Té', 'general', 'p-2', 50, 'COP', '[]', true]],
      Users: [['email'], ['a@b.co']],
    };
    fs.writeFileSync(file, xlsx(sheets));
    expect(await run(['from-sheet', file])).toBe(0);
    const res = json();
    expect(res.counts).toMatchObject({ products: 1, prices: 1 });
    expect(res.problems.join(' ')).toMatch(/User is not a catalog object/);
    const plan = JSON.parse(fs.readFileSync(res.planFile, 'utf8'));
    expect(plan.products[0].entries[0]).toMatchObject({ pricebook: 'general', price: 100, taxes: '["iva19"]', _datamap: true });
    fs.unlinkSync(res.planFile);

    sheets.datamap = [['sheetName', 'objectType', 'drop'], ['Prod', 'Product', true]];
    fs.writeFileSync(file, xlsx(sheets));
    out = '';
    expect(await run(['from-sheet', file])).toBe(3);
    expect(err).toMatch(/drop \(wipe\) every Product/);
  });

  test('never reads files under accounts/', async () => {
    const file = path.join(rootDir, 'accounts', D, 'x.csv');
    fs.writeFileSync(file, 'a\n1\n');
    expect(await run(['sheet', file])).toBe(2);
  });
});

// ─── preview ───────────────────────────────────────────────────────────────────

describe('preview', () => {
  test('diffs by code: create, update and unchanged, and writes nothing', async () => {
    const plan = {
      products: [
        { productCode: 'cafe', productName: 'Café', productFamily: 'ayb', entries: [{ pricebook: 'general', price: 120, taxes: ['iva19'] }] },
        { productCode: 'te', productName: 'Té', productFamily: 'sal', entries: [{ pricebook: 'General', currency: 'COP', price: '2.500,50' }] },
      ],
    };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(0);
    const res = json();
    expect(res.counts.products).toEqual({ create: 1, update: 1, unchanged: 0 });
    expect(res.changes.find((c) => c.section === 'products' && c.action === 'update').fields)
      .toEqual({ productFamily: { from: 'Salones (sal)', to: 'Alimentos y Bebidas (ayb)' } });
    expect(res.counts.entries).toEqual({ create: 1, update: 1, unchanged: 0 });
    const update = res.changes.find((c) => c.section === 'entries' && c.action === 'update');
    expect(update.fields).toEqual({ price: { from: 100, to: 120 } });
    const created = res.changes.find((c) => c.section === 'entries' && c.action === 'create');
    expect(created.fields.price).toBe(2500.5);
    expect(res.version).toMatch(/^[a-f0-9]{16}$/);
    expect(writes()).toHaveLength(0);
  });

  test('blocks the values the server accepts silently but that break quotes', async () => {
    const plan = {
      taxes: [{ taxCode: 'iva-mal', taxName: 'IVA mal', rate: 19 }],
      products: [
        { productCode: 'te', productName: 'Té', entries: [{ pricebook: 'general', price: 10 }] },
        { productCode: 'agua', productName: 'Agua', entries: [{ pricebook: 'general', currency: 'COP', price: 5, taxes: ['exento'] }] },
        { productCode: 'pan', productName: 'Pan', productFamily: 'Alimentos y bebidas', entries: [{ pricebook: 'general', currency: 'COP', price: 5 }, { pricebook: 'General', currency: 'USD', price: 1 }] },
      ],
    };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(3);
    const text = json().blockers.join('\n');
    expect(text).toMatch(/rate 19 means 1900%/);
    expect(text).toMatch(/say the currency of this price/);
    expect(text).toMatch(/tax Exento has rate 0/);
    expect(text).toMatch(/2 ProductFamily records are named "Alimentos y bebidas"/);
    expect(text).toMatch(/listed twice for this product/);
    expect(writes()).toHaveLength(0);
  });

  test('blocks unknown fields, platform fields, a product without code and duplicates in the plan', async () => {
    const plan = {
      products: [
        { productCode: 'te', productName: 'Té', colour: 'green', netUnitPrice: 3 },
        { productName: 'Sin código' },
        { productCode: 'te', productName: 'Té 2' },
      ],
    };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(3);
    const text = json().blockers.join('\n');
    expect(text).toMatch(/"colour" is not a field of Product/);
    expect(text).toMatch(/has no productCode/);
    expect(text).toMatch(/appears twice/);
  });

  test('datamap records ignore unknown columns with one warning, like the app import', async () => {
    const plan = { products: [{ productCode: 'te', productName: 'Té', price: 5, pricebook: 'general', _datamap: true }] };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(0);
    expect(json().warnings.join(' ')).toMatch(/not fields of Product were ignored.*price, pricebook/);
  });

  test('taxes by rate pick the one tax with that rate, a 0 rate means exempt', async () => {
    const plan = { products: [{ productCode: 'te', productName: 'Té', entries: [{ pricebook: 'general', currency: 'COP', price: 5, taxRates: [0.19] }] },
      { productCode: 'pan', productName: 'Pan', entries: [{ pricebook: 'general', currency: 'COP', price: 5, taxRates: [0] }] },
      { productCode: 'vino', productName: 'Vino', entries: [{ pricebook: 'general', currency: 'COP', price: 5, taxRates: [0.08] }] }] };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(3);
    const res = json();
    expect(res.blockers.join(' ')).toMatch(/no tax has the rate 0.08/);
    const te = res.changes.find((c) => c.record.startsWith('Té') && c.section === 'entries');
    expect(te.fields.taxes).toEqual(['IVA 19% (iva19)']);
    const pan = res.changes.find((c) => c.record.startsWith('Pan') && c.section === 'entries');
    expect(pan.fields.taxes).toEqual([]);
  });

  test('warns about coupons, price-list discount schedules and blocks a coupon over 100%', async () => {
    const plan = {
      coupons: [{ couponCode: 'qa-15', couponName: 'QA 15', discountValue: 0.15 }, { couponCode: 'qa-200', couponName: 'QA 200', discountValue: 200 }],
      discountSchedules: [{ discountScheduleCode: 'vol', discountScheduleName: 'Vol', tiers: [{ from: 10, rate: 0.05 }] }],
      pricebooks: [{ pricebookCode: 'general', discountSchedule: 'vol' }],
    };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(3);
    const res = json();
    expect(res.warnings.join(' ')).toMatch(/only redeemed when an account signs up for a subscription/);
    expect(res.warnings.join(' ')).toMatch(/0.15 means 0.15%/);
    expect(res.warnings.join(' ')).toMatch(/not applied by the quote calculation/);
    expect(res.blockers.join(' ')).toMatch(/0–100/);
  });

  test('a refId held by another product blocks, and a numeric refId is sent as text', async () => {
    const taken = { products: [{ productCode: 'te', productName: 'Té', refId: 'ERP-1' }] };
    expect(await run(['preview', D, JSON.stringify(taken)])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/already belongs to product cafe/);
    out = '';
    expect(await run(['preview', D, JSON.stringify({ products: [{ productCode: 'te', productName: 'Té', refId: 900001 }] })])).toBe(0);
    expect(json().changes[0].fields.refId).toBe('900001');
  });
});

// ─── apply ─────────────────────────────────────────────────────────────────────

describe('apply', () => {
  const plan = {
    taxes: [{ taxCode: 'ico8', taxName: 'Impoconsumo 8%', rate: 0.08 }],
    pricebooks: [{ pricebookCode: 'qa', pricebookName: 'QA' }],
    products: [
      { productCode: 'cafe', productName: 'Café', entries: [{ pricebook: 'general', price: 120 }] },
      { productCode: 'te', productName: 'Té', entries: [{ pricebook: 'qa', currency: 'COP', price: 50, taxes: ['ico8'] }] },
    ],
  };

  async function previewVersion(p = plan) {
    out = '';
    expect(await run(['preview', D, JSON.stringify(p)])).toBe(0);
    const { version } = json();
    out = '';
    calls = [];
    return version;
  }

  test('needs the preview version and --confirmed', async () => {
    expect(await run(['apply', D, JSON.stringify(plan), '--confirmed'])).toBe(2);
    expect(await run(['apply', D, JSON.stringify(plan), '--version', 'abc'])).toBe(2);
    expect(await run(['apply', D, JSON.stringify(plan), '--version', 'abc', '--confirmed'])).toBe(3);
    expect(err).toMatch(/changed since the preview/);
    expect(writes()).toHaveLength(0);
  });

  test('writes in order with the new ids, sends only changed fields, reads back and checks each price quotes', async () => {
    const version = await previewVersion();
    expect(await run(['apply', D, JSON.stringify(plan), '--version', version, '--confirmed'])).toBe(0);
    const res = json();
    expect(res.saved).toBe(true);
    const w = writes();
    expect(w.map((c) => `${c.method} ${c.path.split('/')[2]}`)).toEqual(['POST tax', 'POST pricebook', 'POST product', 'PATCH pricebookentry', 'POST pricebookentry']);
    expect(w[3].body).toEqual({ price: 120 });
    const tax = db.tax.find((t) => t.taxCode === 'ico8');
    const product = db.product.find((p) => p.productCode === 'te');
    const pb = db.pricebook.find((p) => p.pricebookCode === 'qa');
    expect(w[4].body).toEqual({ currency: 'COP', price: 50, taxes: [tax._id], product: product._id, pricebook: pb._id });
    expect(res.quotable).toMatchObject({ checked: 2, quotable: 2, notQuotable: [] });
    expect(res.quotable.samples.find((s) => s.product === 'Té').total).toBe(54);
  });

  test('a second run of the same plan changes nothing', async () => {
    let version = await previewVersion();
    await run(['apply', D, JSON.stringify(plan), '--version', version, '--confirmed']);
    version = await previewVersion();
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(0);
    expect(json().changes).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  test('reports a field the server did not keep', async () => {
    const version = await previewVersion();
    fake.dropField = 'productName';
    expect(await run(['apply', D, JSON.stringify(plan), '--version', version, '--confirmed'])).toBe(1);
    expect(json().problems.join(' ')).toMatch(/productName saved as undefined/);
  });

  test('stops at the first rejected write and says what was written', async () => {
    const version = await previewVersion();
    fake.failOn = (object) => object === 'product';
    expect(await run(['apply', D, JSON.stringify(plan), '--version', version, '--confirmed'])).toBe(1);
    const res = json();
    expect(res.saved).toBe(false);
    expect(res.written.map((x) => x.section)).toEqual(['taxes', 'pricebooks']);
    expect(res.failed).toMatchObject({ section: 'products', error: 'boom' });
    expect(res.notWritten).toBe(2);
  });

  test('a price in an inactive price list is reported as not quotable', async () => {
    const p = { products: [{ productCode: 'cafe', entries: [{ pricebook: 'old', currency: 'COP', price: 1 }] }] };
    const version = await previewVersion(p);
    expect(await run(['apply', D, JSON.stringify(p), '--version', version, '--confirmed'])).toBe(0);
    expect(json().quotable.notQuotable).toHaveLength(1);
  });
});

describe('existing taxes', () => {
  test('find tax by rate in any form, and a new tax with an existing rate is flagged', async () => {
    for (const term of ['19', '19%', '0.19']) {
      out = '';
      expect(await run(['find', D, 'tax', term])).toBe(0);
      expect(json().data.map((x) => x.taxCode)).toEqual(['iva19']);
    }
    out = '';
    expect(await run(['preview', D, JSON.stringify({ taxes: [{ taxCode: 'iva-19-bis', taxName: 'IVA 19% bis', rate: 0.19 }] })])).toBe(0);
    expect(json().warnings.join(' ')).toMatch(/rate 0.19 already exists: IVA 19% \(iva19\)/);
  });
});

describe('product', () => {
  test('shows every price with its price list and taxes, and whether it quotes', async () => {
    expect(await run(['product', D, 'cafe'])).toBe(0);
    const res = json();
    expect(res.prices[0]).toMatchObject({ pricebook: 'General (general)', currency: 'COP', price: 100, taxes: ['IVA 19% (0.19)'] });
    expect(res.product.productFamily).toBe('Salones (sal)');
    expect(res.quotable.quotable).toBe(1);
    expect(out).not.toMatch(/SECRET123/);
  });

  test('prices each price for the quantities asked, in one calculation', async () => {
    expect(await run(['product', D, 'cafe', '--quantity', '1,10'])).toBe(0);
    expect(json().quotable.samples.map((x) => [x.quantity, x.total])).toEqual([[1, 119], [10, 1190]]);
    expect(calls.filter((c) => c.path === '/v2/quote/calculate')).toHaveLength(1);
    expect(await run(['product', D, 'cafe', '--quantity', 'ten'])).toBe(2);
  });
});
