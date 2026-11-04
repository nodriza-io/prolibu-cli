#!/usr/bin/env node
'use strict';

// Proposals as their own records: the model where a deal has several proposals, each with a
// status (Draft, Ready, Approved, Denied) and automatic, read-only versions (ProposalVersion).
// Only some accounts run it; `proposal.js model <domain>` tells which. On an account whose
// proposal lives inside the deal this script stops and points back to proposal.js.
//
//   proposal-records.js deals    <domain> <part of the deal name>
//   proposal-records.js show     <domain> <dealId>             its proposals, status, versions, settings
//   proposal-records.js versions <domain> <proposalId>         the versions of one proposal, oldest first
//   proposal-records.js compare  <domain> <proposalId> <versionId>  what restoring would change
//   proposal-records.js preview  <domain> '<plan json>'        writes nothing; returns a version
//   proposal-records.js apply    <domain> '<plan json>' --version <v> --confirmed
//
// A plan has one "action": create | edit | status | restoreVersion (fields in SKILL.md).
// Approving or denying is never done here: denying any proposal denies the whole deal.
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const crypto = require('crypto');
const fs = require('fs');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');
const { detectModel } = require('./model');

const ID_RE = /^[a-f0-9]{24}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const BLOCKED = 3;
const ADVISOR_STATUSES = ['Draft', 'Ready'];
const ACTIONS = ['create', 'edit', 'status', 'restoreVersion'];
const ALLOWED = {
  create: ['dealId', 'title', 'layoutId', 'expirationDate', 'status'],
  edit: ['proposalId', 'title', 'layoutId', 'expirationDate'],
  status: ['proposalId', 'status'],
  restoreVersion: ['proposalId', 'versionId'],
};
const HINTS = {
  visibleToClient: ' Publishing a proposal to the client is done in the app.',
  approved: ' Approving or denying is done in the app: denying any proposal denies the whole deal.',
  denied: ' Approving or denying is done in the app: denying any proposal denies the whole deal.',
  quote: ' Quote lines belong to prolibu-quotes.',
  deal: ' A proposal never moves to another deal.',
};
const PROPOSAL_SELECT = 'proposalCode title status visibleToClient expirationDate unpublishedDate deal template.layout template.language quote.total quote.quoteCurrency quote.lineItems attachments updatedAt';
const RECORDS_ONLY = 'This account keeps the proposal inside the deal. Use scripts/proposal.js instead; nothing was read or written here.';

class Blocked extends Error {}

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
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const idOf = (ref) => (ref && typeof ref === 'object' ? ref._id : ref) || null;
const regex = (term) => `(?i)${String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
const versionOf = (plan, state) => crypto.createHash('sha256').update(JSON.stringify({ plan, state })).digest('hex').slice(0, 16);
const dateOnly = (d) => (d ? String(d).slice(0, 10) : null);

// ---------- reads ----------

async function loadSettings(client) {
  let deals = {};
  try {
    const prefs = await call(client, 'GET', '/v2/user/preferences');
    deals = (prefs && prefs.modules && prefs.modules.sales && prefs.modules.sales.deals) || {};
  } catch {
    // Without preferences the platform defaults apply.
  }
  const versioning = deals.proposalVersioning || {};
  const stageRules = deals.stageRules || {};
  return {
    autoVersions: versioning.autoGenerate === true,
    allowDeleteVersions: versioning.allowDeleteVersions === true,
    allowEditInEndFlowStages: stageRules.allowEditInEndFlowStages === true,
    defaultStatus: ADVISOR_STATUSES.includes(stageRules.defaultProposalStatus) ? stageRules.defaultProposalStatus : 'Draft',
  };
}

async function loadDeal(client, dealId) {
  const deal = await call(client, 'GET', `/v2/deal/${dealId}?${qs({ select: 'dealName contact stage proposals principalProposal updatedAt' })}`);
  const stageId = idOf(deal.stage);
  const stage = stageId ? await call(client, 'GET', `/v2/stage/${stageId}?${qs({ select: 'stageName endFlowStage' })}`) : null;
  return { deal, stage };
}

async function loadProposal(client, proposalId) {
  return call(client, 'GET', `/v2/proposal/${proposalId}?${qs({ select: PROPOSAL_SELECT })}`);
}

async function dealProposals(client, dealId) {
  return rowsOf(await call(client, 'GET', `/v2/proposal?${qs({
    xquery: JSON.stringify({ deal: dealId }), select: PROPOSAL_SELECT, limit: '50',
  })}`));
}

async function proposalVersions(client, proposalId) {
  return rowsOf(await call(client, 'GET', `/v2/proposalversion?${qs({
    xquery: JSON.stringify({ proposal: proposalId }),
    select: 'proposal proposalVersionCode sha256 createdAt creator proposalData.title proposalData.expirationDate proposalData.quote.total proposalData.quote.quoteCurrency',
    sort: 'createdAt',
    limit: '100',
  })}`));
}

async function loadLayout(client, layoutId) {
  try {
    const t = await call(client, 'GET', `/v2/contenttemplate/${layoutId}?${qs({ select: 'contentTemplateName templateType active' })}`);
    return { _id: t._id, name: t.contentTemplateName, type: t.templateType, active: t.active !== false };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

const previewUrl = (domain, dealId, contactId, proposalId) => `https://${domain}/ui/spa/view/deal/${dealId}/${contactId || 'none'}?proposal=${proposalId}&source=versionHistory`;

