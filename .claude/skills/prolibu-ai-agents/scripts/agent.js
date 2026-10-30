#!/usr/bin/env node
'use strict';

// Configures Prolibu's native AI agents the way the app does it, with the checks the server
// skips: which skills the agent's router really uses, what an agent can change with nobody
// watching, triggers that are created switched off, and a separate approval before an agent or
// a trigger may change records on its own.
//
//   agent.js agents   <domain> [text]
//   agent.js show     <domain> <agent _id | AGT-code>
//   agent.js skills   <domain> [text] [--type prompt|agent]
//   agent.js actions  <domain> [text]
//   agent.js triggers <domain> [<agent>]
//   agent.js models   <domain>
//   agent.js runs     <domain> <agent> [--limit n]
//   agent.js preview  <domain> '<plan json>'                      writes nothing; returns a version
//   agent.js apply    <domain> '<plan json>' --version <v> --confirmed [--allow-record-writes]
//   agent.js test     <domain> <agent> '<message>' [--mode internal|channel] --confirmed [--allow-record-writes]
//
// Plan kinds: {"kind":"agent"|"skill"|"trigger", "id"?: <_id or code>, "set": {...}, ...}.
// Without "id" a new record is created. Every command accepts --profile <name>.
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INSTRUCTIONS = 12500;
const MAX_MESSAGE = 600;
const MAX_CLASSIFICATION = 300;
const MAX_SCOPE = 2000;
const LLM_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'google', 'localAgent'];

// Platform tools an agent gets when it has no usable skill and no global action (verified in
// the runner: an empty catalog offers every tool), and the ones among them that change data.
const PLATFORM_TOOLS = ['addNote', 'addTask', 'buildDashboard', 'buildReport', 'calculateQuote', 'captureSnapshot', 'create',
  'createProposal', 'delete', 'describeModel', 'draftEmail', 'editDashboard', 'editReport', 'find', 'findOne', 'getActivity',
  'getMyProfile', 'listModels', 'planReport', 'search', 'sendEmail', 'update', 'updateProposal'];
const WRITE_TOOLS = new Set(['addNote', 'addTask', 'buildDashboard', 'buildReport', 'captureSnapshot', 'create', 'createProposal',
  'delete', 'editDashboard', 'editReport', 'planReport', 'sendEmail', 'update', 'updateProposal']);

const AGENT_FIELDS = new Set(['agentName', 'assignee', 'instructions', 'providerCredential', 'model', 'messages', 'locale',
  'allowEveryone', 'collaborators', 'escalateTo', 'limits', 'surfaces', 'active']);
const SKILL_FIELDS = new Set(['skillName', 'description', 'skillType', 'classification', 'scope', 'content', 'systemPrompt',
  'actions', 'active']);
const TRIGGER_FIELDS = new Set(['eventTriggerName', 'type', 'skill', 'agentProfile', 'routine', 'modelName', 'eventName', 'active']);

const AGENT_SELECT = 'agentCode agentName assignee providerCredential model instructions messages locale allowEveryone active '
  + 'collaborators skills actions surfaces limits escalateTo variables createdBy updatedAt';
const SKILL_SELECT = 'skillCode skillName description skillType classification scope content systemPrompt actions active updatedAt';
const ACTION_SELECT = 'actionCode actionName description type builtin script api.method api.allowInChannels client.tool '
  + 'prompt.skill needsConfirmation requiredPermissions active updatedAt';
const TRIGGER_SELECT = 'eventTriggerCode eventTriggerName type skill agentProfile routine modelName eventName active updatedAt';

class Blocked extends Error {}

// ─── API ───────────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

const qs = (params) => new URLSearchParams(params).toString();

async function list(client, object, { xquery, select, sort = '-updatedAt', limit = 100 } = {}) {
  const params = { limit: String(limit), sort };
  if (select) params.select = select;
  if (xquery) params.xquery = JSON.stringify(xquery);
  const body = await call(client, 'GET', `/v2/${object}?${qs(params)}`);
  return { rows: body.data || [], count: body.pagination ? body.pagination.count : (body.data || []).length };
}

// One record by _id or code. A list with a filter, never a populated read: an agent's
// credential and user stay ids. A dropped filter would return everything, so the count is checked.
async function findOne(client, object, ref, codeField, select) {
  const key = String(ref || '');
  let xquery;
  if (ID_RE.test(key)) xquery = { _id: key };
  else if (codeField && /^[A-Z]{3}-\d+$/.test(key)) xquery = { [codeField]: key };
  else throw new UsageError(`"${key}" is not a _id (24 hex) or a code.`);
  const { rows, count } = await list(client, object, { xquery, select, limit: 2 });
  if (count > 1) throw new Error(`The filter on ${object} matched ${count} records; expected one.`);
  return rows[0] || null;
}

async function findMany(client, object, ids, select) {
  const clean = [...new Set((ids || []).map(String).filter((id) => ID_RE.test(id)))];
  if (!clean.length) return new Map();
  const { rows } = await list(client, object, { xquery: { _id: { $in: clean } }, select, limit: 500 });
  return new Map(rows.map((r) => [String(r._id), r]));
}

// Resolves skill or action refs (ids or codes) to ids; unknown ones go to `missing`.
async function resolveRefs(client, object, codeField, refs, select) {
  const ids = [];
  const codes = [];
  (refs || []).forEach((r) => (ID_RE.test(String(r)) ? ids : codes).push(String(r)));
  const found = new Map();
  if (ids.length) (await findMany(client, object, ids, select)).forEach((v, k) => found.set(k, v));
  if (codes.length) {
    const { rows } = await list(client, object, { xquery: { [codeField]: { $in: codes } }, select, limit: 500 });
    rows.forEach((r) => found.set(String(r._id), r));
  }
  const byRef = new Map();
  const missing = [];
  (refs || []).forEach((r) => {
    const key = String(r);
    const doc = ID_RE.test(key) ? found.get(key) : [...found.values()].find((d) => d[codeField] === key);
    if (doc) byRef.set(key, doc);
    else missing.push(key);
  });
  return { byRef, missing, docs: found };
}

