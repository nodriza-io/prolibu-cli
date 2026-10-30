/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const imports = require('../.claude/skills/prolibu-imports/scripts/imports');
const sheet = require('../.claude/skills/prolibu-imports/scripts/sheet');

const D = 'dev99.example.com';
const UNIQUE_REF = new Set(['contact', 'company', 'deal']);
const PK = { contact: 'email', company: 'companyCode', deal: 'dealCode' };
const MODEL_PATH = { Contact: 'contact', Company: 'company', Deal: 'deal' };
// Fake record ids, built at run time: prefix letter + zero padding + the number.
const ID = (prefix, n) => `${prefix}${String(n).padStart(23, '0')}`;

const SCHEMAS = {
  Contact: {
    _id: { type: 'objectid', avoid: 'update' },
    createdAt: { type: 'date', avoid: 'always' },
    refId: { type: 'mixed' },
    refUrl: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    email: { type: 'string', required: true, primaryKey: true },
    company: { type: 'objectid', ref: 'Company' },
    companyName: { type: 'string' },
    clientSince: { type: 'date' },
    numberOfEmployees: { type: 'number' },
    direction: { type: 'string', enum: ['Inbound', 'Outbound'] },
    address: { city: { type: 'string' }, street: { type: 'string' } },
    tags: { type: ['objectid'], ref: 'Tag' },
    assignee: { type: 'objectid', ref: 'User' },
    stage: { type: 'objectid', ref: 'Stage' },
    notes: { type: ['objectid'], ref: 'Note', avoid: 'always' },
    phones: { type: ['mixed'] },
  },
  Company: {
    companyCode: {
      type: 'string', required: true, primaryKey: true, unique: true, hidden: true,
    },
    companyName: { type: 'string', required: true },
    identification: { docId: { type: 'string' } },
    address: { city: { type: 'string' } },
    numberOfEmployees: { type: 'number' },
    refId: { type: 'mixed' },
  },
  Deal: {
    dealCode: {
      type: 'string', required: true, primaryKey: true, unique: true, hidden: true,
    },
    dealName: { type: 'string', required: true },
    contact: { type: 'objectid', ref: 'Contact' },
    company: { type: 'objectid', ref: 'Company', avoid: 'always' },
    closeDate: { type: 'date' },
    stage: { type: 'objectid', ref: 'Stage' },
    refId: { type: 'mixed' },
    proposal: { quote: { type: 'mixed' } },
  },
};

let rootDir;
let scratch;
let out;
let err;
let calls;
let state;
let nextId;

function newId() {
  nextId += 1;
  return String(nextId).padStart(24, '0');
}

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function getPath(o, p) {
  return p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
}