function proposalSummary(p, principalId) {
  const quote = p.quote || {};
  return {
    _id: p._id,
    code: p.proposalCode || null,
    title: p.title || null,
    status: p.status || null,
    principal: p.isPrincipal === true || (principalId != null && String(principalId) === String(p._id)),
    visibleToClient: Boolean(p.visibleToClient),
    layout: idOf(p.template && p.template.layout),
    expirationDate: dateOnly(p.expirationDate),
    quote: { lines: (quote.lineItems || []).length, total: quote.total === undefined ? null : quote.total, currency: quote.quoteCurrency || null },
    updatedAt: p.updatedAt || null,
  };
}

function versionSummary(v) {
  const data = v.proposalData || {};
  const quote = data.quote || {};
  return {
    _id: v._id,
    code: v.proposalVersionCode || null,
    createdAt: v.createdAt || null,
    creator: idOf(v.creator),
    title: data.title || null,
    expirationDate: dateOnly(data.expirationDate),
    total: quote.total === undefined ? null : quote.total,
    currency: quote.quoteCurrency || null,
  };
}

function closedDeal(stage, settings) {
  return Boolean(stage && stage.endFlowStage && !settings.allowEditInEndFlowStages);
}

// ---------- read commands ----------

async function cmdDeals(client, [name]) {
  if (!name || !String(name).trim()) throw new UsageError('Usage: proposal-records.js deals <domain> <part of the deal name>');
  const body = await call(client, 'GET', `/v2/deal?${qs({
    xquery: JSON.stringify({ dealName: { $regex: regex(name) } }),
    select: 'dealName contact proposals principalProposal updatedAt',
    sort: '-updatedAt',
    limit: '10',
  })}`);
  return {
    deals: rowsOf(body).map((d) => ({
      _id: d._id, dealName: d.dealName, hasContact: Boolean(d.contact), proposals: (d.proposals || []).length,
    })),
  };
}

async function cmdShow(client, [dealId]) {
  if (!ID_RE.test(String(dealId))) throw new UsageError('Usage: proposal-records.js show <domain> <dealId>');
  const { deal, stage } = await loadDeal(client, dealId);
  const settings = await loadSettings(client);
  const proposals = await dealProposals(client, dealId);
  const order = (deal.proposals || []).map(String);
  proposals.sort((a, b) => order.indexOf(String(a._id)) - order.indexOf(String(b._id)));
  const counts = {};
  if (proposals.length) {
    const versions = rowsOf(await call(client, 'GET', `/v2/proposalversion?${qs({
      xquery: JSON.stringify({ dealSource: dealId }), select: 'proposal', limit: '500',
    })}`));
    for (const v of versions) counts[idOf(v.proposal)] = (counts[idOf(v.proposal)] || 0) + 1;
  }
  const contactId = idOf(deal.contact);
  const notes = [];
  if (!settings.autoVersions) notes.push('Automatic versions are off in this account: edits leave no version, so there is nothing to go back to unless an admin turns them on.');
  if (closedDeal(stage, settings)) notes.push(`The deal is in "${stage.stageName}", an end-of-flow stage: its proposals cannot be changed.`);
  return {
    model: 'records',
    deal: {
      _id: deal._id, dealName: deal.dealName, hasContact: Boolean(contactId),
      stage: stage ? { stageName: stage.stageName, endFlowStage: Boolean(stage.endFlowStage) } : null,
    },
    proposals: proposals.map((p) => ({
      ...proposalSummary(p, deal.principalProposal),
      versions: counts[String(p._id)] || 0,
      previewUrl: previewUrl(client.domain, deal._id, contactId, p._id),
    })),
    settings,
    notes,
  };
}

