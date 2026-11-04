/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dg = require('../.claude/skills/prolibu-diagnostics/scripts/diagnose');

const D = 'dev99.example.com';
const KEY = 'SECRET123';
const SELLER_KEY = 'SELLERKEY456';
const PASSWORD = 'Plain-Pass-9876';
const id = (c) => c.repeat(24);
const ADMIN = id('1');
const SELLER = id('2');
const DEAL = id('a');
const FOREIGN_DEAL = id('b');
const CONTACT = id('c');
const SCRIPT = id('d');
const FOREIGN_USER = id('e');

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const list = (rows) => ({ pagination: { count: rows.length, page: 1, lastPage: 1 }, data: rows });
const matchIn = (rows, field, xq) => {
  const cond = xq[field];
  if (cond && cond.$in) return rows.filter((r) => cond.$in.includes(String(r[field])));
  return rows;
};

// A fake of the endpoints the script reads, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  const xq = q.xquery ? JSON.parse(q.xquery) : {};
  const auth = init.headers.Authorization;
  const seller = auth === `Bearer ${SELLER_KEY}`;
  calls.push({ method: init.method, path: u.pathname, query: q, xq, seller });
  const p = u.pathname;
  if (seller && state.sellerForbidden.some((re) => re.test(p))) {
    return respond(403, { error: 'Forbidden. User has no permission.' });
  }
  if (p === '/v2/user/me') {
    return respond(200, { profile: seller ? { _id: SELLER, email: 'sam@example.com', isAdmin: false, status: 'Active' } : { _id: ADMIN, email: 'ada@example.com', isAdmin: true, status: 'Active' } });
  }
  if (p === '/v2/user/preferences') return respond(200, state.prefs);
  if (p === '/v2/user') {
    let rows = state.users;
    if (xq._id) rows = matchIn(rows, '_id', xq);
    else if (xq.email && xq.email.$in) rows = matchIn(rows, 'email', xq);
    else if (typeof xq.email === 'string') rows = rows.filter((r) => r.email === xq.email);
    return respond(200, list(rows));
  }
  if (p === '/v2/deal') return respond(200, list(matchIn(state.deals, '_id', xq)));
  if (p === `/v2/deal/${DEAL}`) return respond(200, state.deals[0]);
  if (p === '/v2/auditlog/getlogs') {
    if (state.auditOff) return respond(400, { error: 'Audit log feature is not enabled' });
    let rows = state.audit;
    if (q.targetModel) rows = rows.filter((r) => r.targetModel === q.targetModel);
    return respond(200, list(rows));
  }
  if (p === '/v2/stagehistory') return respond(200, list(state.stageHistory));
  if (p === '/v2/notification') return respond(200, list(state.notifications));
  if (p === '/v2/email') return respond(200, list(state.emails));
  if (p === '/v2/contact') return respond(200, list(state.contacts));
  if (p === '/v2/script') return respond(200, list(state.scripts.filter((s) => !xq.scriptCode || s.scriptCode === xq.scriptCode)));
  if (p === '/v2/log') return respond(200, list(state.logs));
  if (p === '/v2/webhook') return respond(200, list(state.webhooks));
  if (p === '/v2/eventsubscription') return respond(200, list(state.subscriptions));
  if (p === '/v2/loginactivity') return respond(200, list(state.logins)); // the server may ignore the e-mail filter
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

