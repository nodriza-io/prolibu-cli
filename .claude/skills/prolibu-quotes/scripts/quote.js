#!/usr/bin/env node
'use strict';

// Edits a deal's quote the way the Prolibu app does it: catalog lines are built by the
// server, existing lines travel back untouched, totals come from the server, and the
// whole quote is saved at once.
//
//   quote.js deals      <domain> <name>
//   quote.js show       <domain> <dealId>
//   quote.js pricebooks <domain>
//   quote.js search     <domain> <term> [--pricebook <id>] [--currency <ISO>] [--limit <n>]
//   quote.js preview    <domain> '<plan json>'
//   quote.js apply      <domain> '<plan json>' --deal-version <v> --confirmed [--allow-end-flow-stage]
//
// The plan is inline JSON, or the path of a JSON file in a temp folder.
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
const td = require('./time-discount');

// Line fields this script lets a plan set. The server keeps more editable fields
// (taxes, cost, percentOfTotal…), but those are left to the app on purpose.
const PLAN_FIELDS = new Set([
  'quantity', 'unitMultiplier', 'numberOfPayments', 'discountRate', 'discountAmount', 'price',
  'startDate', 'endDate', 'description', 'internalNotes', 'specialNotes', 'customFields',
]);
const AUTO_SOURCES = new Set(['preference', 'productFamily']);
const BLOCKED = 3;

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isAutoCharge(line) {
  const source = line && line.meta && line.meta.percentOfTotal && line.meta.percentOfTotal.source;
  return AUTO_SOURCES.has(source);
}

function autoChargeKey(line) {
  const pot = line.meta.percentOfTotal;
  const family = pot.productFamily && typeof pot.productFamily === 'object' ? pot.productFamily._id : pot.productFamily;
  return `${pot.source}:${family || ''}:${pot.scopeKey || ''}`;
}

function lineKind(line) {
  if (isAutoCharge(line)) return 'auto-charge';
  if (line.pricebookEntry && !line.isVirtual) return 'catalog';
  return 'virtual';
}

// An events-quote line covers one day: local midnight to the next local midnight (exclusive).
function eventDay(ymd, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!match) throw new UsageError(`Invalid day "${ymd}". Use YYYY-MM-DD.`);
  const [y, m, d] = match.slice(1).map(Number);
  return { startDate: td.midnightIn(y, m, d, timeZone), endDate: td.midnightIn(y, m, d + 1, timeZone) };
}

function validateEdits(edits, where) {
  const out = {};
  for (const [key, value] of Object.entries(edits || {})) {
    if (!PLAN_FIELDS.has(key)) {
      throw new UsageError(`${where}: "${key}" cannot be set by this script. Allowed: ${[...PLAN_FIELDS].join(', ')}.`);
    }
    out[key] = value;
  }
  for (const key of ['quantity', 'unitMultiplier', 'numberOfPayments', 'price', 'discountAmount', 'discountRate']) {
    if (key in out && (typeof out[key] !== 'number' || !Number.isFinite(out[key]) || out[key] < 0)) {
      throw new UsageError(`${where}: ${key} must be a number greater than or equal to 0.`);
    }
  }
  if ('quantity' in out && out.quantity <= 0) throw new UsageError(`${where}: quantity must be greater than 0.`);
  if ('discountRate' in out && out.discountRate > 1) {
    throw new UsageError(`${where}: discountRate is a decimal (10% = 0.1), not a percentage.`);
  }
  // The server lets discountAmount win when both are set, so a discount always travels as a pair.
  if ('discountRate' in out && !('discountAmount' in out)) out.discountAmount = 0;
  if ('discountAmount' in out && !('discountRate' in out)) out.discountRate = 0;
  return out;
}

