/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const webhook = require('../.claude/skills/prolibu-webhooks/scripts/webhook');

const D = 'dev99.example.com';
const ID = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const NEW_ID = 'c'.repeat(24);
const CATALOG = ['Contact.*', 'Contact.create', 'Contact.update', 'Contact.delete', 'Deal.*', 'Deal.create', 'Deal.update',
  'Deal.delete', 'EventProspect.update', 'Quote.update', 'Webhook.update'];
const COLUMNS = {
  Contact: ['_id', 'firstName', 'lastName', 'email', 'address.city', 'address.country', 'updatedAt'],
  Deal: ['_id', 'dealName', 'stage', 'proposal.quote.total', 'proposal.quote.lineItems.productName'],
};

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

// A fake of the endpoints the script uses, shaped after the server behavior verified live:
// getschema answers a single model unwrapped and several models keyed by name; create answers 201;
// PATCH replaces arrays whole; webhooks come back with header values in clear.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (init.method === 'GET' && u.pathname === '/v2/service/getschema') {
    const names = u.searchParams.get('modelNames').split(',');
    if (u.searchParams.get('type') === 'attrs') return respond(200, { webhookName: {}, eventNames: { required: true, enum: CATALOG } });
    if (names.length === 1) return COLUMNS[names[0]] ? respond(200, COLUMNS[names[0]]) : respond(400, { error: 'Not found.' });
    return respond(200, Object.fromEntries(names.map((n) => [n, COLUMNS[n]])));
  }
  if (init.method === 'GET' && u.pathname === '/v2/preference/read') {
    if (state.prefStatus) return respond(state.prefStatus, { error: 'Forbidden' });
    return respond(200, { preference: { integrations: { webhooks: { enabled: state.enabled } }, billing: { secret: 'PREF-SECRET' } } });
  }
  if (init.method === 'GET' && u.pathname === '/v2/webhook') {
    const xquery = u.searchParams.get('xquery');
    const rows = Object.values(state.webhooks).filter((w) => !xquery || w.endpoint === JSON.parse(xquery).endpoint);
    return respond(200, { pagination: { count: rows.length }, data: rows });
  }
  const one = u.pathname.match(/^\/v2\/webhook\/([a-f0-9]{24})$/);
  if (init.method === 'GET' && one) return state.webhooks[one[1]] ? respond(200, state.webhooks[one[1]]) : respond(404, { error: 'Not found' });
  if (init.method === 'POST' && u.pathname === '/v2/webhook') {
    if (!state.enabled) return respond(400, { error: 'Webhooks are disabled, please enable them in preferences.' });
    state.webhooks[NEW_ID] = { ...body, _id: NEW_ID, webhookCode: 'WHK-1', updatedAt: 'T1' };
    return respond(201, state.webhooks[NEW_ID]);
  }
  if (init.method === 'PATCH' && one) {
    if (!state.enabled) return respond(400, { error: 'Webhooks are disabled, please enable them in preferences.' });
    state.webhooks[one[1]] = { ...state.webhooks[one[1]], ...body, updatedAt: 'T2' };
    if (state.dropHeadersOnSave) state.webhooks[one[1]].headers = [];
    return respond(200, state.webhooks[one[1]]);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];

