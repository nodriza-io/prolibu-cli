/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ce = require('../.claude/skills/prolibu-commercial-exceptions/scripts/exception');

const D = 'dev99.example.com';
const KEY = 'SECRET123';
const id = (c) => c.repeat(24);
const ME = id('1');
const OTHER = id('2');
const DEAL = id('a');
const STAGE = id('b');
const ENTRY = id('c');
const PRODUCT = id('d');
const RULE = id('e');
const REQ = id('f');
const POINTER = id('9');

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const capRule = () => ({ _id: RULE, productRuleName: 'Cap 10', productRuleCode: 'cap-10', maxDiscountRate: 0.1, updatedAt: 'R1' });

// A fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  const xq = q.xquery ? JSON.parse(q.xquery) : {};
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: q, body });
  const m = init.method;
  if (m === 'GET' && u.pathname === '/v2/user/me') return respond(200, { profile: state.me, permissions: state.permissions || [] });
  if (m === 'GET' && u.pathname === `/v2/deal/${DEAL}`) return respond(200, state.deal);
  if (m === 'GET' && u.pathname === `/v2/stage/${STAGE}`) return respond(200, state.stage);
  if (m === 'GET' && u.pathname === '/v2/pricebookentry') return respond(200, { data: [state.entry] });
  if (m === 'GET' && u.pathname === '/v2/commercialexception/search') {
    const rows = state.exceptions.filter((r) => Object.entries(xq).every(([k, v]) => String(r[k] && r[k]._id ? r[k]._id : r[k]) === String(v)));
    return respond(200, { data: rows });
  }
  if (m === 'GET' && u.pathname === '/v2/user/search') {
    if (q.outputFormat === 'commercialExceptionApprovers') return respond(200, { data: state.approvers });
    if (xq.isAdmin) return respond(200, { data: [{ _id: ME, firstName: 'Ada', lastName: 'Admin', email: 'ada@example.com' }] });
    return respond(200, { data: [{ _id: xq._id, firstName: 'Sam', lastName: 'Seller', email: 'sam@example.com' }] });
  }
  if (m === 'PUT' && u.pathname === '/v2/quote/calculate') {
    // The server derives the discount amount from the rate before checking rules.
    const lines = body.lineItems.map((l) => ({ ...l, discountAmount: l.discountRate ? l.price * l.discountRate : (l.discountAmount || 0), total: l.price }));
    if (state.calculateError) return respond(400, { error: state.calculateError });
    return respond(200, { ...body, lineItems: lines, total: 1000 });
  }
  if (m === 'POST' && u.pathname === '/v2/commercialexception') {
    const rec = { _id: REQ, ...body, status: 'Pending', createdBy: ME, updatedAt: 'E1' };
    state.exceptions.push(rec);
    return respond(201, rec);
  }
  if (m === 'PATCH' && u.pathname === `/v2/commercialexception/${REQ}`) {
    const rec = state.exceptions.find((r) => r._id === REQ);
    Object.assign(rec, { status: body.status, decisionComment: body.decisionComment, updatedAt: 'E2' });
    if (body.status === 'Approved' && state.applies) {
      rec.appliedIn = POINTER;
      const rule = rec.ignoreProductRules[0].rules[0];
      rule.requestedValue = rule.value;
      if (body.approvedValue !== undefined) rule.value = body.approvedValue;
      const line = state.deal.proposal.quote.lineItems.find((l) => l.uuid === rec.ignoreProductRules[0].uuid);
      line[rule.field] = rule.value;
      state.deal.proposal.quote.commercialException = { _id: POINTER };
    }
    return respond(200, { ...rec, apiKey: KEY });
  }
  if (m === 'PUT' && /\/v2\/commercialexception\/(cancel|editRequest)$/.test(u.pathname)) {
    const rec = state.exceptions.find((r) => r._id === body.id);
    if (u.pathname.endsWith('cancel')) rec.status = 'Cancelled';
    else rec.ignoreProductRules[0].rules[0].value = body.value;
    rec.updatedAt = 'E3';
    return respond(200, rec);
  }
  if (m === 'GET' && u.pathname.startsWith('/v2/productrule/')) {
    const ref = decodeURIComponent(u.pathname.split('/').pop());
    const rule = state.rules.find((r) => r._id === ref || r.productRuleCode === ref);
    return rule ? respond(200, rule) : respond(404, { error: 'Not found' });
  }
  if ((m === 'GET') && (u.pathname === '/v2/product' || u.pathname === '/v2/pricebookentry')) return respond(200, { pagination: { count: 0 }, data: [] });
  if (m === 'POST' && u.pathname === '/v2/productrule') {
    const rule = { _id: id('7'), ...body, updatedAt: 'R0' };
    state.rules.push(rule);
    return respond(201, rule);
  }
  if (m === 'PATCH' && u.pathname.startsWith('/v2/productrule/')) {
    const rule = state.rules.find((r) => r._id === u.pathname.split('/').pop());
    for (const [k, v] of Object.entries(body)) {
      if (v === null) delete rule[k];
      else if (k === 'lockedFields') rule.lockedFields = { ...(rule.lockedFields || {}), ...v };
      else rule[k] = v;
    }
    rule.updatedAt = 'R2';
    return respond(200, rule);
  }
  return respond(404, { error: `unexpected ${m} ${u.pathname}` });
}