function readPlan(arg, rootDir) {
  let text = String(arg);
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
  if (!plan || typeof plan !== 'object' || typeof plan.dealId !== 'string' || !/^[a-f0-9]{24}$/i.test(plan.dealId)) {
    throw new UsageError('The plan needs "dealId" (24 hex characters).');
  }
  for (const key of ['add', 'update', 'remove']) {
    if (plan[key] !== undefined && !Array.isArray(plan[key])) throw new UsageError(`"${key}" must be an array.`);
  }
  if (plan.timeDiscount !== undefined && (!plan.timeDiscount || typeof plan.timeDiscount !== 'object' || Array.isArray(plan.timeDiscount))) {
    throw new UsageError('"timeDiscount" must be an object.');
  }
  if (!(plan.add || []).length && !(plan.update || []).length && !(plan.remove || []).length && !plan.timeDiscount) {
    throw new UsageError('The plan changes nothing: add "add", "update", "remove" or "timeDiscount".');
  }
  return plan;
}

// Builds the quote to send: the stored quote untouched, plus the plan's changes.
// `formatted` maps each add index to the line formatLineItem returned for it.
function buildQuote(storedQuote, plan, formatted, {
  timeZone, now = new Date(), forApply = false, newUuid = () => crypto.randomUUID(),
} = {}) {
  const quote = clone(storedQuote) || {};
  const lines = Array.isArray(quote.lineItems) ? quote.lineItems : [];
  const byUuid = new Map(lines.map((line) => [line.uuid, line]));
  const isEvents = quote.quoteMode === 'Events';
  const warnings = [];
  const added = [];
  const discountChanges = [];

  for (const [i, change] of (plan.update || []).entries()) {
    const line = byUuid.get(change.uuid);
    if (!line) throw new UsageError(`update[${i}]: no line with uuid ${change.uuid}. Run "show" for the current uuids.`);
    if (isAutoCharge(line)) throw new UsageError(`update[${i}]: ${line.productName} is an automatic charge; the server prices it.`);
    const edits = { ...change };
    delete edits.uuid;
    const valid = validateEdits(edits, `update[${i}]`);
    if ('discountRate' in valid || 'discountAmount' in valid) {
      td.clearOriginals(line);
      discountChanges.push({ uuid: line.uuid, discountRate: valid.discountRate, discountAmount: valid.discountAmount });
    }
    Object.assign(line, valid);
  }

  const dismissed = [];
  const removeSet = new Set();
  for (const [i, change] of (plan.remove || []).entries()) {
    const line = byUuid.get(change.uuid);
    if (!line) throw new UsageError(`remove[${i}]: no line with uuid ${change.uuid}.`);
    if (isAutoCharge(line)) {
      if (change.dismissAutoCharge !== true) {
        throw new UsageError(`remove[${i}]: ${line.productName} is an automatic charge and comes back on every calculation. `
          + 'Set "dismissAutoCharge": true only if the user wants it gone from this quote.');
      }
      dismissed.push(autoChargeKey(line));
    }
    if (Array.isArray(line.includedLineIds) && line.includedLineIds.length) {
      warnings.push(`${line.productName} brought included products; removing it does not remove them. Check the preview.`);
    }
    removeSet.add(change.uuid);
  }
  quote.lineItems = lines.filter((line) => !removeSet.has(line.uuid));
  if (dismissed.length) {
    const apot = quote.autoPercentOfTotal && typeof quote.autoPercentOfTotal === 'object' ? quote.autoPercentOfTotal : {};
    quote.autoPercentOfTotal = { ...apot, dismissed: [...new Set([...(apot.dismissed || []), ...dismissed])] };
  }

  // New lines go before the automatic charges the server keeps at the end, as the app does.
  let insertAt = quote.lineItems.length;
  while (insertAt > 0 && isAutoCharge(quote.lineItems[insertAt - 1])) insertAt -= 1;

  for (const [i, change] of (plan.add || []).entries()) {
    const line = clone(formatted[i]);
    if (!line || !line.pricebookEntry) throw new UsageError(`add[${i}]: the server did not return a catalog line.`);
    const { day } = change;
    const rest = { ...change };
    delete rest.pricebookEntryId;
    delete rest.day;
    const edits = validateEdits(rest, `add[${i}]`);
    if (day !== undefined) {
      if (!timeZone) throw new UsageError(`add[${i}]: "day" needs a time zone. Add "timeZone" to the plan.`);
      Object.assign(edits, eventDay(day, timeZone));
    }
    if (isEvents && !(edits.startDate && edits.endDate) && !(line.startDate && line.endDate)) {
      throw new UsageError(`add[${i}]: this is an events quote; give the line a "day" (or startDate and endDate).`);
    }
    Object.assign(line, edits);
    delete line.lineId;
    delete line.calendarEvents;
    line.uuid = newUuid();
    if (!line.currency && quote.quoteCurrency) line.currency = quote.quoteCurrency;
    quote.lineItems.splice(insertAt, 0, line);
    insertAt += 1;
    added.push(line.uuid);
  }

  const firstVirtual = quote.lineItems.findIndex((line) => !line.pricebookEntry);
  if (firstVirtual !== -1 && quote.lineItems.slice(firstVirtual + 1).some((line) => line.pricebookEntry)) {
    warnings.push('A line without a catalog entry sits before catalog lines. Keep catalog lines first, '
      + 'as the app does: reorder the lines in the app before relying on this quote.');
  }
  // The time window: server-written fields never travel back; the plan's change, if any, applies.
  let timeDiscount = null;
  if (plan.timeDiscount) {
    timeDiscount = td.resolveTimeDiscount(plan.timeDiscount, storedQuote && storedQuote.timeSensitiveDiscounts, { timeZone, now, forApply });
    td.applyTimeDiscount(quote, timeDiscount);
  } else if (quote.timeSensitiveDiscounts) {
    quote.timeSensitiveDiscounts = td.withoutServerFields(quote.timeSensitiveDiscounts);
  }
  return {
    quote, added, removed: [...removeSet], dismissed, warnings, timeDiscount, discountChanges,
  };
}