// The chat's model picker: credential id, name, provider and models with list prices. Never a key.
async function loadProviders(client) {
  try {
    const body = await call(client, 'GET', '/v2/aichat/providers');
    return Array.isArray(body) ? body : [];
  } catch {
    return null;
  }
}

// ─── What an agent can do with nobody watching ─────────────────────────────────

function defaultNeedsConfirmation(action) {
  if (action.type === 'script') return true;
  if (action.type === 'api') return !(action.api && action.api.method === 'GET');
  return false;
}

function describeAction(a) {
  const needsConfirmation = a.needsConfirmation === undefined || a.needsConfirmation === null
    ? defaultNeedsConfirmation(a) : a.needsConfirmation === true;
  const tool = a.builtin && a.builtin.tool;
  let writes = false;
  let effect = 'reads only';
  if (a.type === 'builtin') {
    writes = WRITE_TOOLS.has(tool);
    effect = writes ? `wraps the platform tool ${tool}, which changes data` : `wraps the platform tool ${tool}`;
    if (tool === 'escalate_to_human') effect = 'creates a task for the people in escalateTo';
  } else if (a.type === 'script') {
    writes = true;
    effect = 'runs a Script, which can do anything its own key allows';
  } else if (a.type === 'api') {
    writes = !(a.api && a.api.method === 'GET');
    effect = writes ? `${a.api && a.api.method} call to another system` : 'GET call to another system';
  } else if (a.type === 'client') {
    effect = 'runs in the browser screen only; never in triggers';
  } else if (a.type === 'prompt') {
    effect = 'one extra model call with a prompt skill';
  } else if (a.type === 'placeholder') {
    effect = 'returns a fixed answer';
  }
  return {
    actionCode: a.actionCode, actionName: a.actionName, type: a.type, tool: tool || undefined, writes, needsConfirmation,
    sendsEmail: tool === 'sendEmail', external: a.type === 'api', effect,
  };
}

// Mirrors loadAgentCatalog: only active agent-type skills route; inactive or missing actions drop.
// The designer screen agent uses skills as context, never as router modes.
function computeReach(agent, skillsById, actionsById) {
  const designer = (agent.surfaces || []).includes('designStudio');
  const ignoredSkills = [];
  const usableSkills = [];
  (agent.skills || []).map(String).forEach((id) => {
    const s = skillsById.get(id);
    if (!s) ignoredSkills.push({ id, reason: 'not found (deleted?)' });
    else if ((s.skillType || 'prompt') !== 'agent') ignoredSkills.push({ id, skillName: s.skillName, reason: 'prompt skill: the router only uses agent skills' });
    else if (s.active === false) ignoredSkills.push({ id, skillName: s.skillName, reason: 'inactive' });
    else if (designer) ignoredSkills.push({ id, skillName: s.skillName, reason: 'used as context by the designer screen, not as a mode' });
    else usableSkills.push(s);
  });
  const pick = (ids) => (ids || []).map(String).map((id) => actionsById.get(id)).filter((a) => a && a.active !== false);
  const globalActions = pick(agent.actions);
  const skillActions = usableSkills.flatMap((s) => pick(s.actions));
  const catalogEmpty = usableSkills.length === 0 && globalActions.length === 0;

  const seen = new Set();
  const tools = [...globalActions, ...skillActions].filter((a) => !seen.has(String(a._id)) && seen.add(String(a._id))).map(describeAction);
  // An empty catalog offers every platform tool, none of them asking first.
  const writes = catalogEmpty ? PLATFORM_TOOLS.filter((t) => WRITE_TOOLS.has(t)) : tools.filter((t) => t.writes).map((t) => t.actionCode);
  const unconfirmedWrites = catalogEmpty ? writes : tools.filter((t) => t.writes && !t.needsConfirmation).map((t) => t.actionCode);
  return {
    catalogEmpty,
    platformTools: catalogEmpty ? PLATFORM_TOOLS : undefined,
    skillsUsed: usableSkills.map((s) => ({ id: String(s._id), skillCode: s.skillCode, skillName: s.skillName })),
    ignoredSkills,
    tools,
    writes,
    unconfirmedWrites,
    sendsEmail: catalogEmpty || tools.some((t) => t.sendsEmail),
    externalCalls: tools.filter((t) => t.external).map((t) => t.actionCode),
    canChangeRecordsAlone: unconfirmedWrites.length > 0,
  };
}

async function loadAgentWorld(client, agent) {
  const skillsById = await findMany(client, 'skill', agent.skills, SKILL_SELECT);
  const actionIds = [...(agent.actions || [])];
  skillsById.forEach((s) => (s.actions || []).forEach((a) => actionIds.push(a)));
  const actionsById = await findMany(client, 'aiaction', actionIds, ACTION_SELECT);
  return { skillsById, actionsById };
}

