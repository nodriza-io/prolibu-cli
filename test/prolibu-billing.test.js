/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const billing = require('../.claude/skills/prolibu-billing/scripts/billing');

const D = 'dev99.example.com';
const DEAL = 'a'.repeat(24);
const CONTACT = 'b'.repeat(24);
const INV1 = 'c'.repeat(24);
const INV2 = 'd'.repeat(24);
const PAY1 = 'e'.repeat(24);
const STAGE = 'f'.repeat(24);
const ENTRY = '1'.repeat(24);
const KEY = 'SECRET123';

let rootDir;
let out;
let err;
let calls;
let state;

const today = new Date().toISOString().slice(0, 10);

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function invoice(id, extra) {
  return {
    _id: id, invoiceNumber: `INV-${id.slice(0, 3)}`, title: 'Factura - Acme', status: 'open', updatedAt: 'T1',
    contact: { _id: CONTACT, firstName: 'Ana', lastName: 'Ruiz' }, issueDate: '2026-10-01', dueDate: '2026-10-15',
    quote: { quoteCurrency: 'COP', total: 1000, lineItems: [{ productName: 'Room', quantity: 1, price: 1000, total: 1000 }] },
    balance: 1000, payments: [], ...extra,
  };
}

// A fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
  calls.push({ method: init.method, path: u.pathname, xquery: xq, select: u.searchParams.get('select'), body });
  const m = init.method;
  const p = u.pathname;
  if (m === 'GET' && p === '/v2/user/preferences') return respond(200, state.prefs);
  if (m === 'GET' && p === `/v2/deal/${DEAL}`) return respond(200, state.deal);
  if (m === 'GET' && p === `/v2/stage/${STAGE}`) return respond(200, state.stage);
  if (m === 'GET' && p === `/v2/contact/${CONTACT}`) return respond(200, { _id: CONTACT, firstName: 'Ana', lastName: 'Ruiz', updatedAt: 'C1' });
  if (m === 'GET' && p === '/v2/subscription') return respond(200, { data: state.subs, pagination: { count: state.subs.length } });
  if (m === 'GET' && p === '/v2/paymentmethod') {
    return respond(200, { data: [{ gateway: 'stripe', isDefault: true, active: true, card: { last4: '4242', holderName: 'Ana' } }] });
  }
  if (m === 'GET' && p === '/v2/invoice') {
    let list = Object.values(state.invoices);
    const match = (inv, f) => Object.entries(f).every(([k, v]) => {
      if (k === '$and') return v.every((sub) => match(inv, sub));
      if (k === 'contact') return (inv.contact._id || inv.contact) === v;
      if (v && typeof v === 'object') return true;
      return String(inv[k]) === String(v);
    });
    list = list.filter((inv) => match(inv, xq));
    return respond(200, { data: list, pagination: { count: list.length, lastPage: 1 } });
  }
  if (m === 'GET' && p === '/v2/payment') {
    const list = state.payments.filter((pay) => pay.paidInvoices.includes(xq.paidInvoices));
    return respond(200, { data: list });
  }
  if (m === 'GET' && p === '/v2/quote/formatLineItem') {
    return respond(200, { productName: 'Room', pricebookEntry: ENTRY, lineId: 'l1', price: 500, currency: 'COP', apiKey: KEY });
  }
  if (m === 'PUT' && p === '/v2/quote/calculate') {
    const lines = body.lineItems.map((l) => ({ ...l, total: l.price * l.quantity * (1 - (l.discountRate || 0)) }));
    if (!(body.autoPercentOfTotal && body.autoPercentOfTotal.dismissed.length)) {
      lines.push({ productName: 'Service Charge', total: 100, meta: { percentOfTotal: { source: 'preference', scopeKey: '__nodate__' } } });
    }
    return respond(200, { ...body, quoteCurrency: body.quoteCurrency || 'COP', lineItems: lines, total: lines.reduce((a, l) => a + l.total, 0) });
  }
  if (m === 'POST' && p === '/v2/invoice/generatefromdeal') {
    const created = invoice(INV2, { status: 'draft', originDeal: DEAL, updatedAt: 'T0' });
    state.invoices[INV2] = created;
    return respond(200, [created]);
  }
  if (m === 'POST' && p === '/v2/invoice') {
    state.invoices[INV2] = invoice(INV2, { ...body, contact: { _id: body.contact }, quote: { ...body.quote, total: 1000 }, balance: 1000 });
    return respond(201, state.invoices[INV2]);
  }
  if (m === 'POST' && p === '/v2/invoice/registerpayment') {
    if (state.failPaymentOn === body.invoiceId) return respond(400, { error: 'Invoice status must be open to add payment.' });
    const inv = state.invoices[body.invoiceId];
    const id = String(state.payments.length + 2).repeat(24).slice(0, 24);
    state.payments.push({ _id: id, paymentCode: `PAY-${id.slice(0, 2)}`, paidAmount: body.paidAmount, paidInvoices: [inv._id] });
    inv.balance -= body.paidAmount;
    inv.status = inv.balance === 0 ? 'paid' : 'open';
    inv.payments.push(id);
    inv.updatedAt = `T${calls.length}`;
    return respond(200, { invoice: inv, payment: { _id: id, paymentCode: `PAY-${id.slice(0, 2)}` } });
  }
  if (m === 'POST' && p === '/v2/invoice/removepayment') {
    const inv = state.invoices[body.invoiceId];
    const pay = state.payments.find((x) => x._id === body.paymentId);
    state.payments = state.payments.filter((x) => x._id !== body.paymentId);
    inv.payments = inv.payments.filter((x) => x !== body.paymentId);
    inv.balance += pay.paidAmount;
    inv.status = 'open';
    return respond(200, { invoice: inv, payment: pay });
  }
  if (m === 'PATCH' && p.startsWith('/v2/invoice/')) {
    const inv = state.invoices[p.split('/').pop()];
    Object.assign(inv, body, { updatedAt: 'T9' });
    return respond(200, inv);
  }
  return respond(404, { error: `unexpected ${m} ${p}` });
}