const run = (argv) => dg.main([argv[0], D, ...argv.slice(1)], {
  rootDir,
  fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const paths = () => calls.map((c) => c.path);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-diag-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.vendedor.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  out = '';
  err = '';
  calls = [];
  const now = new Date().toISOString();
  state = {
    sellerForbidden: [/^\/v2\/auditlog/, /^\/v2\/log$/, /^\/v2\/webhook/, /^\/v2\/eventsubscription/, /^\/v2\/user$/, /^\/v2\/script/],
    prefs: {
      integrations: {
        lifecycleHooks: { enabled: true, enabledEntities: ['Contact'] },
        webhooks: { enabled: true },
        thirdParty: { ultramsg: { enabled: true, token: KEY }, sendgrid: { enabled: false, apiKey: KEY } },
      },
      modules: { system: { stage: { stageHistory: { enabled: true, trackedStageFields: ['Deal.stage'] } } } },
      security: { secretThing: 'do-not-print' },
    },
    users: [
      { _id: ADMIN, firstName: 'Ada', lastName: 'Admin', email: 'ada@example.com', status: 'Active' },
      { _id: SELLER, firstName: 'Sam', lastName: 'Seller', email: 'sam@example.com', status: 'Active', mobile: '+570000000' },
    ],
    deals: [{ _id: DEAL, createdAt: '2026-11-01T10:00:00.000Z', createdBy: SELLER, updatedAt: now, updatedBy: ADMIN, contact: CONTACT }],
    audit: [
      {
        occurredAt: now, event: 'operation.update', actor: ADMIN, actorEmail: 'ada@example.com', ip: '181.10.20.30', userAgent: 'Mozilla/5.0 (Mac)', targetModel: 'Deal', targetId: DEAL, detail: { changes: { amount: 5000, secret: KEY, nested: { password: PASSWORD, note: 'ok' } } }, result: 'success',
      },
      {
        occurredAt: now, event: 'user.update', actor: ADMIN, actorEmail: 'ada@example.com', ip: '181.10.20.30', userAgent: 'node', targetModel: 'User', targetId: SELLER, detail: { changes: { password: PASSWORD, firstName: 'Sam' } }, result: 'success',
      },
      {
        occurredAt: now, event: 'operation.update', actor: FOREIGN_USER, actorEmail: 'x@other.example.com', ip: '10.0.0.1', userAgent: 'node', targetModel: 'Deal', targetId: FOREIGN_DEAL, detail: { changes: { amount: 1 } }, result: 'success',
      },
      { occurredAt: now, event: 'auth.signin', actorEmail: 'stranger@other.example.com', ip: '10.0.0.2', userAgent: 'curl', result: 'success' },
      { occurredAt: now, event: 'auth.signinFailed', actorEmail: 'sam@example.com', ip: '10.0.0.3', userAgent: 'curl', result: 'failure', reason: 'Invalid credentials' },
    ],
    stageHistory: [{ _id: id('5'), movedAt: now, stageField: 'stage', fromStage: { stageName: 'New' }, toStage: { stageName: 'Won' }, movedBy: { _id: ADMIN, firstName: 'Ada', email: 'ada@example.com' } }],
    notifications: [{ _id: id('6'), createdAt: now, eventType: 'deals.onSetAsAssignee', assignee: SELLER, createdBy: ADMIN, values: { docId: DEAL, modelName: 'Deal', contactPhone: '+5711111', contactEmail: 'client@example.com' } }],
    emails: [{
      _id: id('7'), emailCode: 'e-1', to: 'client@example.com', subject: 'Offer', message: '<p>PRIVATE BODY</p>', status: 'failed', error: 'Mailbox unavailable', provider: 'google', createdAt: now, events: [{ type: 'open', ip: '1.2.3.4', at: now, machine: false }],
    }],
    contacts: [{ _id: CONTACT, email: 'client@example.com', firstName: 'Cleo', emailStatus: { state: 'bounced' } }],
    scripts: [{ _id: SCRIPT, scriptCode: 'welcome', scriptName: 'Welcome', active: true, lifecycleHooks: ['Deal'] }],
    logs: [{ _id: id('8'), createdAt: now, status: 'Failure', message: 'boom', meta: { scriptId: SCRIPT, scriptCode: 'welcome', eventName: 'Deal.afterUpdate', errorStack: 'Error: boom\n at a\n at b\n at c\n at d\n at e' } }],
    webhooks: [
      { _id: id('9'), webhookName: 'Hook A', endpoint: `https://hooks.example.com/in/${KEY}?sig=abc`, eventNames: ['Deal.*'], active: true, headers: [{ name: 'X-Auth', value: 'hdr-secret' }] },
      { _id: id('3'), webhookName: 'Hook B', endpoint: 'https://b.example.com/x', eventNames: ['Deal.update'], active: false },
      { _id: id('4'), webhookName: 'Hook C', endpoint: 'https://c.example.com/x', eventNames: ['Contact.create'], active: true },
    ],
    subscriptions: [{ _id: id('0'), user: SELLER, events: { deals: { onSetAsAssignee: { notificationCenter: true, email: true, ultramsg: true, slack: false } } } }],
    logins: [
      { email: 'sam@example.com', createdAt: now, loginStatus: 'Failure', reason: 'Invalid credentials', ip: '190.1.2.3', country: 'CO' },
      { email: 'sam@example.com', createdAt: now, loginStatus: 'Success', ip: '190.1.2.3', country: 'CO' },
      { email: 'other@example.com', createdAt: now, loginStatus: 'Success', ip: '8.8.8.8' },
    ],
  };
});

