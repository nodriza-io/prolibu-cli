#!/usr/bin/env node
'use strict';

// Works with pipelines the way the Prolibu app does: a pipeline is the set of stages that
// share a stageType ("Deal.stage"), and moving a record is one PATCH of its stage field.
// The server does not check that the stage belongs to the record's pipeline, that it is
// active, or that the stage really changed, so this script checks all of that first.
//
//   stages.js pipelines <domain> <Model>
//   stages.js find      <domain> <Model> <text>
//   stages.js show      <domain> <Model> <id>
//   stages.js move      <domain> <Model> <id>[,<id>…] --to <stage> [--field <f>] [--set '<json>']
//   stages.js move      … --versions '<json from preview>' --confirmed [--end-flow]
//
// <stage> is a stage _id, its stageCode, or its name in any of its languages.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const {
  createClient, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const STAGE_SELECT = 'stageName stageCode stageType index active endFlowStage percentage requiredFields '
  + 'suggestedFields protected setAsDefault color emoji allowEveryone createdBy lang';

// Factory stages (fixed ids seeded in every account). The server reacts to these ids only:
// a stage made by hand called "Won" does not trigger what Approved does.
const FACTORY = {
  dealApproved: '76a6f41079d81268f83fede4',
  dealDenied: '76a6f41079d81268f83fede5',
  contactAttempted: '3396e41069c71267e72feda0',
  contactClient: '3396e41069c71267e72feda4',
  contactLost: '3396e41069c71267e72feda5',
  workOrderInExecution: '88a8f53079d82378f83fc409',
  workOrderSuspended: '88a8f53079d82378f83fc410',
  workOrderCompleted: '88a8f53079d82378f83fc405',
  workOrderCancelled: '88a8f53079d82378f83fc406',
  ticketResolved: '64e6f53079d82378f83fc103',
  ticketClosed: '64e6f53079d82378f83fc106',
};

// The reason fields the app asks for when a card lands on these stages (the reason is
// required, the details optional), and that the server clears when the record leaves them.
const REASON_STAGES = {
  [FACTORY.dealDenied]: { model: 'Deal', fields: ['denied.reason', 'denied.details'] },
  [FACTORY.contactLost]: { model: 'Contact', fields: ['lost.reason', 'lost.details'] },
  [FACTORY.workOrderCancelled]: { model: 'WorkOrder', fields: ['cancelled.reason', 'cancelled.details'] },
};
// The app also asks for an "fps" date when a contact lands on Marketing Qualified, on accounts
// whose contacts have that field.
const FPS_STAGE = '3396e41069c71267e72feda2';

// While a deal sits in an end-of-flow stage, the server rejects any other top-level key.
const DEAL_CLOSED_KEYS = new Set(['updatedBy', 'tracking', 'stage', 'pipelineStages', 'stageMovedAt',
  'stageMovedMethod', 'denied', 'stageHistory', 'contracts', 'tasks', 'notes']);

// Keys the script owns: --set may not touch them.
const RESERVED_KEYS = new Set(['_id', 'pipelineStages', 'stageMovedAt', 'stageMovedMethod', 'stageHistory',
  'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((key) => {
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  });
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The server validates a required field as missing only when it is null, undefined or ''.
// [] and 0 pass.
function isMissing(value) {
  return value === null || value === undefined || value === '';
}

// The account can limit a text field to a list (denied.reason often is); the server refuses
// any other value with a 400.
function optionsOf(attrs, field) {
  const attr = getPath(attrs, field);
  return attr && Array.isArray(attr.enum) && attr.enum.length ? attr.enum : null;
}

function idOf(value) {
  if (value && typeof value === 'object') return value._id ? String(value._id) : undefined;
  return value ? String(value) : undefined;
}

// "Propuesta Enviada", "propuesta-enviada" and "proposalSent" all reduce to letters and digits.
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stageNames(stage) {
  const names = [stage.stageName];
  for (const value of Object.values(stage.lang || {})) if (value && value.stageName) names.push(value.stageName);
  if (stage.stageCode) {
    names.push(stage.stageCode);
    names.push(String(stage.stageCode).split('-').pop());
  }
  return [...new Set(names.filter(Boolean).map(normalize))];
}

function humanDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${mins} min`;
  return `${mins} min`;
}

// Expands {"lost.reason": "x"} into {lost: {reason: "x"}}: the app sends nested objects.
function expandSet(set) {
  const out = {};
  for (const [key, value] of Object.entries(set)) {
    const existing = getPath(out, key);
    if (isPlainObject(value) && isPlainObject(existing)) {
      for (const [k, v] of Object.entries(value)) setPath(out, `${key}.${k}`, v);
    } else {
      setPath(out, key, value);
    }
  }
  return out;
}

function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

function parseSet(text, stageFields) {
  if (text === undefined) return {};
  let set;
  try {
    set = JSON.parse(text);
  } catch {
    throw new UsageError('--set is not valid JSON.');
  }
  if (!isPlainObject(set)) throw new UsageError('--set must be a JSON object, for example \'{"denied":{"reason":"Price"}}\'.');
  const expanded = expandSet(set);
  for (const path of leafPaths(expanded)) {
    const top = path.split('.')[0];
    if (RESERVED_KEYS.has(top)) throw new UsageError(`--set cannot change "${top}": the server keeps it.`);
    if (stageFields.some((field) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`))) {
      throw new UsageError(`--set cannot change the stage field "${path}". Use --to (and --field).`);
    }
  }
  return expanded;
}

function parseVersions(text) {
  let versions;
  try {
    versions = JSON.parse(text);
  } catch {
    throw new UsageError('--versions must be the JSON object "versions" printed by the preview.');
  }
  if (!isPlainObject(versions)) throw new UsageError('--versions must be the JSON object "versions" printed by the preview.');
  return versions;
}

// Stage fields of a model: scalar refs to Stage that belong to this model's own pipelines.
// Refs inside arrays (payment plans) and config refs that point at another model's stages
// (Task.workOrderStageOnDone) are not pipelines.
function findStageFields(attrs, arrayPaths, modelName) {
  const arrays = new Set(arrayPaths || []);
  const fields = [];
  const other = [];
  (function walk(node, path) {
    if (!isPlainObject(node)) return;
    if (node.ref === 'Stage') {
      const insideArray = [...arrays].some((a) => path === a || path.startsWith(`${a}.`));
      const xType = node.xquery && node.xquery.stageType;
      if (insideArray || (xType && xType !== `${modelName}.${path}`) || node.hidden) other.push(path);
      else fields.push(path);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['xquery', 'enum', 'example', 'fakerArgs', 'objectShape', 'default'].includes(key)) continue;
      if (isPlainObject(value)) walk(value, path ? `${path}.${key}` : key);
    }
  }(attrs, ''));
  fields.sort((a, b) => (a === 'stage' ? -1 : b === 'stage' ? 1 : a.localeCompare(b)));
  return { fields, other };
}

function summarizeStage(stage) {
  if (!stage) return null;
  return {
    _id: stage._id,
    stageName: stage.stageName,
    stageCode: stage.stageCode,
    index: stage.index,
    active: stage.active !== false,
    endFlowStage: Boolean(stage.endFlowStage),
    ...(typeof stage.percentage === 'number' ? { percentage: stage.percentage } : {}),
    ...((stage.requiredFields || []).length ? { requiredFields: stage.requiredFields } : {}),
    ...((stage.suggestedFields || []).length ? { suggestedFields: stage.suggestedFields } : {}),
    factory: Boolean(stage.protected),
    private: !(stage.allowEveryone && stage.allowEveryone.view),
  };
}

function sortStages(stages) {
  return [...stages].sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0)
    || String(a.stageName).localeCompare(String(b.stageName)));
}

// What moving into `target` asks for, beyond the stage itself. `required` entries block the
// move when empty; the others are asked for and may stay empty. Same list as the app's dialog,
// plus the account rules the server enforces.
function requiredFor({ modelName, target, record, set, prefs, prefsKnown = true, attrs = {} }) {
  const fields = [];
  const add = (field, required, why) => {
    const found = fields.find((f) => f.field === field);
    if (found) {
      if (required && !found.required) Object.assign(found, { required, why });
      return;
    }
    const value = getPath(set, field) !== undefined ? getPath(set, field) : getPath(record, field);
    const options = optionsOf(attrs, field);
    fields.push({
      field, required, why, missing: isMissing(value), ...(options ? { options } : {}),
    });
  };
  for (const field of target.requiredFields || []) add(field, true, 'the stage requires it (the server refuses the move without it)');
  for (const field of target.suggestedFields || []) add(field, false, 'the stage suggests it (the app asks, may stay empty)');

  const id = String(target._id);
  const reason = REASON_STAGES[id];
  if (reason && reason.model === modelName) {
    const [reasonField, detailsField] = reason.fields;
    const rules = getPath(prefs, 'modules.sales.deals.stageRules.onDenialMoveToStage') || {};
    const wo = getPath(prefs, 'modules.operations.workOrders') || {};
    const serverReason = (modelName === 'Deal' && rules.reasonIsRequired === true)
      || (modelName === 'WorkOrder' && wo.requireCancellationReason === true);
    // Without the preferences, assume the details are required too, as the app's bulk edit does.
    const serverDetails = modelName === 'Deal' && (rules.detailsAreRequired === true || !prefsKnown);
    add(reasonField, true, serverReason ? 'account rule (the server refuses the move without it)' : 'the app requires it on this stage');
    add(detailsField, serverDetails, serverDetails
      ? (prefsKnown ? 'account rule (the server refuses the move without it)' : 'the account may require it (preferences unreadable)')
      : 'the app asks for it (may stay empty)');
  }
  if (modelName === 'Contact' && id === FPS_STAGE) {
    const fpsField = ['fps', 'customFields.fps'].find((f) => getPath(attrs, f) !== undefined);
    if (fpsField) add(fpsField, true, 'the app requires the FPS date on this stage');
  }
  return fields;
}

