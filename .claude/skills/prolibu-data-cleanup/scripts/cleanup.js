#!/usr/bin/env node
'use strict';

// Duplicate contacts and companies: find them, merge them, and tag stale contacts as archived.
//
//   cleanup.js duplicates <domain> <contact|company> [--by email,phone,name,domain,id] [--limit <n>]
//   cleanup.js show       <domain> <contact|company> <id | e-mail | companyCode>   record + what points at it
//   cleanup.js inactive   <domain> --before YYYY-MM-DD [--limit <n>]               contacts with no activity since
//   cleanup.js preview    <domain> '<plan>'                                         writes nothing; returns a version
//   cleanup.js apply      <domain> '<plan>' --version <v> --confirmed [--fires-webhooks]
//
// Plan kinds: merge (one duplicate group) | archive (tag contacts). See SKILL.md for each shape.
// Plans are inline JSON or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).
//
// The platform has no merge operation and no archive for contacts or companies. A merge here
// re-points what can be re-pointed, fills the primary's empty fields, marks the duplicate and
// never deletes it: deleting a contact or company also deletes every note, task, call and
// meeting still listed on it, including the ones just moved (the API cannot clear that list).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');
// Same matching rules as lead conversion and imports: one definition of "same person".
const { nameSimilarity, phonesOf } = require('../../prolibu-leads/scripts/leads');
const { normalizeKey } = require('../../prolibu-imports/scripts/imports');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCKED = 3;
const PAGE = 500;
const MAX_SCAN = 20000;
const MAX_KEY_GROUP = { 'e-mail': 10, phone: 10, 'tax id': 50, domain: 50, name: 50 };
const MAX_NAME_BLOCK = 400;
const NAME_THRESHOLD = 0.92;
const MAX_REFS_PER_KIND = 500;
const MAX_MOVES = 1000;
const MAX_ARCHIVE = 200;
const MERGED_PREFIX = '[FUSIONADA] ';
const DEFAULT_MERGED_TAG = 'Fusionado';
const DEFAULT_ARCHIVE_TAG = 'Archivado';
const FREE_MAIL = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.es', 'live.com', 'icloud.com',
  'msn.com', 'aol.com', 'hotmail.es', 'outlook.es', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'example.com']);
const LEGAL_SUFFIX = /\b(s\s?a\s?de\s?c\s?v|s\s?de\s?r\s?l(\s?de\s?c\s?v)?|s\s?a\s?s|s\s?a|ltda|ltd|limitada|inc|llc|corp|corporation|co|cia|gmbh|e\s?u|s\s?l|s\s?r\s?l|plc)\b/g;

const MODELS = {
  contact: {
    api: 'contact', name: 'Contact',
    select: 'firstName lastName email otherEmails mobile whatsapp phones company companyName jobTitle website address '
      + 'identification socialNetworks industry numberOfEmployees clientSince source tags workspace assignee stage '
      + 'emailStatus consent createdAt updatedAt',
    scanSelect: 'firstName lastName email otherEmails mobile whatsapp phones identification company companyName workspace createdAt updatedAt',
    fill: ['firstName', 'lastName', 'jobTitle', 'company', 'companyName', 'website', 'mobile', 'whatsapp', 'address',
      'identification', 'socialNetworks', 'industry', 'numberOfEmployees', 'clientSince', 'source'],
  },
  company: {
    api: 'company', name: 'Company',
    select: 'companyName companyCode legalName domains website identification primaryEmail primaryPhone phones whatsapp '
      + 'address industry numberOfEmployees socialNetworks locale isAccountOwner assignee createdAt updatedAt',
    scanSelect: 'companyName companyCode legalName domains website identification primaryEmail createdAt updatedAt',
    fill: ['legalName', 'website', 'identification', 'primaryEmail', 'primaryPhone', 'whatsapp', 'address', 'industry',
      'numberOfEmployees', 'socialNetworks', 'locale'],
  },
};

