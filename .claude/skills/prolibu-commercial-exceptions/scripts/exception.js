#!/usr/bin/env node
'use strict';

// Commercial exceptions and product rules, the way the Prolibu app handles them.
//
//   exception.js deals          <domain> <part of the deal name>
//   exception.js diagnose       <domain> <dealId> [--try '<json array of line edits>']
//   exception.js requests       <domain> [--deal <id>] [--status <Pending|Approved|…>] [--mine] [--to-me] [--limit <n>]
//   exception.js approvers      <domain> <dealId>
//   exception.js request-preview <domain> '<plan>'   then  request <domain> '<plan>' --version <v> --confirmed --reaches-people
//   exception.js edit-preview    <domain> '<plan>'   then  edit    <domain> '<plan>' --version <v> --confirmed --reaches-people
//   exception.js cancel-preview  <domain> '<plan>'   then  cancel  <domain> '<plan>' --version <v> --confirmed --reaches-people
//   exception.js decide-preview  <domain> '<plan>'   then  decide  <domain> '<plan>' --version <v> --confirmed --reaches-people [--self-approval]
//   exception.js rules          <domain> [<term>]
//   exception.js rule           <domain> <ruleId|ruleCode>
//   exception.js rule-preview   <domain> '<plan>'   then  rule-apply <domain> '<plan>' --version <v> --confirmed
//
// Plans are inline JSON or the path of a JSON file in a temp folder (see SKILL.md for each shape).
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const BLOCKED = 3;
const HONORED = ['Approved', 'Superseded'];
const DECIDE_PERMISSION = 'Special@CommercialException.allow.decide';
const TEXT_MAX = 2000;

// ProductRule fields, as the server enforces them.
const LIMIT_FIELDS = ['Quantity', 'Price', 'DiscountRate', 'UnitMultiplier', 'NumberOfPayments', 'UpfrontPaymentRate', 'MarkupRate'];
const LIMIT_KEYS = LIMIT_FIELDS.flatMap((f) => [`min${f}`, `max${f}`]);
const LOCKABLE = ['productName', 'description', 'quantity', 'unitMultiplier', 'numberOfPayments', 'upfrontPaymentRate', 'currency',
  'cost', 'price', 'taxes', 'discountAmount', 'contentBlocks', 'startDate', 'endDate'];
// A locked field compares the line with the product for these, with the price-list entry for the rest.
const PRODUCT_SOURCED = ['productName', 'description', 'quantity', 'contentBlocks', 'unitMultiplier', 'numberOfPayments'];
const RATE_FIELDS = ['discountRate', 'upfrontPaymentRate'];
const PRODUCT_LIST_KEYS = ['mustIncludeProducts', 'mustExcludeProducts'];
const RULE_KEYS = new Set(['productRuleName', 'productRuleCode', 'lockedFields', ...LIMIT_KEYS, ...PRODUCT_LIST_KEYS]);
// Line fields a "try" in diagnose may set (the same the quote builder edits).
const TRY_FIELDS = new Set(['quantity', 'unitMultiplier', 'numberOfPayments', 'upfrontPaymentRate', 'price', 'discountRate',
  'discountAmount', 'markupRate', 'cost']);

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const firstLower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const limitField = (key) => firstLower(key.slice(3));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const fullName = (u) => (u && typeof u === 'object' ? [u.firstName, u.lastName].filter(Boolean).join(' ') : null);

function isNumberField(field) {
  return ['quantity', 'unitMultiplier', 'numberOfPayments', 'upfrontPaymentRate', 'price', 'discountRate', 'discountAmount',
    'markupRate', 'cost'].includes(field);
}

// Same rule as the server: a number finite and >= 0 (a discount rate <= 1); otherwise the type of the reference.
function checkValue(field, value, reference) {
  if (isNumberField(field) || typeof reference === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new UsageError(`${field} must be a number greater than or equal to 0.`);
    }
    if (RATE_FIELDS.includes(field) && value > 1) {
      throw new UsageError(`${field} is a decimal (18% = 0.18), not a percentage.`);
    }
    return value;
  }
  if (reference !== undefined && (typeof value !== typeof reference || Array.isArray(value) !== Array.isArray(reference))) {
    throw new UsageError(`${field} must have the same type as the line's current value.`);
  }
  return value;
}

// The rules that apply to a line: the price-list entry's, else the product's (an entry's rules replace the product's).
function effectiveRules(entry) {
  if (!entry) return { source: 'none', rules: [] };
  const entryRules = (entry.rules || []).filter((r) => r && typeof r === 'object');
  if (entryRules.length) return { source: 'entry', rules: entryRules };
  const productRules = ((entry.product && entry.product.rules) || []).filter((r) => r && typeof r === 'object');
  return { source: productRules.length ? 'product' : 'none', rules: productRules };
}

// Fields a rule limits on a line, with each limit.
function limitsOf(rules) {
  const out = [];
  for (const rule of rules) {
    for (const [field, locked] of Object.entries(rule.lockedFields || {})) {
      if (locked === true) out.push({ field, kind: 'locked', rule: rule.productRuleName, ruleId: rule._id });
    }
    for (const key of LIMIT_KEYS) {
      if (key in rule) out.push({ field: limitField(key), kind: key.slice(0, 3), limit: rule[key], rule: rule.productRuleName, ruleId: rule._id });
    }
    for (const key of PRODUCT_LIST_KEYS) {
      if ((rule[key] || []).length) out.push({ field: key, kind: key === 'mustIncludeProducts' ? 'include' : 'exclude', limit: rule[key].map(idOf), rule: rule.productRuleName, ruleId: rule._id });
    }
  }
  return out;
}

function sameTaxes(a, b) {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every((t, i) => t && y[i] && t.taxName === y[i].taxName && t.rate === y[i].rate);
}