const run = (argv, extra = {}) => webhook.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  lookup: extra.lookup || publicLookup,
  newSecret: () => 'GENERATED-VALUE',
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const createPlan = (extra = {}) => JSON.stringify({
  webhookName: 'Contacts to CRM',
  endpoint: 'https://crm.example.org/hooks/prolibu',
  eventNames: ['Contact.create', 'Contact.update'],
  selectedFields: [{ entity: 'Contact', fields: ['firstName', 'email'] }],
  headers: [{ name: 'X-Api-Key', generate: true }],
  active: false,
  ...extra,
});

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-webhooks-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-webhooks-plan-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    enabled: true,
    webhooks: {
      [ID]: {
        _id: ID,
        webhookCode: 'WHK-9',
        webhookName: 'Deals to billing',
        endpoint: 'https://billing.example.org/hook',
        eventNames: ['Deal.update'],
        selectedFields: [{ entity: 'deal', fields: ['_id', 'stage'] }],
        headers: [{ name: 'X-Api-Key', value: 'STORED-SECRET' }, { name: 'X-Tenant', value: 'TENANT-VALUE' }],
        timeoutMs: 120000,
        active: true,
        updatedAt: 'T1',
      },
      [OTHER]: {
        _id: OTHER, webhookName: 'Taken', endpoint: 'https://taken.example.org/hook', eventNames: ['Contact.create'], headers: [], updatedAt: 'T1',
      },
    },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkEndpoint', () => {
  test('only public https destinations pass', () => {
    expect(webhook.checkEndpoint('https://crm.example.org/hook?x=1').blocker).toBeUndefined();
    expect(webhook.checkEndpoint('http://crm.example.org/hook').blocker).toContain('https');
    expect(webhook.checkEndpoint('https://user:pw@crm.example.org/').blocker).toContain('user or password');
    expect(webhook.checkEndpoint('https://localhost/x').blocker).toContain('not a public host');
    expect(webhook.checkEndpoint('https://intranet/x').blocker).toContain('not a public host');
    expect(webhook.checkEndpoint('https://db.svc/x').blocker).toContain('not a public host');
    expect(webhook.checkEndpoint('https://10.0.0.5/x').blocker).toContain('private');
    expect(webhook.checkEndpoint('https://169.254.169.254/latest').blocker).toContain('private');
    expect(webhook.checkEndpoint('https://[::1]/x').blocker).toContain('private');
    expect(webhook.checkEndpoint('https://[::ffff:192.168.1.1]/x').blocker).toContain('private');
    expect(webhook.checkEndpoint('https://93.184.215.14/x').blocker).toContain('host name');
    expect(webhook.checkEndpoint('not a url').blocker).toContain('valid URL');
  });

  test('an endpoint on the same account passes with a loop warning', () => {
    const result = webhook.checkEndpoint(`https://${D}/v2/endpoint/sink`, { ownDomain: D });
    expect(result.blocker).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('loops');
  });
});

describe('normalizeEvents', () => {
  test('fixes the case to the exact name and removes repeats', () => {
    const { eventNames, normalized } = webhook.normalizeEvents(['contact.update', 'Contact.update', 'DEAL.*'], CATALOG);
    expect(eventNames).toEqual(['Contact.update', 'Deal.*']);
    expect(normalized).toEqual(['contact.update → Contact.update', 'DEAL.* → Deal.*']);
  });

  test('explains an unknown event and refuses Webhook events', () => {
    expect(() => webhook.normalizeEvents(['Contact.approved'], CATALOG)).toThrow('Contact.create');
    expect(() => webhook.normalizeEvents(['Contacts.create'], CATALOG)).toThrow('events <domain> <object>');
    expect(() => webhook.normalizeEvents([], CATALOG)).toThrow('at least one');
    expect(() => webhook.normalizeEvents(['Webhook.update'], CATALOG)).toThrow('secret headers');
  });
});

describe('buildSelectedFields', () => {
  const columnsOf = (m) => COLUMNS[m] || [];

  test('adds _id, fixes the entity case and accepts parent paths', () => {
    const { selectedFields } = webhook.buildSelectedFields([], [{ entity: 'contact', fields: ['email', 'address'] }], { models: ['Contact'], columnsOf });
    expect(selectedFields).toEqual([{ entity: 'Contact', fields: ['_id', 'email', 'address'] }]);
  });

  test('rejects unknown fields with suggestions, and objects without an event', () => {
    expect(() => webhook.buildSelectedFields([], [{ entity: 'Contact', fields: ['mail'] }], { models: ['Contact'], columnsOf })).toThrow('did you mean email');
    expect(() => webhook.buildSelectedFields([], [{ entity: 'Deal', fields: ['stage'] }], { models: ['Contact'], columnsOf })).toThrow('no event');
  });

  test('keeps stored lists, fixes their case, drops lists without events, and an empty list removes trimming', () => {
    const stored = [{ entity: 'deal', fields: ['_id', 'stage'] }, { entity: 'Contact', fields: ['email'] }];
    const kept = webhook.buildSelectedFields(stored, undefined, { models: ['Deal'], columnsOf });
    expect(kept.selectedFields).toEqual([{ entity: 'Deal', fields: ['_id', 'stage'] }]);
    expect(kept.notes.join(' ')).toContain('wrong case');
    expect(kept.notes.join(' ')).toContain('no Contact event');
    const cleared = webhook.buildSelectedFields(stored, [{ entity: 'Deal', fields: [] }], { models: ['Deal'], columnsOf });
    expect(cleared.selectedFields).toEqual([]);
  });
});

