/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const bulk = require('../.claude/skills/prolibu-catalog/scripts/bulk-prices');

const D = 'dev99.example.com';

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let db;
let fake;
let sleeps;
let seq;

function id(n) {
  return String(n).padStart(24, '0');
}

// ─── A fake account, shaped after the verified server behavior ─────────────────
// Lists accept xquery with $and, $in and {_id: {$gt}}, sort=_id and limit. The importer looks
// each row up by _id, else by pricebookEntryCode, then PATCHes or POSTs it; a second price
// for the same product and list fails that row; with silent=true it answers counts.

function matches(doc, q) {
  if (!q) return true;
  return Object.entries(q).every(([k, cond]) => {
    if (k === '$and') return cond.every((c) => matches(doc, c));
    const v = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) return cond.$in.map(String).includes(String(v));
      if ('$gt' in cond) return String(v) > String(cond.$gt);
    }
    return String(v) === String(cond);
  });
}

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function importRows(rows) {
  const errors = [];
  let created = 0;
  let updated = 0;
  rows.forEach((row, i) => {
    if (fake.failRow && fake.failRow(row)) {
      errors.push({ type: row._id ? 'update' : 'create', row: i, error: 'Validation failed' });
      return;
    }
    const key = row._id || row.pricebookEntryCode;
    const found = key ? db.pricebookentry.find((e) => (row._id ? e._id === row._id : e.pricebookEntryCode === key)) : null;
    if (found) {
      Object.assign(found, row);
      updated += 1;
      return;
    }
    if (db.pricebookentry.some((e) => e.pricebook === row.pricebook && e.product === row.product)) {
      errors.push({ type: 'create', row: i, error: `pricebook '${row.pricebook}' already exists` });
      return;
    }
    // The server's default code is "ENT-" + (ms + random offset): seen live colliding inside
    // one import ("pricebookEntryCode 'ENT-…' ya existe."). fake.sameDefaultCode reproduces it.
    const code = row.pricebookEntryCode || (fake.sameDefaultCode ? 'ENT-1795556607335' : `ENT-${seq + 1}`);
    if (db.pricebookentry.some((e) => e.pricebookEntryCode === code)) {
      errors.push({ type: 'create', row: i, error: `pricebookEntryCode '${code}' ya existe.` });
      return;
    }
    seq += 1;
    db.pricebookentry.push({
      _id: id(900 + seq), active: true, taxes: [], ...row, pricebookEntryCode: code,
    });
    created += 1;
  });
  return { created, updated, errors };
}

async function fetchImpl(url, init) {
  const u = new URL(url);
  const method = init.method;
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: u.pathname, params: Object.fromEntries(u.searchParams), body });
  if (fake.status429 && fake.status429 > 0) {
    fake.status429 -= 1;
    return respond(429, { error: 'Too many requests.' });
  }
  if (method === 'GET' && u.pathname === '/v2/user/me') {
    return respond(200, {
      profile: { isAdmin: false, roles: [{ permissions: fake.permissions || ['Resource@PricebookEntry.find', 'Resource@PricebookEntry.create', 'Resource@PricebookEntry.update'] }] },
      modelSchemas: { PricebookEntry: { currency: { type: 'string', enum: ['COP', 'USD', 'MXN'] } } },
    });
  }
  if (method === 'PUT' && u.pathname === '/v2/service/importdata') {
    if (fake.importerThrows) {
      fake.importerThrows = false;
      importRows(body);
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    const result = importRows(body);
    return respond(200, result);
  }
  const m = u.pathname.match(/^\/v2\/(\w+)$/);
  if (method === 'GET' && m) {
    const object = m[1];
    if (['webhook', 'script', 'eventtrigger'].includes(object)) {
      if (fake.effects) return respond(200, { pagination: { count: fake.effects[object] || 0 }, data: [] });
      return respond(403, { error: 'Forbidden' });
    }
    if (!db[object]) return respond(404, { error: 'not found' });
    const xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : null;
    const limit = Number(u.searchParams.get('limit') || 25);
    const rows = db[object].filter((doc) => matches(doc, xquery)).sort((a, b) => (a._id < b._id ? -1 : 1));
    return respond(200, { pagination: { count: rows.length }, data: rows.slice(0, limit).map((r) => ({ ...r })) });
  }
  return respond(404, { error: 'not found' });
}