function isPlain(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Mongo-like filter: equality (type-strict), $in (also on array fields), $regex with inline (?i), $or, dotted paths.
function matches(rec, q) {
  return Object.entries(q).every(([k, cond]) => {
    if (k === '$or') return cond.some((c) => matches(rec, c));
    const v = getPath(rec, k);
    if (isPlain(cond) && '$in' in cond) return cond.$in.some((x) => (Array.isArray(v) ? v.includes(x) : x === v));
    if (isPlain(cond) && '$regex' in cond) {
      let src = cond.$regex;
      let flags = '';
      if (src.startsWith('(?i)')) {
        src = src.slice(4);
        flags = 'i';
      }
      return typeof v === 'string' && new RegExp(src, flags).test(v);
    }
    return v === cond;
  });
}

function merge(rec, body) {
  for (const [k, v] of Object.entries(body)) {
    if (v === null) delete rec[k];
    else if (isPlain(v) && isPlain(rec[k])) merge(rec[k], v);
    else rec[k] = v;
  }
}

// Shaped after ImportExportData.importDataJSON: per row, look up by _id or the model's primary
// key (contact email matches whatever the case), PATCH if found, POST otherwise (with the _id
// sent, if any); errors carry the 0-based row; refId is unique on contact/company/deal.
function importer(object, docs) {
  const created = [];
  const updated = [];
  const errors = [];
  const list = state.records[object];
  docs.forEach((doc, i) => {
    const id = doc._id || doc[PK[object]];
    const found = id ? list.find((r) => r._id === id || (r[PK[object]] || '').toLowerCase() === String(id).toLowerCase()) : null;
    const dup = (refId, self) => UNIQUE_REF.has(object) && typeof refId === 'string' && list.some((r) => r.refId === refId && r._id !== self);
    if (found) {
      if (dup(doc.refId, found._id)) {
        errors.push({ type: 'update', row: i, error: `refId '${doc.refId}' ya existe.` });
        return;
      }
      const body = { ...doc };
      delete body._id;
      for (const f of state.dropOnSave || []) delete body[f];
      merge(found, body);
      found.updatedAt = `T${nextId += 1}`;
      updated.push({ ...found });
      return;
    }
    if (object === 'contact' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.email || '')) {
      errors.push({ type: 'create', row: i, error: `Valor de correo inválido: '${doc.email}'` });
      return;
    }
    if (dup(doc.refId)) {
      errors.push({ type: 'create', row: i, error: `refId '${doc.refId}' ya existe.` });
      return;
    }
    const rec = { ...doc, _id: doc._id || newId(), updatedAt: 'T0' };
    if (object === 'company' && !rec.companyCode) rec.companyCode = `CMP-${nextId}`;
    if (object === 'deal' && !rec.dealCode) rec.dealCode = `DEA-${nextId}`;
    for (const f of state.dropOnSave || []) delete rec[f];
    list.push(rec);
    created.push({ ...rec });
  });
  return { created, updated, errors };
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({
    method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body,
  });
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.pathname === '/v2/user/me') {
    return respond(200, { profile: { _id: 'u1', locale: { language: 'es', timeZone: state.userTz } }, modelSchemas: SCHEMAS });
  }
  if (u.pathname === '/v2/user/preferences') {
    return respond(200, {
      locale: { numberFormat: state.numberFormat || '0,000.00', timeZone: state.accountTz },
      integrations: { webhooks: { enabled: true }, lifecycleHooks: { enabled: true, enabledEntities: ['Contact'] } },
    });
  }
  if (u.pathname === '/v2/service/importdata' && init.method === 'PUT') {
    if (state.importerStatus) return respond(state.importerStatus, { statusCode: state.importerStatus, error: 'Too many requests.' });
    const object = MODEL_PATH[u.searchParams.get('modelName')];
    if (!object) return respond(400, { statusCode: 400, error: `El modelo '${u.searchParams.get('modelName')}' no existe` });
    return respond(200, importer(object, body));
  }
  if (u.pathname === '/v2/service/importjobs') return respond(200, { docs: state.jobs, total: state.jobs.length });
  if (parts[2] === 'importjob') {
    const job = state.jobs.find((j) => j._id === parts[3]);
    return job ? respond(200, job) : respond(400, { statusCode: 400, error: 'Import job not found' });
  }
  const object = parts[1];
  if (init.method === 'GET' && parts.length === 2) {
    if (object === 'syncconnection') return respond(200, { pagination: { count: state.sync.length }, data: state.sync });
    const source = {
      stage: state.stages, webhook: state.webhooks, script: state.scripts, eventtrigger: [],
    }[object] || state.records[object] || [];
    const xq = u.searchParams.has('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const found = source.filter((r) => matches(r, xq));
    const limit = Number(u.searchParams.get('limit') || 20);
    return respond(200, { pagination: { count: found.length }, data: found.slice(0, limit) });
  }
  return respond(404, { statusCode: 404, error: `unexpected ${init.method} ${u.pathname}` });
}

async function run(...argv) {
  const stdout = { write: (t) => { out += t; } };
  const stderr = { write: (t) => { err += t; } };
  out = '';
  err = '';
  const code = await imports.main(argv, {
    rootDir, fetchImpl: fakeFetch, stdout, stderr,
  });
  let json = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = null;
  }
  return { code, json };
}

const puts = () => calls.filter((c) => c.method === 'PUT');

const CONTACT_MAPPING = {
  Correo: 'email', Nombre: 'firstName', Apellido: 'lastName', Empresa: 'company', Desde: 'clientSince', Empleados: 'numberOfEmployees',
};