// ─── Plan ──────────────────────────────────────────────────────────────────────

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    text = fs.readFileSync(text, 'utf8');
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || !['agent', 'skill', 'trigger'].includes(plan.kind)) throw new UsageError('The plan needs "kind": "agent", "skill" or "trigger".');
  const allowed = { agent: AGENT_FIELDS, skill: SKILL_FIELDS, trigger: TRIGGER_FIELDS }[plan.kind];
  const set = plan.set || {};
  if (typeof set !== 'object' || Array.isArray(set)) throw new UsageError('"set" must be an object.');
  const unknown = Object.keys(set).filter((k) => !allowed.has(k));
  if (unknown.length) throw new UsageError(`"set" has fields this skill does not write for a ${plan.kind}: ${unknown.join(', ')}.`);
  const extra = Object.keys(plan).filter((k) => !['kind', 'id', 'set', 'skills', 'actions'].includes(k));
  if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}.`);
  if (plan.kind !== 'agent' && (plan.skills || plan.actions)) {
    throw new UsageError('"skills" and "actions" lists belong to an agent plan; for a skill use set.actions.');
  }
  const hasLists = plan.skills || plan.actions;
  if (!plan.id && !Object.keys(set).length) throw new UsageError('A new record needs "set".');
  if (plan.id && !Object.keys(set).length && !hasLists) throw new UsageError('The plan changes nothing.');
  return { ...plan, set };
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function diff(before, body) {
  return Object.keys(body)
    .filter((k) => !same(before ? before[k] : undefined, body[k]))
    .map((k) => ({ field: k, before: before && before[k] !== undefined ? before[k] : null, after: body[k] }));
}

// add/remove/order on an id list, keeping the stored order (the router reads skills top to bottom).
function mergeList(current, change, byRef, label, blockers) {
  if (!change) return null;
  const list = (current || []).map(String);
  const toId = (ref) => (byRef.get(String(ref)) ? String(byRef.get(String(ref))._id) : null);
  (change.remove || []).forEach((ref) => {
    const id = toId(ref) || String(ref);
    const at = list.indexOf(id);
    if (at < 0) blockers.push(`${label} ${ref} is not on the agent.`);
    else list.splice(at, 1);
  });
  (change.add || []).forEach((ref) => {
    const id = toId(ref);
    if (id && !list.includes(id)) list.push(id);
  });
  if (change.order) {
    const ordered = change.order.map(toId);
    if (ordered.some((id) => !id) || ordered.length !== list.length || ordered.some((id) => !list.includes(id))) {
      blockers.push(`"${label}s.order" must list exactly the agent's ${label}s after the change (${list.length}).`);
    } else return ordered;
  }
  return list;
}

function checkModel(set, current, providers, warnings, blockers) {
  const credential = set.providerCredential !== undefined ? set.providerCredential : current && current.providerCredential;
  const model = set.model !== undefined ? set.model : current && current.model;
  if (set.providerCredential !== undefined && set.providerCredential !== null && !ID_RE.test(String(set.providerCredential))) {
    blockers.push('providerCredential must be the _id of an existing LLM credential (ask an admin; this skill never creates or reads credentials).');
    return null;
  }
  if (!credential) {
    if (model) warnings.push(`Model "${model}" is not checked without a credential, and an agent without a credential cannot run.`);
    else warnings.push('No LLM credential: the agent cannot run until an admin sets providerCredential.');
    return null;
  }
  if (!providers) {
    warnings.push('Could not read the model list; the server checks the model when saving.');
    return null;
  }
  const cred = providers.find((p) => p.id === String(credential));
  if (!cred) {
    warnings.push('The key\'s user cannot use that credential, so its models were not checked. The agent\'s own user must have access to it, or every run fails.');
    return null;
  }
  if (cred.providerType === 'localAgent') {
    blockers.push('That credential is a personal local bridge: triggers, channels and other people cannot run with it. Pick a provider credential.');
  }
  if (model && !(cred.models || []).some((m) => m.id === model)) {
    blockers.push(`Model "${model}" is not offered by the credential "${cred.name}" (${cred.providerType}). Pick one from "models", or leave model empty for the cheapest one.`);
  }
  const chosen = model || null;
  const info = (cred.models || []).find((m) => m.id === (chosen || cred.default));
  return { credential: cred.name, providerType: cred.providerType, model: chosen || `(empty: the cheapest fitting model, today ${cred.default || 'unknown'})`, price: info && info.price ? `${info.price.input} / ${info.price.output} USD per million input / output tokens` : 'no list price known' };
}