describe('buildHeaders', () => {
  const stored = [{ name: 'X-Api-Key', value: 'old' }, { name: 'X-Tenant', value: 't' }];

  test('replaces, generates and removes by name, keeping the rest', () => {
    const r = webhook.buildHeaders(stored, [{ name: 'x-api-key', generate: true }, { name: 'X-Tenant', remove: true }, { name: 'X-Env', value: 'prod' }], {
      generate: true, newSecret: () => 'NEW',
    });
    expect(r.headers).toEqual([{ name: 'x-api-key', value: 'NEW' }, { name: 'X-Env', value: 'prod' }]);
    expect(r.generated).toEqual([{ name: 'x-api-key', value: 'NEW' }]);
    expect(webhook.buildHeaders(stored, undefined).headers).toEqual(stored);
  });

  test('refuses bad names, platform headers and ambiguous entries', () => {
    expect(() => webhook.buildHeaders([], [{ name: 'Content-Type', value: 'x' }])).toThrow('set by the platform');
    expect(() => webhook.buildHeaders([], [{ name: 'Bad Name', value: 'x' }])).toThrow('valid header name');
    expect(() => webhook.buildHeaders([], [{ name: 'X-A', value: 'x', generate: true }])).toThrow('exactly one');
    expect(() => webhook.buildHeaders([], [{ name: 'X-A', value: 'a\nb' }])).toThrow('single-line');
    expect(() => webhook.buildHeaders([], [{ name: 'X-A', remove: true }])).toThrow('no stored header');
  });
});