// Maps the columns the rows use, as the agent would after inspect.
function contactPlan(rows, extra = {}) {
  const columns = new Set(rows.flatMap((r) => Object.keys(r)));
  const mapping = Object.fromEntries(Object.entries(CONTACT_MAPPING).filter(([c]) => columns.has(c)));
  return JSON.stringify({
    object: 'contact', rows, mapping, ...extra,
  });
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-root-'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-scratch-'));
  process.env.CLAUDE_SCRATCHPAD = scratch;
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'k-secret-123' }));
  calls = [];
  nextId = 1000;
  state = {
    records: {
      contact: [{
        _id: ID('c', 1), email: 'ana@acme.com', firstName: 'Ana', lastName: 'Ruiz', updatedAt: 'T1',
      }],
      company: [
        {
          _id: ID('f', 1), companyName: 'Acme SAS', companyCode: 'CMP-1', identification: { docId: '900-1' }, updatedAt: 'T1',
        },
        {
          _id: ID('f', 2), companyName: 'Twin Co', companyCode: 'CMP-2', updatedAt: 'T1',
        },
        {
          _id: ID('f', 3), companyName: 'twin  co', companyCode: 'CMP-3', updatedAt: 'T1',
        },
      ],
      deal: [{
        _id: ID('d', 1), dealName: 'Old deal', dealCode: 'DEA-1', refId: 900001, updatedAt: 'T1',
      }],
    },
    stages: [
      {
        _id: 's00000000000000000000001', stageName: 'Reunión Agendada', stageCode: 'meeting', stageType: 'Deal.stage', active: true,
      },
      {
        _id: 's00000000000000000000002', stageName: 'Aprobado', stageCode: 'approved', stageType: 'Deal.stage', active: true, endFlowStage: true,
      },
      {
        _id: 's00000000000000000000003', stageName: 'Nuevo', stageCode: 'contact-new', stageType: 'Contact.stage', active: true,
      },
      {
        _id: 's00000000000000000000004', stageName: 'Viejo', stageCode: 'old', stageType: 'Deal.stage', active: false,
      },
    ],
    webhooks: [{ webhookName: 'ERP', eventNames: ['Contact.create'], active: true }, { webhookName: 'Other', eventNames: ['Deal.update'], active: true }],
    scripts: [{ scriptName: 'Enrich', lifecycleHooks: ['Contact'], active: true }],
    sync: [],
    jobs: [],
    userTz: 'America/Bogota',
  };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  delete process.env.CLAUDE_SCRATCHPAD;
});

// ─── Files ─────────────────────────────────────────────────────────────────────

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

function xlsxFile(dir) {
  const file = path.join(dir, 'book.xlsx');
  fs.writeFileSync(file, zip([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/><sheet name="Otra" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<sst><si><t>Correo</t></si><si><t>Desde</t></si><si><r><t>Ana</t></r><r><t xml:space="preserve"> &amp; Co</t></r></si><si><t/></si></sst>', true],
    ['xl/styles.xml', '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Activo</t></is></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46085</v></c><c r="D2" t="b"><v>1</v></c></row>'
      + '<row r="3"/>'
      + '<row r="4"><c r="A4"><v>7.5</v></c><c r="B4" s="2"><v>46085.5</v></c><c r="C4"><v>9</v></c></row>'
      + '</sheetData></worksheet>', true],
    ['xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>'],
  ]));
  return file;
}

describe('file readers', () => {
  test('CSV: delimiter, quotes, line breaks, BOM and row numbers as the sheet shows them', () => {
    const file = path.join(scratch, 'a.csv');
    fs.writeFileSync(file, '﻿Correo;Nota;Nota\r\nana@acme.com;"uno; dos";x\r\n;;\r\nbo@example.com;"línea 1\nlínea ""2""";y\r\n');
    const t = sheet.readTable(file);
    expect(t.delimiter).toBe(';');
    expect(t.headers).toEqual(['Correo', 'Nota', 'Nota (2)']);
    expect(t.rows).toEqual([
      { row: 2, values: { Correo: 'ana@acme.com', Nota: 'uno; dos', 'Nota (2)': 'x' } },
      { row: 4, values: { Correo: 'bo@example.com', Nota: 'línea 1\nlínea "2"', 'Nota (2)': 'y' } },
    ]);
    expect(t.warnings.join(' ')).toMatch(/Two columns are called "Nota"/);
  });

  test('CSV saved by Excel on Windows (not UTF-8) is read as Latin-1 with a warning', () => {
    const file = path.join(scratch, 'b.csv');
    fs.writeFileSync(file, Buffer.from('Nombre,Ciudad\nJos\xe9,Bogot\xe1\n', 'latin1'));
    const t = sheet.readTable(file);
    expect(t.rows[0].values).toEqual({ Nombre: 'José', Ciudad: 'Bogotá' });
    expect(t.warnings.join(' ')).toMatch(/Latin-1/);
  });

  test('XLSX: shared and inline strings, booleans, date formats, sparse cells, sheets', () => {
    const file = xlsxFile(scratch);
    const t = sheet.readTable(file);
    expect(t.sheets).toEqual(['Datos', 'Otra']);
    expect(t.headers).toEqual(['Correo', 'Desde', 'Activo']);
    expect(t.rows).toEqual([
      { row: 2, values: { Correo: 'Ana & Co', Desde: '2026-03-04', Activo: true } },
      { row: 4, values: { Correo: 7.5, Desde: '2026-03-04 12:00:00' } },
    ]);
    expect(t.warnings.join(' ')).toMatch(/no header/);
    expect(sheet.readTable(file, { sheet: 'Otra' }).headers).toEqual(['x']);
    expect(() => sheet.readTable(file, { sheet: 'Nope' })).toThrow(/no sheet named "Nope"/);
  });

  test('refuses other formats and damaged workbooks', () => {
    const xls = path.join(scratch, 'old.xls');
    fs.writeFileSync(xls, 'x');
    expect(() => sheet.readTable(xls)).toThrow(/Only \.csv, \.tsv, \.txt and \.xlsx/);
    const bad = path.join(scratch, 'bad.xlsx');
    fs.writeFileSync(bad, 'not a zip at all, just text that is long enough');
    expect(() => sheet.readTable(bad)).toThrow(/not a valid \.xlsx/);
  });
});