async function buildAgentChange(client, plan) {
  const blockers = [];
  const warnings = [];
  const set = { ...plan.set };
  const current = plan.id ? await findOne(client, 'aiagentprofile', plan.id, 'agentCode', AGENT_SELECT) : null;
  if (plan.id && !current) throw new Blocked(`No agent ${plan.id}.`);

  if (!current) {
    if (!set.agentName || !String(set.agentName).trim()) blockers.push('A new agent needs set.agentName.');
    if (!set.assignee) blockers.push('A new agent needs set.assignee: the e-mail or _id of the user it runs as (one agent per user).');
    if (set.active === undefined) set.active = false;
  } else if (set.assignee !== undefined && !same(set.assignee, current.assignee)) {
    blockers.push('The agent\'s user cannot change after creation. Create another agent for another user.');
  }
  if (set.assignee !== undefined && !ID_RE.test(String(set.assignee)) && !EMAIL_RE.test(String(set.assignee))) {
    blockers.push('set.assignee must be a user _id or e-mail.');
  }
  if (typeof set.instructions === 'string' && set.instructions.length > MAX_INSTRUCTIONS) {
    blockers.push(`instructions has ${set.instructions.length} characters; the limit is ${MAX_INSTRUCTIONS}.`);
  }
  Object.entries(set.messages || {}).forEach(([k, v]) => {
    if (typeof v === 'string' && v.length > MAX_MESSAGE) blockers.push(`messages.${k} has ${v.length} characters; the limit is ${MAX_MESSAGE}.`);
  });
  if (set.messages && current && current.messages) set.messages = { ...current.messages, ...set.messages };
  if (set.locale && set.locale.strategy === 'fixed' && !set.locale.language) blockers.push('locale.strategy "fixed" needs locale.language.');
  if (set.allowEveryone && set.allowEveryone.view === true) {
    warnings.push('allowEveryone.view: every user can talk to this agent, and it acts as ITS user, with its access, not theirs.');
  }
  if (set.surfaces && set.surfaces.length) warnings.push('surfaces: a screen is served by one active agent; the server refuses a clash.');

  const touchesLlm = set.providerCredential !== undefined || set.model !== undefined || !current;
  let llm = null;
  if (touchesLlm) llm = checkModel(set, current, await loadProviders(client), warnings, blockers);
  else if (!current.providerCredential) warnings.push('No LLM credential: the agent cannot run until an admin sets providerCredential.');

  // Skills and actions: resolve, check, merge into the stored order.
  const skillRefs = [...((plan.skills && plan.skills.add) || []), ...((plan.skills && plan.skills.remove) || []), ...((plan.skills && plan.skills.order) || [])];
  const actionRefs = [...((plan.actions && plan.actions.add) || []), ...((plan.actions && plan.actions.remove) || [])];
  const skillsFound = await resolveRefs(client, 'skill', 'skillCode', skillRefs, SKILL_SELECT);
  const actionsFound = await resolveRefs(client, 'aiaction', 'actionCode', actionRefs, ACTION_SELECT);
  skillsFound.missing.forEach((r) => blockers.push(`No skill ${r}.`));
  actionsFound.missing.forEach((r) => blockers.push(`No action ${r}.`));
  ((plan.skills && plan.skills.add) || []).forEach((ref) => {
    const s = skillsFound.byRef.get(String(ref));
    if (!s) return;
    if ((s.skillType || 'prompt') !== 'agent') {
      blockers.push(`"${s.skillName}" is a prompt skill: an agent's router ignores it. For a scheduled or record task, put it on a trigger; to give the agent a mode, use an agent skill.`);
    } else if (s.active === false) blockers.push(`"${s.skillName}" is inactive.`);
  });
  ((plan.actions && plan.actions.add) || []).forEach((ref) => {
    const a = actionsFound.byRef.get(String(ref));
    if (!a) return;
    if (a.active === false) blockers.push(`Action "${a.actionName}" is inactive.`);
    if (a.type === 'client') warnings.push(`Action "${a.actionName}" runs in a browser screen only: it never runs in triggers or channels.`);
  });
  const skills = mergeList(current && current.skills, plan.skills, skillsFound.byRef, 'skill', blockers);
  const actions = mergeList(current && current.actions, plan.actions, actionsFound.byRef, 'action', blockers);

  const body = { ...set };
  if (skills) body.skills = skills;
  if (actions) body.actions = actions;
  const changes = diff(current, body);
  Object.keys(body).forEach((k) => { if (current && same(current[k], body[k])) delete body[k]; });

  const after = { ...(current || {}), ...body };
  const world = await loadAgentWorld(client, after);
  const reach = computeReach(after, world.skillsById, world.actionsById);
  if (reach.ignoredSkills.length) warnings.push(`Skills the router ignores: ${reach.ignoredSkills.map((s) => `${s.skillName || s.id} (${s.reason})`).join('; ')}.`);
  if (reach.catalogEmpty) {
    warnings.push('No usable skill and no global action: in the app\'s chat and in triggers the agent gets EVERY platform tool (create, update, delete, send e-mail…) within its user\'s permissions.');
  }
  if (reach.sendsEmail) warnings.push('It can send e-mail from its user\'s connected mailbox.');
  const needsRecordWriteApproval = after.active !== false && reach.canChangeRecordsAlone;
  const nextSteps = [];
  if (!current) {
    nextSteps.push('In the app, Users → the agent\'s user → turn on "AI agent" (billable). This skill never changes users; until then every run fails with "agent user missing or inactive".');
  }
  return {
    kind: 'agent', target: current ? { id: String(current._id), agentCode: current.agentCode, agentName: current.agentName } : null,
    create: !current, body, changes, llm, reach, needsRecordWriteApproval, warnings, blockers, nextSteps,
    version: current ? current.updatedAt : 'new',
  };
}

async function usersOfSkill(client, skillId) {
  const agents = (await list(client, 'aiagentprofile', { xquery: { skills: skillId }, select: AGENT_SELECT })).rows;
  const triggers = (await list(client, 'eventtrigger', { xquery: { skill: skillId }, select: TRIGGER_SELECT })).rows;
  return { agents, triggers };
}