async function run(...args) {
  out = '';
  err = '';
  const code = await bulk.main(args, {
    rootDir,
    fetchImpl,
    stdout: { write: (t) => { out += t; } },
    stderr: { write: (t) => { err += t; } },
    sleep: async (ms) => { sleeps.push(ms); },
    budget: fake.budget,
    jobsRoot: path.join(tmpDir, 'jobs'),
  });
  let json = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = null;
  }
  return { code, json };
}

function writes() {
  return calls.filter((c) => c.method !== 'GET');
}

function csv(name, text) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, text);
  return file;
}

const MAP = JSON.stringify({
  product: 'Código', pricebook: 'Lista', price: 'Precio', currency: 'Moneda', taxRate: 'IVA',
});

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-bulk-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-bulk-tmp-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  calls = [];
  sleeps = [];
  seq = 0;
  fake = {};
  db = {
    tax: [
      { _id: id(1), taxCode: 'iva19', taxName: 'IVA 19%', rate: 0.19 },
      { _id: id(2), taxCode: 'cero', taxName: 'Cero', rate: 0 },
    ],
    pricebook: [
      { _id: id(10), pricebookCode: 'sede-a', pricebookName: 'Sede A', active: true },
      { _id: id(11), pricebookCode: 'sede-b', pricebookName: 'Sede B', active: true },
      { _id: id(12), pricebookCode: 'otra', pricebookName: 'Other list', active: true },
    ],
    product: [
      { _id: id(20), productCode: 'p1', productName: 'P1', active: true },
      { _id: id(21), productCode: 'p2', productName: 'P2', active: true },
      { _id: id(22), productCode: 'p3', productName: 'P3', active: true },
      { _id: id(23), productCode: 'p4', productName: 'P4', active: false },
    ],
    pricebookentry: [
      {
        _id: id(30), pricebook: id(10), product: id(20), pricebookEntryCode: 'e-a-p1', currency: 'COP', price: 1000, cost: 0, taxes: [id(1)], active: true,
      },
      {
        _id: id(31), pricebook: id(10), product: id(21), pricebookEntryCode: 'e-a-p2', currency: 'COP', price: 2000, taxes: [], active: true,
      },
      {
        _id: id(32), pricebook: id(12), product: id(22), pricebookEntryCode: 'e-otra-p3', currency: 'COP', price: 3000, taxes: [], active: true,
      },
      {
        _id: id(33), pricebook: id(11), product: id(20), pricebookEntryCode: 'e-b-p1', currency: 'COP', price: 1550, taxes: [], active: false,
      },
      {
        _id: id(34), pricebook: id(11), product: id(21), pricebookEntryCode: 'e-b-p2', currency: 'COP', price: 0, pricingMethod: 'Percent Of Total', taxes: [], active: true,
      },
    ],
  };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// p1 same price (unchanged), p2 new price (update), p3 new in sede-a (create).
const BASIC = 'Código;Lista;Precio;Moneda;IVA\np1;sede-a;1000;COP;19%\np2;sede-a;2100;COP;0\np3;sede-a;500;COP;19\n';

async function previewBasic(text = BASIC, ...extra) {
  const r = await run('preview', D, csv('prices.csv', text), '--map', MAP, ...extra);
  return r;
}