describe('values', () => {
  test('numbers follow the decimal separator, and a lone "1.200" is ambiguous until the user says', () => {
    expect(imports.parseNumber('1.234,56', '.', false)).toEqual({ value: 1234.56 });
    expect(imports.parseNumber('7,5', '.', false)).toEqual({ value: 7.5 });
    expect(imports.parseNumber('1.200', '.', false).ambiguousNumber).toBe(true);
    expect(imports.parseNumber('1.200', ',', true)).toEqual({ value: 1200 });
    expect(imports.parseNumber('1.200', '.', true)).toEqual({ value: 1.2 });
    expect(imports.parseNumber('abc', '.', false).error).toMatch(/not a number/);
  });

  test('dates are read in the time zone; day/month order must be known', () => {
    const tz = { timeZone: 'America/Bogota' };
    expect(imports.parseDate('2026-03-04', tz)).toEqual({ value: '2026-03-04T05:00:00.000Z' });
    expect(imports.parseDate('13/04/2026', tz)).toEqual({ value: '2026-04-13T05:00:00.000Z' });
    expect(imports.parseDate('03/04/2026', tz).ambiguousDate).toBe(true);
    expect(imports.parseDate('03/04/2026', { ...tz, dateOrder: 'MDY' })).toEqual({ value: '2026-03-04T05:00:00.000Z' });
    expect(imports.parseDate('2026-03-04T10:00:00Z', {})).toEqual({ value: '2026-03-04T10:00:00.000Z' });
    expect(imports.parseDate('2026-03-04', {}).needsZone).toBe(true);
    expect(imports.parseDate(46085, tz)).toEqual({ value: '2026-03-04T05:00:00.000Z' });
  });

  test('refId goes as text, emails lower case, enums take the stored spelling', () => {
    const f = imports.importableFields(SCHEMAS.Contact);
    expect(imports.convert('refId', f.refId, 900001, {})).toEqual({ value: '900001' });
    expect(imports.convert('email', f.email, ' Ana@ACME.com ', {})).toEqual({ value: 'ana@acme.com' });
    expect(imports.convert('email', f.email, 'nope', {}).error).toMatch(/not a valid email/);
    expect(imports.convert('direction', f.direction, 'inbound', {})).toEqual({ value: 'Inbound' });
    expect(imports.convert('refUrl', f.refUrl, 'https://erp.example.com/x?token=1', {}).error).toMatch(/credential/);
  });

  test('platform fields and fields of other skills are not importable', () => {
    const f = imports.importableFields(SCHEMAS.Deal);
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['dealName', 'contact', 'closeDate', 'stage', 'refId']));
    expect(f.company).toBeUndefined();
    expect(f['proposal.quote']).toBeUndefined();
    expect(f.dealCode.required).toBe(false);
    expect(imports.importableFields(SCHEMAS.Contact).phones).toBeUndefined();
  });
});

