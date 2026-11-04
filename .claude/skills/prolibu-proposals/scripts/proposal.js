#!/usr/bin/env node
'use strict';

// Proposals, proposal versions, contract templates and contracts of a Prolibu deal, the way
// the app does them. Contracts are only ever prepared as Draft: this script never sends
// anything for signature.
//
//   proposal.js deals              <domain> <part of the deal name>
//   proposal.js show               <domain> <dealId>
//   proposal.js layouts            <domain> [term]
//   proposal.js contract-templates <domain> [term]
//   proposal.js contract           <domain> <contractId>
//   proposal.js preview            <domain> '<plan json>'          writes nothing; returns a version
//   proposal.js apply              <domain> '<plan json>' --version <v> --confirmed
//   proposal.js model              <domain>                         which proposal model the account runs
//
// This script is for accounts whose proposal lives inside the deal. On an account where proposals
// are their own records it stops (exit 3) and points to proposal-records.js.
//
// A plan has one "action": proposal | saveVersion | restoreVersion | contractTemplate |
// generateContract | updateContract (fields in SKILL.md).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const crypto = require('crypto');
const fs = require('fs');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');
const { detectModel } = require('./model');

const ID_RE = /^[a-f0-9]{24}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const BLOCKED = 3;
const ROLES = ['signer', 'reviewer'];
const ACTIONS = ['proposal', 'saveVersion', 'restoreVersion', 'contractTemplate', 'generateContract', 'updateContract'];
const ALLOWED = {
  proposal: ['dealId', 'enabled', 'title', 'layoutId', 'expirationDate'],
  saveVersion: ['dealId', 'name'],
  restoreVersion: ['dealId', 'versionId', 'backup'],
  contractTemplate: ['name', 'html', 'language'],
  generateContract: ['dealId', 'templateId', 'signers', 'attachProposal', 'pages', 'name', 'options'],
  updateContract: ['contractId', 'name', 'signers', 'options'],
};
const OPTION_KEYS = ['sendEmailsInOrder', 'emailCode', 'deadlineDate', 'allowReject', 'skipLocation'];
const GENERATE_TIMEOUT_MS = 180000;
const NEVER_SENT = 'Nothing was sent to anyone: the contract stays in Draft until someone sends it from the app.';

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
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// ---------- template variables ----------

// [[name]] fields, {{ }} logic, and signature boxes of a contract template body.
function templateVariables(html) {
  const text = String(html || '');
  const square = [...new Set([...text.matchAll(/\[\[\s*([^[\]]+?)\s*\]\]/g)].map((m) => m[1]))];
  const reserved = square.filter((name) => /^firma\.\d+\./i.test(name));
  const logic = [...new Set([...text.matchAll(/\{\{\{?([^{}]+?)\}?\}\}/g)].map((m) => m[1].trim()))];
  return {
    fields: square.filter((name) => !reserved.includes(name)),
    reserved,
    logic,
    // An editor link inside {{ }} (autolink) breaks Handlebars: the whole block stays raw.
    brokenLogic: logic.filter((expr) => /<[a-z/]/i.test(expr)),
    signatureBoxes: (text.match(/⟦sig:\d+⟧/g) || []).length,
  };
}

