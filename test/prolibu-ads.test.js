/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ads = require('../.claude/skills/prolibu-ads/scripts/ads');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-987654';
const ME = 'a'.repeat(24);
const SELLER = 'b'.repeat(24);
const OFF_USER = 'c'.repeat(24);
const GROUP = 'd'.repeat(24);
const POOL = 'e'.repeat(24);
const EMPTY_GROUP = 'f'.repeat(24);
const HUB = '1'.repeat(24);
const BRIDGE = '2'.repeat(24);
const FORM = '3'.repeat(24);
const AD1 = '4'.repeat(24);
const AD2 = '5'.repeat(24);
const CONTACT = '6'.repeat(24);
const STAGE_NEW = '7'.repeat(24);
const STAGE_QUAL = '8'.repeat(24);
const CRED = '9'.repeat(24);
const PAGE_TOKEN = 'page-token-should-never-print';

let rootDir;
let calls;
let state;
let seq;
let forbid;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v === null || v === undefined ? null : String(v));
const newId = () => `0${String(seq++).padStart(23, '0')}`;

function getPath(record, key) {
  return key.split('.').reduce((o, k) => {
    if (Array.isArray(o)) return o.map((x) => (x && typeof x === 'object' ? x[k] : undefined));
    return o && typeof o === 'object' ? o[k] : undefined;
  }, record);
}

function cond(field, v) {
  if (v === null) return field === null || field === undefined;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v).every(([op, arg]) => {
      if (op === '$exists') return (field !== undefined && field !== null) === arg;
      if (op === '$ne') return idOf(field) !== (arg === null ? null : String(arg));
      if (op === '$in') return [].concat(field ?? []).some((f) => arg.map(String).includes(idOf(f)));
      if (op === '$regex') return new RegExp(arg.replace(/^\(\?i\)/, ''), 'i').test(String(field || ''));
      if (op === '$gte') return String(field) >= arg;
      if (op === '$lt') return String(field) < arg;
      return true;
    });
  }
  if (Array.isArray(field)) return field.map(idOf).includes(String(v));
  return idOf(field) === String(v);
}

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    if (k === '$and') return v.every((q) => matches(record, q));
    if (k === '$or') return v.some((q) => matches(record, q));
    return cond(getPath(record, k), v);
  });
}

const PLAIN_PARAMS = ['adHub', 'pageId', 'provider', 'formId', 'form', 'contact', 'email', 'assignmentGroup', 'type'];

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: init.headers.Authorization });
  const [, , object, id] = u.pathname.split('/');
  if (forbid && forbid(init.method, u.pathname, init.headers.Authorization)) {
    return respond(403, { statusCode: 403, error: `Forbidden. User has no permission on ${object}.` });
  }
  if (u.pathname === '/v2/user/me') return respond(200, { profile: { _id: ME, email: 'me@example.com', apiKey: KEY, locale: {} } });
  if (u.pathname === '/v2/user/preferences') return respond(200, { modules: { directory: { contacts: { submissions: { enabled: state.enabled } } } } });
  const coll = state[object];
  if (!coll) return respond(404, { error: 'not found' });
  if (init.method === 'GET') {
    if (id) {
      const r = coll.find((x) => x._id === id);
      return r ? respond(200, r) : respond(404, { error: 'not found' });
    }
    const xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    PLAIN_PARAMS.forEach((p) => {
      if (u.searchParams.has(p)) xquery[p] = u.searchParams.get(p);
    });
    const limit = Number(u.searchParams.get('limit') || 20);
    const page = Number(u.searchParams.get('page') || 1);
    let rows = coll.filter((r) => matches(r, xquery));
    const sort = u.searchParams.get('sort');
    if (sort) {
      const key = sort.replace(/^-/, '');
      rows = [...rows].sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : 1) * (sort.startsWith('-') ? -1 : 1));
    }
    const lastPage = Math.max(1, Math.ceil(rows.length / limit));
    return respond(200, { pagination: { count: rows.length, page, lastPage }, data: rows.slice((page - 1) * limit, page * limit) });
  }
  if (init.method === 'POST') {
    const rec = { _id: newId(), ...body, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: `N${seq++}` };
    coll.push(rec);
    return respond(200, rec);
  }
  if (init.method === 'PATCH') {
    const rec = coll.find((x) => x._id === id);
    if (!rec) return respond(404, { error: 'not found' });
    Object.entries(body).forEach(([k, v]) => {
      if (v === null) delete rec[k];
      else rec[k] = v;
    });
    rec.updatedAt = `U${seq++}`;
    return respond(200, rec);
  }
  return respond(405, { error: 'unexpected' });
}

