#!/usr/bin/env node
'use strict';

// Follows a Prolibu contract from Draft onwards the way the app does it: who takes part and
// whose turn it is, the first send for signature, reminders to the people who still have to
// sign, taking a sent contract back to Draft, and downloading its PDFs.
//
//   contract.js list             <domain> [name] [--status <S>] [--deal <dealId>] [--limit <n>]
//   contract.js status           <domain> <contractId> [--evidence]
//   contract.js send-preview     <domain> <contractId>
//   contract.js send             <domain> <contractId> --version <v> --recipients <a@x,b@y> --confirmed --reaches-people
//   contract.js remind-preview   <domain> <contractId> [--signer <contactId>]
//   contract.js remind           <domain> <contractId> [--signer <contactId>] --version <v> --recipients <…> --confirmed --reaches-people
//   contract.js withdraw-preview <domain> <contractId>
//   contract.js withdraw         <domain> <contractId> --version <v> --confirmed
//   contract.js download         <domain> <contractId> [--original] [--out <folder>]
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).
//
// The script never prints a signing link or a file URL, never sends to everyone at once
// (resendEmail "all" also e-mails people who already signed), and never writes anything on a
// contract except its status, Draft → Ready (send) or Ready → Draft (withdraw).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ['Draft', 'Ready', 'Pending', 'Signed', 'Rejected'];
// The platform's system "Approved" stage: a deal moves there when all participants sign.
const APPROVED_STAGE_ID = '76a6f41079d81268f83fede4';
const CONTRACT_FIELDS = 'contractName status signers signerEvidences options skipDealApproval origin '
  + 'contractDocuments signedDocuments isContractTemplate tracking createdBy createdAt updatedAt language';
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60000;
const BLOCKED = 3;
const STOP = 'STOP HERE and end your turn; never run the write in the same turn as this preview.';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : String(v));
const norm = (email) => String(email || '').trim().toLowerCase();

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRecipients(text) {
  if (!text) return [];
  return [...new Set(String(text).split(',').map(norm).filter(Boolean))].sort();
}

