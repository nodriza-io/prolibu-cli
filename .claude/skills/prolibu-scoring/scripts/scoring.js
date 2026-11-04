#!/usr/bin/env node
'use strict';

// Lead and deal scoring the way the platform computes it: read the account switches, list and
// show profiles with lints the server never runs, explain a record's score criterion by
// criterion, create or edit a rules profile (always inactive), activate or deactivate one, and
// re-score an explicit list of records. Run with no arguments for the command list.
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const CODE_RE = /^[A-Za-z0-9._-]{1,80}$/;
const BLOCKED = 3;
const MAX_RECOMPUTE = 50;
const MAX_TRY = 10;
const SCORED_ENTITIES = ['Contact', 'Deal'];
const OBJECT = { Contact: 'contact', Deal: 'deal' };

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. ';

// json-logic operators the platform's engine knows. Anything else throws inside the engine,
// which counts the criterion as "not fired" without any error.
const OPERATORS = new Set([
  '==', '===', '!=', '!==', '>', '>=', '<', '<=', '!!', '!', '%', 'log', 'in', 'cat', 'substr', '+', '*', '-', '/',
  'min', 'max', 'merge', 'var', 'missing', 'missing_some', 'if', '?:', 'and', 'or', 'all', 'none', 'some', 'filter',
  'map', 'reduce',
]);
const QUANTIFIERS = new Set(['all', 'none', 'some', 'filter', 'map', 'reduce']);
const COMPARISONS = new Set(['==', '===', '!=', '!==', '>', '>=', '<', '<=']);

// Values the engine adds to every record before evaluating criteria.
const SUGAR = {
  common: ['modelName', 'hasCompany', 'daysSinceCreated', 'daysSinceLastActivity'],
  Deal: ['quoteTotal', 'hasQuote', 'proposalViews', 'interactions'],
  Contact: ['hasOpenDeal', 'openDealValue', 'firstContactHeat'],
};
const SIGNALS = {
  common: ['emailsSent', 'emailOpens', 'emailClicks', 'emailReplies', 'presentationViews', 'callsConnected',
    'meetingsCompleted', 'tasksOpen', 'lastActivityAt', 'refreshedAt'],
  Deal: ['interactions', 'calendarEvents'],
  Contact: ['openDeals', 'openDealValue'],
};
const STAGE_KEYS = ['stageCode', 'stageName', 'index', 'percentage', 'endFlowStage'];
const META_FIELDS = new Set(['_id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'workspace']);
// Arrays inside the quote, which the schema stores as a free-form object.
const KNOWN_ARRAYS = ['proposal.quote.lineItems'];

const PLAN_FIELDS = ['scoringName', 'scoringCode', 'description', 'entity', 'type', 'criteria', 'bands', 'normalization', 'workspace'];
const REFUSED_FIELDS = {
  active: 'is never part of a plan: a new profile is always created inactive; use activate-preview / activate',
  ai: 'belongs to the AI layer, which does not run today (profiles of type ai or hybrid score by their rules only)',
  assignee: 'changes who owns the record; set it in the app',
  collaborators: 'changes who can see the record; set it in the app',
  allowEveryone: 'changes who can see the record; set it in the app',
  score: 'is computed by the platform',
};
const CRITERION_KEYS = ['key', 'label', 'category', 'when', 'points'];
const BAND_KEYS = ['key', 'label', 'min', 'max', 'color'];

class Blocked extends Error {}

// ── API helpers ──────────────────────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const msg = typeof body.error === 'string' ? body.error : body.message || JSON.stringify(body.error || 'no message');
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return sp.toString();
}

async function list(client, object, xquery, select, limit = 200) {
  const body = await call(client, 'GET', `/v2/${object}?${qs({ xquery, select, limit })}`);
  return { data: (body && body.data) || [], count: body && body.pagination ? body.pagination.count : 0 };
}

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : String(v || ''));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = (body && body.profile) || {};
  return {
    _id: idOf(p._id),
    email: p.email || null,
    primaryWorkspace: p.primaryWorkspace ? { _id: idOf(p.primaryWorkspace), name: p.primaryWorkspace.workspaceName || null } : null,
    schemas: (body && body.modelSchemas) || {},
  };
}

async function scoringPrefs(client) {
  const prefs = await call(client, 'GET', '/v2/user/preferences');
  const s = (((prefs || {}).modules || {}).system || {}).scoring || {};
  const recompute = s.recompute || {};
  return {
    enabled: s.enabled === true,
    entities: Array.isArray(s.entities) ? s.entities : ['Contact'],
    onActivity: recompute.onActivity !== false,
    periodicity: recompute.periodicity || null,
    defaultScoring: s.defaultScoring ? idOf(s.defaultScoring) : null,
  };
}

const PROFILE_SELECT = 'scoringName scoringCode description entity type active workspace criteria bands normalization updatedAt';

async function getProfile(client, ref) {
  if (!ID_RE.test(String(ref)) && !CODE_RE.test(String(ref))) throw new UsageError(`"${ref}" is not a profile id or code.`);
  return call(client, 'GET', `/v2/scoring/${encodeURIComponent(ref)}?${qs({ select: PROFILE_SELECT })}`);
}

async function allProfiles(client) {
  return (await list(client, 'scoring', {}, PROFILE_SELECT, 200)).data;
}

// The profile the engine uses for a record: the active one of the record's workspace, else
// the active global one; among several actives, the most recently updated.
function applicableProfile(profiles, entity, workspace) {
  const actives = profiles.filter((p) => p.entity === entity && p.active)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const ws = workspace ? idOf(workspace) : null;
  if (ws) {
    const own = actives.find((p) => idOf(p.workspace) === ws);
    if (own) return { profile: own, scope: 'workspace' };
  }
  const global = actives.find((p) => !p.workspace);
  return global ? { profile: global, scope: 'global' } : { profile: null, scope: null };
}

function forbidden(err) {
  return err && err.status === 403;
}

// ── Reading criteria ─────────────────────────────────────────────────────────────────────────────

// Every var a json-logic rule reads, with whether it is read inside a quantifier's predicate
// (where the data is the array item, not the record).
function collectVars(node, inPredicate = false, out = [], ops = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectVars(n, inPredicate, out, ops));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const keys = Object.keys(node);
  if (keys.length !== 1) {
    ops.push({ unknown: `{${keys.join(',')}}` });
    return out;
  }
  const op = keys[0];
  const args = node[op];
  ops.push({ op });
  if (op === 'var') {
    const p = Array.isArray(args) ? args[0] : args;
    out.push({ path: p === undefined || p === null ? '' : String(p), inPredicate });
    if (Array.isArray(args) && args.length > 1) collectVars(args[1], inPredicate, out, ops);
    return out;
  }
  if (QUANTIFIERS.has(op) && Array.isArray(args)) {
    collectVars(args[0], inPredicate, out, ops);
    collectVars(args[1], true, out, ops);
    if (args.length > 2) collectVars(args[2], inPredicate, out, ops);
    return out;
  }
  collectVars(args, inPredicate, out, ops);
  return out;
}

