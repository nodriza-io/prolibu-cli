/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const messaging = require('../.claude/skills/prolibu-messaging/scripts/messaging');

const D = 'dev99.example.com';
const ME = '1'.repeat(24);
const OTHER_USER = '2'.repeat(24);
const C1 = 'a'.repeat(24);
const C2 = 'b'.repeat(24);
const C_ME = 'c'.repeat(24);
const C_GONE = 'd'.repeat(24);
const LIST = 'e'.repeat(24);
const TPL = 'f'.repeat(24);
const TPL_BLOCKS = '3'.repeat(24);
const TPL_WA = '4'.repeat(24);
const CAMP = '5'.repeat(24);
const NEW_ID = '6'.repeat(24);

const SCHEMAS = {
  Contact: {
    firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string' },
    company: { type: 'objectid', ref: 'Company' }, address: { city: { type: 'string' } },
    tags: { type: ['objectid'], ref: 'Tag' }, phones: { type: ['mixed'] },
  },
  Company: { companyName: { type: 'string' }, assignee: { type: 'objectid', ref: 'User' } },
  User: { firstName: { type: 'string' }, lastName: { type: 'string' }, jobTitle: { type: 'string' }, company: { type: 'objectid', ref: 'Company' } },
};

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

// A small fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const p = u.pathname;
  const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
  if (init.method === 'GET' && p === '/v2/user/me') {
    return respond(200, { profile: { _id: ME, email: 'me@example.com', firstName: 'Mia', lastName: 'Lead' }, modelSchemas: SCHEMAS });
  }
  if (init.method === 'GET' && p === '/v2/contact') {
    let rows = Object.values(state.contacts);
    if (xq._id) rows = rows.filter((c) => xq._id.$in.includes(c._id));
    if (xq.email) rows = rows.filter((c) => c.email === xq.email);
    return respond(200, { data: rows, pagination: { count: rows.length, lastPage: 1 } });
  }
  const contactMatch = /^\/v2\/contact\/(\w+)$/.exec(p);
  if (init.method === 'GET' && contactMatch) {
    const c = state.contacts[contactMatch[1]];
    return c ? respond(200, { ...c, company: c.company ? { _id: 'co1', companyName: 'Acme & Co' } : null }) : respond(404, { error: 'Not found' });
  }
  const crud = /^\/v2\/(contactlist|messagetemplate|emailcampaign)(?:\/(\w+))?$/.exec(p);
  if (crud && !['sendCampaign', 'pauseCampaign'].includes(crud[2])) {
    const store = state[crud[1]];
    if (init.method === 'GET' && crud[2]) return store[crud[2]] ? respond(200, store[crud[2]]) : respond(404, { error: 'Not found' });
    if (init.method === 'POST') {
      if (crud[1] === 'emailcampaign' && state.noMailbox) return respond(400, { error: 'No email provider found to send the email' });
      store[NEW_ID] = { _id: NEW_ID, createdBy: ME, updatedAt: 'T1', ...(crud[1] === 'emailcampaign' ? { status: 'Paused', from: 'me@example.com' } : {}), ...body };
      if (crud[1] === 'emailcampaign') store[NEW_ID].contacts = body.contacts.filter((id) => state.contacts[id]);
      return respond(201, store[NEW_ID]);
    }
    if (init.method === 'PATCH') {
      store[crud[2]] = { ...store[crud[2]], ...body, updatedAt: 'T9' };
      return respond(200, store[crud[2]]);
    }
  }
  if (init.method === 'GET' && p === '/v2/email') {
    const rows = state.emails.filter((e) => e.emailCampaign === xq.emailCampaign && (!xq.contact || e.contact === xq.contact));
    return respond(200, { data: rows, pagination: { count: rows.length, lastPage: 1 } });
  }
  if (init.method === 'GET' && /^\/v2\/email\/\w+$/.test(p)) return respond(200, { status: 'sent', to: 'me@example.com' });
  if (init.method === 'PUT' && p === '/v2/emailcampaign/sendCampaign') {
    const camp = state.emailcampaign[body.emailCampaignId];
    if (body.testMode) return respond(200, { _id: 'em1', status: 'sent', to: state.contacts[camp.testContact].email });
    camp.status = 'Sending';
    return respond(200, camp);
  }
  if (init.method === 'PUT' && p === '/v2/emailcampaign/pauseCampaign') {
    state.emailcampaign[body.emailCampaignId].status = 'Paused';
    return respond(200, {});
  }
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