async function buildSkillChange(client, plan) {
  const blockers = [];
  const warnings = [];
  const set = { ...plan.set };
  const current = plan.id ? await findOne(client, 'skill', plan.id, 'skillCode', SKILL_SELECT) : null;
  if (plan.id && !current) throw new Blocked(`No skill ${plan.id}.`);
  const type = set.skillType || (current && current.skillType) || 'prompt';
  if (!['prompt', 'agent'].includes(type)) blockers.push('skillType must be "prompt" or "agent".');
  if (current && set.skillType && set.skillType !== (current.skillType || 'prompt')) {
    blockers.push('A skill does not change type: the agents and triggers that use it would break. Create a new skill.');
  }
  if (!current && !set.skillName) blockers.push('A new skill needs set.skillName.');
  if (type === 'agent') {
    const classification = set.classification !== undefined ? set.classification : current && current.classification;
    if (!classification || !String(classification).trim()) blockers.push('An agent skill needs classification: when it applies (the router reads it).');
    if (classification && String(classification).length > MAX_CLASSIFICATION) blockers.push(`classification is over ${MAX_CLASSIFICATION} characters.`);
    if (set.scope && String(set.scope).length > MAX_SCOPE) blockers.push(`scope is over ${MAX_SCOPE} characters.`);
    if (set.systemPrompt !== undefined) blockers.push('systemPrompt belongs to prompt skills; an agent skill uses scope and content.');
  } else {
    ['classification', 'scope', 'actions'].forEach((f) => {
      if (set[f] !== undefined) blockers.push(`${f} belongs to agent skills; a prompt skill uses systemPrompt and content.`);
    });
  }
  let actionsById = new Map();
  if (set.actions) {
    const found = await resolveRefs(client, 'aiaction', 'actionCode', set.actions, ACTION_SELECT);
    found.missing.forEach((r) => blockers.push(`No action ${r}.`));
    set.actions = set.actions.map((r) => found.byRef.get(String(r))).filter(Boolean).map((a) => String(a._id));
    actionsById = found.docs;
  }
  const changes = diff(current, set);
  const body = { ...set };
  Object.keys(body).forEach((k) => { if (current && same(current[k], body[k])) delete body[k]; });

  const used = current ? await usersOfSkill(client, String(current._id)) : { agents: [], triggers: [] };
  let needsRecordWriteApproval = false;
  const affected = [];
  for (const agent of used.agents) {
    const world = await loadAgentWorld(client, agent);
    const afterSkill = { ...current, ...body, skillType: type };
    world.skillsById.set(String(current._id), afterSkill);
    actionsById.forEach((a, id) => world.actionsById.set(id, a));
    const reach = computeReach(agent, world.skillsById, world.actionsById);
    if (agent.active !== false && reach.canChangeRecordsAlone && body.actions) needsRecordWriteApproval = true;
    affected.push({ agent: agent.agentName, agentCode: agent.agentCode, active: agent.active !== false, canChangeRecordsAlone: reach.canChangeRecordsAlone });
  }
  if (used.triggers.length) {
    warnings.push(`Used as the task of ${used.triggers.length} trigger(s): ${used.triggers.map((t) => `${t.eventTriggerName} (${t.active ? 'on' : 'off'})`).join(', ')}.`);
    if (body.active === false) warnings.push('Turning it off makes those triggers fail on every fire (logged as AiAgent failures).');
  }
  return {
    kind: 'skill', target: current ? { id: String(current._id), skillCode: current.skillCode, skillName: current.skillName } : null,
    create: !current, skillType: type, body, changes, usedBy: { agents: affected, triggers: used.triggers.map((t) => t.eventTriggerName) },
    needsRecordWriteApproval, warnings, blockers, nextSteps: [], version: current ? current.updatedAt : 'new',
  };
}

const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)$/i;

// Five fields only: the server also takes a sixth (seconds) field, which would run every second.
function checkCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length === 6) return 'It has six fields: the first one is seconds, so it would run several times a minute. Use five fields (minute hour day month weekday).';
  if (parts.length !== 5) return 'A schedule has five fields: minute hour day month weekday (for example "0 9 * * 1-5").';
  for (let i = 0; i < 5; i += 1) {
    const [lo, hi] = CRON_RANGES[i];
    for (const item of parts[i].split(',')) {
      const [range, step] = item.split('/');
      if (step !== undefined && !/^\d+$/.test(step)) return `Field ${i + 1} has a bad step "${item}".`;
      if (range === '*') continue;
      for (const v of range.split('-')) {
        if (NAMES.test(v) && (i === 3 || i === 4)) continue;
        if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) return `Field ${i + 1} has "${item}"; it must be between ${lo} and ${hi}.`;
      }
    }
  }
  return null;
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(0);
    return typeof tz === 'string' && tz.includes('/');
  } catch {
    return false;
  }
}

async function modelNames(client) {
  const me = await call(client, 'GET', '/v2/user/me');
  return new Set(Object.keys((me && me.modelSchemas) || {}));
}

