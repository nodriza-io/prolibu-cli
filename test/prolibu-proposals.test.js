/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const proposal = require('../.claude/skills/prolibu-proposals/scripts/proposal');

const D = 'dev99.example.com';
const DEAL = 'a'.repeat(24);
const STAGE = 'b'.repeat(24);
const LAYOUT = 'c'.repeat(24);
const SNIPPET = 'd'.repeat(24);
const CONTACT = 'e'.repeat(24);
const REVIEWER = 'f'.repeat(24);
const VERSION = '1'.repeat(24);
const OTHER_VERSION = '2'.repeat(24);
const TEMPLATE = '3'.repeat(24);
const CONTRACT = '4'.repeat(24);

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
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const p = u.pathname;
  if (state.networkErrorOn === `${init.method} ${p}`) {
    state.contracts.push({ _id: CONTRACT, contractName: 'Late', status: 'Draft', signers: [CONTACT], updatedAt: new Date().toISOString() });
    throw new TypeError('fetch failed');
  }
  if (init.method === 'GET' && p === `/v2/deal/${DEAL}`) return respond(200, state.deal);
  if (init.method === 'GET' && p === `/v2/stage/${STAGE}`) return respond(200, state.stage);
  if (init.method === 'GET' && p === '/v2/user/preferences') return respond(200, { modules: { sales: { deals: state.prefs } } });
  if (init.method === 'GET' && p.startsWith('/v2/contact/')) {
    const c = state.contacts[p.split('/').pop()];
    return c ? respond(200, c) : respond(404, { error: 'Not found.' });
  }
  if (init.method === 'GET' && p === `/v2/contenttemplate/${LAYOUT}`) return respond(200, { _id: LAYOUT, contentTemplateName: 'Letter', templateType: 'layout', active: true, taxonomy: { language: 'es' } });
  if (init.method === 'GET' && p === `/v2/contenttemplate/${SNIPPET}`) return respond(200, { _id: SNIPPET, contentTemplateName: 'Snip', templateType: 'snippet', active: true });
  if (init.method === 'PATCH' && p === `/v2/deal/${DEAL}`) {
    if (body.proposal) {
      const next = { ...state.deal.proposal, ...body.proposal };
      if (body.proposal.template) next.template = { ...state.deal.proposal.template, ...body.proposal.template };
      state.deal = { ...state.deal, proposal: next, updatedAt: 'T2' };
    }
    if (body.proposalVersions && body.proposalVersions.restorationPoint) {
      state.deal = { ...state.deal, proposal: state.versions[body.proposalVersions.restorationPoint].proposalData, updatedAt: 'T3' };
    }
    return respond(200, state.deal);
  }
  if (init.method === 'POST' && p === '/v2/proposalversion/createRestorationPoint') {
    const id = `${'9'.repeat(22)}${String(state.newVersions).padStart(2, '0')}`;
    state.newVersions += 1;
    state.versions[id] = { dealSource: DEAL, proposalData: body.proposalData };
    state.deal.proposalVersions.refs.push(id);
    state.deal.proposalVersions.details.push({ id, versionName: body.versionName, visibleToClient: body.visibleToClient });
    state.deal.updatedAt = `T-v${id}`;
    return respond(200, { details: state.deal.proposalVersions.details });
  }
  if (init.method === 'GET' && p.startsWith('/v2/proposalversion/')) {
    const v = state.versions[p.split('/').pop()];
    return v ? respond(200, v) : respond(404, { error: 'Not found.' });
  }
  if (init.method === 'GET' && p === '/v2/contract') return respond(200, { data: state.contracts, pagination: { count: state.contracts.length } });
  if (init.method === 'GET' && p === `/v2/contract/${TEMPLATE}`) return respond(200, state.template);
  if (init.method === 'POST' && p === '/v2/contract/generateFromDeal') {
    if (state.generateExisting) return respond(200, { _id: CONTRACT, contractName: 'Old', status: 'Ready', existing: true });
    state.contract = {
      _id: CONTRACT, contractName: 'Deal - Contract', status: body.status === 'Draft' && !state.forceReady ? 'Draft' : 'Ready',
      contractDocuments: ['file1'], signers: body.signerContactIds,
      signerEvidences: Object.fromEntries(body.signerContactIds.map((id) => [id, { role: 'signer', email: 'x@example.com' }])),
      contractFields: { full_name: 'Ana', amount: '' }, contractEditor: '<p>Ana</p>', options: { reject: { allow: true } }, updatedAt: 'C1',
    };
    return respond(200, { ...state.contract, signingUrl: 'https://x/sign' });
  }
  if (init.method === 'GET' && p === `/v2/contract/${CONTRACT}`) {
    const c = state.contract;
    if (state.turnReadyAfterReads !== undefined) {
      state.turnReadyAfterReads -= 1;
      if (state.turnReadyAfterReads < 0) c.status = 'Ready';
    }
    return respond(200, c);
  }
  if (init.method === 'PATCH' && p === `/v2/contract/${CONTRACT}`) {
    const c = state.contract;
    if (body.options) c.options = { ...c.options, ...body.options };
    if (body.contractName) c.contractName = body.contractName;
    if (body.signers) c.signers = body.signers;
    if (body.signerEvidences) c.signerEvidences = body.signerEvidences;
    c.updatedAt = 'C2';
    return respond(200, c);
  }
  if (init.method === 'POST' && p === '/v2/contract') {
    state.created = { _id: '5'.repeat(24), ...body, updatedAt: 'N1' };
    return respond(201, state.created);
  }
  if (init.method === 'GET' && p === `/v2/contract/${'5'.repeat(24)}`) return respond(200, state.created);
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