function operatorsOf(node) {
  const ops = [];
  collectVars(node, false, [], ops);
  return ops;
}

// Comparisons of a signals date with a text value: the engine leaves those dates as Date
// objects, so the comparison is always false.
function signalDateComparisons(node, found = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => signalDateComparisons(n, found));
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const [op] = Object.keys(node);
  const args = node[op];
  if (COMPARISONS.has(op) && Array.isArray(args)) {
    const readsSignalDate = args.some((a) => a && typeof a === 'object' && a.var !== undefined
      && /^signals\.[A-Za-z]+At$/.test(String(Array.isArray(a.var) ? a.var[0] : a.var)));
    const hasText = args.some((a) => typeof a === 'string');
    if (readsSignalDate && hasText) found.push(op);
  }
  if (args && typeof args === 'object') signalDateComparisons(args, found);
  return found;
}

// Where a var path lands in the evaluation context of an entity.
function classifyPath(path, entity, schema) {
  if (path === '') return { kind: 'item' };
  const segs = path.split('.');
  const [head] = segs;
  if ([...SUGAR.common, ...(SUGAR[entity] || [])].includes(path)) return { kind: 'sugar' };
  if (['score', 'scoreBand', 'scoreDetail'].includes(head)) return { kind: 'removed' };
  if (head === 'stage') {
    if (segs.length === 1 || (segs.length === 2 && STAGE_KEYS.includes(segs[1]))) return { kind: 'stage' };
    return { kind: 'unknown' };
  }
  if (head === 'signals') {
    if (segs.length === 2 && [...SIGNALS.common, ...(SIGNALS[entity] || [])].includes(segs[1])) {
      return { kind: 'signal', date: /At$/.test(segs[1]) };
    }
    return { kind: 'unknown' };
  }
  for (const arr of KNOWN_ARRAYS) {
    if (path.startsWith(`${arr}.`) && !/^\d+$/.test(path.slice(arr.length + 1).split('.')[0])) return { kind: 'arrayAttr', array: arr };
  }
  if (!schema) return { kind: 'unchecked' };
  // Schema leaves carry a type: "string", "objectid" (with ref), "mixed", or a list such as
  // ["objectid"] for an array field. Nested objects have no type of their own.
  const isLeaf = (n) => n && (typeof n.type === 'string' || Array.isArray(n.type));
  let node = schema;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const field = segs.slice(0, i).join('.');
    if (i > 0 && isLeaf(node)) {
      if (Array.isArray(node.type)) {
        if (!/^\d+$/.test(seg)) return { kind: 'arrayAttr', array: field };
        if (node.type[0] === 'mixed') return { kind: 'field' };
        if (i + 1 === segs.length) return { kind: 'field' };
        if (node.ref) return { kind: 'refPath', ref: node.ref, field: `${field}.${seg}` };
        return { kind: 'unknown' };
      }
      if (node.type === 'mixed') return { kind: 'field' };
      if (node.ref) return { kind: 'refPath', ref: node.ref, field };
      return { kind: 'unknown' };
    }
    if (!node || typeof node !== 'object') return { kind: 'unknown' };
    const next = node[seg];
    if (next === undefined || next === null) return { kind: 'unknown' };
    node = next;
  }
  return { kind: 'field' };
}

function lintCriterion(crit, i, entity, schema, topFields) {
  const at = `criteria[${i}] "${crit.label || crit.key || crit.category || i}"`;
  const blockers = [];
  const warnings = [];
  if (!crit || typeof crit !== 'object' || Array.isArray(crit)) return { blockers: [`criteria[${i}] must be an object.`], warnings };
  const extra = Object.keys(crit).filter((k) => !CRITERION_KEYS.includes(k));
  if (extra.length) blockers.push(`${at}: unknown keys ${extra.join(', ')} (allowed: ${CRITERION_KEYS.join(', ')}).`);
  if (typeof crit.points !== 'number' || !Number.isFinite(crit.points)) blockers.push(`${at}: points must be a number (negative subtracts).`);
  else if (crit.points === 0) warnings.push(`${at}: points is 0, it never changes the score.`);
  if (!crit.label && !crit.key) warnings.push(`${at}: no label or key; the breakdown will show only the category.`);
  if (crit.when === undefined || crit.when === null) {
    warnings.push(`${at}: no condition, so it adds ${crit.points} points to EVERY record.`);
    return { blockers, warnings };
  }
  if (typeof crit.when !== 'object' || Array.isArray(crit.when)) {
    blockers.push(`${at}: when must be a json-logic object such as {">": [{"var": "quoteTotal"}, 1000]}.`);
    return { blockers, warnings };
  }
  for (const o of operatorsOf(crit.when)) {
    if (o.unknown) blockers.push(`${at}: ${o.unknown} is not a json-logic operation (one key per object).`);
    else if (!OPERATORS.has(o.op)) blockers.push(`${at}: operator "${o.op}" does not exist; the engine would count this criterion as never met, without any error.`);
  }
  for (const v of collectVars(crit.when)) {
    if (v.inPredicate) {
      const head = v.path.split('.')[0];
      if (v.path && !META_FIELDS.has(head) && (topFields.has(head) || ['signals', 'stage', ...SUGAR.common, ...(SUGAR[entity] || [])].includes(head))) {
        warnings.push(`${at}: "${v.path}" is read inside some/all/none, where the data is each list item, not the ${entity}; it reads nothing there.`);
      }
      continue;
    }
    const c = classifyPath(v.path, entity, schema);
    if (c.kind === 'removed') warnings.push(`${at}: "${v.path}" is removed before evaluation (a profile cannot read the score itself); it is always empty.`);
    if (c.kind === 'unknown') warnings.push(`${at}: "${v.path}" is not a field of ${entity}; it is always empty, so the criterion may never be met.`);
    if (c.kind === 'refPath') warnings.push(`${at}: "${v.path}" reads inside "${c.field}", a link to ${c.ref}; links are not expanded (only the id is there), so it is always empty.`);
    if (c.kind === 'arrayAttr') {
      warnings.push(`${at}: "${v.path}" reads an attribute of the list "${c.array}" by name, which is always empty; use {"some": [{"var": "${c.array}"}, <condition on each item>]}.`);
    }
    if (c.kind === 'signal') {
      warnings.push(`${at}: "${v.path}" is an engagement counter; with rules profiles it is only refreshed by a re-score (recompute) or a scheduled cadence, never by normal activity.`);
    }
  }
  if (signalDateComparisons(crit.when).length) {
    blockers.push(`${at}: compares a signals date with a text date; those dates are not converted, so the comparison is always false. Use "daysSinceLastActivity" instead.`);
  }
  return { blockers, warnings };
}