// Same lookup order as the platform: exact key, then case-insensitive, then a dotted path.
function lookupField(fields, name) {
  if (!fields || typeof fields !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const lower = name.toLowerCase();
  const key = Object.keys(fields).find((k) => k.toLowerCase() === lower);
  if (key !== undefined) return fields[key];
  if (!name.includes('.')) return undefined;
  return name.split('.').reduce((obj, part) => (obj && typeof obj === 'object' ? obj[part] : undefined), fields);
}

// Which [[fields]] the saved contract filled, left empty, or did not know at all.
function variablesReport(templateHtml, contractFields, compiledHtml) {
  const vars = templateVariables(templateHtml);
  const report = { filled: [], empty: [], unknown: [] };
  for (const name of vars.fields) {
    const value = lookupField(contractFields, name);
    if (value === undefined) report.unknown.push(name);
    else if (isEmpty(value)) report.empty.push(name);
    else report.filled.push(name);
  }
  report.logicNotCompiled = typeof compiledHtml === 'string' && /\{\{[^{}]+\}\}/.test(compiledHtml);
  return report;
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
  if (!plan || !ACTIONS.includes(plan.action)) {
    throw new UsageError(`The plan needs "action": one of ${ACTIONS.join(', ')}.`);
  }
  for (const key of Object.keys(plan)) {
    if (key !== 'action' && !ALLOWED[plan.action].includes(key)) {
      const hint = key === 'status' ? ' This script never changes a contract status: sending happens in the app.' : '';
      throw new UsageError(`"${key}" is not allowed in a ${plan.action} plan (allowed: ${ALLOWED[plan.action].join(', ')}).${hint}`);
    }
  }
  for (const key of ['dealId', 'versionId', 'templateId', 'contractId']) {
    if (plan[key] !== undefined && !ID_RE.test(String(plan[key]))) throw new UsageError(`"${key}" must be a 24-character id.`);
  }
  const need = { proposal: 'dealId', saveVersion: 'dealId', restoreVersion: 'dealId', generateContract: 'dealId', updateContract: 'contractId' }[plan.action];
  if (need && !plan[need]) throw new UsageError(`A ${plan.action} plan needs "${need}".`);
  validateAction(plan);
  return plan;
}

function validateSigners(signers) {
  if (signers === undefined) return;
  if (!Array.isArray(signers) || !signers.length) throw new UsageError('"signers" must be a non-empty list of {contactId, role}.');
  const seen = new Set();
  for (const s of signers) {
    if (!s || !ID_RE.test(String(s.contactId))) throw new UsageError('Each signer needs "contactId" (24 characters).');
    if (s.role !== undefined && !ROLES.includes(s.role)) throw new UsageError(`A signer's role is "signer" or "reviewer", not "${s.role}".`);
    if (seen.has(s.contactId)) throw new UsageError(`Contact ${s.contactId} is listed twice.`);
    seen.add(s.contactId);
  }
  if (!signers.some((s) => (s.role || 'signer') === 'signer')) throw new UsageError('At least one participant must have the role "signer".');
}

function validateOptions(options) {
  if (options === undefined) return;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new UsageError('"options" must be an object.');
  for (const [key, value] of Object.entries(options)) {
    if (!OPTION_KEYS.includes(key)) throw new UsageError(`Unknown option "${key}" (allowed: ${OPTION_KEYS.join(', ')}).`);
    if (key === 'deadlineDate') {
      if (value !== null && !(DATE_RE.test(String(value)) && !Number.isNaN(Date.parse(value)))) throw new UsageError('"deadlineDate" must be YYYY-MM-DD.');
    } else if (typeof value !== 'boolean') {
      throw new UsageError(`"${key}" must be true or false.`);
    }
  }
}

function validateAction(plan) {
  if (plan.action === 'proposal') {
    if (!['enabled', 'title', 'layoutId', 'expirationDate'].some((k) => plan[k] !== undefined)) {
      throw new UsageError('The plan changes nothing: add enabled, title, layoutId or expirationDate.');
    }
    if (plan.enabled !== undefined && typeof plan.enabled !== 'boolean') throw new UsageError('"enabled" must be true or false.');
    if (plan.enabled === false && Object.keys(plan).some((k) => ['title', 'layoutId', 'expirationDate'].includes(k))) {
      throw new UsageError('Turning the proposal off takes no other change.');
    }
    if (plan.title !== undefined && !String(plan.title).trim()) throw new UsageError('"title" cannot be empty.');
    if (plan.layoutId !== undefined && !ID_RE.test(String(plan.layoutId))) {
      throw new UsageError('"layoutId" must be a layout template id. To go back to the default layout, pass its id (see layouts).');
    }
    if (plan.expirationDate !== undefined && !(DATE_RE.test(String(plan.expirationDate)) && !Number.isNaN(Date.parse(plan.expirationDate)))) {
      throw new UsageError('"expirationDate" must be YYYY-MM-DD.');
    }
  }
  if (plan.action === 'saveVersion' && !String(plan.name || '').trim()) throw new UsageError('A version needs a "name".');
  if (plan.action === 'restoreVersion') {
    if (!plan.versionId) throw new UsageError('A restoreVersion plan needs "versionId".');
    if (plan.backup !== undefined && typeof plan.backup !== 'boolean') throw new UsageError('"backup" must be true or false.');
  }
  if (plan.action === 'contractTemplate') {
    if (!String(plan.name || '').trim()) throw new UsageError('A contract template needs a "name".');
    if (!String(plan.html || '').trim()) throw new UsageError('A contract template needs "html" (its body).');
  }
  if (plan.action === 'generateContract') {
    validateSigners(plan.signers);
    validateOptions(plan.options);
    if (plan.attachProposal !== undefined && typeof plan.attachProposal !== 'boolean') throw new UsageError('"attachProposal" must be true or false.');
    if (plan.attachProposal === false && !plan.templateId) throw new UsageError('Without the proposal attached, a contract template is required: the contract would have no document.');
    if (plan.pages !== undefined && (!Array.isArray(plan.pages) || plan.pages.some((p) => !Number.isInteger(p) || p < 0))) {
      throw new UsageError('"pages" must be a list of proposal page numbers counted from 0.');
    }
    if (plan.name !== undefined && !String(plan.name).trim()) throw new UsageError('"name" cannot be empty.');
  }
  if (plan.action === 'updateContract') {
    validateSigners(plan.signers);
    validateOptions(plan.options);
    if (plan.name !== undefined && !String(plan.name).trim()) throw new UsageError('"name" cannot be empty.');
    if (plan.name === undefined && plan.signers === undefined && plan.options === undefined) {
      throw new UsageError('The plan changes nothing: add name, signers or options.');
    }
  }
}

// Friendly options → the platform's nested shape (PATCH merges these keys one by one).
function platformOptions(options) {
  if (!options) return undefined;
  const out = {};
  if (options.sendEmailsInOrder !== undefined) out.sendEmailsInOrder = options.sendEmailsInOrder;
  if (options.emailCode !== undefined) out.verification = { emailCode: options.emailCode };
  if (options.deadlineDate !== undefined) out.deadlineDate = options.deadlineDate === null ? null : new Date(options.deadlineDate).toISOString();
  if (options.allowReject !== undefined) out.reject = { allow: options.allowReject };
  if (options.skipLocation !== undefined) out.skipLocation = options.skipLocation;
  return out;
}

// signers in order + a complete role map (signerEvidences is replaced whole on save).
function signerBody(signers) {
  return {
    signers: signers.map((s) => s.contactId),
    signerEvidences: Object.fromEntries(signers.map((s) => [s.contactId, { role: s.role || 'signer' }])),
  };
}

const versionOf = (plan, state) => crypto.createHash('sha256').update(JSON.stringify({ plan, state })).digest('hex').slice(0, 16);

// ---------- reads ----------

const DEAL_FIELDS = 'dealName stage contact proposal proposalVersions contracts updatedAt';

async function loadDeal(client, dealId) {
  const deal = await call(client, 'GET', `/v2/deal/${dealId}?${qs({ select: DEAL_FIELDS })}`);
  const stageId = idOf(deal.stage);
  const stage = stageId ? await call(client, 'GET', `/v2/stage/${stageId}?${qs({ select: 'stageName endFlowStage' })}`) : null;
  return { deal, stage };
}

async function loadPrefs(client) {
  try {
    const prefs = await call(client, 'GET', '/v2/user/preferences');
    return (prefs && prefs.modules && prefs.modules.sales && prefs.modules.sales.deals) || {};
  } catch {
    return {};
  }
}

async function loadContact(client, id) {
  try {
    return await call(client, 'GET', `/v2/contact/${id}?${qs({ select: 'firstName lastName email' })}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function dealContracts(client, dealId) {
  const body = await call(client, 'GET', `/v2/contract?${qs({
    xquery: JSON.stringify({ 'origin.docId': dealId }),
    select: 'contractName status signers skipDealApproval updatedAt',
    sort: '-createdAt',
    limit: '50',
  })}`);
  return rowsOf(body);
}

const contactName = (c) => (c ? [c.firstName, c.lastName].filter(Boolean).join(' ') : null);
const previewUrl = (domain, dealId) => `https://${domain}/ui/spa/view/deal/${dealId}/none`;

function versionList(deal) {
  const restoration = idOf(deal.proposalVersions && deal.proposalVersions.restorationPoint);
  return ((deal.proposalVersions && deal.proposalVersions.details) || []).map((d) => ({
    id: d.id || null,
    name: d.versionName,
    current: d.id == null || d.latestVersion === true,
    visibleToClient: Boolean(d.visibleToClient),
    automatic: Boolean(d.isAutoGenerated),
    createdAt: d.createdAt || null,
    creator: d.creator || null,
    lastRestored: Boolean(d.id && restoration && d.id === restoration),
  }));
}

function dealBlockers({ stage }, prefs) {
  const found = [];
  const allowEdit = prefs.stageRules && prefs.stageRules.allowEditInEndFlowStages;
  if (stage && stage.endFlowStage && !allowEdit) {
    found.push(`The deal is in "${stage.stageName}", an end-of-flow stage: the account rejects proposal changes there unless an admin allows edits in end-flow stages.`);
  }
  return found;
}

async function cmdDeals(client, [name]) {
  if (!name || !String(name).trim()) throw new UsageError('Usage: proposal.js deals <domain> <part of the deal name>');
  const body = await call(client, 'GET', `/v2/deal?${qs({
    xquery: JSON.stringify({ dealName: { $regex: regex(name) } }),
    select: 'dealName contact proposal.enabled proposal.title updatedAt',
    sort: '-updatedAt',
    limit: '10',
  })}`);
  return {
    deals: rowsOf(body).map((d) => ({
      _id: d._id, dealName: d.dealName, hasContact: Boolean(d.contact),
      proposalEnabled: Boolean(d.proposal && d.proposal.enabled), proposalTitle: (d.proposal && d.proposal.title) || null,
    })),
  };
}

async function cmdShow(client, [dealId]) {
  if (!ID_RE.test(String(dealId))) throw new UsageError('Usage: proposal.js show <domain> <dealId>');
  const loaded = await loadDeal(client, dealId);
  const { deal, stage } = loaded;
  const prefs = await loadPrefs(client);
  const proposal = deal.proposal || {};
  const template = proposal.template || {};
  const contactId = idOf(deal.contact);
  const contact = contactId ? await loadContact(client, contactId) : null;
  let layout = null;
  if (idOf(template.layout)) {
    try {
      const t = await call(client, 'GET', `/v2/contenttemplate/${idOf(template.layout)}?${qs({ select: 'contentTemplateName templateType' })}`);
      layout = { _id: t._id, name: t.contentTemplateName };
    } catch {
      layout = { _id: idOf(template.layout), name: null };
    }
  }
  const contracts = await dealContracts(client, dealId);
  const quote = proposal.quote || null;
  return {
    deal: {
      _id: deal._id, dealName: deal.dealName,
      contact: contact ? { _id: contact._id, name: contactName(contact), email: contact.email || null } : null,
      stage: stage ? { stageName: stage.stageName, endFlowStage: Boolean(stage.endFlowStage) } : null,
    },
    proposal: {
      enabled: Boolean(proposal.enabled),
      title: proposal.title || null,
      layout,
      language: template.language || null,
      expirationDate: proposal.expirationDate || null,
      quote: quote ? { lines: (quote.lineItems || []).length, total: quote.total === undefined ? null : quote.total, currency: quote.quoteCurrency || null } : null,
    },
    versions: versionList(deal),
    contracts: contracts.map((c) => ({ _id: c._id, contractName: c.contractName, status: c.status, signers: (c.signers || []).length })),
    previewUrl: proposal.enabled ? previewUrl(client.domain, deal._id) : null,
    blockers: dealBlockers(loaded, prefs),
    version: deal.updatedAt,
  };
}

async function cmdLayouts(client, [term]) {
  const xquery = { templateType: 'layout', active: { $ne: false } };
  if (term && String(term).trim()) xquery.contentTemplateName = { $regex: regex(term) };
  const body = await call(client, 'GET', `/v2/contenttemplate?${qs({
    xquery: JSON.stringify(xquery), select: 'contentTemplateName taxonomy.language updatedAt', sort: '-updatedAt', limit: '50',
  })}`);
  let defaultLayout = null;
  try {
    const d = await call(client, 'GET', '/v2/contenttemplate/defaultLayout');
    if (d && d.contentTemplate) defaultLayout = { _id: d.contentTemplate._id, name: d.contentTemplate.contentTemplateName, origin: d.defaultLayoutType || null };
  } catch {
    defaultLayout = null;
  }
  return {
    defaultLayout,
    total: body && body.pagination ? body.pagination.count : undefined,
    layouts: rowsOf(body).map((t) => ({ _id: t._id, name: t.contentTemplateName, language: (t.taxonomy && t.taxonomy.language) || null })),
  };
}

async function cmdContractTemplates(client, [term]) {
  const xquery = { isContractTemplate: true };
  if (term && String(term).trim()) xquery.contractName = { $regex: regex(term) };
  const body = await call(client, 'GET', `/v2/contract?${qs({
    xquery: JSON.stringify(xquery), select: 'contractName language contractEditor contractDocuments updatedAt', sort: '-createdAt', limit: '25',
  })}`);
  return {
    total: body && body.pagination ? body.pagination.count : undefined,
    templates: rowsOf(body).map((t) => {
      const vars = templateVariables(t.contractEditor);
      return {
        _id: t._id, name: t.contractName, language: t.language || null,
        hasBody: Boolean(t.contractEditor), fixedDocuments: (t.contractDocuments || []).length,
        fields: vars.fields, logic: vars.logic.length, brokenLogic: vars.brokenLogic, signatureBoxes: vars.signatureBoxes,
      };
    }),
  };
}

async function cmdContract(client, [contractId]) {
  if (!ID_RE.test(String(contractId))) throw new UsageError('Usage: proposal.js contract <domain> <contractId>');
  const c = await call(client, 'GET', `/v2/contract/${contractId}`);
  const evidences = c.signerEvidences || {};
  const emptyFields = Object.entries(c.contractFields || {})
    .filter(([, v]) => v === null || typeof v !== 'object')
    .filter(([, v]) => isEmpty(v)).map(([k]) => k);
  return {
    contract: {
      _id: c._id, contractName: c.contractName, status: c.status, isTemplate: Boolean(c.isContractTemplate),
      deal: c.origin && c.origin.modelName === 'Deal' ? idOf(c.origin.docId) : null,
      documents: (c.contractDocuments || []).length,
      signers: (c.signers || []).map((id) => {
        const e = evidences[idOf(id)] || {};
        return { contactId: idOf(id), name: e.fullName || null, email: e.email || null, role: e.role || 'signer', status: e.status || null };
      }),
      options: c.options || {},
      emptyFields,
      logicNotCompiled: typeof c.contractEditor === 'string' && /\{\{[^{}]+\}\}/.test(c.contractEditor) && !c.isContractTemplate,
    },
    editable: c.status === 'Draft' && !c.isContractTemplate,
    version: c.updatedAt,
  };
}

// ---------- write plans ----------

async function signerContacts(client, signers, warnings, blockers) {
  const out = [];
  for (const s of signers) {
    const contact = await loadContact(client, s.contactId);
    if (!contact) blockers.push(`Contact ${s.contactId} does not exist.`);
    else if (!contact.email) blockers.push(`${contactName(contact) || s.contactId} has no e-mail; every participant needs one to sign.`);
    out.push({ contactId: s.contactId, role: s.role || 'signer', name: contactName(contact), email: contact ? contact.email || null : null });
  }
  if (signers.length > 1) warnings.push('Participants are asked in the listed order when "sendEmailsInOrder" is on; otherwise all at once.');
  return out;
}

async function buildChange(client, plan) {
  const warnings = [];
  const blockers = [];
  const steps = [];
  let summary = {};
  let state = null;

  if (['proposal', 'saveVersion', 'restoreVersion', 'generateContract'].includes(plan.action)) {
    const loaded = await loadDeal(client, plan.dealId);
    const prefs = await loadPrefs(client);
    const { deal } = loaded;
    const proposal = deal.proposal || {};
    state = deal.updatedAt;
    if (plan.action !== 'generateContract') blockers.push(...dealBlockers(loaded, prefs));

    if (plan.action === 'proposal') {
      const body = {};
      const changes = [];
      if (plan.enabled === true && !proposal.enabled) {
        body.enabled = true;
        changes.push('turn the proposal on');
        if (!deal.contact) blockers.push('The deal has no contact; a proposal needs one. Add a contact to the deal first.');
        const title = plan.title !== undefined ? String(plan.title).trim() : (proposal.title || deal.dealName);
        if (title !== proposal.title) body.title = title;
        const defaultStage = prefs.stageRules && prefs.stageRules.defaultProposalStage;
        if (defaultStage && idOf(defaultStage) !== idOf(deal.stage)) {
          warnings.push('Turning the proposal on moves the deal to the account\'s default proposal stage.');
        }
        if (plan.layoutId === undefined && !idOf(proposal.template && proposal.template.layout)) {
          warnings.push('No template chosen: the platform applies the default layout (see layouts).');
        }
      } else if (plan.enabled === false && proposal.enabled) {
        body.enabled = false;
        changes.push('turn the proposal off');
        warnings.push('The client\'s proposal link stops showing the proposal. The quote, versions and contracts are kept.');
      } else if (plan.enabled !== undefined) {
        warnings.push(`The proposal is already ${proposal.enabled ? 'on' : 'off'}.`);
      }
      if (plan.enabled !== false) {
        if (!proposal.enabled && plan.enabled !== true) {
          blockers.push('The proposal is off. Turn it on in the same plan ("enabled": true) before changing it.');
        }
        if (plan.title !== undefined && String(plan.title).trim() !== proposal.title) {
          body.title = String(plan.title).trim();
        }
        if (body.title !== undefined) {
          changes.push(`title "${body.title}"`);
          if (/\{\{/.test(body.title)) warnings.push('The title has {{ }}: the platform fills it in once and saves the result; the placeholders are not kept.');
        }
        if (plan.layoutId !== undefined && plan.layoutId !== idOf(proposal.template && proposal.template.layout)) {
          let layout = null;
          try {
            layout = await call(client, 'GET', `/v2/contenttemplate/${plan.layoutId}?${qs({ select: 'contentTemplateName templateType active taxonomy.language' })}`);
          } catch (err) {
            if (err.status !== 404) throw err;
          }
          if (!layout) blockers.push(`Template ${plan.layoutId} does not exist.`);
          else if (layout.templateType !== 'layout') blockers.push(`"${layout.contentTemplateName}" is a ${layout.templateType} template, not a layout. Pick one from layouts.`);
          else if (layout.active === false) blockers.push(`"${layout.contentTemplateName}" is inactive.`);
          else {
            body.template = { layout: plan.layoutId };
            const language = layout.taxonomy && layout.taxonomy.language;
            if (language) body.template.language = language;
            changes.push(`template "${layout.contentTemplateName}"${language ? ` (${language})` : ''}`);
          }
        }
        if (plan.expirationDate !== undefined) {
          body.expirationDate = new Date(plan.expirationDate).toISOString();
          changes.push(`expires ${plan.expirationDate}`);
        }
      }
      if (proposal.enabled && Object.keys(body).length) {
        warnings.push('The account may also save an automatic hidden version of the proposal with this change.');
      }
      if (!Object.keys(body).length && !blockers.length) blockers.push('Nothing to change: the proposal already looks like that.');
      steps.push({ method: 'PATCH', path: `/v2/deal/${deal._id}`, data: { proposal: body } });
      summary = { deal: deal.dealName, changes };
    }

    if (plan.action === 'saveVersion') {
      if (!proposal.enabled) blockers.push('The proposal is off: only an active proposal can be versioned.');
      const name = String(plan.name).trim();
      if (versionList(deal).some((v) => v.name === name)) warnings.push(`A version named "${name}" already exists; the new one gets the same name.`);
      steps.push({
        method: 'POST', path: '/v2/proposalversion/createRestorationPoint',
        data: { dealSource: deal._id, proposalData: proposal, versionName: name, visibleToClient: false },
      });
      summary = { deal: deal.dealName, saves: `a hidden version "${name}" of the proposal as it is now (title "${proposal.title || ''}")` };
      if (proposal.quote) warnings.push('The platform recalculates the quote inside the version with today\'s prices and rules.');
    }

    if (plan.action === 'restoreVersion') {
      const version = versionList(deal).find((v) => v.id === plan.versionId);
      if (!version) blockers.push('That version does not belong to this deal. Run show and pick one from versions.');
      if (!proposal.enabled) blockers.push('The proposal is off. Turn it on first.');
      let snapshot = null;
      if (version) {
        snapshot = await call(client, 'GET', `/v2/proposalversion/${plan.versionId}?${qs({ select: 'proposalData dealSource' })}`);
        if (idOf(snapshot.dealSource) !== deal._id) blockers.push('That version belongs to another deal.');
      }
      const backup = plan.backup !== false;
      if (backup) {
        steps.push({
          method: 'POST', path: '/v2/proposalversion/createRestorationPoint',
          data: { dealSource: deal._id, proposalData: proposal, versionName: `Before restoring "${version ? version.name : plan.versionId}"`, visibleToClient: false },
        });
      } else {
        warnings.push('Without a backup, the current proposal is lost unless the account saved an automatic version of it.');
      }
      steps.push({ method: 'PATCH', path: `/v2/deal/${deal._id}`, data: { proposalVersions: { restorationPoint: plan.versionId } } });
      const data = (snapshot && snapshot.proposalData) || {};
      summary = {
        deal: deal.dealName,
        replaces: { title: proposal.title || null, quoteTotal: proposal.quote ? proposal.quote.total : null },
        with: { version: version ? version.name : plan.versionId, title: data.title || null, quoteTotal: data.quote ? data.quote.total : null },
        backup,
      };
      warnings.push('Restoring replaces the whole proposal (title, template, quote) with the version.');
    }

    if (plan.action === 'generateContract') {
      if (!proposal.enabled) blockers.push('The proposal is off: a contract is generated from an active proposal.');
      if (!deal.contact) blockers.push('The deal has no contact.');
      const existing = (await dealContracts(client, deal._id)).filter((c) => c.status !== 'Rejected' && c.skipDealApproval !== true);
      if (existing.length) {
        blockers.push(`The deal already has the contract "${existing[0].contractName}" (${existing[0].status}). The platform keeps one active contract per deal and would return that one instead of creating a new one.`);
      }
      let template = null;
      if (plan.templateId) {
        try {
          template = await call(client, 'GET', `/v2/contract/${plan.templateId}?${qs({ select: 'contractName isContractTemplate contractEditor' })}`);
        } catch (err) {
          if (err.status !== 404) throw err;
        }
        if (!template || !template.isContractTemplate) blockers.push('That id is not a contract template. Pick one from contract-templates.');
      }
      const signersIn = plan.signers || (deal.contact ? [{ contactId: idOf(deal.contact), role: 'signer' }] : []);
      const participants = await signerContacts(client, signersIn, warnings, blockers);
      const vars = templateVariables(template && template.contractEditor);
      if (template && !template.contractEditor) warnings.push('The template has no body text; only its fixed documents are used.');
      if (vars.brokenLogic.length) warnings.push(`These {{ }} blocks contain a link and will not compile (they show as raw text): ${vars.brokenLogic.join(' | ')}`);
      if (template && !vars.signatureBoxes) warnings.push('The template has no signature box (⟦sig:1⟧); place the signature in the app before sending.');
      const attachProposal = plan.attachProposal !== false;
      const initiator = signersIn.find((s) => s.contactId === idOf(deal.contact)) || signersIn[0];
      steps.push({
        method: 'POST', path: '/v2/contract/generateFromDeal',
        data: {
          dealId: deal._id,
          contactId: initiator ? initiator.contactId : undefined,
          signerContactIds: signersIn.map((s) => s.contactId),
          ...(plan.templateId ? { contractTemplateId: plan.templateId } : {}),
          attachProposal,
          ...(plan.pages ? { pages: plan.pages } : {}),
          status: 'Draft',
        },
      });
      const follow = {};
      if (plan.name) follow.contractName = String(plan.name).trim();
      if (signersIn.some((s) => (s.role || 'signer') !== 'signer')) Object.assign(follow, signerBody(signersIn));
      if (plan.options) follow.options = platformOptions(plan.options);
      if (Object.keys(follow).length) steps.push({ method: 'PATCH', path: '/v2/contract/:new', data: follow, onlyIfDraft: true });
      summary = {
        deal: deal.dealName,
        contractName: plan.name || `${proposal.title || deal.dealName} - Contract`,
        template: template ? template.contractName : null,
        document: [template ? 'the template text' : null, attachProposal ? `the proposal (${plan.pages ? `page${plan.pages.length > 1 ? 's' : ''} ${plan.pages.map((p) => p + 1).join(', ')}` : 'all pages'})` : null].filter(Boolean).join(' + '),
        participants,
        options: plan.options || {},
        status: 'Draft (nothing is sent)',
        templateFields: vars.fields,
        templateLogic: vars.logic,
      };
      warnings.push('The contract text is filled in with the deal\'s data now and saved filled in: later changes to the deal do not update it.');
    }
  }

  if (plan.action === 'contractTemplate') {
    const vars = templateVariables(plan.html);
    if (vars.brokenLogic.length) blockers.push(`These {{ }} blocks contain HTML tags and would not compile: ${vars.brokenLogic.join(' | ')}`);
    if (!vars.fields.length && !vars.logic.length) warnings.push('The body has no variables: every contract made from it will have the same text.');
    if (!vars.signatureBoxes) warnings.push('No signature box (⟦sig:1⟧ for the first participant, ⟦sig:2⟧ for the second…): signatures must then be placed by hand in the app.');
    steps.push({
      method: 'POST', path: '/v2/contract',
      data: {
        contractName: String(plan.name).trim(), contractEditor: plan.html, isContractTemplate: true, status: 'Draft', signers: [],
        ...(plan.language ? { language: plan.language } : {}),
      },
    });
    summary = { createsTemplate: String(plan.name).trim(), fields: vars.fields, logic: vars.logic, signatureBoxes: vars.signatureBoxes };
  }

  if (plan.action === 'updateContract') {
    const c = await call(client, 'GET', `/v2/contract/${plan.contractId}`);
    state = c.updatedAt;
    if (c.isContractTemplate) blockers.push('That is a contract template, not a contract. Edit templates in the app.');
    else if (c.status !== 'Draft') {
      blockers.push(c.status === 'Ready'
        ? 'The contract is Ready: every save of a Ready contract sends the signature request again. Change it in the app.'
        : `The contract is ${c.status}: it is already in the signing flow and cannot be prepared again.`);
    }
    const follow = {};
    let participants;
    if (plan.name !== undefined) follow.contractName = String(plan.name).trim();
    if (plan.signers) {
      participants = await signerContacts(client, plan.signers, warnings, blockers);
      Object.assign(follow, signerBody(plan.signers));
      warnings.push('Signature positions already placed for removed participants are not moved; check them in the app.');
    }
    if (plan.options) follow.options = platformOptions(plan.options);
    steps.push({ method: 'PATCH', path: `/v2/contract/${c._id}`, data: follow });
    summary = { contract: c.contractName, status: c.status, name: follow.contractName, participants, options: plan.options };
  }

  return { steps, summary, warnings, blockers, state };
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

async function applyProposal(client, plan, step) {
  await call(client, step.method, step.path, { data: step.data, confirmed: true });
  const { deal } = await loadDeal(client, plan.dealId);
  const sent = step.data.proposal;
  const p = deal.proposal || {};
  const problems = [];
  if (sent.enabled !== undefined && Boolean(p.enabled) !== sent.enabled) problems.push('The proposal on/off state did not save.');
  if (sent.template && idOf(p.template && p.template.layout) !== sent.template.layout) problems.push('The template did not save.');
  if (sent.title !== undefined && !/\{\{/.test(sent.title) && p.title !== sent.title) problems.push('The title did not save as sent.');
  return {
    saved: problems.length === 0,
    proposal: { enabled: Boolean(p.enabled), title: p.title || null, layout: idOf(p.template && p.template.layout), expirationDate: p.expirationDate || null },
    previewUrl: p.enabled ? previewUrl(client.domain, deal._id) : null,
    problems,
    version: deal.updatedAt,
  };
}

async function createVersion(client, step) {
  const before = await call(client, 'GET', `/v2/deal/${step.data.dealSource}?${qs({ select: 'proposalVersions' })}`);
  const known = new Set(((before.proposalVersions && before.proposalVersions.refs) || []).map(idOf));
  const body = await call(client, step.method, step.path, { data: step.data, confirmed: true });
  const created = ((body && body.details) || []).find((d) => d.id && !known.has(d.id) && d.versionName === step.data.versionName);
  return created || null;
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const change = await buildChange(client, plan);
  if (versionOf(plan, change.state) !== flags.version) throw new Blocked('The record or the plan changed since the preview. Preview again and show the user.');
  if (change.blockers.length) throw new Blocked(change.blockers.join(' '));

  if (plan.action === 'proposal') return applyProposal(client, plan, change.steps[0]);

  if (plan.action === 'saveVersion') {
    const created = await createVersion(client, change.steps[0]);
    const { deal } = await loadDeal(client, plan.dealId);
    const listed = created && versionList(deal).find((v) => v.id === created.id);
    return {
      saved: Boolean(listed),
      versionId: created ? created.id : null,
      name: plan.name,
      visibleToClient: false,
      problems: listed ? [] : ['The version was not found in the deal\'s list after saving.'],
      version: deal.updatedAt,
    };
  }

  if (plan.action === 'restoreVersion') {
    let backupId = null;
    const steps = [...change.steps];
    if (steps.length === 2) {
      const backup = await createVersion(client, steps.shift());
      if (!backup) throw new Error('The backup version was not created; nothing was restored.');
      backupId = backup.id;
    }
    await call(client, steps[0].method, steps[0].path, { data: steps[0].data, confirmed: true });
    const { deal } = await loadDeal(client, plan.dealId);
    const snapshot = await call(client, 'GET', `/v2/proposalversion/${plan.versionId}?${qs({ select: 'proposalData' })}`);
    const want = snapshot.proposalData || {};
    const got = deal.proposal || {};
    const problems = [];
    if (got.title !== want.title) problems.push('The title is not the version\'s title.');
    if (idOf(got.template && got.template.layout) !== idOf(want.template && want.template.layout)) problems.push('The template is not the version\'s template.');
    return {
      saved: problems.length === 0,
      restored: plan.versionId,
      backupVersionId: backupId,
      proposal: { title: got.title || null, layout: idOf(got.template && got.template.layout), quoteTotal: got.quote ? got.quote.total : null },
      problems,
      version: deal.updatedAt,
    };
  }

  if (plan.action === 'contractTemplate') {
    const created = await call(client, 'POST', '/v2/contract', { data: change.steps[0].data, confirmed: true });
    const t = await call(client, 'GET', `/v2/contract/${created._id}?${qs({ select: 'contractName isContractTemplate status contractEditor updatedAt' })}`);
    const problems = [];
    if (!t.isContractTemplate) problems.push('The record was not saved as a template.');
    if (t.contractEditor !== plan.html) problems.push('The body did not save exactly as sent.');
    return { saved: problems.length === 0, templateId: t._id, name: t.contractName, problems, version: t.updatedAt };
  }

  if (plan.action === 'generateContract') {
    const [generate, follow] = change.steps;
    const startedAt = Date.now();
    let made;
    try {
      made = await call(client, generate.method, generate.path, { data: generate.data, confirmed: true });
    } catch (err) {
      // The server prints the documents before it saves: a slow print can outlast the request
      // while the contract still gets created. Look before reporting a failure.
      if (err.status) throw err;
      const late = (await dealContracts(client, plan.dealId)).find((c) => c.status !== 'Rejected' && Date.parse(c.updatedAt) >= startedAt - 5000);
      if (!late) throw err;
      made = { _id: late._id };
    }
    if (made && made.existing) {
      throw new Blocked(`The platform returned the deal's existing contract "${made.contractName}" (${made.status}) instead of a new one. Nothing was created.`);
    }
    const contractId = made && made._id;
    if (!contractId) throw new Error('The platform did not return the new contract id.');
    let c = await call(client, 'GET', `/v2/contract/${contractId}`);
    const problems = [];
    if (c.status !== 'Draft') problems.push(`The contract came back as ${c.status}, not Draft. Tell the user right away and stop.`);
    if (follow && c.status === 'Draft') {
      await call(client, 'PATCH', `/v2/contract/${contractId}`, { data: follow.data, confirmed: true });
      c = await call(client, 'GET', `/v2/contract/${contractId}`);
      if (c.status !== 'Draft') problems.push(`The contract came back as ${c.status}, not Draft.`);
    }
    const template = plan.templateId
      ? await call(client, 'GET', `/v2/contract/${plan.templateId}?${qs({ select: 'contractEditor' })}`)
      : null;
    if (!(c.contractDocuments || []).length) problems.push('The contract has no document: the print service did not answer. Generate it again later or attach the document in the app.');
    const evidences = c.signerEvidences || {};
    return {
      saved: problems.length === 0,
      contractId,
      contractName: c.contractName,
      status: c.status,
      documents: (c.contractDocuments || []).length,
      participants: (c.signers || []).map((id) => ({ contactId: idOf(id), role: (evidences[idOf(id)] || {}).role || 'signer', email: (evidences[idOf(id)] || {}).email || null })),
      options: c.options || {},
      variables: template ? variablesReport(template.contractEditor, c.contractFields, c.contractEditor) : null,
      note: NEVER_SENT,
      problems,
      version: c.updatedAt,
    };
  }

  if (plan.action === 'updateContract') {
    const step = change.steps[0];
    // Re-check right before writing: a Ready contract would e-mail its participants on this save.
    const fresh = await call(client, 'GET', `/v2/contract/${plan.contractId}?${qs({ select: 'status' })}`);
    if (fresh.status !== 'Draft') throw new Blocked(`The contract is ${fresh.status} now; nothing was written.`);
    await call(client, step.method, step.path, { data: step.data, confirmed: true });
    const c = await call(client, 'GET', `/v2/contract/${plan.contractId}`);
    const evidences = c.signerEvidences || {};
    const problems = [];
    if (c.status !== 'Draft') problems.push(`The contract came back as ${c.status}, not Draft.`);
    if (step.data.contractName && c.contractName !== step.data.contractName) problems.push('The name did not save.');
    for (const s of plan.signers || []) {
      if (((evidences[s.contactId] || {}).role || 'signer') !== (s.role || 'signer')) problems.push(`The role of ${s.contactId} did not save.`);
    }
    if (plan.signers && (c.signers || []).map(idOf).join() !== plan.signers.map((s) => s.contactId).join()) problems.push('The participants did not save in the order sent.');
    return {
      saved: problems.length === 0,
      contractId: c._id,
      status: c.status,
      participants: (c.signers || []).map((id) => ({ contactId: idOf(id), role: (evidences[idOf(id)] || {}).role || 'signer' })),
      options: c.options || {},
      note: NEVER_SENT,
      problems,
      version: c.updatedAt,
    };
  }
  throw new UsageError(`Unknown action ${plan.action}.`);
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

// Commands and plan actions that read or write the deal's own proposal.
const DEAL_MODEL_COMMANDS = ['deals', 'show', 'preview', 'apply'];
const CONTRACT_ONLY_ACTIONS = ['contractTemplate', 'updateContract'];
const RECORDS_MODEL = 'This account keeps proposals as their own records (several per deal, with status and automatic versions). '
  + 'Use scripts/proposal-records.js instead; nothing was read or written here.';

async function assertDealModel(client, command, rest, rootDir) {
  if (!DEAL_MODEL_COMMANDS.includes(command)) return;
  // A bad plan is a usage error before any call, the model probe included.
  if ((command === 'preview' || command === 'apply') && CONTRACT_ONLY_ACTIONS.includes(readPlan(rest[0], rootDir).action)) return;
  const { model } = await detectModel(client);
  if (model === 'records') throw new Blocked(RECORDS_MODEL);
}

async function cmdModel(client) {
  return detectModel(client);
}

const COMMANDS = {
  model: cmdModel,
  deals: cmdDeals,
  show: cmdShow,
  layouts: cmdLayouts,
  'contract-templates': cmdContractTemplates,
  contract: cmdContract,
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
    if (!handler || !domain) throw new UsageError(`Usage: proposal.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    // Generating a contract prints two PDFs on the server; give it more than the default 30 s.
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr, timeoutMs: GENERATE_TIMEOUT_MS });
    await assertDealModel(client, command, rest, rootDir);
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

module.exports = {
  main, readPlan, buildChange, templateVariables, variablesReport, lookupField, platformOptions, signerBody,
};
