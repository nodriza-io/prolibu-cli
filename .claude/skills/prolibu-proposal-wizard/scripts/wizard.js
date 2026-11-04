#!/usr/bin/env node
'use strict';

// Proposal wizards (the public quote page /pw/<code>), the way the Prolibu app handles them.
//
//   wizard.js list            <domain>
//   wizard.js show            <domain> <wizardCode|id>
//   wizard.js doctor          <domain> <wizardCode|id>
//   wizard.js deals           <domain> <wizardCode|id> [--since YYYY-MM-DD] [--email <visitor>] [--limit <n>]
//   wizard.js public-check    <domain> <wizardCode|id>
//   wizard.js links           <domain> <wizardCode|id> [--lock]
//   wizard.js preview-create  <domain> '<plan>'                  then create   <domain> '<plan>' --version <v> --confirmed
//   wizard.js preview-update  <domain> <wizard> '<plan>'         then update   <domain> <wizard> '<plan>' --version <v> --confirmed [--rename-link]
//   wizard.js preview-publish <domain> <wizard>                  then publish  <domain> <wizard> --version <v> --confirmed
//   wizard.js preview-unpublish <domain> <wizard>                then unpublish <domain> <wizard> --version <v> --confirmed
//   wizard.js preview-group   <domain> '<plan>'                  then group    <domain> '<plan>' --version <v> --confirmed
//   wizard.js preview-shortlink <domain> <wizard> '<plan>'       then shortlink <domain> <wizard> '<plan>' --version <v> --confirmed
//
// Plans are inline JSON or the path of a JSON file in a temp folder (see SKILL.md for each shape).
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).
// This script never submits the public form: a submission creates a contact and a deal and
// e-mails the address typed in it.

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, validateTarget, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHORT_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED = 3;
const TIMEOUT_MS = 30000;
const PAGE_LANGUAGES = ['es', 'en', 'pt'];
const PW_GROUP_TYPE = 'Proposal Wizard';
const TSD_STRATEGIES = ['Real-Time', 'Limited-Time'];
const SETTABLE = ['proposalWizardName', 'assignmentGroup', 'wizardGroup', 'proposalPreset', 'lineItemsSource', 'contactFields',
  'dealFields', 'appearance', 'displaySettings', 'termsAndConditions', 'allowMultipleLineItems', 'createVersionPerLineItem',
  'allowSignIn', 'requireAuthentication', 'htmlHeader', 'language', 'form'];
const BOOLEAN_FIELDS = ['allowMultipleLineItems', 'createVersionPerLineItem', 'allowSignIn', 'requireAuthentication'];
// Keys the anonymous page must never receive (wizard and catalog line).
const PRIVATE_CONFIG_KEYS = ['proposalPreset', 'assignmentGroup', 'lineItemsSource'];
const PRIVATE_LINE_KEYS = ['cost', 'internalNotes', 'rules', 'scripts', 'snippets', 'specialNotes', 'markupRate'];
// Routes that create a contact and a deal and e-mail the visitor. This script never calls them.
const SUBMIT_ROUTE = /^\/v2\/proposalwizard\/(generate|pairsubmit)(\/|\?|$)/i;

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fullName = (u) => (u && typeof u === 'object' ? [u.firstName, u.lastName].filter(Boolean).join(' ') || null : null);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);

function humanDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  for (const [name, size] of units) {
    if (ms >= size) {
      const n = Math.round((ms / size) * 10) / 10;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${ms} ms`;
}

// Objects merge key by key with what is stored; arrays and plain values replace it whole.
function deepMerge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

// Leaf-level differences between two values, as dotted paths.
function diffPaths(before, after, prefix = '') {
  if (isPlain(after) && isPlain(before)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => (k in after ? diffPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k) : []));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ field: prefix, from: before === undefined ? null : before, to: after }];
}

function wizardLink(domain, code) {
  return `https://${domain}/pw/${encodeURIComponent(code)}`;
}

function productLink(domain, code, entryIds, lock) {
  const params = new URLSearchParams({ pbe: entryIds.join(',') });
  if (lock) params.set('avoidChangeProduct', 'true');
  return `${wizardLink(domain, code)}?${params.toString().replace(/%2C/g, ',')}`;
}

function needRef(value, name) {
  if (typeof value !== 'string' || !REF_RE.test(value)) throw new UsageError(`${name} must be a code or a 24-character id.`);
  return value;
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim()) throw new UsageError('Missing the plan (inline JSON or a temp file path).');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the plan file ${arg}.`);
    }
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!isPlain(plan)) throw new UsageError('The plan must be a JSON object.');
  return plan;
}

// Checks the wizard fields a plan sets. Returns warnings; throws UsageError on a wrong shape.
function validateSet(set, { creating }) {
  if (!isPlain(set) || !Object.keys(set).length) throw new UsageError('"set" must be an object with the wizard fields to write.');
  const warnings = [];
  for (const key of Object.keys(set)) {
    if (key === 'active') throw new UsageError('"active" is not set here: use preview-publish / preview-unpublish, each with its own yes.');
    if (key === 'proposalWizardCode') {
      if (creating) throw new UsageError('The server makes the code from the name; do not send proposalWizardCode on create.');
      continue;
    }
    if (!SETTABLE.includes(key)) throw new UsageError(`Unknown or read-only wizard field "${key}". Allowed: ${SETTABLE.join(', ')}.`);
  }
  for (const key of BOOLEAN_FIELDS) {
    if (key in set && typeof set[key] !== 'boolean') throw new UsageError(`${key} must be true or false.`);
  }
  for (const key of ['proposalPreset', 'lineItemsSource', 'contactFields', 'dealFields', 'appearance', 'displaySettings', 'termsAndConditions']) {
    if (key in set && set[key] !== null && !isPlain(set[key])) throw new UsageError(`${key} must be an object.`);
  }
  if ('proposalWizardName' in set && (typeof set.proposalWizardName !== 'string' || !set.proposalWizardName.trim())) {
    throw new UsageError('proposalWizardName must be a non-empty text.');
  }
  if ('language' in set) {
    if (typeof set.language !== 'string' || !/^[a-z]{2}$/.test(set.language)) throw new UsageError('language must be a two-letter code such as "es".');
    if (!PAGE_LANGUAGES.includes(set.language)) {
      warnings.push(`The public page has texts only in es, en and pt: with "${set.language}" the page shows Spanish (the e-mail to the visitor uses "${set.language}").`);
    }
  }
  const preset = set.proposalPreset || {};
  for (const key of ['expirationDays', 'unpublishedDays']) {
    if (key in preset && (typeof preset[key] !== 'number' || preset[key] < 0)) throw new UsageError(`proposalPreset.${key} must be a number of days.`);
  }
  const tsd = preset.timeSensitiveDiscounts;
  if (tsd && tsd.enabled) {
    if (!TSD_STRATEGIES.includes(tsd.strategy)) throw new UsageError(`timeSensitiveDiscounts.strategy must be one of ${TSD_STRATEGIES.join(', ')}.`);
    if (typeof tsd.time !== 'number' || tsd.time <= 0) throw new UsageError('timeSensitiveDiscounts.time must be a positive number of MILLISECONDS (1 hour = 3600000).');
    if (tsd.time < 60000) warnings.push(`timeSensitiveDiscounts.time is ${tsd.time} ms (${humanDuration(tsd.time)}). The platform reads MILLISECONDS: 1 hour = 3600000.`);
    const pct = tsd.overrideDiscount && tsd.overrideDiscount.percentage;
    if (pct !== undefined && (typeof pct !== 'number' || pct < 0 || pct > 1)) throw new UsageError('overrideDiscount.percentage is a decimal (15% = 0.15).');
    if (tsd.overrideDiscount) warnings.push('overrideDiscount replaces the discount of EVERY line, preset lines included.');
  }
  if ('htmlHeader' in set && typeof set.htmlHeader !== 'string') throw new UsageError('htmlHeader must be text.');
  if (set.requireAuthentication === true && set.allowSignIn === false) {
    throw new UsageError('requireAuthentication needs allowSignIn: true (advisors sign in on the page).');
  }
  return warnings;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function call(client, method, reqPath, opts) {
  if (SUBMIT_ROUTE.test(reqPath) && !(opts && opts.reachesPeople)) {
    throw new UsageError('This script never submits the public form (it creates a contact and a deal and e-mails the visitor).');
  }
  const res = await client.request(method, reqPath, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function tryGet(client, reqPath) {
  const res = await client.request('GET', reqPath);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`GET ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

// The public page, as an anonymous visitor gets it: no key, only this account's host.
const PUBLIC_PATH_RE = /^\/(pw|pwg)\/[A-Za-z0-9._-]{1,128}$|^\/v2\/proposalWizard(Group)?\/(getUiConfig|fetch)\/[A-Za-z0-9._-]{1,128}$/;

async function publicGet(ctx, domain, reqPath) {
  validateTarget(domain, '/v2/');
  if (!PUBLIC_PATH_RE.test(reqPath)) throw new UsageError('Refusing an anonymous request outside the public wizard paths.');
  const res = await ctx.fetchImpl(`https://${domain}${reqPath}`, {
    method: 'GET', headers: { Accept: reqPath.startsWith('/v2/') ? 'application/json' : 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body = text;
  if (reqPath.startsWith('/v2/')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  const header = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
  return { status: res.status, body, text, header };
}

async function findWizard(client, ref) {
  needRef(ref, 'The wizard');
  const wizard = await tryGet(client, `/v2/proposalwizard/${encodeURIComponent(ref)}`);
  if (!wizard || !wizard._id) throw new Blocked(`No proposal wizard "${ref}". Run list to see the codes.`);
  return wizard;
}

// A reference given by id, code (primary key) or exact name. Never guessed.
async function resolveRef(client, object, ref, { nameField, select, xquery = {} }) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref !== 'string') throw new UsageError(`${object} must be given as an id, code or exact name.`);
  if (ID_RE.test(ref) || REF_RE.test(ref)) {
    const direct = await tryGet(client, `/v2/${object}/${encodeURIComponent(ref)}?${qs({ select })}`);
    if (direct && direct._id) return direct;
  }
  const body = await call(client, 'GET', `/v2/${object}?${qs({ xquery: { ...xquery, [nameField]: ref }, select, limit: '5' })}`);
  const rows = rowsOf(body);
  if (rows.length > 1) throw new Blocked(`Several ${object} records are named "${ref}". Use the id.`);
  if (!rows.length) throw new Blocked(`No ${object} "${ref}" (by id, code or exact name).`);
  return rows[0];
}

async function usersByIds(client, ids) {
  if (!ids.length) return [];
  const body = await call(client, 'GET', `/v2/user?${qs({ xquery: { _id: { $in: ids } }, select: 'firstName lastName email status', limit: String(Math.max(ids.length, 1)) })}`);
  return rowsOf(body);
}

async function loadGroup(client, ref) {
  const group = await resolveRef(client, 'usergroup', ref, { nameField: 'userGroupName', select: 'userGroupName userGroupType users enableLoadBalancing updatedAt' });
  const ids = (group.users || []).map(idOf);
  const found = await usersByIds(client, ids);
  const users = ids.map((uid) => {
    const u = found.find((r) => idOf(r) === uid);
    return u ? { _id: uid, name: fullName(u), email: u.email, status: u.status } : { _id: uid, name: null, email: null, status: 'unreadable' };
  });
  return { group, users };
}

function summarizeGroup({ group, users }) {
  return {
    _id: idOf(group),
    name: group.userGroupName,
    type: group.userGroupType,
    assignment: group.enableLoadBalancing ? 'round-robin (in list order; each submission moves the chosen user to the end)' : 'random among active users',
    users,
    activeUsers: users.filter((u) => u.status === 'Active').length,
    updatedAt: group.updatedAt,
  };
}

// Active entries the wizard offers, with their product, as generate() accepts them.
async function loadCatalog(client, source) {
  const pricebook = source && source.pricebook ? idOf(source.pricebook) : null;
  const loose = ((source && source.pricebookEntries) || []).map(idOf);
  const or = [];
  if (pricebook) or.push({ pricebook });
  if (loose.length) or.push({ _id: { $in: loose } });
  if (!or.length) return { entries: [], pricebook: null };
  const body = await call(client, 'GET', `/v2/pricebookentry?${qs({
    xquery: { $or: or, active: true },
    select: 'pricebookEntryCode price currency active product pricebook',
    populatePath: [{ path: 'product', select: 'productName productCode active' }, { path: 'pricebook', select: 'pricebookName active' }],
    limit: '200',
  })}`);
  const entries = rowsOf(body).map((e) => ({
    _id: idOf(e),
    product: e.product && e.product.productName ? e.product.productName : idOf(e.product),
    productActive: e.product && typeof e.product === 'object' ? e.product.active !== false : null,
    pricebook: e.pricebook && e.pricebook.pricebookName ? e.pricebook.pricebookName : idOf(e.pricebook),
    pricebookActive: e.pricebook && typeof e.pricebook === 'object' ? e.pricebook.active !== false : null,
    price: e.price,
    currency: e.currency || null,
    code: e.pricebookEntryCode,
  }));
  const pb = pricebook ? await tryGet(client, `/v2/pricebook/${pricebook}?${qs({ select: 'pricebookName active updatedAt' })}`) : null;
  return { entries, pricebook: pb, pricebookId: pricebook, count: (body.pagination && body.pagination.count) || entries.length };
}

// ─── Diagnosis shared by doctor and the previews ───────────────────────────────

// Findings: level "error" loses submissions or the page; "warning" works but surprises; "info" explains.
async function analyze(client, wizard) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  const loaded = {};

  if (wizard.active === false) add('info', 'inactive', 'The wizard is not published: its link answers "not active" and nothing can be submitted.');

  // Assignment group.
  if (!wizard.assignmentGroup) {
    add('error', 'noGroup', 'No assignment group: the server refuses the wizard.');
  } else {
    let g = null;
    try {
      g = await loadGroup(client, idOf(wizard.assignmentGroup));
    } catch (e) {
      if (e instanceof Blocked) add('error', 'groupMissing', 'The assignment group does not exist: every submission fails and the visitor\'s quote is lost.');
      else throw e;
    }
    if (g) {
      loaded.group = summarizeGroup(g);
      if (g.group.userGroupType !== PW_GROUP_TYPE) {
        add('warning', 'groupType', `The assignment group is of type "${g.group.userGroupType}", not "${PW_GROUP_TYPE}". The server accepts it, but the app's picker hides it and other features may use the same group.`);
      }
      const unreadable = g.users.filter((u) => u.status === 'unreadable').length;
      if (!g.users.length) {
        add('error', 'emptyGroup', 'The assignment group has no users: every anonymous submission fails and the visitor\'s quote is lost.');
      } else if (!loaded.group.activeUsers && !unreadable) {
        add('error', 'noActiveUsers', 'The assignment group has no active users: every anonymous submission fails and the visitor\'s quote is lost.');
      } else if (!loaded.group.activeUsers) {
        add('warning', 'activeUnknown', 'No user of the group is readable as active with this profile; if none is active, submissions fail and the quote is lost.');
      }
      if (unreadable) add('warning', 'unreadableUsers', `${unreadable} user(s) of the group cannot be read with this profile (another workspace or removed). Deals can still be assigned to them; their raw ids are listed.`);
      const inactive = g.users.filter((u) => u.status && u.status !== 'Active' && u.status !== 'unreadable').length;
      if (inactive) add('info', 'inactiveUsers', `${inactive} user(s) of the group are not active: they are skipped.`);
      add('info', 'assignment', g.group.enableLoadBalancing
        ? 'Round-robin: each submission goes to the next active user and rewrites the group\'s user order.'
        : 'Random: each submission goes to a random active user of the group (enableLoadBalancing off).');
    }
  }
  if (wizard.allowSignIn) {
    add('info', 'advisorTakesDeal', 'allowSignIn is on: when a signed-in advisor submits, the deal goes to that advisor, not to the group.');
  }

  // Catalog.
  const catalog = await loadCatalog(client, wizard.lineItemsSource);
  loaded.catalog = catalog;
  const offered = catalog.entries.filter((e) => e.productActive !== false && e.pricebookActive !== false);
  if (!offered.length) {
    add('error', 'noProducts', 'The wizard offers no active product: the page shows nothing to choose and every submission is refused (400).');
  }
  if (catalog.pricebook && catalog.pricebook.active === false) add('warning', 'pricebookInactive', 'The base price list is inactive: its products are not offered.');
  const dropped = catalog.entries.length - offered.length;
  if (dropped) add('warning', 'inactiveProducts', `${dropped} entr${dropped === 1 ? 'y has' : 'ies have'} an inactive product or price list: not offered.`);
  const currencies = [...new Set(offered.map((e) => e.currency).filter(Boolean))];
  if (currencies.length > 1) add('warning', 'mixedCurrencies', `The catalog mixes currencies (${currencies.join(', ')}).`);
  const advisorLists = ((wizard.lineItemsSource && wizard.lineItemsSource.advisorPricebooks) || []).length;
  if (advisorLists && !wizard.allowSignIn) add('warning', 'advisorListsUnused', 'Advisor price lists are set but allowSignIn is off: nobody can use them.');
  if (wizard.requireAuthentication && !wizard.allowSignIn) add('warning', 'authWithoutSignIn', 'requireAuthentication is on without allowSignIn.');

  // Preset and texts.
  const preset = wizard.proposalPreset || {};
  if (!preset.title) add('error', 'noTitle', 'proposalPreset.title is required.');
  if (preset.layout) {
    const layout = await tryGet(client, `/v2/contenttemplate/${idOf(preset.layout)}?${qs({ select: 'contentTemplateName templateType' })}`);
    if (!layout) add('warning', 'layoutMissing', 'The proposal layout of the preset does not exist.');
    else if (layout.templateType !== 'layout') add('warning', 'layoutType', `The preset layout is a "${layout.templateType}" template, not a layout.`);
  }
  if (preset.stage) {
    const stage = await tryGet(client, `/v2/stage/${idOf(preset.stage)}?${qs({ select: 'stageName' })}`);
    if (!stage) add('warning', 'stageMissing', 'The preset stage does not exist.');
  }
  const presetLines = ((preset.quote && preset.quote.lineItems) || []).length;
  if (presetLines) add('info', 'presetLines', `${presetLines} preset line(s) go first in every quote the wizard creates.`);
  const tsd = preset.timeSensitiveDiscounts;
  if (tsd && tsd.enabled) {
    add('info', 'timeDiscount', `Time-sensitive discount: ${tsd.strategy || '?'} for ${humanDuration(tsd.time) || '?'} (stored in milliseconds: ${tsd.time}).`);
    if (typeof tsd.time === 'number' && tsd.time < 60000) add('warning', 'timeDiscountShort', 'The discount time is under one minute: it was probably typed in seconds or minutes, but the platform reads milliseconds.');
  }
  if (wizard.language && !PAGE_LANGUAGES.includes(wizard.language)) {
    add('warning', 'language', `Language "${wizard.language}": the page has texts only in es, en and pt, so it shows Spanish.`);
  }
  const terms = wizard.termsAndConditions || {};
  if (terms.enabled && !terms.documentUrl && !terms.acceptanceText) add('warning', 'termsEmpty', 'Terms are on but have no text or document link.');

  // Linked form.
  if (wizard.form) {
    const form = await tryGet(client, `/v2/form/${idOf(wizard.form)}?${qs({ select: 'formName active type access' })}`);
    const access = (form && form.access) || {};
    if (!form) add('warning', 'formMissing', 'The linked form does not exist: its extra fields are dropped.');
    else if (form.active === false || form.type === 'meta') add('warning', 'formInactive', 'The linked form is inactive: its extra fields are dropped silently (the deal is still created).');
    else if ((access.mode || 'public') === 'public' && access.enableCaptcha !== false) add('warning', 'formCaptcha', 'The linked form has its captcha on (the default): the wizard cannot pass it, so the extra fields are dropped silently. Turn the form\'s captcha off (prolibu-forms).');
    else if (access.mode === 'password') add('warning', 'formPassword', 'The linked form is password-protected: the extra fields are dropped silently.');
    if (form) loaded.form = { _id: idOf(form), name: form.formName, active: form.active !== false, mode: access.mode || 'public', captcha: access.enableCaptcha !== false };
  }

  // Siblings in a wizard group.
  if (wizard.wizardGroup) {
    const body = await call(client, 'GET', `/v2/proposalwizard?${qs({ xquery: { wizardGroup: idOf(wizard.wizardGroup) }, select: 'proposalWizardCode active', limit: '100' })}`);
    const inactive = rowsOf(body).filter((w) => w.active === false && idOf(w) !== idOf(wizard)).map((w) => w.proposalWizardCode);
    if (inactive.length) add('warning', 'inactiveSiblings', `The page's wizard switcher also lists inactive wizards of the same group (${inactive.join(', ')}); a visitor who picks one gets an error.`);
  }
  return { findings, loaded };
}

const errorsOf = (findings) => findings.filter((f) => f.level === 'error').map((f) => f.message);

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdList(client) {
  const body = await call(client, 'GET', `/v2/proposalwizard?${qs({
    select: 'proposalWizardCode proposalWizardName active assignmentGroup wizardGroup lineItemsSource.pricebook allowSignIn requireAuthentication updatedAt',
    populatePath: [{ path: 'assignmentGroup', select: 'userGroupName userGroupType' }, { path: 'lineItemsSource.pricebook', select: 'pricebookName' }],
    sort: 'proposalWizardName',
    limit: '100',
  })}`);
  const rows = rowsOf(body).map((w) => ({
    _id: idOf(w),
    code: w.proposalWizardCode,
    name: w.proposalWizardName,
    active: w.active !== false,
    group: w.assignmentGroup && w.assignmentGroup.userGroupName ? `${w.assignmentGroup.userGroupName} (${w.assignmentGroup.userGroupType})` : idOf(w.assignmentGroup) || null,
    basePriceList: w.lineItemsSource && w.lineItemsSource.pricebook ? w.lineItemsSource.pricebook.pricebookName || idOf(w.lineItemsSource.pricebook) : null,
    access: w.requireAuthentication ? 'advisors only' : w.allowSignIn ? 'anyone + advisors' : 'anyone',
    link: wizardLink(client.domain, w.proposalWizardCode),
  }));
  return { count: (body.pagination && body.pagination.count) || rows.length, wizards: rows };
}

function wizardSummary(domain, w) {
  return {
    _id: idOf(w),
    code: w.proposalWizardCode,
    name: w.proposalWizardName,
    active: w.active !== false,
    link: wizardLink(domain, w.proposalWizardCode),
    language: w.language || null,
    access: w.requireAuthentication ? 'advisors only' : w.allowSignIn ? 'anyone + advisors' : 'anyone',
    asks: { email: true, ...(w.contactFields || {}), observations: !!(w.dealFields && w.dealFields.observations) },
    multipleProducts: !!w.allowMultipleLineItems,
    versionPerLine: !!w.createVersionPerLineItem,
    preset: w.proposalPreset || {},
    display: w.displaySettings || {},
    terms: w.termsAndConditions || {},
    htmlHeader: w.htmlHeader ? `${String(w.htmlHeader).length} characters` : null,
    updatedAt: w.updatedAt,
  };
}

async function cmdShow(client, [ref], flags, ctx) {
  const wizard = await findWizard(client, ref);
  const { findings, loaded } = await analyze(client, wizard);
  const anon = await publicGet(ctx, client.domain, `/v2/proposalWizard/getUiConfig/${encodeURIComponent(wizard.proposalWizardCode)}`);
  const visitor = anon.status === 200 && anon.body
    ? { status: 200, products: (anon.body.lineItems || []).map((l) => ({ pricebookEntry: idOf(l.pricebookEntry), product: l.productName, price: l.price, currency: l.currency })) }
    : { status: anon.status, error: anon.body && anon.body.error ? anon.body.error : null };
  return {
    wizard: wizardSummary(client.domain, wizard),
    group: loaded.group || null,
    catalog: { basePriceList: loaded.catalog.pricebook ? loaded.catalog.pricebook.pricebookName : null, entries: loaded.catalog.entries },
    form: loaded.form || null,
    visitorSees: visitor,
    findings,
  };
}

async function cmdDoctor(client, [ref], flags, ctx) {
  const wizard = await findWizard(client, ref);
  const { findings, loaded } = await analyze(client, wizard);
  const anon = await publicGet(ctx, client.domain, `/v2/proposalWizard/getUiConfig/${encodeURIComponent(wizard.proposalWizardCode)}`);
  if (wizard.active !== false && anon.status === 401 && wizard.requireAuthentication) {
    findings.push({ level: 'info', code: 'advisorsOnly', message: 'Advisors only: an anonymous visitor is asked to sign in.' });
  } else if (wizard.active !== false && anon.status !== 200) {
    findings.push({ level: 'error', code: 'pageFails', message: `The public page config answers ${anon.status}${anon.body && anon.body.error ? ` (${anon.body.error})` : ''}.` });
  }
  if (anon.status === 200 && anon.body && !anon.body.turnstileSiteKey) {
    findings.push({ level: 'info', code: 'noCaptcha', message: 'No captcha on the page (the account has no Cloudflare Turnstile credential): anyone can submit any e-mail.' });
  }
  return {
    wizard: { _id: idOf(wizard), code: wizard.proposalWizardCode, name: wizard.proposalWizardName, active: wizard.active !== false, link: wizardLink(client.domain, wizard.proposalWizardCode) },
    group: loaded.group || null,
    offeredProducts: loaded.catalog.entries.filter((e) => e.productActive !== false && e.pricebookActive !== false).length,
    ok: !findings.some((f) => f.level === 'error'),
    findings,
  };
}

async function cmdDeals(client, [ref], flags) {
  const wizard = await findWizard(client, ref);
  const xquery = { proposalWizard: idOf(wizard) };
  if (flags.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.since)) throw new UsageError('--since must be YYYY-MM-DD.');
    xquery.createdAt = { $gte: `${flags.since}T00:00:00.000Z` };
  }
  if (flags.email) {
    if (!EMAIL_RE.test(flags.email)) throw new UsageError('--email must be an e-mail address.');
    const contacts = rowsOf(await call(client, 'GET', `/v2/contact?${qs({ xquery: { email: flags.email.toLowerCase() }, select: '_id', limit: '50' })}`));
    if (!contacts.length) return { wizard: wizard.proposalWizardCode, count: 0, deals: [], note: `No contact with the e-mail ${flags.email}: the submission never reached the server, or it failed.` };
    xquery.contact = { $in: contacts.map(idOf) };
  }
  const limit = String(Math.min(Math.max(Number(flags.limit) || 20, 1), 100));
  const body = await call(client, 'GET', `/v2/deal?${qs({
    xquery,
    select: 'dealName createdAt assignee contact source stage proposal.quote.total proposal.quote.quoteCurrency proposal.quote.lineItems',
    populatePath: [{ path: 'contact', select: 'firstName lastName email assignee' }],
    sort: '-createdAt',
    limit,
  })}`);
  const deals = rowsOf(body);
  const entryIds = [...new Set(deals.flatMap((d) => ((d.proposal && d.proposal.quote && d.proposal.quote.lineItems) || []).map((l) => idOf(l.pricebookEntry)).filter(Boolean)))];
  const current = entryIds.length
    ? rowsOf(await call(client, 'GET', `/v2/pricebookentry?${qs({ xquery: { _id: { $in: entryIds } }, select: 'price currency active', limit: String(entryIds.length) })}`))
    : [];
  const priceOf = new Map(current.map((e) => [idOf(e), e]));
  // Assignees by raw id: a populate turns an unreadable user into null and hides who got the deal.
  const people = await usersByIds(client, [...new Set(deals.map((d) => idOf(d.assignee)).filter(Boolean))]);
  const personOf = new Map(people.map((p) => [idOf(p), p]));
  const out = deals.map((d) => {
    const quote = (d.proposal && d.proposal.quote) || {};
    const assigneeId = idOf(d.assignee);
    const person = personOf.get(assigneeId);
    const contact = d.contact && typeof d.contact === 'object' ? d.contact : null;
    const contactOwner = contact ? idOf(contact.assignee) : null;
    return {
      _id: idOf(d),
      createdAt: d.createdAt,
      dealName: d.dealName,
      assignee: { _id: assigneeId || null, name: fullName(person), email: person ? person.email : null, status: person ? person.status : null, readable: !!person },
      contact: contact ? { _id: idOf(contact), email: contact.email, owner: contactOwner } : { _id: idOf(d.contact) || null },
      contactOwnerDiffers: !!(contactOwner && assigneeId && contactOwner !== assigneeId),
      total: quote.total === undefined ? null : quote.total,
      currency: quote.quoteCurrency || null,
      lines: (quote.lineItems || []).map((l) => {
        const now = priceOf.get(idOf(l.pricebookEntry));
        return {
          product: l.productName,
          quantity: l.quantity,
          price: l.price,
          discountAmount: l.discountAmount || 0,
          currency: l.currency || null,
          noPriceListEntry: !l.pricebookEntry,
          priceNow: now ? now.price : null,
          priceChanged: !!(now && typeof l.price === 'number' && now.price !== l.price),
        };
      }),
    };
  });
  // Twin deals: the same contact twice within 60 seconds (a double click on submit).
  const twins = [];
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      if (out[i].contact._id && out[i].contact._id === out[j].contact._id
        && Math.abs(Date.parse(out[i].createdAt) - Date.parse(out[j].createdAt)) <= 60000) twins.push([out[i]._id, out[j]._id]);
    }
  }
  return {
    wizard: wizard.proposalWizardCode,
    count: (body.pagination && body.pagination.count) || out.length,
    shown: out.length,
    deals: out,
    twins,
    notes: [
      'Each submission e-mails the visitor a link to the proposal and notifies the deal\'s assignee in the app.',
      'contactOwnerDiffers: the visitor already existed as a contact; the contact keeps its owner, the deal goes to the group\'s user.',
      'assignee.readable false: the deal points to a user this profile cannot read (another workspace or removed); the raw id is shown.',
      'noPriceListEntry: a preset line of the wizard, or a line the account\'s pricing adds on recalculation (for example a service charge).',
    ],
  };
}