async function cmdVersions(client, [proposalId]) {
  if (!ID_RE.test(String(proposalId))) throw new UsageError('Usage: proposal-records.js versions <domain> <proposalId>');
  const proposal = await loadProposal(client, proposalId);
  const settings = await loadSettings(client);
  const versions = (await proposalVersions(client, proposalId)).map(versionSummary);
  return {
    proposal: proposalSummary(proposal),
    versions,
    autoVersions: settings.autoVersions,
    note: versions.length
      ? 'Versions are read-only snapshots, oldest first. The proposal itself is the current one; restoring copies a version over it.'
      : (settings.autoVersions ? 'This proposal has no versions yet.' : 'This proposal has no versions: automatic versions are off in this account.'),
  };
}

// The content fields a restore replaces, in plain words.
function contentChanges(current, data) {
  const changes = [];
  const cq = current.quote || {};
  const vq = (data && data.quote) || {};
  const add = (field, from, to) => {
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) changes.push({ field, now: from ?? null, afterRestore: to ?? null });
  };
  add('title', current.title, data.title);
  add('expirationDate', dateOnly(current.expirationDate), dateOnly(data.expirationDate));
  add('unpublishedDate', dateOnly(current.unpublishedDate), dateOnly(data.unpublishedDate));
  add('layout', idOf(current.template && current.template.layout), idOf(data.template && data.template.layout));
  add('quote.lines', (cq.lineItems || []).length, (vq.lineItems || []).length);
  add('quote.total', cq.total, vq.total);
  add('quote.currency', cq.quoteCurrency, vq.quoteCurrency);
  add('attachments', (current.attachments || []).length, ((data && data.attachments) || []).length);
  return changes;
}

async function cmdCompare(client, [proposalId, versionId]) {
  if (!ID_RE.test(String(proposalId)) || !ID_RE.test(String(versionId))) {
    throw new UsageError('Usage: proposal-records.js compare <domain> <proposalId> <versionId>');
  }
  const proposal = await loadProposal(client, proposalId);
  const version = await call(client, 'GET', `/v2/proposalversion/${versionId}`);
  if (String(idOf(version.proposal)) !== String(proposalId)) {
    return { blockers: ['That version belongs to another proposal: only a version of the same proposal can be restored.'] };
  }
  const changes = contentChanges(proposal, version.proposalData || {});
  return {
    proposal: proposalSummary(proposal),
    version: versionSummary(version),
    changes,
    note: changes.length ? 'Restoring would make these changes; status, visibility and the deal stay as they are.' : 'The version has the same content as the proposal in these fields.',
  };
}

// ---------- plan ----------

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
  if (!plan || !ACTIONS.includes(plan.action)) throw new UsageError(`The plan needs "action": one of ${ACTIONS.join(', ')}.`);
  for (const key of Object.keys(plan)) {
    if (key !== 'action' && !ALLOWED[plan.action].includes(key)) {
      throw new UsageError(`"${key}" is not allowed in a ${plan.action} plan (allowed: ${ALLOWED[plan.action].join(', ')}).${HINTS[key] || ''}`);
    }
  }
  for (const key of ['dealId', 'proposalId', 'layoutId', 'versionId']) {
    if (plan[key] !== undefined && !ID_RE.test(String(plan[key]))) throw new UsageError(`"${key}" must be a 24-character id.`);
  }
  const need = { create: ['dealId', 'title'], edit: ['proposalId'], status: ['proposalId', 'status'], restoreVersion: ['proposalId', 'versionId'] }[plan.action];
  for (const key of need) if (plan[key] === undefined || plan[key] === '') throw new UsageError(`A ${plan.action} plan needs "${key}".`);
  if (plan.title !== undefined && (typeof plan.title !== 'string' || !plan.title.trim() || plan.title.length > 300)) {
    throw new UsageError('"title" must be text of 1 to 300 characters.');
  }
  if (plan.expirationDate !== undefined && (typeof plan.expirationDate !== 'string' || !DATE_RE.test(plan.expirationDate))) {
    throw new UsageError('"expirationDate" must be a date like 2026-12-31.');
  }
  if (plan.status !== undefined && !ADVISOR_STATUSES.includes(plan.status)) {
    throw new UsageError(`"status" is Draft or Ready. Approved and Denied follow the deal's stage and are never written here.${HINTS.approved}`);
  }
  if (plan.action === 'edit' && !['title', 'layoutId', 'expirationDate'].some((k) => plan[k] !== undefined)) {
    throw new UsageError('An edit plan needs at least one of title, layoutId, expirationDate.');
  }
  return plan;
}

