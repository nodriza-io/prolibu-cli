/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const quote = require('../.claude/skills/prolibu-quotes/scripts/quote');

const D = 'dev99.example.com';
const DEAL = 'a'.repeat(24);
const STAGE = 'b'.repeat(24);
const ENTRY = 'c'.repeat(24);

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let state;

const existingLine = {
  uuid: 'u-old', lineId: 'l-old', productName: 'Chair', product: 'p1', pricebookEntry: 'e1',
  quantity: 2, price: 10, discountRate: 0, discountAmount: 0, currency: 'USD', total: 20,
};
const autoCharge = {
  uuid: 'u-auto', productName: 'Service Charge', isVirtual: true, total: 2,
  meta: { percentOfTotal: { source: 'preference', productFamily: null, scopeKey: 'quote' } },
};

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

// A tiny fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body && JSON.parse(init.body) });
  if (init.method === 'GET' && u.pathname === `/v2/deal/${DEAL}`) return respond(200, state.deal);
  if (init.method === 'GET' && u.pathname === `/v2/stage/${STAGE}`) return respond(200, state.stage);
  if (init.method === 'GET' && u.pathname === '/v2/quote/formatLineItem') {
    return respond(200, { productName: 'Table', product: 'p2', pricebookEntry: u.searchParams.get('pricebookEntryId'), lineId: 'l-new', price: 50, currency: 'USD', taxes: [] });
  }
  if (init.method === 'GET' && u.pathname === '/v2/deal') return respond(200, { data: [{ _id: DEAL, dealName: 'Acme (2026)' }] });
  if (init.method === 'GET' && u.pathname === '/v2/quote/productSearch') {
    return respond(200, {
      data: [{
        productName: 'Table', productCode: 'TB-1',
        pricebookEntries: [
          { _id: ENTRY, price: 50, currency: 'USD', pricebook: { _id: 'pb-usd', pricebookName: 'USD list' } },
          { _id: 'd'.repeat(24), price: 200000, currency: 'COP', pricebook: { _id: 'pb-cop', pricebookName: 'COP list', active: false } },
        ],
      }],
      pagination: { count: 1 },
    });
  }
  if (init.method === 'PUT' && u.pathname === '/v2/quote/calculate') {
    const q = JSON.parse(init.body);
    const lines = q.lineItems.map((l) => ({ ...l, total: (l.price || 0) * (l.quantity || 1) }));
    const dismissed = (q.autoPercentOfTotal && q.autoPercentOfTotal.dismissed) || [];
    if (!dismissed.includes('preference::quote') && !lines.some((l) => l.uuid === 'u-auto')) lines.push({ ...autoCharge, uuid: 'u-auto-new' });
    return respond(200, { ...q, lineItems: lines, total: lines.reduce((s, l) => s + (l.total || 0), 0) });
  }
  if (init.method === 'PATCH' && u.pathname === `/v2/deal/${DEAL}`) {
    if (state.patchStatus) return respond(state.patchStatus, { error: 'conflict' });
    const body = JSON.parse(init.body);
    state.deal = { ...state.deal, proposal: { ...state.deal.proposal, ...body.proposal }, updatedAt: 'T2' };
    if (state.saveAsVirtual) state.deal.proposal.quote.lineItems.forEach((l) => { delete l.pricebookEntry; });
    return respond(200, state.deal);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => quote.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const plan = (body) => JSON.stringify({ dealId: DEAL, ...body });

function writePlan(plan) {
  const file = path.join(tmpDir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-quotes-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-quotes-plan-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    stage: { _id: STAGE, stageName: 'Proposal', endFlowStage: false },
    deal: {
      _id: DEAL, dealName: 'Acme', stage: STAGE, contact: 'k1', updatedAt: 'T1',
      proposal: {
        enabled: true, title: 'Acme proposal',
        quote: {
          quoteCode: 'QTE-1', quoteCurrency: 'USD', commercialException: { _id: 'ce1' }, paymentPlan: { enabled: true },
          lineItems: [existingLine, autoCharge],
        },
      },
    },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildQuote', () => {
  const formatted = [{ productName: 'Table', product: 'p2', pricebookEntry: ENTRY, lineId: 'l-new', currency: 'USD' }];

  test('keeps the stored quote and lines verbatim and adds a catalog line with a new uuid', () => {
    const stored = state.deal.proposal.quote;
    const { quote: q, added } = quote.buildQuote(stored, { add: [{ pricebookEntryId: ENTRY, quantity: 3 }] }, formatted, { newUuid: () => 'u-new' });
    expect(q.quoteCode).toBe('QTE-1');
    expect(q.commercialException).toEqual({ _id: 'ce1' });
    expect(q.paymentPlan).toEqual({ enabled: true });
    expect(q.lineItems[0]).toEqual(existingLine);
    expect(q.lineItems[1]).toMatchObject({ uuid: 'u-new', pricebookEntry: ENTRY, quantity: 3 });
    expect(q.lineItems[1].lineId).toBeUndefined();
    expect(q.lineItems[2].uuid).toBe('u-auto');
    expect(added).toEqual(['u-new']);
    expect(stored.lineItems).toHaveLength(2);
  });

  test('a discount always travels as a pair and rates are decimals', () => {
    const { quote: q } = quote.buildQuote(state.deal.proposal.quote, { update: [{ uuid: 'u-old', discountRate: 0.1 }] }, []);
    expect(q.lineItems[0]).toMatchObject({ discountRate: 0.1, discountAmount: 0 });
    expect(() => quote.buildQuote(state.deal.proposal.quote, { update: [{ uuid: 'u-old', discountRate: 10 }] }, [])).toThrow('decimal');
  });

  test('refuses fields the script does not own', () => {
    expect(() => quote.buildQuote(state.deal.proposal.quote, { update: [{ uuid: 'u-old', isVirtual: true }] }, [])).toThrow('cannot be set');
    expect(() => quote.buildQuote(state.deal.proposal.quote, { update: [{ uuid: 'u-old', pricebookEntry: 'x' }] }, [])).toThrow('cannot be set');
  });

  test('an automatic charge is removed only with dismissAutoCharge, and is then dismissed', () => {
    expect(() => quote.buildQuote(state.deal.proposal.quote, { remove: [{ uuid: 'u-auto' }] }, [])).toThrow('automatic charge');
    const { quote: q, dismissed } = quote.buildQuote(state.deal.proposal.quote, { remove: [{ uuid: 'u-auto', dismissAutoCharge: true }] }, []);
    expect(q.lineItems.map((l) => l.uuid)).toEqual(['u-old']);
    expect(dismissed).toEqual(['preference::quote']);
    expect(q.autoPercentOfTotal.dismissed).toEqual(['preference::quote']);
  });

  test('events quotes need a day per added line', () => {
    const stored = { ...state.deal.proposal.quote, quoteMode: 'Events' };
    expect(() => quote.buildQuote(stored, { add: [{ pricebookEntryId: ENTRY }] }, formatted)).toThrow('events quote');
    const { quote: q } = quote.buildQuote(stored, { add: [{ pricebookEntryId: ENTRY, day: '2026-11-05' }] }, formatted, { timeZone: 'America/Bogota' });
    expect(q.lineItems[1].startDate).toBe('2026-11-05T05:00:00.000Z');
    expect(q.lineItems[1].endDate).toBe('2026-11-06T05:00:00.000Z');
  });
});

describe('eventDay', () => {
  test('uses the time zone, including across a DST change', () => {
    expect(quote.eventDay('2026-03-08', 'America/New_York')).toEqual({
      startDate: '2026-03-08T05:00:00.000Z', endDate: '2026-03-09T04:00:00.000Z',
    });
    expect(quote.eventDay('2026-07-01', 'UTC').startDate).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('commands', () => {
  test('search lists one row per price-list entry, flags inactive lists and never writes', async () => {
    expect(await run(['search', D, 'tab'])).toBe(0);
    expect(calls[0].path).toBe('/v2/quote/productSearch');
    expect(calls[0].query.xquery).toBe('{"active":true}');
    const result = JSON.parse(out);
    expect(result.results).toHaveLength(2);
    expect(result.results[1]).toMatchObject({ currency: 'COP', inactive: true });
    expect(result.note).toContain('cannot see');
    out = '';
    expect(await run(['search', D, 'tab', '--currency', 'USD'])).toBe(0);
    expect(JSON.parse(out).results.map((r) => r.pricebookEntryId)).toEqual([ENTRY]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('deals searches by name with an inline case-insensitive regex', async () => {
    expect(await run(['deals', D, 'acme (2026'])).toBe(0);
    const xquery = JSON.parse(calls[0].query.xquery);
    expect(xquery).toEqual({ dealName: { $regex: '(?i)acme \\(2026' } });
    expect(JSON.parse(out).deals[0]._id).toBe(DEAL);
  });

  test('preview calculates without writing and returns the deal version', async () => {
    expect(await run(['preview', D, plan({ add: [{ pricebookEntryId: ENTRY, quantity: 2 }] })])).toBe(0);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const result = JSON.parse(out);
    expect(result.after.lines.map((l) => l.product)).toEqual(['Chair', 'Table', 'Service Charge']);
    expect(result.warnings.join(' ')).not.toContain('product rules');
    expect(result.dealVersion).toBe('T1');
  });

  test('a plan can also come from a file in a temp folder', async () => {
    const file = writePlan({ dealId: DEAL, add: [{ pricebookEntryId: ENTRY }] });
    expect(await run(['preview', D, file])).toBe(0);
  });

  test('apply refuses without a deal version or without --confirmed', async () => {
    const p = plan({ add: [{ pricebookEntryId: ENTRY }] });
    expect(await run(['apply', D, p, '--confirmed'])).toBe(2);
    expect(err).toContain('Run preview first');
    expect(await run(['apply', D, p, '--deal-version', 'T1'])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('apply saves the full calculated quote, keeps the title and verifies the read-back', async () => {
    const p = plan({ add: [{ pricebookEntryId: ENTRY, quantity: 2 }] });
    await run(['preview', D, p]);
    out = '';
    calls = [];
    expect(await run(['apply', D, p, '--deal-version', 'T1', '--confirmed'])).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.body.proposal.title).toBe('Acme proposal');
    expect(patch.body.proposal.enabled).toBe(true);
    expect(patch.body.proposal.quote.quoteCode).toBe('QTE-1');
    expect(patch.body.proposal.quote.commercialException).toEqual({ _id: 'ce1' });
    expect(patch.body.proposal.quote.lineItems.map((l) => l.uuid)).toContain('u-old');
    expect(JSON.parse(out).saved).toBe(true);
  });

  test('apply stops if the deal changed after the preview', async () => {
    const p = plan({ add: [{ pricebookEntryId: ENTRY }] });
    await run(['preview', D, p]);
    state.deal.updatedAt = 'T9';
    calls = [];
    expect(await run(['apply', D, p, '--deal-version', 'T1', '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('a deal in an end-flow stage is blocked before writing', async () => {
    state.stage.endFlowStage = true;
    const p = plan({ add: [{ pricebookEntryId: ENTRY }] });
    expect(await run(['preview', D, p])).toBe(3);
    calls = [];
    expect(await run(['apply', D, p, '--deal-version', 'T1', '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('old lines without a uuid are not reported as missing', async () => {
    state.deal.proposal.quote.lineItems.push({ productName: 'Legacy', product: 'p9', pricebookEntry: 'e9', price: 1, quantity: 1 });
    const p = plan({ add: [{ pricebookEntryId: ENTRY }] });
    out = '';
    expect(await run(['apply', D, p, '--deal-version', 'T1', '--confirmed'])).toBe(0);
    expect(JSON.parse(out).problems).toEqual([]);
  });

  test('a 409 staleQuote is reported as blocked', async () => {
    state.patchStatus = 409;
    expect(await run(['apply', D, plan({ add: [{ pricebookEntryId: ENTRY }] }), '--deal-version', 'T1', '--confirmed'])).toBe(3);
    expect(err).toContain('staleQuote');
  });

  test('a line saved as virtual is reported as a failure', async () => {
    state.saveAsVirtual = true;
    out = '';
    expect(await run(['apply', D, plan({ add: [{ pricebookEntryId: ENTRY }] }), '--deal-version', 'T1', '--confirmed'])).toBe(1);
    expect(JSON.parse(out).problems.join(' ')).toContain('virtual');
  });

  test('plan files outside temp folders are refused', async () => {
    const file = path.join(__dirname, `outside-plan-${process.pid}.json`);
    fs.writeFileSync(file, plan({ add: [{ pricebookEntryId: ENTRY }] }));
    try {
      expect(await run(['preview', D, file])).toBe(2);
      expect(err).toContain('temp folder');
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('the API key never reaches the output', async () => {
    await run(['preview', D, plan({ add: [{ pricebookEntryId: ENTRY }] })]);
    expect(out + err).not.toContain('SECRET123');
  });
});

describe('plans with a time window', () => {
  test('a plan may only change the time window', async () => {
    expect(await run(['preview', D, plan({ timeDiscount: { off: true } })])).not.toBe(2);
  });

  test('timeDiscount must be an object', async () => {
    expect(await run(['preview', D, plan({ timeDiscount: 5 })])).toBe(2);
    expect(err).toMatch(/object/);
  });
});
