/* global describe, test, expect, beforeEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const records = require('../.claude/skills/prolibu-proposals/scripts/proposal-records');
const proposal = require('../.claude/skills/prolibu-proposals/scripts/proposal');

const D = 'dev99.example.com';
const DEAL = 'a'.repeat(24);
const STAGE = 'b'.repeat(24);
const LAYOUT = 'c'.repeat(24);
const SNIPPET = 'd'.repeat(24);
const CONTACT = 'e'.repeat(24);
const P1 = '1'.repeat(24);
const P2 = '2'.repeat(24);
const V1 = '5'.repeat(24);
const V_OTHER = '6'.repeat(24);
const NEW_P = '7'.repeat(24);

let rootDir;
let out;
let err;
let calls;
let state;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const writes = () => calls.filter((c) => c.method !== 'GET');

// Shaped after feat/propuestas-revision: base CRUD on /v2/proposal, ProposalWriteGuard (400 on
// Approved/Denied), restore through the `restorationPoint` virtual.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const p = u.pathname;
  const m = init.method;
  if (m === 'GET' && p === '/v2/proposal') {
    if (!state.recordsModel) return respond(404, { error: 'Not found' });
    const xq = u.searchParams.get('xquery');
    const rows = Object.values(state.proposals).filter((r) => !xq || r.deal === JSON.parse(xq).deal);
    return respond(200, { data: rows, pagination: { count: rows.length } });
  }
  if (m === 'GET' && p === `/v2/deal/${DEAL}`) return respond(200, state.deal);
  if (m === 'GET' && p === `/v2/stage/${STAGE}`) return respond(200, state.stage);
  if (m === 'GET' && p === '/v2/user/preferences') return respond(200, { modules: { sales: { deals: state.prefs } } });
  if (m === 'GET' && p === `/v2/contenttemplate/${LAYOUT}`) return respond(200, { _id: LAYOUT, contentTemplateName: 'Letter', templateType: 'layout', active: true });
  if (m === 'GET' && p === `/v2/contenttemplate/${SNIPPET}`) return respond(200, { _id: SNIPPET, contentTemplateName: 'Snip', templateType: 'snippet', active: true });
  if (m === 'GET' && p.startsWith('/v2/proposal/')) {
    const r = state.proposals[p.split('/').pop()];
    return r ? respond(200, r) : respond(404, { error: 'Not found' });
  }
  if (m === 'GET' && p === '/v2/proposalversion') {
    const xq = JSON.parse(u.searchParams.get('xquery'));
    const rows = Object.values(state.versions).filter((v) => (xq.proposal ? v.proposal === xq.proposal : v.dealSource === xq.dealSource));
    return respond(200, { data: rows });
  }
  if (m === 'GET' && p.startsWith('/v2/proposalversion/')) {
    const v = state.versions[p.split('/').pop()];
    return v ? respond(200, v) : respond(404, { error: 'Not found' });
  }
  if (m === 'POST' && p === '/v2/proposal') {
    const first = state.deal.proposals.length === 0;
    state.proposals[NEW_P] = {
      _id: NEW_P, deal: body.deal, title: body.title, status: body.status, visibleToClient: first,
      template: body.template || { layout: LAYOUT }, quote: { lineItems: [] }, updatedAt: 'N1',
    };
    state.deal.proposals.push(NEW_P);
    state.deal.updatedAt = 'D2';
    return respond(200, state.proposals[NEW_P]);
  }
  if (m === 'PATCH' && p.startsWith('/v2/proposal/')) {
    const r = state.proposals[p.split('/').pop()];
    if (body.status && !['Draft', 'Ready'].includes(body.status)) return respond(400, { error: 'Document key protected' });
    if (body.restorationPoint) {
      Object.assign(r, state.versions[body.restorationPoint].proposalData);
    } else {
      const { template, ...rest } = body;
      Object.assign(r, rest);
      if (template) r.template = { ...r.template, ...template };
    }
    r.updatedAt = `U${calls.length}`;
    return respond(200, r);
  }
  return respond(404, { error: `unexpected ${m} ${p}` });
}

const runWith = (mod) => (argv) => mod.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const run = runWith(records);
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-proposal-records-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    recordsModel: true,
    prefs: { proposalVersioning: { autoGenerate: true }, stageRules: { allowEditInEndFlowStages: false } },
    stage: { _id: STAGE, stageName: 'Proposal', endFlowStage: false },
    deal: { _id: DEAL, dealName: 'Acme', stage: STAGE, contact: CONTACT, proposals: [P1, P2], principalProposal: P1, updatedAt: 'D1' },
    proposals: {
      [P1]: { _id: P1, deal: DEAL, title: 'Option A', status: 'Draft', visibleToClient: true, template: { layout: LAYOUT }, quote: { lineItems: [{}, {}], total: 200, quoteCurrency: 'COP' }, expirationDate: '2026-12-31T00:00:00.000Z', updatedAt: 'U0' },
      [P2]: { _id: P2, deal: DEAL, title: 'Option B', status: 'Ready', visibleToClient: false, template: { layout: LAYOUT }, quote: { lineItems: [{}] }, updatedAt: 'U0' },
    },
    versions: {
      [V1]: { _id: V1, proposal: P1, dealSource: DEAL, sha256: 'h1', createdAt: '2026-11-01', proposalData: { title: 'Option A (old)', template: { layout: LAYOUT }, quote: { lineItems: [{}], total: 100, quoteCurrency: 'COP' }, expirationDate: '2026-12-31T00:00:00.000Z' } },
      [V_OTHER]: { _id: V_OTHER, proposal: P2, dealSource: DEAL, sha256: 'h2', proposalData: { title: 'B' } },
    },
  };
});

describe('model detection', () => {
  test('an account without the Proposal model is sent back to proposal.js, and proposal.js to this script on the new model', async () => {
    state.recordsModel = false;
    expect(await run(['show', D, DEAL])).toBe(3);
    expect(err).toMatch(/proposal\.js/);
    expect(writes()).toHaveLength(0);

    state.recordsModel = true;
    err = '';
    expect(await runWith(proposal)(['show', D, DEAL])).toBe(3);
    expect(err).toMatch(/proposal-records\.js/);
    expect(calls.filter((c) => c.path.startsWith('/v2/deal'))).toHaveLength(0);
  });

  test('the model command says which one', async () => {
    expect(await run(['model', D])).toBe(0);
    expect(JSON.parse(out).model).toBe('records');
    state.recordsModel = false;
    out = '';
    expect(await runWith(proposal)(['model', D])).toBe(0);
    expect(JSON.parse(out).model).toBe('deal');
  });
});

describe('reads', () => {
  test('show lists the proposals in the deal order with status, principal and version counts', async () => {
    expect(await run(['show', D, DEAL])).toBe(0);
    const r = JSON.parse(out);
    expect(r.proposals.map((p) => [p.title, p.status, p.principal, p.versions])).toEqual([['Option A', 'Draft', true, 1], ['Option B', 'Ready', false, 1]]);
    expect(r.proposals[0].previewUrl).toContain(`?proposal=${P1}&source=versionHistory`);
    expect(r.settings.autoVersions).toBe(true);
  });

  test('show says when automatic versions are off', async () => {
    state.prefs.proposalVersioning.autoGenerate = false;
    await run(['show', D, DEAL]);
    expect(JSON.parse(out).notes.join(' ')).toMatch(/Automatic versions are off/);
  });

  test('compare lists what a restore would change', async () => {
    expect(await run(['compare', D, P1, V1])).toBe(0);
    const fields = JSON.parse(out).changes.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(['title', 'quote.lines', 'quote.total']));
  });
});

describe('plans', () => {
  test('only Draft and Ready; approve, deny, publish and quote fields are refused before any call', async () => {
    expect(await run(['preview', D, plan({ action: 'status', proposalId: P1, status: 'Approved' })])).toBe(2);
    expect(err).toMatch(/denies the whole deal/);
    expect(await run(['preview', D, plan({ action: 'edit', proposalId: P1, visibleToClient: true })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'edit', proposalId: P1, quote: {} })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'edit', proposalId: { $ne: null }, title: 'x' })])).toBe(2);
    expect(await run(['preview', D, plan({ action: 'approve', proposalId: P1 })])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('apply needs --confirmed and the preview version, and refuses a stale one', async () => {
    const p = { action: 'edit', proposalId: P1, title: 'New' };
    expect(await run(['apply', D, plan(p), '--version', 'x'])).toBe(2);
    expect(await run(['apply', D, plan(p), '--confirmed'])).toBe(2);
    expect(await run(['apply', D, plan(p), '--version', 'stale', '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('a closed deal blocks every change', async () => {
    state.stage.endFlowStage = true;
    expect(await run(['preview', D, plan({ action: 'edit', proposalId: P1, title: 'x' })])).toBe(3);
  });
});

describe('writes', () => {
  test('edit sends only what changes and reads it back', async () => {
    const { code, result } = await previewThenApply({ action: 'edit', proposalId: P1, title: 'Option A2', layoutId: LAYOUT });
    expect(code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: `/v2/proposal/${P1}`, body: { title: 'Option A2' } })]);
    expect(result.proposal.title).toBe('Option A2');
  });

  test('a snippet is not a layout', async () => {
    expect(await run(['preview', D, plan({ action: 'edit', proposalId: P1, layoutId: SNIPPET })])).toBe(3);
  });

  test('status moves between Draft and Ready only; an Approved proposal is blocked', async () => {
    const { code } = await previewThenApply({ action: 'status', proposalId: P1, status: 'Ready' });
    expect(code).toBe(0);
    expect(state.proposals[P1].status).toBe('Ready');
    state.proposals[P2].status = 'Approved';
    expect(await run(['preview', D, plan({ action: 'status', proposalId: P2, status: 'Draft' })])).toBe(3);
  });

  test('create posts the deal, title and default status, born hidden when the deal has proposals', async () => {
    state.prefs.stageRules.defaultProposalStatus = 'Ready';
    out = '';
    await run(['preview', D, plan({ action: 'create', dealId: DEAL, title: 'Option C' })]);
    expect(JSON.parse(out).summary.join(' ')).toMatch(/born hidden/);
    const { code, result } = await previewThenApply({ action: 'create', dealId: DEAL, title: 'Option C' });
    expect(code).toBe(0);
    expect(writes()[0].body).toEqual({ deal: DEAL, title: 'Option C', status: 'Ready' });
    expect(result.proposal._id).toBe(NEW_P);
  });

  test('restore uses restorationPoint, warns it keeps no copy, and checks the result', async () => {
    out = '';
    await run(['preview', D, plan({ action: 'restoreVersion', proposalId: P1, versionId: V1 })]);
    expect(JSON.parse(out).warnings.join(' ')).toMatch(/saves no copy/);
    const { code, result } = await previewThenApply({ action: 'restoreVersion', proposalId: P1, versionId: V1 });
    expect(code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ body: { restorationPoint: V1 } })]);
    expect(result.proposal.title).toBe('Option A (old)');
  });

  test('a version of another proposal is blocked', async () => {
    expect(await run(['preview', D, plan({ action: 'restoreVersion', proposalId: P1, versionId: V_OTHER })])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('the api key never reaches the output', async () => {
    await run(['show', D, DEAL]);
    expect(out + err).not.toContain('SECRET123');
  });
});