async function checkLayout(client, layoutId, blockers) {
  const layout = await loadLayout(client, layoutId);
  if (!layout) blockers.push(`Template ${layoutId} does not exist or this key cannot read it.`);
  else if (layout.type !== 'layout') blockers.push(`"${layout.name}" is a ${layout.type || 'template'}, not a layout: a proposal only takes a layout.`);
  else if (!layout.active) blockers.push(`"${layout.name}" is inactive.`);
  return layout;
}

async function buildChange(client, plan) {
  const settings = await loadSettings(client);
  const blockers = [];
  const warnings = [];
  const summary = [];
  let proposal = null;
  let dealId = plan.dealId;
  if (plan.proposalId) {
    proposal = await loadProposal(client, plan.proposalId);
    dealId = idOf(proposal.deal);
  }
  const { deal, stage } = await loadDeal(client, dealId);
  if (closedDeal(stage, settings)) {
    blockers.push(`The deal is in "${stage.stageName}", an end-of-flow stage: the account rejects proposal changes there unless an admin allows edits in end-flow stages.`);
  }
  const state = { deal: deal.updatedAt, proposal: proposal ? proposal.updatedAt : null, proposals: (deal.proposals || []).length };
  let step;

  if (plan.action === 'create') {
    const data = { deal: plan.dealId, title: plan.title.trim() };
    if (plan.layoutId) {
      const layout = await checkLayout(client, plan.layoutId, blockers);
      data.template = { layout: plan.layoutId };
      if (layout) summary.push(`Template: ${layout.name}.`);
    }
    if (plan.expirationDate) data.expirationDate = plan.expirationDate;
    data.status = plan.status || settings.defaultStatus;
    const first = (deal.proposals || []).length === 0;
    summary.unshift(`New proposal "${data.title}" in "${deal.dealName}", status ${data.status}.`);
    summary.push(first
      ? 'It is the first proposal of the deal, so the platform makes it visible to the client and the principal one.'
      : 'It is born hidden from the client; the deal already has other proposals.');
    if (!plan.layoutId) warnings.push('No template given: the platform applies the user\'s default layout.');
    warnings.push('It is born without quote lines; add them with prolibu-quotes.');
    if (settings.autoVersions) summary.push('The account saves a first version of it automatically.');
    step = { method: 'POST', path: '/v2/proposal', data };
  }

  if (plan.action === 'edit') {
    const data = {};
    if (plan.title !== undefined && plan.title.trim() !== proposal.title) {
      data.title = plan.title.trim();
      summary.push(`Title: "${proposal.title}" → "${data.title}".`);
    }
    if (plan.expirationDate !== undefined && dateOnly(plan.expirationDate) !== dateOnly(proposal.expirationDate)) {
      data.expirationDate = plan.expirationDate;
      summary.push(`Expiry: ${dateOnly(proposal.expirationDate) || 'none'} → ${dateOnly(plan.expirationDate)}.`);
    }
    if (plan.layoutId !== undefined && plan.layoutId !== idOf(proposal.template && proposal.template.layout)) {
      const layout = await checkLayout(client, plan.layoutId, blockers);
      data.template = { layout: plan.layoutId };
      if (layout) summary.push(`Template → ${layout.name}.`);
    }
    if (!Object.keys(data).length) blockers.push('Nothing changes: the proposal already has these values.');
    if (proposal.visibleToClient) warnings.push('This proposal is visible to the client: the change shows in the client\'s link as soon as it is saved.');
    if (settings.autoVersions) summary.push('The account saves a version automatically after a content change.');
    else warnings.push('Automatic versions are off: the current content is not kept anywhere after this edit.');
    step = { method: 'PATCH', path: `/v2/proposal/${plan.proposalId}`, data };
  }

  if (plan.action === 'status') {
    if (!ADVISOR_STATUSES.includes(proposal.status)) {
      blockers.push(`The proposal is ${proposal.status}: Approved and Denied follow the deal's stage and only change when the deal moves.`);
    } else if (proposal.status === plan.status) {
      blockers.push(`The proposal is already ${plan.status}.`);
    }
    summary.push(`Status: ${proposal.status} → ${plan.status}. Nothing is sent to the client and the deal does not move.`);
    step = { method: 'PATCH', path: `/v2/proposal/${plan.proposalId}`, data: { status: plan.status } };
  }

  if (plan.action === 'restoreVersion') {
    let version = null;
    try {
      version = await call(client, 'GET', `/v2/proposalversion/${plan.versionId}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (!version) blockers.push('That version does not exist.');
    else if (String(idOf(version.proposal)) !== String(plan.proposalId)) blockers.push('That version belongs to another proposal: only a version of the same proposal can be restored.');
    else {
      const changes = contentChanges(proposal, version.proposalData || {});
      if (!changes.length) blockers.push('The version has the same content as the proposal: restoring changes nothing.');
      for (const c of changes) summary.push(`${c.field}: ${JSON.stringify(c.now)} → ${JSON.stringify(c.afterRestore)}.`);
      state.version = version.sha256 || null;
    }
    warnings.push('Restoring replaces the whole content (title, quote, template, attachments, dates) and saves no copy of the current one; the API has no way to save a version by hand.');
    if (!settings.autoVersions) warnings.push('Automatic versions are off: unless the current content equals a saved version, it is lost after the restore.');
    warnings.push('The quote is not recalculated, and an expired date comes back expired.');
    if (proposal.visibleToClient) warnings.push('This proposal is visible to the client: the restored content shows in the client\'s link at once.');
    step = { method: 'PATCH', path: `/v2/proposal/${plan.proposalId}`, data: { restorationPoint: plan.versionId } };
  }

  return { step, summary, warnings, blockers, state, deal, settings };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const change = await buildChange(client, plan);
  return {
    action: plan.action,
    summary: change.summary,
    warnings: change.warnings,
    blockers: change.blockers,
    version: versionOf(plan, change.state),
    nextStep: change.blockers.length
      ? 'Blocked: tell the user why in plain words; do not apply.'
      : 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version.',
  };
}

// ---------- apply ----------

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const change = await buildChange(client, plan);
  if (versionOf(plan, change.state) !== flags.version) throw new Blocked('The deal or the proposal changed since the preview. Preview again and show the user.');
  if (change.blockers.length) throw new Blocked(change.blockers.join(' '));

  const { step } = change;
  const body = await call(client, step.method, step.path, { data: step.data, confirmed: true });
  const proposalId = plan.proposalId || idOf(body);
  if (!proposalId) throw new Error('The server did not return the proposal id; check the deal in the app before retrying.');
  const saved = await loadProposal(client, proposalId);
  const problems = [];
  if (step.data.title !== undefined && saved.title !== step.data.title) problems.push('The title did not save as sent.');
  if (step.data.expirationDate !== undefined && dateOnly(saved.expirationDate) !== dateOnly(step.data.expirationDate)) problems.push('The expiry did not save.');
  if (step.data.template && idOf(saved.template && saved.template.layout) !== step.data.template.layout) problems.push('The template did not save.');
  if (step.data.status !== undefined && saved.status !== step.data.status) problems.push(`The status came back as ${saved.status}.`);
  if (plan.action === 'restoreVersion') {
    const version = await call(client, 'GET', `/v2/proposalversion/${plan.versionId}`);
    const left = contentChanges(saved, version.proposalData || {}).filter((c) => !c.field.startsWith('quote.total'));
    if (left.length) problems.push(`After the restore these fields still differ from the version: ${left.map((c) => c.field).join(', ')}.`);
  }
  const { deal } = await loadDeal(client, idOf(saved.deal));
  return {
    saved: problems.length === 0,
    action: plan.action,
    proposal: proposalSummary(saved, deal.principalProposal),
    previewUrl: previewUrl(client.domain, deal._id, idOf(deal.contact), saved._id),
    problems,
  };
}

// ---------- CLI ----------

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
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  model: (client) => detectModel(client),
  deals: cmdDeals,
  show: cmdShow,
  versions: cmdVersions,
  compare: cmdCompare,
  preview: cmdPreview,
  apply: cmdApply,
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
    if (!handler || !domain) throw new UsageError(`Usage: proposal-records.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    if (command === 'preview' || command === 'apply') readPlan(rest[0], rootDir);
    if (command !== 'model') {
      const { model } = await detectModel(client);
      if (model !== 'records') throw new Blocked(RECORDS_ONLY);
    }
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

module.exports = { main, readPlan, contentChanges };