function lintBands(bands, ceiling) {
  const blockers = [];
  const warnings = [];
  if (bands === undefined) return { blockers, warnings, sorted: undefined };
  if (!Array.isArray(bands)) return { blockers: ['bands must be a list.'], warnings, sorted: undefined };
  bands.forEach((b, i) => {
    const at = `bands[${i}]`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      blockers.push(`${at} must be an object.`);
      return;
    }
    const extra = Object.keys(b).filter((k) => !BAND_KEYS.includes(k));
    if (extra.length) blockers.push(`${at}: unknown keys ${extra.join(', ')} (allowed: ${BAND_KEYS.join(', ')}).`);
    if (!b.key && !b.label) blockers.push(`${at}: needs a key or a label (the record stores key, else label).`);
    if (typeof b.min !== 'number' || typeof b.max !== 'number') blockers.push(`${at}: min and max must be numbers.`);
    else {
      if (b.min > b.max) blockers.push(`${at}: min ${b.min} is above max ${b.max}.`);
      if (b.min < 0 || b.max > 100) blockers.push(`${at}: the score is always 0-100; keep min and max inside it.`);
    }
  });
  if (blockers.length) return { blockers, warnings, sorted: undefined };
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.min <= prev.max) warnings.push(`Bands "${prev.key || prev.label}" and "${cur.key || cur.label}" overlap at ${cur.min}-${Math.min(prev.max, cur.max)}; the first in order wins (the script saves them sorted by min).`);
    else if (Number.isInteger(prev.max) && Number.isInteger(cur.min) && cur.min > prev.max + 1) {
      warnings.push(`Scores ${prev.max + 1}-${cur.min - 1} fall in no band (their band will be empty).`);
    }
  }
  if (sorted.length && sorted[0].min > 0) warnings.push(`Scores 0-${sorted[0].min - 1} fall in no band.`);
  if (sorted.length && sorted[sorted.length - 1].max < 100) warnings.push(`Scores ${sorted[sorted.length - 1].max + 1}-100 fall in no band.`);
  if (ceiling !== null) {
    sorted.filter((b) => b.min > ceiling).forEach((b) => warnings.push(`Band "${b.key || b.label}" starts at ${b.min}, above the highest reachable score (${ceiling}): no record can reach it.`));
  }
  return { blockers, warnings, sorted };
}

// The highest score the criteria can give: positive points added up (as if all fired),
// normalized and capped like the engine does.
function ceilingOf(criteria, normalization) {
  if (!Array.isArray(criteria)) return null;
  const positive = criteria.reduce((sum, c) => sum + (c && typeof c.points === 'number' && c.points > 0 ? c.points : 0), 0);
  const norm = normalization || {};
  let value = positive;
  if (norm.mode === 'maxPoints' && Number(norm.maxPoints) > 0) value = Math.round((positive / Number(norm.maxPoints)) * 100);
  return { positivePoints: positive, ceiling: Math.max(0, Math.min(100, Math.round(value))) };
}