describe('bulk preview', () => {
  test('decides create, update and unchanged by product and price list, and writes nothing', async () => {
    const { code, json } = await previewBasic();
    expect(code).toBe(0);
    expect(json.counts).toEqual({
      create: 1, update: 1, unchanged: 1, error: 0,
    });
    expect(json.sample.updates[0]).toMatchObject({ product: 'p2', pricebook: 'sede-a', to: { price: 2100 } });
    expect(json.sample.creates[0]).toMatchObject({ product: 'p3', values: { price: 500, currency: 'COP', taxes: [id(1)] } });
    expect(json.priceTotals).toMatchObject({
      pricesChanged: 1, raised: 1, sumBefore: 2000, sumAfter: 2100,
    });
    expect(json.version).toMatch(/^[a-f0-9]{16}$/);
    expect(json.nextStep).toMatch(/^STOP/);
    expect(writes()).toEqual([]);
    expect(fs.existsSync(json.detailFile)).toBe(true);
  });

  test('reads with a cursor on _id only, one page at a time, never page= or another sort', async () => {
    for (let i = 0; i < 1100; i += 1) {
      db.pricebookentry.push({
        _id: `${'f'.repeat(16)}${String(i).padStart(8, '0')}`, pricebook: id(12), product: id(22), price: 1, currency: 'COP', taxes: [],
      });
    }
    db.pricebookentry.push({
      _id: 'f'.repeat(24), pricebook: id(10), product: id(22), pricebookEntryCode: 'late', price: 7, currency: 'COP', taxes: [],
    });
    const { json } = await previewBasic();
    expect(json.counts.update).toBe(2);
    const gets = calls.filter((c) => c.method === 'GET' && c.params.limit && c.params.limit !== '1');
    expect(gets.every((c) => c.params.sort === '_id' && !c.params.page)).toBe(true);
    const entryReads = gets.filter((c) => c.path === '/v2/pricebookentry');
    expect(entryReads.length).toBeGreaterThan(0);
    expect(gets.some((c) => /"\$gt"/.test(c.params.xquery || ''))).toBe(false);
  });

  test('walks pages by _id > last when a page is full', async () => {
    for (let i = 0; i < 1001; i += 1) {
      db.pricebookentry.push({
        _id: `${'e'.repeat(16)}${String(i).padStart(8, '0')}`, pricebook: id(10), product: `${'d'.repeat(16)}${String(i).padStart(8, '0')}`, price: 1, currency: 'COP', taxes: [],
      });
    }
    await previewBasic();
    const pages = calls.filter((c) => c.path === '/v2/pricebookentry' && /"pricebook"/.test(c.params.xquery));
    expect(pages.length).toBe(3);
    expect(JSON.parse(pages[1].params.xquery).$and[1]._id.$gt).toBe(`${'e'.repeat(16)}00000497`);
  });

  test('refuses rows the server would accept silently or misread', async () => {
    const text = [
      'Código;Lista;Precio;Moneda;IVA',
      'p3;sede-a;500;;', // new price without currency
      'p3;sede-b;1.234;COP;', // ambiguous number
      'nope;sede-a;5;COP;', // unknown product
      'p1;nope;5;COP;', // unknown list
      'p2;sede-b;5;EUR;', // currency the account does not accept
      'p1;sede-a;-1;COP;', // negative
      'p3;sede-a;10;COP;12%', // no tax with that rate
    ].join('\n');
    const { code, json } = await previewBasic(text);
    expect(code).toBe(0);
    expect(json.counts.error).toBe(7);
    const e = json.sample.errors.map((x) => x.error).join(' | ');
    expect(e).toMatch(/needs a currency/);
    expect(e).toMatch(/ambiguous/);
    expect(e).toMatch(/product "nope" not found/);
    expect(e).toMatch(/price list "nope" not found/);
    expect(e).toMatch(/currency "EUR"/);
    expect(e).toMatch(/negative/);
    expect(e).toMatch(/no tax with rate 0.12/);
  });

  test('refuses a tax with rate 0, a duplicated pair and a code that belongs to another price', async () => {
    const text = 'product;pricebook;price;currency;taxes;pricebookEntryCode\np3;sede-a;1;COP;cero;\np3;sede-a;2;COP;;\np3;sede-b;3;COP;;e-otra-p3\n';
    const { json } = await run('preview', D, csv('x.csv', text));
    const e = json.sample.errors.map((x) => `${x.row}: ${x.error}`).join(' | ');
    expect(e).toMatch(/2: tax "cero" has rate 0/);
    expect(e).toMatch(/3: same product and price list as row 2/);
    expect(e).toMatch(/4: code "e-otra-p3" belongs to another price/);
  });

  test('--pricebooks keeps the load inside the agreed lists', async () => {
    const { code } = await previewBasic(BASIC.replace('p3;sede-a', 'p3;otra'), '--pricebooks', 'sede-a');
    expect(code).toBe(3);
    expect(err).toMatch(/outside --pricebooks/);
    expect(writes()).toEqual([]);
  });

  test('a wide sheet (one price column per list) becomes one row per list', async () => {
    const text = 'Código,Moneda,Precio A,Precio B\np3,COP,100,200\np1,COP,1000,\n';
    const map = JSON.stringify({ product: 'Código', currency: 'Moneda', wide: { 'Precio A': 'sede-a', 'Precio B': 'sede-b' } });
    const { json } = await run('preview', D, csv('wide.csv', text), '--map', map);
    expect(json.counts).toEqual({
      create: 2, update: 0, unchanged: 1, error: 0,
    });
    expect(json.sample.creates.map((c) => c.row)).toEqual(['2/Precio A', '2/Precio B']);
  });

  test('reports webhooks, scripts and agent triggers that run per row, when the key can read them', async () => {
    fake.effects = { webhook: 2, script: 0, eventtrigger: 1 };
    const { json } = await previewBasic();
    expect(json.sideEffects).toEqual({ webhooks: 2, lifecycleScripts: 0, agentTriggers: 1 });
    expect(json.warnings.join(' ')).toMatch(/2 active webhooks run on every price saved/);
    fake.effects = null;
    const again = await previewBasic();
    expect(again.json.sideEffects.webhooks).toMatch(/unknown/);
  });

  test('warns when the user may not create or change prices', async () => {
    expect((await previewBasic()).json.canWritePrices).toBe(true);
    fake.permissions = ['Resource@PricebookEntry.find'];
    const { json } = await previewBasic();
    expect(json.canWritePrices).toBe(false);
    expect(json.warnings.join(' ')).toMatch(/no permission to create or change prices/);
  });

  test('never prints the key', async () => {
    db.product[0].productName = 'SECRET123';
    await previewBasic();
    expect(out + err).not.toMatch(/SECRET123/);
  });
});