async function cmdLinks(client, [ref], flags) {
  const wizard = await findWizard(client, ref);
  const catalog = await loadCatalog(client, wizard.lineItemsSource);
  const offered = catalog.entries.filter((e) => e.productActive !== false && e.pricebookActive !== false);
  let groupLink = null;
  if (wizard.wizardGroup) {
    const g = await tryGet(client, `/v2/proposalwizardgroup/${idOf(wizard.wizardGroup)}?${qs({ select: 'proposalWizardGroupCode proposalWizardGroupName' })}`);
    if (g && g.proposalWizardGroupCode) groupLink = `https://${client.domain}/pwg/${encodeURIComponent(g.proposalWizardGroupCode)}`;
  }
  return {
    wizard: wizard.proposalWizardCode,
    active: wizard.active !== false,
    link: wizardLink(client.domain, wizard.proposalWizardCode),
    groupLink,
    perProduct: offered.map((e) => ({ product: e.product, price: e.price, currency: e.currency, pricebookEntry: e._id, link: productLink(client.domain, wizard.proposalWizardCode, [e._id], !!flags.lock) })),
    notes: [
      flags.lock ? 'avoidChangeProduct=true: the visitor cannot change the product.' : 'Add --lock to stop the visitor from changing the product.',
      'These links are built locally: nothing was written. Changing the wizard code breaks every link, QR and short link already shared.',
      ...(wizard.active === false ? ['The wizard is not published: the links answer "not active" until it is.'] : []),
    ],
  };
}