// Every rule violation of one line, mirroring the server's checks (which stop at the first one).
function evaluateLine({ line, entry, quoteProductIds, exceptionRules }) {
  const { rules } = effectiveRules(entry);
  const found = [];
  const base = { uuid: line.uuid, product: line.productName };
  const pinFor = (field) => (exceptionRules || []).find((r) => r && r.field === field);
  for (const rule of rules) {
    const ruleName = rule.productRuleName || rule.productRuleCode || idOf(rule);
    for (const [field, locked] of Object.entries(rule.lockedFields || {})) {
      if (locked !== true) continue;
      const pin = pinFor(field);
      if (pin && pin.value === undefined) continue;
      if (pin) {
        const ok = field === 'taxes' ? sameTaxes(pin.value, line.taxes) : pin.value === line[field];
        if (!ok) found.push({ ...base, field, kind: 'pinned', rule: ruleName, limit: pin.value, value: line[field] });
        continue;
      }
      const source = field === 'taxes' ? entry.taxes
        : PRODUCT_SOURCED.includes(field) ? (entry.product || {})[field] : entry[field];
      const ok = field === 'taxes' ? sameTaxes(source, line.taxes) : source === line[field];
      if (!ok) found.push({ ...base, field, kind: 'locked', rule: ruleName, limit: source, value: line[field] });
    }
    for (const key of Object.keys(rule)) {
      const isLimit = key.startsWith('min') || key.startsWith('max');
      if (!isLimit && !PRODUCT_LIST_KEYS.includes(key)) continue;
      const field = isLimit ? limitField(key) : key;
      const pin = pinFor(field);
      if (pin) {
        if (pin.value !== undefined && line[field] !== pin.value) {
          found.push({ ...base, field, kind: 'pinned', rule: ruleName, limit: pin.value, value: line[field] });
        }
        continue;
      }
      const limit = rule[key];
      if (key.startsWith('min')) {
        if (line[field] === undefined || line[field] === null) {
          found.push({ ...base, field, kind: 'missingField', rule: ruleName, limit, value: null });
        } else if (line[field] < limit) {
          found.push({ ...base, field, kind: 'min', rule: ruleName, limit, value: line[field] });
        }
      } else if (key.startsWith('max')) {
        if (line[field] > limit) found.push({ ...base, field, kind: 'max', rule: ruleName, limit, value: line[field] });
      } else {
        const wanted = (limit || []).map(idOf);
        for (const id of wanted) {
          const present = quoteProductIds.includes(id);
          if (key === 'mustIncludeProducts' && !present) found.push({ ...base, field, kind: 'include', rule: ruleName, limit: id, value: null });
          if (key === 'mustExcludeProducts' && present) found.push({ ...base, field, kind: 'exclude', rule: ruleName, limit: id, value: id });
        }
      }
    }
  }
  const seen = new Set();
  return found.filter((v) => {
    const k = `${v.field}|${v.kind}|${JSON.stringify(v.limit)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Every violation of a quote. `pointer` is the exception record the quote points to (or null).
function evaluateQuote(quote, entriesById, pointer) {
  const lines = (quote && quote.lineItems) || [];
  const violations = [];
  const notes = [];
  let exception = pointer;
  if (pointer && pointer.status && !HONORED.includes(pointer.status)) {
    violations.push({ field: null, kind: 'pointerNotApproved', limit: null, value: pointer.status, uuid: null, product: null });
    exception = null;
  }
  const exceptionEntries = (exception && exception.ignoreProductRules) || [];
  if (exception && !exceptionEntries.length) {
    notes.push('The quote points to an exception that lifts every rule of the deal: nothing is checked.');
    return { violations, notes };
  }
  const quoteProductIds = lines.map((l) => idOf(l.product));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.pricebookEntry) continue;
    const entry = entriesById.get(idOf(line.pricebookEntry));
    if (!entry || !entry.product) continue;
    const mine = exceptionEntries.filter((e) => e && e.uuid && e.uuid === line.uuid);
    if (mine.some((e) => !Array.isArray(e.rules) || !e.rules.length)) continue;
    const exceptionRules = mine.flatMap((e) => e.rules);
    violations.push(...evaluateLine({ line, entry, quoteProductIds, exceptionRules }).map((v) => ({ ...v, index: i })));
  }
  return { violations, notes };
}

function explain(v) {
  switch (v.kind) {
    case 'pointerNotApproved': return `The quote points to a commercial exception that is ${v.value}, not approved: every save and calculation fails until a manager fixes it in the app.`;
    case 'locked': return `${v.field} is locked by rule "${v.rule}": it must stay ${JSON.stringify(v.limit)} and is ${JSON.stringify(v.value)}.`;
    case 'pinned': return `An approved exception fixes ${v.field} at exactly ${JSON.stringify(v.limit)}; the line has ${JSON.stringify(v.value)}. Moving it needs a new request.`;
    case 'min': return `${v.field} ${v.value} is below the minimum ${v.limit} of rule "${v.rule}".`;
    case 'max': return `${v.field} ${v.value} is above the maximum ${v.limit} of rule "${v.rule}".`;
    case 'missingField': return `Rule "${v.rule}" sets a minimum for ${v.field}, but the line has no ${v.field}: the server refuses it.`;
    case 'include': return `Rule "${v.rule}" requires product ${v.limit} in the same quote.`;
    case 'exclude': return `Rule "${v.rule}" forbids product ${v.limit} in the same quote.`;
    default: return `${v.field}: ${v.kind}`;
  }
}

// A line edit as the quote builder makes it: a discount travels as a pair.
function applyTry(line, edits) {
  for (const [key, value] of Object.entries(edits)) {
    if (key === 'uuid') continue;
    if (!TRY_FIELDS.has(key)) throw new UsageError(`--try: "${key}" cannot be tried. Allowed: ${[...TRY_FIELDS].join(', ')}.`);
    line[key] = checkValue(key, value);
  }
  if ('discountRate' in edits && !('discountAmount' in edits)) line.discountAmount = 0;
  if ('discountAmount' in edits && !('discountRate' in edits)) line.discountRate = 0;
}

// Validates a ProductRule change before writing: the server accepts min > max, negatives and rates > 1.
function validateRuleSet(set, existing = null) {
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) {
    throw new UsageError('The plan changes nothing: add "set".');
  }
  const warnings = [];
  for (const [key, value] of Object.entries(set)) {
    if (!RULE_KEYS.has(key)) throw new UsageError(`"${key}" is not a product rule field. Allowed: ${[...RULE_KEYS].join(', ')}.`);
    if (LIMIT_KEYS.includes(key)) {
      // null removes the limit (the API unsets the field); it only makes sense on an existing rule.
      if (value === null) {
        if (!existing) throw new UsageError(`${key}: null removes a limit; leave it out of a new rule instead.`);
        continue;
      }
      const field = limitField(key);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new UsageError(`${key} must be a number greater than or equal to 0.`);
      if (RATE_FIELDS.includes(field) && value > 1) throw new UsageError(`${key} is a decimal (10% = 0.1), not a percentage.`);
      if (field === 'markupRate' && value > 1) warnings.push(`${key} ${value} means ${Math.round(value * 100)}%. Rates are decimals (10% = 0.1).`);
    }
  }
  if ('productRuleName' in set && (typeof set.productRuleName !== 'string' || !set.productRuleName.trim())) {
    throw new UsageError('productRuleName must be a non-empty text.');
  }
  if ('productRuleCode' in set) {
    if (existing) throw new UsageError('productRuleCode is not changed on an existing rule: products and imports may refer to it.');
    if (typeof set.productRuleCode !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(set.productRuleCode)) {
      throw new UsageError('productRuleCode: letters, digits, dot, dash or underscore, up to 64.');
    }
  }
  if (!existing && !set.productRuleName) throw new UsageError('A new rule needs "productRuleName".');
  if ('lockedFields' in set) {
    const lf = set.lockedFields;
    if (!lf || typeof lf !== 'object' || Array.isArray(lf)) throw new UsageError('lockedFields must be an object of true/false.');
    for (const [k, v] of Object.entries(lf)) {
      if (!LOCKABLE.includes(k)) {
        const hint = k === 'discountRate' ? ' To forbid discounts, lock discountAmount or set maxDiscountRate 0.' : '';
        throw new UsageError(`lockedFields.${k} cannot be locked. Allowed: ${LOCKABLE.join(', ')}.${hint}`);
      }
      if (typeof v !== 'boolean') throw new UsageError(`lockedFields.${k} must be true or false.`);
    }
  }
  for (const key of PRODUCT_LIST_KEYS) {
    if (key in set && (!Array.isArray(set[key]) || set[key].some((v) => typeof v !== 'string' || !v.trim()))) {
      throw new UsageError(`${key} must be a list of product ids or codes.`);
    }
  }
  const merged = { ...(existing || {}), ...set };
  for (const key of LIMIT_KEYS) if (merged[key] === null) delete merged[key];
  for (const f of LIMIT_FIELDS) {
    const min = merged[`min${f}`];
    const max = merged[`max${f}`];
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new UsageError(`min${f} (${min}) is greater than max${f} (${max}).`);
    }
  }
  if ('minPrice' in set || 'maxPrice' in set) {
    warnings.push('minPrice and maxPrice compare the list price of the line, not the price after discount. '
      + 'To bound discounts, also set maxDiscountRate.');
  }
  for (const key of LIMIT_KEYS.filter((k) => k.startsWith('min') && k in set)) {
    const field = limitField(key);
    if (['markupRate', 'upfrontPaymentRate'].includes(field)) {
      warnings.push(`${key}: a line without ${field} is refused ("Cannot validate field against product rule").`);
    }
  }
  if (PRODUCT_LIST_KEYS.some((k) => (set[k] || []).length)) {
    warnings.push('mustIncludeProducts / mustExcludeProducts were not tested on a live quote yet: check a quote with this rule after attaching it.');
  }
  return { warnings };
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
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  return plan;
}

function needId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new UsageError(`The plan needs "${name}" (24 hex characters).`);
  return value;
}

function cleanText(value, name, required) {
  if (value === undefined && !required) return undefined;
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) throw new UsageError(`"${name}" is required and cannot be empty.`);
  if (text.length > TEXT_MAX) throw new UsageError(`"${name}" is longer than ${TEXT_MAX} characters.`);
  return text;
}

// ─── API steps ─────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    err.details = body.details;
    throw err;
  }
  return res.body;
}

const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || body;
  return {
    _id: idOf(p), email: p.email, name: fullName(p), isAdmin: p.isAdmin === true,
    canDecide: p.isAdmin === true || (Array.isArray(body.permissions) && body.permissions.includes(DECIDE_PERMISSION)),
  };
}

async function loadDeal(client, dealId) {
  const deal = await call(client, 'GET', `/v2/deal/${dealId}?${qs({ select: 'dealName stage assignee createdBy collaborators workspace proposal updatedAt' })}`);
  let stage = null;
  if (idOf(deal.stage)) {
    stage = await call(client, 'GET', `/v2/stage/${idOf(deal.stage)}?${qs({ select: 'stageName endFlowStage' })}`).catch(() => null);
  }
  return { deal, stage, quote: (deal.proposal && deal.proposal.quote) || {} };
}

// Search, not findOne: a seller may search exceptions but not read one by id.
const EXCEPTION_SELECT = 'deal status requestType justification approver decisionComment decidedBy decidedAt appliedIn ignoreProductRules createdBy createdAt updatedAt';
async function findExceptions(client, xquery, { limit = 50, populate = true } = {}) {
  const params = { xquery, select: EXCEPTION_SELECT, sort: '-createdAt', limit: String(limit) };
  if (populate) {
    params.populatePath = [
      { path: 'approver', select: 'firstName lastName email' },
      { path: 'createdBy', select: 'firstName lastName email' },
      { path: 'decidedBy', select: 'firstName lastName' },
      { path: 'deal', select: 'dealName' },
    ];
  }
  return rowsOf(await call(client, 'GET', `/v2/commercialexception/search?${qs(params)}`));
}

async function loadException(client, id) {
  const [record] = await findExceptions(client, { _id: id }, { limit: 1 });
  if (!record) throw new Blocked(`No commercial exception ${id} that this user can see.`);
  return record;
}

async function loadEntries(client, quote) {
  const ids = [...new Set(((quote && quote.lineItems) || []).map((l) => idOf(l.pricebookEntry)).filter((id) => ID_RE.test(id)))];
  if (!ids.length) return new Map();
  const params = {
    xquery: { _id: { $in: ids } },
    limit: '500',
    populatePath: [
      { path: 'rules' },
      { path: 'taxes', select: 'taxName rate' },
      { path: 'product', select: 'productName productCode description quantity unitMultiplier numberOfPayments contentBlocks rules', populate: [{ path: 'rules' }] },
    ],
  };
  const rows = rowsOf(await call(client, 'GET', `/v2/pricebookentry?${qs(params)}`));
  return new Map(rows.map((e) => [idOf(e), e]));
}

async function loadPointer(client, quote) {
  const id = idOf(quote && quote.commercialException);
  if (!ID_RE.test(id)) return null;
  const rows = rowsOf(await call(client, 'GET', `/v2/commercialexception/search?${qs({ xquery: { _id: id }, select: 'status requestType deal ignoreProductRules', limit: '1' })}`));
  // A pointer to a record that no longer exists is dropped by the server on the next save.
  return rows[0] || { _id: id, missing: true, ignoreProductRules: [] };
}

// What the server would compute for a line, when it cannot tell us: a discount travels as a pair, so a
// rate implies an amount and an amount implies a rate. Other derived values (markup…) are not estimated.
function estimateLine(line) {
  const out = { ...line };
  const price = typeof out.price === 'number' ? out.price : 0;
  if (out.discountRate > 0 && !out.discountAmount) out.discountAmount = price * out.discountRate;
  else if (out.discountAmount > 0 && !out.discountRate && price) out.discountRate = out.discountAmount / price;
  return out;
}

// Calculates the quote on the server (writes nothing). The server checks rules on the values it calculates
// and answers 400 at the first broken one; then its message is kept and the lines are estimated locally.
async function calculatedQuote(client, quote) {
  const res = await client.request('PUT', '/v2/quote/calculate', { data: quote });
  if (res.ok && res.body && Array.isArray(res.body.lineItems)) {
    const byUuid = new Map(res.body.lineItems.map((l) => [l && l.uuid, l]));
    const ordered = (quote.lineItems || []).map((l) => byUuid.get(l.uuid) || l);
    return { quote: { ...quote, lineItems: ordered }, calculated: true, total: res.body.total, server: { ok: true, total: res.body.total } };
  }
  const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
  return {
    quote: { ...quote, lineItems: (quote.lineItems || []).map(estimateLine) },
    calculated: false,
    server: { ok: false, status: res.status, message: body.error || body.message || 'no message' },
  };
}

function summarizeRequest(r) {
  const entry = (r.ignoreProductRules || [])[0] || {};
  const rule = (entry.rules || [])[0] || {};
  return {
    _id: idOf(r),
    deal: r.deal && typeof r.deal === 'object' ? { _id: idOf(r.deal), dealName: r.deal.dealName } : r.deal,
    status: r.status,
    requestType: r.requestType,
    uuid: entry.uuid,
    field: rule.field,
    asked: rule.requestedValue !== undefined ? rule.requestedValue : rule.value,
    approvedValue: r.status === 'Approved' || r.status === 'Superseded' ? rule.value : undefined,
    originalValue: rule.originalValue,
    justification: r.justification,
    approver: r.approver && typeof r.approver === 'object' ? { _id: idOf(r.approver), name: fullName(r.approver), email: r.approver.email } : r.approver,
    requestedBy: r.createdBy && typeof r.createdBy === 'object' ? { _id: idOf(r.createdBy), name: fullName(r.createdBy), email: r.createdBy.email } : r.createdBy,
    decidedBy: fullName(r.decidedBy) || undefined,
    decisionComment: r.decisionComment,
    appliedIn: r.appliedIn || null,
    ...(r.status === 'Approved' && r.requestType === 'Request' && !r.appliedIn ? { notInQuote: true } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function approverList(client, deal) {
  const scope = deal.workspace ? {
    $or: [{ workspace: idOf(deal.workspace) }, { primaryWorkspace: idOf(deal.workspace) },
      { selectableWorkspaces: idOf(deal.workspace) }, { sharedWorkspaces: idOf(deal.workspace) }],
  } : undefined;
  const base = { select: 'firstName lastName email', limit: '100', sort: 'firstName' };
  const deciders = rowsOf(await call(client, 'GET', `/v2/user/search?${qs({ ...base, outputFormat: 'commercialExceptionApprovers', ...(scope ? { xquery: scope } : {}) })}`));
  const admins = rowsOf(await call(client, 'GET', `/v2/user/search?${qs({ ...base, xquery: { isAdmin: true, status: 'Active' } })}`));
  const seen = new Set();
  const out = [];
  for (const [group, rows] of [['approver', deciders], ['admin', admins]]) {
    for (const u of rows) {
      if (seen.has(idOf(u))) continue;
      seen.add(idOf(u));
      out.push({ _id: idOf(u), name: fullName(u), email: u.email, group });
    }
  }
  return out;
}

function lineByUuid(quote, uuid) {
  return ((quote && quote.lineItems) || []).find((l) => l && l.uuid === uuid) || null;
}

function owners(deal) {
  return [...new Set([idOf(deal.assignee), idOf(deal.createdBy)].filter(Boolean))];
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdDeals(client, [name]) {
  if (!name || !String(name).trim()) throw new UsageError('Usage: exception.js deals <domain> <part of the deal name>');
  const pattern = `(?i)${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const rows = rowsOf(await call(client, 'GET', `/v2/deal?${qs({ xquery: { dealName: { $regex: pattern } }, select: 'dealName updatedAt', sort: '-updatedAt', limit: '10' })}`));
  return { deals: rows.map((d) => ({ _id: idOf(d), dealName: d.dealName, updatedAt: d.updatedAt })) };
}

async function cmdDiagnose(client, [dealId], flags) {
  if (!ID_RE.test(String(dealId))) throw new UsageError('Usage: exception.js diagnose <domain> <dealId> [--try \'[{"uuid":"…","discountRate":0.18}]\']');
  const { deal, stage, quote: stored } = await loadDeal(client, dealId);
  const quote = JSON.parse(JSON.stringify(stored));
  const tried = [];
  if (flags.try) {
    let edits;
    try {
      edits = JSON.parse(flags.try);
    } catch {
      throw new UsageError('--try is not valid JSON.');
    }
    if (!Array.isArray(edits)) edits = [edits];
    for (const edit of edits) {
      const line = lineByUuid(quote, edit && edit.uuid);
      if (!line) throw new UsageError(`--try: no line with uuid ${edit && edit.uuid}. Run diagnose without --try to see the uuids.`);
      applyTry(line, edit);
      tried.push(edit.uuid);
    }
  }
  const [entries, pointer, requests] = await Promise.all([
    loadEntries(client, quote), loadPointer(client, quote),
    findExceptions(client, { deal: dealId, requestType: 'Request' }, { limit: 50 }),
  ]);
  const calc = (quote.lineItems || []).length ? await calculatedQuote(client, quote) : { quote, calculated: true, server: { ok: true } };
  const result = evaluateQuote(calc.quote, entries, pointer);
  if (!calc.calculated) {
    result.notes.push('The server stopped at the first broken rule, so the other lines were checked on their stored values. '
      + 'A discount rate was turned into an amount (and back) locally; other values the server derives, such as markup, may differ.');
  }
  const lines = (calc.quote.lineItems || []).map((line) => {
    const entry = entries.get(idOf(line.pricebookEntry));
    const { source, rules } = effectiveRules(entry);
    const limits = limitsOf(rules);
    const values = {};
    for (const l of limits) if (!PRODUCT_LIST_KEYS.includes(l.field)) values[l.field] = line[l.field];
    return {
      uuid: line.uuid, product: line.productName, catalog: Boolean(line.pricebookEntry) && !line.isVirtual,
      ruleSource: source, limits: limits.map(({ field, kind, limit, rule }) => ({ field, kind, limit, rule })), values,
    };
  });
  const { server } = calc;
  const agree = server.ok === !result.violations.length;
  const pointerRules = pointer && !pointer.missing ? (pointer.ignoreProductRules || []).flatMap((e) => (e.rules && e.rules.length
    ? e.rules.map((r) => ({ uuid: e.uuid, field: r.field, pinnedTo: r.value, originalValue: r.originalValue }))
    : [{ uuid: e.uuid, field: '*', note: 'every rule of this line is lifted' }])) : [];
  return {
    deal: {
      _id: idOf(deal), dealName: deal.dealName, updatedAt: deal.updatedAt, proposalOn: Boolean(deal.proposal && deal.proposal.enabled),
      stage: stage ? stage.stageName : null, endFlowStage: Boolean(stage && stage.endFlowStage),
    },
    tried: tried.length ? tried : undefined,
    exception: pointer ? {
      _id: idOf(pointer), status: pointer.status || (pointer.missing ? 'missing' : null),
      liftsWholeDeal: !pointer.missing && !(pointer.ignoreProductRules || []).length, rules: pointerRules,
    } : null,
    lines,
    violations: result.violations.map((v) => ({
      ...v, message: explain(v),
      requestable: !['pointerNotApproved', 'include', 'exclude', 'missingField'].includes(v.kind),
    })),
    notes: result.notes,
    server,
    ...(agree ? {} : { warning: 'The local check and the server disagree. Trust the server message and report the case.' }),
    requests: requests.map(summarizeRequest),
    nextStep: result.violations.length
      ? 'Explain each violation in plain words. To go past a limit the seller asks for an exception (request-preview). Changing the quote itself is prolibu-quotes.'
      : 'No rule blocks this quote.',
  };
}

async function cmdRequests(client, args, flags) {
  const xquery = { requestType: 'Request' };
  if (flags.deal) xquery.deal = needId(flags.deal, '--deal');
  if (flags.status) {
    if (!['Pending', 'Approved', 'Rejected', 'Cancelled', 'Superseded'].includes(flags.status)) throw new UsageError('--status must be Pending, Approved, Rejected, Cancelled or Superseded.');
    xquery.status = flags.status;
  }
  if (flags.mine || flags.toMe) {
    const user = await me(client);
    if (flags.mine) xquery.createdBy = user._id;
    if (flags.toMe) xquery.approver = user._id;
  }
  const rows = await findExceptions(client, xquery, { limit: flags.limit || 50 });
  return { count: rows.length, requests: rows.map(summarizeRequest) };
}

async function cmdApprovers(client, [dealId]) {
  if (!ID_RE.test(String(dealId))) throw new UsageError('Usage: exception.js approvers <domain> <dealId>');
  const { deal } = await loadDeal(client, dealId);
  return { deal: { _id: idOf(deal), dealName: deal.dealName }, approvers: await approverList(client, deal) };
}

// ─── Requests (seller side) ────────────────────────────────────────────────────

async function prepareRequest(client, plan) {
  needId(plan.dealId, 'dealId');
  if (typeof plan.uuid !== 'string' || !plan.uuid) throw new UsageError('The plan needs "uuid" (the line uuid from diagnose).');
  if (typeof plan.field !== 'string' || !plan.field) throw new UsageError('The plan needs "field" (for example "discountRate").');
  if (plan.value === undefined) throw new UsageError('The plan needs "value" (the value asked for; rates are decimals).');
  const justification = cleanText(plan.justification, 'justification', true);
  if (typeof plan.approver !== 'string' || !plan.approver.trim()) throw new UsageError('The plan needs "approver" (user _id or e-mail from the approvers command).');

  const user = await me(client);
  const { deal, stage, quote } = await loadDeal(client, plan.dealId);
  const blockers = [];
  const warnings = [];
  const line = lineByUuid(quote, plan.uuid);
  if (!line) {
    throw new Blocked('That line is not in the saved quote. An approval could not reach it ("not applied"). Save the quote first (prolibu-quotes), then ask again.');
  }
  if (!(deal.proposal && deal.proposal.enabled)) blockers.push('The deal\'s proposal is off: an approval would not reach the quote. Turn it on by saving the quote (prolibu-quotes).');
  if (stage && stage.endFlowStage) blockers.push(`The deal is in "${stage.stageName}", an end-of-flow stage: an approval would not reach the quote.`);
  const value = checkValue(plan.field, plan.value, line[plan.field]);

  const [entries, pointer, approvers, pending] = await Promise.all([
    loadEntries(client, quote), loadPointer(client, quote), approverList(client, deal),
    findExceptions(client, { deal: plan.dealId, requestType: 'Request', status: 'Pending' }, { limit: 50 }),
  ]);
  const entry = entries.get(idOf(line.pricebookEntry));
  const { rules } = effectiveRules(entry);
  const limits = limitsOf(rules).filter((l) => l.field === plan.field);
  const honored = pointer && !pointer.missing && (!pointer.status || HONORED.includes(pointer.status));
  const pointerEntry = honored ? (pointer.ignoreProductRules || []).find((e) => e && e.uuid === plan.uuid) : null;
  const applied = pointerEntry ? (pointerEntry.rules || []).find((r) => r && r.field === plan.field) : null;
  {
    // What the line would break with the value asked, without the pin on this field (calculated by the server
    // when it accepts the quote, else estimated locally).
    const others = pointerEntry ? (pointerEntry.rules || []).filter((r) => r && r.field !== plan.field) : [];
    const trialQuote = JSON.parse(JSON.stringify(quote));
    const trialLine = lineByUuid(trialQuote, plan.uuid);
    trialLine[plan.field] = value;
    if (plan.field === 'discountRate') trialLine.discountAmount = 0;
    if (plan.field === 'discountAmount') trialLine.discountRate = 0;
    const calc = await calculatedQuote(client, trialQuote);
    const calcLine = lineByUuid(calc.quote, plan.uuid);
    const broken = evaluateLine({ line: calcLine, entry, quoteProductIds: (calc.quote.lineItems || []).map((l) => idOf(l.product)), exceptionRules: others });
    const onField = broken.filter((v) => v.field === plan.field);
    const elsewhere = broken.filter((v) => v.field !== plan.field);
    if (!limits.length && !elsewhere.length) {
      blockers.push(`No product rule limits ${plan.field} on ${line.productName}: no exception is needed. Change the quote with prolibu-quotes.`);
    } else if (!applied && !broken.length) {
      blockers.push(`${JSON.stringify(value)} is already allowed for ${plan.field} on ${line.productName}: no exception is needed. Change the quote with prolibu-quotes.`);
    } else if (!onField.length && elsewhere.length) {
      blockers.push(`The limit that this value breaks is on ${elsewhere.map((v) => `${v.field} (it would become ${JSON.stringify(v.value)}; rule "${v.rule}")`).join(', ')}, not on ${plan.field}. `
        + 'Ask for that field instead, or the approval would fail to reach the quote.');
    } else if (elsewhere.length) {
      warnings.push(`This value also breaks ${elsewhere.map((v) => `${v.field} (rule "${v.rule}")`).join(', ')}: the approval may not reach the quote until that is excepted too.`);
    }
  }
  const clash = pending.find((r) => (r.ignoreProductRules || []).some((e) => e.uuid === plan.uuid && (e.rules || []).some((x) => x.field === plan.field)));
  if (clash) {
    const own = idOf(clash.createdBy) === user._id;
    blockers.push(own
      ? `You already have a pending request for ${plan.field} on this line (${idOf(clash)}). Edit it instead (edit-preview).`
      : `Someone else already has a pending request for ${plan.field} on this line (${idOf(clash)}). Wait for its decision.`);
  }
  const who = String(plan.approver).trim().toLowerCase();
  const approver = approvers.find((a) => a._id === who || (a.email && a.email.toLowerCase() === who));
  if (!approver) blockers.push('The approver is not allowed for this deal. Pick one from the approvers command.');
  if (approver && approver._id === user._id) warnings.push('You named yourself as approver: the platform drops a notice to its own author, so nobody is told.');
  if (!user.isAdmin && owners(deal).length && !owners(deal).includes(user._id)) {
    warnings.push('You do not own this deal: the server accepts the request only if you collaborate on it or may edit deals there.');
  }
  warnings.push('Once approved, the line is fixed at exactly the approved value; any later change to that field needs a new request.');
  if (plan.field === 'price') warnings.push('minPrice/maxPrice compare the list price, not the price after discount.');

  const originalValue = applied && 'originalValue' in applied ? applied.originalValue : line[plan.field];
  const body = {
    deal: plan.dealId, requestType: 'Request', justification,
    approver: approver ? approver._id : String(plan.approver),
    ignoreProductRules: [{ uuid: plan.uuid, rules: [{ field: plan.field, value, originalValue }] }],
  };
  return {
    user, deal, line, body, approver, blockers, warnings,
    version: `${hash(body)}:${deal.updatedAt}`,
  };
}

async function cmdRequestPreview(client, [planArg], flags, ctx) {
  const prep = await prepareRequest(client, readPlan(planArg, ctx.rootDir));
  return {
    deal: { _id: idOf(prep.deal), dealName: prep.deal.dealName },
    line: { uuid: prep.line.uuid, product: prep.line.productName },
    field: prep.body.ignoreProductRules[0].rules[0].field,
    current: prep.body.ignoreProductRules[0].rules[0].originalValue,
    asked: prep.body.ignoreProductRules[0].rules[0].value,
    justification: prep.body.justification,
    approver: prep.approver || null,
    reachesPeople: prep.approver ? [`${prep.approver.name} <${prep.approver.email}>: platform notice and e-mail, whatever their settings`] : [],
    warnings: prep.warnings,
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not send.'
      : `${STOP}request with the same plan, --version ${prep.version}, --confirmed and --reaches-people.`,
  };
}

function needWriteFlags(flags) {
  if (!flags.version) throw new UsageError('Missing --version. Run the preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview to the user and wait for a yes.');
  if (!flags.reachesPeople) throw new UsageError('This e-mails or notifies people. Add --reaches-people only after the user said yes to exactly this.');
}

async function cmdRequest(client, [planArg], flags, ctx) {
  needWriteFlags(flags);
  const prep = await prepareRequest(client, readPlan(planArg, ctx.rootDir));
  if (prep.version !== flags.version) throw new Blocked('The deal or the plan changed since the preview. Run request-preview again and show the user.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  let created;
  try {
    created = await call(client, 'POST', '/v2/commercialexception', { data: prep.body, confirmed: true, reachesPeople: true });
  } catch (err) {
    if (err.details && err.details.code === 'pendingExists') throw new Blocked(`A pending request for this line and field already exists (${err.details.pendingId}).`);
    throw err;
  }
  const back = summarizeRequest(await loadException(client, idOf(created)));
  return { created: back.status === 'Pending', request: back };
}

async function prepareOwnPending(client, plan) {
  needId(plan.id, 'id');
  const user = await me(client);
  const record = await loadException(client, plan.id);
  const blockers = [];
  if (record.requestType !== 'Request' || record.status !== 'Pending') blockers.push(`This request is ${record.status}; only a pending request can change.`);
  if (idOf(record.createdBy) !== user._id) blockers.push('Only the person who asked can edit or withdraw this request.');
  return { user, record, blockers };
}

async function prepareEdit(client, plan) {
  const { user, record, blockers } = await prepareOwnPending(client, plan);
  const rule = ((record.ignoreProductRules || [])[0] || {}).rules?.[0] || {};
  const body = { id: plan.id };
  const changes = [];
  if (plan.value !== undefined) {
    body.value = checkValue(rule.field, plan.value, rule.value);
    if (body.value !== rule.value) changes.push({ field: 'value', from: rule.value, to: body.value });
  }
  if (plan.justification !== undefined) {
    body.justification = cleanText(plan.justification, 'justification', true);
    if (body.justification !== record.justification) changes.push({ field: 'justification', to: body.justification });
  }
  let approver = record.approver && typeof record.approver === 'object'
    ? { _id: idOf(record.approver), name: fullName(record.approver), email: record.approver.email } : null;
  if (plan.approver !== undefined) {
    const { deal } = await loadDeal(client, idOf(record.deal));
    const who = String(plan.approver).trim().toLowerCase();
    const found = (await approverList(client, deal)).find((a) => a._id === who || (a.email && a.email.toLowerCase() === who));
    if (!found) blockers.push('The approver is not allowed for this deal. Pick one from the approvers command.');
    else {
      body.approver = found._id;
      if (found._id !== (approver && approver._id)) changes.push({ field: 'approver', from: approver && approver.name, to: found.name });
      approver = found;
    }
  }
  if (!changes.length && !blockers.length) blockers.push('The plan changes nothing.');
  return { user, record, rule, body, changes, approver, blockers, version: `${record.updatedAt}:${hash(body)}` };
}

async function cmdEditPreview(client, [planArg], flags, ctx) {
  const prep = await prepareEdit(client, readPlan(planArg, ctx.rootDir));
  return {
    request: summarizeRequest(prep.record),
    changes: prep.changes,
    reachesPeople: prep.approver ? [`${prep.approver.name} <${prep.approver.email}>: asked again by platform notice and e-mail`] : [],
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not send.'
      : `${STOP}edit with the same plan, --version ${prep.version}, --confirmed and --reaches-people.`,
  };
}

async function cmdEdit(client, [planArg], flags, ctx) {
  needWriteFlags(flags);
  const prep = await prepareEdit(client, readPlan(planArg, ctx.rootDir));
  if (prep.version !== flags.version) throw new Blocked('The request changed since the preview. Run edit-preview again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  await call(client, 'PUT', '/v2/commercialexception/editRequest', { data: prep.body, confirmed: true, reachesPeople: true });
  const back = summarizeRequest(await loadException(client, prep.record._id));
  const problems = [];
  if (prep.body.value !== undefined && back.asked !== prep.body.value) problems.push('The value did not change.');
  if (prep.body.approver && back.approver && back.approver._id !== prep.body.approver) problems.push('The approver did not change.');
  return { edited: !problems.length, request: back, problems };
}

async function cmdCancelPreview(client, [planArg], flags, ctx) {
  const prep = await prepareOwnPending(client, readPlan(planArg, ctx.rootDir));
  const approver = prep.record.approver && typeof prep.record.approver === 'object' ? prep.record.approver : null;
  return {
    request: summarizeRequest(prep.record),
    reachesPeople: approver ? [`${fullName(approver)} <${approver.email}>: told the request was withdrawn (by their notification settings)`] : [],
    blockers: prep.blockers,
    version: prep.record.updatedAt,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why.'
      : `${STOP}cancel with the same plan, --version ${prep.record.updatedAt}, --confirmed and --reaches-people.`,
  };
}

async function cmdCancel(client, [planArg], flags, ctx) {
  needWriteFlags(flags);
  const prep = await prepareOwnPending(client, readPlan(planArg, ctx.rootDir));
  if (prep.record.updatedAt !== flags.version) throw new Blocked('The request changed since the preview. Run cancel-preview again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  await call(client, 'PUT', '/v2/commercialexception/cancel', { data: { id: prep.record._id }, confirmed: true, reachesPeople: true });
  const back = summarizeRequest(await loadException(client, prep.record._id));
  return { cancelled: back.status === 'Cancelled', request: back };
}

// ─── Decisions (manager side) ──────────────────────────────────────────────────

async function prepareDecision(client, plan) {
  needId(plan.id, 'id');
  if (!['approve', 'reject'].includes(plan.decision)) throw new UsageError('The plan needs "decision": "approve" or "reject".');
  const comment = plan.comment === undefined ? undefined : cleanText(plan.comment, 'comment', plan.decision === 'reject');
  if (plan.decision === 'reject' && comment === undefined) throw new UsageError('A rejection needs "comment" (the reason the seller will read).');
  const user = await me(client);
  const record = await loadException(client, plan.id);
  const summary = summarizeRequest(record);
  const blockers = [];
  const warnings = [];
  if (record.requestType !== 'Request' || record.status !== 'Pending') blockers.push(`This request is ${record.status}; only a pending request can be decided.`);
  const { deal, stage, quote } = await loadDeal(client, idOf(record.deal));
  const self = idOf(record.createdBy) === user._id || owners(deal).includes(user._id);
  if (self && !user.isAdmin) blockers.push('You asked for this request or own the deal: someone else must decide it.');
  if (self && user.isAdmin) {
    warnings.push('SELF-APPROVAL: this key\'s user asked for this request or owns the deal. The platform allows it only because the user is an admin. Say so to the user; decide needs --self-approval.');
  }
  if (!user.canDecide) warnings.push('This user may lack the permission to decide exceptions; the server will answer 403 if so.');
  const body = { status: plan.decision === 'approve' ? 'Approved' : 'Rejected' };
  if (comment) body.decisionComment = comment;
  let finalValue;
  if (plan.decision === 'approve') {
    finalValue = summary.asked;
    if (plan.approvedValue !== undefined && plan.approvedValue !== null) {
      const v = checkValue(summary.field, plan.approvedValue, summary.asked);
      if (JSON.stringify(v) !== JSON.stringify(summary.asked)) {
        body.approvedValue = v;
        finalValue = v;
      }
    }
  }
  const line = lineByUuid(quote, summary.uuid);
  let reachesQuote = null;
  if (plan.decision === 'approve') {
    const reasons = [];
    if (!(deal.proposal && deal.proposal.enabled)) reasons.push('the deal\'s proposal is off');
    if (!line) reasons.push('the line is not in the saved quote');
    if (stage && stage.endFlowStage) reasons.push(`the deal is in the end-of-flow stage "${stage.stageName}"`);
    reachesQuote = reasons.length
      ? { expected: false, why: `The approval will be recorded but NOT written into the quote: ${reasons.join('; ')}.` }
      : { expected: true, change: { product: line.productName, field: summary.field, from: line[summary.field], to: finalValue } };
    if (!reasons.length) {
      const trialQuote = JSON.parse(JSON.stringify(quote));
      const trialLine = lineByUuid(trialQuote, summary.uuid);
      trialLine[summary.field] = finalValue;
      if (summary.field === 'discountRate') trialLine.discountAmount = 0;
      if (summary.field === 'discountAmount') trialLine.discountRate = 0;
      const calc = await calculatedQuote(client, trialQuote);
      if (calc.calculated) {
        const after = lineByUuid(calc.quote, summary.uuid);
        reachesQuote.quoteCurrency = quote.quoteCurrency || null;
        reachesQuote.totalBefore = typeof quote.total === 'number' ? quote.total : null;
        reachesQuote.totalAfter = typeof calc.total === 'number' ? calc.total : null;
        reachesQuote.lineTotalAfter = after && typeof after.total === 'number' ? after.total : null;
      } else {
        reachesQuote.totalBefore = typeof quote.total === 'number' ? quote.total : null;
        reachesQuote.totalAfter = null;
        reachesQuote.totalNote = 'The new total is calculated by the platform when it applies the approval; decide reports it.';
      }
    }
    if (reasons.length) warnings.push(reachesQuote.why);
    else warnings.push('Approving saves the deal: the quote is recalculated, and the account\'s deal scripts and webhooks run.');
  }
  const recipientIds = [...new Set([idOf(record.createdBy), owners(deal)[0]].filter(Boolean))];
  const recipients = await Promise.all(recipientIds.map(async (id) => {
    const r = record.createdBy && idOf(record.createdBy) === id && typeof record.createdBy === 'object' ? record.createdBy
      : await call(client, 'GET', `/v2/user/search?${qs({ xquery: { _id: id }, select: 'firstName lastName email', limit: '1' })}`).then((b) => rowsOf(b)[0]).catch(() => null);
    return r ? `${fullName(r)} <${r.email}>` : id;
  }));
  return {
    user, record, summary, deal, body, finalValue, reachesQuote, blockers, warnings, self,
    recipients: recipientIds.filter((id) => id !== user._id).length ? recipients : [],
    version: `${record.updatedAt}:${deal.updatedAt}:${hash(body)}`,
  };
}

async function cmdDecidePreview(client, [planArg], flags, ctx) {
  const prep = await prepareDecision(client, readPlan(planArg, ctx.rootDir));
  return {
    request: prep.summary,
    decision: prep.body.status,
    ...(prep.body.status === 'Approved' ? { approvedValue: prep.finalValue, counteroffer: 'approvedValue' in prep.body } : {}),
    comment: prep.body.decisionComment || null,
    reachesQuote: prep.reachesQuote,
    reachesPeople: prep.recipients.length ? prep.recipients.map((r) => `${r}: notice, e-mail and pop-up (by their settings)`)
      : ['Nobody else: the requester and the deal owner are this user, and the platform drops notices to their own author.'],
    selfApproval: prep.self || undefined,
    warnings: prep.warnings,
    blockers: prep.blockers,
    version: prep.version,
    nextStep: prep.blockers.length ? 'Blocked: tell the user why; do not decide.'
      : `${STOP}decide with the same plan, --version ${prep.version}, --confirmed and --reaches-people${prep.self ? ' and --self-approval' : ''}.`,
  };
}

async function cmdDecide(client, [planArg], flags, ctx) {
  needWriteFlags(flags);
  const prep = await prepareDecision(client, readPlan(planArg, ctx.rootDir));
  if (prep.version !== flags.version) throw new Blocked('The request or the deal changed since the preview. Run decide-preview again.');
  if (prep.blockers.length) throw new Blocked(prep.blockers.join(' '));
  if (prep.self && !flags.selfApproval) throw new Blocked('This is a self-approval. Add --self-approval only after the user confirmed it knowing that.');
  await call(client, 'PATCH', `/v2/commercialexception/${prep.record._id}`, { data: prep.body, confirmed: true, reachesPeople: true });
  const back = summarizeRequest(await loadException(client, prep.record._id));
  const out = { decided: back.status === prep.body.status, request: back };
  if (prep.body.status === 'Approved') {
    const { quote } = await loadDeal(client, idOf(prep.deal));
    const line = lineByUuid(quote, back.uuid);
    const pointer = idOf(quote.commercialException);
    if (back.appliedIn && pointer === idOf(back.appliedIn) && line && line[back.field] === prep.finalValue) {
      out.inQuote = {
        applied: true, line: line.productName, field: back.field, value: line[back.field], exception: pointer,
        lineTotal: typeof line.total === 'number' ? line.total : null, quoteTotal: typeof quote.total === 'number' ? quote.total : null, quoteCurrency: quote.quoteCurrency || null,
      };
    } else if (back.appliedIn) {
      out.inQuote = { applied: true, note: 'Applied, but the quote has changed since (another approval or a save).' };
    } else {
      out.inQuote = {
        applied: false,
        reason: line ? 'applyFailed: the deal refused the save (closed stage, or another rule still fails). The approval stands; the quote was not changed.'
          : 'lineMissing: the line is not in the saved quote (or the proposal is off). The approval stands; the quote was not changed.',
      };
    }
  }
  return out;
}

// ─── Product rules ─────────────────────────────────────────────────────────────

const RULE_SELECT = ['productRuleName', 'productRuleCode', 'lockedFields', ...LIMIT_KEYS, ...PRODUCT_LIST_KEYS, 'updatedAt'].join(' ');

function summarizeRule(rule) {
  const limits = {};
  for (const key of LIMIT_KEYS) if (key in rule) limits[key] = rule[key];
  const locked = Object.entries(rule.lockedFields || {}).filter(([, v]) => v === true).map(([k]) => k);
  return {
    _id: idOf(rule), productRuleName: rule.productRuleName, productRuleCode: rule.productRuleCode, limits, locked,
    mustIncludeProducts: (rule.mustIncludeProducts || []).map(idOf), mustExcludeProducts: (rule.mustExcludeProducts || []).map(idOf),
    updatedAt: rule.updatedAt,
  };
}

async function findRule(client, ref) {
  const path = ID_RE.test(String(ref)) ? `/v2/productrule/${ref}` : `/v2/productrule/${encodeURIComponent(String(ref))}`;
  const res = await client.request('GET', path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /v2/productrule answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
  return res.body;
}

async function usage(client, ruleId) {
  const count = async (object) => {
    const body = await call(client, 'GET', `/v2/${object}?${qs({ xquery: { rules: ruleId }, select: object === 'product' ? 'productName productCode' : 'product pricebook', limit: '20' })}`);
    return { count: (body.pagination && body.pagination.count) || rowsOf(body).length, sample: rowsOf(body).map((r) => r.productName || idOf(r)) };
  };
  const [products, entries] = await Promise.all([count('product'), count('pricebookentry')]);
  return { products, priceListEntries: entries };
}

async function cmdRules(client, [term]) {
  const params = { select: RULE_SELECT, sort: 'productRuleName', limit: '100' };
  const body = term
    ? await call(client, 'GET', `/v2/productrule/search?${qs({ ...params, term: String(term) })}`)
    : await call(client, 'GET', `/v2/productrule?${qs(params)}`);
  return { count: (body.pagination && body.pagination.count) || rowsOf(body).length, rules: rowsOf(body).map(summarizeRule) };
}

async function cmdRule(client, [ref]) {
  if (!ref) throw new UsageError('Usage: exception.js rule <domain> <ruleId|ruleCode>');
  const rule = await findRule(client, ref);
  if (!rule) throw new Blocked(`No product rule ${ref}.`);
  return { rule: summarizeRule(rule), usedBy: await usage(client, idOf(rule)) };
}

async function resolveProducts(client, refs) {
  const ids = [];
  for (const ref of refs) {
    const res = await client.request('GET', `/v2/product/${encodeURIComponent(ref)}?${qs({ select: 'productName' })}`);
    if (!res.ok || !res.body || !idOf(res.body)) throw new Blocked(`No product ${ref}.`);
    ids.push(idOf(res.body));
  }
  return ids;
}

async function prepareRule(client, plan) {
  const existing = plan.rule !== undefined ? await findRule(client, plan.rule) : null;
  if (plan.rule !== undefined && !existing) throw new Blocked(`No product rule ${plan.rule}. Omit "rule" to create one.`);
  const { warnings } = validateRuleSet(plan.set, existing);
  const body = { ...plan.set };
  if (body.productRuleName) body.productRuleName = body.productRuleName.trim();
  // The whole lockedFields object travels, so fields locked before stay locked.
  if (body.lockedFields) body.lockedFields = { ...((existing && existing.lockedFields) || {}), ...body.lockedFields };
  for (const key of PRODUCT_LIST_KEYS) if (body[key]) body[key] = await resolveProducts(client, body[key]);
  const changes = [];
  for (const [key, value] of Object.entries(body)) {
    const before = existing ? existing[key] : undefined;
    if (value === null && (before === undefined || before === null)) continue;
    if (JSON.stringify(before) !== JSON.stringify(value)) changes.push({ field: key, from: before === undefined ? null : before, to: value });
  }
  if (!changes.length) throw new Blocked('The plan changes nothing on this rule.');
  if (!existing && body.productRuleCode && await findRule(client, body.productRuleCode)) {
    throw new Blocked(`A product rule with code ${body.productRuleCode} already exists. Edit it instead ("rule": "${body.productRuleCode}").`);
  }
  const used = existing ? await usage(client, idOf(existing)) : null;
  if (used && (used.products.count || used.priceListEntries.count)) {
    warnings.push(`Every open quote with these products is checked against the new limits on its next save: ${used.products.count} products and ${used.priceListEntries.count} price-list entries use this rule.`);
  }
  if (!existing) warnings.push('A new rule does nothing until it is attached to a product or price-list entry (prolibu-catalog).');
  return {
    existing, body, changes, warnings, used,
    version: existing ? `${existing.updatedAt}:${hash(body)}` : hash(body),
  };
}

async function cmdRulePreview(client, [planArg], flags, ctx) {
  const prep = await prepareRule(client, readPlan(planArg, ctx.rootDir));
  return {
    action: prep.existing ? 'update' : 'create',
    rule: prep.existing ? summarizeRule(prep.existing) : null,
    changes: prep.changes,
    usedBy: prep.used,
    warnings: prep.warnings,
    version: prep.version,
    nextStep: `${STOP}rule-apply with the same plan, --version ${prep.version} and --confirmed.`,
  };
}

async function cmdRuleApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run rule-preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview to the user and wait for a yes.');
  const prep = await prepareRule(client, readPlan(planArg, ctx.rootDir));
  if (prep.version !== flags.version) throw new Blocked('The rule or the plan changed since the preview. Run rule-preview again.');
  const saved = prep.existing
    ? await call(client, 'PATCH', `/v2/productrule/${idOf(prep.existing)}`, { data: prep.body, confirmed: true })
    : await call(client, 'POST', '/v2/productrule', { data: prep.body, confirmed: true });
  const back = await findRule(client, idOf(saved));
  const problems = [];
  for (const [key, value] of Object.entries(prep.body)) {
    const got = key === 'lockedFields' ? Object.fromEntries(Object.keys(value).map((k) => [k, (back.lockedFields || {})[k]]))
      : PRODUCT_LIST_KEYS.includes(key) ? (back[key] || []).map(idOf) : back[key];
    if (value === null ? got !== undefined && got !== null : JSON.stringify(got) !== JSON.stringify(value)) problems.push(`${key} reads back as ${JSON.stringify(got)}.`);
  }
  return { saved: !problems.length, rule: summarizeRule(back), problems, attach: 'To make it apply, attach it to products or price-list entries with prolibu-catalog.' };
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
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (arg === '--self-approval') flags.selfApproval = true;
    else if (arg === '--mine') flags.mine = true;
    else if (arg === '--to-me') flags.toMe = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--deal') flags.deal = next();
    else if (arg === '--status') flags.status = next();
    else if (arg === '--try') flags.try = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 50, 1), 200);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  deals: cmdDeals,
  diagnose: cmdDiagnose,
  requests: cmdRequests,
  approvers: cmdApprovers,
  'request-preview': cmdRequestPreview,
  request: cmdRequest,
  'edit-preview': cmdEditPreview,
  edit: cmdEdit,
  'cancel-preview': cmdCancelPreview,
  cancel: cmdCancel,
  'decide-preview': cmdDecidePreview,
  decide: cmdDecide,
  rules: cmdRules,
  rule: cmdRule,
  'rule-preview': cmdRulePreview,
  'rule-apply': cmdRuleApply,
};

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
    if (!handler || !domain) throw new UsageError(`Usage: exception.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
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
  main, evaluateQuote, evaluateLine, effectiveRules, limitsOf, validateRuleSet, checkValue, applyTry, summarizeRequest,
};