const run = (argv) => billing.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET' && !(c.method === 'PUT' && c.path === '/v2/quote/calculate'));

async function previewVersion(plan) {
  out = '';
  const code = await run(['preview', D, JSON.stringify(plan)]);
  const result = json();
  out = '';
  return { code, result };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-billing-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  out = '';
  err = '';
  calls = [];
  state = {
    prefs: { globalLocale: { currency: 'COP', language: 'es' }, modules: { billing: { general: { enabled: false }, invoices: { defaultDueDateDays: 0 } } } },
    deal: {
      _id: DEAL, dealName: 'Acme', contact: CONTACT, stage: STAGE, updatedAt: 'D1',
      proposal: { enabled: true, title: 'Acme', quote: { quoteCurrency: 'COP', total: 1000, lineItems: [{ total: 1000 }] } },
    },
    stage: { _id: STAGE, stageName: 'Aprobado', stageCode: 'deal-stage-approved' },
    subs: [],
    invoices: { [INV1]: invoice(INV1) },
    payments: [],
  };
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('readPlan', () => {
  const read = (plan) => billing.readPlan(JSON.stringify(plan), rootDir, '2026-11-03');

  test('never accepts deleteInvoicesWithOriginDeal', () => {
    expect(() => read({ kind: 'fromDeal', dealId: DEAL, deleteInvoicesWithOriginDeal: true })).toThrow('never sent');
  });

  test('rejects unknown kinds and keys, including a status on a manual invoice', () => {
    expect(() => read({ kind: 'delete', invoice: 'INV-1' })).toThrow('"kind" must be one of');
    expect(() => read({
      kind: 'manual', contactId: CONTACT, title: 'x', issueDate: '2026-11-01', dueDate: '2026-11-02', status: 'paid', lines: [{ pricebookEntryId: ENTRY, quantity: 1 }],
    })).toThrow('"status" is not allowed');
  });

  test('payments need a number, a known method and a date that is not in the future', () => {
    const pay = (p) => read({ kind: 'pay', payments: [{ invoice: 'INV-1', amount: 10, method: 'Cash', ...p }] });
    expect(() => pay({ amount: '10' })).toThrow('must be a number');
    expect(() => pay({ amount: 0 })).toThrow('greater than 0');
    expect(() => pay({ method: 'Transferencia' })).toThrow('method must be one of');
    expect(() => pay({ date: '2026-12-01' })).toThrow('in the future');
    expect(() => pay({ invoice: { $ne: null } })).toThrow('invoice number');
    expect(pay({ date: '2026-10-28' }).payments[0].date).toBe('2026-10-28');
  });

  test('discountRate is a decimal', () => {
    expect(() => read({
      kind: 'manual', contactId: CONTACT, title: 'x', issueDate: '2026-11-01', dueDate: '2026-11-02', lines: [{ pricebookEntryId: ENTRY, quantity: 1, discountRate: 10 }],
    })).toThrow('decimal');
  });
});

describe('simulateFromDeal', () => {
  const opts = { today: '2026-11-03', defaultDueDateDays: 5, accountCurrency: 'COP', invoiceWord: 'Factura' };

  test('without a payment plan: one draft for the whole quote', () => {
    const list = billing.simulateFromDeal(state.deal, opts);
    expect(list).toEqual([{ title: 'Factura - Acme', issueDate: '2026-11-03', dueDate: '2026-11-08', status: 'draft', currency: 'COP', total: 1000 }]);
  });

  test('with a payment plan: zero instalments skipped, future ones scheduled, currency falls back to the account', () => {
    const deal = {
      dealName: 'Acme',
      proposal: {
        title: 'Acme',
        quote: {
          quoteCurrency: 'USD', total: 300,
          paymentPlan: {
            enabled: true, titleTemplate: 'Cuota {{number}} - {{proposalTitle}}',
            payments: [
              { title: 'A', total: 100, issueDate: '2026-11-01', dueDate: '2026-10-01', quote: { lineItems: [] } },
              { title: 'B', total: 0 },
              { title: 'C', total: 200, issueDate: '2026-12-01', quote: { lineItems: [], quoteCurrency: 'USD' } },
            ],
          },
        },
      },
    };
    const list = billing.simulateFromDeal(deal, opts);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ title: 'Cuota 1 - Acme', status: 'draft', dueDate: '2026-11-01', currency: 'COP' });
    expect(list[1]).toMatchObject({ title: 'Cuota 3 - Acme', status: 'scheduled', dueDate: '2026-12-06', currency: 'USD' });
  });
});

