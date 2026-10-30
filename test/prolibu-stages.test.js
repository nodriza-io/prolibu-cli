/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const stages = require('../.claude/skills/prolibu-stages/scripts/stages');

const D = 'dev99.example.com';
const DEAL = 'a'.repeat(24);
const DEAL2 = 'b'.repeat(24);
const USER = 'c'.repeat(24);
const { FACTORY } = stages;
const S = {
  open: '76a6f41079d81268f83fede1',
  inProcess: '76a6f41079d81268f83fede2',
  negotiation: '76a6f41079d81268f83fede3',
  approved: FACTORY.dealApproved,
  denied: FACTORY.dealDenied,
  old: 'd'.repeat(24),
  contacted: '3396e41069c71267e72feda1',
  high: '16b7f53079d82378f83fc306',
};

let rootDir;
let out;
let err;
let calls;
let state;

function stage(_id, stageName, index, extra = {}) {
  return {
    _id, stageName, index, stageType: 'Deal.stage', active: true, allowEveryone: { view: true }, protected: '-stageName', ...extra,
  };
}

const DEAL_ATTRS = {
  _id: { _type: 'objectid' },
  dealName: { displayName: true, _type: 'string' },
  contact: { ref: 'Contact', displayName: true, _type: 'objectid' },
  assignee: { ref: 'User', _type: 'objectid' },
  stage: { ref: 'Stage', _type: 'objectid' },
  priority: { ref: 'Stage', _type: 'objectid' },
  stageMovedAt: { _type: 'date' },
  pipelineStages: { hidden: true, _type: 'mixed' },
  stageHistory: { ref: 'StageHistory', _type: 'array' },
  denied: { reason: { _type: 'string' }, details: { _type: 'string' } },
  proposal: { enabled: { _type: 'boolean' }, quote: { paymentPlan: { payments: { stage: { ref: 'Stage', _type: 'objectid' } } } } },
  hiddenStage: { ref: 'Stage', hidden: true, _type: 'objectid' },
  otherModelStage: { ref: 'Stage', xquery: { stageType: 'WorkOrder.stage' }, _type: 'objectid' },
};

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function get(obj, p) {
  return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

// A fake of the endpoints the script uses, shaped after the server behavior verified live:
// stage refs are not checked against stageType, requiredFields and the denial rule answer 400,
// a closed deal refuses other keys, and a move bumps pipelineStages and updatedAt.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  calls.push({ method: init.method, path: u.pathname, query: q, body: init.body && JSON.parse(init.body) });
  if (u.pathname === '/v2/service/getSchema') {
    if (q.modelNames !== 'Deal') return respond(400, { error: 'Invalid model' });
    return respond(200, q.type === 'arrays' ? ['proposal.quote.paymentPlan.payments', 'stageHistory'] : DEAL_ATTRS);
  }
  if (u.pathname === '/v2/stage' && init.method === 'GET') {
    let rows = state.stages;
    if (q.xquery) {
      const prefix = JSON.parse(q.xquery).stageType.$regex.replace('^', '').replace('\\.', '.');
      rows = rows.filter((s) => s.stageType.startsWith(prefix));
    }
    return respond(200, { data: rows, pagination: { count: rows.length } });
  }
  const stageMatch = /^\/v2\/stage\/([a-f0-9]{24})$/.exec(u.pathname);
  if (stageMatch) {
    const found = state.stages.find((s) => s._id === stageMatch[1]);
    return found ? respond(200, found) : respond(404, { error: 'Not found' });
  }
  if (u.pathname === '/v2/preference/read') {
    return state.prefs ? respond(200, { preference: state.prefs }) : respond(403, { error: 'Forbidden' });
  }
  if (u.pathname === '/v2/stagehistory') return respond(200, { data: state.history });
  if (u.pathname === '/v2/workorder') return respond(200, { data: state.workOrders });
  const dealMatch = /^\/v2\/deal\/([a-f0-9]{24})$/.exec(u.pathname);
  if (dealMatch && init.method === 'GET') {
    const deal = state.deals[dealMatch[1]];
    return deal ? respond(200, JSON.parse(JSON.stringify(deal))) : respond(404, { error: 'Not found' });
  }
  if (dealMatch && init.method === 'PATCH') {
    const deal = state.deals[dealMatch[1]];
    const body = JSON.parse(init.body);
    if (state.failPatch && state.failPatch === dealMatch[1]) return respond(500, { error: 'boom' });
    const current = state.stages.find((s) => s._id === deal.stage);
    if (current && current.endFlowStage && Object.keys(body).some((k) => !['stage', 'denied'].includes(k))) {
      return respond(400, { error: 'This deal is in a closed stage and cannot be edited.' });
    }
    const target = state.stages.find((s) => s._id === body.stage);
    for (const f of (target && target.requiredFields) || []) {
      const v = get(body, f) ?? get(deal, f);
      if (v === null || v === undefined || v === '') return respond(400, { error: 'Stage required field is missing.' });
    }
    if (body.stage === S.denied && !get(body, 'denied.details') && !get(deal, 'denied.details')) {
      return respond(400, { error: 'Denial details are required when moving to denied stage.' });
    }
    const now = new Date().toISOString();
    Object.assign(deal, body, { updatedAt: `${deal.updatedAt}+` });
    if (body.stage) {
      deal.stageMovedAt = now;
      deal.pipelineStages = { ...deal.pipelineStages, stage: { movedAt: now, movedBy: USER, index: Date.now() } };
    }
    if (body.priority) deal.pipelineStages = { ...deal.pipelineStages, priority: { movedAt: now, movedBy: USER, index: Date.now() } };
    if (body.stage === S.approved) state.workOrders.push({ _id: 'e'.repeat(24), workOrderName: `${deal.dealName} - Work Order` });
    return respond(200, deal);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => stages.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-stages-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  const earlier = new Date(Date.now() - (3 * 86400000 + 2 * 3600000)).toISOString();
  state = {
    stages: [
      stage(S.negotiation, 'Negociación', 300, { stageCode: 'deal-stage-negotiation', lang: { en: { stageName: 'Negotiation' } } }),
      stage(S.open, 'Reunión Agendada', 100, { stageCode: 'deal-stage-meetingScheduled' }),
      stage(S.inProcess, 'En Proceso', 200, { stageCode: 'deal-stage-inProcess', requiredFields: ['assignee'] }),
      stage(S.approved, 'Aprobado', 400, { stageCode: 'deal-stage-approved', endFlowStage: true }),
      stage(S.denied, 'Negado', 500, { stageCode: 'deal-stage-denied', endFlowStage: true }),
      stage(S.old, 'Old', 600, { active: false, protected: undefined, allowEveryone: { view: false } }),
      stage(S.contacted, 'Contactado', 150, { stageType: 'Contact.stage' }),
      stage(S.high, 'Alta', 300, { stageType: 'Deal.priority' }),
      stage('f'.repeat(24), 'Gone', 100, { stageType: 'Deal.customFields.gone' }),
    ],
    prefs: {
      modules: {
        sales: { deals: { stageRules: { onDenialMoveToStage: { reasonIsRequired: false, detailsAreRequired: true } } } },
        system: { stage: { stageHistory: { enabled: true, trackedStageFields: ['Deal.stage'] } } },
      },
    },
    history: [],
    workOrders: [],
    deals: {
      [DEAL]: {
        _id: DEAL, dealName: 'Acme', contact: 'k1', stage: S.open, updatedAt: 'T1', stageMovedAt: earlier,
        pipelineStages: { stage: { movedAt: earlier, movedBy: USER, index: 1 } }, stageHistory: ['h1'],
      },
      [DEAL2]: {
        _id: DEAL2, dealName: 'Beta', contact: 'k1', stage: S.open, updatedAt: 'T5', pipelineStages: {},
      },
    },
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

const writes = () => calls.filter((c) => c.method !== 'GET');
const versions = (map) => JSON.stringify(map);

describe('pure helpers', () => {
  test('stage fields are scalar Stage refs of the model, not refs in arrays, hidden or for another model', () => {
    const { fields, other } = stages.findStageFields(DEAL_ATTRS, ['proposal.quote.paymentPlan.payments'], 'Deal');
    expect(fields).toEqual(['stage', 'priority']);
    expect(other.sort()).toEqual(['hiddenStage', 'otherModelStage', 'proposal.quote.paymentPlan.payments.stage']);
  });

  test('--set accepts dotted keys and nests them the way the app sends them', () => {
    expect(stages.parseSet('{"denied.reason":"Price","denied":{"details":"Too high"}}', ['stage']))
      .toEqual({ denied: { reason: 'Price', details: 'Too high' } });
    expect(() => stages.parseSet('{"stage":"x"}', ['stage'])).toThrow('stage field');
    expect(() => stages.parseSet('{"pipelineStages":{"stage":{"index":1}}}', ['stage'])).toThrow('server keeps it');
    expect(() => stages.parseSet('[1]', ['stage'])).toThrow('JSON object');
  });

  test('a stage is found by id, name in any language, code, or code tail, ignoring accents and case', () => {
    const list = state.stages;
    expect(stages.resolveTarget('negociacion', list, 'stage', 'Deal').id).toBe(S.negotiation);
    expect(stages.resolveTarget('Negotiation', list, 'stage', 'Deal').id).toBe(S.negotiation);
    expect(stages.resolveTarget('deal-stage-denied', list, 'stage', 'Deal').id).toBe(S.denied);
    expect(stages.resolveTarget('approved', list, 'stage', 'Deal').id).toBe(S.approved);
    expect(stages.resolveTarget(S.contacted, list, 'stage', 'Deal').id).toBe(S.contacted);
    expect(() => stages.resolveTarget('Contactado', list, 'stage', 'Deal')).toThrow('No single stage');
  });

  test('required means null, undefined or empty string; [] and 0 pass', () => {
    const target = { _id: 'x', requiredFields: ['a', 'b', 'c', 'd'] };
    const asks = stages.requiredFor({ modelName: 'Deal', target, record: { a: [], b: 0, c: '' }, set: {}, prefs: {} });
    expect(asks.filter((r) => r.missing).map((r) => r.field)).toEqual(['c', 'd']);
  });

  test('human durations', () => {
    expect(stages.humanDuration(3 * 86400000 + 2 * 3600000)).toBe('3 d 2 h');
    expect(stages.humanDuration(90 * 60000)).toBe('1 h 30 min');
    expect(stages.humanDuration(-1)).toBeNull();
  });
});

describe('pipelines and show', () => {
  test('pipelines lists each stage field with its stages by index and flags', async () => {
    expect(await run(['pipelines', D, 'deal'])).toBe(0);
    const r = JSON.parse(out);
    expect(r.model).toBe('Deal');
    expect(r.pipelines.map((p) => p.stageType)).toEqual(['Deal.stage', 'Deal.priority']);
    const names = r.pipelines[0].stages.map((s) => s.stageName);
    expect(names).toEqual(['Reunión Agendada', 'En Proceso', 'Negociación', 'Aprobado', 'Negado', 'Old']);
    expect(r.pipelines[0].stages[1].requiredFields).toEqual(['assignee']);
    expect(r.pipelines[0].stages[5]).toMatchObject({ active: false, factory: false, private: true });
    expect(r.orphanStageTypes).toEqual(['Deal.customFields.gone']);
    expect(writes()).toHaveLength(0);
  });

  test('show gives time in stage, what each target needs, and flags history rows the record does not list', async () => {
    state.history = [
      { _id: 'h2', stageField: 'stage', fromStage: S.open, toStage: S.denied, movedAt: 'T3' },
      { _id: 'h1', stageField: 'stage', fromStage: null, toStage: S.open, movedAt: 'T0' },
    ];
    expect(await run(['show', D, 'Deal', DEAL])).toBe(0);
    const r = JSON.parse(out);
    const main = r.pipelines[0];
    expect(main.stage.stageName).toBe('Reunión Agendada');
    expect(main.timeInStage).toBe('3 d 2 h');
    const byName = Object.fromEntries(main.targets.map((t) => [t.stageName, t]));
    expect(byName['En Proceso'].needs).toEqual(['assignee']);
    expect(byName.Negado.needs).toEqual(['denied.reason', 'denied.details']);
    expect(byName.Old).toBeUndefined();
    expect(r.history[0]).toMatchObject({ to: 'Negado', notApplied: true });
    expect(r.history[1].notApplied).toBeUndefined();
  });
});

describe('move preview', () => {
  test('writes nothing and returns the exact patch and the record versions', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negociación'])).toBe(0);
    const r = JSON.parse(out);
    expect(r.records[0].patch).toEqual({ stage: S.negotiation });
    expect(r.versions).toEqual({ [DEAL]: 'T1' });
    expect(r.records[0].effects.join(' ')).toContain('StageHistory');
    expect(writes()).toHaveLength(0);
  });

  test('blocks a stage from another pipeline, an inactive stage, and the current stage', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', S.contacted])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('Contact.stage');
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', S.old])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('inactive');
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Reunión Agendada'])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('time in stage');
    expect(writes()).toHaveLength(0);
  });

  test('a stage requiredField blocks until --set gives it', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'En Proceso'])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('assignee');
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'En Proceso', '--set', `{"assignee":"${USER}"}`])).toBe(0);
    expect(JSON.parse(out).records[0].patch).toEqual({ assignee: USER, stage: S.inProcess });
  });

  test('Denied needs the reason (app) and the details (account rule); unreadable preferences assume both', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'denied', '--set', '{"denied.reason":"Price"}'])).toBe(3);
    const r = JSON.parse(out);
    expect(r.records[0].required.map((x) => [x.field, x.required, x.missing]))
      .toEqual([['denied.reason', true, false], ['denied.details', true, true]]);
    state.prefs.modules.sales.deals.stageRules.onDenialMoveToStage.detailsAreRequired = false;
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'denied', '--set', '{"denied.reason":"Price"}'])).toBe(0);
    state.prefs = null;
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'denied', '--set', '{"denied.reason":"Price"}'])).toBe(3);
    expect(JSON.parse(out).prefsNote).toContain('admin-only');
  });

  test('a reason limited to a list must be one of its options', async () => {
    DEAL_ATTRS.denied.reason.enum = ['Price', 'Timing'];
    try {
      const set = '{"denied":{"reason":"Other","details":"x"}}';
      expect(await run(['move', D, 'Deal', DEAL, '--to', 'denied', '--set', set])).toBe(3);
      expect(JSON.parse(out).blockers.join(' ')).toContain('Options: Price, Timing');
      out = '';
      await run(['show', D, 'Deal', DEAL]);
      const denied = JSON.parse(out).pipelines[0].targets.find((t) => t.stageName === 'Negado');
      expect(denied.options).toEqual({ 'denied.reason': ['Price', 'Timing'] });
    } finally {
      delete DEAL_ATTRS.denied.reason.enum;
    }
  });

  test('a closed deal can leave its stage but not change other fields in the same move', async () => {
    state.deals[DEAL].stage = S.denied;
    state.deals[DEAL].denied = { reason: 'Price', details: 'x' };
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negociación', '--set', '{"dealName":"New"}'])).toBe(3);
    expect(JSON.parse(out).blockers.join(' ')).toContain('closed stage');
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negociación'])).toBe(0);
    expect(JSON.parse(out).records[0].effects.join(' ')).toContain('Clears denied.reason');
  });

  test('a deal with several stage fields moves the main one unless --field says otherwise', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--field', 'priority', '--to', 'alta'])).toBe(0);
    expect(JSON.parse(out).records[0].patch).toEqual({ priority: S.high });
    expect(await run(['move', D, 'Deal', DEAL, '--field', 'nope', '--to', 'alta'])).toBe(2);
  });
});