function money(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizeLine(line) {
  // Under a time window the stored rate is not the rate asked for: show the original instead.
  const clocked = line.originalDiscountAmount !== undefined;
  return {
    uuid: line.uuid,
    product: line.productName,
    code: line.productCode,
    kind: lineKind(line),
    quantity: line.quantity,
    price: money(line.price),
    ...(clocked
      ? { originalDiscountAmount: line.originalDiscountAmount, originalDiscountRate: line.originalDiscountRate }
      : { discountRate: line.discountRate }),
    discountAmount: line.discountAmount,
    currency: line.currency,
    total: money(line.total),
    ...(line.startDate ? { startDate: line.startDate, endDate: line.endDate } : {}),
  };
}

function summarizeQuote(quote) {
  const q = quote || {};
  return {
    quoteCurrency: q.quoteCurrency || null,
    quoteMode: q.quoteMode || 'Standard',
    lines: (q.lineItems || []).map(summarizeLine),
    totals: {
      subTotal: money(q.subTotal),
      discountAmount: money(q.discountAmount),
      taxAmount: money(q.taxAmount),
      total: money(q.total),
      convertedTotal: money(q.convertedTotal),
    },
    hasCommercialException: Boolean(q.commercialException),
    paymentPlan: Boolean(q.paymentPlan && q.paymentPlan.enabled),
  };
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

const DEAL_FIELDS = 'dealName stage contact proposal updatedAt';

async function loadDeal(client, dealId) {
  const deal = await call(client, 'GET', `/v2/deal/${dealId}?${new URLSearchParams({ select: DEAL_FIELDS })}`);
  const stageId = deal.stage && typeof deal.stage === 'object' ? deal.stage._id : deal.stage;
  let stage = null;
  if (stageId) {
    stage = await call(client, 'GET', `/v2/stage/${stageId}?${new URLSearchParams({ select: 'stageName endFlowStage' })}`);
  }
  return { deal, stage };
}

function blockers({ deal, stage }, { allowEndFlowStage = false } = {}) {
  const found = [];
  if (stage && stage.endFlowStage && !allowEndFlowStage) {
    found.push(`The deal is in "${stage.stageName}", an end-of-flow stage: the account rejects quote changes there `
      + 'unless an admin allowed edits in end-flow stages.');
  }
  if (!deal.contact) found.push('The deal has no contact; a deal with a proposal needs one. Add a contact first.');
  return found;
}

async function timeZoneFor(client, plan, storedQuote) {
  if (plan.timeZone) return plan.timeZone;
  const tsd = storedQuote && storedQuote.timeSensitiveDiscounts;
  const needed = (plan.add || []).some((change) => change.day !== undefined)
    || Boolean(plan.timeDiscount) || Boolean(tsd && tsd.enabled);
  if (!needed) return undefined;
  const me = await call(client, 'GET', '/v2/user/me');
  return (me.locale && me.locale.timeZone) || (me.profile && me.profile.locale && me.profile.locale.timeZone) || undefined;
}

async function prepare(client, plan, { forApply = false, now = new Date() } = {}) {
  const loaded = await loadDeal(client, plan.dealId);
  const formatted = [];
  for (const [i, change] of (plan.add || []).entries()) {
    if (!change || typeof change.pricebookEntryId !== 'string' || !/^[a-f0-9]{24}$/i.test(change.pricebookEntryId)) {
      throw new UsageError(`add[${i}]: "pricebookEntryId" is required (from the "search" command).`);
    }
    formatted.push(await call(client, 'GET', `/v2/quote/formatLineItem?${new URLSearchParams({ pricebookEntryId: change.pricebookEntryId })}`));
  }
  const storedQuote = (loaded.deal.proposal && loaded.deal.proposal.quote) || {};
  const timeZone = await timeZoneFor(client, plan, storedQuote);
  if (!timeZone && td.needsTimeZone(plan.timeDiscount)) {
    throw new UsageError('timeDiscount uses a local time but no time zone was found. Ask the user and add "timeZone" to the plan.');
  }
  const built = buildQuote(storedQuote, plan, formatted, { timeZone, now, forApply });
  const calculated = await call(client, 'PUT', '/v2/quote/calculate', { data: built.quote });
  const sent = new Set(built.quote.lineItems.map((line) => line.uuid));
  const serverAdded = (calculated.lineItems || []).filter((line) => !sent.has(line.uuid)).map(summarizeLine);
  const warnings = [...built.warnings];
  if (!storedQuote.quoteCurrency && calculated.quoteCurrency) {
    warnings.push(`The quote had no currency; the server set the account currency, ${calculated.quoteCurrency}. `
      + 'Confirm it with the user.');
  }
  const addedSet = new Set(built.added);
  for (const line of calculated.lineItems || []) {
    if (addedSet.has(line.uuid) && line.currency && calculated.quoteCurrency && line.currency !== calculated.quoteCurrency) {
      warnings.push(`${line.productName} is priced in ${line.currency} and converted to ${calculated.quoteCurrency} in the totals.`);
    }
  }
  if (money(calculated.total) === null) warnings.push('The calculated total is not a number: a line is missing its price. Do not save.');
  const timeBlock = td.timeDiscountPreview({
    storedQuote, calculated, plan, resolved: built.timeDiscount, addedUuids: built.added, timeZone, now,
  });
  return {
    ...loaded, built, calculated, serverAdded, warnings, storedQuote, timeBlock,
  };
}

function proposalTitle(deal, quote) {
  return (deal.proposal && deal.proposal.title) || quote.quoteName || deal.dealName || '';
}

// What the read-back must show after saving a time window: the window as resolved, and each
// line whose discount the plan set keeps that discount as its original.
function timeDiscountProblems(result, saved) {
  const problems = [];
  const resolved = result.built.timeDiscount;
  const tsd = saved.timeSensitiveDiscounts || {};
  if (resolved && resolved.off && tsd.enabled) problems.push('The time window is still on after saving.');
  if (resolved && !resolved.off) {
    if (!tsd.enabled) problems.push('The time window is not on after saving.');
    if (tsd.strategy !== resolved.strategy) problems.push(`Saved strategy is ${tsd.strategy}, not ${resolved.strategy}.`);
    for (const key of ['startFrom', 'endAt']) {
      if (Date.parse(tsd[key]) !== Date.parse(resolved[key])) problems.push(`Saved ${key} is ${tsd[key]}, not ${resolved[key]}.`);
    }
  }
  if (!tsd.enabled) return problems;
  const lines = new Map((saved.lineItems || []).map((line) => [line.uuid, line]));
  for (const change of result.built.discountChanges || []) {
    const line = lines.get(change.uuid);
    if (!line) continue;
    const asked = change.discountAmount || (line.price || 0) * (change.discountRate || 0);
    if (typeof line.originalDiscountAmount !== 'number' || Math.abs(line.originalDiscountAmount - asked) > 0.01) {
      problems.push(`${line.productName}: the saved discount is ${line.originalDiscountAmount} per unit, not ${asked}.`);
    }
  }
  return problems;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdShow(client, [dealId]) {
  if (!/^[a-f0-9]{24}$/i.test(String(dealId))) throw new UsageError('Usage: quote.js show <domain> <dealId>');
  const loaded = await loadDeal(client, dealId);
  const { deal, stage } = loaded;
  return {
    deal: { _id: deal._id, dealName: deal.dealName, updatedAt: deal.updatedAt, hasContact: Boolean(deal.contact) },
    stage: stage ? { stageName: stage.stageName, endFlowStage: Boolean(stage.endFlowStage) } : null,
    proposal: { enabled: Boolean(deal.proposal && deal.proposal.enabled), title: (deal.proposal && deal.proposal.title) || null },
    quote: summarizeQuote(deal.proposal && deal.proposal.quote),
    blockers: blockers(loaded),
  };
}

async function cmdDeals(client, [name]) {
  if (!name || !String(name).trim()) throw new UsageError('Usage: quote.js deals <domain> <part of the deal name>');
  // Case-insensitive goes inline as (?i): the API rejects a separate $options.
  const pattern = `(?i)${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const query = new URLSearchParams({
    xquery: JSON.stringify({ dealName: { $regex: pattern } }),
    select: 'dealName stage updatedAt',
    sort: '-updatedAt',
    limit: '10',
  });
  const body = await call(client, 'GET', `/v2/deal?${query}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  return { deals: rows.map((d) => ({ _id: d._id, dealName: d.dealName, updatedAt: d.updatedAt })) };
}

async function cmdPricebooks(client) {
  const query = new URLSearchParams({ select: 'pricebookName active', limit: '200', sort: 'pricebookName' });
  const body = await call(client, 'GET', `/v2/pricebook?${query}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  return { pricebooks: rows.filter((p) => p.active !== false).map((p) => ({ _id: p._id, pricebookName: p.pricebookName })) };
}

async function cmdSearch(client, [term], flags) {
  if (!term || !String(term).trim()) throw new UsageError('Usage: quote.js search <domain> <term> [--pricebook <id>] [--currency <ISO>]');
  const query = new URLSearchParams({
    term: String(term).trim(),
    limit: String(flags.limit || 20),
    page: '1',
    xquery: JSON.stringify({ active: true }),
  });
  if (flags.pricebook) query.set('pricebookId', flags.pricebook);
  const body = await call(client, 'GET', `/v2/quote/productSearch?${query}`);
  const rows = [];
  for (const product of body.data || []) {
    for (const entry of product.pricebookEntries || []) {
      const pricebook = entry.pricebook && typeof entry.pricebook === 'object' ? entry.pricebook : { _id: entry.pricebook };
      if (flags.pricebook && pricebook._id !== flags.pricebook) continue;
      if (flags.currency && entry.currency !== flags.currency) continue;
      rows.push({
        pricebookEntryId: entry._id,
        productName: product.productName,
        productCode: product.productCode,
        price: entry.price,
        currency: entry.currency,
        pricebookId: pricebook._id,
        pricebookName: pricebook.pricebookName || null,
        ...(entry.active === false || pricebook.active === false ? { inactive: true } : {}),
      });
    }
  }
  return {
    results: rows,
    totalProducts: (body.pagination && body.pagination.count) || rows.length,
    note: flags.pricebook ? undefined : 'Without --pricebook, results may include price lists the user cannot see. Confirm the price list with the user.',
  };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  if (!planArg) throw new UsageError("Usage: quote.js preview <domain> '<plan json>'");
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await prepare(client, plan);
  const found = blockers(result);
  return {
    deal: { _id: result.deal._id, dealName: result.deal.dealName },
    dealVersion: result.deal.updatedAt,
    stage: result.stage ? result.stage.stageName : null,
    turnsProposalOn: !(result.deal.proposal && result.deal.proposal.enabled),
    before: summarizeQuote(result.storedQuote),
    after: summarizeQuote(result.calculated),
    addedLines: result.built.added,
    removedLines: result.built.removed,
    dismissedAutoCharges: result.built.dismissed,
    serverAddedLines: result.serverAdded,
    timeDiscount: result.timeBlock,
    resolvedTimeDiscount: td.resolvedForApply(result.built.timeDiscount),
    warnings: result.warnings,
    blockers: found,
    nextStep: found.length
      ? 'Blocked: tell the user why; do not apply.'
      : 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --deal-version set to dealVersion'
        + (result.built.timeDiscount ? ', replacing the plan\'s "timeDiscount" with "resolvedTimeDiscount" exactly.' : '.'),
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!planArg) throw new UsageError("Usage: quote.js apply <domain> '<plan json>' --deal-version <v> --confirmed");
  if (!flags.dealVersion) {
    throw new UsageError('Missing --deal-version. Run preview first and pass its dealVersion: apply only saves what the user saw.');
  }
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await prepare(client, plan, { forApply: true });
  if (result.deal.updatedAt !== flags.dealVersion) {
    throw new Blocked('The deal changed since the preview. Run preview again and show the user the new result.');
  }
  const found = blockers(result, { allowEndFlowStage: flags.allowEndFlowStage });
  if (found.length) throw new Blocked(found.join(' '));
  if (money(result.calculated.total) === null) throw new Blocked('The calculated total is not a number; nothing was saved.');

  const proposal = { title: proposalTitle(result.deal, result.calculated), enabled: true, quote: result.calculated };
  try {
    await call(client, 'PATCH', `/v2/deal/${plan.dealId}`, { data: { proposal }, confirmed: true });
  } catch (err) {
    if (err.status === 409) {
      throw new Blocked('The quote changed because of an approval (409 staleQuote). Nothing was saved. Run preview again.');
    }
    throw err;
  }

  const after = await loadDeal(client, plan.dealId);
  const saved = (after.deal.proposal && after.deal.proposal.quote) || {};
  const savedLines = new Map((saved.lineItems || []).map((line) => [line.uuid, line]));
  const problems = [];
  for (const uuid of result.built.added) {
    const line = savedLines.get(uuid);
    if (!line) problems.push(`Added line ${uuid} is missing after saving.`);
    else if (!line.product || !line.pricebookEntry || line.isVirtual) problems.push(`Added line ${uuid} was saved as virtual.`);
  }
  const removed = new Set(result.built.removed);
  for (const line of result.storedQuote.lineItems || []) {
    // Old lines without a uuid get one from the server on save, so they cannot be matched here.
    if (!line.uuid) continue;
    if (!removed.has(line.uuid) && !isAutoCharge(line) && !savedLines.has(line.uuid)) {
      problems.push(`Existing line ${line.productName} (${line.uuid}) disappeared.`);
    }
  }
  problems.push(...timeDiscountProblems(result, saved));
  return {
    saved: problems.length === 0,
    deal: { _id: after.deal._id, dealName: after.deal.dealName, updatedAt: after.deal.updatedAt },
    quote: summarizeQuote(saved),
    problems,
  };
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
    else if (arg === '--allow-end-flow-stage') flags.allowEndFlowStage = true;
    else if (arg === '--deal-version') flags.dealVersion = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--pricebook') flags.pricebook = next();
    else if (arg === '--currency') flags.currency = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 20, 1), 100);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = { deals: cmdDeals, show: cmdShow, pricebooks: cmdPricebooks, search: cmdSearch, preview: cmdPreview, apply: cmdApply };

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
      throw new UsageError('Usage: quote.js <deals|show|pricebooks|search|preview|apply> <domain> … (see the header of this file)');
    }
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

module.exports = { main, buildQuote, eventDay, validateEdits, summarizeQuote, autoChargeKey, isAutoCharge };