// What the server does on its own when the record lands on `target`. Plain sentences.
function effectsOf({ modelName, field, current, target, record, prefs }) {
  const effects = [];
  const warnings = [];
  const id = String(target._id);
  const isMain = field === 'stage';
  effects.push(`Sets pipelineStages.${field}.movedAt/movedBy/index (time in stage restarts)${isMain ? ' and stageMovedAt' : ''}.`);
  const history = getPath(prefs, 'modules.system.stage.stageHistory');
  if (history && history.enabled && (history.trackedStageFields || []).includes(`${modelName}.${field}`)) {
    effects.push('Writes a StageHistory row (stage history is on for this pipeline).');
  }
  effects.push(`Fires the ${modelName}.update webhooks and the change notifications of the users who subscribed.`);

  if (modelName === 'Deal' && isMain) {
    effects.push('Recomputes the deal score.');
    const proposal = Boolean(getPath(record, 'proposal.enabled'));
    if (proposal) {
      effects.push('Recalculates the quote with current prices: proposal.quote totals may change.');
      if (id === FACTORY.dealApproved) effects.push('Calendar events of the quote lines become Confirmed.');
      else if (id === FACTORY.dealDenied) effects.push('Calendar events of the quote lines become Cancelled.');
      else effects.push('Calendar events of the quote lines become Tentative.');
    }
    if (id === FACTORY.dealApproved) {
      const auto = getPath(prefs, 'modules.operations.workOrders.autoCreateOnDealApproval');
      if (auto !== false) effects.push('Creates a WorkOrder for the deal (unless one exists).');
    }
    if (target.endFlowStage) {
      const editable = getPath(prefs, 'modules.sales.deals.stageRules.allowEditInEndFlowStages');
      if (editable !== true) effects.push('Locks the deal: afterwards only the stage, denied reason, notes, tasks and contracts can change.');
      const survey = getPath(prefs, 'modules.sales.deals.customerSatisfaction.sendSurveyOnEndStage');
      if (record.contact && getPath(record, 'proposal.enabled') && survey !== false) {
        warnings.push(survey === true
          ? 'The account emails a satisfaction survey to the deal contact when a deal with a proposal reaches an end-of-flow stage.'
          : 'If the account sends satisfaction surveys, the deal contact gets one by email.');
      }
    }
    if (current && String(current._id) === FACTORY.dealDenied) effects.push('Clears denied.reason and denied.details.');
  }
  if (modelName === 'Contact' && isMain) {
    effects.push('Recomputes the contact score.');
    if (id === FACTORY.contactClient && !record.clientSince) effects.push('Sets clientSince to now.');
    if (id === FACTORY.contactAttempted && !getPath(record, 'firstContact.at')) effects.push('Records the first contact (firstContact).');
    if (current && String(current._id) === FACTORY.contactLost) effects.push('Clears lost.reason and lost.details.');
    if (getPath(record, 'adCampaignMeta.provider') === 'Meta') warnings.push('This contact came from a Meta ad: the move is reported to Meta.');
  }
  if (modelName === 'WorkOrder' && isMain) {
    effects.push('Updates the work order time tracking (started, suspended, completed or cancelled).');
    effects.push('With progress "By Stage", progress becomes the stage percentage.');
    if (current && String(current._id) === FACTORY.workOrderCancelled) effects.push('Clears cancelled.reason and cancelled.details.');
    const wo = getPath(prefs, 'modules.operations.workOrders') || {};
    if (target.endFlowStage && id !== FACTORY.workOrderCancelled) {
      if (wo.blockCompleteWithPendingTasks) warnings.push('The account refuses this move while the work order has pending tasks.');
      if (wo.blockCompleteWithUnsignedContracts) warnings.push('The account refuses this move while the work order has unsigned contracts.');
    }
  }
  if (modelName === 'Ticket' && isMain && target.endFlowStage) {
    warnings.push('If the account sends satisfaction surveys, the ticket contact gets one by email.');
  }
  if (target.endFlowStage) warnings.push(`"${target.stageName}" is an end-of-flow stage (closed). Writing needs --end-flow.`);
  return { effects, warnings };
}