function lintProfile(profile, { schema, prefs } = {}) {
  const blockers = [];
  const warnings = [];
  const entity = profile.entity;
  const topFields = new Set(Object.keys(schema || {}));
  if (profile.type && profile.type !== 'rules') {
    warnings.push(`Type "${profile.type}": the AI layer does not run today; this profile scores by its rules only.`);
  }
  if (!SCORED_ENTITIES.includes(entity)) warnings.push(`Entity ${entity} has no score fields: this profile never scores anything (only Contact and Deal do).`);
  if (prefs && !prefs.entities.includes(entity)) warnings.push(`Entity ${entity} is not enabled for scoring in the account settings.`);
  const criteria = Array.isArray(profile.criteria) ? profile.criteria : [];
  if (!criteria.length) warnings.push('No criteria: every record scores 0.');
  const keys = {};
  criteria.forEach((c, i) => {
    const r = lintCriterion(c, i, entity, schema, topFields);
    blockers.push(...r.blockers);
    warnings.push(...r.warnings);
    if (c && c.key) (keys[c.key] = keys[c.key] || []).push(i);
  });
  Object.entries(keys).filter(([, idx]) => idx.length > 1).forEach(([k, idx]) => warnings.push(`Key "${k}" is used by criteria ${idx.join(', ')}.`));
  const norm = profile.normalization || {};
  if (norm.mode && !['sumCapped', 'maxPoints'].includes(norm.mode)) blockers.push('normalization.mode must be "sumCapped" or "maxPoints".');
  if (norm.mode === 'maxPoints' && !(Number(norm.maxPoints) > 0)) blockers.push('normalization.maxPoints must be above 0 with mode "maxPoints" (otherwise the engine adds points up as "sumCapped").');
  const c = ceilingOf(criteria, norm);
  if (c && (norm.mode || 'sumCapped') === 'sumCapped' && c.positivePoints > 100) warnings.push(`Positive points add up to ${c.positivePoints}; the score is capped at 100.`);
  const b = lintBands(profile.bands, c ? c.ceiling : null);
  blockers.push(...b.blockers);
  warnings.push(...b.warnings);
  return { blockers, warnings, ceiling: c, sortedBands: b.sorted };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

function summarize(p) {
  return {
    _id: p._id, scoringName: p.scoringName, scoringCode: p.scoringCode, entity: p.entity, type: p.type || 'rules',
    active: !!p.active, scope: p.workspace ? `workspace ${idOf(p.workspace)}` : 'global',
    criteria: (p.criteria || []).length, bands: (p.bands || []).length, updatedAt: p.updatedAt,
  };
}

async function cmdStatus(client, rest, flags) {
  const [user, prefs] = await Promise.all([me(client), scoringPrefs(client)]);
  const out = {
    switches: prefs,
    keyUser: { email: user.email, primaryWorkspace: user.primaryWorkspace },
    findings: [],
  };
  if (!prefs.enabled) out.findings.push('Scoring is OFF for the account (modules.system.scoring.enabled): nothing is scored. An admin turns it on in the account settings.');
  SCORED_ENTITIES.filter((e) => !prefs.entities.includes(e)).forEach((e) => out.findings.push(`${e} is not in the scored entities: no ${e} profile can be created or applied.`));
  prefs.entities.filter((e) => !SCORED_ENTITIES.includes(e)).forEach((e) => out.findings.push(`${e} is enabled in the settings but has no score fields: it is never scored.`));
  if (!prefs.periodicity) out.findings.push('No scheduled re-score: engagement counters (signals.*) under rules profiles only refresh with a recompute.');
  if (user.primaryWorkspace) {
    out.findings.push(`This key's user has a primary workspace (${user.primaryWorkspace.name || user.primaryWorkspace._id}): profiles it creates apply only to that workspace, never to the whole account.`);
  }
  let profiles;
  try {
    profiles = await allProfiles(client);
  } catch (err) {
    if (!forbidden(err)) throw err;
    out.profiles = 'forbidden';
    out.findings.push('This key cannot read scoring profiles (403): only the switches and the records\' stored scores are visible to it.');
    return out;
  }
  out.profiles = profiles.map(summarize);
  const scopes = {};
  profiles.filter((p) => p.active).forEach((p) => {
    const k = `${p.entity}|${p.workspace ? idOf(p.workspace) : 'global'}`;
    (scopes[k] = scopes[k] || []).push(p.scoringName);
  });
  out.activeByScope = scopes;
  Object.entries(scopes).filter(([, names]) => names.length > 1).forEach(([k, names]) => out.findings.push(`${k} has ${names.length} active profiles (${names.join(', ')}); the most recently updated wins.`));
  for (const e of SCORED_ENTITIES.filter((x) => prefs.entities.includes(x))) {
    if (!scopes[`${e}|global`]) out.findings.push(`No active global ${e} profile: ${e} records outside a workspace with its own profile are not scored.`);
  }
  profiles.filter((p) => p.type && p.type !== 'rules').forEach((p) => out.findings.push(`"${p.scoringName}" is type ${p.type}: the AI layer does not run today, it scores by its rules only.`));
  if (flags.counts) {
    out.counts = {};
    for (const e of SCORED_ENTITIES.filter((x) => prefs.entities.includes(x))) {
      const all = await list(client, OBJECT[e], {}, '_id', 1);
      const scored = await list(client, OBJECT[e], { score: { $exists: true } }, '_id', 1);
      out.counts[e] = { total: all.count, withScore: scored.count, withoutScore: all.count - scored.count };
      const global = applicableProfile(profiles, e, null).profile;
      if (global && global.updatedAt) {
        // Unscored records not saved since the global profile last changed: they wait for a save.
        const waiting = await list(client, OBJECT[e], { score: { $exists: false }, updatedAt: { $lt: global.updatedAt } }, '_id', 5);
        out.counts[e].withoutScoreNotSavedSinceProfile = waiting.count;
        out.counts[e].sampleWithoutScore = waiting.data.map((r) => r._id);
      }
    }
    out.countsNote = 'Records without a score that were not saved since the profile changed get one on their next save. Use explain on a sample id.';
  }
  return out;
}

async function cmdProfiles(client, rest, flags) {
  const profiles = await allProfiles(client);
  return { profiles: profiles.filter((p) => !flags.entity || p.entity === flags.entity).map(summarize) };
}

function readableCriterion(c) {
  return { label: c.label || c.key || c.category || null, key: c.key || null, category: c.category || null, points: c.points, when: c.when === undefined ? null : c.when };
}

async function cmdShow(client, [ref]) {
  if (!ref) throw new UsageError('Usage: show <domain> <profileId | scoringCode>');
  const [p, user, prefs] = await Promise.all([getProfile(client, ref), me(client), scoringPrefs(client)]);
  const lint = lintProfile(p, { schema: user.schemas[p.entity], prefs });
  return {
    profile: summarize(p),
    normalization: p.normalization || { mode: 'sumCapped' },
    criteria: (p.criteria || []).map(readableCriterion),
    bands: p.bands || [],
    highestReachableScore: lint.ceiling,
    problems: lint.blockers,
    warnings: lint.warnings,
  };
}

// ── Explain a record's score ─────────────────────────────────────────────────────────────────────

function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), obj);
}

function shortValue(v) {
  if (Array.isArray(v)) return `[list of ${v.length}]`;
  if (v && typeof v === 'object') return '[object]';
  return v === undefined ? null : v;
}

async function resolveRecord(client, entity, ref) {
  const obj = OBJECT[entity];
  if (ID_RE.test(String(ref))) return { id: ref };
  const escaped = String(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 120);
  const rx = { $regex: `(?i)${escaped}` };
  const xquery = entity === 'Deal' ? { dealName: rx } : (String(ref).includes('@') ? { email: String(ref).toLowerCase() } : { $or: [{ firstName: rx }, { lastName: rx }, { email: rx }] });
  const select = entity === 'Deal' ? 'dealName' : 'firstName lastName email';
  const found = (await list(client, obj, xquery, select, 10)).data;
  if (found.length === 1) return { id: found[0]._id };
  return { matches: found.map((r) => ({ _id: r._id, name: r.dealName || [r.firstName, r.lastName].filter(Boolean).join(' '), email: r.email })) };
}

function storedPart(record) {
  const d = record.scoreDetail || {};
  return {
    score: record.score === undefined ? null : record.score,
    band: record.scoreBand === undefined ? null : record.scoreBand,
    profileUsed: d.scoring ? idOf(d.scoring) : null,
    profileVersion: d.modelVersion || null,
    computedAt: d.computedAt || null,
    source: d.source || null,
    breakdown: d.breakdown || [],
    history: (d.history || []).slice(-5),
  };
}

function criterionRows(profile, previewRules, context) {
  const fired = {};
  (previewRules.breakdown || []).forEach((b) => { fired[b.criterion] = (fired[b.criterion] || 0) + 1; });
  return (profile.criteria || []).map((c) => {
    const name = c.label || c.key || c.category || 'general';
    const met = fired[name] > 0;
    if (met) fired[name] -= 1;
    const reads = {};
    if (c.when && typeof c.when === 'object') {
      collectVars(c.when).filter((v) => !v.inPredicate && v.path).forEach((v) => { reads[v.path] = shortValue(getPath(context, v.path)); });
    }
    return { criterion: name, met, points: met ? c.points : 0, possible: c.points, condition: c.when === undefined ? null : c.when, valuesRead: reads };
  });
}

