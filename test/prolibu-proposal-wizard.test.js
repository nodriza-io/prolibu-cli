/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('../.claude/skills/prolibu-proposal-wizard/scripts/wizard');

const D = 'dev99.example.com';
const KEY = 'SECRET123';
const id = (c) => c.repeat(24);
const WIZ = id('a');
const GROUP = id('b');
const OTHER_GROUP = id('c');
const PB = id('d');
const ENTRY = id('e');
const ENTRY2 = id('f');
const U1 = id('1');
const U2 = id('2');
const FORM = id('3');
const LAYOUT = id('4');
const NEW_ID = id('9');

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: (n) => lower[n.toLowerCase()] || null } };
}

const matches = (row, xq) => Object.entries(xq).every(([k, v]) => {
  if (k === '$or') return v.some((c) => matches(row, c));
  const val = k.split('.').reduce((o, p) => (o ? o[p] : undefined), row);
  if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(val));
  if (v && typeof v === 'object' && '$gte' in v) return String(val) >= v.$gte;
  return String(val && val._id ? val._id : val) === String(v);
});

function list(rows, q) {
  const xq = q.xquery ? JSON.parse(q.xquery) : {};
  const data = rows.filter((r) => matches(r, xq));
  return respond(200, { pagination: { count: data.length }, data });
}