describe('plan', () => {
  test('only contacts, companies and deals; nothing from accounts/', async () => {
    let r = await run('preview', D, JSON.stringify({ object: 'ticket', rows: [{ a: 1 }], mapping: { a: 'x' } }));
    expect(r.code).toBe(2);
    expect(err).toMatch(/contact, company or deal/);
    fs.writeFileSync(path.join(rootDir, 'accounts', D, 'notes.csv'), 'a\n1\n');
    r = await run('inspect', D, 'contact', path.join(rootDir, 'accounts', D, 'notes.csv'));
    expect(r.code).toBe(2);
    expect(err).toMatch(/nothing under accounts\//);
    r = await run('inspect', D, 'contact', path.join(rootDir, 'accounts', D, 'profile.json'));
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('mapping must name real columns and importable fields, one column per field', async () => {
    let r = await run('preview', D, contactPlan([{ Correo: 'a@b.co' }], { mapping: { Mail: 'email' } }));
    expect(r.code).toBe(2);
    expect(err).toMatch(/column the file does not have: "Mail"/);
    r = await run('preview', D, contactPlan([{ Correo: 'a@b.co', Notas: 'x' }], { mapping: { Correo: 'email', Notas: 'notes' } }));
    expect(r.code).toBe(2);
    expect(err).toMatch(/set by the platform/);
    r = await run('preview', D, contactPlan([{ Correo: 'a@b.co', Mail: 'b@b.co' }], { mapping: { Correo: 'email', Mail: 'email' } }));
    expect(r.code).toBe(2);
    expect(err).toMatch(/both go to "email"/);
    r = await run('preview', D, contactPlan([{ Nombre: 'x' }], { mapping: { Nombre: 'firstName' } }));
    expect(r.code).toBe(2);
    expect(err).toMatch(/matched by "email", but no column is mapped/);
    expect(puts()).toHaveLength(0);
  });

  test('_id match is for existing records only', async () => {
    const r = await run('preview', D, JSON.stringify({
      object: 'contact', rows: [{ Id: ID('c', 1) }], mapping: { Id: '_id' }, match: '_id',
    }));
    expect(r.code).toBe(2);
    expect(err).toMatch(/"missing": "skip"/);
  });
});

describe('preview', () => {
  test('contacts: create, skip existing (any case), duplicate in file, errors, references and side effects', async () => {
    const r = await run('preview', D, contactPlan([
      { Correo: 'ANA@acme.com', Nombre: 'Ana' },
      { Correo: 'bo@example.com', Nombre: 'Bo', Empresa: 'acme  sas', Empleados: '12' },
      { Correo: 'Bo@Example.com', Nombre: 'Bo again' },
      { Correo: 'cy@example.com', Empresa: 'Nope Inc' },
      { Correo: 'dee@example.com', Empresa: 'twin co' },
      { Correo: 'bad-email', Nombre: 'Bad' },
    ]));
    expect(r.code).toBe(0);
    const byRow = Object.fromEntries(r.json.rows.map((x) => [x.row, x]));
    expect(byRow[2].action).toBe('skip');
    expect(byRow[3]).toMatchObject({ action: 'create', values: { email: 'bo@example.com', company: ID('f', 1), numberOfEmployees: 12 } });
    expect(byRow[4]).toMatchObject({ action: 'duplicateInFile' });
    expect(byRow[5].errors[0]).toMatch(/no company "Nope Inc"/);
    expect(byRow[6].errors[0]).toMatch(/2 companies are called "twin co"/);
    expect(byRow[7].errors[0]).toMatch(/not a valid email/);
    expect(r.json.counts).toMatchObject({ create: 1, skip: 1, toWrite: 1 });
    expect(r.json.sideEffects.webhooks).toEqual([{ name: 'ERP', events: ['Contact.create'] }]);
    expect(r.json.sideEffects.scripts).toEqual(['Enrich']);
    expect(fs.readFileSync(r.json.reportFile, 'utf8')).toMatch(/duplicateInFile/);
    expect(puts()).toHaveLength(0);
  });

  test('existing "update" sends only the fields that change; unchanged rows are left alone', async () => {
    const r = await run('preview', D, contactPlan([
      { Correo: 'ana@acme.com', Nombre: 'Ana', Apellido: 'Gómez' },
      { Correo: 'ana@acme.com' },
    ], { existing: 'update' }));
    const row = r.json.rows.find((x) => x.row === 2);
    expect(row.changes).toEqual([{ field: 'lastName', from: 'Ruiz', to: 'Gómez' }]);
    expect(r.json.counts.update).toBe(1);
    const again = await run('preview', D, contactPlan([{ Correo: 'ana@acme.com', Nombre: 'Ana' }], { existing: 'update' }));
    expect(again.json.rows[0].action).toBe('unchanged');
  });

  test('updateFields limits what changes on existing records; the matched key is never rewritten', async () => {
    const r = await run('preview', D, JSON.stringify({
      object: 'company',
      rows: [{ E: 'ACME SAS', C: 'Cali', N: '900-2' }, { E: 'New Co', C: 'Lima', N: '7' }],
      mapping: { E: 'companyName', C: 'address.city', N: 'identification.docId' },
      existing: 'update',
      updateFields: ['address.city'],
    }));
    const byRow = Object.fromEntries(r.json.rows.map((x) => [x.row, x]));
    expect(byRow[2].changes).toEqual([{ field: 'address.city', from: null, to: 'Cali' }]);
    expect(byRow[3].values).toEqual({ companyName: 'New Co', address: { city: 'Lima' }, identification: { docId: '7' } });
    const bad = await run('preview', D, JSON.stringify({
      object: 'company', rows: [{ E: 'x' }], mapping: { E: 'companyName' }, updateFields: ['address.city'],
    }));
    expect(bad.code).toBe(2);
  });

  test('blocks on dates without a time zone, ambiguous dates and ambiguous numbers', async () => {
    state.userTz = undefined;
    let r = await run('preview', D, contactPlan([{ Correo: 'x@example.com', Desde: '2026-01-02' }]));
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/time zone/);
    state.userTz = 'America/Bogota';
    r = await run('preview', D, contactPlan([{ Correo: 'x@example.com', Desde: '02/03/2026', Empleados: '1.200' }]));
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/day\/month or month\/day/);
    expect(r.json.blockers.join(' ')).toMatch(/thousands or decimals/);
    r = await run('preview', D, contactPlan([{ Correo: 'x@example.com', Desde: '02/03/2026', Empleados: '1.200' }], { dateOrder: 'DMY', decimalSeparator: ',' }));
    expect(r.code).toBe(0);
    expect(r.json.rows[0].values).toMatchObject({ clientSince: '2026-03-02T05:00:00.000Z', numberOfEmployees: 1200 });
  });

  test('companies by name: case and spaces ignored, two records with the name are ambiguous', async () => {
    const r = await run('preview', D, JSON.stringify({
      object: 'company',
      rows: [{ Empresa: 'ACME sas' }, { Empresa: 'Twin Co' }, { Empresa: 'New One', NIT: '1' }],
      mapping: { Empresa: 'companyName', NIT: 'identification.docId' },
    }));
    const byRow = Object.fromEntries(r.json.rows.map((x) => [x.row, x]));
    expect(byRow[2]).toMatchObject({ action: 'skip', recordId: ID('f', 1) });
    expect(byRow[3]).toMatchObject({ action: 'ambiguous', recordIds: [ID('f', 2), ID('f', 3)] });
    expect(byRow[4]).toMatchObject({ action: 'create', values: { companyName: 'New One', identification: { docId: '1' } } });
  });

  test('deals: contact by email, stage of its own pipeline, refId twins, amount and closed-stage warnings', async () => {
    state.records.contact.push({ _id: ID('c', 2), email: 'bo@example.com', updatedAt: 'T1' });
    const r = await run('preview', D, JSON.stringify({
      object: 'deal',
      rows: [
        {
          Negocio: 'D1', Contacto: 'BO@example.com', Etapa: 'reunion agendada', Id: 'E-1', Valor: '10',
        },
        { Negocio: 'D2', Etapa: 'Nuevo', Id: 'E-2' },
        { Negocio: 'D3', Etapa: 'Viejo', Id: 'E-3' },
        { Negocio: 'D4', Id: '900001' },
        { Negocio: 'D5', Etapa: 'aprobado', Id: 'E-5' },
      ],
      mapping: {
        Negocio: 'dealName', Contacto: 'contact', Etapa: 'stage', Id: 'refId', Valor: null,
      },
      match: 'refId',
    }));
    expect(r.code).toBe(0);
    const byRow = Object.fromEntries(r.json.rows.map((x) => [x.row, x]));
    expect(byRow[2].values).toMatchObject({ contact: ID('c', 2), stage: 's00000000000000000000001', refId: 'E-1' });
    expect(byRow[3].errors[0]).toMatch(/not an active stage of the Deal.stage pipeline/);
    expect(byRow[4].errors[0]).toMatch(/not an active stage/);
    expect(byRow[5]).toMatchObject({ action: 'ambiguous', recordIds: [ID('d', 1)] });
    expect(r.json.warnings.join(' ')).toMatch(/no amount field/);
    expect(r.json.warnings.join(' ')).toMatch(/closed stage \(Aprobado\)/);
    expect(r.json.sideEffects.webhooks).toEqual([]);
  });

  test('moving the stage of an existing record is left to prolibu-stages', async () => {
    state.records.contact[0].stage = 's00000000000000000000099';
    state.stages.push({
      _id: 's00000000000000000000099', stageName: 'Otro', stageType: 'Contact.stage', active: true,
    });
    const r = await run('preview', D, JSON.stringify({
      object: 'contact', rows: [{ Correo: 'ana@acme.com', Etapa: 'Nuevo' }], mapping: { Correo: 'email', Etapa: 'stage' }, existing: 'update',
    }));
    expect(r.json.rows[0].errors[0]).toMatch(/prolibu-stages/);
  });

  test('bulk edit by _id: an unknown id is an error (the importer would create a record with it)', async () => {
    const r = await run('preview', D, JSON.stringify({
      object: 'contact',
      rows: [{ Id: ID('c', 1), Ciudad: 'Cali' }, { Id: ID('c', 'dead'), Ciudad: 'Cali' }],
      mapping: { Id: '_id', Ciudad: 'address.city' },
      match: '_id',
      existing: 'update',
      missing: 'skip',
    }));
    const byRow = Object.fromEntries(r.json.rows.map((x) => [x.row, x]));
    expect(byRow[2]).toMatchObject({ action: 'update', changes: [{ field: 'address.city', from: null, to: 'Cali' }] });
    expect(byRow[3].errors[0]).toMatch(/would create a new record with that id/);
  });

  test('refId on an object a CRM sync owns is blocked', async () => {
    state.sync = [{
      _id: 'x', active: true, connector: 'hubspot', objects: [{ objectType: 'Contact', active: true, direction: 'both' }],
    }];
    const r = await run('preview', D, JSON.stringify({
      object: 'contact', rows: [{ Correo: 'z@example.com', Id: 'H-1' }], mapping: { Correo: 'email', Id: 'refId' },
    }));
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/refId cannot be written on contact/);
  });
});