// What points at a contact or a company. `move` says how a merge re-points it; report-only rows
// stay on the duplicate (the API ignores the field, or moving it would rewrite legal or billing
// history), and the preview says so. `extra` narrows a shared field (origin.docId).
const REFS = {
  contact: [
    { api: 'deal', name: 'Deal', field: 'contact', move: 'set', label: 'deals' },
    { api: 'presentation', name: 'Presentation', field: 'contact', move: 'set', label: 'presentations' },
    { api: 'note', name: 'Note', field: 'origin.docId', extra: { 'origin.modelName': 'Contact' }, move: 'origin', label: 'notes' },
    { api: 'task', name: 'Task', field: 'origin.docId', extra: { 'origin.modelName': 'Contact' }, move: 'origin', label: 'tasks' },
    { api: 'call', name: 'Call', field: 'origin.docId', extra: { 'origin.modelName': 'Contact' }, move: 'origin', label: 'calls' },
    { api: 'call', name: 'Call', field: 'contact', move: 'set', label: 'calls (contact field)' },
    { api: 'meeting', name: 'Meeting', field: 'origin.docId', extra: { 'origin.modelName': 'Contact' }, move: 'origin', label: 'meetings' },
    { api: 'meeting', name: 'Meeting', field: 'attendees', move: 'array', label: 'meetings (attendee)' },
    { api: 'conversation', name: 'Conversation', field: 'contact', move: 'set', label: 'conversations' },
    { api: 'contactlist', name: 'ContactList', field: 'contacts', move: 'array', label: 'contact lists' },
    { api: 'email', field: 'contact', label: 'e-mails', why: 'the API cannot change an e-mail\'s contact; they stay on the duplicate\'s timeline' },
    { api: 'contactsubmission', field: 'contact', label: 'form and ad submissions', why: 'the contact of a submission cannot be changed; re-contact history stays on the duplicate' },
    { api: 'lead', field: 'convertedTo', label: 'converted leads', why: 'fixed by the server at conversion' },
    { api: 'contract', field: 'signers', label: 'contracts (signer)', why: 'signers are legal evidence; not rewritten' },
    { api: 'ticket', field: 'requester.contact', label: 'support tickets', why: 'the requester is not rewritten (its company field would be lost)' },
    { api: 'invoice', field: 'contact', label: 'invoices', why: 'billing history is not rewritten' },
    { api: 'subscription', field: 'contact', label: 'subscriptions', why: 'billing history is not rewritten' },
    { api: 'paymentmethod', field: 'contact', label: 'payment methods', why: 'billing data is not rewritten' },
    { api: 'emailcampaign', field: 'contacts', label: 'e-mail campaigns', why: 'campaign audiences are history' },
    { api: 'calendarevent', field: 'contact', label: 'bookings', why: 'the booking\'s signer is not rewritten' },
    { api: 'workorder', field: 'contact', label: 'work orders', why: 'not rewritten here' },
    { api: 'pricebook', field: 'contact', label: 'price books', why: 'not rewritten here' },
    { api: 'company', field: 'referedBy.contact', label: 'companies referred by', why: 'not rewritten here' },
  ],
  company: [
    { api: 'contact', name: 'Contact', field: 'company', move: 'set', label: 'contacts' },
    { api: 'note', name: 'Note', field: 'origin.docId', extra: { 'origin.modelName': 'Company' }, move: 'origin', label: 'notes' },
    { api: 'task', name: 'Task', field: 'origin.docId', extra: { 'origin.modelName': 'Company' }, move: 'origin', label: 'tasks' },
    { api: 'task', name: 'Task', field: 'company', move: 'set', label: 'tasks (company field)' },
    { api: 'conversation', name: 'Conversation', field: 'company', move: 'set', label: 'conversations' },
    { api: 'deal', field: 'company', label: 'deals', why: 'Deal.company is read-only in the API and the server only fills it when empty: these deals keep the old company in reports' },
    { api: 'meeting', field: 'company', label: 'meetings', why: 'read-only in the API' },
    { api: 'ticket', field: 'requester.company', label: 'support tickets', why: 'read-only in the API' },
    { api: 'invoice', field: 'company', label: 'invoices', why: 'read-only in the API' },
    { api: 'subscription', field: 'company', label: 'subscriptions', why: 'read-only in the API' },
    { api: 'paymentmethod', field: 'company', label: 'payment methods', why: 'read-only in the API' },
    { api: 'workorder', field: 'company', label: 'work orders', why: 'read-only in the API' },
    { api: 'asset', field: 'supplier', label: 'assets (supplier)', why: 'not rewritten here' },
    { api: 'group', field: 'company', label: 'groups', why: 'not rewritten here' },
  ],
};

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes to THIS group in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const fullName = (r) => (r && typeof r === 'object' ? [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null : null);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normName = (s) => deaccent(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function isEmpty(v) {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v).every(isEmpty);
  return false;
}

const emailKey = (e) => normalizeKey('email', e);
const emailsOf = (r) => [r.email, r.primaryEmail, ...((r.otherEmails || []).map((o) => o && o.email))]
  .map(emailKey).filter((e) => e && EMAIL_RE.test(e));

function companyKey(name) {
  const base = normName(normalizeKey('companyName', name) || '').replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return base.length >= 3 ? base : null;
}

function hostOf(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const at = t.lastIndexOf('@');
  const host = at >= 0 ? t.slice(at + 1) : t.replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0];
  const clean = host.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) && !FREE_MAIL.has(clean) ? clean : null;
}