// A fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, host: u.host, path: u.pathname, query: q, body, auth: init.headers && init.headers.Authorization });
  const m = init.method;
  const p = u.pathname;
  const last = decodeURIComponent(p.split('/').pop());
  if (state.forbidden && p.startsWith('/v2/proposalwizard')) return respond(403, { error: 'Forbidden. User has no permission.' });
  // Anonymous public page and config.
  if (p.startsWith('/pw/')) return respond(200, '<html><head><meta name="robots" content="noindex, nofollow"><script src="https://cdn.example.com/x.js"></script></head></html>', { 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'self' null" });
  if (p.startsWith('/v2/proposalWizard/getUiConfig/')) {
    const w = state.wizards.find((x) => x.proposalWizardCode === last);
    if (!w) return respond(404, { error: 'Not found' });
    if (w.active === false) return respond(400, { error: 'Proposal Wizard is not active.' });
    return respond(200, { proposalWizardCode: w.proposalWizardCode, lineItems: [{ pricebookEntry: ENTRY, productName: 'Coffee', price: 10, currency: 'USD' }], turnstileSiteKey: '', session: { status: init.headers.Authorization ? 'advisor' : 'anonymous' } });
  }
  if (m === 'GET' && p === '/v2/proposalwizard') return list(state.wizards, q);
  if (m === 'GET' && p.startsWith('/v2/proposalwizard/')) {
    const w = state.wizards.find((x) => x._id === last || x.proposalWizardCode === last);
    return w ? respond(200, { ...w, note: `key ${KEY}` }) : respond(404, { error: 'Not found' });
  }
  if (m === 'POST' && p === '/v2/proposalwizard') {
    const w = { _id: NEW_ID, proposalWizardCode: 'new-wizard-123', active: true, ...body, updatedAt: 'W0' };
    state.wizards.push(w);
    return respond(200, w);
  }
  if (m === 'PATCH' && p.startsWith('/v2/proposalwizard/')) {
    const w = state.wizards.find((x) => x._id === last);
    for (const [k, v] of Object.entries(body)) w[k] = v;
    w.updatedAt = 'W2';
    return respond(200, w);
  }
  if (m === 'GET' && p === '/v2/usergroup') return list(state.groups, q);
  if (m === 'GET' && p.startsWith('/v2/usergroup/')) {
    const g = state.groups.find((x) => x._id === last);
    return g ? respond(200, g) : respond(404, { error: 'Not found' });
  }
  if (m === 'POST' && p === '/v2/usergroup') {
    const g = { _id: id('8'), ...body, updatedAt: 'G0' };
    state.groups.push(g);
    return respond(200, g);
  }
  if (m === 'PATCH' && p.startsWith('/v2/usergroup/')) {
    const g = state.groups.find((x) => x._id === last);
    Object.assign(g, body, { updatedAt: 'G2' });
    return respond(200, g);
  }
  if (m === 'GET' && p === '/v2/user') return list(state.users, q);
  if (m === 'GET' && p === '/v2/pricebookentry') return list(state.entries, q);
  if (m === 'GET' && p === '/v2/pricebook') return list(state.pricebooks, q);
  if (m === 'GET' && p.startsWith('/v2/pricebook/')) {
    const pb = state.pricebooks.find((x) => x._id === last);
    return pb ? respond(200, pb) : respond(404, { error: 'Not found' });
  }
  if (m === 'GET' && p.startsWith('/v2/contenttemplate')) return p === '/v2/contenttemplate' ? list([{ _id: LAYOUT, contentTemplateName: 'Main', templateType: 'layout' }], q) : (last === LAYOUT ? respond(200, { _id: LAYOUT, templateType: 'layout' }) : respond(404, {}));
  if (m === 'GET' && p.startsWith('/v2/form/')) return state.form && last === FORM ? respond(200, state.form) : respond(404, { error: 'Not found' });
  if (m === 'GET' && p === '/v2/deal') return list(state.deals, q);
  if (m === 'GET' && p === '/v2/contact') return list(state.contacts, q);
  if (m === 'GET' && p === '/v2/shorturl') return list(state.shorturls, q);
  if (m === 'GET' && p.startsWith('/v2/shorturl/')) {
    const s = state.shorturls.find((x) => x.shortUrlCode === last);
    return s ? respond(200, s) : respond(404, {});
  }
  if (m === 'POST' && p === '/v2/shorturl') {
    const s = { _id: id('7'), shortUrlCode: body.shortUrlCode || 'Ab3dEf7h', url: body.url };
    state.shorturls.push(s);
    return respond(200, s);
  }
  return respond(404, { error: `unexpected ${m} ${p}` });
}

const run = (argv, extra = []) => pw.main([argv[0], D, ...argv.slice(1), ...extra], {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET');
const versionOf = async (argv) => {
  out = '';
  await run(argv);
  const v = json().version;
  out = '';
  return v;
};

const baseWizard = (over = {}) => ({
  _id: WIZ, proposalWizardCode: 'shop-123', proposalWizardName: 'Shop', active: true, assignmentGroup: GROUP,
  proposalPreset: { title: 'Your quote', layout: LAYOUT }, lineItemsSource: { pricebook: PB }, displaySettings: { title: 'Hello', subtitle: 'Sub' },
  language: 'es', updatedAt: 'W1', ...over,
});

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-pw-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: 'SELLERKEY' }));
  out = '';
  err = '';
  calls = [];
  state = {
    wizards: [baseWizard()],
    groups: [
      { _id: GROUP, userGroupName: 'Sales team', userGroupType: 'Proposal Wizard', users: [U1, U2], enableLoadBalancing: true, updatedAt: 'G1' },
      { _id: OTHER_GROUP, userGroupName: 'Leads', userGroupType: 'Contact Assignment', users: [U1], updatedAt: 'G1' },
    ],
    users: [
      { _id: U1, firstName: 'Ann', lastName: 'One', email: 'ann@example.com', status: 'Active' },
      { _id: U2, firstName: 'Bob', lastName: 'Two', email: 'bob@example.com', status: 'Active' },
    ],
    pricebooks: [{ _id: PB, pricebookName: 'Retail', active: true, updatedAt: 'P1' }],
    entries: [
      { _id: ENTRY, pricebook: { _id: PB, pricebookName: 'Retail', active: true }, product: { productName: 'Coffee', active: true }, price: 10, currency: 'USD', active: true },
      { _id: ENTRY2, pricebook: { _id: PB, pricebookName: 'Retail', active: true }, product: { productName: 'Tea', active: true }, price: 8, currency: 'USD', active: true },
    ],
    form: null,
    deals: [],
    contacts: [],
    shorturls: [],
  };
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('pure helpers', () => {
  test('validateSet refuses active, unknown fields and percentages above 1', () => {
    expect(() => pw.validateSet({ active: true }, { creating: false })).toThrow(/preview-publish/);
    expect(() => pw.validateSet({ price: 1 }, { creating: true })).toThrow(/Unknown/);
    const tsd = (over) => ({ proposalPreset: { timeSensitiveDiscounts: { enabled: true, strategy: 'Real-Time', time: 3600000, ...over } } });
    expect(() => pw.validateSet(tsd({ overrideDiscount: { percentage: 15 } }), { creating: true })).toThrow(/decimal/);
    expect(() => pw.validateSet(tsd({ strategy: 'Soon' }), { creating: true })).toThrow(/strategy/);
    expect(() => pw.validateSet({ requireAuthentication: true, allowSignIn: false }, { creating: true })).toThrow(/allowSignIn/);
  });

  test('time-sensitive discount time is milliseconds; a page language outside es/en/pt is flagged', () => {
    const warnings = pw.validateSet({ language: 'fr', proposalPreset: { timeSensitiveDiscounts: { enabled: true, strategy: 'Real-Time', time: 30 } } }, { creating: true });
    expect(warnings.join(' ')).toMatch(/MILLISECONDS/);
    expect(warnings.join(' ')).toMatch(/shows Spanish/);
    expect(pw.validateSet({ language: 'en' }, { creating: true })).toEqual([]);
    expect(pw.humanDuration(3600000)).toBe('1 hour');
  });

  test('deepMerge keeps stored keys; arrays replace whole', () => {
    expect(pw.deepMerge({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: 9 }, e: [3] })).toEqual({ a: 1, b: { c: 9, d: 3 }, e: [3] });
    expect(pw.diffPaths({ b: { c: 2, d: 3 } }, { b: { c: 9, d: 3 } })).toEqual([{ field: 'b.c', from: 2, to: 9 }]);
  });

  test('product links carry pbe and the lock flag', () => {
    expect(pw.productLink(D, 'shop-123', [ENTRY], true)).toBe(`https://${D}/pw/shop-123?pbe=${ENTRY}&avoidChangeProduct=true`);
    expect(pw.productLink(D, 'shop-123', [ENTRY, ENTRY2], false)).toBe(`https://${D}/pw/shop-123?pbe=${ENTRY},${ENTRY2}`);
  });
});

