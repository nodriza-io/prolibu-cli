/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentJs = require('../.claude/skills/prolibu-ai-agents/scripts/agent');

const D = 'dev99.example.com';
const AGENT = 'a'.repeat(24);
const OTHER_AGENT = 'b'.repeat(24);
const SK_AGENT = 'c'.repeat(24);
const SK_PROMPT = 'd'.repeat(24);
const SK_OFF = 'e'.repeat(24);
const ACT_SEARCH = '1'.repeat(24);
const ACT_UPDATE = '2'.repeat(24);
const ACT_SCRIPT = '3'.repeat(24);
const TRIGGER = '4'.repeat(24);
const CRED = '5'.repeat(24);
const LOCAL = '6'.repeat(24);
const NEW_ID = 'f'.repeat(24);

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const CODE_FIELDS = {
  aiagentprofile: 'agentCode', skill: 'skillCode', aiaction: 'actionCode', eventtrigger: 'eventTriggerCode',
};

// Mongo-like match for the filters the script sends: equality, $in, array contains, inline (?i) regex.
function matches(doc, xquery) {
  return Object.entries(xquery || {}).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === 'object' && cond.$in) return cond.$in.map(String).includes(String(v));
    if (cond && typeof cond === 'object' && cond.$regex) return new RegExp(cond.$regex.replace('(?i)', ''), 'i').test(String(v || ''));
    if (Array.isArray(v)) return v.map(String).includes(String(cond));
    return String(v) === String(cond);
  });
}

// A fake of the endpoints the script uses, shaped after the server behavior verified live:
// lists answer {pagination, data}; create answers 201 with server defaults (active true);
// PATCH replaces arrays whole; the playground answers {text, usage, trace}.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (init.method === 'GET' && u.pathname === '/v2/aichat/providers') return respond(200, state.providers);
  if (init.method === 'GET' && u.pathname === '/v2/user/me') return respond(200, { modelSchemas: { Contact: {}, Deal: {}, EventProspect: {} } });
  if (init.method === 'POST' && u.pathname === '/v2/aiagentprofile/test') {
    return respond(200, { text: 'hi', rounds: 1, model: 'm-small', provider: 'anthropic', usage: { totalTokens: 10 }, trace: [{ kind: 'tool', name: 'search', status: 'ok' }] });
  }
  const m = u.pathname.match(/^\/v2\/([a-z]+)(?:\/([a-f0-9]{24}))?$/);
  if (!m) return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
  const [, object, id] = m;
  const table = state[object];
  if (!table) return respond(404, { error: `no ${object}` });
  if (init.method === 'GET' && !id) {
    const xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const rows = Object.values(table).filter((d) => {
      if (xquery._id) return matches(d, { _id: xquery._id });
      return matches(d, xquery);
    });
    return respond(200, { pagination: { count: rows.length }, data: rows });
  }
  if (init.method === 'POST' && !id) {
    const doc = { active: true, ...body, _id: NEW_ID, [CODE_FIELDS[object]]: 'NEW-1', updatedAt: 'T1' };
    if (state.serverIgnoresActive) doc.active = true;
    table[NEW_ID] = doc;
    return respond(201, doc);
  }
  if (init.method === 'PATCH' && id) {
    table[id] = { ...table[id], ...body, updatedAt: 'T2' };
    return respond(200, table[id]);
  }
  return respond(404, { error: 'unexpected' });
}