const domainsOf = (c) => [...new Set([...(c.domains || []), c.website, c.primaryEmail].map(hostOf).filter(Boolean))];
const docIdOf = (r) => {
  const d = r.identification && (r.identification.docId || r.identification.number);
  const k = String(d || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  return k.length >= 5 ? k : null;
};

// Union-find over record ids; each union remembers why.
function groupPairs(ids, pairs) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Finds duplicate groups in already-loaded records. Pure: tested without the API.
//   by: subset of email, phone, name, domain, id
function findDuplicates(model, records, by) {
  const reasons = new Map();
  const pairs = [];
  const skippedKeys = [];
  const note = (a, b, why, strong) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const prev = reasons.get(key) || { why: new Set(), strong: false };
    prev.why.add(why);
    prev.strong = prev.strong || strong;
    reasons.set(key, prev);
    pairs.push([a, b]);
  };
  const byKey = (label, keysOf, strong) => {
    const index = new Map();
    for (const r of records) for (const k of keysOf(r)) {
      if (!index.has(k)) index.set(k, new Set());
      index.get(k).add(idOf(r));
    }
    for (const [k, set] of index) {
      const ids = [...set];
      if (ids.length < 2) continue;
      if (ids.length > MAX_KEY_GROUP[label]) {
        skippedKeys.push({ by: label, key: label === 'phone' ? `…${k}` : k, records: ids.length });
        continue;
      }
      for (let i = 1; i < ids.length; i += 1) note(ids[0], ids[i], label === 'phone' ? `same phone (…${k})` : `same ${label} (${k})`, strong);
    }
  };
  if (by.includes('email')) byKey('e-mail', emailsOf, true);
  if (by.includes('phone') && model === 'contact') byKey('phone', phonesOf, true);
  if (by.includes('id')) byKey('tax id', (r) => [docIdOf(r)].filter(Boolean), true);
  if (by.includes('domain') && model === 'company') byKey('domain', domainsOf, true);
  if (by.includes('name')) {
    const label = model === 'company' ? (r) => r.companyName : fullName;
    if (model === 'company') byKey('name', (r) => [companyKey(r.companyName)].filter(Boolean), false);
    // Similar names, compared inside blocks that share the first letters of a word.
    const blocks = new Map();
    for (const r of records) {
      const n = model === 'company' ? companyKey(r.companyName) : normName(fullName(r));
      if (!n || n.length < 6 || (model === 'contact' && !n.includes(' '))) continue;
      const words = n.split(' ');
      const head = (model === 'contact' ? words[words.length - 1] : words[0]).slice(0, 4);
      if (!blocks.has(head)) blocks.set(head, []);
      blocks.get(head).push(r);
    }
    for (const [head, list] of blocks) {
      if (list.length > MAX_NAME_BLOCK) {
        skippedKeys.push({ by: 'similar name', key: head, records: list.length });
        continue;
      }
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const score = nameSimilarity(label(list[i]), label(list[j]));
          if (score >= NAME_THRESHOLD) note(idOf(list[i]), idOf(list[j]), `similar name (${Math.round(score * 100)}%)`, false);
        }
      }
    }
  }
  const byId = new Map(records.map((r) => [idOf(r), r]));
  const groups = groupPairs(records.map(idOf), pairs).map((ids) => {
    const why = [];
    let strong = false;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        const r = reasons.get(key);
        if (r) {
          why.push(...r.why);
          strong = strong || r.strong;
        }
      }
    }
    const members = ids.map((id) => byId.get(id));
    const label = (m) => (model === 'company' ? m.companyName : fullName(m)) || '';
    const mixedNames = members.some((a, i) => members.slice(i + 1).some((b) => label(a) && label(b) && nameSimilarity(label(a), label(b)) < 0.5));
    return {
      confidence: strong ? 'high' : 'low',
      ...(mixedNames ? { mixedNames: true } : {}),
      why: [...new Set(why)],
      suggestedPrimary: idOf(suggestPrimary(model, members)),
      sameWorkspace: new Set(members.map((m) => idOf(m.workspace))).size === 1,
      records: members.map((m) => recordView(model, m)),
    };
  });
  groups.sort((a, b) => (a.confidence === b.confidence ? b.records.length - a.records.length : a.confidence === 'high' ? -1 : 1));
  return { groups, skippedKeys };
}