describe('apply', () => {
  async function previewVersion(plan) {
    const r = await run('preview', D, plan);
    return r.json.version;
  }

  test('needs --confirmed and the preview version, and refuses when the account changed', async () => {
    const plan = contactPlan([{ Correo: 'new@example.com', Nombre: 'N' }]);
    let r = await run('apply', D, plan, '--version', 'x');
    expect(r.code).toBe(2);
    r = await run('apply', D, plan, '--confirmed');
    expect(r.code).toBe(2);
    expect(err).toMatch(/Missing --version/);
    const v = await previewVersion(plan);
    state.records.contact.push({ _id: ID('c', 9), email: 'new@example.com', updatedAt: 'T1' });
    r = await run('apply', D, plan, '--version', v, '--confirmed');
    expect(r.code).toBe(3);
    expect(err).toMatch(/changed since the preview/);
    expect(puts()).toHaveLength(0);
  });

  test('writes through the importer in chunks, reports each row and reads it back', async () => {
    const plan = contactPlan([
      { Correo: 'ana@acme.com', Apellido: 'Gómez' },
      { Correo: 'n1@example.com', Nombre: 'N1' },
      { Correo: 'n2@example.com', Nombre: 'N2', Empresa: 'CMP-1' },
    ], { existing: 'update', defaults: { source: 'fair' } });
    SCHEMAS.Contact.source = { type: 'string' };
    const v = await previewVersion(plan);
    const r = await run('apply', D, plan, '--version', v, '--confirmed', '--chunk', '2');
    delete SCHEMAS.Contact.source;
    expect(r.code).toBe(0);
    expect(r.json.saved).toBe(true);
    expect(r.json.counts).toEqual({ updated: 1, created: 2 });
    expect(puts().map((c) => c.query.modelName)).toEqual(['Contact', 'Contact']);
    expect(puts()[0].body[0]).toEqual({ _id: ID('c', 1), lastName: 'Gómez' });
    expect(puts()[0].body[1]).toEqual({ email: 'n1@example.com', firstName: 'N1', source: 'fair' });
    expect(state.records.contact.find((c) => c.email === 'n2@example.com').company).toBe(ID('f', 1));
    expect(state.records.contact[0].source).toBeUndefined();
    expect(fs.readFileSync(r.json.reportFile, 'utf8')).toMatch(/created/);
  });

  test('row errors from the importer and fields that did not save are reported, exit 1', async () => {
    const plan = JSON.stringify({
      object: 'company', rows: [{ E: 'Uno', R: 'R-1' }, { E: 'Dos', R: 'R-1x' }], mapping: { E: 'companyName', R: 'refId' },
    });
    const v = await previewVersion(plan);
    state.records.company.push({
      _id: ID('f', 9), companyName: 'Other', companyCode: 'CMP-9', refId: 'R-1x', updatedAt: 'T1',
    });
    // The new record does not change the preview (different name), so the version still holds.
    state.dropOnSave = ['refId'];
    const r = await run('apply', D, plan, '--version', v, '--confirmed');
    expect(r.code).toBe(1);
    expect(r.json.saved).toBe(false);
    expect(r.json.problems.join(' ')).toMatch(/refId was saved as null/);
  });

  test('a refused chunk stops the run and nothing after it is sent', async () => {
    const plan = contactPlan([{ Correo: 'a1@example.com' }, { Correo: 'a2@example.com' }, { Correo: 'a3@example.com' }]);
    const v = await previewVersion(plan);
    state.importerStatus = 429;
    const r = await run('apply', D, plan, '--version', v, '--confirmed', '--chunk', '2');
    expect(r.code).toBe(1);
    expect(r.json.stopped).toMatch(/429/);
    expect(r.json.counts).toEqual({ notSent: 3 });
    expect(puts()).toHaveLength(1);
  });

  test('a row the importer turns into an update is flagged', () => {
    const rows = [{ action: 'create', key: 'x@example.com', row: 2 }];
    const res = imports.matchResults(rows, { created: [], updated: [{ _id: 'c1', email: 'x@example.com' }], errors: [] }, 'email');
    expect(res[0]).toMatchObject({ status: 'updated', problem: expect.stringMatching(/instead of creating/) });
    const err0 = imports.matchResults(rows, { created: [], updated: [], errors: [{ type: 'create', row: 0, error: 'bad' }] }, 'email');
    expect(err0[0]).toMatchObject({ status: 'failed', error: 'bad' });
  });

  test('more rows than one run sends are refused; export writes the file instead', async () => {
    const rows = Array.from({ length: 301 }, (_, i) => ({ Correo: `p${i}@example.com` }));
    const plan = contactPlan(rows);
    const v = await previewVersion(plan);
    let r = await run('apply', D, plan, '--version', v, '--confirmed');
    expect(r.code).toBe(3);
    expect(err).toMatch(/Run export/);
    expect(puts()).toHaveLength(0);
    r = await run('export', D, plan);
    expect(r.code).toBe(2);
    r = await run('export', D, plan, '--version', v);
    expect(r.code).toBe(0);
    const bodies = JSON.parse(fs.readFileSync(r.json.file, 'utf8'));
    expect(bodies).toHaveLength(301);
    expect(bodies[0]).toEqual({ email: 'p0@example.com' });
    expect(puts()).toHaveLength(0);
  });
});