async function cmdExplain(client, rest, flags) {
  const entity = flags.entity;
  if (!SCORED_ENTITIES.includes(entity) || !flags.record) throw new UsageError('Usage: explain <domain> --entity Contact|Deal --record <id | name | e-mail> [--scoring <profileId>]');
  const resolved = await resolveRecord(client, entity, flags.record);
  if (!resolved.id) return { matches: resolved.matches, blockers: [resolved.matches.length ? 'Several records match: ask which one.' : 'No record matches.'] };
  const nameFields = entity === 'Deal' ? 'dealName stage' : 'firstName lastName email';
  const record = await call(client, 'GET', `/v2/${OBJECT[entity]}/${resolved.id}?${qs({ select: `${nameFields} workspace score scoreBand scoreDetail signals updatedAt` })}`);
  const prefs = await scoringPrefs(client);
  const out = {
    record: { _id: record._id, entity, name: record.dealName || [record.firstName, record.lastName].filter(Boolean).join(' '), workspace: record.workspace ? idOf(record.workspace) : null, updatedAt: record.updatedAt },
    stored: storedPart(record),
    signalsRefreshedAt: (record.signals && record.signals.refreshedAt) || null,
    checklist: [],
  };
  const check = (ok, text) => out.checklist.push({ ok, check: text });
  check(prefs.enabled, 'Scoring is turned on for the account');
  check(prefs.entities.includes(entity), `${entity} is in the scored entities`);
  let profiles;
  try {
    profiles = await allProfiles(client);
  } catch (err) {
    if (!forbidden(err)) throw err;
    out.profileAccess = 'forbidden';
    out.note = 'This key cannot read scoring profiles or run a preview (403). The stored breakdown above is what the platform saved on the record; '
      + 'an admin can explain the criteria that did not count. Do not retry with another key.';
    return out;
  }
  const app = applicableProfile(profiles, entity, record.workspace);
  check(!!app.profile, `An active ${entity} profile applies to this record (its workspace, else global)`);
  const chosen = flags.scoring ? await getProfile(client, flags.scoring) : app.profile;
  if (!chosen) {
    out.cause = 'No active profile applies to this record, so it is not scored.';
    return out;
  }
  if (chosen.entity !== entity) throw new UsageError(`Profile "${chosen.scoringName}" scores ${chosen.entity}, not ${entity}.`);
  const applies = !!app.profile && app.profile._id === chosen._id;
  out.profile = { ...summarize(chosen), appliesToThisRecord: applies, appliesBecause: applies ? `${app.scope} profile` : null };
  const preview = await call(client, 'GET', `/v2/scoring/preview?${qs({ scoringId: chosen._id, recordId: record._id })}`);
  const rules = (preview && preview.rules) || {};
  const context = (preview && preview.context) || {};
  out.now = { score: rules.value, band: rules.band, rawPoints: rules.raw };
  out.criteria = criterionRows(chosen, rules, context);
  if (entity === 'Deal' && context.stage) out.stage = context.stage;
  const findings = [];
  if (out.stored.score === null) {
    findings.push(app.profile ? 'The record has no score: scores are computed only when the record is saved, and it was not saved since a profile applied to it (activating a profile does not re-score existing records).' : 'No profile applies.');
  } else {
    if (app.profile && out.stored.profileUsed && out.stored.profileUsed !== String(app.profile._id)) findings.push('The stored score came from another profile; the record has not been saved since the current profile applied.');
    if (app.profile && out.stored.computedAt && String(app.profile.updatedAt) > String(out.stored.computedAt)) findings.push('The profile changed after this record was last scored; the new rules apply on its next save.');
    const sameProfile = out.stored.profileUsed === String(chosen._id);
    if (rules.value !== undefined && rules.value !== out.stored.score && out.profile.appliesToThisRecord && sameProfile) {
      findings.push(`Stored ${out.stored.score} vs ${rules.value} now: the record would change on its next save (fresh counters, elapsed days or profile edits).`);
    }
  }
  if (context.stage && context.stage.endFlowStage) findings.push('The deal is in a closed stage: most edits and recompute are refused there, so its score stays frozen.');
  if ((chosen.criteria || []).some((c) => /"(signals\.|daysSinceLastActivity|interactions|hasOpenDeal|openDealValue)/.test(JSON.stringify(c.when || {})))) {
    findings.push(`Some criteria read engagement counters. "now" uses fresh counters; the stored score used the counters saved on the record${out.signalsRefreshedAt ? ` (last refreshed ${out.signalsRefreshedAt})` : ', which were never refreshed'}. With rules profiles only a re-score (recompute) refreshes them.`);
  }
  const lint = lintProfile(chosen, { schema: (await me(client)).schemas[entity], prefs });
  out.profileWarnings = lint.warnings;
  out.findings = findings;
  return out;
}

async function cmdTry(client, [ref, ids]) {
  if (!ref || !ids) throw new UsageError('Usage: try <domain> <profileId> <recordId,recordId,…> (at most 10)');
  const list2 = [...new Set(String(ids).split(',').map((s) => s.trim()).filter(Boolean))];
  if (!list2.length || list2.length > MAX_TRY || !list2.every((x) => ID_RE.test(x))) throw new UsageError(`Give 1-${MAX_TRY} record ids (24 hex characters), separated by commas.`);
  const profile = await getProfile(client, ref);
  const results = [];
  for (const id of list2) {
    const stored = await call(client, 'GET', `/v2/${OBJECT[profile.entity] || 'contact'}/${id}?${qs({ select: 'score scoreBand' })}`);
    const pv = await call(client, 'GET', `/v2/scoring/preview?${qs({ scoringId: profile._id, recordId: id })}`);
    const rules = (pv && pv.rules) || {};
    results.push({
      recordId: id, storedScore: stored.score === undefined ? null : stored.score, storedBand: stored.scoreBand || null,
      withThisProfile: { score: rules.value, band: rules.band }, met: (rules.breakdown || []).map((b) => `${b.criterion} ${b.points > 0 ? '+' : ''}${b.points}`),
    });
  }
  return { profile: summarize(profile), results, note: 'Preview only: nothing was saved and no record changed.' };
}

// ── Create or edit a profile ─────────────────────────────────────────────────────────────────────

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    if (!text) throw new UsageError('Missing the plan (inline JSON in single quotes, or a temp file path).');
    assertDataFileAllowed(text, rootDir);
    text = fs.readFileSync(text, 'utf8');
  }
  try {
    const plan = JSON.parse(text);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('not an object');
    return plan;
  } catch {
    throw new UsageError('The plan is not a valid JSON object.');
  }
}

// What a whole-list replacement does, by item name (criteria and bands are sent whole).
function listDiff(before, after) {
  const name = (x, i) => (x && (x.key || x.label)) || `#${i}`;
  const b = new Map((before || []).map((x, i) => [name(x, i), x]));
  const a = new Map((after || []).map((x, i) => [name(x, i), x]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).map((k) => a.get(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)),
    changed: [...a.keys()].filter((k) => b.has(k) && !same(a.get(k), b.get(k))).map((k) => ({ item: k, from: b.get(k), to: a.get(k) })),
    count: { before: (before || []).length, after: (after || []).length },
  };
}