describe('move write', () => {
  test('refuses without --versions, before any call', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negociación', '--confirmed'])).toBe(2);
    expect(err).toContain('--versions');
    expect(calls).toHaveLength(0);
  });

  test('refuses when the record changed since the preview', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negociación', '--versions', versions({ [DEAL]: 'T0' }), '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(writes()).toHaveLength(0);
  });

  test('moves with one PATCH carrying the stage and the reason fields, then reads back', async () => {
    const set = '{"denied":{"reason":"Price","details":"Too high"}}';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negado', '--set', set, '--versions', versions({ [DEAL]: 'T1' }), '--confirmed'])).toBe(3);
    expect(err).toContain('--end-flow');
    expect(writes()).toHaveLength(0);
    out = '';
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Negado', '--set', set, '--versions', versions({ [DEAL]: 'T1' }), '--confirmed', '--end-flow'])).toBe(0);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({ denied: { reason: 'Price', details: 'Too high' }, stage: S.denied });
    expect(JSON.parse(out).results[0]).toMatchObject({ moved: true, stage: 'Negado', problems: [] });
  });

  test('approving a deal reports the work order the server created', async () => {
    expect(await run(['move', D, 'Deal', DEAL, '--to', 'Aprobado', '--versions', versions({ [DEAL]: 'T1' }), '--confirmed', '--end-flow'])).toBe(0);
    expect(JSON.parse(out).results[0].workOrders).toEqual([{ _id: 'e'.repeat(24), workOrderName: 'Acme - Work Order' }]);
  });

  test('several records move one PATCH each and each result is reported', async () => {
    state.failPatch = DEAL2;
    const v = versions({ [DEAL]: 'T1', [DEAL2]: 'T5' });
    expect(await run(['move', D, 'Deal', `${DEAL},${DEAL2}`, '--to', 'Negociación', '--versions', v, '--confirmed'])).toBe(1);
    const r = JSON.parse(out);
    expect(writes()).toHaveLength(2);
    expect(r.results.map((x) => x.moved)).toEqual([true, false]);
    expect(r.results[1].error).toContain('500');
  });

  test('one blocked record stops the whole batch before any write', async () => {
    state.deals[DEAL2].stage = S.negotiation;
    const v = versions({ [DEAL]: 'T1', [DEAL2]: 'T5' });
    expect(await run(['move', D, 'Deal', `${DEAL},${DEAL2}`, '--to', 'Negociación', '--versions', v, '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('the API key never reaches the output', async () => {
    await run(['move', D, 'Deal', DEAL, '--to', 'Negociación', '--versions', versions({ [DEAL]: 'T1' }), '--confirmed']);
    await run(['show', D, 'Deal', DEAL]);
    expect(out + err).not.toContain('SECRET123');
  });
});