afterEach(() => {
  // Read-only: nothing but GET ever leaves the script.
  expect(calls.every((c) => c.method === 'GET')).toBe(true);
  expect(out).not.toContain(KEY);
  expect(out).not.toContain(PASSWORD);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('read-only guard', () => {
  test('refuses every method but GET', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(() => dg.assertReadOnly(m, '/v2/deal')).toThrow(/read-only/);
    expect(() => dg.assertReadOnly('GET', '/v2/deal')).not.toThrow();
  });

  test('refuses reads that change data or export unfiltered rows', () => {
    for (const p of ['/v2/eventsubscription/getMine', '/v2/email/view/abc', '/v2/email/click/t/1', '/v2/email/unsubscribe/x', '/v2/email/consent/x',
      '/v2/log/clear', '/v2/notification/clean', '/v2/auditlog/getlogs?limit=1&format=csv', '/v2/auditlog/getlogs?format=XLSX']) {
      expect(() => dg.assertReadOnly('GET', p)).toThrow(/Refusing/);
    }
  });

  test('--confirmed is a usage error and sends nothing', async () => {
    expect(await run(['audit', '--confirmed'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('audit', () => {
  test('never prints passwords or secrets, even with --values; no values for users', async () => {
    expect(await run(['audit', '--values'])).toBe(0);
    const res = json();
    const deal = res.rows.find((r) => r.targetModel === 'Deal');
    expect(deal.values).toEqual({ amount: 5000, nested: { note: 'ok' } });
    const user = res.rows.find((r) => r.targetModel === 'User');
    expect(user.values).toMatch(/not shown/);
    expect(user.fields).toEqual(['firstName']);
  });

  test('field names only by default', async () => {
    expect(await run(['audit'])).toBe(0);
    const deal = json().rows.find((r) => r.targetModel === 'Deal');
    expect(deal.fields).toEqual(['amount', 'nested']);
    expect(deal.values).toBeUndefined();
  });

  test('drops rows whose record or person is not on this account and counts them', async () => {
    expect(await run(['audit'])).toBe(0);
    const res = json();
    expect(res.droppedNotOnThisAccount).toBe(2);
    expect(res.rows.map((r) => r.actorEmail)).not.toContain('x@other.example.com');
    expect(res.rows.map((r) => r.actorEmail)).not.toContain('stranger@other.example.com');
    expect(res.rows.find((r) => r.event === 'auth.signinFailed').reason).toBe('Invalid credentials');
  });

  test('masks IP and user agent unless --ip', async () => {
    await run(['audit']);
    const row = json().rows.find((r) => r.targetModel === 'Deal');
    expect(row.ip).toBe('181.x.x.x');
    expect(row.userAgent).toBe('Mozilla/…');
    out = '';
    await run(['audit', '--ip']);
    expect(json().rows.find((r) => r.targetModel === 'Deal').ip).toBe('181.10.20.30');
  });

  test('defaults to the last 24 hours, says so, and never asks for an export', async () => {
    await run(['audit']);
    const res = json();
    expect(res.window.defaulted).toBe(true);
    expect(res.window.note).toMatch(/24 hours/);
    const q = calls.find((c) => c.path === '/v2/auditlog/getlogs').query;
    expect(new Date(q.endTime) - new Date(q.startTime)).toBe(24 * 3600 * 1000);
    expect(q.format).toBeUndefined();
  });

  test('a disabled audit log is blocked (exit 3)', async () => {
    state.auditOff = true;
    expect(await run(['audit'])).toBe(3);
    expect(err).toMatch(/not enabled/);
  });

  test('a seller gets FORBIDDEN once, with --profile, and no retry', async () => {
    expect(await run(['audit', '--profile', 'vendedor'])).toBe(1);
    expect(err).toMatch(/^FORBIDDEN/);
    expect(err).toMatch(/did not retry/);
    expect(calls.filter((c) => c.path === '/v2/auditlog/getlogs')).toHaveLength(1);
    expect(calls.every((c) => c.seller)).toBe(true);
  });
});

describe('record', () => {
  test('builds a timeline with nested filters and filtered personal data', async () => {
    expect(await run(['record', 'Deal', DEAL])).toBe(0);
    const res = json();
    const sh = calls.find((c) => c.path === '/v2/stagehistory');
    expect(sh.xq).toEqual({ origin: { modelName: 'Deal', docId: DEAL } });
    expect(sh.query.modelName).toBeUndefined();
    expect(calls.find((c) => c.path === '/v2/notification').xq).toEqual({ values: { docId: DEAL } });
    expect(res.audit.rows.map((r) => r.targetId)).toEqual([DEAL]);
    expect(res.timeline.map((t) => t.source)).toEqual(expect.arrayContaining(['stageHistory', 'auditLog', 'notification', 'email', 'record']));
    expect(out).not.toContain('PRIVATE BODY');
    expect(out).not.toContain('+5711111');
  });

  test('a seller sees what the profile may read and gets the rest listed as forbidden', async () => {
    expect(await run(['record', 'Deal', DEAL, '--profile', 'vendedor'])).toBe(0);
    const res = json();
    expect(res.forbidden.map((f) => f.read)).toEqual(expect.arrayContaining(['audit log']));
    expect(res.forbiddenHint).toMatch(/did not retry/);
  });

  test('rejects a bad id before any call', async () => {
    expect(await run(['record', 'Deal', '123'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('script', () => {
  test('reads logs with the nested meta filter and reports the failing switches', async () => {
    expect(await run(['script', 'welcome', '--model', 'Deal'])).toBe(0);
    const res = json();
    const logCalls = calls.filter((c) => c.path === '/v2/log');
    expect(logCalls.map((c) => c.xq)).toEqual([{ logType: 'Script', meta: { scriptId: SCRIPT } }, { logType: 'Script', meta: { scriptCode: 'welcome' } }]);
    expect(logCalls.every((c) => !Object.keys(c.xq).some((k) => k.includes('.')))).toBe(true);
    expect(res.verdict).toMatch(/Deal is enabled for lifecycle hooks/);
    expect(res.logs).toHaveLength(1);
    expect(res.logs[0].errorStack.split('\n')).toHaveLength(4);
    expect(res.notes.join(' ')).toMatch(/No log does not mean it did not run/);
  });

  test('unknown script code is blocked', async () => {
    expect(await run(['script', 'nope'])).toBe(3);
  });
});

describe('webhook', () => {
  test('lists hosts only, matches wildcards, and states there is no delivery history', async () => {
    expect(await run(['webhook', 'Deal.update'])).toBe(0);
    const res = json();
    expect(res.wouldFire.map((w) => w.name)).toEqual(['Hook A']);
    expect(res.wouldFire[0].host).toBe('hooks.example.com');
    expect(res.listeningButInactive.map((w) => w.name)).toEqual(['Hook B']);
    expect(out).not.toContain('hdr-secret');
    expect(out).not.toContain('sig=abc');
    expect(res.notes[0]).toMatch(/no delivery history/);
  });

  test('webhooks off for the account: nothing fires', async () => {
    state.prefs.integrations.webhooks.enabled = false;
    await run(['webhook', 'Deal.update']);
    expect(json().wouldFire).toEqual([]);
  });

  test('prints no preference other than the switches', async () => {
    await run(['webhook', 'Deal.update']);
    expect(out).not.toContain('do-not-print');
  });
});

describe('email', () => {
  test('summarizes without the body and explains a suppressed contact', async () => {
    expect(await run(['email', '--recipient', 'client@example.com'])).toBe(0);
    const res = json();
    expect(res.emails[0].status).toBe('failed');
    expect(res.emails[0].events).toEqual({ open: 1 });
    expect(res.emails[0].lastEvents[0].ip).toBeUndefined();
    expect(res.contact.suppressed).toBe(true);
    expect(res.notes[0]).toMatch(/bounced/);
    expect(out).not.toContain('PRIVATE BODY');
    expect(out).not.toContain('1.2.3.4');
  });

  test('needs exactly one way to find the e-mail', async () => {
    expect(await run(['email'])).toBe(2);
    expect(await run(['email', '--recipient', 'a@example.com', '--code', 'x'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('notice', () => {
  test('reads settings raw (never getMine) and walks the gates', async () => {
    expect(await run(['notice', '--user', 'sam@example.com', '--event', 'deals.onSetAsAssignee', '--actor', 'sam@example.com'])).toBe(0);
    const res = json();
    expect(paths().some((p) => /getmine/i.test(p))).toBe(false);
    expect(calls.find((c) => c.path === '/v2/eventsubscription').xq).toEqual({ user: SELLER });
    expect(res.gates.find((g) => /did not cause/.test(g.gate)).ok).toBe(false);
    expect(res.channels.email).toMatch(/only from production/);
    expect(res.channels.ultramsg).toBe('on: WhatsApp is sent');
    expect(out).not.toContain('+570000000');
  });

  test('a seller asking about itself gets its own data; settings listed as forbidden', async () => {
    expect(await run(['notice', '--user', 'sam@example.com', '--event', 'deals.onSetAsAssignee', '--profile', 'vendedor'])).toBe(0);
    const res = json();
    expect(res.user._id).toBe(SELLER);
    expect(res.forbidden.map((f) => f.read)).toEqual(['notice settings']);
    expect(calls.filter((c) => c.path === '/v2/eventsubscription')).toHaveLength(1);
  });
});

describe('login', () => {
  test('keeps only the asked e-mail and masks IPs', async () => {
    expect(await run(['login', 'sam@example.com'])).toBe(0);
    const res = json();
    expect(res.rows).toHaveLength(2);
    expect(res.summary.reasons).toEqual({ 'Invalid credentials': 1 });
    expect(res.rows[0].ip).toBe('190.x.x.x');
    expect(out).not.toContain('8.8.8.8');
    expect(res.notes[0]).toMatch(/MFA/);
  });

  test('a non-admin asking about someone else gets no rows and no sign-in read', async () => {
    expect(await run(['login', 'other@example.com', '--profile', 'vendedor'])).toBe(0);
    expect(json().rows).toEqual([]);
    expect(paths()).not.toContain('/v2/loginactivity');
  });
});

describe('helpers', () => {
  test('dropSecrets removes secret keys at any depth', () => {
    expect(dg.dropSecrets({ a: 1, Password: 'x', h: { headers: [1], apiKey: 'k', ok: [{ token: 't', v: 2 }] } })).toEqual({ a: 1, h: { ok: [{ v: 2 }] } });
  });

  test('windowOf rejects reversed or malformed dates', () => {
    expect(() => dg.windowOf({ from: '2026-11-03', to: '2026-11-01' }, 0)).toThrow(/before/);
    expect(() => dg.windowOf({ from: 'yesterday' }, 0)).toThrow(/ISO/);
    const w = dg.windowOf({ to: '2026-11-03' }, 24 * 3600 * 1000);
    expect(w.to.toISOString()).toBe('2026-11-03T23:59:59.999Z');
  });
});