const run = (argv) => messaging.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const sendPut = () => calls.filter((c) => c.method === 'PUT' && c.path === '/v2/emailcampaign/sendCampaign');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-messaging-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    contacts: {
      [C1]: { _id: C1, firstName: 'Ana', email: 'ana@example.com', company: 'co1', emailStatus: { state: 'subscribed' }, consent: { state: 'accepted' } },
      [C2]: { _id: C2, firstName: 'Bo', email: 'bo@example.com', emailStatus: { state: 'unsubscribed' }, consent: { state: 'pending' } },
      [C_ME]: { _id: C_ME, firstName: 'Mia', email: 'me@example.com', emailStatus: { state: 'subscribed' }, consent: { state: 'pending' } },
    },
    contactlist: { [LIST]: { _id: LIST, contactListName: 'Clients', contacts: [C1, C2], updatedAt: 'L1' } },
    messagetemplate: {
      [TPL]: { _id: TPL, messageTemplateName: 'Welcome', modelName: 'Email', subject: 'Hi {{contact.firstName}}', content: '<p>Hello {{contact.firstName}} from {{me.firstName}}</p>', updatedAt: 'M1' },
      [TPL_BLOCKS]: { _id: TPL_BLOCKS, messageTemplateName: 'Blocks', modelName: 'Email', subject: 'News', content: '<html>{{contact.firstName}}</html>', design: { format: 'blocks', doc: {} }, updatedAt: 'M2' },
      [TPL_WA]: { _id: TPL_WA, messageTemplateName: 'WA', modelName: 'Message', content: 'Hi {{1}} there', updatedAt: 'M3' },
    },
    emailcampaign: {
      [CAMP]: {
        _id: CAMP, emailCampaignName: 'Nov', status: 'Paused', provider: 'google', from: 'me@example.com', createdBy: ME,
        subject: 'Hi {{contact.firstName}}', message: '<p>Hello {{contact.firstName}}</p>', contacts: [C1, C2], updatedAt: 'K1',
      },
    },
    emails: [],
  };
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('template engine (same rules as the server message engine)', () => {
  const ctx = { contact: { firstName: 'Ana <b>', company: { companyName: 'A&B' }, at: '2026-11-05T23:30:00Z', amount: 1234.5 } };

  test('escapes {{x}} like Handlebars and leaves {{{x}}} raw', () => {
    expect(messaging.processTemplate('{{contact.firstName}}|{{{contact.firstName}}}', ctx).output).toBe('Ana &lt;b&gt;|Ana <b>');
    expect(messaging.processTemplate('{{contact.company.companyName}}', ctx).output).toBe('A&amp;B');
  });

  test('implements the five helpers with the server semantics', () => {
    const r = messaging.processTemplate('{{default contact.lastName "friend"}} {{uppercase contact.firstName}} {{shortDate contact.at "DD/MM/YYYY HH:mm"}} {{toCurrency contact.amount "USD"}}', ctx);
    expect(r.output).toBe('friend ANA &lt;B&gt; 05/11/2026 23:30 $1,234.50');
    expect(r.errors).toEqual([]);
  });

  test('a helper the engine does not have is an error (the server refuses to save it)', () => {
    expect(messaging.processTemplate('{{capitalize contact.firstName}}', ctx).errors[0]).toMatch(/Missing helper: "capitalize"/);
  });

  test('unbalanced blocks and unclosed mustaches are errors; blocks are approximate', () => {
    expect(messaging.processTemplate('{{#if contact.firstName}}hi', ctx).errors[0]).toMatch(/Unclosed block/);
    expect(messaging.processTemplate('{{contact.firstName', ctx).errors[0]).toMatch(/Unclosed/);
    const r = messaging.processTemplate('{{#if contact.firstName}}hi{{/if}}', ctx);
    expect(r.errors).toEqual([]);
    expect(r.approximate).toBe(true);
  });

  test('a path that ends on a record prints [object Object], like the real e-mail', () => {
    expect(messaging.processTemplate('{{contact.company}}', ctx).output).toBe('[object Object]');
  });
});