describe('commands', () => {
  test('list masks header values and reports problems of stored webhooks', async () => {
    expect(await run(['list', D])).toBe(0);
    const result = JSON.parse(out);
    expect(result.accountSwitch).toBe('on');
    const stored = result.webhooks.find((w) => w._id === ID);
    expect(stored.headers).toEqual([{ name: 'X-Api-Key', value: '***' }, { name: 'X-Tenant', value: '***' }]);
    expect(stored.issues.join(' ')).toContain('wrong case');
    expect(out).not.toContain('STORED-SECRET');
    expect(out).not.toContain('PREF-SECRET');
  });

  test('the account switch is unknown when the user cannot read preferences', async () => {
    state.prefStatus = 403;
    expect(await run(['show', D, ID])).toBe(0);
    expect(JSON.parse(out).accountSwitch).toContain('unknown');
  });

  test('a new webhook must say active true or false', async () => {
    const plan = JSON.parse(createPlan());
    delete plan.active;
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(2);
    expect(err).toContain('"active"');
    expect(calls).toHaveLength(0);
  });

  test('preview validates against the server lists and writes nothing', async () => {
    expect(await run(['preview', D, createPlan({ eventNames: ['contact.create', 'Contact.update'] })])).toBe(0);
    const result = JSON.parse(out);
    expect(result.action).toBe('create');
    expect(result.after.eventNames).toEqual(['Contact.create', 'Contact.update']);
    expect(result.after.selectedFields).toEqual([{ entity: 'Contact', fields: ['_id', 'firstName', 'email'] }]);
    expect(result.headerChanges[0].change).toContain('shown once');
    expect(result.notes).toContain('event contact.create → Contact.create');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('apply creates, reads back and shows a generated secret once', async () => {
    expect(await run(['apply', D, createPlan(), '--confirmed'])).toBe(0);
    const post = calls.find((c) => c.method === 'POST');
    expect(post.body).toMatchObject({
      active: false,
      timeoutMs: 5000,
      selectedFields: [{ entity: 'Contact', fields: ['_id', 'firstName', 'email'] }],
      headers: [{ name: 'X-Api-Key', value: 'GENERATED-VALUE' }],
    });
    const result = JSON.parse(out);
    expect(result.saved).toBe(true);
    expect(result.webhook.headers).toEqual([{ name: 'X-Api-Key', value: '***' }]);
    expect(result.newSecrets).toEqual([{ name: 'X-Api-Key', value: 'GENERATED-VALUE' }]);
    expect(calls.filter((c) => c.method === 'GET' && c.path === `/v2/webhook/${NEW_ID}`)).toHaveLength(1);
  });

  test('apply refuses without --confirmed', async () => {
    expect(await run(['apply', D, createPlan()])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('a taken endpoint blocks the preview and the write', async () => {
    const plan = createPlan({ endpoint: 'https://taken.example.org/hook' });
    expect(await run(['preview', D, plan])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('already used');
    calls = [];
    expect(await run(['apply', D, plan, '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a host that resolves to a private address is blocked', async () => {
    const lookup = async () => [{ address: '10.1.2.3', family: 4 }];
    expect(await run(['preview', D, createPlan()], { lookup })).toBe(3);
    expect(err).toContain('private');
  });

  test('with webhooks off for the account, nothing is written', async () => {
    state.enabled = false;
    expect(await run(['preview', D, createPlan()])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('Preferences');
    calls = [];
    expect(await run(['apply', D, createPlan(), '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('an update needs the version from preview and stops if the webhook changed', async () => {
    const plan = JSON.stringify({ id: ID, active: false });
    expect(await run(['apply', D, plan, '--confirmed'])).toBe(2);
    expect(err).toContain('--webhook-version');
    state.webhooks[ID].updatedAt = 'T9';
    calls = [];
    expect(await run(['apply', D, plan, '--webhook-version', 'T1', '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('an update sends only what changes, with full lists, and keeps other header values', async () => {
    const plan = JSON.stringify({ id: ID, eventNames: ['Deal.update', 'Deal.create'], headers: [{ name: 'X-Api-Key', value: 'ROTATED' }] });
    expect(await run(['preview', D, plan])).toBe(0);
    const preview = JSON.parse(out);
    expect(preview.webhookVersion).toBe('T1');
    expect(Object.keys(preview.changes).sort()).toEqual(['eventNames', 'headers', 'selectedFields']);
    expect(out).not.toContain('ROTATED');
    expect(out).not.toContain('TENANT-VALUE');
    out = '';
    calls = [];
    expect(await run(['apply', D, plan, '--webhook-version', 'T1', '--confirmed'])).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.body).toEqual({
      eventNames: ['Deal.update', 'Deal.create'],
      selectedFields: [{ entity: 'Deal', fields: ['_id', 'stage'] }],
      headers: [{ name: 'X-Api-Key', value: 'ROTATED' }, { name: 'X-Tenant', value: 'TENANT-VALUE' }],
    });
    expect(JSON.parse(out).saved).toBe(true);
    expect(out).not.toContain('TENANT-VALUE');
  });

  test('a stored timeout above the app range is kept when not touched', async () => {
    const plan = JSON.stringify({ id: ID, webhookName: 'Deals to billing v2' });
    expect(await run(['apply', D, plan, '--webhook-version', 'T1', '--confirmed'])).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.body.timeoutMs).toBeUndefined();
    out = '';
    expect(await run(['preview', D, JSON.stringify({ id: ID, timeoutMs: 120000 })])).toBe(2);
  });

  test('a read-back that differs is reported as a failure', async () => {
    state.dropHeadersOnSave = true;
    const plan = JSON.stringify({ id: ID, active: false });
    expect(await run(['apply', D, plan, '--webhook-version', 'T1', '--confirmed'])).toBe(1);
    expect(JSON.parse(out).problems.join(' ')).toContain('headers');
  });

  test('events and fields resolve the exact object name', async () => {
    expect(await run(['events', D, 'contact'])).toBe(0);
    expect(JSON.parse(out).events).toEqual(['Contact.*', 'Contact.create', 'Contact.update', 'Contact.delete']);
    out = '';
    expect(await run(['fields', D, 'contact', 'addr'])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ object: 'Contact', fields: ['address.city', 'address.country'] });
    expect(await run(['fields', D, 'Contacts'])).toBe(2);
  });

  test('plan files outside temp folders are refused', async () => {
    const file = path.join(__dirname, `outside-webhook-plan-${process.pid}.json`);
    fs.writeFileSync(file, createPlan());
    try {
      expect(await run(['preview', D, file])).toBe(2);
      expect(err).toContain('temp folder');
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('a plan file in a temp folder works', async () => {
    const file = path.join(tmpDir, 'plan.json');
    fs.writeFileSync(file, createPlan());
    expect(await run(['preview', D, file])).toBe(0);
  });

  test('the API key never reaches the output', async () => {
    await run(['apply', D, createPlan(), '--confirmed']);
    await run(['list', D]);
    expect(out + err).not.toContain('SECRET123');
  });
});