describe('planPayments and agingReport', () => {
  test('one payment per invoice, never above the balance, date in the note', () => {
    const map = new Map([['INV-1', invoice(INV1)], ['INV-2', invoice(INV2, { status: 'draft' })]]);
    const r = billing.planPayments([
      { invoice: 'INV-1', amount: 600, method: 'Cash', date: '2026-10-28' },
      { invoice: 'INV-1', amount: 500, method: 'Cash' },
      { invoice: 'INV-2', amount: 10, method: 'Cash' },
    ], map, { today: '2026-11-03' });
    expect(r.steps[0].body).toEqual({ invoiceId: INV1, paymentMethod: 'Cash', paidAmount: 600, specialNote: 'Pago recibido el 2026-10-28.' });
    expect(r.blockers.join(' ')).toContain('more than the balance');
    expect(r.blockers.join(' ')).toContain('is draft');
  });

  test('a payment that clears the balance makes the invoice paid', () => {
    const r = billing.planPayments([{ invoice: 'INV-1', amount: 1000, method: 'Cash' }], new Map([['INV-1', invoice(INV1)]]), { today });
    expect(r.steps[0]).toMatchObject({ balanceAfter: 0, statusAfter: 'paid' });
    expect(r.blockers).toEqual([]);
  });

  test('aging never adds currencies together', () => {
    const r = billing.agingReport([
      invoice(INV1, { dueDate: '2026-09-01' }),
      invoice(INV2, { dueDate: '2026-12-01', quote: { quoteCurrency: 'USD', total: 50 }, balance: 50 }),
    ], '2026-11-03');
    expect(r.totalsByCurrency).toEqual({ COP: { open: 1000, overdue: 1000 }, USD: { open: 50, overdue: 0 } });
    expect(r.clients[0].currencies.COP.aging['61-90']).toBe(1000);
  });
});