// Every check that can stop a move, without touching the server.
function checkMove({
  modelName, field, record, current, target, set, prefs, prefsKnown = true, attrs = {},
}) {
  const blockers = [];
  const expectedType = `${modelName}.${field}`;
  if (target.stageType !== expectedType) {
    blockers.push(`"${target.stageName}" belongs to the pipeline ${target.stageType || '(none)'}, not ${expectedType}. `
      + 'The server would accept it and the record would vanish from its board.');
  }
  if (target.active === false) blockers.push(`"${target.stageName}" is inactive: the app does not offer it.`);
  if (current && String(current._id) === String(target._id)) {
    blockers.push(`The record is already in "${target.stageName}". Sending it again would restart its time in stage.`);
  }
  if (modelName === 'Deal' && field === 'stage' && current && current.endFlowStage) {
    const editable = getPath(prefs, 'modules.sales.deals.stageRules.allowEditInEndFlowStages');
    const extra = Object.keys(set).filter((key) => !DEAL_CLOSED_KEYS.has(key));
    if (extra.length && editable !== true) {
      blockers.push(`The deal is in "${current.stageName}", a closed stage: the server refuses ${extra.join(', ')} until it leaves it. `
        + 'Move it first, then edit.');
    }
  }
  for (const path of leafPaths(set)) {
    const options = optionsOf(attrs, path);
    const value = getPath(set, path);
    if (options && !isMissing(value) && !options.includes(value)) {
      blockers.push(`"${value}" is not an option for ${path}. Options: ${options.join(', ')}.`);
    }
  }
  const required = requiredFor({
    modelName, target, record, set, prefs, prefsKnown, attrs,
  });
  const missing = required.filter((r) => r.required && r.missing);
  if (missing.length) {
    blockers.push(`Missing for "${target.stageName}": ${missing.map((m) => m.field).join(', ')}. `
      + 'Ask the user for the values and pass them with --set.');
  }
  return { blockers, required };
}