const run = (argv) => proposal.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const plan = (p) => JSON.stringify(p);

async function previewThenApply(p) {
  out = '';
  expect(await run(['preview', D, plan(p)])).toBe(0);
  const { version } = JSON.parse(out);
  out = '';
  const code = await run(['apply', D, plan(p), '--version', version, '--confirmed']);
  return { code, result: out ? JSON.parse(out) : null };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-proposals-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    prefs: { stageRules: { allowEditInEndFlowStages: false } },
    stage: { _id: STAGE, stageName: 'Proposal', endFlowStage: false },
    deal: {
      _id: DEAL, dealName: 'Acme', stage: STAGE, contact: CONTACT, updatedAt: 'T1',
      proposal: { enabled: false, template: { assets: [] } },
      proposalVersions: { refs: [VERSION], details: [{ id: null, latestVersion: true, versionName: 'Latest', visibleToClient: true }, { id: VERSION, versionName: 'v1' }] },
    },
    versions: {
      [VERSION]: { dealSource: DEAL, proposalData: { enabled: true, title: 'Old title', template: { layout: LAYOUT } } },
      [OTHER_VERSION]: { dealSource: 'z'.repeat(24), proposalData: { enabled: true, title: 'x' } },
    },
    newVersions: 0,
    contacts: {
      [CONTACT]: { _id: CONTACT, firstName: 'Ana', email: 'ana@example.com' },
      [REVIEWER]: { _id: REVIEWER, firstName: 'Rev', email: 'rev@example.com' },
    },
    contracts: [],
    template: { _id: TEMPLATE, contractName: 'Service', isContractTemplate: true, contractEditor: '<p>[[full_name]] [[amount]] [[nope]] [[firma.1.fecha]] ⟦sig:1⟧</p>' },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('plans', () => {
  test('a plan names one known action and only its own fields', async () => {
    expect(await run(['preview', D, plan({ action: 'publish', dealId: DEAL })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'updateContract', contractId: CONTRACT, status: 'Ready' })])).toBe(2);
    expect(err).toMatch(/never changes a contract status/);
    expect(await run(['preview', D, plan({ action: 'proposal', dealId: 'nope', title: 'x' })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'generateContract', dealId: DEAL, signers: [{ contactId: REVIEWER, role: 'reviewer' }] })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'generateContract', dealId: DEAL, attachProposal: false })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'updateContract', contractId: CONTRACT, options: { emailCode: 'yes' } })])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('apply needs --confirmed and the preview version, and refuses a stale one', async () => {
    const p = { action: 'proposal', dealId: DEAL, enabled: true };
    expect(await run(['apply', D, plan(p), '--version', 'x'])).toBe(2);
    expect(await run(['apply', D, plan(p), '--confirmed'])).toBe(2);
    expect(await run(['apply', D, plan(p), '--version', 'stale', '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });
});

describe('proposal', () => {
  test('turning it on sends the title (deal name by default) and the layout with its language, never the html', async () => {
    const { code, result } = await previewThenApply({ action: 'proposal', dealId: DEAL, enabled: true, layoutId: LAYOUT });
    expect(code).toBe(0);
    const patch = writes()[0];
    expect(patch.body).toEqual({ proposal: { enabled: true, title: 'Acme', template: { layout: LAYOUT, language: 'es' } } });
    expect(JSON.stringify(patch.body)).not.toMatch(/layoutHtml|snippetHtml/);
    expect(result.saved).toBe(true);
  });

  test('on an active proposal it never resends enabled (that would move the deal to the default stage)', async () => {
    state.deal.proposal = { enabled: true, title: 'Acme', template: { layout: SNIPPET } };
    const { code } = await previewThenApply({ action: 'proposal', dealId: DEAL, enabled: true, title: 'New' });
    expect(code).toBe(0);
    expect(writes()[0].body).toEqual({ proposal: { title: 'New' } });
  });

  test('blocks a deal without contact, a template that is not a layout, and a closed deal', async () => {
    state.deal.contact = null;
    expect(await run(['preview', D, plan({ action: 'proposal', dealId: DEAL, enabled: true })])).toBe(3);
    expect(JSON.parse(out).blockers.join()).toMatch(/no contact/);
    state.deal.contact = CONTACT;
    out = '';
    expect(await run(['preview', D, plan({ action: 'proposal', dealId: DEAL, enabled: true, layoutId: SNIPPET })])).toBe(3);
    expect(JSON.parse(out).blockers.join()).toMatch(/not a layout/);
    state.stage.endFlowStage = true;
    out = '';
    expect(await run(['preview', D, plan({ action: 'proposal', dealId: DEAL, enabled: true })])).toBe(3);
    expect(JSON.parse(out).blockers.join()).toMatch(/end-of-flow/);
    state.prefs.stageRules.allowEditInEndFlowStages = true;
    out = '';
    expect(await run(['preview', D, plan({ action: 'proposal', dealId: DEAL, enabled: true })])).toBe(0);
    expect(writes()).toHaveLength(0);
  });
});

describe('versions', () => {
  test('saving a version sends the stored proposal, hidden from the client, and finds it in the list', async () => {
    state.deal.proposal = { enabled: true, title: 'Acme', template: { layout: LAYOUT, layoutHtml: '<x>' } };
    const { code, result } = await previewThenApply({ action: 'saveVersion', dealId: DEAL, name: 'Before discount' });
    expect(code).toBe(0);
    const post = writes()[0];
    expect(post.path).toBe('/v2/proposalversion/createRestorationPoint');
    expect(post.body).toEqual({ dealSource: DEAL, proposalData: state.versions[result.versionId].proposalData, versionName: 'Before discount', visibleToClient: false });
    expect(post.body.proposalData.title).toBe('Acme');
    expect(result).toMatchObject({ saved: true, visibleToClient: false });
  });

  test('restoring saves a backup first, then points the deal at the version, and checks the result', async () => {
    state.deal.proposal = { enabled: true, title: 'Current', template: { layout: SNIPPET } };
    const { code, result } = await previewThenApply({ action: 'restoreVersion', dealId: DEAL, versionId: VERSION });
    expect(code).toBe(0);
    const [backup, restore] = writes();
    expect(backup.body).toMatchObject({ versionName: 'Before restoring "v1"', proposalData: { title: 'Current' }, visibleToClient: false });
    expect(restore.body).toEqual({ proposalVersions: { restorationPoint: VERSION } });
    expect(result).toMatchObject({ saved: true, restored: VERSION, proposal: { title: 'Old title' } });
    expect(result.backupVersionId).toBeTruthy();
  });

  test('a version of another deal is blocked', async () => {
    state.deal.proposal = { enabled: true, title: 'Current' };
    expect(await run(['preview', D, plan({ action: 'restoreVersion', dealId: DEAL, versionId: OTHER_VERSION })])).toBe(3);
    expect(writes()).toHaveLength(0);
  });
});

describe('contracts', () => {
  beforeEach(() => {
    state.deal.proposal = { enabled: true, title: 'Acme', template: { layout: LAYOUT } };
  });

  test('a generated contract is always a Draft, and roles and options go in a second save while it is a Draft', async () => {
    const p = {
      action: 'generateContract', dealId: DEAL, templateId: TEMPLATE,
      signers: [{ contactId: CONTACT }, { contactId: REVIEWER, role: 'reviewer' }], options: { sendEmailsInOrder: true, emailCode: true, deadlineDate: '2026-12-01' },
    };
    const { code, result } = await previewThenApply(p);
    expect(code).toBe(0);
    const [generate, patch] = writes();
    expect(generate.body).toMatchObject({ dealId: DEAL, contactId: CONTACT, signerContactIds: [CONTACT, REVIEWER], contractTemplateId: TEMPLATE, attachProposal: true, status: 'Draft' });
    expect(patch.body.signerEvidences).toEqual({ [CONTACT]: { role: 'signer' }, [REVIEWER]: { role: 'reviewer' } });
    expect(patch.body.options).toEqual({ sendEmailsInOrder: true, verification: { emailCode: true }, deadlineDate: '2026-12-01T00:00:00.000Z' });
    expect(result).toMatchObject({ saved: true, status: 'Draft', variables: { filled: ['full_name'], empty: ['amount'], unknown: ['nope'] } });
    expect(JSON.stringify(result)).not.toMatch(/signingUrl/);
  });

  test('blocks a deal that already has an active contract; a rejected one does not count', async () => {
    state.contracts = [{ _id: CONTRACT, contractName: 'Old', status: 'Draft' }];
    expect(await run(['preview', D, plan({ action: 'generateContract', dealId: DEAL })])).toBe(3);
    state.contracts = [{ _id: CONTRACT, contractName: 'Old', status: 'Rejected' }];
    out = '';
    expect(await run(['preview', D, plan({ action: 'generateContract', dealId: DEAL })])).toBe(0);
    expect(writes()).toHaveLength(0);
  });

  test('an existing contract returned by the platform, or one that is not a Draft, is reported, never patched', async () => {
    state.generateExisting = true;
    expect((await previewThenApply({ action: 'generateContract', dealId: DEAL, options: { emailCode: true } })).code).toBe(3);
    expect(writes().filter((c) => c.method === 'PATCH')).toHaveLength(0);
    state.generateExisting = false;
    state.forceReady = true;
    calls = [];
    const { code, result } = await previewThenApply({ action: 'generateContract', dealId: DEAL, options: { emailCode: true } });
    expect(code).toBe(1);
    expect(result.problems.join()).toMatch(/not Draft/);
    expect(writes().filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('a slow print that outlasts the request still finds the new contract', async () => {
    state.networkErrorOn = 'POST /v2/contract/generateFromDeal';
    state.contract = { _id: CONTRACT, contractName: 'Late', status: 'Draft', contractDocuments: ['f'], signers: [CONTACT], signerEvidences: {}, updatedAt: 'C1' };
    const { code, result } = await previewThenApply({ action: 'generateContract', dealId: DEAL });
    expect(code).toBe(0);
    expect(result.contractId).toBe(CONTRACT);
  });

  test('a contract that is not a Draft cannot be changed, also when it turns Ready after the preview', async () => {
    state.contract = { _id: CONTRACT, contractName: 'C', status: 'Ready', signers: [CONTACT], signerEvidences: {}, updatedAt: 'C1' };
    expect(await run(['preview', D, plan({ action: 'updateContract', contractId: CONTRACT, name: 'x' })])).toBe(3);
    expect(JSON.parse(out).blockers.join()).toMatch(/sends the signature request again/);
    state.contract.status = 'Draft';
    state.turnReadyAfterReads = 2; // preview read, apply's own read, then the re-check sees Ready
    const { code } = await previewThenApply({ action: 'updateContract', contractId: CONTRACT, name: 'x' });
    expect(code).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('a contract template is created as a template, in Draft, without participants', async () => {
    const { code, result } = await previewThenApply({ action: 'contractTemplate', name: 'NDA', html: '<p>[[full_name]] ⟦sig:1⟧</p>' });
    expect(code).toBe(0);
    expect(writes()[0].body).toEqual({ contractName: 'NDA', contractEditor: '<p>[[full_name]] ⟦sig:1⟧</p>', isContractTemplate: true, status: 'Draft', signers: [] });
    expect(result.saved).toBe(true);
  });

  test('a {{ }} block holding an editor link is caught before it is saved', async () => {
    const html = '<p>{{or <a href="http://contact.email">contact.email</a> email}}</p>';
    expect(await run(['preview', D, plan({ action: 'contractTemplate', name: 'Bad', html })])).toBe(3);
    expect(writes()).toHaveLength(0);
  });
});

describe('template variables', () => {
  test('finds fields, reserved signature fields, logic and signature boxes', () => {
    const v = proposal.templateVariables('<p>[[ full_name ]] [[firma.1.fecha]] {{#each signers}}{{email}}{{/each}} ⟦sig:1⟧ ⟦sig:2⟧</p>');
    expect(v.fields).toEqual(['full_name']);
    expect(v.reserved).toEqual(['firma.1.fecha']);
    expect(v.logic).toEqual(['#each signers', 'email', '/each']);
    expect(v.signatureBoxes).toBe(2);
  });

  test('looks fields up like the platform: exact, any case, then a dotted path', () => {
    const fields = { Email: 'a@example.com', contact: { address: { city: 'Cali' } }, amount: '' };
    expect(proposal.lookupField(fields, 'email')).toBe('a@example.com');
    expect(proposal.lookupField(fields, 'contact.address.city')).toBe('Cali');
    const r = proposal.variablesReport('[[email]] [[amount]] [[contact.address.city]] [[nope]]', fields, '<p>{{x}}</p>');
    expect(r).toEqual({ filled: ['email', 'contact.address.city'], empty: ['amount'], unknown: ['nope'], logicNotCompiled: true });
  });
});