function headerReport(res) {
  const csp = res.header('content-security-policy') || '';
  const ancestors = (csp.match(/frame-ancestors([^;]*)/) || [null, ''])[1].trim().split(/\s+/).filter(Boolean);
  return {
    status: res.status,
    xRobotsTag: res.header('x-robots-tag'),
    referrerPolicy: res.header('referrer-policy'),
    cacheControl: res.header('cache-control'),
    frameAncestors: { count: ancestors.length, unusual: ancestors.filter((x) => x === 'null' || /^chrome-extension:|^http:\/\//i.test(x)) },
  };
}

async function cmdPublicCheck(client, [ref], flags, ctx) {
  const wizard = await findWizard(client, ref);
  const code = wizard.proposalWizardCode;
  const page = await publicGet(ctx, client.domain, `/pw/${encodeURIComponent(code)}`);
  const html = typeof page.text === 'string' ? page.text : '';
  const robotsMeta = (html.match(/<meta[^>]+name=["']robots["'][^>]*>/i) || [null])[0];
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((m) => ({ src: m[1], integrity: /integrity=/i.test(m[0]) }));
  const external = scripts.filter((s) => /^https?:\/\//i.test(s.src) && !s.src.includes(client.domain));
  const config = await publicGet(ctx, client.domain, `/v2/proposalWizard/getUiConfig/${encodeURIComponent(code)}`);
  const cfg = config.status === 200 && isPlain(config.body) ? config.body : null;
  const lineKeys = cfg ? [...new Set((cfg.lineItems || []).flatMap((l) => Object.keys(l)))] : [];
  const headers = headerReport(page);
  const findings = [];
  const add = (level, message) => findings.push({ level, message });
  if (!headers.xRobotsTag) add('warning', 'No X-Robots-Tag header (only the meta robots tag tells search engines not to index the page).');
  if (!robotsMeta || !/noindex/i.test(robotsMeta)) add('warning', 'No meta robots noindex on the page.');
  if (!headers.referrerPolicy) add('warning', 'No Referrer-Policy header.');
  const odd = headers.frameAncestors.unusual;
  if (odd.length) add('warning', `Other sites allowed to embed the page include unusual origins: ${odd.slice(0, 5).join(' ')}. This is an account setting (admin).`);
  if (external.some((s) => !s.integrity)) add('warning', 'The page loads scripts from a public CDN without an integrity check.');
  if (cfg && !cfg.turnstileSiteKey) add('warning', 'No captcha: the account has no Cloudflare Turnstile credential, so bots can submit and each submission e-mails the address typed.');
  if (cfg && PRIVATE_CONFIG_KEYS.some((k) => k in cfg)) add('error', 'The anonymous page config includes internal wizard settings.');
  if (lineKeys.some((k) => PRIVATE_LINE_KEYS.includes(k))) add('error', 'The anonymous catalog includes internal product fields.');
  if (wizard.active !== false && !cfg) add('error', `The anonymous page config answers ${config.status}.`);
  return {
    wizard: code,
    link: wizardLink(client.domain, code),
    page: { ...headers, metaRobots: robotsMeta, externalScripts: external },
    anonymousConfig: cfg ? {
      status: 200,
      keys: Object.keys(cfg).sort(),
      lineKeys: lineKeys.sort(),
      captcha: !!cfg.turnstileSiteKey,
      session: cfg.session || null,
    } : { status: config.status },
    findings,
    note: 'Read-only: these requests were sent without any key, as an anonymous visitor.',
  };
}

// ─── Create and update ─────────────────────────────────────────────────────────

// Turns names in a plan into ids, the way the app's pickers store them.
async function resolveSet(client, set) {
  const body = JSON.parse(JSON.stringify(set));
  const refsUsed = {};
  if ('assignmentGroup' in body && body.assignmentGroup) {
    const g = await resolveRef(client, 'usergroup', body.assignmentGroup, { nameField: 'userGroupName', select: 'userGroupName userGroupType updatedAt' });
    body.assignmentGroup = idOf(g);
    refsUsed.assignmentGroup = g.updatedAt;
  }
  if ('wizardGroup' in body && body.wizardGroup) {
    body.wizardGroup = idOf(await resolveRef(client, 'proposalwizardgroup', body.wizardGroup, { nameField: 'proposalWizardGroupName', select: 'proposalWizardGroupName' }));
  }
  if ('form' in body && body.form) body.form = idOf(await resolveRef(client, 'form', body.form, { nameField: 'formName', select: 'formName' }));
  const src = body.lineItemsSource;
  if (isPlain(src)) {
    if (src.pricebook) {
      const pb = await resolveRef(client, 'pricebook', src.pricebook, { nameField: 'pricebookName', select: 'pricebookName active updatedAt' });
      src.pricebook = idOf(pb);
      refsUsed.pricebook = pb.updatedAt;
    }
    if (src.pricebookEntries !== undefined) {
      if (!Array.isArray(src.pricebookEntries)) throw new UsageError('lineItemsSource.pricebookEntries must be a list.');
      const ids = [];
      for (const e of src.pricebookEntries) ids.push(idOf(await resolveRef(client, 'pricebookentry', e, { nameField: 'pricebookEntryCode', select: 'pricebookEntryCode' })));
      src.pricebookEntries = ids;
    }
    if (src.advisorPricebooks !== undefined) {
      if (!Array.isArray(src.advisorPricebooks)) throw new UsageError('lineItemsSource.advisorPricebooks must be a list.');
      const ids = [];
      for (const p of src.advisorPricebooks) ids.push(idOf(await resolveRef(client, 'pricebook', p, { nameField: 'pricebookName', select: 'pricebookName' })));
      src.advisorPricebooks = ids;
    }
  }
  const preset = body.proposalPreset;
  if (isPlain(preset)) {
    if (preset.layout) {
      preset.layout = idOf(await resolveRef(client, 'contenttemplate', preset.layout, {
        nameField: 'contentTemplateName', select: 'contentTemplateName templateType', xquery: { templateType: 'layout' },
      }));
    }
    if (preset.stage) preset.stage = idOf(await resolveRef(client, 'stage', preset.stage, { nameField: 'stageName', select: 'stageName' }));
  }
  return { body, refsUsed };
}

async function prepareCreate(client, plan) {
  const warnings = validateSet(plan.set, { creating: true });
  for (const req of ['proposalWizardName', 'assignmentGroup']) if (!plan.set[req]) throw new UsageError(`"set.${req}" is required.`);
  if (!plan.set.proposalPreset || !plan.set.proposalPreset.title) throw new UsageError('"set.proposalPreset.title" (the proposal title of each deal) is required.');
  const { body, refsUsed } = await resolveSet(client, plan.set);
  body.proposalWizardName = body.proposalWizardName.trim();
  body.active = false;
  const { findings, loaded } = await analyze(client, body);
  const blockers = errorsOf(findings).filter((m) => !/not published/.test(m));
  return {
    body, findings, loaded, warnings, blockers,
    version: hash({ body, refsUsed, group: loaded.group ? loaded.group.updatedAt : null, entries: loaded.catalog.entries.map((e) => e._id) }),
  };
}

async function cmdPreviewCreate(client, [planArg], flags, ctx) {
  const prep = await prepareCreate(client, readPlan(planArg, ctx.rootDir));
  return {
    action: 'create',
    wizard: prep.body,
    publishedOnCreate: false,
    group: prep.loaded.group || null,
    offeredProducts: prep.loaded.catalog.entries.filter((e) => e.productActive !== false && e.pricebookActive !== false).map((e) => `${e.product} · ${e.price} ${e.currency || ''}`.trim()),
    warnings: prep.warnings,
    findings: prep.findings,
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not create.'
      : `${STOP}create with the same plan, --version ${prep.version} and --confirmed. It is created unpublished; publishing is its own preview and yes.`,
  };
}

function checkReadBack(sent, back) {
  const problems = [];
  for (const d of diffPaths(back, deepMerge(back, sent))) problems.push(`${d.field} reads back as ${JSON.stringify(d.from)} (sent ${JSON.stringify(d.to)}).`);
  return problems;
}

async function cmdCreate(client, [planArg], flags, ctx) {
  needWriteFlags(flags, 'preview-create');
  const prep = await prepareCreate(client, readPlan(planArg, ctx.rootDir));
  if (prep.version !== flags.version) throw new Blocked('The plan or a record it uses changed since the preview. Run preview-create again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  const saved = await call(client, 'POST', '/v2/proposalwizard', { data: prep.body, confirmed: true });
  const back = await findWizard(client, idOf(saved));
  const problems = checkReadBack(prep.body, back);
  return {
    created: !problems.length,
    wizard: wizardSummary(client.domain, back),
    problems,
    nextStep: 'It is NOT published. Run doctor, then preview-publish when the user wants it live; suggest testing the link in a private window with their own e-mail.',
  };
}

async function prepareUpdate(client, ref, plan, flags) {
  const wizard = await findWizard(client, ref);
  const warnings = validateSet(plan.set, { creating: false });
  if ('proposalWizardCode' in plan.set) {
    if (!flags.renameLink) throw new Blocked('Changing proposalWizardCode changes the public link: every link, QR and short link already shared stops working. Ask the user for that separately, then add --rename-link.');
    if (typeof plan.set.proposalWizardCode !== 'string' || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(plan.set.proposalWizardCode)) throw new UsageError('proposalWizardCode must be lowercase letters, digits and hyphens.');
    warnings.push(`The public link changes from /pw/${wizard.proposalWizardCode} to /pw/${plan.set.proposalWizardCode}; the old one stops working.`);
  }
  const { body: resolved } = await resolveSet(client, plan.set);
  const body = {};
  for (const [k, v] of Object.entries(resolved)) body[k] = isPlain(v) && isPlain(wizard[k]) ? deepMerge(wizard[k], v) : v;
  const changes = Object.keys(body).flatMap((k) => diffPaths(wizard[k], body[k], k));
  if (!changes.length) throw new Blocked('The plan changes nothing on this wizard.');
  const after = { ...wizard, ...body };
  const { findings, loaded } = await analyze(client, after);
  const errors = errorsOf(findings).filter((m) => !/not published/.test(m));
  const blockers = wizard.active !== false ? errors : [];
  if (wizard.active === false) warnings.push(...errors.map((m) => `Before publishing: ${m}`));
  else warnings.push('The wizard is published: the change is live for visitors as soon as it is saved.');
  return {
    wizard, body, changes, warnings, findings, loaded, blockers,
    version: `${wizard.updatedAt}:${hash(body)}`,
  };
}

async function cmdPreviewUpdate(client, [ref, planArg], flags, ctx) {
  const prep = await prepareUpdate(client, ref, readPlan(planArg, ctx.rootDir), flags);
  return {
    action: 'update',
    wizard: { _id: idOf(prep.wizard), code: prep.wizard.proposalWizardCode, name: prep.wizard.proposalWizardName, active: prep.wizard.active !== false },
    changes: prep.changes,
    warnings: prep.warnings,
    findings: prep.findings,
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not update.'
      : `${STOP}update with the same wizard and plan, --version ${prep.version} and --confirmed${'proposalWizardCode' in prep.body ? ' and --rename-link' : ''}.`,
  };
}

async function cmdUpdate(client, [ref, planArg], flags, ctx) {
  needWriteFlags(flags, 'preview-update');
  const prep = await prepareUpdate(client, ref, readPlan(planArg, ctx.rootDir), flags);
  if (prep.version !== flags.version) throw new Blocked('The wizard or the plan changed since the preview. Run preview-update again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  await call(client, 'PATCH', `/v2/proposalwizard/${idOf(prep.wizard)}`, { data: prep.body, confirmed: true });
  const back = await findWizard(client, idOf(prep.wizard));
  const problems = checkReadBack(prep.body, back);
  return { updated: !problems.length, wizard: wizardSummary(client.domain, back), problems };
}

// ─── Publish / unpublish ───────────────────────────────────────────────────────

async function preparePublish(client, ref, publish) {
  const wizard = await findWizard(client, ref);
  const isActive = wizard.active !== false;
  if (publish && isActive) throw new Blocked('The wizard is already published.');
  if (!publish && !isActive) throw new Blocked('The wizard is already unpublished.');
  const warnings = [];
  let blockers = [];
  let findings = [];
  if (publish) {
    ({ findings } = await analyze(client, { ...wizard, active: true }));
    blockers = errorsOf(findings);
    warnings.push('From now on anyone with the link can submit: each submission creates a contact and a deal, e-mails the address typed and notifies the assigned user.');
  } else {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const recent = await call(client, 'GET', `/v2/deal?${qs({ xquery: { proposalWizard: idOf(wizard), createdAt: { $gte: since } }, select: '_id', limit: '1' })}`);
    const count = (recent.pagination && recent.pagination.count) || rowsOf(recent).length;
    warnings.push(`Visitors who open the link (or a QR / short link to it) will get "not active". The wizard created ${count} deal(s) in the last 30 days.`);
  }
  return { wizard, warnings, findings, blockers, version: String(wizard.updatedAt) };
}

function publishPreview(name) {
  return async (client, [ref]) => {
    const publish = name === 'publish';
    const prep = await preparePublish(client, ref, publish);
    return {
      action: name,
      wizard: { _id: idOf(prep.wizard), code: prep.wizard.proposalWizardCode, name: prep.wizard.proposalWizardName },
      link: wizardLink(client.domain, prep.wizard.proposalWizardCode),
      warnings: prep.warnings,
      findings: prep.findings,
      blockers: prep.blockers,
      version: prep.version,
      nextStep: prep.blockers.length ? `Blocked: tell the user why; do not ${name}.` : `${STOP}${name} with the same wizard, --version ${prep.version} and --confirmed.`,
    };
  };
}

function publishApply(name) {
  return async (client, [ref], flags, ctx) => {
    needWriteFlags(flags, `preview-${name}`);
    const publish = name === 'publish';
    const prep = await preparePublish(client, ref, publish);
    if (prep.version !== flags.version) throw new Blocked(`The wizard changed since the preview. Run preview-${name} again.`);
    if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
    await call(client, 'PATCH', `/v2/proposalwizard/${idOf(prep.wizard)}`, { data: { active: publish }, confirmed: true });
    const back = await findWizard(client, idOf(prep.wizard));
    const page = await publicGet(ctx, client.domain, `/v2/proposalWizard/getUiConfig/${encodeURIComponent(back.proposalWizardCode)}`);
    const problems = [];
    if ((back.active !== false) !== publish) problems.push(`active reads back as ${back.active}.`);
    if (publish && page.status !== 200) problems.push(`The public page config answers ${page.status} after publishing.`);
    if (!publish && page.status === 200) problems.push('The public page still answers 200 after unpublishing.');
    return {
      [publish ? 'published' : 'unpublished']: !problems.length,
      link: wizardLink(client.domain, back.proposalWizardCode),
      publicPageStatus: page.status,
      problems,
      ...(publish ? { tip: 'Open the link in a private window and submit with the user\'s own e-mail to see the whole flow.' } : {}),
    };
  };
}

// ─── Assignment group ("Proposal Wizard" user group) ───────────────────────────

async function prepareGroup(client, plan) {
  const known = ['group', 'name', 'emails', 'roundRobin', 'description'];
  for (const k of Object.keys(plan)) if (!known.includes(k)) throw new UsageError(`Unknown group plan key "${k}". Allowed: ${known.join(', ')}.`);
  if ('roundRobin' in plan && typeof plan.roundRobin !== 'boolean') throw new UsageError('roundRobin must be true or false.');
  if ('emails' in plan && (!Array.isArray(plan.emails) || !plan.emails.length || plan.emails.some((e) => typeof e !== 'string' || !EMAIL_RE.test(e)))) {
    throw new UsageError('emails must be a non-empty list of e-mail addresses.');
  }
  if ('name' in plan && (typeof plan.name !== 'string' || !plan.name.trim())) throw new UsageError('name must be a non-empty text.');
  const existing = plan.group ? await loadGroup(client, plan.group) : null;
  if (!existing && (!plan.name || !plan.emails)) throw new UsageError('A new group needs "name" and "emails".');
  if (existing && existing.group.userGroupType !== PW_GROUP_TYPE) {
    throw new Blocked(`"${existing.group.userGroupName}" is a "${existing.group.userGroupType}" group: other features use it. Create a "${PW_GROUP_TYPE}" group instead.`);
  }
  const blockers = [];
  const warnings = [];
  const body = {};
  let members = existing ? existing.users : [];
  if (plan.emails) {
    const emails = [...new Set(plan.emails.map((e) => e.trim().toLowerCase()))];
    const found = rowsOf(await call(client, 'GET', `/v2/user?${qs({ xquery: { email: { $in: emails } }, select: 'firstName lastName email status', limit: String(emails.length) })}`));
    members = emails.map((email) => {
      const u = found.find((r) => String(r.email).toLowerCase() === email);
      if (!u) blockers.push(`No user with the e-mail ${email}.`);
      return u ? { _id: idOf(u), name: fullName(u), email, status: u.status } : { _id: null, name: null, email, status: 'not found' };
    });
    body.users = members.filter((m) => m._id).map((m) => m._id);
  }
  const inactive = members.filter((m) => m._id && m.status !== 'Active');
  if (inactive.length) warnings.push(`Not active, so they never receive quotes: ${inactive.map((m) => m.email || m._id).join(', ')}.`);
  if (!members.some((m) => m.status === 'Active')) blockers.push('No active user in the group: every submission of its wizards would fail.');
  if (plan.name) body.userGroupName = plan.name.trim();
  if (plan.description !== undefined) body.description = String(plan.description);
  if ('roundRobin' in plan) body.enableLoadBalancing = plan.roundRobin;
  if (!existing) {
    body.userGroupType = PW_GROUP_TYPE;
    if (!('enableLoadBalancing' in body)) body.enableLoadBalancing = false;
  }
  let usedBy = [];
  if (existing) {
    usedBy = rowsOf(await call(client, 'GET', `/v2/proposalwizard?${qs({ xquery: { assignmentGroup: idOf(existing.group) }, select: 'proposalWizardCode active', limit: '100' })}`))
      .map((w) => `${w.proposalWizardCode}${w.active === false ? ' (unpublished)' : ''}`);
    if (usedBy.length) warnings.push(`Every wizard using this group changes at once: ${usedBy.join(', ')}.`);
  }
  const changes = existing ? Object.keys(body).flatMap((k) => diffPaths(k === 'users' ? existing.users.map((u) => u._id) : existing.group[k], body[k], k)) : [];
  if (existing && !changes.length) throw new Blocked('The plan changes nothing on this group.');
  if (body.enableLoadBalancing === true) warnings.push('Round-robin: each submission goes to the next active user and rewrites the order of the group\'s users.');
  if (body.enableLoadBalancing === false) warnings.push('Random: each submission goes to a random active user.');
  return {
    existing, body, members, changes, usedBy, warnings, blockers,
    version: existing ? `${existing.group.updatedAt}:${hash(body)}` : hash({ body, members }),
  };
}

async function cmdPreviewGroup(client, [planArg], flags, ctx) {
  const prep = await prepareGroup(client, readPlan(planArg, ctx.rootDir));
  return {
    action: prep.existing ? 'update' : 'create',
    group: prep.existing ? summarizeGroup(prep.existing) : null,
    write: prep.body,
    members: prep.members,
    changes: prep.changes,
    warnings: prep.warnings,
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not write the group.' : `${STOP}group with the same plan, --version ${prep.version} and --confirmed.`,
  };
}

async function cmdGroup(client, [planArg], flags, ctx) {
  needWriteFlags(flags, 'preview-group');
  const plan = readPlan(planArg, ctx.rootDir);
  const prep = await prepareGroup(client, plan);
  if (prep.version !== flags.version) throw new Blocked('The group, its users or the plan changed since the preview. Run preview-group again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  const saved = prep.existing
    ? await call(client, 'PATCH', `/v2/usergroup/${idOf(prep.existing.group)}`, { data: prep.body, confirmed: true })
    : await call(client, 'POST', '/v2/usergroup', { data: prep.body, confirmed: true });
  const back = await loadGroup(client, idOf(saved) || idOf(prep.existing && prep.existing.group));
  const problems = [];
  if (prep.body.users && JSON.stringify(back.users.map((u) => u._id)) !== JSON.stringify(prep.body.users)) problems.push('users read back differently.');
  for (const k of ['userGroupName', 'userGroupType', 'enableLoadBalancing']) {
    if (k in prep.body && back.group[k] !== prep.body[k]) problems.push(`${k} reads back as ${JSON.stringify(back.group[k])}.`);
  }
  return { saved: !problems.length, group: summarizeGroup(back), problems, use: 'Set it on a wizard with "assignmentGroup": "<this id>".' };
}

// ─── Short link ────────────────────────────────────────────────────────────────

async function prepareShortlink(client, ref, plan) {
  for (const k of Object.keys(plan)) if (!['code', 'pbe', 'lock'].includes(k)) throw new UsageError(`Unknown short link plan key "${k}". Allowed: code, pbe, lock.`);
  if (plan.code !== undefined && (typeof plan.code !== 'string' || !SHORT_CODE_RE.test(plan.code))) throw new UsageError('code: 2–64 letters, digits, "-" or "_", starting with a letter or digit.');
  if (plan.pbe !== undefined && (!Array.isArray(plan.pbe) || plan.pbe.some((e) => typeof e !== 'string' || !ID_RE.test(e)))) throw new UsageError('pbe must be a list of price-list entry ids.');
  const wizard = await findWizard(client, ref);
  const blockers = [];
  const warnings = [];
  let url = wizardLink(client.domain, wizard.proposalWizardCode);
  if (plan.pbe && plan.pbe.length) {
    const offered = new Set((await loadCatalog(client, wizard.lineItemsSource)).entries.map((e) => e._id));
    const missing = plan.pbe.filter((e) => !offered.has(e));
    if (missing.length) blockers.push(`Not offered by this wizard: ${missing.join(', ')}. Run links to see the entries.`);
    url = productLink(client.domain, wizard.proposalWizardCode, plan.pbe, !!plan.lock);
  }
  const existing = rowsOf(await call(client, 'GET', `/v2/shorturl?${qs({ xquery: { url }, select: 'shortUrlCode url', limit: '20' })}`))
    .map((s) => ({ code: s.shortUrlCode, link: `https://${client.domain}/r/${s.shortUrlCode}` }));
  if (existing.length) warnings.push(`${existing.length} short link(s) already point to this address; you can reuse one instead of creating another. Existing short links are never deleted here.`);
  if (plan.code) {
    const taken = rowsOf(await call(client, 'GET', `/v2/shorturl?${qs({ xquery: { shortUrlCode: plan.code }, select: 'shortUrlCode url', limit: '1' })}`));
    if (taken.length) blockers.push(`The short code "${plan.code}" is taken.`);
  } else {
    warnings.push('No code given: the server picks a random 8-character code.');
  }
  if (wizard.active === false) warnings.push('The wizard is not published: the short link answers "not active" until it is.');
  warnings.push('Short links are shared by the whole account and keep the full address: changing the wizard code later breaks this one too.');
  return { wizard, url, code: plan.code || null, existing, warnings, blockers, version: hash({ url, code: plan.code || null, existing: existing.map((e) => e.code), w: wizard.updatedAt }) };
}

async function cmdPreviewShortlink(client, [ref, planArg], flags, ctx) {
  const prep = await prepareShortlink(client, ref, readPlan(planArg, ctx.rootDir));
  return {
    action: 'create short link',
    target: prep.url,
    code: prep.code,
    link: prep.code ? `https://${client.domain}/r/${prep.code}` : null,
    existing: prep.existing,
    warnings: prep.warnings,
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not create it.' : `${STOP}shortlink with the same wizard and plan, --version ${prep.version} and --confirmed.`,
  };
}

async function cmdShortlink(client, [ref, planArg], flags, ctx) {
  needWriteFlags(flags, 'preview-shortlink');
  const prep = await prepareShortlink(client, ref, readPlan(planArg, ctx.rootDir));
  if (prep.version !== flags.version) throw new Blocked('Something changed since the preview. Run preview-shortlink again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  const data = prep.code ? { shortUrlCode: prep.code, url: prep.url } : { url: prep.url };
  const saved = await call(client, 'POST', '/v2/shorturl', { data, confirmed: true });
  const code = saved.shortUrlCode || prep.code;
  const back = await tryGet(client, `/v2/shorturl/${encodeURIComponent(code)}?${qs({ select: 'shortUrlCode url' })}`);
  const problems = back && back.url === prep.url ? [] : ['The short link does not read back with the expected address.'];
  const link = `https://${client.domain}/r/${code}`;
  return { created: !problems.length, link, target: prep.url, qrImage: `https://${client.domain}/v2/service/qrcode/?text=${encodeURIComponent(link)}`, problems };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

function needWriteFlags(flags, preview) {
  if (!flags.version) throw new UsageError(`Missing --version. Run ${preview} first and pass its version.`);
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview to the user and wait for a yes.');
}

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
    else if (arg === '--lock') flags.lock = true;
    else if (arg === '--rename-link') flags.renameLink = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--since') flags.since = next();
    else if (arg === '--email') flags.email = next();
    else if (arg === '--limit') flags.limit = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  list: cmdList,
  show: cmdShow,
  doctor: cmdDoctor,
  deals: cmdDeals,
  links: cmdLinks,
  'public-check': cmdPublicCheck,
  'preview-create': cmdPreviewCreate,
  create: cmdCreate,
  'preview-update': cmdPreviewUpdate,
  update: cmdUpdate,
  'preview-publish': publishPreview('publish'),
  publish: publishApply('publish'),
  'preview-unpublish': publishPreview('unpublish'),
  unpublish: publishApply('unpublish'),
  'preview-group': cmdPreviewGroup,
  group: cmdGroup,
  'preview-shortlink': cmdPreviewShortlink,
  shortlink: cmdShortlink,
};

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can grant the permission.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: wizard.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir, fetchImpl });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (result.blockers && result.blockers.length) return BLOCKED;
    if (result.problems && result.problems.length) return 1;
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    if (err && err.status === 403) {
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
  main, validateSet, deepMerge, diffPaths, productLink, humanDuration, PUBLIC_PATH_RE,
};