async function buildTriggerChange(client, plan) {
  const blockers = [];
  const warnings = [];
  const set = { ...plan.set };
  const current = plan.id ? await findOne(client, 'eventtrigger', plan.id, 'eventTriggerCode', TRIGGER_SELECT) : null;
  if (plan.id && !current) throw new Blocked(`No trigger ${plan.id}.`);
  if (!current) {
    if (set.active === true) blockers.push('A trigger is created switched off. Create it, check it, then turn it on with its own plan and yes.');
    set.active = false;
    if (!set.eventTriggerName) blockers.push('A new trigger needs set.eventTriggerName.');
    if (!set.type) blockers.push('A new trigger needs set.type: "routine" (schedule) or "lifecycle" (record event).');
  }
  const after = { ...(current || {}), ...set };
  if (!['routine', 'lifecycle'].includes(after.type)) blockers.push('type must be "routine" or "lifecycle".');
  // Switching type clears the other type's fields, as the app does.
  if (current && set.type && set.type !== current.type) {
    if (set.type === 'routine') Object.assign(set, { modelName: null, eventName: null });
    else set.routine = null;
    Object.assign(after, set);
  }
  if (after.type === 'routine') {
    const r = after.routine || {};
    const why = checkCron(r.periodicity);
    if (why) blockers.push(`routine.periodicity: ${why}`);
    if (!validTimeZone(r.timeZone)) blockers.push('routine.timeZone must be an IANA time zone such as "America/Bogota".');
    if (!why && !/^\d+$/.test(String(r.periodicity).trim().split(/\s+/)[0])) {
      warnings.push('It runs more than once in each hour it matches: every run is a full agent turn paid in tokens.');
    }
  } else if (after.type === 'lifecycle') {
    if (!['afterCreate', 'afterUpdate', 'afterDelete'].includes(after.eventName)) blockers.push('eventName must be afterCreate, afterUpdate or afterDelete.');
    if (!after.modelName) blockers.push('A record trigger needs modelName (for example "Contact").');
    else if (set.modelName !== undefined) {
      const names = await modelNames(client);
      if (!names.has(after.modelName)) {
        const guess = [...names].find((n) => n.toLowerCase() === String(after.modelName).toLowerCase());
        blockers.push(guess ? `modelName is case-sensitive: use "${guess}". "${after.modelName}" would never fire.` : `There is no object "${after.modelName}" on this account.`);
      }
    }
    warnings.push(`It fires on every ${after.modelName || '<object>'} ${String(after.eventName || '').replace('after', '').toLowerCase()} by anyone (users, imports, forms, integrations), whatever the lifecycle hooks setting says. Each fire is a full agent run paid in tokens.`);
    if (after.eventName === 'afterUpdate') warnings.push('afterUpdate fires on every save, even when nothing changed.');
  }

  // The task (a prompt skill) and the agent that runs it.
  let skill = null;
  if (!after.skill) blockers.push('A trigger needs set.skill: the prompt skill whose content is the task.');
  else {
    skill = (await resolveRefs(client, 'skill', 'skillCode', [after.skill], SKILL_SELECT)).byRef.get(String(after.skill));
    if (!skill) blockers.push(`No skill ${after.skill}.`);
    else {
      if (set.skill !== undefined) set.skill = String(skill._id);
      if ((skill.skillType || 'prompt') !== 'prompt') blockers.push(`"${skill.skillName}" is an agent skill. A trigger's task is a prompt skill (its content and systemPrompt), as the app requires.`);
      if (skill.active === false) blockers.push(`"${skill.skillName}" is inactive: every fire would fail.`);
    }
  }
  let agent = null;
  let reach = null;
  if (!after.agentProfile) blockers.push('A trigger needs set.agentProfile: without an agent nothing runs (each fire only logs a failure).');
  else {
    agent = await findOne(client, 'aiagentprofile', after.agentProfile, 'agentCode', AGENT_SELECT);
    if (!agent) blockers.push(`No agent ${after.agentProfile}.`);
    else {
      if (set.agentProfile !== undefined) set.agentProfile = String(agent._id);
      const world = await loadAgentWorld(client, agent);
      reach = computeReach(agent, world.skillsById, world.actionsById);
      if (after.active === true) {
        if (agent.active === false) blockers.push(`The agent "${agent.agentName}" is inactive: every fire would fail.`);
        if (!agent.providerCredential) blockers.push(`The agent "${agent.agentName}" has no LLM credential: every fire would fail.`);
        warnings.push('Make sure the agent\'s user has "AI agent" turned on in Users (this skill cannot read users); otherwise every fire fails and is logged.');
      }
      if (reach.catalogEmpty) warnings.push('The agent has no usable skill or action, so a fire gets EVERY platform tool (create, update, delete, send e-mail…).');
      const confirmable = reach.tools.filter((t) => t.writes && t.needsConfirmation).map((t) => t.actionCode);
      if (confirmable.length) warnings.push(`In a trigger nobody can confirm, so these actions are refused: ${confirmable.join(', ')}.`);
    }
  }
  const changes = diff(current, set);
  const body = { ...set };
  Object.keys(body).forEach((k) => { if (current && same(current[k], body[k])) delete body[k]; });
  const turnsOn = after.active === true && (!current || current.active !== true);
  const needsRecordWriteApproval = after.active === true && !!reach && reach.canChangeRecordsAlone;
  return {
    kind: 'trigger',
    target: current ? { id: String(current._id), eventTriggerCode: current.eventTriggerCode, eventTriggerName: current.eventTriggerName } : null,
    create: !current, body, changes, turnsOn, active: after.active === true,
    task: skill ? { skillName: skill.skillName, skillCode: skill.skillCode } : null,
    agent: agent ? { agentName: agent.agentName, agentCode: agent.agentCode, active: agent.active !== false, hasCredential: !!agent.providerCredential } : null,
    reach, needsRecordWriteApproval, warnings, blockers, nextSteps: [],
    version: `${current ? current.updatedAt : 'new'}|${agent ? agent.updatedAt : ''}`,
  };
}

async function buildChange(client, plan, ctx) {
  if (plan.kind === 'agent') return buildAgentChange(client, plan);
  if (plan.kind === 'skill') return buildSkillChange(client, plan, ctx);
  return buildTriggerChange(client, plan, ctx);
}

// ─── Commands ──────────────────────────────────────────────────────────────────