describe('variable lint (what a campaign e-mail can fill)', () => {
  const lint = (paths, extra) => messaging.lintPaths(paths, { schemas: SCHEMAS, ...extra });

  test('flags bare fields, unknown roots, typos and paths that end on a record', () => {
    const { warnings } = lint(['firstName', 'deal.dealName', 'contact.firstname', 'contact.company', 'contact.company.companyName', 'me.jobTitle', 'contact.address.city']);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toMatch(/write \{\{contact\.firstName\}\}/);
    expect(warnings[1]).toMatch(/only knows contact, me/);
    expect(warnings[2]).toMatch(/no field "firstname"/);
    expect(warnings[3]).toMatch(/\[object Object\]/);
  });

  test('consent and presentation tags block a campaign that does not feed them', () => {
    expect(lint(['consentAcceptUrl'], { campaign: {} }).blockers[0]).toMatch(/consent-request/);
    expect(lint(['presentationUrl'], { campaign: {} }).blockers[0]).toMatch(/presentation/);
    expect(lint(['consentAcceptUrl'], { campaign: { consentRequest: true } }).blockers).toEqual([]);
  });

  test('variables must exist on the campaign', () => {
    expect(lint(['variables.promo'], { variables: {} }).warnings[0]).toMatch(/no variable "promo"/);
    expect(lint(['variables.promo'], { variables: { promo: 'X' } }).warnings).toEqual([]);
  });

  test('builds a nested populate like the server does', () => {
    expect(messaging.populateTree(['contact.company.companyName', 'contact.company.assignee.firstName'], SCHEMAS, 'contact', 'Contact')).toEqual([
      { path: 'company', select: 'companyName assignee', populate: [{ path: 'assignee', select: 'firstName' }] },
    ]);
  });
});