// ─── API steps ─────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const message = typeof body.error === 'string' ? body.error : (body.message || 'no message');
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${String(message).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function rowsOf(body) {
  return Array.isArray(body) ? body : (body && body.data) || [];
}

async function loadSchema(client, modelArg) {
  const name = String(modelArg || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new UsageError('Give the model name, for example Deal, Contact, Ticket or WorkOrder.');
  const tryName = async (candidate) => {
    const res = await client.request('GET', `/v2/service/getSchema?${new URLSearchParams({ modelNames: candidate, type: 'attrs' })}`);
    return res.ok && isPlainObject(res.body) && res.body._id ? res.body : null;
  };
  // Stage types carry the exact model name ("WorkOrder.stage"), which the schema endpoint and
  // the stageType checks need. A model without stages keeps the given name, capitalized.
  const types = rowsOf(await call(client, 'GET', `/v2/stage?${new URLSearchParams({ select: 'stageType', limit: '1000' })}`));
  const match = [...new Set(types.map((s) => String(s.stageType || '').split('.')[0]))]
    .find((model) => model.toLowerCase() === name.toLowerCase());
  const modelName = match || `${name[0].toUpperCase()}${name.slice(1)}`;
  const attrs = await tryName(modelName);
  if (!attrs) throw new UsageError(`Unknown model "${name}". Use its exact name, for example WorkOrder.`);
  const arrays = await call(client, 'GET', `/v2/service/getSchema?${new URLSearchParams({ modelNames: modelName, type: 'arrays' })}`);
  const { fields, other } = findStageFields(attrs, Array.isArray(arrays) ? arrays : [], modelName);
  const displayFields = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (isPlainObject(value) && value.displayName && value._type === 'string') displayFields.push(key);
  }
  return {
    modelName,
    path: `/v2/${modelName.toLowerCase()}`,
    attrs,
    fields,
    other,
    displayFields,
    hasPipelineStages: Boolean(attrs.pipelineStages),
    hasStageHistory: Boolean(attrs.stageHistory),
  };
}

async function loadPipelineStages(client, modelName) {
  const query = new URLSearchParams({
    xquery: JSON.stringify({ stageType: { $regex: `^${modelName}\\.` } }),
    select: STAGE_SELECT,
    limit: '1000',
    sort: 'index',
  });
  return rowsOf(await call(client, 'GET', `/v2/stage?${query}`));
}

async function loadStage(client, stageId) {
  const res = await client.request('GET', `/v2/stage/${stageId}?${new URLSearchParams({ select: STAGE_SELECT })}`);
  if (res.status === 404 || (res.ok && !(res.body && res.body._id))) return null;
  if (!res.ok) throw new Error(`GET /v2/stage answered ${res.status}`);
  return res.body;
}

// Full preferences are admin-only; every user can read the stage rules at /v2/user/preferences.
// Without either, the script assumes the safe side.
async function loadPrefs(client) {
  const res = await client.request('GET', '/v2/preference/read');
  if (res.ok) return { prefs: (res.body && res.body.preference) || res.body || {}, known: true };
  const pub = await client.request('GET', '/v2/user/preferences');
  if (pub.ok && pub.body) return { prefs: pub.body.preference || pub.body, known: true };
  return { prefs: {}, known: false };
}

function resolveTarget(to, stages, field, modelName) {
  const text = String(to || '').trim();
  if (!text) throw new UsageError('Missing --to <stage id, code or name>.');
  if (ID_RE.test(text)) return { id: text };
  const want = normalize(text);
  const inPipeline = stages.filter((s) => s.stageType === `${modelName}.${field}`);
  const exact = inPipeline.filter((s) => stageNames(s).includes(want));
  if (exact.length === 1) return { id: String(exact[0]._id) };
  if (exact.length > 1) {
    throw new UsageError(`"${text}" matches several stages: ${exact.map((s) => `${s.stageName} (${s._id})`).join(', ')}. Use the _id.`);
  }
  const partial = inPipeline.filter((s) => stageNames(s).some((n) => n.includes(want)));
  if (partial.length === 1) return { id: String(partial[0]._id) };
  const options = (partial.length ? partial : inPipeline).map((s) => `${s.stageName} (${s._id})`).join(', ');
  throw new UsageError(`No single stage "${text}" in ${modelName}.${field}. Options: ${options || 'none'}.`);
}

function recordSelect(schema, extra = []) {
  const keys = new Set(['updatedAt', 'pipelineStages', ...schema.fields, ...schema.displayFields, ...extra]);
  if (schema.attrs.stageMovedAt) keys.add('stageMovedAt');
  if (schema.hasStageHistory) keys.add('stageHistory');
  return [...keys].join(' ');
}

async function loadRecord(client, schema, id, extra) {
  const res = await client.request('GET', `${schema.path}/${id}?${new URLSearchParams({ select: recordSelect(schema, extra) })}`);
  if (res.status === 404 || (res.ok && !(res.body && res.body._id))) throw new UsageError(`No ${schema.modelName} with _id ${id}.`);
  if (!res.ok) throw new Error(`GET ${schema.path}/${id} answered ${res.status}`);
  return res.body;
}

function displayName(record, schema) {
  return schema.displayFields.map((f) => record[f]).filter((v) => typeof v === 'string' && v).join(' ') || String(record._id);
}

function extraFieldsFor(schema, stages) {
  const extra = new Set();
  for (const stage of stages) for (const f of [...(stage.requiredFields || []), ...(stage.suggestedFields || [])]) extra.add(f);
  for (const { model, fields } of Object.values(REASON_STAGES)) if (model === schema.modelName) fields.forEach((f) => extra.add(f));
  if (schema.modelName === 'Deal') ['proposal.enabled', 'contact'].forEach((f) => extra.add(f));
  if (schema.modelName === 'Contact') {
    ['clientSince', 'firstContact.at', 'adCampaignMeta.provider', 'fps', 'customFields.fps'].forEach((f) => extra.add(f));
  }
  // A select that names a field the model does not have can fail the whole read.
  return [...extra].filter((f) => getPath(schema.attrs, f) !== undefined);
}

function stageState(record, field, stagesById, now = Date.now()) {
  const id = idOf(getPath(record, field));
  const pipe = getPath(record, `pipelineStages.${field}`);
  const movedAt = (pipe && pipe.movedAt) || (field === 'stage' ? record.stageMovedAt : undefined);
  const stage = id ? stagesById.get(id) : null;
  return {
    field,
    stage: id ? (summarizeStage(stage) || { _id: id, stageName: '(unknown stage)' }) : null,
    movedAt: movedAt || null,
    movedBy: (pipe && pipe.movedBy) || null,
    timeInStage: movedAt ? humanDuration(now - new Date(movedAt).getTime()) : null,
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdPipelines(client, [model]) {
  if (!model) throw new UsageError('Usage: stages.js pipelines <domain> <Model>');
  const schema = await loadSchema(client, model);
  const stages = await loadPipelineStages(client, schema.modelName);
  const pipelines = schema.fields.map((field) => ({
    field,
    stageType: `${schema.modelName}.${field}`,
    stages: sortStages(stages.filter((s) => s.stageType === `${schema.modelName}.${field}`)).map(summarizeStage),
  }));
  const known = new Set(pipelines.map((p) => p.stageType));
  const orphan = [...new Set(stages.map((s) => s.stageType).filter((t) => t && !known.has(t)))];
  return {
    model: schema.modelName,
    path: schema.path,
    tracksTimeInStage: schema.hasPipelineStages,
    pipelines,
    ...(schema.other.length ? { otherStageRefs: schema.other } : {}),
    ...(orphan.length ? { orphanStageTypes: orphan } : {}),
    notes: [
      'Order is "index" ascending, as the board shows it.',
      'private: true means only its creator sees it in the app (allowEveryone.view is off).',
      'factory: true marks a seeded stage: it can be renamed or deactivated, never deleted.',
    ],
  };
}

async function cmdFind(client, [model, ...words]) {
  const text = words.join(' ').trim();
  if (!model || !text) throw new UsageError('Usage: stages.js find <domain> <Model> <text>');
  const schema = await loadSchema(client, model);
  if (!schema.displayFields.length) throw new UsageError(`${schema.modelName} has no name field to search. Ask the user for the _id.`);
  const pattern = `(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const or = schema.displayFields.map((f) => ({ [f]: { $regex: pattern } }));
  const query = new URLSearchParams({
    xquery: JSON.stringify(or.length === 1 ? or[0] : { $or: or }),
    select: [...schema.displayFields, ...schema.fields, 'updatedAt'].join(' '),
    sort: '-updatedAt',
    limit: '10',
  });
  const rows = rowsOf(await call(client, 'GET', `${schema.path}?${query}`));
  return { model: schema.modelName, records: rows.map((r) => ({ _id: r._id, name: displayName(r, schema), updatedAt: r.updatedAt })) };
}

async function cmdShow(client, [model, id]) {
  if (!model || !ID_RE.test(String(id))) throw new UsageError('Usage: stages.js show <domain> <Model> <id>');
  const schema = await loadSchema(client, model);
  const stages = await loadPipelineStages(client, schema.modelName);
  const stagesById = new Map(stages.map((s) => [String(s._id), s]));
  const record = await loadRecord(client, schema, id, extraFieldsFor(schema, stages));
  const { prefs, known } = await loadPrefs(client);
  for (const field of schema.fields) {
    const sid = idOf(getPath(record, field));
    if (sid && !stagesById.has(sid)) {
      const stage = await loadStage(client, sid);
      if (stage) stagesById.set(sid, stage);
    }
  }
  const pipelines = schema.fields.map((field) => {
    const state = stageState(record, field, stagesById);
    const current = state.stage && stagesById.get(String(state.stage._id));
    const targets = sortStages(stages.filter((s) => s.stageType === `${schema.modelName}.${field}` && s.active !== false))
      .filter((s) => !current || String(s._id) !== String(current._id))
      .map((target) => {
        const asks = requiredFor({
          modelName: schema.modelName, target, record, set: {}, prefs, prefsKnown: known, attrs: schema.attrs,
        });
        const needs = asks.filter((r) => r.required && r.missing).map((r) => r.field);
        const optional = asks.filter((r) => !r.required && r.missing).map((r) => r.field);
        const options = Object.fromEntries(asks.filter((r) => r.missing && r.options).map((r) => [r.field, r.options]));
        return {
          _id: target._id,
          stageName: target.stageName,
          ...(target.endFlowStage ? { endFlowStage: true } : {}),
          ...(needs.length ? { needs } : {}),
          ...(optional.length ? { asksOptional: optional } : {}),
          ...(Object.keys(options).length ? { options } : {}),
        };
      });
    const misplaced = current && current.stageType && current.stageType !== `${schema.modelName}.${field}`;
    return { ...state, ...(misplaced ? { warning: `The current stage belongs to ${current.stageType}.` } : {}), targets };
  });

  let history = [];
  const histQuery = new URLSearchParams({
    xquery: JSON.stringify({ 'origin.modelName': schema.modelName, 'origin.docId': id }),
    select: 'stageField fromStage toStage movedAt movedBy',
    sort: '-movedAt',
    limit: '50',
  });
  const histRes = await client.request('GET', `/v2/stagehistory?${histQuery}`);
  if (histRes.ok) {
    const own = schema.hasStageHistory ? new Set((record.stageHistory || []).map(String)) : null;
    const name = (sid) => {
      if (!sid) return null;
      const stage = stagesById.get(String(sid));
      return stage ? stage.stageName : `${sid} (not a stage of ${schema.modelName})`;
    };
    history = rowsOf(histRes.body).map((h) => ({
      movedAt: h.movedAt,
      field: h.stageField,
      from: name(idOf(h.fromStage)),
      to: name(idOf(h.toStage)),
      movedBy: idOf(h.movedBy) || null,
      // A row the record does not list comes from a move the server then refused.
      ...(own && !own.has(String(h._id)) ? { notApplied: true } : {}),
    }));
  }
  return {
    model: schema.modelName,
    record: { _id: record._id, name: displayName(record, schema), updatedAt: record.updatedAt },
    pipelines,
    history,
    ...(history.length ? {} : { historyNote: 'No stage history: it is off unless the account turned it on for this pipeline.' }),
    ...(known ? {} : { prefsNote: 'Account preferences are admin-only; account-specific rules were not checked.' }),
  };
}

async function planMove(client, schema, id, {
  to, field, set, stages, prefs, prefsKnown,
}) {
  const stagesById = new Map(stages.map((s) => [String(s._id), s]));
  const record = await loadRecord(client, schema, id, extraFieldsFor(schema, stages));
  const { id: targetId } = resolveTarget(to, stages, field, schema.modelName);
  const target = stagesById.get(targetId) || await loadStage(client, targetId);
  if (!target) throw new UsageError(`No stage with _id ${targetId}.`);
  const currentId = idOf(getPath(record, field));
  const current = currentId ? (stagesById.get(currentId) || await loadStage(client, currentId)) : null;
  const { blockers, required } = checkMove({
    modelName: schema.modelName, field, record, current, target, set, prefs, prefsKnown, attrs: schema.attrs,
  });
  const { effects, warnings } = effectsOf({ modelName: schema.modelName, field, current, target, record, prefs });
  const body = setPath(JSON.parse(JSON.stringify(set)), field, String(target._id));
  return {
    record, current, target, body, blockers, required, effects, warnings,
  };
}

async function cmdMove(client, [model, idsArg], flags) {
  if (!model || !idsArg) throw new UsageError("Usage: stages.js move <domain> <Model> <id>[,<id>…] --to <stage> [--field <f>] [--set '<json>']");
  const ids = [...new Set(String(idsArg).split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.some((x) => !ID_RE.test(x))) throw new UsageError('Record ids must be 24-character hex _ids, separated by commas.');
  if (ids.length > 50) throw new UsageError('Move at most 50 records per run.');
  if (flags.confirmed && !flags.versions) {
    throw new UsageError('Missing --versions. Run the move without --confirmed first and pass its "versions": the write only does what the user saw.');
  }
  const schema = await loadSchema(client, model);
  if (!schema.fields.length) throw new UsageError(`${schema.modelName} has no stage field.`);
  const field = flags.field || (schema.fields.includes('stage') ? 'stage' : schema.fields.length === 1 ? schema.fields[0] : null);
  if (!field) throw new UsageError(`${schema.modelName} has several stage fields (${schema.fields.join(', ')}). Pass --field.`);
  if (!schema.fields.includes(field)) throw new UsageError(`"${field}" is not a stage field of ${schema.modelName}: ${schema.fields.join(', ')}.`);
  const set = parseSet(flags.set, schema.fields);
  const stages = await loadPipelineStages(client, schema.modelName);
  const { prefs, known } = await loadPrefs(client);
  const versions = flags.versions ? parseVersions(flags.versions) : null;

  const plans = [];
  for (const id of ids) {
    const plan = await planMove(client, schema, id, {
      to: flags.to, field, set, stages, prefs, prefsKnown: known,
    });
    if (versions && versions[id] !== plan.record.updatedAt) {
      plan.blockers.push('The record changed since the preview. Run the preview again and show the user.');
    }
    if (flags.confirmed && plan.target.endFlowStage && !flags.endFlow && !plan.blockers.length) {
      plan.blockers.push(`"${plan.target.stageName}" is an end-of-flow stage. Add --end-flow only after the user agreed to its effects.`);
    }
    plans.push(plan);
  }
  const preview = (plan) => ({
    _id: plan.record._id,
    name: displayName(plan.record, schema),
    from: plan.current ? plan.current.stageName : null,
    to: plan.target.stageName,
    toId: plan.target._id,
    endFlowStage: Boolean(plan.target.endFlowStage),
    required: plan.required,
    patch: plan.body,
    effects: plan.effects,
    warnings: plan.warnings,
    blockers: plan.blockers,
  });

  if (!flags.confirmed) {
    const blocked = plans.some((p) => p.blockers.length);
    return {
      mode: 'preview (nothing written)',
      model: schema.modelName,
      field,
      records: plans.map(preview),
      versions: Object.fromEntries(plans.map((p) => [String(p.record._id), p.record.updatedAt])),
      ...(known ? {} : { prefsNote: 'Account preferences are admin-only; account rules (denial reason, surveys, work orders) were assumed.' }),
      blockers: plans.flatMap((p) => p.blockers.map((b) => `${displayName(p.record, schema)}: ${b}`)),
      nextStep: blocked
        ? 'Blocked: explain each blocker to the user. Nothing was written.'
        : 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run the same command with --versions \'<versions>\' --confirmed'
          + (plans.some((p) => p.target.endFlowStage) ? ' --end-flow.' : '.'),
    };
  }

  if (plans.some((p) => p.blockers.length)) {
    throw new Blocked(plans.filter((p) => p.blockers.length).map((p) => `${displayName(p.record, schema)}: ${p.blockers.join(' ')}`).join(' | '));
  }

  // The app moves several cards with one PATCH each and reports each result on its own.
  const results = [];
  for (const plan of plans) {
    const id = String(plan.record._id);
    const started = Date.now();
    try {
      await call(client, 'PATCH', `${schema.path}/${id}`, { data: plan.body, confirmed: true });
    } catch (err) {
      results.push({ _id: id, moved: false, error: err.message });
      continue;
    }
    const after = await loadRecord(client, schema, id, extraFieldsFor(schema, stages));
    const problems = [];
    if (idOf(getPath(after, field)) !== String(plan.target._id)) problems.push('The stage did not change.');
    for (const path of leafPaths(set)) {
      const sent = getPath(set, path);
      if (JSON.stringify(getPath(after, path)) !== JSON.stringify(sent)) problems.push(`${path} was not saved as sent.`);
    }
    const pipe = getPath(after, `pipelineStages.${field}`);
    if (schema.hasPipelineStages && !(pipe && new Date(pipe.movedAt).getTime() >= started - 120000)) {
      problems.push(`pipelineStages.${field}.movedAt was not updated.`);
    }
    const result = {
      _id: id,
      name: displayName(after, schema),
      moved: problems.length === 0,
      stage: plan.target.stageName,
      movedAt: pipe ? pipe.movedAt : null,
      problems,
    };
    if (schema.modelName === 'Deal' && String(plan.target._id) === FACTORY.dealApproved) {
      const wo = rowsOf(await call(client, 'GET', `/v2/workorder?${new URLSearchParams({
        xquery: JSON.stringify({ deal: id }), select: 'workOrderName stage', limit: '5',
      })}`));
      result.workOrders = wo.map((w) => ({ _id: w._id, workOrderName: w.workOrderName }));
    }
    results.push(result);
  }
  return { mode: 'write', model: schema.modelName, field, results, moved: results.every((r) => r.moved) };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

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
    else if (arg === '--end-flow') flags.endFlow = true;
    else if (arg === '--to') flags.to = next();
    else if (arg === '--field') flags.field = next();
    else if (arg === '--set') flags.set = next();
    else if (arg === '--versions') flags.versions = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = { pipelines: cmdPipelines, find: cmdFind, show: cmdShow, move: cmdMove };

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) {
      throw new UsageError('Usage: stages.js <pipelines|find|show|move> <domain> … (see the header of this file)');
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (result.mode === 'write') return result.moved ? 0 : 1;
    return result.blockers && result.blockers.length ? BLOCKED : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED (nothing written): ${hide(err.message)}\n`);
      return BLOCKED;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, findStageFields, expandSet, parseSet, checkMove, requiredFor, effectsOf, resolveTarget, normalize, humanDuration, FACTORY,
  optionsOf,
};