function sameRecipients(given, expected) {
  const a = parseRecipients(given.join(','));
  const b = [...new Set(expected.map(norm))].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function deadlineInfo(contract, now = Date.now()) {
  const raw = contract.options && contract.options.deadlineDate;
  if (!raw) return { deadline: null, expired: false };
  const t = Date.parse(raw);
  return { deadline: raw, expired: Number.isFinite(t) && t < now };
}

// The platform's own "next signer": the first Pending entry of signerEvidences, in key order
// (not in the order of `signers`).
function nextPending(evidences) {
  const entry = Object.entries(evidences || {}).find(([, e]) => e && e.status === 'Pending');
  return entry ? entry[0] : null;
}

// One row per participant, in signing order (`signers`), with the e-mail the platform really
// uses: the contact's current address, not the copy kept in the evidence.
function participants(contract, contacts) {
  const evidences = contract.signerEvidences || {};
  return (contract.signers || []).map((raw, index) => {
    const id = idOf(raw);
    const e = evidences[id] || null;
    const c = contacts.get(id) || null;
    return {
      order: index + 1,
      contactId: id,
      name: (e && e.fullName) || (c && [c.firstName, c.lastName].filter(Boolean).join(' ')) || null,
      email: c ? (c.email || null) : null,
      evidenceEmail: e ? (e.email || null) : null,
      role: (e && e.role) || null,
      status: (e && e.status) || null,
      actedAt: e && (e.status === 'Signed' || e.status === 'Rejected') ? (e.updatedAt || null) : null,
      rejectReason: (e && e.rejectReason) || null,
      contactExists: Boolean(c),
      hasEvidence: Boolean(e),
    };
  });
}

function participantProblems(rows) {
  const blockers = [];
  const warnings = [];
  for (const p of rows) {
    const who = p.name || p.contactId;
    if (!p.contactExists) blockers.push(`Participant ${p.order} (${who}) is not an existing contact.`);
    else if (!p.email || !EMAIL_RE.test(p.email)) blockers.push(`Participant ${p.order} (${who}) has no valid e-mail on the contact.`);
    if (!p.hasEvidence) blockers.push(`Participant ${p.order} (${who}) has no role on the contract: fix the participants with prolibu-proposals (updateContract) while it is a Draft.`);
    if (p.email && p.evidenceEmail && norm(p.email) !== norm(p.evidenceEmail)) {
      warnings.push(`${who}: the e-mail goes to the contact's current address ${p.email}, not to ${p.evidenceEmail} shown on the contract.`);
    }
  }
  return { blockers, warnings };
}

function dealEffect(contract, deal, approvedStageName) {
  if (!contract.origin || contract.origin.modelName !== 'Deal') {
    return 'This contract does not come from a deal: signing it moves nothing.';
  }
  if (contract.skipDealApproval) return 'Signing it does not move the deal (skipDealApproval is on).';
  const name = approvedStageName || 'Approved';
  const already = deal && idOf(deal.stage) === APPROVED_STAGE_ID;
  return already
    ? `The deal is already in the system stage "${name}".`
    : `When every participant has signed, the platform moves the deal to its system stage "${name}" (this runs the deal's webhooks and stage rules), even if the account's pipeline uses other stages.`;
}

// ─── API reads ─────────────────────────────────────────────────────────────────

async function call(client, method, reqPath, opts) {
  const res = await client.request(method, reqPath, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function contractId(arg, usage) {
  if (!ID_RE.test(String(arg || ''))) throw new UsageError(usage);
  return String(arg);
}

async function loadContract(client, id) {
  let c;
  try {
    c = await call(client, 'GET', `/v2/contract/${id}?${qs({ select: CONTRACT_FIELDS })}`);
  } catch (err) {
    if (err.status === 404) throw new Blocked('No contract with that id in this account (or this user cannot see it).');
    throw err;
  }
  if (c.isContractTemplate) throw new Blocked('That id is a contract template, not a contract. Templates belong to prolibu-proposals.');
  return c;
}

async function loadContacts(client, contract) {
  const ids = (contract.signers || []).map(idOf);
  const map = new Map();
  if (!ids.length) return map;
  const body = await call(client, 'GET', `/v2/contact?${qs({
    xquery: JSON.stringify({ _id: { $in: ids } }), select: 'firstName lastName email', limit: String(Math.min(ids.length, 500)),
  })}`);
  for (const c of body.data || []) map.set(String(c._id), c);
  return map;
}

async function loadDeal(client, contract) {
  if (!contract.origin || contract.origin.modelName !== 'Deal' || !contract.origin.docId) return { deal: null, stageName: null };
  let deal = null;
  try {
    deal = await call(client, 'GET', `/v2/deal/${idOf(contract.origin.docId)}?${qs({ select: 'dealName stage' })}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 403) throw err;
  }
  let stageName = null;
  if (deal && deal.stage) {
    try {
      stageName = (await call(client, 'GET', `/v2/stage/${idOf(deal.stage)}?${qs({ select: 'stageName' })}`)).stageName || null;
    } catch {
      stageName = null;
    }
  }
  return { deal, stageName };
}

async function approvedStageName(client) {
  try {
    return (await call(client, 'GET', `/v2/stage/${APPROVED_STAGE_ID}?${qs({ select: 'stageName' })}`)).stageName || null;
  } catch {
    return null;
  }
}

async function userName(client, id) {
  if (!id || !ID_RE.test(idOf(id))) return null;
  try {
    const u = await call(client, 'GET', `/v2/user/${idOf(id)}?${qs({ select: 'firstName lastName' })}`);
    return [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

async function loadAll(client, id) {
  const contract = await loadContract(client, id);
  const contacts = await loadContacts(client, contract);
  const rows = participants(contract, contacts);
  return { contract, rows };
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdList(client, rest, flags) {
  const term = rest.join(' ').trim();
  const filter = { isContractTemplate: { $ne: true } };
  if (flags.status) {
    const s = STATUSES.find((x) => x.toLowerCase() === String(flags.status).toLowerCase());
    if (!s) throw new UsageError(`--status must be one of ${STATUSES.join(', ')}.`);
    filter.status = s;
  }
  if (flags.deal) {
    if (!ID_RE.test(flags.deal)) throw new UsageError('--deal must be a deal id (24 hex characters).');
    filter['origin.docId'] = flags.deal;
  }
  if (term) filter.contractName = { $regex: `(?i)${escapeRegex(term)}` };
  const body = await call(client, 'GET', `/v2/contract?${qs({
    xquery: JSON.stringify(filter),
    select: 'contractName status signerEvidences origin options.deadlineDate updatedAt',
    sort: '-updatedAt',
    limit: String(flags.limit || 20),
  })}`);
  const contracts = (body.data || []).map((c) => {
    const ev = Object.values(c.signerEvidences || {}).filter(Boolean);
    return {
      contractId: c._id,
      name: c.contractName,
      status: c.status,
      signed: `${ev.filter((e) => e.status === 'Signed').length}/${ev.length}`,
      dealId: c.origin && c.origin.modelName === 'Deal' ? idOf(c.origin.docId) : null,
      deadline: (c.options && c.options.deadlineDate) || null,
      updatedAt: c.updatedAt,
    };
  });
  return { total: body.pagination ? body.pagination.count : contracts.length, contracts };
}

async function cmdStatus(client, [rawId], flags) {
  const id = contractId(rawId, 'Usage: status <domain> <contractId> [--evidence]');
  const { contract, rows } = await loadAll(client, id);
  const { deal, stageName } = await loadDeal(client, contract);
  const approved = contract.origin && contract.origin.modelName === 'Deal' ? await approvedStageName(client) : null;
  const { deadline, expired } = deadlineInfo(contract);
  const evidences = contract.signerEvidences || {};
  const inOrder = Boolean(contract.options && contract.options.sendEmailsInOrder);
  const open = ['Ready', 'Pending'].includes(contract.status);
  const turnId = open ? nextPending(evidences) : null;
  const turn = turnId ? rows.find((r) => r.contactId === turnId) : null;
  const views = contract.tracking && Array.isArray(contract.tracking.views) ? contract.tracking.views : [];
  const lastView = (contract.tracking && contract.tracking.lastSeenAt)
    || views.map((v) => v && (v.date || v.createdAt || v.viewedAt)).filter(Boolean).sort().pop() || null;

  const trail = [{ at: contract.createdAt, event: 'created' }];
  for (const r of rows) {
    if (r.status === 'Signed') trail.push({ at: r.actedAt, event: `${r.role === 'reviewer' ? 'reviewed' : 'signed'} by ${r.name}` });
    if (r.status === 'Rejected') trail.push({ at: r.actedAt, event: `rejected by ${r.name}${r.rejectReason ? `: ${r.rejectReason}` : ''}` });
  }
  trail.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  const out = {
    contractId: contract._id,
    name: contract.contractName,
    status: contract.status,
    language: contract.language || null,
    participants: rows.map(({ contactExists, hasEvidence, ...r }) => r),
    oneAtATime: inOrder,
    whoseTurn: turn ? { name: turn.name, email: turn.email, role: turn.role } : null,
    deadline,
    deadlineExpired: expired,
    canReject: Boolean(contract.options && contract.options.reject && contract.options.reject.allow),
    emailCode: Boolean(contract.options && contract.options.verification && contract.options.verification.emailCode),
    documents: { original: (contract.contractDocuments || []).length, signed: (contract.signedDocuments || []).length },
    views: { total: (contract.tracking && contract.tracking.totalViews) || views.length, last: lastView },
    deal: deal ? { dealId: deal._id, name: deal.dealName, stage: stageName } : null,
    dealEffect: dealEffect(contract, deal, approved),
    auditTrail: trail,
    notes: [],
  };
  if (inOrder && open) {
    const firstInSigners = rows.find((r) => r.status === 'Pending');
    if (firstInSigners && turnId && firstInSigners.contactId !== turnId) {
      out.notes.push('The platform picks the next person by the order the roles were saved, which differs from the participant list here.');
    }
    out.notes.push('One at a time only controls who gets the e-mail; the platform does not stop a later person from signing first.');
  }
  if (expired && open) out.notes.push('The deadline has passed: nobody can sign, and the contract stays open until someone acts in the app.');
  if (flags.evidence) {
    out.evidence = rows.filter((r) => r.status === 'Signed' || r.status === 'Rejected').map((r) => {
      const e = evidences[r.contactId] || {};
      return { name: r.name, ip: e.ip || null, location: e.location || null };
    });
    out.notes.push('evidence holds personal data (IP and location): share it only with someone who needs it.');
  }
  return out;
}

// ─── Send (Draft → Ready) ──────────────────────────────────────────────────────

async function planSend(client, id) {
  const { contract, rows } = await loadAll(client, id);
  const blockers = [];
  const warnings = [];
  if (contract.status === 'Ready') blockers.push('The contract was already sent (Ready). To e-mail the pending people again use remind-preview; never save it again.');
  else if (contract.status !== 'Draft') blockers.push(`The contract is ${contract.status}: it cannot be sent again.`);
  if (!contract.origin || contract.origin.modelName !== 'Deal') {
    blockers.push('This contract was not generated from a deal (an uploaded PDF or another origin): its signature positions are set in the app. Send it from the app.');
  }
  if (!rows.length) blockers.push('The contract has no participants. Add them with prolibu-proposals while it is a Draft.');
  if (!(contract.contractDocuments || []).length) blockers.push('The contract has no document to sign.');
  if (rows.length && !rows.some((r) => r.role === 'signer')) blockers.push('Every participant is a reviewer: at least one must be a signer.');
  const pp = participantProblems(rows);
  blockers.push(...pp.blockers);
  warnings.push(...pp.warnings);
  const { deadline, expired } = deadlineInfo(contract);
  if (expired) blockers.push(`The deadline (${deadline}) has passed: nobody could sign. Change it with prolibu-proposals first.`);
  else if (!deadline) warnings.push('There is no deadline: the signing link never expires. Consider setting one with prolibu-proposals first.');
  const inOrder = Boolean(contract.options && contract.options.sendEmailsInOrder);
  const now = inOrder ? rows.slice(0, 1) : rows;
  const later = inOrder ? rows.slice(1) : [];
  const { deal, stageName } = await loadDeal(client, contract);
  const approved = await approvedStageName(client);
  const requestedBy = await userName(client, contract.createdBy);
  if (contract.options && contract.options.verification && contract.options.verification.emailCode) {
    warnings.push('Each person gets a code by e-mail when they open the document, before they can sign.');
  }
  warnings.push(`The e-mail says it was requested by ${requestedBy || 'the contract creator'} (the person who created the contract), not by whoever sends it.`);
  warnings.push('Once sent, every later save of this contract e-mails the request again: do not edit it while it waits for signatures.');
  const recipients = now.map((r) => r.email).filter(Boolean);
  const version = hash({
    u: contract.updatedAt, s: contract.status, signers: rows.map((r) => [r.contactId, r.role, r.status, norm(r.email)]), o: contract.options,
  });
  return {
    contract, rows, blockers, warnings, recipients, version,
    summary: {
      contractId: contract._id,
      name: contract.contractName,
      deal: deal ? { name: deal.dealName, stage: stageName } : null,
      emailedNow: now.map((r) => ({ name: r.name, email: r.email, role: r.role })),
      emailedLaterOneByOne: later.map((r) => ({ name: r.name, email: r.email, role: r.role })),
      deadline,
      canReject: Boolean(contract.options && contract.options.reject && contract.options.reject.allow),
      dealEffect: dealEffect(contract, deal, approved),
    },
  };
}

async function cmdSendPreview(client, [rawId]) {
  const id = contractId(rawId, 'Usage: send-preview <domain> <contractId>');
  const p = await planSend(client, id);
  return {
    ...p.summary,
    recipients: p.recipients,
    warnings: p.warnings,
    blockers: p.blockers,
    version: p.blockers.length ? null : p.version,
    nextStep: p.blockers.length
      ? 'Blocked: explain each blocker to the user in plain words. Nothing was sent.'
      : `This e-mails real people and cannot be undone. Show the user who gets the e-mail now (recipients), who gets it later, the deal effect and every warning, and ask them to confirm by repeating the exact e-mail list. ${STOP} Only after an explicit yes to exactly these recipients in a later message, run send with --version ${p.version} --recipients "${p.recipients.join(',')}" --confirmed --reaches-people. Never print or share a signing link.`,
  };
}

async function cmdSend(client, [rawId], flags) {
  const id = contractId(rawId, 'Usage: send <domain> <contractId> --version <v> --recipients <a@x,…> --confirmed --reaches-people');
  if (!flags.version) throw new UsageError('Missing --version. Run send-preview first and pass its version.');
  if (!flags.recipients) throw new UsageError('Missing --recipients: the exact e-mail list from send-preview, as the user confirmed it.');
  if (!flags.confirmed || !flags.reachesPeople) {
    throw new UsageError('Sending e-mails people: it needs --confirmed and --reaches-people, given only after the user said yes to exactly these recipients.');
  }
  const p = await planSend(client, id);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The contract or its participants changed since the preview. Run send-preview again and show the user.');
  if (!sameRecipients(parseRecipients(flags.recipients), p.recipients)) {
    throw new Blocked(`--recipients does not match who would be e-mailed now (${p.recipients.join(', ')}). Nothing was sent.`);
  }
  await call(client, 'PATCH', `/v2/contract/${id}`, { data: { status: 'Ready' }, confirmed: true, reachesPeople: true });
  const after = await loadContract(client, id);
  const problems = after.status === 'Ready' ? [] : [`The contract came back as ${after.status}, not Ready.`];
  return {
    sent: problems.length === 0,
    contractId: id,
    status: after.status,
    emailedNow: p.summary.emailedNow,
    emailedLaterOneByOne: p.summary.emailedLaterOneByOne,
    dealEffect: p.summary.dealEffect,
    problems,
  };
}

// ─── Remind (resendEmail single, pending people only) ──────────────────────────

async function planRemind(client, id, signer) {
  if (signer !== undefined && !ID_RE.test(String(signer))) throw new UsageError('--signer must be a contact id (24 hex characters).');
  const { contract, rows } = await loadAll(client, id);
  const blockers = [];
  if (contract.status === 'Draft') blockers.push('The contract has not been sent yet (Draft): use send-preview.');
  else if (!['Ready', 'Pending'].includes(contract.status)) blockers.push(`The contract is ${contract.status}: there is nobody to remind.`);
  const { deadline, expired } = deadlineInfo(contract);
  if (expired) blockers.push(`The deadline (${deadline}) has passed: the link would not let anyone sign. Decide in the app what to do with the contract.`);
  const inOrder = Boolean(contract.options && contract.options.sendEmailsInOrder);
  const signerIds = new Set(rows.map((r) => r.contactId));
  const pendingIds = Object.entries(contract.signerEvidences || {})
    .filter(([cid, e]) => e && e.status === 'Pending' && signerIds.has(cid)).map(([cid]) => cid);
  let eligible = blockers.length ? [] : (inOrder ? pendingIds.slice(0, 1) : pendingIds);
  if (signer !== undefined) {
    const row = rows.find((r) => r.contactId === signer);
    if (!row) blockers.push('That contact is not a participant of this contract.');
    else if (row.status !== 'Pending') blockers.push(`${row.name || signer} already ${String(row.status).toLowerCase()}; there is nothing to remind.`);
    else if (!blockers.length && !eligible.includes(signer)) blockers.push(`It is not ${row.name || signer}'s turn yet: the contract goes one person at a time.`);
    eligible = eligible.filter((x) => x === signer);
  }
  if (!blockers.length && !eligible.length) blockers.push('Nobody is pending.');
  const targets = eligible.map((cid) => rows.find((r) => r.contactId === cid));
  const pp = participantProblems(targets);
  blockers.push(...pp.blockers);
  const recipients = targets.map((r) => r.email).filter(Boolean);
  const version = hash({ u: contract.updatedAt, s: contract.status, t: targets.map((r) => [r.contactId, norm(r.email)]) });
  return { contract, targets, blockers, warnings: pp.warnings, recipients, version, inOrder };
}

async function cmdRemindPreview(client, [rawId], flags) {
  const id = contractId(rawId, 'Usage: remind-preview <domain> <contractId> [--signer <contactId>]');
  const p = await planRemind(client, id, flags.signer);
  const skipped = (p.contract.signers || []).map(idOf).filter((cid) => !p.targets.some((t) => t && t.contactId === cid));
  return {
    contractId: id,
    name: p.contract.contractName,
    status: p.contract.status,
    reminded: p.targets.map((r) => ({ name: r.name, email: r.email, role: r.role })),
    notReminded: skipped.length,
    oneAtATime: p.inOrder,
    recipients: p.recipients,
    warnings: p.warnings,
    blockers: p.blockers,
    version: p.blockers.length ? null : p.version,
    nextStep: p.blockers.length
      ? 'Blocked: explain each blocker to the user in plain words. Nothing was sent.'
      : `This e-mails real people and cannot be undone. Show the user exactly who gets the reminder and ask them to confirm the e-mail list. ${STOP} Only after an explicit yes to exactly these recipients in a later message, run remind with --version ${p.version} --recipients "${p.recipients.join(',')}"${flags.signer ? ` --signer ${flags.signer}` : ''} --confirmed --reaches-people. Never print or share a signing link.`,
  };
}

async function cmdRemind(client, [rawId], flags) {
  const id = contractId(rawId, 'Usage: remind <domain> <contractId> [--signer <id>] --version <v> --recipients <…> --confirmed --reaches-people');
  if (!flags.version) throw new UsageError('Missing --version. Run remind-preview first and pass its version.');
  if (!flags.recipients) throw new UsageError('Missing --recipients: the exact e-mail list from remind-preview, as the user confirmed it.');
  if (!flags.confirmed || !flags.reachesPeople) {
    throw new UsageError('A reminder e-mails people: it needs --confirmed and --reaches-people, given only after the user said yes to exactly these recipients.');
  }
  const p = await planRemind(client, id, flags.signer);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The contract changed since the preview (someone signed, or it was edited). Run remind-preview again.');
  if (!sameRecipients(parseRecipients(flags.recipients), p.recipients)) {
    throw new Blocked(`--recipients does not match who would be reminded (${p.recipients.join(', ')}). Nothing was sent.`);
  }
  const sentTo = [];
  for (const t of p.targets) {
    try {
      await call(client, 'POST', `/v2/contract/resendEmail/${id}/${t.contactId}/single`, { confirmed: true, reachesPeople: true });
    } catch (err) {
      return { sent: false, sentTo, failedAt: { name: t.name, email: t.email }, problems: [String(err.message)] };
    }
    sentTo.push({ name: t.name, email: t.email });
  }
  return { sent: true, contractId: id, sentTo, problems: [] };
}

// ─── Withdraw (Ready → Draft) ──────────────────────────────────────────────────

async function planWithdraw(client, id) {
  const contract = await loadContract(client, id);
  const blockers = [];
  const ev = Object.values(contract.signerEvidences || {}).filter(Boolean);
  if (contract.status === 'Draft') blockers.push('The contract is already a Draft: there is nothing to withdraw.');
  else if (contract.status === 'Pending') blockers.push('Someone has already signed: withdrawing would hide their signature. Cancelling a partially signed contract is done in the app.');
  else if (contract.status !== 'Ready') blockers.push(`The contract is ${contract.status}: it cannot be withdrawn.`);
  else if (ev.some((e) => e.status !== 'Pending')) blockers.push('A participant has already acted on this contract. Handle it in the app.');
  return { contract, blockers, version: contract.updatedAt };
}

async function cmdWithdrawPreview(client, [rawId]) {
  const id = contractId(rawId, 'Usage: withdraw-preview <domain> <contractId>');
  const p = await planWithdraw(client, id);
  return {
    contractId: id,
    name: p.contract.contractName,
    status: p.contract.status,
    effects: [
      'The contract goes back to Draft. Its signing links stop working: they show only that it is a draft.',
      'Nobody is e-mailed: tell the participants yourself if they expect it.',
      'Sending it again later e-mails every participant again.',
    ],
    blockers: p.blockers,
    version: p.blockers.length ? null : p.version,
    nextStep: p.blockers.length
      ? 'Blocked: explain each blocker to the user in plain words. Nothing was written.'
      : `Show the user these effects and ask for a yes. ${STOP} Only after an explicit yes in a later message, run withdraw with --version ${p.version} --confirmed.`,
  };
}

async function cmdWithdraw(client, [rawId], flags) {
  const id = contractId(rawId, 'Usage: withdraw <domain> <contractId> --version <v> --confirmed');
  if (!flags.version) throw new UsageError('Missing --version. Run withdraw-preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const p = await planWithdraw(client, id);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The contract changed since the preview (someone may have signed). Run withdraw-preview again.');
  await call(client, 'PATCH', `/v2/contract/${id}`, { data: { status: 'Draft' }, confirmed: true });
  const after = await loadContract(client, id);
  const problems = after.status === 'Draft' ? [] : [`The contract came back as ${after.status}, not Draft.`];
  return { withdrawn: problems.length === 0, contractId: id, status: after.status, problems };
}

// ─── Download ──────────────────────────────────────────────────────────────────

function safeName(text) {
  return String(text || 'contract').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'contract';
}

function isInside(child, dir) {
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function outputDir(flagOut, rootDir) {
  if (!flagOut) {
    const base = process.env.CLAUDE_SCRATCHPAD || os.tmpdir();
    return fs.mkdtempSync(path.join(base, 'prolibu-contract-'));
  }
  const dir = path.resolve(flagOut);
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // Created below.
  }
  let root = path.resolve(rootDir);
  try {
    root = fs.realpathSync(root);
  } catch {
    // Keep the lexical path.
  }
  if (isInside(dir, path.resolve(rootDir)) || isInside(real, root)) {
    throw new UsageError('Refusing --out inside the repository: signed contracts hold personal data. Pick a folder outside it, or leave --out out to use a temp folder.');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function allowedFileUrl(text) {
  try {
    const u = new URL(text);
    return u.protocol === 'https:' && (u.hostname === 'amazonaws.com' || u.hostname.endsWith('.amazonaws.com'));
  } catch {
    return false;
  }
}

async function cmdDownload(client, [rawId], flags, ctx) {
  const id = contractId(rawId, 'Usage: download <domain> <contractId> [--original] [--out <folder>]');
  const kind = flags.original ? 'contractDocuments' : 'signedDocuments';
  let body;
  try {
    body = await call(client, 'GET', `/v2/contract/${id}?${qs({
      select: 'contractName status isContractTemplate contractDocuments signedDocuments',
      populatePath: JSON.stringify([{ path: 'contractDocuments' }, { path: 'signedDocuments' }]),
      outputFormat: 'signedUrl',
    })}`);
  } catch (err) {
    if (err.status === 404) throw new Blocked('No contract with that id in this account (or this user cannot see it).');
    throw err;
  }
  if (body.isContractTemplate) throw new Blocked('That id is a contract template, not a contract.');
  const files = (body[kind] || []).filter((f) => f && typeof f === 'object');
  if (!files.length) {
    throw new Blocked(flags.original
      ? 'The contract has no original document.'
      : `There is no signed document yet (the contract is ${body.status}). Use --original for the document as sent.`);
  }
  const dir = outputDir(flags.out, ctx.rootDir);
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const saved = [];
  for (const [i, f] of files.entries()) {
    if (!allowedFileUrl(f.signedUrl)) throw new Error(`The platform gave no usable download address for file ${i + 1}.`);
    const res = await fetchImpl(f.signedUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.status !== 200) throw new Error(`Downloading file ${i + 1} answered ${res.status} (download addresses expire after 15 minutes: run download again).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES) throw new Error(`File ${i + 1} is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB.`);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`File ${i + 1} is not a PDF.`);
    const label = flags.original ? 'original' : 'signed';
    const base = `${safeName(body.contractName)}-${label}${files.length > 1 ? `-${i + 1}` : ''}`;
    let file = path.join(dir, `${base}.pdf`);
    for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `${base}-${n}.pdf`);
    fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
    saved.push({ file, bytes: buf.length });
  }
  return {
    contractId: id,
    name: body.contractName,
    status: body.status,
    kind: flags.original ? 'original' : 'signed',
    saved,
    note: 'Give the user the local file paths. Never share download addresses or signing links.',
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
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (arg === '--evidence') flags.evidence = true;
    else if (arg === '--original') flags.original = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--recipients') flags.recipients = next();
    else if (arg === '--signer') flags.signer = next();
    else if (arg === '--status') flags.status = next();
    else if (arg === '--deal') flags.deal = next();
    else if (arg === '--out') flags.out = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 20, 1), 100);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  list: cmdList,
  status: cmdStatus,
  'send-preview': cmdSendPreview,
  send: cmdSend,
  'remind-preview': cmdRemindPreview,
  remind: cmdRemind,
  'withdraw-preview': cmdWithdrawPreview,
  withdraw: cmdWithdraw,
  download: cmdDownload,
};
const WRITES = { send: 'sent', remind: 'sent', withdraw: 'withdrawn' };

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
    if (!handler || !domain) {
      throw new UsageError(`Usage: contract.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir, fetchImpl: opts.fetchImpl });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (WRITES[command] && !result[WRITES[command]]) return 1;
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
  main, participants, nextPending, sameRecipients, parseRecipients, deadlineInfo, dealEffect, allowedFileUrl, safeName,
};