describe('plans', () => {
  test('a plan names exactly one object and no unsupported field', () => {
    expect(() => messaging.readPlan('{"template":{},"list":{}}', rootDir)).toThrow(/exactly one/);
    expect(() => messaging.readPlan('{"campaign":{"name":"x","sequence":"' + C1 + '"}}', rootDir)).toThrow(/not supported/);
    expect(() => messaging.readPlan('{"list":{"add":["nope"]}}', rootDir)).toThrow(/array of ids/);
  });

  test('apply refuses without --version or --confirmed and sends nothing', async () => {
    const plan = JSON.stringify({ list: { id: LIST, add: [C_ME] } });
    expect(await run(['apply', D, plan, '--confirmed'])).toBe(2);
    expect(await run(['apply', D, plan, '--version', 'v'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('contact lists', () => {
  test('adding keeps every existing contact: the PATCH carries the whole array', async () => {
    const plan = JSON.stringify({ list: { id: LIST, add: [C_ME], remove: [C2] } });
    expect(await run(['preview', D, plan])).toBe(0);
    const { version, added, removed } = json();
    expect([added, removed]).toEqual([1, 1]);
    out = '';
    expect(await run(['apply', D, plan, '--version', version, '--confirmed'])).toBe(0);
    const patch = writes().find((c) => c.method === 'PATCH');
    expect(patch.body.contacts).toEqual([C1, C_ME]);
    expect(json().saved).toBe(true);
  });

  test('a contact id that does not exist blocks the save (the server would keep it)', async () => {
    expect(await run(['preview', D, JSON.stringify({ list: { id: LIST, add: [C_GONE] } })])).toBe(3);
    expect(json().blockers[0]).toMatch(/do not exist/);
  });

  test('counts who would really get an e-mail', async () => {
    await run(['show', D, 'list', LIST]);
    const r = json().recipients;
    expect([r.contacts, r.unsubscribed, r.willReceive, r.consent.accepted]).toEqual([2, 1, 1, 1]);
  });
});

describe('templates', () => {
  test('a new template is an Email template and renders for a sample contact', async () => {
    const plan = JSON.stringify({ template: { name: 'T', subject: 'Hi {{contact.firstName}}', content: '<p>{{contact.company.companyName}} / {{me.jobTitle}}</p>' } });
    expect(await run(['preview', D, plan, '--sample', C1])).toBe(0);
    const r = json();
    expect(r.changes.find((c) => c.field === 'modelName').after).toBe('Email');
    expect(r.sample.subject).toBe('Hi Ana');
    expect(r.sample.text).toBe('Acme &amp; Co / [me.jobTitle]');
    expect(r.sample.notPreviewed).toEqual(['me.jobTitle']);
    const populate = calls.find((c) => c.path === `/v2/contact/${C1}`).query.populatePath;
    expect(JSON.parse(populate)).toEqual([{ path: 'company', select: 'companyName' }]);
  });

  test('an invalid template is blocked before the server sees it', async () => {
    expect(await run(['preview', D, JSON.stringify({ template: { name: 'T', content: '{{capitalize contact.firstName}}' } })])).toBe(3);
    expect(writes()).toEqual([]);
  });

  test('WhatsApp templates and block-editor content are left to the app', async () => {
    expect(await run(['preview', D, JSON.stringify({ template: { id: TPL_WA, name: 'x' } })])).toBe(3);
    expect(json().blockers[0]).toMatch(/WhatsApp/);
    out = '';
    expect(await run(['preview', D, JSON.stringify({ template: { id: TPL_BLOCKS, content: '<p>x</p>' } })])).toBe(3);
    expect(json().blockers[0]).toMatch(/block editor/);
    out = '';
    expect(await run(['preview', D, JSON.stringify({ template: { id: TPL_BLOCKS, subject: 'New subject' } })])).toBe(0);
  });
});

describe('campaign drafts', () => {
  test('a new campaign copies the template and the list, and saving sends nothing', async () => {
    const plan = JSON.stringify({ campaign: { name: 'Nov', provider: 'google', templateId: TPL, listIds: [LIST], addContacts: [C1], variables: { promo: 'X' } } });
    expect(await run(['preview', D, plan])).toBe(0);
    const { version, recipients } = json();
    expect(recipients.contacts).toBe(2);
    out = '';
    expect(await run(['apply', D, plan, '--version', version, '--confirmed'])).toBe(0);
    const post = writes().find((c) => c.method === 'POST');
    expect(post.path).toBe('/v2/emailcampaign');
    expect(post.body.subject).toBe(state.messagetemplate[TPL].subject);
    expect(post.body.message).toBe(state.messagetemplate[TPL].content);
    expect(post.body.contacts).toEqual([C1, C2]);
    expect(post.body.variables).toEqual([{ promo: 'X' }]);
    expect(sendPut()).toEqual([]);
    expect(json()).toMatchObject({ saved: true, status: 'Paused', sent: false });
  });

  test('a block template is copied with the marker the app uses to recognize it', async () => {
    await run(['preview', D, JSON.stringify({ campaign: { name: 'B', provider: 'google', templateId: TPL_BLOCKS } })]);
    expect(json().changes.find((c) => c.field === 'message').after.startsWith(`<!-- pl-blocks-template:${TPL_BLOCKS} -->\n`)).toBe(true);
  });

  test('a launched campaign cannot change', async () => {
    state.emailcampaign[CAMP].status = 'Sending';
    expect(await run(['preview', D, JSON.stringify({ campaign: { id: CAMP, name: 'Other' } })])).toBe(3);
    expect(json().blockers[0]).toMatch(/Sending/);
  });

  test('a missing mailbox explains itself', async () => {
    state.noMailbox = true;
    const plan = JSON.stringify({ campaign: { name: 'Nov', provider: 'google', templateId: TPL } });
    await run(['preview', D, plan]);
    const { version } = json();
    expect(await run(['apply', D, plan, '--version', version, '--confirmed'])).toBe(1);
    expect(err).toMatch(/connect Google or Microsoft/);
  });
});

describe('sending', () => {
  test('send refuses without --confirmed-send, even with --confirmed, and calls nothing', async () => {
    expect(await run(['send', D, CAMP, '--send-version', 'v', '--confirmed'])).toBe(2);
    expect(await run(['send', D, CAMP, '--send-version', 'v'])).toBe(2);
    expect(await run(['send', D, CAMP, '--confirmed-send'])).toBe(2);
    expect(calls).toEqual([]);
  });

  test('a test goes to the user\'s own contact by default and sets it as the test contact', async () => {
    expect(await run(['send-preview', D, CAMP])).toBe(0);
    const preview = json();
    expect(preview.sendsTo).toEqual({ contactId: C_ME, email: 'me@example.com', ownAddress: true });
    expect(preview.emails).toBe(1);
    out = '';
    expect(await run(['send', D, CAMP, '--send-version', preview.sendVersion, '--confirmed-send'])).toBe(0);
    const ws = writes();
    expect(ws[0]).toMatchObject({ method: 'PATCH', body: { testContact: C_ME } });
    expect(ws[1]).toMatchObject({ method: 'PUT', body: { emailCampaignId: CAMP, testMode: true } });
    expect(json()).toMatchObject({ sent: true, mode: 'test' });
  });

  test('a second test to the same contact is blocked (one e-mail per contact per campaign)', async () => {
    state.emails.push({ emailCampaign: CAMP, contact: C_ME, status: 'sent' });
    expect(await run(['send-preview', D, CAMP])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/one per contact per campaign/);
  });

  test('a live send needs --live, its own version and the exact number of recipients', async () => {
    expect(await run(['send-preview', D, CAMP, '--live'])).toBe(0);
    const { sendVersion, recipients, willReceive } = json();
    expect([recipients, willReceive]).toEqual([2, 1]);
    out = '';
    expect(await run(['send', D, CAMP, '--send-version', sendVersion, '--confirmed-send', '--live', '--recipients', '5'])).toBe(2);
    expect(sendPut()).toEqual([]);
    expect(await run(['send', D, CAMP, '--send-version', 'stale', '--confirmed-send', '--live', '--recipients', '2'])).toBe(3);
    expect(sendPut()).toEqual([]);
    // A test version is not a live version.
    out = '';
    await run(['send-preview', D, CAMP]);
    const testVersion = json().sendVersion;
    expect(await run(['send', D, CAMP, '--send-version', testVersion, '--confirmed-send', '--live', '--recipients', '2'])).toBe(3);
    out = '';
    expect(await run(['send', D, CAMP, '--send-version', sendVersion, '--confirmed-send', '--live', '--recipients', '2'])).toBe(0);
    expect(sendPut()).toHaveLength(1);
    expect(sendPut()[0].body).toEqual({ emailCampaignId: CAMP, testMode: false });
    expect(json()).toMatchObject({ sent: true, mode: 'live', status: 'Sending' });
  });

  test('only the creator, assignee or a collaborator may send', async () => {
    state.emailcampaign[CAMP].createdBy = OTHER_USER;
    expect(await run(['send-preview', D, CAMP, '--live'])).toBe(3);
    expect(json().blockers[0]).toMatch(/creator/);
  });

  test('show campaign explains each failure and lints the copied message', async () => {
    state.emailcampaign[CAMP].message = '<p>Hola {{firstName}}</p>';
    state.emails.push(
      { emailCampaign: CAMP, contact: C1, status: 'sent' },
      { emailCampaign: CAMP, contact: C2, status: 'failed', error: 'Recipient suppressed' },
    );
    expect(await run(['show', D, 'campaign', CAMP])).toBe(0);
    const r = json();
    expect(r.delivery).toMatchObject({ sent: 1, failed: 1, failedReasons: { 'Recipient suppressed': 1 } });
    expect(r.warnings.join(' ')).toMatch(/write \{\{contact\.firstName\}\}/);
  });

  test('contacts reads one contact by id', async () => {
    expect(await run(['contacts', D, C1])).toBe(0);
    expect(json().contacts[0]).toMatchObject({ id: C1, email: 'ana@example.com', consent: 'accepted' });
  });

  test('pause needs --confirmed', async () => {
    state.emailcampaign[CAMP].status = 'Sending';
    expect(await run(['pause', D, CAMP])).toBe(2);
    expect(await run(['pause', D, CAMP, '--confirmed'])).toBe(0);
    expect(json().paused).toBe(true);
  });

  test('never prints the API key', async () => {
    await run(['send-preview', D, CAMP, '--live']);
    expect(out + err).not.toMatch(/SECRET123/);
  });
});