describe('the app\'s imports', () => {
  test('jobs and job: counts, bulk edits and the meaning of row numbers', async () => {
    state.jobs = [
      {
        _id: ID('a', 1), status: 'completed', modelName: 'Contact', fileName: 'bulk-edit-contact.json', totalRows: 2, successRows: 2, errorRows: 0, errors: [],
      },
      {
        _id: ID('a', 2), status: 'completed', modelName: 'Deal', fileName: 'deals.xlsx', totalRows: 3, successRows: 1, errorRows: 2, errors: [{ row: 2, error: 'x' }],
      },
    ];
    let r = await run('jobs', D, '--limit', '5');
    expect(r.json.jobs.map((j) => j.kind)).toEqual(['bulk edit', 'import']);
    r = await run('job', D, ID('a', 2));
    expect(r.json.errors).toEqual([{ row: 2, error: 'x' }]);
    expect(r.json.errorsNote.join(' ')).toMatch(/first 1 of 2/);
    expect(r.json.errorsNote.join(' ')).toMatch(/spreadsheet row N\+1/);
  });
});

describe('secrets', () => {
  test('the API key never reaches the output', async () => {
    await run('preview', D, contactPlan([{ Correo: 'k-secret-123@example.com' }]));
    expect(out).not.toMatch(/k-secret-123/);
    expect(out).toMatch(/\*\*\*@example\.com/);
  });
});