describe('read commands', () => {
  test('list gives the public link and redacts the key', async () => {
    state.wizards[0].proposalWizardName = `Shop ${KEY}`;
    expect(await run(['list'])).toBe(0);
    expect(json().wizards[0].link).toBe(`https://${D}/pw/shop-123`);
    expect(out).not.toContain(KEY);
  });

  test('doctor: a healthy wizard is ok and lists the assignment mode', async () => {
    expect(await run(['doctor', 'shop-123'])).toBe(0);
    const r = json();
    expect(r.ok).toBe(true);
    expect(r.group.activeUsers).toBe(2);
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['assignment', 'noCaptcha']));
  });

  test('doctor: no active user in the group loses the quote', async () => {
    state.users.forEach((u) => { u.status = 'Inactive'; });
    await run(['doctor', 'shop-123']);
    expect(json().findings.find((f) => f.code === 'noActiveUsers').level).toBe('error');
  });

  test('doctor: unreadable users are a warning, never an error', async () => {
    state.users = [];
    await run(['doctor', 'shop-123']);
    const codes = json().findings.map((f) => `${f.level}:${f.code}`);
    expect(codes).toEqual(expect.arrayContaining(['warning:activeUnknown', 'warning:unreadableUsers']));
    expect(codes).not.toContain('error:noActiveUsers');
  });

  test('doctor: no products, wrong group type, form captcha and inactive siblings', async () => {
    state.entries = [];
    state.form = { _id: FORM, formName: 'Extra', active: true, type: 'web', access: { mode: 'public', enableCaptcha: true } };
    Object.assign(state.wizards[0], { assignmentGroup: OTHER_GROUP, form: FORM, wizardGroup: id('5') });
    state.wizards.push(baseWizard({ _id: id('6'), proposalWizardCode: 'sibling', active: false, wizardGroup: id('5') }));
    await run(['doctor', 'shop-123']);
    const codes = json().findings.map((f) => `${f.level}:${f.code}`);
    expect(codes).toEqual(expect.arrayContaining(['error:noProducts', 'warning:groupType', 'warning:formCaptcha', 'warning:inactiveSiblings']));
    expect(json().ok).toBe(false);
  });

  test('public-check and the visitor view go out without any key, to the account host only', async () => {
    expect(await run(['public-check', 'shop-123'])).toBe(0);
    const anon = calls.filter((c) => c.path.startsWith('/pw/') || c.path.startsWith('/v2/proposalWizard/getUiConfig'));
    expect(anon.length).toBe(2);
    expect(anon.every((c) => !c.auth && c.host === D)).toBe(true);
    const msgs = json().findings.map((f) => f.message).join(' ');
    expect(msgs).toMatch(/X-Robots-Tag/);
    expect(msgs).toMatch(/integrity/);
    expect(json().page.frameAncestors.unusual).toEqual(['null']);
  });

  test('deals: raw assignee id, contact owner mismatch, price changes and twins', async () => {
    const C = id('7');
    const deal = (n, at) => ({
      _id: id(String(n)), createdAt: at, dealName: '@Shop - Ann', assignee: id('0'), proposalWizard: WIZ,
      contact: { _id: C, email: 'v@example.com', assignee: U1 },
      proposal: { quote: { total: 12, quoteCurrency: 'USD', lineItems: [{ productName: 'Coffee', quantity: 1, price: 12, pricebookEntry: ENTRY }] } },
    });
    state.deals = [deal(8, '2026-01-01T10:00:30.000Z'), deal(9, '2026-01-01T10:00:00.000Z')];
    expect(await run(['deals', 'shop-123'])).toBe(0);
    const r = json();
    expect(r.deals[0].assignee).toMatchObject({ _id: id('0'), readable: false });
    expect(r.deals[0].contactOwnerDiffers).toBe(true);
    expect(r.deals[0].lines[0]).toMatchObject({ priceNow: 10, priceChanged: true });
    expect(r.twins.length).toBe(1);
  });

  test('a 403 stops at once with the FORBIDDEN message and no retry', async () => {
    state.forbidden = true;
    expect(await run(['show', 'shop-123'], ['--profile', 'seller'])).toBe(1);
    expect(err).toMatch(/FORBIDDEN/);
    expect(err).toMatch(/did not retry it or try another profile/);
    expect(calls.length).toBe(1);
    expect(calls[0].auth).toBe('Bearer SELLERKEY');
  });
});