const textFilter = (field, text) => (text ? { [field]: { $regex: `(?i)${String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } : undefined);

async function cmdAgents(client, [text]) {
  const { rows, count } = await list(client, 'aiagentprofile', { xquery: textFilter('agentName', text), select: AGENT_SELECT, sort: 'agentName' });
  return {
    count,
    agents: rows.map((a) => ({
      id: String(a._id), agentCode: a.agentCode, agentName: a.agentName, active: a.active !== false, hasCredential: !!a.providerCredential,
      model: a.model || null, skills: (a.skills || []).length, actions: (a.actions || []).length, surfaces: a.surfaces || [],
      everyoneCanUse: !!(a.allowEveryone && a.allowEveryone.view),
    })),
  };
}

async function cmdShow(client, [ref]) {
  if (!ref) throw new UsageError('Usage: show <domain> <agent _id | AGT-code>');
  const agent = await findOne(client, 'aiagentprofile', ref, 'agentCode', AGENT_SELECT);
  if (!agent) throw new Blocked(`No agent ${ref}.`);
  const world = await loadAgentWorld(client, agent);
  const reach = computeReach(agent, world.skillsById, world.actionsById);
  const triggers = (await list(client, 'eventtrigger', { xquery: { agentProfile: String(agent._id) }, select: TRIGGER_SELECT })).rows;
  const providers = await loadProviders(client);
  const cred = providers && agent.providerCredential ? providers.find((p) => p.id === String(agent.providerCredential)) : null;
  return {
    agent: {
      id: String(agent._id), agentCode: agent.agentCode, agentName: agent.agentName, active: agent.active !== false,
      userId: agent.assignee, providerCredential: agent.providerCredential || null,
      credential: cred ? { name: cred.name, providerType: cred.providerType } : (agent.providerCredential ? 'not visible to this key\'s user' : null),
      model: agent.model || (cred ? `(empty: today ${cred.default})` : null),
      instructions: agent.instructions || '', instructionsLength: (agent.instructions || '').length,
      messages: agent.messages || {}, locale: agent.locale || {}, allowEveryone: agent.allowEveryone || {},
      collaborators: agent.collaborators || [], escalateTo: agent.escalateTo || [], surfaces: agent.surfaces || [],
      limits: agent.limits || {}, variables: (agent.variables || []).length,
    },
    skills: (agent.skills || []).map((id) => {
      const s = world.skillsById.get(String(id));
      return s ? { id: String(s._id), skillCode: s.skillCode, skillName: s.skillName, skillType: s.skillType || 'prompt', active: s.active !== false, actions: (s.actions || []).length } : { id: String(id), missing: true };
    }),
    globalActions: (agent.actions || []).map((id) => world.actionsById.get(String(id))).filter(Boolean).map(describeAction),
    reach,
    triggers: triggers.map((t) => ({
      id: String(t._id), eventTriggerCode: t.eventTriggerCode, eventTriggerName: t.eventTriggerName, type: t.type, active: t.active === true,
      when: t.type === 'routine' ? `${(t.routine || {}).periodicity || '(no schedule)'} ${(t.routine || {}).timeZone || ''}`.trim() : `${t.modelName}.${t.eventName}`,
      skill: t.skill,
    })),
    version: agent.updatedAt,
  };
}

async function cmdSkills(client, [text], flags) {
  const xquery = { ...(textFilter('skillName', text) || {}) };
  if (flags.type) xquery.skillType = flags.type;
  const { rows, count } = await list(client, 'skill', { xquery: Object.keys(xquery).length ? xquery : undefined, select: SKILL_SELECT, sort: 'skillName' });
  return {
    count,
    skills: rows.map((s) => ({
      id: String(s._id), skillCode: s.skillCode, skillName: s.skillName, skillType: s.skillType || 'prompt', active: s.active !== false,
      classification: s.classification || undefined, actions: (s.actions || []).length || undefined,
    })),
  };
}

async function cmdActions(client, [text]) {
  const { rows, count } = await list(client, 'aiaction', { xquery: textFilter('actionName', text), select: ACTION_SELECT, sort: 'actionName' });
  return { count, actions: rows.map((a) => ({ id: String(a._id), active: a.active !== false, ...describeAction(a) })) };
}

async function cmdTriggers(client, [ref]) {
  let xquery;
  if (ref) {
    const agent = await findOne(client, 'aiagentprofile', ref, 'agentCode', AGENT_SELECT);
    if (!agent) throw new Blocked(`No agent ${ref}.`);
    xquery = { agentProfile: String(agent._id) };
  }
  const { rows, count } = await list(client, 'eventtrigger', { xquery, select: TRIGGER_SELECT });
  return { count, triggers: rows.map((t) => ({ id: String(t._id), ...t })) };
}

async function cmdModels(client) {
  const providers = await loadProviders(client);
  if (!providers) throw new Error('Could not read the model list (GET /v2/aichat/providers).');
  return {
    note: 'Credentials this key\'s user may use, with their models and list prices in USD per million tokens (input / output). Never a key.',
    credentials: providers.filter((p) => LLM_PROVIDERS.includes(p.providerType)).map((p) => ({
      providerCredential: p.id, name: p.name, providerType: p.providerType, default: p.default,
      personalBridge: p.providerType === 'localAgent' || undefined,
      models: (p.models || []).map((m) => ({ id: m.id, tier: m.tier, price: m.price ? `${m.price.input} / ${m.price.output}` : null })),
    })),
  };
}

async function cmdRuns(client, [ref], flags) {
  if (!ref) throw new UsageError('Usage: runs <domain> <agent> [--limit n]');
  const agent = await findOne(client, 'aiagentprofile', ref, 'agentCode', AGENT_SELECT);
  if (!agent) throw new Blocked(`No agent ${ref}.`);
  const limit = Math.min(Number(flags.limit) || 20, 100);
  const { rows, count } = await list(client, 'conversation', {
    xquery: { aiAgentProfile: String(agent._id) }, select: 'title status aiModel aiCredential aiUsage aiContext.origin createdAt', sort: '-createdAt', limit,
  });
  const providers = await loadProviders(client);
  const priceOf = (cred, model) => {
    const p = providers && providers.find((x) => x.id === String(cred));
    const m = p && (p.models || []).find((x) => x.id === model);
    return m && m.price ? m.price : null;
  };
  let tokens = 0;
  let usd = 0;
  let unpriced = 0;
  const runs = rows.map((c) => {
    const usage = c.aiUsage || {};
    tokens += usage.totalTokens || 0;
    const price = priceOf(c.aiCredential, c.aiModel);
    let cost = null;
    if (price && usage.totalTokens) {
      cost = ((usage.promptTokens || 0) * price.input + (usage.completionTokens || 0) * price.output) / 1e6;
      usd += cost;
    } else if (usage.totalTokens) unpriced += 1;
    const origin = (c.aiContext && c.aiContext.origin) || {};
    return {
      conversationId: String(c._id), at: c.createdAt, startedBy: origin.kind || 'chat', triggerId: origin.triggerId,
      status: c.status, model: c.aiModel, calls: usage.calls || 0, tokens: usage.totalTokens || 0,
      estimatedUsd: cost === null ? null : Number(cost.toFixed(4)), title: c.title,
    };
  });
  // Log.meta is free-form: the server drops a filter on it, so the agent's failures are picked here.
  const logs = (await list(client, 'log', { xquery: { logType: 'AiAgent' }, select: 'status message meta createdAt', sort: '-createdAt', limit: 200 })).rows
    .filter((l) => l.meta && (String(l.meta.agentId) === String(agent._id) || l.meta.agentCode === agent.agentCode));
  return {
    agent: { agentName: agent.agentName, agentCode: agent.agentCode },
    conversations: count, shown: runs.length, runs,
    totals: { tokens, estimatedUsd: Number(usd.toFixed(4)), runsWithoutPrice: unpriced },
    failures: logs.map((l) => ({ at: l.createdAt, status: l.status, message: l.message, origin: l.meta.origin && l.meta.origin.kind })),
    note: 'Estimated cost uses the model list prices; the provider bills the account\'s key. Failure logs are kept 7 days.',
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const change = await buildChange(client, plan, ctx);
  let nextStep;
  if (change.blockers.length) nextStep = 'Blocked: tell the user why in plain words; do not apply.';
  else if (change.needsRecordWriteApproval) {
    nextStep = 'Explain that this agent can change records on its own, including records other people own, as far as its user\'s access reaches. '
      + 'STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message to THAT, run apply with --version, --confirmed and --allow-record-writes.';
  } else nextStep = 'Show the changes to the user. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version.';
  return { ...change, nextStep };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const change = await buildChange(client, plan, ctx);
  if (change.version !== flags.version) throw new Blocked('Something changed since the preview. Preview again and show the user.');
  if (change.blockers.length) throw new Blocked(change.blockers.join(' '));
  if (change.needsRecordWriteApproval && !flags.allowRecordWrites) {
    throw new Blocked('This would let the agent change records on its own. It needs the user\'s explicit yes to that, then --allow-record-writes.');
  }
  const object = { agent: 'aiagentprofile', skill: 'skill', trigger: 'eventtrigger' }[plan.kind];
  if (!Object.keys(change.body).length) return { saved: true, unchanged: true, problems: [] };
  let saved;
  if (change.create) saved = await call(client, 'POST', `/v2/${object}`, { data: change.body, confirmed: true });
  else saved = await call(client, 'PATCH', `/v2/${object}/${change.target.id}`, { data: change.body, confirmed: true });

  const id = String(saved._id);
  const select = { agent: AGENT_SELECT, skill: SKILL_SELECT, trigger: TRIGGER_SELECT }[plan.kind];
  const after = await findOne(client, object, id, null, select);
  const problems = [];
  if (!after) problems.push('The record could not be read back.');
  else {
    Object.entries(change.body).forEach(([field, value]) => {
      if (field === 'assignee' && !ID_RE.test(String(value))) {
        if (!after.assignee) problems.push('assignee did not save.');
        return;
      }
      const stored = after[field];
      const comparable = value && typeof value === 'object' && !Array.isArray(value) && stored && typeof stored === 'object'
        ? Object.keys(value).every((k) => same(stored[k], value[k])) : same(stored, value);
      if (!comparable) problems.push(`${field} did not save as sent.`);
    });
    if (plan.kind === 'trigger' && change.create && after.active !== false) problems.push('The new trigger is ON; switch it off now.');
  }
  return {
    saved: problems.length === 0, kind: plan.kind, created: change.create, id,
    code: after && (after.agentCode || after.skillCode || after.eventTriggerCode), version: after && after.updatedAt,
    changes: change.changes, warnings: change.warnings, nextSteps: change.nextSteps, problems,
  };
}

// One turn of the saved agent, like the editor's playground: tools really run (except the ones
// that need confirmation) and the turn is paid in tokens.
async function cmdTest(client, [ref, message], flags) {
  if (!ref || !message) throw new UsageError('Usage: test <domain> <agent> \'<message>\' [--mode internal|channel] --confirmed');
  if (flags.mode && !['internal', 'channel'].includes(flags.mode)) throw new UsageError('--mode must be internal or channel.');
  if (String(message).length > 4000) throw new UsageError('The message is over 4000 characters.');
  if (!flags.confirmed) throw new UsageError('A test is a real turn: it costs tokens and its tools run. Ask first, then pass --confirmed.');
  const agent = await findOne(client, 'aiagentprofile', ref, 'agentCode', AGENT_SELECT);
  if (!agent) throw new Blocked(`No agent ${ref}.`);
  if (!agent.providerCredential) throw new Blocked('The agent has no LLM credential, so it cannot run. An admin sets providerCredential.');
  const world = await loadAgentWorld(client, agent);
  const reach = computeReach(agent, world.skillsById, world.actionsById);
  if (reach.canChangeRecordsAlone && !flags.allowRecordWrites) {
    throw new Blocked(`During the test these tools really run without asking: ${reach.unconfirmedWrites.join(', ')}. It needs the user's explicit yes to that, then --allow-record-writes.`);
  }
  const data = { id: String(agent._id), messages: [{ role: 'user', content: String(message) }] };
  if (flags.mode) data.mode = flags.mode;
  const res = await call(client, 'POST', '/v2/aiagentprofile/test', { data, confirmed: true });
  return {
    text: res.text, model: res.model, provider: res.provider, rounds: res.rounds, mode: res.mode, timeMs: res.timeMs, usage: res.usage,
    toolsCalled: (res.trace || []).filter((t) => t.kind === 'tool').map((t) => ({ name: t.name, status: t.status })),
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--allow-record-writes') flags.allowRecordWrites = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--type') flags.type = next();
    else if (arg === '--limit') flags.limit = next();
    else if (arg === '--mode') flags.mode = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  agents: cmdAgents, show: cmdShow, skills: cmdSkills, actions: cmdActions, triggers: cmdTriggers, models: cmdModels,
  runs: cmdRuns, preview: cmdPreview, apply: cmdApply, test: cmdTest,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: agent.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    if (flags.type && !['prompt', 'agent'].includes(flags.type)) throw new UsageError('--type must be prompt or agent.');
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    return result.blockers && result.blockers.length ? BLOCKED : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main, computeReach, describeAction, checkCron, readPlan, mergeList, PLATFORM_TOOLS, WRITE_TOOLS };