describe('yearly update by a factor', () => {
  test('multiplies every active price of the lists, rounds to the step and shows totals', async () => {
    const { code, json } = await run('preview', D, '--pricebooks', 'sede-a,sede-b', '--factor', '1.0525', '--round', '100');
    expect(code).toBe(0);
    expect(json.counts).toEqual({
      create: 0, update: 2, unchanged: 0, error: 0,
    });
    expect(json.sample.updates.map((u) => u.to.price)).toEqual([1100, 2100]);
    expect(json.priceTotals).toMatchObject({ sumBefore: 3000, sumAfter: 3200, raised: 2 });
    expect(json.warnings.join(' ')).toMatch(/1 inactive prices left/);
    expect(json.warnings.join(' ')).toMatch(/percent of the total/);
    expect(writes()).toEqual([]);
    expect(calls.some((c) => c.path === '/v2/pricebookentry' && /e-otra|"000000000000000000000012"/.test(c.params.xquery))).toBe(false);
  });

  test('warns when a list shows no prices to this user (prices are shared record by record)', async () => {
    // Seen live: a sales user who could see a shared list read 0 of its 50 prices.
    db.pricebookentry = db.pricebookentry.filter((e) => e.pricebook !== id(11));
    const { code, json } = await run('preview', D, '--pricebooks', 'sede-a,sede-b', '--factor', '1.05');
    expect(code).toBe(0);
    expect(json.warnings.join(' ')).toMatch(/No prices visible in sede-b: .*not shared with this user/);
    expect(json.warnings.join(' ')).not.toMatch(/sede-a/);
  });

  test('refuses a factor that more than halves or doubles prices, and needs the lists', async () => {
    expect((await run('preview', D, '--pricebooks', 'sede-a', '--factor', '3')).code).toBe(3);
    expect((await run('preview', D, '--factor', '1.1')).code).toBe(2);
    expect((await run('preview', D, '--pricebooks', 'nope', '--factor', '1.1')).code).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('bulk apply', () => {
  test('needs --confirmed and a version from preview; sends nothing otherwise', async () => {
    const { json } = await previewBasic();
    calls = [];
    expect((await run('apply', D, '--version', json.version)).code).toBe(2);
    expect((await run('apply', D, '--confirmed')).code).toBe(2);
    expect((await run('apply', D, '--version', '0123456789abcdef', '--confirmed')).code).toBe(3);
    expect((await run('apply', 'other.example.com', '--version', json.version, '--confirmed')).code).not.toBe(0);
    expect(writes()).toEqual([]);
  });

  test('writes through the importer in sequential chunks, existing prices by _id, then reads back', async () => {
    const text = 'Código;Lista;Precio;Moneda;IVA\np1;sede-a;1100;COP;19\np2;sede-a;2100;COP;\np3;sede-a;300;COP;\np3;sede-b;400;COP;\n';
    const { json } = await previewBasic(text);
    calls = [];
    const { code, json: res } = await run('apply', D, '--version', json.version, '--confirmed', '--chunk', '2');
    expect(code).toBe(0);
    expect(res.saved).toBe(true);
    expect(res.counts).toEqual({ updated: 2, created: 2 });
    expect(res.verified).toBe(4);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(2);
    expect(puts.every((c) => c.params.modelName === 'PricebookEntry' && c.params.silent === 'true')).toBe(true);
    expect(puts[0].body[0]).toEqual({ _id: id(30), price: 1100 });
    expect(puts[1].body[0]).toEqual({
      pricebook: id(10), product: id(22), price: 300, currency: 'COP', pricebookEntryCode: expect.stringMatching(/^ENT-[0-9a-f]{16}$/),
    });
    expect(calls.some((c) => c.method === 'POST' || c.method === 'PATCH')).toBe(false);
    expect(sleeps).toEqual([500]);
    const result = fs.readFileSync(res.resultFile, 'utf8');
    expect(result.split('\n').filter(Boolean).length).toBe(5);
    expect(db.pricebookentry.find((e) => e._id === id(30)).price).toBe(1100);
  });

  test('new prices carry their own random code, so the server default code cannot collide', async () => {
    fake.sameDefaultCode = true;
    const text = 'Código;Lista;Precio;Moneda\np3;sede-a;300;COP\np3;sede-b;400;COP\np1;otra;500;COP\n';
    const { json } = await previewBasic(text);
    calls = [];
    const { code, json: res } = await run('apply', D, '--version', json.version, '--confirmed');
    expect(code).toBe(0);
    expect(res.counts).toEqual({ created: 3 });
    const sent = calls.filter((c) => c.method === 'PUT').flatMap((c) => c.body).map((r) => r.pricebookEntryCode);
    expect(new Set(sent).size).toBe(3);
    expect(sent.every((c) => /^ENT-[0-9a-f]{16}$/.test(c))).toBe(true);
  });

  test('without its own code, two new prices in one import collide on the server default code', async () => {
    fake.sameDefaultCode = true;
    expect(importRows([
      { pricebook: id(10), product: id(22), price: 1, currency: 'COP' },
      { pricebook: id(11), product: id(22), price: 2, currency: 'COP' },
    ]).errors).toEqual([{ type: 'create', row: 1, error: "pricebookEntryCode 'ENT-1795556607335' ya existe." }]);
  });

  test('resumes: a second run skips what is already written', async () => {
    const text = 'Código;Lista;Precio;Moneda\np1;sede-a;1100;COP\np2;sede-a;2100;COP\np3;sede-a;300;COP\n';
    const { json } = await previewBasic(text);
    const first = await run('apply', D, '--version', json.version, '--confirmed', '--max-rows', '2');
    expect(first.code).toBe(1);
    expect(first.json).toMatchObject({ saved: false, sentThisRun: 2, remaining: 1 });
    calls = [];
    const second = await run('apply', D, '--version', json.version, '--confirmed');
    expect(second.code).toBe(0);
    expect(second.json.counts).toEqual({ 'already written': 2, created: 1 });
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(1);
    expect(puts[0].body).toHaveLength(1);
    expect(db.pricebookentry.filter((e) => e.product === id(22) && e.pricebook === id(10))).toHaveLength(1);
  });

  test('a call that times out is checked in the read-back, and a rerun does not write twice', async () => {
    const { json } = await previewBasic();
    fake.importerThrows = true;
    const first = await run('apply', D, '--version', json.version, '--confirmed');
    expect(first.code).toBe(1);
    expect(first.json.stopped).toMatch(/did not answer/);
    expect(first.json.counts).toEqual({ updated: 1, created: 1 });
    calls = [];
    const second = await run('apply', D, '--version', json.version, '--confirmed');
    expect(second.json.counts).toEqual({ 'already written': 2 });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  test('leaves alone a price someone changed after the preview', async () => {
    const { json } = await previewBasic();
    db.pricebookentry.find((e) => e._id === id(31)).price = 2050;
    const { code, json: res } = await run('apply', D, '--version', json.version, '--confirmed');
    expect(code).toBe(1);
    expect(res.counts['changed since preview (not written)']).toBe(1);
    expect(db.pricebookentry.find((e) => e._id === id(31)).price).toBe(2050);
  });

  test('a row the importer refuses is reported with its error; the rest is written', async () => {
    const { json } = await previewBasic();
    fake.failRow = (row) => row.product === id(22);
    const { code, json: res } = await run('apply', D, '--version', json.version, '--confirmed');
    expect(code).toBe(1);
    expect(res.counts).toEqual({ updated: 1, failed: 1 });
    expect(res.failedRows[0]).toMatchObject({ product: 'p3', error: 'Validation failed' });
    expect(res.problems).toEqual([]);
  });

  test('pauses a full minute before the key reaches the limit, and once more on a 429', async () => {
    const { json } = await previewBasic();
    fake.budget = 2;
    sleeps = [];
    await run('apply', D, '--version', json.version, '--confirmed', '--chunk', '1', '--pause-ms', '0');
    expect(sleeps.filter((ms) => ms === 65000).length).toBeGreaterThanOrEqual(1);
    fake.budget = undefined;
    const again = await previewBasic(BASIC.replace('2100', '2200'));
    calls = [];
    sleeps = [];
    fake.status429 = 1;
    const res = await run('apply', D, '--version', again.json.version, '--confirmed');
    expect(res.code).toBe(0);
    expect(sleeps).toContain(65000);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  test('rejects chunk sizes over the cap', async () => {
    const { json } = await previewBasic();
    expect((await run('apply', D, '--version', json.version, '--confirmed', '--chunk', '1000')).code).toBe(2);
  });
});

describe('helpers', () => {
  test('tax rates: 19, 19% and 0.19 are the same rate', () => {
    expect(bulk.toRate('19')).toBe(0.19);
    expect(bulk.toRate('19%')).toBe(0.19);
    expect(bulk.toRate(0.19)).toBe(0.19);
    expect(bulk.toRate('abc')).toBeUndefined();
  });
  test('rounding to a step', () => {
    expect(bulk.round(1052.5, 100)).toBe(1100);
    expect(bulk.round(1049.9, 100)).toBe(1000);
    expect(bulk.round(10.555, 0)).toBe(10.56);
  });
  test('unknown mapping keys are refused', () => {
    expect(() => bulk.mapRows([], { precio: 'x' })).toThrow(/Unknown mapping key/);
  });
});