describe('create and update', () => {
  const createPlan = (over = {}) => JSON.stringify({ set: { proposalWizardName: 'Fair', assignmentGroup: 'Sales team', proposalPreset: { title: 'Quote', layout: 'Main' }, lineItemsSource: { pricebook: 'Retail' }, ...over } });

  test('preview-create resolves names, forces active false and writes nothing', async () => {
    expect(await run(['preview-create', createPlan()])).toBe(0);
    const r = json();
    expect(r.wizard).toMatchObject({ assignmentGroup: GROUP, active: false, lineItemsSource: { pricebook: PB }, proposalPreset: { layout: LAYOUT } });
    expect(r.nextStep).toMatch(/STOP HERE/);
    expect(writes()).toEqual([]);
  });

  test('preview-create is blocked when the wizard would offer no product', async () => {
    expect(await run(['preview-create', createPlan({ lineItemsSource: {} })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/no active product/);
  });

  test('create needs --confirmed and the same version, posts active false and reads back', async () => {
    const v = await versionOf(['preview-create', createPlan()]);
    expect(await run(['create', createPlan(), '--version', v])).toBe(2);
    expect(await run(['create', createPlan(), '--version', 'old', '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
    out = '';
    expect(await run(['create', createPlan(), '--version', v, '--confirmed'])).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/v2/proposalwizard', body: { active: false } });
    expect(json().wizard.active).toBe(false);
  });

  test('update sends the whole nested object merged with what is stored', async () => {
    const plan = JSON.stringify({ set: { displaySettings: { subtitle: 'New' } } });
    const v = await versionOf(['preview-update', 'shop-123', plan]);
    expect(await run(['update', 'shop-123', plan, '--version', v, '--confirmed'])).toBe(0);
    expect(writes()[0].body).toEqual({ displaySettings: { title: 'Hello', subtitle: 'New' } });
  });

  test('changing the code needs --rename-link; active is never set by update', async () => {
    expect(await run(['preview-update', 'shop-123', JSON.stringify({ set: { proposalWizardCode: 'other' } })])).toBe(3);
    expect(err).toMatch(/--rename-link/);
    expect(await run(['preview-update', 'shop-123', JSON.stringify({ set: { active: false } })])).toBe(2);
  });

  test('update of a published wizard is blocked when it would lose submissions', async () => {
    const plan = JSON.stringify({ set: { lineItemsSource: { pricebook: null } } });
    state.entries = [];
    expect(await run(['preview-update', 'shop-123', plan])).toBe(3);
  });
});

describe('publish, group and short link', () => {
  test('publish is blocked by errors, then patches only active and checks the page', async () => {
    state.wizards[0].active = false;
    state.users.forEach((u) => { u.status = 'Inactive'; });
    expect(await run(['preview-publish', 'shop-123'])).toBe(3);
    state.users.forEach((u) => { u.status = 'Active'; });
    const v = await versionOf(['preview-publish', 'shop-123']);
    expect(await run(['publish', 'shop-123', '--version', v, '--confirmed'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', body: { active: true } })]);
    expect(json().publicPageStatus).toBe(200);
  });

  test('unpublish of an unpublished wizard is blocked', async () => {
    state.wizards[0].active = false;
    expect(await run(['preview-unpublish', 'shop-123'])).toBe(3);
  });

  test('group: unknown e-mail blocks; a new group is of type Proposal Wizard', async () => {
    const bad = JSON.stringify({ name: 'QA', emails: ['ann@example.com', 'nobody@example.com'] });
    expect(await run(['preview-group', bad])).toBe(3);
    const plan = JSON.stringify({ name: 'QA', emails: ['ann@example.com'], roundRobin: false });
    const v = await versionOf(['preview-group', plan]);
    expect(await run(['group', plan, '--version', v, '--confirmed'])).toBe(0);
    expect(writes()[0].body).toEqual({ users: [U1], userGroupName: 'QA', enableLoadBalancing: false, userGroupType: 'Proposal Wizard' });
  });

  test('group: a group of another type is never edited', async () => {
    expect(await run(['preview-group', JSON.stringify({ group: OTHER_GROUP, emails: ['bob@example.com'] })])).toBe(3);
    expect(err).toMatch(/Contact Assignment/);
  });

  test('short link: taken code and entries the wizard does not offer block; nothing is deleted', async () => {
    state.shorturls.push({ shortUrlCode: 'fair', url: 'https://elsewhere.example.com' });
    expect(await run(['preview-shortlink', 'shop-123', JSON.stringify({ code: 'fair' })])).toBe(3);
    expect(await run(['preview-shortlink', 'shop-123', JSON.stringify({ code: 'fair2', pbe: [id('0')] })])).toBe(3);
    const plan = JSON.stringify({ code: 'fair2', pbe: [ENTRY], lock: true });
    const v = await versionOf(['preview-shortlink', 'shop-123', plan]);
    expect(await run(['shortlink', 'shop-123', plan, '--version', v, '--confirmed'])).toBe(0);
    expect(json().link).toBe(`https://${D}/r/fair2`);
    expect(writes().map((c) => c.method)).toEqual(['POST']);
  });

  test('no command ever submits the public form', async () => {
    for (const argv of [['show', 'shop-123'], ['doctor', 'shop-123'], ['public-check', 'shop-123'], ['links', 'shop-123']]) await run(argv);
    expect(calls.some((c) => /generate|pairsubmit/i.test(c.path))).toBe(false);
    expect(pw.PUBLIC_PATH_RE.test('/v2/proposalWizard/generate')).toBe(false);
  });
});