const run = (argv) => agentJs.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/test'));

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-ai-agents-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    providers: [
      { id: CRED, name: 'Main LLM', providerType: 'anthropic', default: 'm-small', models: [{ id: 'm-small', price: { input: 1, output: 5 } }, { id: 'm-large' }] },
      { id: LOCAL, name: 'Local bridge', providerType: 'localAgent', default: 'x', models: [{ id: 'x' }] },
    ],
    aiagentprofile: {
      [AGENT]: {
        _id: AGENT, agentCode: 'AGT-1', agentName: 'Sales helper', assignee: 'u1', providerCredential: CRED, model: 'm-small',
        active: true, skills: [SK_AGENT], actions: [ACT_SEARCH], updatedAt: 'V1',
      },
      [OTHER_AGENT]: {
        _id: OTHER_AGENT, agentCode: 'AGT-2', agentName: 'Silent', assignee: 'u2', active: false, skills: [], actions: [], updatedAt: 'V9',
      },
    },
    skill: {
      [SK_AGENT]: { _id: SK_AGENT, skillCode: 'SKL-1', skillName: 'Leads', skillType: 'agent', classification: 'leads', actions: [], active: true, updatedAt: 'S1' },
      [SK_PROMPT]: { _id: SK_PROMPT, skillCode: 'SKL-2', skillName: 'Daily summary', skillType: 'prompt', content: 'Summarize', active: true, updatedAt: 'S2' },
      [SK_OFF]: { _id: SK_OFF, skillCode: 'SKL-3', skillName: 'Old', skillType: 'agent', classification: 'x', active: false, updatedAt: 'S3' },
    },
    aiaction: {
      [ACT_SEARCH]: { _id: ACT_SEARCH, actionCode: 'find_contacts', actionName: 'Find contacts', type: 'builtin', builtin: { tool: 'search' }, active: true },
      [ACT_UPDATE]: { _id: ACT_UPDATE, actionCode: 'update_deal', actionName: 'Update deal', type: 'builtin', builtin: { tool: 'update' }, needsConfirmation: false, active: true },
      [ACT_SCRIPT]: { _id: ACT_SCRIPT, actionCode: 'sync_erp', actionName: 'Sync ERP', type: 'script', active: true },
    },
    eventtrigger: {
      [TRIGGER]: {
        _id: TRIGGER, eventTriggerCode: 'EVT-1', eventTriggerName: 'Morning', type: 'routine', skill: SK_PROMPT, agentProfile: AGENT,
        routine: { periodicity: '0 9 * * *', timeZone: 'America/Bogota' }, active: false, updatedAt: 'R1',
      },
    },
    conversation: {
      c1: { _id: 'c1', aiAgentProfile: AGENT, aiModel: 'm-small', aiCredential: CRED, aiUsage: { promptTokens: 1000000, completionTokens: 100000, totalTokens: 1100000, calls: 3 }, aiContext: { origin: { kind: 'eventTrigger', triggerId: TRIGGER } }, status: 'closed' },
    },
    log: {
      l1: { _id: 'l1', logType: 'AiAgent', status: 'Failure', message: 'agent user missing or inactive (AGT-1)', meta: { agentId: AGENT, origin: { kind: 'eventTrigger' } } },
      l2: { _id: 'l2', logType: 'AiAgent', status: 'Failure', message: 'other agent', meta: { agentId: OTHER_AGENT } },
    },
  };
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

const actionsMap = () => new Map(Object.values(state.aiaction).map((a) => [a._id, a]));
const skillsMap = () => new Map(Object.values(state.skill).map((s) => [s._id, s]));

describe('computeReach', () => {
  test('an agent with no usable skill and no action gets every platform tool, none asking first', () => {
    const reach = agentJs.computeReach({ skills: [SK_PROMPT, SK_OFF], actions: [] }, skillsMap(), actionsMap());
    expect(reach.catalogEmpty).toBe(true);
    expect(reach.unconfirmedWrites).toEqual(expect.arrayContaining(['create', 'update', 'delete', 'sendEmail']));
    expect(reach.canChangeRecordsAlone).toBe(true);
    expect(reach.ignoredSkills.map((s) => s.reason)).toEqual([expect.stringContaining('prompt skill'), 'inactive']);
  });

  test('read-only actions do not count as writes; a builtin update does', () => {
    expect(agentJs.computeReach({ skills: [SK_AGENT], actions: [ACT_SEARCH] }, skillsMap(), actionsMap()).canChangeRecordsAlone).toBe(false);
    expect(agentJs.computeReach({ skills: [], actions: [ACT_UPDATE] }, skillsMap(), actionsMap()).unconfirmedWrites).toEqual(['update_deal']);
  });

  test('a script action writes but asks first by default, so it cannot run alone', () => {
    const reach = agentJs.computeReach({ skills: [], actions: [ACT_SCRIPT] }, skillsMap(), actionsMap());
    expect(reach.writes).toEqual(['sync_erp']);
    expect(reach.canChangeRecordsAlone).toBe(false);
  });

  test('inactive actions drop; the designer screen agent never routes skills', () => {
    const actions = actionsMap();
    actions.get(ACT_UPDATE).active = false;
    expect(agentJs.computeReach({ skills: [SK_AGENT], actions: [ACT_UPDATE] }, skillsMap(), actions).writes).toEqual([]);
    const designer = agentJs.computeReach({ skills: [SK_AGENT], actions: [], surfaces: ['designStudio'] }, skillsMap(), actionsMap());
    expect(designer.catalogEmpty).toBe(true);
  });
});