async function buildProfilePlan(client, plan) {
  const blockers = [];
  const warnings = [];
  const set = plan.set;
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new UsageError('The plan needs "set": {…} with the profile fields.');
  for (const k of Object.keys(plan)) if (!['id', 'set'].includes(k)) throw new UsageError(`Unknown plan key "${k}" (allowed: id, set).`);
  for (const k of Object.keys(set)) {
    if (REFUSED_FIELDS[k]) blockers.push(`"${k}" ${REFUSED_FIELDS[k]}.`);
    else if (!PLAN_FIELDS.includes(k)) blockers.push(`"${k}" is not a profile field this skill sets (allowed: ${PLAN_FIELDS.join(', ')}).`);
  }
  const [user, prefs] = await Promise.all([me(client), scoringPrefs(client)]);
  const current = plan.id ? await getProfile(client, plan.id) : null;
  const merged = { ...(current ? clone(current) : { type: 'rules', normalization: { mode: 'sumCapped' } }), ...clone(set) };
  if (merged.type !== 'rules') blockers.push('Only rules profiles are supported: the AI layer (type ai or hybrid) does not run today. Offer a rules profile.');
  if (!merged.scoringName || typeof merged.scoringName !== 'string' || merged.scoringName.length > 200) blockers.push('scoringName is required (text, at most 200 characters).');
  if (set.scoringCode !== undefined && (current || !CODE_RE.test(String(set.scoringCode)))) blockers.push(current ? 'scoringCode cannot change on an existing profile.' : 'scoringCode: letters, digits, dot, dash or underscore only.');
  if (!SCORED_ENTITIES.includes(merged.entity)) blockers.push('entity must be "Contact" or "Deal" (the only records with a score).');
  else if (!prefs.entities.includes(merged.entity)) blockers.push(`${merged.entity} is not enabled for scoring in the account settings; the server rejects the profile. An admin adds it in the account settings.`);
  if (current && set.entity !== undefined && set.entity !== current.entity) blockers.push('The entity of an existing profile cannot change: create a new profile instead.');
  if (!Array.isArray(merged.criteria) || !merged.criteria.length) blockers.push('criteria must be a non-empty list.');
  if (!prefs.enabled) warnings.push('Scoring is OFF for the account: the profile will exist but score nothing until an admin turns it on.');
  // Scope: the server stamps the creator's primary workspace on a profile created without one.
  let workspace = current ? (current.workspace ? idOf(current.workspace) : null) : undefined;
  if (current && set.workspace !== undefined && String(set.workspace) !== String(workspace)) blockers.push('The scope (workspace) of an existing profile cannot change: create a new profile instead.');
  if (!current) {
    if (set.workspace !== undefined && set.workspace !== null && !ID_RE.test(String(set.workspace))) blockers.push('workspace must be a workspace id, or null for the whole account.');
    if (set.workspace === undefined) blockers.push('Say the scope: "workspace": null for the whole account, or a workspace id for one workspace.');
    workspace = set.workspace === undefined ? null : set.workspace;
    if (workspace === null && user.primaryWorkspace) {
      blockers.push(`This key's user has a primary workspace (${user.primaryWorkspace.name || user.primaryWorkspace._id}), so the platform would stamp it on the profile: it cannot create a profile for the whole account. Use a key whose user has no primary workspace, or create it for that workspace.`);
    }
  }
  const lint = lintProfile(merged, { schema: user.schemas[merged.entity], prefs });
  blockers.push(...lint.blockers);
  warnings.push(...lint.warnings.filter((w) => !w.startsWith('Type ')));
  const body = {};
  for (const k of PLAN_FIELDS) {
    if (set[k] === undefined || k === 'workspace') continue;
    body[k] = k === 'bands' && lint.sortedBands ? lint.sortedBands : clone(set[k]);
  }
  if (!current) {
    if (body.type === undefined) body.type = 'rules';
    if (body.normalization === undefined) body.normalization = { mode: 'sumCapped' };
    body.active = false;
    if (workspace) body.workspace = workspace;
  }
  const patch = current ? Object.fromEntries(Object.entries(body).filter(([k, v]) => !same(v, current[k]))) : body;
  if (current && !Object.keys(patch).length) blockers.push('Nothing changes: the plan matches the profile.');
  const profiles = await allProfiles(client);
  const actives = profiles.filter((p) => p.active && p.entity === merged.entity && (p.workspace ? idOf(p.workspace) : null) === (workspace || null));
  if (current && current.active) warnings.push('This profile is ACTIVE: the change applies to each record on its next save (no re-score of existing records).');
  return {
    action: current ? 'update' : 'create',
    profile: current ? summarize(current) : null,
    scope: workspace ? `workspace ${workspace}` : 'whole account',
    activeInSameScope: actives.map((p) => ({ _id: p._id, scoringName: p.scoringName })),
    changes: current ? Object.fromEntries(Object.keys(patch).map((k) => [k, ['criteria', 'bands'].includes(k)
      ? listDiff(current[k], patch[k]) : { from: current[k] === undefined ? null : current[k], to: patch[k] }])) : body,
    highestReachableScore: lint.ceiling,
    blockers,
    warnings,
    body: patch,
    version: hash({ id: current ? current._id : null, updatedAt: current ? current.updatedAt : null, body: patch }),
  };
}

async function cmdPlan(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await buildProfilePlan(client, plan);
  const { body, ...shown } = p;
  return {
    ...shown,
    next: p.blockers.length ? 'Fix the blockers and run plan again. Nothing was written.'
      : `${STOP}After a yes, run: apply <domain> '<same plan>' --version ${p.version} --confirmed. ${p.action === 'create' ? 'The profile is created INACTIVE; test it with try, then activate-preview.' : ''}`,
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version || !flags.confirmed) throw new UsageError('apply needs --version <from plan> and --confirmed.');
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await buildProfilePlan(client, plan);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The profile or the plan changed since the preview. Run plan again and show the new summary.');
  let saved;
  if (p.action === 'create') saved = await call(client, 'POST', '/v2/scoring', { data: p.body, confirmed: true });
  else saved = await call(client, 'PATCH', `/v2/scoring/${p.profile._id}`, { data: p.body, confirmed: true });
  const back = await getProfile(client, saved._id || p.profile._id);
  const mismatches = [];
  for (const [k, v] of Object.entries(p.body)) {
    if (k === 'workspace') {
      if (idOf(back.workspace) !== String(v)) mismatches.push('workspace');
    } else if (!same(back[k], v)) mismatches.push(k);
  }
  if (p.action === 'create' && back.workspace && !p.body.workspace) mismatches.push('workspace (the platform stamped the creator\'s primary workspace)');
  return {
    saved: mismatches.length === 0,
    profile: summarize(back),
    mismatches,
    next: p.action === 'create' ? 'Inactive profile created. Test it with try on a few real records, then activate-preview when the user wants it live.' : 'Saved.',
  };
}