describe('commands against a fake server', () => {
  test('receivables filters with $and and never on quote fields', async () => {
    expect(await run(['receivables', D, '--as-of', '2026-11-03'])).toBe(0);
    const q = calls.find((c) => c.path === '/v2/invoice').xquery;
    expect(q.$and).toEqual([{ status: 'open' }, { balance: { $gt: 0 } }]);
    expect(JSON.stringify(q)).not.toContain('quote.');
  });

  test('fromDeal is blocked when the deal already has invoices, and when it is not won', async () => {
    state.invoices[INV1].originDeal = DEAL;
    let r = await previewVersion({ kind: 'fromDeal', dealId: DEAL });
    expect(r.code).toBe(3);
    expect(r.result.blockers.join(' ')).toContain('already has 1 invoice');
    delete state.invoices[INV1];
    state.stage = { stageName: 'Negociación', stageCode: 'deal-stage-negotiation' };
    r = await previewVersion({ kind: 'fromDeal', dealId: DEAL });
    expect(r.result.blockers.join(' ')).toContain('not in the won stage');
    r = await previewVersion({ kind: 'fromDeal', dealId: DEAL, notWonConfirmed: true });
    expect(r.result.blockers).toEqual([]);
    expect(r.result.nextStep).toContain('STOP HERE');
    expect(writes()).toEqual([]);
  });

  test('fromDeal apply sends only the deal id and reads the invoices back', async () => {
    delete state.invoices[INV1];
    const { result } = await previewVersion({ kind: 'fromDeal', dealId: DEAL });
    expect(await run(['apply', D, JSON.stringify({ kind: 'fromDeal', dealId: DEAL }), '--version', result.version, '--confirmed'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ path: '/v2/invoice/generatefromdeal', body: { dealId: DEAL } })]);
    expect(json().invoices).toHaveLength(1);
  });

  test('apply needs --confirmed and the current version', async () => {
    const plan = JSON.stringify({ kind: 'emit', invoice: INV1 });
    expect(await run(['apply', D, plan, '--version', 'T1'])).toBe(2);
    expect(await run(['apply', D, plan, '--version', 'old', '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(writes()).toEqual([]);
  });

  test('pay records one payment per invoice in order and stops at the first failure', async () => {
    state.invoices[INV2] = invoice(INV2);
    const plan = { kind: 'pay', payments: [{ invoice: INV1, amount: 400, method: 'Cash' }, { invoice: INV2, amount: 300, method: 'Cash' }, { invoice: INV1, amount: 100, method: 'Cash' }] };
    const { result } = await previewVersion(plan);
    state.failPaymentOn = INV2;
    expect(await run(['apply', D, JSON.stringify(plan), '--version', result.version, '--confirmed'])).toBe(1);
    const sent = writes().map((c) => c.body.invoiceId);
    expect(sent).toEqual([INV1, INV2]);
    expect(writes().every((c) => typeof c.body.paidAmount === 'number')).toBe(true);
    expect(json().payments).toHaveLength(1);
    expect(json().problems[0]).toContain('nothing after it was sent');
  });

  test('a rerun of the same pay plan is refused', async () => {
    const plan = { kind: 'pay', payments: [{ invoice: INV1, amount: 400, method: 'Cash' }] };
    const { result } = await previewVersion(plan);
    expect(await run(['apply', D, JSON.stringify(plan), '--version', result.version, '--confirmed'])).toBe(0);
    expect(await run(['apply', D, JSON.stringify(plan), '--version', result.version, '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(1);
  });

  test('unpay refuses a payment of another invoice', async () => {
    state.payments.push({ _id: PAY1, paidAmount: 100, paidInvoices: [INV2] });
    const r = await previewVersion({ kind: 'unpay', invoice: INV1, paymentId: PAY1 });
    expect(r.code).toBe(3);
    expect(r.result.blockers[0]).toContain('not a payment of invoice');
  });

  test('unpay of its own payment reopens a paid invoice', async () => {
    state.payments.push({ _id: PAY1, paidAmount: 1000, paidInvoices: [INV1] });
    Object.assign(state.invoices[INV1], { status: 'paid', balance: 0, payments: [PAY1] });
    const plan = { kind: 'unpay', invoice: INV1, paymentId: PAY1 };
    const { result } = await previewVersion(plan);
    expect(result.statusAfter).toBe('open');
    expect(await run(['apply', D, JSON.stringify(plan), '--version', result.version, '--confirmed'])).toBe(0);
    expect(json().invoice).toMatchObject({ status: 'open', balance: 1000 });
  });

  test('void is blocked while the invoice has payments; emit sends only the status', async () => {
    state.invoices[INV1].payments = [PAY1];
    const r = await previewVersion({ kind: 'void', invoice: INV1 });
    expect(r.result.blockers[0]).toContain('has payments');
    state.invoices[INV1] = invoice(INV1, { status: 'draft' });
    const { result } = await previewVersion({ kind: 'emit', invoice: INV1 });
    expect(await run(['apply', D, JSON.stringify({ kind: 'emit', invoice: INV1 }), '--version', result.version, '--confirmed'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', body: { status: 'open' } })]);
  });

  test('manual preview drops the automatic charge the invoice will not have; apply creates a draft', async () => {
    const plan = {
      kind: 'manual', contactId: CONTACT, title: 'Acme manual', issueDate: '2026-11-01', dueDate: '2026-11-30', lines: [{ pricebookEntryId: ENTRY, quantity: 2 }],
    };
    const { result } = await previewVersion(plan);
    expect(result.total).toBe(1000);
    expect(result.lines.map((l) => l.product)).toEqual(['Room']);
    expect(await run(['apply', D, JSON.stringify(plan), '--version', result.version, '--confirmed'])).toBe(0);
    const post = writes()[0];
    expect(post.body).toMatchObject({ status: 'draft', contact: CONTACT, quote: { quoteCurrency: 'COP' } });
    expect(post.body.quote.lineItems[0].lineId).toBeUndefined();
    out = '';
    const again = await previewVersion(plan);
    expect(again.result.blockers[0]).toContain('already has an invoice with this title');
  });

  test('payment methods never print card fields, and the key never reaches the output', async () => {
    expect(await run(['payment-methods', D, CONTACT])).toBe(0);
    expect(out).not.toContain('4242');
    expect(out).not.toContain('holderName');
    out = '';
    state.deal.dealName = `Acme ${KEY}`;
    expect(await run(['preview', D, JSON.stringify({ kind: 'fromDeal', dealId: DEAL })])).toBe(0);
    expect(out).toContain('Acme ***');
    expect(out).not.toContain(KEY);
  });
});

describe('--profile and 403', () => {
  test('--profile reads profile.<name>.json, and a 403 stops at once with a clear message', async () => {
    const SELLER_KEY = 'seller-key-not-the-admin-one';
    fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
    const seen = [];
    let stdout = '';
    let stderr = '';
    const code = await billing.main(['invoices', D, '--profile', 'seller'], {
      rootDir,
      fetchImpl: async (url, init) => {
        seen.push({ path: new URL(url).pathname, auth: init.headers.Authorization });
        return { status: 403, text: async () => JSON.stringify({ statusCode: 403, error: 'Prohibido' }) };
      },
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^FORBIDDEN: .*403: Prohibido/);
    expect(stderr).toContain('did not retry it or try another profile');
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${SELLER_KEY}`);
    expect(stdout + stderr).not.toContain(SELLER_KEY);
  });
});