describe('checkCron', () => {
  test('five valid fields pass; seconds, ranges and garbage do not', () => {
    expect(agentJs.checkCron('0 9 * * 1-5')).toBeNull();
    expect(agentJs.checkCron('*/15 8-18 * jan,feb mon-fri')).toBeNull();
    expect(agentJs.checkCron('*/10 * * * * *')).toContain('seconds');
    expect(agentJs.checkCron('60 9 * * *')).toContain('between 0 and 59');
    expect(agentJs.checkCron('every day')).toContain('five fields');
  });
});

describe('readPlan', () => {
  test('rejects fields the skill does not write and lists on the wrong kind', () => {
    expect(() => agentJs.readPlan('{"kind":"agent","id":"AGT-1","set":{"apiKey":"x"}}')).toThrow('apiKey');
    expect(() => agentJs.readPlan('{"kind":"skill","id":"SKL-1","skills":{"add":["x"]}}')).toThrow('agent plan');
    expect(() => agentJs.readPlan('{"kind":"bot","set":{}}')).toThrow('kind');
  });
});

describe('agent plans', () => {
  test('a new agent is created off, needs its user, and says the user switch is for an admin', async () => {
    expect(await run(['preview', D, '{"kind":"agent","set":{"agentName":"New"}}'])).toBe(3);
    expect(json().blockers.join(' ')).toContain('assignee');
    out = '';
    expect(await run(['preview', D, '{"kind":"agent","set":{"agentName":"New","assignee":"bot@example.com","providerCredential":"' + CRED + '"}}'])).toBe(0);
    const p = json();
    expect(p.body.active).toBe(false);
    expect(p.nextSteps.join(' ')).toContain('AI agent');
    expect(p.needsRecordWriteApproval).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  test('a prompt skill or an inactive skill cannot be added to an agent', async () => {
    expect(await run(['preview', D, '{"kind":"agent","id":"AGT-1","skills":{"add":["SKL-2","SKL-3"]}}'])).toBe(3);
    const { blockers } = json();
    expect(blockers.join(' ')).toContain('prompt skill');
    expect(blockers.join(' ')).toContain('inactive');
  });

  test('skills keep the stored order; add appends, order must list them all', async () => {
    state.skill.s4 = { _id: '7'.repeat(24), skillCode: 'SKL-4', skillName: 'Quotes', skillType: 'agent', classification: 'q', active: true };
    state.skill['7'.repeat(24)] = state.skill.s4;
    delete state.skill.s4;
    await run(['preview', D, '{"kind":"agent","id":"AGT-1","skills":{"add":["SKL-4"]}}']);
    expect(json().body.skills).toEqual([SK_AGENT, '7'.repeat(24)]);
    out = '';
    expect(await run(['preview', D, '{"kind":"agent","id":"AGT-1","skills":{"add":["SKL-4"],"order":["SKL-4"]}}'])).toBe(3);
    out = '';
    await run(['preview', D, '{"kind":"agent","id":"AGT-1","skills":{"add":["SKL-4"],"order":["SKL-4","SKL-1"]}}']);
    expect(json().body.skills).toEqual(['7'.repeat(24), SK_AGENT]);
  });

  test('the model must belong to the credential; a local bridge is refused; no credential only warns', async () => {
    expect(await run(['preview', D, '{"kind":"agent","id":"AGT-1","set":{"model":"m-huge"}}'])).toBe(3);
    expect(json().blockers.join(' ')).toContain('not offered');
    out = '';
    expect(await run(['preview', D, `{"kind":"agent","id":"AGT-1","set":{"providerCredential":"${LOCAL}","model":"x"}}`])).toBe(3);
    expect(json().blockers.join(' ')).toContain('personal local bridge');
    out = '';
    expect(await run(['preview', D, '{"kind":"agent","id":"AGT-2","set":{"model":"anything"}}'])).toBe(0);
    expect(json().warnings.join(' ')).toContain('not checked without a credential');
  });

  test('instructions over the limit and a changed user are blocked', async () => {
    const long = 'x'.repeat(12501);
    expect(await run(['preview', D, JSON.stringify({ kind: 'agent', id: 'AGT-1', set: { instructions: long, assignee: 'other@example.com' } })])).toBe(3);
    const { blockers } = json();
    expect(blockers.join(' ')).toContain('12500');
    expect(blockers.join(' ')).toContain('cannot change');
  });

  test('turning on an agent that can change records alone needs --allow-record-writes', async () => {
    const plan = '{"kind":"agent","id":"AGT-2","set":{"active":true}}';
    await run(['preview', D, plan]);
    const p = json();
    expect(p.needsRecordWriteApproval).toBe(true);
    expect(p.warnings.join(' ')).toContain('EVERY platform tool');
    expect(await run(['apply', D, plan, '--version', p.version, '--confirmed'])).toBe(3);
    expect(err).toContain('--allow-record-writes');
    expect(writes()).toHaveLength(0);
    out = '';
    expect(await run(['apply', D, plan, '--version', p.version, '--confirmed', '--allow-record-writes'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: `/v2/aiagentprofile/${OTHER_AGENT}`, body: { active: true } })]);
    expect(json().saved).toBe(true);
  });

  test('apply needs --version and --confirmed, and refuses a stale version', async () => {
    const plan = '{"kind":"agent","id":"AGT-1","set":{"instructions":"Be brief."}}';
    expect(await run(['apply', D, plan, '--confirmed'])).toBe(2);
    expect(await run(['apply', D, plan, '--version', 'V1'])).toBe(2);
    expect(await run(['apply', D, plan, '--version', 'OLD', '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
    expect(await run(['apply', D, plan, '--version', 'V1', '--confirmed'])).toBe(0);
    expect(writes()[0].body).toEqual({ instructions: 'Be brief.' });
  });
});

describe('skill plans', () => {
  test('type-specific fields are checked and the type never changes', async () => {
    expect(await run(['preview', D, '{"kind":"skill","set":{"skillName":"X","skillType":"agent"}}'])).toBe(3);
    expect(json().blockers.join(' ')).toContain('classification');
    out = '';
    expect(await run(['preview', D, '{"kind":"skill","id":"SKL-2","set":{"classification":"x"}}'])).toBe(3);
    out = '';
    expect(await run(['preview', D, '{"kind":"skill","id":"SKL-1","set":{"skillType":"prompt"}}'])).toBe(3);
    expect(json().blockers.join(' ')).toContain('does not change type');
  });

  test('a write action added to a skill of an active agent needs the separate yes', async () => {
    await run(['preview', D, '{"kind":"skill","id":"SKL-1","set":{"actions":["update_deal"]}}']);
    const p = json();
    expect(p.body.actions).toEqual([ACT_UPDATE]);
    expect(p.needsRecordWriteApproval).toBe(true);
    expect(p.usedBy.agents[0].agentCode).toBe('AGT-1');
  });

  test('a prompt skill used by a trigger warns before it is turned off', async () => {
    await run(['preview', D, '{"kind":"skill","id":"SKL-2","set":{"active":false}}']);
    expect(json().warnings.join(' ')).toContain('fail on every fire');
  });
});

describe('trigger plans', () => {
  const base = { eventTriggerName: 'On contact', type: 'lifecycle', modelName: 'Contact', eventName: 'afterCreate', skill: 'SKL-2', agentProfile: 'AGT-1' };

  test('a new trigger is always created off, and the read-back checks it', async () => {
    const plan = JSON.stringify({ kind: 'trigger', set: base });
    await run(['preview', D, plan]);
    const p = json();
    expect(p.body.active).toBe(false);
    expect(p.warnings.join(' ')).toContain('by anyone');
    out = '';
    expect(await run(['apply', D, plan, '--version', p.version, '--confirmed'])).toBe(0);
    expect(writes()[0].body.active).toBe(false);
    out = '';
    state.serverIgnoresActive = true;
    expect(await run(['apply', D, plan, '--version', p.version, '--confirmed'])).toBe(1);
    expect(json().problems.join(' ')).toContain('ON');
  });

  test('creating a trigger already on is blocked', async () => {
    expect(await run(['preview', D, JSON.stringify({ kind: 'trigger', set: { ...base, active: true } })])).toBe(3);
    expect(json().blockers.join(' ')).toContain('switched off');
  });

  test('wrong model case, an agent skill as task, no agent, seconds cron and a bad zone are blocked', async () => {
    expect(await run(['preview', D, JSON.stringify({ kind: 'trigger', set: { ...base, modelName: 'contact', skill: 'SKL-1', agentProfile: undefined } })])).toBe(3);
    const b = json().blockers.join(' ');
    expect(b).toContain('use "Contact"');
    expect(b).toContain('agent skill');
    expect(b).toContain('agentProfile');
    out = '';
    const routine = { eventTriggerName: 'R', type: 'routine', skill: 'SKL-2', agentProfile: 'AGT-1', routine: { periodicity: '*/5 * * * * *', timeZone: 'Bogota' } };
    expect(await run(['preview', D, JSON.stringify({ kind: 'trigger', set: routine })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/seconds[\s\S]*IANA/);
  });

  test('turning on a trigger of an agent that writes alone needs the separate yes; an agent without credential blocks', async () => {
    state.aiagentprofile[AGENT].actions = [ACT_UPDATE];
    const plan = '{"kind":"trigger","id":"EVT-1","set":{"active":true}}';
    await run(['preview', D, plan]);
    const p = json();
    expect(p.turnsOn).toBe(true);
    expect(p.needsRecordWriteApproval).toBe(true);
    expect(await run(['apply', D, plan, '--version', p.version, '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
    out = '';
    delete state.aiagentprofile[AGENT].providerCredential;
    expect(await run(['preview', D, plan])).toBe(3);
    expect(json().blockers.join(' ')).toContain('no LLM credential');
  });

  test('switching type clears the other type\'s fields, as the app does', async () => {
    await run(['preview', D, '{"kind":"trigger","id":"EVT-1","set":{"type":"lifecycle","modelName":"Deal","eventName":"afterUpdate"}}']);
    expect(json().body.routine).toBeNull();
  });
});

describe('runs and test', () => {
  test('runs estimates cost from list prices and keeps only this agent\'s failures', async () => {
    expect(await run(['runs', D, 'AGT-1'])).toBe(0);
    const r = json();
    expect(r.runs[0]).toEqual(expect.objectContaining({ startedBy: 'eventTrigger', tokens: 1100000, estimatedUsd: 1.5 }));
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].message).toContain('AGT-1');
  });

  test('test needs --confirmed, and the separate yes when tools would write', async () => {
    expect(await run(['test', D, 'AGT-1', 'hello'])).toBe(2);
    expect(calls).toHaveLength(0);
    state.aiagentprofile[AGENT].actions = [ACT_UPDATE];
    expect(await run(['test', D, 'AGT-1', 'hello', '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.path.endsWith('/test'))).toBe(false);
    expect(await run(['test', D, 'AGT-1', 'hello', '--confirmed', '--allow-record-writes'])).toBe(0);
    expect(json().toolsCalled).toEqual([{ name: 'search', status: 'ok' }]);
  });

  test('the API key never reaches the output', async () => {
    await run(['agents', D]);
    expect(out + err).not.toContain('SECRET123');
  });
});