let stdout;
let stderr;
async function run(args, opts = {}) {
  stdout = '';
  stderr = '';
  const code = await ads.main([args[0], D, ...args.slice(1)], {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } }, ...opts,
  });
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Errors go to stderr.
  }
  return { code, json };
}

async function preview(plan) {
  return run(['preview', JSON.stringify(plan)]);
}

async function previewThenApply(plan, extra = []) {
  const p = await preview(plan);
  expect(p.code).toBe(0);
  calls = [];
  return run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed', ...extra]);
}

const writes = () => calls.filter((c) => c.method !== 'GET');

function submission(over) {
  return {
    _id: newId(),
    contact: CONTACT,
    sequence: 1,
    createdAt: '2026-10-10T15:00:00.000Z',
    adCampaign: AD1,
    refId: '1234567890',
    adCampaignMeta: {
      provider: 'Meta', source: 'Facebook', pageId: '111', pageName: 'Main page', formId: '9001', formName: 'Test drive',
      campaignId: '7001', campaignName: 'Spring', adCampaignCode: '8001', adCampaignName: 'Video A', accountTimezone: 'America/Bogota',
    },
    ...over,
  };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.vendedor.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  seq = 0;
  forbid = null;
  state = {
    enabled: true,
    user: [
      { _id: ME, email: 'me@example.com', firstName: 'Me', status: 'Active' },
      { _id: SELLER, email: 'seller@example.com', firstName: 'Sel', lastName: 'Ler', status: 'Active' },
      { _id: OFF_USER, email: 'gone@example.com', firstName: 'Gone', status: 'Inactive' },
    ],
    usergroup: [
      { _id: GROUP, userGroupCode: 'UGP-1', userGroupName: 'Inbound team', userGroupType: 'Contact Assignment', enableLoadBalancing: true, users: [OFF_USER, SELLER, ME], updatedAt: 'G1' },
      { _id: POOL, userGroupCode: 'UGP-2', userGroupName: 'Pool team', userGroupType: 'Contact Assignment', users: [ME], updatedAt: 'G2' },
      { _id: EMPTY_GROUP, userGroupCode: 'UGP-3', userGroupName: 'Nobody', userGroupType: 'Contact Assignment', enableLoadBalancing: true, users: [], updatedAt: 'G3' },
    ],
    adhub: [{
      _id: HUB, adHubCode: 'ADH-1', adHubName: 'Main Meta', adProvider: 'Meta', state: 'Connected', active: true, workspace: null,
      details: [{ pageId: '111', pageName: 'Main page', accessToken: PAGE_TOKEN }, { pageId: '222', pageName: 'Second page' }],
      pageWorkspaces: [], qualificationMappings: [], metaCredential: CRED, updatedAt: 'H1',
    }],
    adhubform: [{ _id: BRIDGE, adHub: HUB, provider: 'Meta', pageId: '111', pageName: 'Main page', formId: '9001', formName: 'Test drive', form: FORM, active: true, updatedAt: 'B1' }],
    form: [{
      _id: FORM, formName: 'Main page · Test drive', type: 'meta', active: true,
      formSchema: { email: { type: 'email' }, full_name: { type: 'text' }, budget: { type: 'text' } },
      mappings: [{ modelName: 'Contact', action: 'create', fieldMap: { email: 'email', budget: 'customFields.budget' } }],
      updatedAt: 'F1',
    }],
    adcampaign: [
      { _id: AD1, adCampaignCode: '8001', adCampaignName: 'Video A', createdAt: '2026-01-01', updatedAt: 'A1' },
      { _id: AD2, adCampaignCode: '8002', adCampaignName: 'Video A', assignmentGroup: POOL, createdAt: '2026-01-01', updatedAt: 'A2' },
    ],
    contactsubmission: [],
    contact: [{
      _id: CONTACT, email: 'lead@example.com', firstName: 'Lia', lastName: 'Ad', adCampaign: AD1, stage: STAGE_QUAL, createdAt: '2026-10-10T15:00:00.000Z',
      adCampaignMeta: { provider: 'Meta', pageId: '111', formId: '9001', formName: 'Test drive', campaignName: 'Spring', adCampaignName: 'Video A' },
    }],
    stage: [
      { _id: STAGE_NEW, stageCode: 'contact-new', stageName: 'New', stageType: 'Contact.stage', index: 100 },
      { _id: STAGE_QUAL, stageCode: 'contact-qualified', stageName: 'Qualified', stageType: 'Contact.stage', index: 200 },
      { _id: newId(), stageCode: 'contact-noindex', stageName: 'Loose', stageType: 'Contact.stage' },
    ],
    workspace: [{ _id: newId(), workspaceCode: 'colombia', workspaceName: 'Colombia', active: true }, { _id: newId(), workspaceCode: 'old', active: false }],
  };
  state.contactsubmission.push(submission());
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('pure helpers', () => {
  test('a form only routes when it maps at least one question the ingestion accepts', () => {
    const form = { mappings: [{ modelName: 'Contact', fieldMap: { a: 'assignee', b: 'stage' }, assignmentGroup: GROUP }], assignmentGroup: POOL };
    expect(ads.formConfig(form).mappedCount).toBe(0);
    expect(ads.bridgeApplies({ active: true, form: FORM }, form).applies).toBe(false);
    form.mappings[0].fieldMap.c = 'email';
    const cfg = ads.formConfig(form);
    expect(cfg).toMatchObject({ mappedCount: 1, emailMapped: true, group: GROUP, groupLevel: 'mapping' });
    expect(ads.bridgeApplies({ active: false, form: FORM }, form).applies).toBe(false);
  });

  test('zoned midnight converts a calendar day to the right instant', () => {
    expect(ads.zonedMidnight('2026-07-01', 'America/Bogota')).toBe('2026-07-01T05:00:00.000Z');
    expect(ads.zonedMidnight('2026-07-01', 'UTC')).toBe('2026-07-01T00:00:00.000Z');
    expect(ads.zonedMidnight('2026-03-29', 'Europe/Madrid')).toBe('2026-03-28T23:00:00.000Z');
    expect(() => ads.zonedMidnight('2026-02-30', 'UTC')).toThrow(/Invalid date/);
  });

  test('tally splits new contacts from re-contacts per dimension', () => {
    const rows = [submission(), submission({ sequence: 2 }), submission({ contact: 'x', adCampaignMeta: { campaignId: '7002', campaignName: 'Fall' } })];
    const t = ads.tally(rows, 'campaign');
    expect(t.total).toMatchObject({ leads: 3, newContacts: 2, recontacts: 1, uniqueContacts: 2 });
    expect(t.rows[0]).toMatchObject({ key: '7001', name: 'Spring', leads: 2, recontacts: 1, uniqueContacts: 1 });
  });

  test('plans need a known kind', () => {
    expect(() => ads.parsePlan('{"kind":"contact"}', rootDir)).toThrow(/kind/);
    expect(() => ads.parsePlan('not json', rootDir)).toThrow();
  });
});

describe('reads', () => {
  test('hubs lists pages with their last lead and never prints page details beyond id and name', async () => {
    const { code, json } = await run(['hubs']);
    expect(code).toBe(0);
    expect(stdout).not.toContain(PAGE_TOKEN);
    expect(stdout).not.toContain(KEY);
    expect(json.hubs[0].pages).toEqual([
      expect.objectContaining({ pageId: '111', forms: 1, lastLeadAt: '2026-10-10T15:00:00.000Z' }),
      expect.objectContaining({ pageId: '222', forms: 0, lastLeadAt: null }),
    ]);
    expect(json.hubs[0].conversionsCredential).toBe(true);
    expect(JSON.stringify(json)).not.toContain(CRED);
  });

  test('hubs warns when submissions are off', async () => {
    state.enabled = false;
    const { json } = await run(['hubs']);
    expect(json.note).toMatch(/OFF/);
  });

  test('forms shows the effective group and whether the ingestion applies the form', async () => {
    state.form[0].assignmentGroup = GROUP;
    const { json } = await run(['forms']);
    expect(json.forms[0]).toMatchObject({ metaFormId: '9001', mapped: '2/3', emailMapped: true, applied: true });
    expect(json.forms[0].group).toMatchObject({ id: GROUP, name: 'Inbound team', level: 'form' });
  });

  test('group shows members in order, skips inactive ones and names the next in turn', async () => {
    state.adcampaign[0].assignmentGroup = GROUP;
    const { code, json } = await run(['group', 'Inbound team']);
    expect(code).toBe(0);
    expect(json.members.map((m) => m.active)).toEqual([false, true, true]);
    expect(json.nextInTurn.email).toBe('seller@example.com');
    expect(json.usedBy.campaigns[0].code).toBe('8001');
  });

  test('report sends the date range inside $and and counts by campaign', async () => {
    state.contactsubmission.push(submission({ sequence: 2, createdAt: '2026-10-31T23:00:00.000Z' }));
    state.contactsubmission.push(submission({ createdAt: '2026-11-01T06:00:00.000Z' }));
    const { code, json } = await run(['report', '--from', '2026-10-01', '--to', '2026-10-31', '--tz', 'America/Bogota']);
    expect(code).toBe(0);
    const q = JSON.parse(calls.find((c) => c.path === '/v2/contactsubmission').query.xquery);
    expect(q.createdAt).toBeUndefined();
    expect(q.$and).toEqual([{ createdAt: { $gte: '2026-10-01T05:00:00.000Z' } }, { createdAt: { $lt: '2026-11-01T05:00:00.000Z' } }]);
    expect(json.total).toMatchObject({ leads: 2, newContacts: 1, recontacts: 1 });
    expect(json.rows[0].name).toBe('Spring');
  });

  test('report pages through every submission', async () => {
    for (let i = 0; i < 600; i += 1) state.contactsubmission.push(submission({ contact: `c${i}` }));
    const { json } = await run(['report', '--from', '2026-10-01', '--to', '2026-10-31', '--by', 'ad', '--tz', 'UTC']);
    expect(json.total.leads).toBe(601);
    expect(calls.filter((c) => c.path === '/v2/contactsubmission').length).toBe(2);
  });

  test('report refuses bad dates and dimensions without calling the server', async () => {
    expect((await run(['report', '--from', '2026-10', '--to', '2026-10-31'])).code).toBe(2);
    expect((await run(['report', '--from', '2026-10-01', '--to', '2026-10-31', '--by', 'color'])).code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('diagnose explains the route and why a stage move would not reach Meta', async () => {
    state.form[0].assignmentGroup = GROUP;
    state.adhub[0].qualificationMappings = [{ stageCode: 'contact-qualified', eventName: 'Qualified' }];
    const { code, json } = await run(['diagnose', 'lead@example.com']);
    expect(code).toBe(0);
    expect(json.routing.expectedGroupToday).toMatchObject({ from: 'form', name: 'Inbound team' });
    expect(json.metaReport).toMatchObject({ event: 'Qualified', wouldReport: true });
    expect(json.findings.join(' ')).toMatch(/No owner and no group/);
    state.contactsubmission[0].refId = undefined;
    const again = await run(['diagnose', CONTACT]);
    expect(again.json.metaReport.reasons.join(' ')).toMatch(/No Meta lead id/);
  });

  test('diagnose says so when the contact did not come from an ad', async () => {
    state.contact.push({ _id: newId(), email: 'web@example.com' });
    const { json } = await run(['diagnose', 'web@example.com']);
    expect(json.adLead).toBe(false);
  });

  test('a seller without Ad Hub access gets the partial diagnosis, not a retry', async () => {
    forbid = (method, p) => /^\/v2\/(adhub|adhubform|adcampaign|usergroup|form)/.test(p);
    const { code, json } = await run(['diagnose', 'lead@example.com', '--profile', 'vendedor']);
    expect(code).toBe(0);
    expect(json.findings.join(' ')).toMatch(/admin only/);
    expect(calls.every((c) => c.auth === `Bearer ${SELLER_KEY}`)).toBe(true);
  });

  test('a 403 on a list prints FORBIDDEN and stops', async () => {
    forbid = (method, p) => p.startsWith('/v2/adcampaign');
    const { code } = await run(['campaigns']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/FORBIDDEN/);
    expect(calls.length).toBe(1);
  });
});

describe('campaign-group plans', () => {
  test('preview resolves a Meta campaign into its ads and stops before writing', async () => {
    state.contactsubmission.push(submission({ adCampaign: AD2, adCampaignMeta: { ...submission().adCampaignMeta, adCampaignCode: '8002' } }));
    const { code, json } = await preview({ kind: 'campaign-group', metaCampaign: 'Spring', group: 'UGP-1' });
    expect(code).toBe(0);
    expect(json.changes.map((c) => c.code).sort()).toEqual(['8001', '8002']);
    expect(json.changes.find((c) => c.code === '8002').from).toMatch(/Pool team/);
    expect(json.futureRecipients).toEqual(['seller@example.com', 'me@example.com']);
    expect(json.nextStep).toMatch(/STOP HERE/);
    expect(writes()).toEqual([]);
  });

  test('apply sets the group on each ad and reads it back', async () => {
    const res = await previewThenApply({ kind: 'campaign-group', campaigns: ['8001'], group: 'Inbound team' });
    expect(res.code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: `/v2/adcampaign/${AD1}`, body: { assignmentGroup: GROUP } })]);
    expect(state.adcampaign[0].assignmentGroup).toBe(GROUP);
  });

  test('null removes the group', async () => {
    const res = await previewThenApply({ kind: 'campaign-group', campaigns: [AD2], group: null });
    expect(res.code).toBe(0);
    expect(writes()[0].body).toEqual({ assignmentGroup: null });
    expect(state.adcampaign[1].assignmentGroup).toBeUndefined();
  });

  test('register creates an ad that has not brought leads yet, with its group', async () => {
    const res = await previewThenApply({ kind: 'campaign-group', register: [{ adCampaignCode: '8099', adCampaignName: 'Video new' }], group: 'UGP-1' });
    expect(res.code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/v2/adcampaign', body: { adCampaignCode: '8099', assignmentGroup: GROUP } });
    expect(res.json.done[0].registered).toBe(true);
  });

  test('a name shared by several ads is blocked and lists them', async () => {
    const { code, json } = await preview({ kind: 'campaign-group', campaigns: ['Video A'], group: 'UGP-1' });
    expect(code).toBe(3);
    expect(json.blockers[0]).toMatch(/2 ads are named/);
  });

  test('a group without members or without active members blocks', async () => {
    expect((await preview({ kind: 'campaign-group', campaigns: ['8001'], group: 'UGP-3' })).code).toBe(3);
    state.usergroup[1].users = [OFF_USER];
    const { code, json } = await preview({ kind: 'campaign-group', campaigns: ['8001'], group: 'Pool team' });
    expect(code).toBe(3);
    expect(json.blockers[0]).toMatch(/No member/);
  });

  test('a form with its own group is reported as winning over the ad', async () => {
    state.form[0].assignmentGroup = POOL;
    const { json } = await preview({ kind: 'campaign-group', campaigns: ['8001'], group: 'UGP-1' });
    expect(json.warnings.join(' ')).toMatch(/own group, which wins/);
  });

  test('apply refuses without --confirmed, with a stale version, and after a change', async () => {
    const plan = { kind: 'campaign-group', campaigns: ['8001'], group: 'UGP-1' };
    const p = await preview(plan);
    expect((await run(['apply', JSON.stringify(plan), '--version', p.json.version])).code).toBe(2);
    expect((await run(['apply', JSON.stringify(plan), '--version', 'nope', '--confirmed'])).code).toBe(3);
    state.adcampaign[0].updatedAt = 'A9';
    calls = [];
    expect((await run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed'])).code).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('form-group plans', () => {
  test('sets the form group; a mapping group that would win is changed too', async () => {
    state.form[0].mappings[0].assignmentGroup = { _id: POOL, userGroupName: 'Pool team' };
    const res = await previewThenApply({ kind: 'form-group', form: '9001', group: 'UGP-1' });
    expect(res.code).toBe(0);
    const w = writes()[0];
    expect(w).toMatchObject({ method: 'PATCH', path: `/v2/form/${FORM}` });
    expect(w.body.assignmentGroup).toBe(GROUP);
    expect(w.body.mappings[0].assignmentGroup).toBe(GROUP);
    expect(w.body.mappings[0].fieldMap).toEqual({ email: 'email', budget: 'customFields.budget' });
  });

  test('a form that maps nothing is blocked: the platform would ignore its group', async () => {
    state.form[0].mappings[0].fieldMap = { budget: 'stage' };
    const { code, json } = await preview({ kind: 'form-group', form: BRIDGE, group: 'UGP-1' });
    expect(code).toBe(3);
    expect(json.blockers[0]).toMatch(/maps no question/);
  });

  test('a switched-off form is warned about', async () => {
    state.adhubform[0].active = false;
    const { json } = await preview({ kind: 'form-group', form: '9001', group: 'UGP-1' });
    expect(json.warnings.join(' ')).toMatch(/switched off/);
  });

  test('an unknown form is blocked before any write', async () => {
    const { code } = await preview({ kind: 'form-group', form: '12345', group: 'UGP-1' });
    expect(code).toBe(3);
    expect(writes()).toEqual([]);
  });
});

describe('hub plans', () => {
  test('qualification mappings need --reports-to-meta on top of --confirmed', async () => {
    const plan = { kind: 'hub', hub: 'ADH-1', set: { qualificationMappings: [{ stageCode: 'contact-qualified', eventName: 'Qualified Lead' }] } };
    const p = await preview(plan);
    expect(p.json.reportsToMeta).toBe(true);
    expect(p.json.nextStep).toMatch(/--reports-to-meta/);
    calls = [];
    expect((await run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed'])).code).toBe(3);
    expect(writes()).toEqual([]);
    const ok = await run(['apply', JSON.stringify(plan), '--version', p.json.version, '--confirmed', '--reports-to-meta']);
    expect(ok.code).toBe(0);
    expect(writes()[0].body).toEqual({ qualificationMappings: [{ stageCode: 'contact-qualified', eventName: 'Qualified Lead' }] });
  });

  test('unknown stages, duplicates and unconnected pages block', async () => {
    const bad = await preview({
      kind: 'hub',
      hub: 'ADH-1',
      set: {
        qualificationMappings: [{ stageCode: 'nope', eventName: 'X' }, { stageCode: 'contact-new', eventName: 'A' }, { stageCode: 'contact-new', eventName: 'B' }],
        pageWorkspaces: [{ pageId: '999', workspaceCode: 'colombia' }, { pageId: '111', workspaceCode: 'old' }],
      },
    });
    expect(bad.code).toBe(3);
    const text = bad.json.blockers.join(' ');
    expect(text).toMatch(/No contact stage/);
    expect(text).toMatch(/mapped twice/);
    expect(text).toMatch(/not connected/);
    expect(text).toMatch(/deactivated/);
  });

  test('page workspaces save without the Meta flag and read back', async () => {
    const res = await previewThenApply({ kind: 'hub', hub: HUB, set: { pageWorkspaces: [{ pageId: '222', workspaceCode: 'colombia' }] } });
    expect(res.code).toBe(0);
    expect(state.adhub[0].pageWorkspaces).toEqual([{ pageId: '222', workspaceCode: 'colombia', pageName: 'Second page' }]);
  });

  test('credentials, pages and on/off are refused as usage errors', async () => {
    const { code } = await preview({ kind: 'hub', hub: 'ADH-1', set: { metaCredential: CRED } });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('submissions off blocks any Ad Hub write', async () => {
    state.enabled = false;
    const { code } = await preview({ kind: 'hub', hub: 'ADH-1', set: { pageWorkspaces: [] } });
    expect(code).toBe(3);
  });
});