// ── Activate / deactivate ────────────────────────────────────────────────────────────────────────

async function activationPlan(client, ref, activate) {
  const profile = await getProfile(client, ref);
  const prefs = await scoringPrefs(client);
  const blockers = [];
  const warnings = [];
  if (activate && profile.active) blockers.push('The profile is already active.');
  if (!activate && !profile.active) blockers.push('The profile is already inactive.');
  if (activate && (profile.type || 'rules') !== 'rules') blockers.push('Only rules profiles are activated by this skill (the AI layer does not run today).');
  if (!SCORED_ENTITIES.includes(profile.entity)) blockers.push(`${profile.entity} records have no score: activating this profile does nothing.`);
  if (activate && !prefs.enabled) warnings.push('Scoring is OFF for the account: the profile will be active but score nothing until an admin turns it on.');
  const user = await me(client);
  const lint = lintProfile(profile, { schema: user.schemas[profile.entity], prefs });
  if (activate) blockers.push(...lint.blockers);
  const ws = profile.workspace ? idOf(profile.workspace) : null;
  const profiles = await allProfiles(client);
  const displaced = activate ? profiles.filter((p) => p._id !== profile._id && p.active && p.entity === profile.entity && (p.workspace ? idOf(p.workspace) : null) === ws) : [];
  const xquery = ws ? { workspace: ws } : {};
  const inScope = SCORED_ENTITIES.includes(profile.entity) ? (await list(client, OBJECT[profile.entity], xquery, '_id', 1)).count : 0;
  let fallback = null;
  if (!activate) {
    const rest = profiles.filter((p) => p._id !== profile._id);
    const after = ws ? applicableProfile(rest, profile.entity, ws) : applicableProfile(rest.filter((p) => !p.workspace), profile.entity, null);
    fallback = after.profile ? { _id: after.profile._id, scoringName: after.profile.scoringName } : null;
  }
  const effects = activate ? [
    displaced.length ? `Switches OFF ${displaced.map((p) => `"${p.scoringName}"`).join(', ')} (same ${profile.entity}, same scope), silently.` : `No other active ${profile.entity} profile in this scope.`,
    ws ? `Applies to ${profile.entity} records of workspace ${ws} (${inScope} records); other workspaces keep their own or the global profile.`
      : `Applies to ${profile.entity} records of every workspace without its own active profile (${inScope} ${profile.entity} records in the account).`,
    'Existing scores do NOT change now: each record is re-scored on its next save. Re-scoring named records now is a separate step (recompute-preview).',
  ] : [
    `Records keep their current scores (frozen); nothing clears them.${fallback ? ` From their next save, "${fallback.scoringName}" applies instead.` : ' From then on, they are not scored.'}`,
  ];
  return {
    profile: summarize(profile),
    displaced: displaced.map((p) => ({ _id: p._id, scoringName: p.scoringName })),
    fallbackAfterDeactivation: fallback,
    recordsInScope: inScope,
    effects,
    blockers,
    warnings: [...warnings, ...lint.warnings],
    version: hash({ id: profile._id, updatedAt: profile.updatedAt, active: !!profile.active, displaced: displaced.map((p) => p._id) }),
  };
}

async function cmdActivationPreview(activate, client, [ref]) {
  if (!ref) throw new UsageError(`Usage: ${activate ? 'activate' : 'deactivate'}-preview <domain> <profileId>`);
  const p = await activationPlan(client, ref, activate);
  return {
    ...p,
    next: p.blockers.length ? 'Blocked. Nothing was written.' : `${STOP}After a yes, run: ${activate ? 'activate' : 'deactivate'} <domain> ${p.profile._id} --version ${p.version} --confirmed`,
  };
}

async function cmdActivation(activate, client, [ref], flags) {
  if (!ref || !flags.version || !flags.confirmed) throw new UsageError(`${activate ? 'activate' : 'deactivate'} needs <profileId>, --version <from preview> and --confirmed.`);
  const p = await activationPlan(client, ref, activate);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The profiles changed since the preview. Run the preview again and show the new summary.');
  await call(client, 'PATCH', `/v2/scoring/${p.profile._id}`, { data: { active: activate }, confirmed: true });
  const back = await getProfile(client, p.profile._id);
  const stillActive = [];
  for (const d of p.displaced) {
    const other = await getProfile(client, d._id);
    if (other.active) stillActive.push(d.scoringName);
  }
  return {
    saved: !!back.active === activate && !stillActive.length,
    profile: summarize(back),
    switchedOff: activate ? p.displaced.filter((d) => !stillActive.includes(d.scoringName)) : [],
    stillActive,
    effects: p.effects,
  };
}

// ── Re-score named records ───────────────────────────────────────────────────────────────────────

function readRecomputePlan(arg, rootDir) {
  const plan = readPlan(arg, rootDir);
  for (const k of Object.keys(plan)) if (!['entity', 'ids'].includes(k)) throw new UsageError(`Unknown key "${k}": the plan is {"entity": "Contact"|"Deal", "ids": [...]} only (never a query).`);
  if (!SCORED_ENTITIES.includes(plan.entity)) throw new UsageError('entity must be "Contact" or "Deal".');
  if (!Array.isArray(plan.ids) || !plan.ids.length) throw new UsageError('ids must be a non-empty list of record ids the user named.');
  const ids = [...new Set(plan.ids.map(String))];
  if (ids.length > MAX_RECOMPUTE) throw new UsageError(`At most ${MAX_RECOMPUTE} records per re-score; never a whole entity.`);
  if (!ids.every((id) => ID_RE.test(id))) throw new UsageError('Every id must be 24 hex characters.');
  return { entity: plan.entity, ids: ids.sort() };
}