// The record with more filled fields; the oldest on a tie. Only a suggestion: the user decides.
function suggestPrimary(model, members) {
  const score = (r) => MODELS[model].fill.filter((f) => !isEmpty(r[f])).length + emailsOf(r).length;
  return [...members].sort((a, b) => score(b) - score(a) || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
}

function recordView(model, r) {
  if (model === 'company') {
    return {
      _id: idOf(r), companyName: r.companyName || null, companyCode: r.companyCode || null, domains: domainsOf(r), createdAt: r.createdAt || null, updatedAt: r.updatedAt || null,
    };
  }
  return {
    _id: idOf(r),
    name: fullName(r),
    email: r.email || null,
    otherEmails: (r.otherEmails || []).map((o) => o && o.email).filter(Boolean),
    phones: phonesOf(r).map((p) => `…${p}`),
    company: r.company ? idOf(r.company) : r.companyName || null,
    workspace: r.workspace ? idOf(r.workspace) : null,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
  };
}

// True when `saved` holds everything that was sent (the server may add defaults such as
// address.location, and returns refs as ids or objects).
function contains(saved, sent) {
  if (sent === null || sent === undefined || sent === '') return isEmpty(saved) || saved === sent;
  if (Array.isArray(sent)) return Array.isArray(saved) && sent.every((x) => saved.some((y) => contains(y, x)));
  if (typeof sent === 'object') return Boolean(saved) && typeof saved === 'object' && Object.keys(sent).every((k) => contains(saved[k], sent[k]));
  if (saved && typeof saved === 'object') return idOf(saved) === String(sent);
  return saved === sent || String(saved) === String(sent);
}

const phoneTail = (n) => String(n || '').replace(/\D/g, '').slice(-8);

// What the primary gains: empty fields filled from duplicates (first duplicate that has it),
// e-mails and phones the primary lacks, the duplicates' tags. Owner, collaborators, group and
// stage stay the primary's: changing them notifies people or moves the pipeline.
function fillPayload(model, primary, duplicates) {
  const payload = {};
  const taken = {};
  for (const field of MODELS[model].fill) {
    if (!isEmpty(primary[field])) continue;
    if (field === 'companyName' && (primary.company || payload.company)) continue;
    const src = duplicates.find((d) => !isEmpty(d[field]));
    if (src) {
      payload[field] = field === 'company' ? idOf(src[field]) : src[field];
      taken[field] = idOf(src);
    }
  }
  const tails = new Set([primary.mobile, primary.whatsapp, primary.primaryPhone, ...((primary.phones || []).map((p) => p && p.number))].map(phoneTail).filter(Boolean));
  const fillTails = [payload.mobile, payload.whatsapp, payload.primaryPhone].map(phoneTail).filter(Boolean);
  fillTails.forEach((t) => tails.add(t));
  const newPhones = [];
  for (const d of duplicates) {
    const list = [
      ...((d.phones || []).filter((p) => p && p.number)),
      ...(['mobile', 'whatsapp', 'primaryPhone'].filter((k) => d[k]).map((k) => ({ name: k, number: d[k] }))),
    ];
    for (const p of list) {
      const t = phoneTail(p.number);
      if (t.length >= 7 && !tails.has(t)) {
        tails.add(t);
        newPhones.push({ name: p.name || 'merged', number: String(p.number) });
      }
    }
  }
  if (newPhones.length) payload.phones = [...(primary.phones || []), ...newPhones];
  if (model === 'contact') {
    const have = new Set(emailsOf(primary));
    const extra = [];
    for (const d of duplicates) {
      for (const e of emailsOf(d)) {
        if (!have.has(e)) {
          have.add(e);
          extra.push({ name: 'merged', email: e });
        }
      }
    }
    if (extra.length) payload.otherEmails = [...(primary.otherEmails || []), ...extra];
    const tags = new Set((primary.tags || []).map(idOf));
    const add = duplicates.flatMap((d) => (d.tags || []).map(idOf)).filter((t) => t && !tags.has(t));
    if (add.length) payload.tags = [...tags, ...new Set(add)];
  } else {
    const have = new Set((primary.domains || []).map((d) => String(d).toLowerCase()));
    const add = duplicates.flatMap((d) => d.domains || []).map((d) => String(d).toLowerCase()).filter((d) => !have.has(d));
    if (add.length) payload.domains = [...(primary.domains || []), ...new Set(add)];
  }
  return { payload, taken };
}

// The PATCH body that re-points one record from the duplicate to the primary.
function moveBody(ref, record, dupId, primaryId) {
  if (ref.move === 'origin') return { origin: { modelName: ref.extra['origin.modelName'], docId: primaryId } };
  if (ref.move === 'array') {
    const list = (getPath(record, ref.field) || []).map(idOf).map((id) => (id === dupId ? primaryId : id));
    return { [ref.field]: [...new Set(list)] };
  }
  return { [ref.field]: primaryId };
}

// ─── API helpers ───────────────────────────────────────────────────────────────

async function call(client, method, p, opts) {
  const res = await client.request(method, p, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const msg = typeof body.error === 'string' ? body.error : body.message || 'no message';
    const err = new Error(`${method} ${p.split('?')[0]} answered ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function list(client, object, params) {
  return rowsOf(await call(client, 'GET', `/v2/${object}?${qs(params)}`));
}

async function scanAll(client, model) {
  const rows = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const body = await call(client, 'GET', `/v2/${MODELS[model].api}?${qs({
      select: MODELS[model].scanSelect, limit: String(PAGE), page: String(page), sort: '_id',
    })}`);
    const data = rowsOf(body);
    total = (body.pagination && body.pagination.count) || total;
    rows.push(...data);
    if (data.length < PAGE || rows.length >= MAX_SCAN) break;
    page += 1;
  }
  return { rows, total, truncated: rows.length < total };
}

async function findRecord(client, model, ref) {
  const r = String(ref || '').trim();
  if (!r) throw new UsageError(`Give the ${model} by id${model === 'contact' ? ' or e-mail' : ', companyCode or exact name'}.`);
  let query;
  if (ID_RE.test(r)) query = { _id: r };
  else if (model === 'contact') query = { email: emailKey(r) };
  else if (/^CMP-/i.test(r)) query = { companyCode: r };
  else query = { companyName: r };
  const rows = await list(client, MODELS[model].api, { xquery: query, select: MODELS[model].select, limit: '3' });
  if (!rows.length) throw new Blocked(`No ${model} "${r}" visible to this profile.`);
  if (rows.length > 1) throw new Blocked(`"${r}" matches ${rows.length} companies; use the id or companyCode.`);
  return rows[0];
}

// Records that point at `id` through one reference. The server drops a filter on a field it does
// not know and then answers with EVERY record: the echoed query proves the filter was applied.
async function refsOf(client, ref, id) {
  const xquery = { [ref.field]: id, ...(ref.extra || {}) };
  const select = ref.move === 'array' ? `_id ${ref.field}` : '_id';
  let body;
  try {
    body = await call(client, 'GET', `/v2/${ref.api}?${qs({ xquery, select, limit: String(MAX_REFS_PER_KIND) })}`);
  } catch (err) {
    if (err.status === 404) return { state: 'absent' };
    if (err.status === 403) {
      if (ref.move) throw err;
      return { state: 'forbidden' };
    }
    throw err;
  }
  const echoed = body && body.query && Object.prototype.hasOwnProperty.call(body.query, ref.field);
  if (!echoed) return { state: 'unfilterable' };
  const rows = rowsOf(body);
  const count = (body.pagination && body.pagination.count) || rows.length;
  return { state: 'ok', count, rows };
}

async function referenceReport(client, model, id) {
  const out = [];
  for (const ref of REFS[model]) {
    const r = await refsOf(client, ref, id);
    out.push({ ref, ...r });
  }
  return out;
}

const refSummary = (report) => report
  .filter((r) => r.state !== 'ok' || r.count > 0)
  .map((r) => ({
    what: r.ref.label,
    count: r.state === 'ok' ? r.count : null,
    merge: r.ref.move ? 'moves to the primary' : `stays on the duplicate: ${r.ref.why}`,
    ...(r.state !== 'ok' ? { note: r.state === 'forbidden' ? 'not checked: no permission' : r.state === 'absent' ? 'not on this account' : 'could not be counted (filter not supported)' } : {}),
  }))
  .filter((r) => r.note !== 'not on this account');

// Active webhooks and lifecycle scripts that a write to these models would trigger.
async function automations(client, modelNames) {
  const hits = [];
  let unknown = false;
  try {
    for (const w of await list(client, 'webhook', { xquery: { active: true }, select: 'webhookName eventNames', limit: '200' })) {
      const events = (w.eventNames || []).filter((e) => modelNames.some((m) => e === `${m}.*` || e.startsWith(`${m}.`)));
      if (events.length) hits.push({ type: 'webhook', name: w.webhookName, events });
    }
    for (const s of await list(client, 'script', { xquery: { active: true }, select: 'scriptName lifecycleHooks', limit: '200' })) {
      const models = (s.lifecycleHooks || []).filter((m) => modelNames.includes(m));
      if (models.length) hits.push({ type: 'script', name: s.scriptName, events: models.map((m) => `${m} lifecycle`) });
    }
  } catch (err) {
    if (err.status !== 403) throw err;
    unknown = true;
  }
  return { hits, unknown };
}

async function tagByName(client, name, modelName) {
  const rows = await list(client, 'tag', { xquery: { tagName: name }, select: 'tagName modelName', limit: '10' });
  return rows.find((t) => t.modelName === modelName) || rows.find((t) => !t.modelName) || null;
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

function outDir() {
  const dir = process.env.CLAUDE_SCRATCHPAD || os.tmpdir();
  return fs.existsSync(dir) ? dir : os.tmpdir();
}

function writeDetail(name, data) {
  const file = path.join(outDir(), `prolibu-cleanup-${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ─── Read commands ─────────────────────────────────────────────────────────────

function modelArg(value) {
  if (!MODELS[value]) throw new UsageError('The object is "contact" or "company".');
  return value;
}

async function cmdDuplicates(client, rest, flags) {
  const model = modelArg(rest[0]);
  const by = String(flags.by || (model === 'contact' ? 'email,phone,name,id' : 'domain,name,id,email')).split(',').map((s) => s.trim());
  const bad = by.filter((b) => !['email', 'phone', 'name', 'domain', 'id'].includes(b));
  if (bad.length) throw new UsageError(`Unknown --by ${bad.join(', ')}. Use email, phone, name, domain, id.`);
  const scan = await scanAll(client, model);
  const { groups, skippedKeys } = findDuplicates(model, scan.rows, by);
  const limit = flags.limit || 20;
  const file = writeDetail(`${model}-duplicates`, { by, scanned: scan.rows.length, groups, skippedKeys });
  return {
    object: model,
    by,
    scanned: scan.rows.length,
    totalVisible: scan.total,
    truncated: scan.truncated,
    groups: groups.length,
    highConfidence: groups.filter((g) => g.confidence === 'high').length,
    shown: groups.slice(0, limit),
    skippedKeys: skippedKeys.slice(0, 10),
    skippedKeysTotal: skippedKeys.length,
    detailFile: file,
    notes: [
      'Only records this profile can see are compared.',
      '"low" confidence = similar name only: always ask the user whether they are the same.',
      '"mixedNames" = the group joins records with clearly different names through a shared phone or e-mail (a switchboard, a test value): merge only the pairs the user confirms.',
      skippedKeys.length ? 'Some keys are shared by too many records to be a duplicate (switchboard phones, generic names): they were skipped.' : null,
    ].filter(Boolean),
    nextStep: 'Show the groups. To merge one, run show on its records, then preview a merge plan for ONE group.',
  };
}

async function cmdShow(client, rest) {
  const model = modelArg(rest[0]);
  const record = await findRecord(client, model, rest[1]);
  const report = await referenceReport(client, model, idOf(record));
  return { object: model, record: recordView(model, record), pointingAtIt: refSummary(report) };
}

async function cmdInactive(client, rest, flags) {
  const before = flags.before;
  if (!DATE_RE.test(String(before || ''))) throw new UsageError('Give --before YYYY-MM-DD (no activity since that day).');
  const limit = flags.limit || 50;
  const candidates = [];
  let page = 1;
  let scanned = 0;
  let total = 0;
  while (candidates.length < limit && scanned < MAX_SCAN) {
    const body = await call(client, 'GET', `/v2/contact?${qs({
      xquery: { updatedAt: { $lt: before } }, select: 'firstName lastName email submissions updatedAt createdAt tags', limit: String(PAGE), page: String(page), sort: 'updatedAt',
    })}`);
    const rows = rowsOf(body);
    total = (body.pagination && body.pagination.count) || total;
    scanned += rows.length;
    const fresh = rows.filter((c) => !(c.submissions && c.submissions.lastAt && String(c.submissions.lastAt) >= before));
    const ids = fresh.map(idOf);
    const busy = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      for (const d of await list(client, 'deal', { xquery: { contact: { $in: part }, updatedAt: { $gte: before } }, select: 'contact', limit: '500' })) busy.add(idOf(d.contact));
      for (const e of await list(client, 'email', { xquery: { contact: { $in: part }, createdAt: { $gte: before } }, select: 'contact', limit: '500' })) busy.add(idOf(e.contact));
    }
    candidates.push(...fresh.filter((c) => !busy.has(idOf(c))));
    if (rows.length < PAGE) break;
    page += 1;
  }
  const shown = candidates.slice(0, limit);
  return {
    before,
    notChangedSince: total,
    inactiveShown: shown.length,
    contacts: shown.map((c) => ({
      _id: idOf(c), name: fullName(c), email: c.email, updatedAt: c.updatedAt, lastSubmission: (c.submissions && c.submissions.lastAt) || null,
    })),
    rule: `Not edited since ${before} (a new note, task, call or meeting also counts as an edit), no form or ad submission, no deal touched and no e-mail since then.`,
    nextStep: 'Show the list. To archive, preview {"kind":"archive","contacts":[ids]} (tags them; nothing is deleted).',
  };
}

// ─── Plans ─────────────────────────────────────────────────────────────────────

async function planMerge(client, plan) {
  const model = modelArg(plan.object);
  const primaryRef = plan.primary;
  const dupRefs = [].concat(plan.duplicates || []);
  if (!primaryRef || !dupRefs.length) throw new UsageError('A merge plan needs "primary" and "duplicates": [..] (one group per plan).');
  const primary = await findRecord(client, model, primaryRef);
  const duplicates = [];
  for (const ref of dupRefs) duplicates.push(await findRecord(client, model, ref));
  const blockers = [];
  const warnings = [];
  const pid = idOf(primary);
  if (duplicates.some((d) => idOf(d) === pid)) throw new UsageError('The primary cannot also be a duplicate.');
  if (new Set(duplicates.map(idOf)).size !== duplicates.length) throw new UsageError('A duplicate is listed twice.');
  if (model === 'contact' && duplicates.some((d) => idOf(d.workspace) !== idOf(primary.workspace))) {
    blockers.push('The records belong to different workspaces: the app keeps each workspace apart. Merge only within one workspace.');
  }
  if (model === 'company' && duplicates.some((d) => d.isAccountOwner)) blockers.push('A duplicate is the account\'s own company: it cannot be merged away. Make it the primary.');

  const moves = [];
  const stays = [];
  for (const d of duplicates) {
    const report = await referenceReport(client, model, idOf(d));
    for (const r of report) {
      if (r.ref.move) {
        if (r.state !== 'ok') {
          blockers.push(`Could not list the ${r.ref.label} of ${idOf(d)} (${r.state}): merging could leave them behind.`);
          continue;
        }
        if (r.count > r.rows.length) blockers.push(`${idOf(d)} has ${r.count} ${r.ref.label}; this script moves at most ${MAX_REFS_PER_KIND} per kind.`);
        for (const row of r.rows) moves.push({ ref: r.ref, record: row, from: idOf(d) });
      }
    }
    for (const s of refSummary(report).filter((x) => !x.merge.startsWith('moves'))) stays.push({ duplicate: idOf(d), ...s });
  }
  if (moves.length > MAX_MOVES) blockers.push(`This group needs ${moves.length} writes; the limit is ${MAX_MOVES}. Merge fewer duplicates at a time.`);

  const { payload, taken } = fillPayload(model, primary, duplicates);
  if (model === 'contact') {
    const owners = new Set([primary, ...duplicates].map((r) => idOf(r.assignee)).filter(Boolean));
    if (owners.size > 1) warnings.push('The records have different owners: the primary keeps its owner, nobody is notified.');
    const optOut = duplicates.filter((d) => (d.emailStatus && d.emailStatus.state && d.emailStatus.state !== 'subscribed') || (d.consent && d.consent.state === 'rejected'));
    if (optOut.length) {
      warnings.push(`A duplicate unsubscribed, bounced or rejected marketing consent (${optOut.map((d) => d.email).join(', ')}). That state cannot be copied to the primary: after the merge the primary may still get campaigns. Tell the user.`);
    }
    const companies = new Set([primary, ...duplicates].map((r) => idOf(r.company)).filter(Boolean));
    if (companies.size > 1) warnings.push('The records are linked to different companies: the primary keeps its own.');
    if (duplicates.some((d) => idOf(d.stage) && idOf(d.stage) !== idOf(primary.stage))) warnings.push('A duplicate is in another stage: the primary keeps its stage and stage history.');
  }
  const dealsStay = stays.filter((s) => s.what === 'deals');
  if (model === 'company' && dealsStay.length) warnings.push('Deals keep the old company (the API cannot change it); company reports will still show them under the renamed duplicate.');

  const markTag = model === 'contact' ? String(plan.markTag || DEFAULT_MERGED_TAG) : null;
  const tag = markTag ? await tagByName(client, markTag, 'Contact') : null;
  const marks = duplicates.map((d) => (model === 'company'
    ? { _id: idOf(d), set: { companyName: d.companyName && d.companyName.startsWith(MERGED_PREFIX) ? d.companyName : `${MERGED_PREFIX}${d.companyName}`, domains: [] } }
    : { _id: idOf(d), addTag: markTag }));

  const alreadyMarked = duplicates.every((d) => (model === 'company'
    ? String(d.companyName || '').startsWith(MERGED_PREFIX)
    : Boolean(tag) && (d.tags || []).map(idOf).includes(idOf(tag))));
  if (alreadyMarked && !moves.length && !Object.keys(payload).length) {
    blockers.push('Already merged: nothing left to move or fill, and the duplicates are already marked.');
  }

  const written = new Set([MODELS[model].name, 'Note', ...moves.map((m) => m.ref.name)]);
  if (moves.some((m) => m.ref.move === 'origin')) written.add(MODELS[model].name);
  if (model === 'contact' && !tag) written.add('Tag');
  const auto = await automations(client, [...written]);
  if (auto.unknown) warnings.push('This profile cannot read webhooks and scripts: assume the writes trigger them.');

  const count = {};
  for (const m of moves) count[m.ref.label] = (count[m.ref.label] || 0) + 1;
  const version = hash({
    k: 'merge', model, pid, pu: primary.updatedAt, d: duplicates.map((d) => [idOf(d), d.updatedAt]), m: moves.map((m) => [m.ref.api, idOf(m.record), m.ref.field]), payload, markTag, tag: tag && idOf(tag),
  });
  return {
    model, primary, duplicates, moves, payload, marks, tag, markTag, auto, version,
    view: {
      kind: 'merge',
      object: model,
      primary: recordView(model, primary),
      duplicates: duplicates.map((d) => recordView(model, d)),
      fillsPrimary: Object.keys(payload).map((f) => ({ field: f, value: payload[f], from: taken[f] || 'duplicates' })),
      moves: count,
      staysOnDuplicate: stays,
      markDuplicate: model === 'company'
        ? `Renamed "${MERGED_PREFIX}<name>" and its domains cleared (so new contacts link to the primary). Not deleted.`
        : `Tagged "${markTag}"${tag ? '' : ' (the tag is created)'}. Not deleted; it keeps its e-mail.`,
      auditNote: 'A note on the primary lists what moved.',
      triggers: auto.hits,
      undo: 'A merge cannot be undone by the platform. apply writes a log of every record moved, so it could be moved back by hand.',
      neverDelete: 'Do not delete the duplicate afterwards: deleting it also deletes the notes, tasks, calls and meetings moved to the primary.',
    },
    blockers,
    warnings,
  };
}

async function planArchive(client, plan) {
  if (plan.object && plan.object !== 'contact') {
    throw new UsageError('Only contacts can be archived: companies have no tags and the platform has no archive. Leave stale companies as they are, or merge them.');
  }
  const refs = [].concat(plan.contacts || []);
  if (!refs.length) throw new UsageError('An archive plan needs "contacts": [ids or e-mails].');
  if (refs.length > MAX_ARCHIVE) throw new UsageError(`At most ${MAX_ARCHIVE} contacts per plan.`);
  const ids = refs.filter((r) => ID_RE.test(String(r)));
  const emails = refs.filter((r) => !ID_RE.test(String(r))).map(emailKey);
  const found = [];
  if (ids.length) found.push(...await list(client, 'contact', { xquery: { _id: { $in: ids } }, select: 'firstName lastName email tags updatedAt', limit: '200' }));
  if (emails.length) found.push(...await list(client, 'contact', { xquery: { email: { $in: emails } }, select: 'firstName lastName email tags updatedAt', limit: '200' }));
  const byKey = new Map();
  for (const c of found) byKey.set(idOf(c), c);
  const missing = refs.filter((r) => ![...byKey.values()].some((c) => idOf(c) === String(r) || c.email === emailKey(r)));
  const tagName = String(plan.tag || DEFAULT_ARCHIVE_TAG);
  const tag = await tagByName(client, tagName, 'Contact');
  const contacts = [...byKey.values()];
  const already = tag ? contacts.filter((c) => (c.tags || []).map(idOf).includes(idOf(tag))) : [];
  const todo = contacts.filter((c) => !already.includes(c));
  const written = ['Contact', ...(tag ? [] : ['Tag'])];
  const auto = await automations(client, written);
  const warnings = [];
  if (missing.length) warnings.push(`Not found or not visible: ${missing.join(', ')}.`);
  if (auto.unknown) warnings.push('This profile cannot read webhooks and scripts: assume the writes trigger them.');
  const version = hash({ k: 'archive', t: tagName, tag: tag && idOf(tag), c: todo.map((c) => [idOf(c), c.updatedAt]) });
  return {
    tagName, tag, todo, auto, version,
    view: {
      kind: 'archive',
      tag: `${tagName}${tag ? '' : ' (created)'}`,
      toTag: todo.map((c) => ({ _id: idOf(c), name: fullName(c), email: c.email })),
      alreadyTagged: already.length,
      meaning: 'The platform has no archive for contacts. Archiving = adding this tag; the app can filter it out. Nothing is deleted and nobody is notified.',
      triggers: auto.hits,
    },
    blockers: todo.length ? [] : ['Nothing to do: every contact already has the tag.'],
    warnings,
  };
}

const PLANNERS = { merge: planMerge, archive: planArchive };

async function buildPlan(client, plan) {
  const planner = PLANNERS[plan.kind];
  if (!planner) throw new UsageError('Plan "kind" is "merge" or "archive".');
  return planner(client, plan);
}

async function cmdPreview(client, rest, flags, ctx) {
  const plan = readPlan(rest[0], ctx.rootDir);
  const p = await buildPlan(client, plan);
  const needsFlag = p.auto.hits.length || p.auto.unknown;
  return {
    preview: p.view,
    version: p.version,
    blockers: p.blockers,
    warnings: p.warnings,
    nextStep: p.blockers.length ? 'Blocked: explain the blockers to the user. Nothing was written.'
      : `${STOP}apply with --version ${p.version} --confirmed${needsFlag ? ' --fires-webhooks (the listed webhooks/scripts run; say so in the summary)' : ''}.`,
  };
}

async function readBackMerge(client, p) {
  const problems = [];
  const model = p.model;
  const saved = await findRecord(client, model, idOf(p.primary));
  for (const [field, value] of Object.entries(p.payload)) {
    if (!contains(saved[field], value)) problems.push(`Primary field ${field} did not save as sent.`);
  }
  for (const d of p.duplicates) {
    for (const ref of REFS[model].filter((r) => r.move)) {
      const r = await refsOf(client, ref, idOf(d));
      if (r.state === 'ok' && r.count > 0) problems.push(`${r.count} ${ref.label} still point at duplicate ${idOf(d)}.`);
    }
  }
  return problems;
}

async function applyMerge(client, p) {
  const log = [];
  const problems = [];
  const pid = idOf(p.primary);
  const step = async (what, method, url, data) => {
    try {
      const body = await call(client, method, url, { data, confirmed: true });
      log.push({ ...what, status: 'done' });
      return body;
    } catch (err) {
      log.push({ ...what, status: 'failed', error: err.message });
      throw err;
    }
  };
  try {
    if (Object.keys(p.payload).length) {
      await step({ action: 'fill-primary', fields: Object.keys(p.payload) }, 'PATCH', `/v2/${p.model}/${pid}`, p.payload);
    }
    // Group writes per record: a call can be linked by origin and by its contact field.
    const byRecord = new Map();
    for (const m of p.moves) {
      const key = `${m.ref.api}/${idOf(m.record)}`;
      const prev = byRecord.get(key) || { api: m.ref.api, id: idOf(m.record), from: m.from, fields: [], body: {} };
      Object.assign(prev.body, moveBody(m.ref, m.record, m.from, pid));
      prev.fields.push(m.ref.field);
      byRecord.set(key, prev);
    }
    for (const w of byRecord.values()) {
      await step({ action: 'move', model: w.api, _id: w.id, fields: w.fields, from: w.from, to: pid }, 'PATCH', `/v2/${w.api}/${w.id}`, w.body);
    }
    let tagId = p.tag ? idOf(p.tag) : null;
    if (p.model === 'contact' && !tagId) {
      const created = await step({ action: 'create-tag', tagName: p.markTag }, 'POST', '/v2/tag', { tagName: p.markTag, modelName: 'Contact' });
      tagId = idOf(created);
    }
    for (const [i, mark] of p.marks.entries()) {
      const d = p.duplicates[i];
      const body = p.model === 'company' ? mark.set : { tags: [...new Set([...(d.tags || []).map(idOf), tagId])] };
      await step({ action: 'mark-duplicate', _id: mark._id, set: Object.keys(body) }, 'PATCH', `/v2/${p.model}/${mark._id}`, body);
    }
    const lines = Object.entries(p.view.moves).map(([k, v]) => `<li>${escapeHtml(k)}: ${v}</li>`).join('');
    const dupNames = p.duplicates.map((d) => escapeHtml(p.model === 'company' ? `${d.companyName} (${d.companyCode || idOf(d)})` : `${fullName(d) || ''} <${d.email}>`)).join(', ');
    const content = `<p>Registro fusionado con: ${dupNames}.</p>${lines ? `<ul>${lines}</ul>` : '<p>No había registros que mover.</p>'}`;
    await step({ action: 'audit-note' }, 'POST', '/v2/note', { content, origin: { modelName: MODELS[p.model].name, docId: pid } });
  } catch (err) {
    if (err.status === 403) throw Object.assign(err, { log });
    problems.push(`Stopped at the first failure: ${err.message}. Records already moved are listed in the log; nothing after it was written.`);
  }
  if (!problems.length) problems.push(...await readBackMerge(client, p));
  const logFile = writeDetail('merge-log', { primary: pid, duplicates: p.duplicates.map(idOf), log });
  return {
    merged: { primary: pid, duplicates: p.duplicates.map(idOf) },
    moved: log.filter((l) => l.action === 'move' && l.status === 'done').length,
    log: log.slice(0, 50),
    logFile,
    problems,
  };
}

async function applyArchive(client, p) {
  const done = [];
  const problems = [];
  let tagId = p.tag ? idOf(p.tag) : null;
  if (!tagId) tagId = idOf(await call(client, 'POST', '/v2/tag', { data: { tagName: p.tagName, modelName: 'Contact' }, confirmed: true }));
  for (const c of p.todo) {
    try {
      await call(client, 'PATCH', `/v2/contact/${idOf(c)}`, { data: { tags: [...new Set([...(c.tags || []).map(idOf), tagId])] }, confirmed: true });
      done.push(idOf(c));
    } catch (err) {
      if (err.status === 403) throw err;
      problems.push(`Stopped at ${idOf(c)}: ${err.message}. The contacts before it are tagged; rerun the preview for the rest.`);
      break;
    }
  }
  if (done.length) {
    const back = await list(client, 'contact', { xquery: { _id: { $in: done } }, select: 'tags', limit: '200' });
    for (const c of back) if (!(c.tags || []).map(idOf).includes(tagId)) problems.push(`Contact ${idOf(c)} did not keep the tag.`);
  }
  return { archived: done.length, tag: { _id: tagId, tagName: p.tagName }, contacts: done, problems };
}

async function cmdApply(client, rest, flags, ctx) {
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and ask first.');
  if (!flags.version) throw new UsageError('apply needs the --version printed by preview.');
  const plan = readPlan(rest[0], ctx.rootDir);
  const p = await buildPlan(client, plan);
  if (p.version !== flags.version) throw new Blocked('The records changed since the preview (or the plan is different). Run preview again and show the user the new result.');
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if ((p.auto.hits.length || p.auto.unknown) && !flags.firesWebhooks) {
    throw new Blocked('These writes trigger webhooks or scripts (see preview.triggers). Run apply again with --fires-webhooks only after the user agreed to that.');
  }
  return plan.kind === 'merge' ? applyMerge(client, p) : applyArchive(client, p);
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
    else if (arg === '--fires-webhooks') flags.firesWebhooks = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--by') flags.by = next();
    else if (arg === '--before') flags.before = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 20, 1), 200);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  duplicates: cmdDuplicates,
  show: cmdShow,
  inactive: cmdInactive,
  preview: cmdPreview,
  apply: cmdApply,
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
    if (!handler || !domain) throw new UsageError(`Usage: cleanup.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
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
      if (err.log) stdout.write(`${hide(JSON.stringify({ stoppedAt: err.message, log: err.log }, null, 2))}\n`);
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
  main, findDuplicates, fillPayload, moveBody, contains, companyKey, hostOf, domainsOf, suggestPrimary, REFS,
};