const run = (argv) => ce.main([argv[0], D, ...argv.slice(1)], {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET' && !(c.method === 'PUT' && c.path === '/v2/quote/calculate'));

const requestPlan = (extra = {}) => JSON.stringify({
  dealId: DEAL, uuid: 'u1', field: 'discountRate', value: 0.18, justification: 'Three-year contract', approver: 'ann@example.com', ...extra,
});

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-ce-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  out = '';
  err = '';
  calls = [];
  state = {
    me: { _id: ME, firstName: 'Ada', lastName: 'Admin', email: 'ada@example.com', isAdmin: false },
    permissions: ['Special@CommercialException.allow.decide'],
    stage: { _id: STAGE, stageName: 'Proposal', endFlowStage: false },
    deal: {
      _id: DEAL, dealName: 'Acme', stage: STAGE, assignee: OTHER, createdBy: OTHER, updatedAt: 'T1',
      proposal: {
        enabled: true,
        quote: {
          quoteCurrency: 'USD', total: 900,
          lineItems: [{ uuid: 'u1', productName: 'License', product: PRODUCT, pricebookEntry: ENTRY, price: 100, discountRate: 0.05, discountAmount: 5, quantity: 1 }],
        },
      },
    },
    entry: { _id: ENTRY, price: 100, discountAmount: 0, rules: [], product: { _id: PRODUCT, productName: 'License', rules: [capRule()] } },
    approvers: [{ _id: id('3'), firstName: 'Ann', lastName: 'Boss', email: 'ann@example.com' }],
    exceptions: [],
    rules: [capRule()],
    applies: true,
  };
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('evaluateQuote', () => {
  const entries = (entry) => new Map([[ENTRY, entry]]);
  const quote = (lines) => ({ lineItems: lines });
  const line = (over) => ({ uuid: 'u1', productName: 'License', product: PRODUCT, pricebookEntry: ENTRY, price: 100, quantity: 1, discountRate: 0, discountAmount: 0, ...over });
  const entryWith = (rules, over = {}) => ({ _id: ENTRY, price: 100, discountAmount: 0, rules: [], product: { _id: PRODUCT, productName: 'License', quantity: 1, rules }, ...over });

  test('reports every violation, not only the first one', () => {
    const rules = [{ productRuleName: 'R', maxDiscountRate: 0.1, maxQuantity: 5, lockedFields: { price: true } }];
    const { violations } = ce.evaluateQuote(quote([line({ discountRate: 0.2, quantity: 8, price: 90 })]), entries(entryWith(rules)), null);
    expect(violations.map((v) => `${v.field}:${v.kind}`).sort()).toEqual(['discountRate:max', 'price:locked', 'quantity:max']);
  });

  test("an entry's rules replace the product's", () => {
    const entry = entryWith([{ productRuleName: 'P', maxQuantity: 1 }], { rules: [{ productRuleName: 'E', maxQuantity: 10 }] });
    expect(ce.evaluateQuote(quote([line({ quantity: 5 })]), entries(entry), null).violations).toEqual([]);
  });

  test('min on a missing field is refused; max on a missing field passes', () => {
    const rules = [{ productRuleName: 'R', minMarkupRate: 0.1, maxUpfrontPaymentRate: 0.5 }];
    const { violations } = ce.evaluateQuote(quote([line()]), entries(entryWith(rules)), null);
    expect(violations.map((v) => v.kind)).toEqual(['missingField']);
  });

  test('an approved exception pins the value: back within limits still fails', () => {
    const pointer = { status: 'Approved', ignoreProductRules: [{ uuid: 'u1', rules: [{ field: 'discountRate', value: 0.15 }] }] };
    const rules = [{ productRuleName: 'R', maxDiscountRate: 0.1 }];
    expect(ce.evaluateQuote(quote([line({ discountRate: 0.15 })]), entries(entryWith(rules)), pointer).violations).toEqual([]);
    const { violations } = ce.evaluateQuote(quote([line({ discountRate: 0.05 })]), entries(entryWith(rules)), pointer);
    expect(violations[0]).toMatchObject({ field: 'discountRate', kind: 'pinned', limit: 0.15 });
  });

  test('a line entry without rules is free; an empty exception frees the whole deal', () => {
    const rules = [{ productRuleName: 'R', maxQuantity: 1 }];
    const free = { status: 'Approved', ignoreProductRules: [{ uuid: 'u1', rules: [] }] };
    expect(ce.evaluateQuote(quote([line({ quantity: 9 })]), entries(entryWith(rules)), free).violations).toEqual([]);
    const all = ce.evaluateQuote(quote([line({ quantity: 9 })]), entries(entryWith(rules)), { status: 'Approved', ignoreProductRules: [] });
    expect(all.violations).toEqual([]);
    expect(all.notes[0]).toMatch(/every rule/);
  });

  test('a pointer to a pending exception blocks the whole quote', () => {
    const { violations } = ce.evaluateQuote(quote([line()]), entries(entryWith([])), { status: 'Pending', ignoreProductRules: [{ uuid: 'u1', rules: [] }] });
    expect(violations[0].kind).toBe('pointerNotApproved');
  });

  test('checks every catalog line and skips custom lines', () => {
    const rules = [{ productRuleName: 'R', maxQuantity: 1 }];
    const r = ce.evaluateQuote(quote([{ uuid: 'v', productName: 'Custom', quantity: 9 }, line({ quantity: 9 })]), entries(entryWith(rules)), null);
    expect(r.violations.map((v) => v.uuid)).toEqual(['u1']);
  });

  test('must include / exclude products compare product ids', () => {
    const rules = [{ productRuleName: 'R', mustIncludeProducts: [id('5')], mustExcludeProducts: [PRODUCT] }];
    const kinds = ce.evaluateQuote(quote([line()]), entries(entryWith(rules)), null).violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(['exclude', 'include']);
  });
});

describe('validateRuleSet', () => {
  test.each([
    [{ productRuleName: 'X', minQuantity: 5, maxQuantity: 2 }, /greater than maxQuantity/],
    [{ productRuleName: 'X', maxDiscountRate: 10 }, /decimal/],
    [{ productRuleName: 'X', maxUpfrontPaymentRate: 1.5 }, /decimal/],
    [{ productRuleName: 'X', minPrice: -1 }, /greater than or equal to 0/],
    [{ productRuleName: 'X', lockedFields: { discountRate: true } }, /lock discountAmount/],
    [{ productRuleName: 'X', ownerId: 'x' }, /not a product rule field/],
    [{ maxQuantity: 3 }, /needs "productRuleName"/],
    [{ productRuleName: 'X', maxQuantity: null }, /leave it out/],
  ])('refuses %j', (set, message) => {
    expect(() => ce.validateRuleSet(set)).toThrow(message);
  });

  test('checks min <= max against the stored rule, and null removes a limit on edit', () => {
    expect(() => ce.validateRuleSet({ minQuantity: 6 }, { maxQuantity: 5 })).toThrow(/greater than/);
    expect(() => ce.validateRuleSet({ minQuantity: 6, maxQuantity: null }, { maxQuantity: 5 })).not.toThrow();
    expect(() => ce.validateRuleSet({ productRuleCode: 'new' }, { productRuleCode: 'old' })).toThrow(/not changed/);
  });

  test('warns that price limits compare the list price', () => {
    expect(ce.validateRuleSet({ productRuleName: 'X', minPrice: 10 }).warnings.join(' ')).toMatch(/list price/);
  });
});

describe('diagnose', () => {
  test('uses the server values when it accepts the quote', async () => {
    expect(await run(['diagnose', DEAL])).toBe(0);
    expect(json()).toMatchObject({ violations: [], server: { ok: true }, notes: [] });
    const calcs = calls.filter((c) => c.path === '/v2/quote/calculate');
    expect(calcs).toHaveLength(1);
    expect(calcs[0].body.lineItems).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  test('when the server refuses, keeps its message and checks every line on estimated values', async () => {
    state.entry.product.rules = [{ productRuleName: 'No discounts', lockedFields: { discountAmount: true } }];
    state.calculateError = "Locked field 'discountAmount'";
    expect(await run(['diagnose', DEAL, '--try', '[{"uuid":"u1","discountRate":0.2}]'])).toBe(0);
    const res = json();
    // The rate becomes an amount on the server; the local estimate does the same, so the lock shows.
    expect(res.violations).toEqual([expect.objectContaining({ field: 'discountAmount', kind: 'locked', value: 20 })]);
    expect(res.server).toMatchObject({ ok: false, message: "Locked field 'discountAmount'" });
    expect(res.notes.join(' ')).toMatch(/stored values/);
    const calcs = calls.filter((c) => c.path === '/v2/quote/calculate');
    expect(calcs).toHaveLength(1);
    expect(calcs[0].body.lineItems.map((l) => l.uuid)).toEqual(['u1']);
  });

  test('refuses a try on a field it does not know', async () => {
    expect(await run(['diagnose', DEAL, '--try', '[{"uuid":"u1","productName":"x"}]'])).toBe(2);
  });
});

describe('request', () => {
  test('preview resolves the approver, keeps the current value as original, and stops', async () => {
    expect(await run(['request-preview', requestPlan()])).toBe(0);
    const res = json();
    expect(res).toMatchObject({ asked: 0.18, current: 0.05, approver: { _id: id('3') }, blockers: [] });
    expect(res.reachesPeople[0]).toMatch(/ann@example.com/);
    expect(res.nextStep).toMatch(/STOP HERE/);
    expect(writes()).toEqual([]);
  });

  test('blocks a line that is not in the saved quote', async () => {
    expect(await run(['request-preview', requestPlan({ uuid: 'nope' })])).toBe(3);
    expect(err).toMatch(/not in the saved quote/);
  });

  test('blocks a value the rule already allows', async () => {
    expect(await run(['request-preview', requestPlan({ value: 0.08 })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/already allowed/);
  });

  test('points to the other field when the value breaks a different rule', async () => {
    state.entry.product.rules = [{ productRuleName: 'No discounts', lockedFields: { discountAmount: true } }];
    expect(await run(['request-preview', requestPlan()])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/on discountAmount/);
  });

  test('still points to the other field when the server refuses the trial', async () => {
    state.entry.product.rules = [{ productRuleName: 'No discounts', lockedFields: { discountAmount: true } }];
    state.calculateError = 'Locked field';
    expect(await run(['request-preview', requestPlan()])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/on discountAmount/);
  });

  test('blocks a second pending request on the same line and field, offering edit when it is own', async () => {
    state.exceptions.push({ _id: REQ, deal: DEAL, requestType: 'Request', status: 'Pending', createdBy: ME, ignoreProductRules: [{ uuid: 'u1', rules: [{ field: 'discountRate', value: 0.2 }] }] });
    expect(await run(['request-preview', requestPlan()])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/Edit it instead/);
  });

  test('rates are decimals', async () => {
    expect(await run(['request-preview', requestPlan({ value: 18 })])).toBe(2);
  });

  test('writing needs the version, --confirmed and --reaches-people', async () => {
    expect(await run(['request', requestPlan(), '--confirmed', '--reaches-people'])).toBe(2);
    expect(await run(['request', requestPlan(), '--version', 'v', '--confirmed'])).toBe(2);
    expect(await run(['request', requestPlan(), '--version', 'stale', '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toEqual([]);
  });

  test('sends exactly one line and one field, then reads it back', async () => {
    await run(['request-preview', requestPlan()]);
    const { version } = json();
    out = '';
    expect(await run(['request', requestPlan(), '--version', version, '--confirmed', '--reaches-people'])).toBe(0);
    const [post] = writes();
    expect(post.body).toEqual({
      deal: DEAL, requestType: 'Request', justification: 'Three-year contract', approver: id('3'),
      ignoreProductRules: [{ uuid: 'u1', rules: [{ field: 'discountRate', value: 0.18, originalValue: 0.05 }] }],
    });
    expect(json()).toMatchObject({ created: true, request: { status: 'Pending' } });
  });
});

describe('edit and cancel', () => {
  beforeEach(() => {
    state.exceptions.push({
      _id: REQ, deal: DEAL, requestType: 'Request', status: 'Pending', createdBy: ME, updatedAt: 'E1',
      approver: { _id: id('3'), firstName: 'Ann', email: 'ann@example.com' },
      ignoreProductRules: [{ uuid: 'u1', rules: [{ field: 'discountRate', value: 0.18 }] }],
    });
  });

  test('only the creator may cancel', async () => {
    state.exceptions[0].createdBy = OTHER;
    expect(await run(['cancel-preview', `{"id":"${REQ}"}`])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/Only the person who asked/);
  });

  test('cancel withdraws the own pending request', async () => {
    expect(await run(['cancel', `{"id":"${REQ}"}`, '--version', 'E1', '--confirmed', '--reaches-people'])).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'PUT', path: '/v2/commercialexception/cancel', body: { id: REQ } });
    expect(json().cancelled).toBe(true);
  });

  test('edit sends only the new value', async () => {
    const plan = `{"id":"${REQ}","value":0.16}`;
    await run(['edit-preview', plan]);
    const { version } = json();
    out = '';
    expect(await run(['edit', plan, '--version', version, '--confirmed', '--reaches-people'])).toBe(0);
    expect(writes()[0].body).toEqual({ id: REQ, value: 0.16 });
  });
});

describe('decide', () => {
  beforeEach(() => {
    state.exceptions.push({
      _id: REQ, deal: DEAL, requestType: 'Request', status: 'Pending', createdBy: OTHER, updatedAt: 'E1',
      ignoreProductRules: [{ uuid: 'u1', rules: [{ field: 'discountRate', value: 0.18, originalValue: 0.05 }] }],
    });
  });
  const preview = async (plan) => {
    out = '';
    await run(['decide-preview', JSON.stringify({ id: REQ, ...plan })]);
    return json();
  };

  test('a rejection needs a comment', async () => {
    expect(await run(['decide-preview', `{"id":"${REQ}","decision":"reject"}`])).toBe(2);
  });

  test('a counteroffer travels as approvedValue; the asked value does not', async () => {
    expect((await preview({ decision: 'approve', approvedValue: 0.15 })).counteroffer).toBe(true);
    expect((await preview({ decision: 'approve', approvedValue: 0.18 })).counteroffer).toBe(false);
  });

  test('a non-admin cannot decide on their own deal', async () => {
    state.deal.assignee = ME;
    const res = await preview({ decision: 'approve' });
    expect(res.blockers.join(' ')).toMatch(/someone else must decide/);
  });

  test('an admin approving their own request is flagged and needs --self-approval', async () => {
    state.me.isAdmin = true;
    state.exceptions[0].createdBy = ME;
    const res = await preview({ decision: 'approve' });
    expect(res.selfApproval).toBe(true);
    out = '';
    expect(await run(['decide', JSON.stringify({ id: REQ, decision: 'approve' }), '--version', res.version, '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toEqual([]);
  });

  test('approves and reports that the value reached the quote', async () => {
    const plan = { decision: 'approve', approvedValue: 0.15 };
    const res = await preview(plan);
    expect(res.reachesQuote).toMatchObject({ expected: true, change: { from: 0.05, to: 0.15 } });
    out = '';
    expect(await run(['decide', JSON.stringify({ id: REQ, ...plan }), '--version', res.version, '--confirmed', '--reaches-people'])).toBe(0);
    expect(writes()[0].body).toEqual({ status: 'Approved', approvedValue: 0.15 });
    expect(json().inQuote).toMatchObject({ applied: true, value: 0.15 });
    expect(out).not.toContain(KEY);
  });

  test('warns before, and reports after, an approval that cannot reach a closed deal', async () => {
    state.stage.endFlowStage = true;
    state.applies = false;
    const res = await preview({ decision: 'approve' });
    expect(res.reachesQuote.expected).toBe(false);
    out = '';
    await run(['decide', JSON.stringify({ id: REQ, decision: 'approve' }), '--version', res.version, '--confirmed', '--reaches-people']);
    expect(json().inQuote).toMatchObject({ applied: false });
    expect(json().inQuote.reason).toMatch(/^applyFailed/);
  });
});

describe('product rules', () => {
  test('creates a rule only after its preview, and refuses a code that exists', async () => {
    const plan = JSON.stringify({ set: { productRuleName: 'Cap 5', productRuleCode: 'cap-5', maxDiscountRate: 0.05 } });
    await run(['rule-preview', plan]);
    const { version, action } = json();
    expect(action).toBe('create');
    out = '';
    expect(await run(['rule-apply', plan, '--version', version, '--confirmed'])).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', body: { productRuleName: 'Cap 5', maxDiscountRate: 0.05 } });
    expect(await run(['rule-preview', JSON.stringify({ set: { productRuleName: 'Again', productRuleCode: 'cap-10' } })])).toBe(3);
  });

  test('edits keep the locked fields already set and check against the stored limits', async () => {
    state.rules[0].lockedFields = { price: true };
    const plan = JSON.stringify({ rule: 'cap-10', set: { lockedFields: { quantity: true }, maxDiscountRate: null } });
    await run(['rule-preview', plan]);
    const { version } = json();
    out = '';
    expect(await run(['rule-apply', plan, '--version', version, '--confirmed'])).toBe(0);
    expect(writes()[0].body).toEqual({ lockedFields: { price: true, quantity: true }, maxDiscountRate: null });
    expect(json()).toMatchObject({ saved: true, rule: { locked: ['price', 'quantity'], limits: {} } });
    expect(await run(['rule-apply', plan, '--version', version, '--confirmed'])).toBe(3);
  });
});

describe('--profile and 403', () => {
  test('--profile reads profile.<name>.json, and a 403 stops at once with a clear message', async () => {
    const SELLER_KEY = 'seller-key-not-the-admin-one';
    fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
    const seen = [];
    let stdout = '';
    let stderr = '';
    const code = await ce.main(['deals', D, 'Acme', '--profile', 'seller'], {
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