async function recomputePlan(client, plan) {
  const { entity, ids } = plan;
  const blockers = [];
  const warnings = [];
  const prefs = await scoringPrefs(client);
  if (!prefs.enabled) blockers.push('Scoring is OFF for the account: a re-score would refresh counters but give no score.');
  if (!prefs.entities.includes(entity)) blockers.push(`${entity} is not enabled for scoring; the server rejects the re-score.`);
  const profiles = await allProfiles(client);
  const select = entity === 'Deal' ? 'dealName stage workspace score scoreBand' : 'firstName lastName email workspace score scoreBand';
  const records = (await list(client, OBJECT[entity], { _id: { $in: ids } }, select, MAX_RECOMPUTE)).data;
  const missing = ids.filter((id) => !records.some((r) => String(r._id) === id));
  if (missing.length) blockers.push(`Not found or not visible to this key: ${missing.join(', ')}.`);
  let closed = [];
  if (entity === 'Deal') {
    const stageIds = [...new Set(records.map((r) => idOf(r.stage)).filter(Boolean))];
    const stages = stageIds.length ? (await list(client, 'stage', { _id: { $in: stageIds } }, 'stageName endFlowStage', 200)).data : [];
    const closedStages = new Set(stages.filter((s) => s.endFlowStage).map((s) => String(s._id)));
    closed = records.filter((r) => closedStages.has(idOf(r.stage))).map((r) => r._id);
    if (closed.length) warnings.push(`${closed.length} deal(s) are in a closed stage: the platform refuses to save them, so they will be counted as failed.`);
  }
  const hooks = (await list(client, 'webhook', { active: true }, 'webhookName endpoint eventNames active', 200)).data
    .filter((w) => (w.eventNames || []).some((e) => e === `${entity}.update` || e === `${entity}.*`));
  const triggers = (await list(client, 'eventtrigger', { active: true, modelName: entity, eventName: 'afterUpdate' }, 'name eventName modelName', 200)).data;
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  const sideEffects = [
    `Each of the ${records.length} records is saved again (counters refreshed, score recomputed).`,
    hooks.length ? `Fires ${hooks.length} webhook(s) once per record: ${hooks.map((w) => `"${w.webhookName}" → ${hostOf(w.endpoint)}`).join('; ')}.` : `No active ${entity}.update webhook.`,
    triggers.length ? `Runs ${triggers.length} AI agent trigger(s) on update per record.` : 'No AI agent trigger on update.',
    entity === 'Deal' ? 'Anyone viewing these proposals sees a "modified" refresh, and proposal versions may be generated.'
      : 'Contact change notifications may go to the assignee and collaborators.',
  ];
  return {
    entity,
    records: records.map((r) => {
      const app = applicableProfile(profiles, entity, r.workspace);
      return { _id: r._id, name: r.dealName || [r.firstName, r.lastName].filter(Boolean).join(' '), score: r.score === undefined ? null : r.score, band: r.scoreBand || null, profile: app.profile ? app.profile.scoringName : null, closedStage: closed.includes(r._id) };
    }),
    sideEffects,
    blockers,
    warnings,
    version: hash({ entity, ids, hooks: hooks.map((w) => w._id), triggers: triggers.map((t) => t._id) }),
  };
}

async function cmdRecomputePreview(client, [planArg], flags, ctx) {
  const p = await recomputePlan(client, readRecomputePlan(planArg, ctx.rootDir));
  return {
    ...p,
    next: p.blockers.length ? 'Blocked. Nothing was written.'
      : `${STOP}This reaches people and outside systems (side effects above). After a yes to exactly that, run: recompute <domain> '<same plan>' --version ${p.version} --confirmed --reaches-people`,
  };
}

async function cmdRecompute(client, [planArg], flags, ctx) {
  if (!flags.version || !flags.confirmed || !flags.reachesPeople) throw new UsageError('recompute needs --version <from preview>, --confirmed and --reaches-people.');
  const plan = readRecomputePlan(planArg, ctx.rootDir);
  const p = await recomputePlan(client, plan);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('Records, webhooks or triggers changed since the preview. Run recompute-preview again.');
  const res = await call(client, 'POST', '/v2/scoring/recompute', {
    data: { entity: plan.entity, query: { _id: { $in: plan.ids } } }, confirmed: true, reachesPeople: true,
  });
  const select = plan.entity === 'Deal' ? 'dealName score scoreBand scoreDetail.computedAt' : 'firstName lastName score scoreBand scoreDetail.computedAt';
  const after = (await list(client, OBJECT[plan.entity], { _id: { $in: plan.ids } }, select, MAX_RECOMPUTE)).data;
  const before = Object.fromEntries(p.records.map((r) => [String(r._id), r]));
  return {
    saved: (res && res.processed) === plan.ids.length,
    processed: res && res.processed,
    failed: res && res.failed,
    records: after.map((r) => ({
      _id: r._id, before: before[String(r._id)] ? before[String(r._id)].score : null, after: r.score === undefined ? null : r.score, band: r.scoreBand || null,
      computedAt: r.scoreDetail ? r.scoreDetail.computedAt : null,
    })),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const USAGE = `Usage: scoring.js <command> <domain> …
  status            <domain> [--counts]
  profiles          <domain> [--entity Contact|Deal]
  show              <domain> <profileId | scoringCode>
  explain           <domain> --entity Contact|Deal --record <id | name | e-mail> [--scoring <profileId>]
  try               <domain> <profileId> <recordId,…>           (preview, at most 10)
  plan              <domain> '<plan>'     →  apply <domain> '<plan>' --version v --confirmed
  activate-preview  <domain> <profileId>  →  activate <domain> <profileId> --version v --confirmed
  deactivate-preview <domain> <profileId> →  deactivate <domain> <profileId> --version v --confirmed
  recompute-preview <domain> '{"entity":"Contact","ids":[…]}'  →  recompute … --version v --confirmed --reaches-people
Every command takes --profile <name>.`;

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = ['version', 'profile', 'entity', 'record', 'scoring'];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (arg === '--counts') flags.counts = true;
    else if (arg.startsWith('--') && valued.includes(arg.slice(2))) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[arg.slice(2)] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (flags.entity !== undefined && !SCORED_ENTITIES.includes(flags.entity)) throw new UsageError('--entity must be Contact or Deal (the only records with a score).');
  if (flags.scoring !== undefined && !ID_RE.test(flags.scoring)) throw new UsageError('--scoring must be a profile id (24 hex characters).');
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  status: cmdStatus,
  profiles: cmdProfiles,
  show: cmdShow,
  explain: cmdExplain,
  try: cmdTry,
  plan: cmdPlan,
  apply: cmdApply,
  'activate-preview': (...a) => cmdActivationPreview(true, ...a),
  activate: (...a) => cmdActivation(true, ...a),
  'deactivate-preview': (...a) => cmdActivationPreview(false, ...a),
  deactivate: (...a) => cmdActivation(false, ...a),
  'recompute-preview': cmdRecomputePreview,
  recompute: cmdRecompute,
};
const WRITES = ['apply', 'activate', 'deactivate', 'recompute'];

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can grant the permission.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(USAGE);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (WRITES.includes(command) && !result.saved) return 1;
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
    if (forbidden(err)) {
      stderr.write(`FORBIDDEN: ${hide(err.message)}\n${FORBIDDEN_HINT}\n`);
      return 1;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, lintProfile, lintCriterion, lintBands, ceilingOf, classifyPath, collectVars, applicableProfile,
};
