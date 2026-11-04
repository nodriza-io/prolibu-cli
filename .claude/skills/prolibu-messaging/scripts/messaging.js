#!/usr/bin/env node
'use strict';

// E-mail templates, contact lists and e-mail campaigns the way the Prolibu app builds them, and
// read-only views of WhatsApp conversations. Saving never sends: only `send` sends, and only with
// the version of its own send-preview and --confirmed-send. A test goes to the user's own contact
// unless the user names another one.
//
//   messaging.js templates     <domain> [term] [--whatsapp]
//   messaging.js lists         <domain> [term]
//   messaging.js campaigns     <domain> [term]
//   messaging.js contacts      <domain> <name, e-mail or contact id>
//   messaging.js show          <domain> <template|list|campaign> <id> [--sample <contactId>]
//   messaging.js preview       <domain> '<plan json>' [--sample <contactId>]
//   messaging.js apply         <domain> '<plan json>' --version <v> --confirmed
//   messaging.js send-preview  <domain> <campaignId> [--live] [--test-contact <id>] [--sample <id>]
//   messaging.js send          <domain> <campaignId> --send-version <v> --confirmed-send
//                              [--live --recipients <n>] [--test-contact <id>]
//   messaging.js pause         <domain> <campaignId> --confirmed
//   messaging.js channels      <domain>
//   messaging.js conversations <domain> [--contact <id>] [--channel-type <type>] [--limit <n>]
//   messaging.js messages      <domain> <conversationId> [--limit <n>]
//
// Plan (exactly one key): {"template": {...}} | {"list": {...}} | {"campaign": {...}}; inline
// JSON or the path of a JSON file in a temp folder. Every command accepts --profile <name>.
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const BLOCKED = 3;
const BATCH = 100;
const PROVIDERS = ['google', 'microsoft', 'sendgrid'];
const SUPPRESSED = ['unsubscribed', 'bounced', 'complained'];
const BUILTIN_HELPERS = new Set(['if', 'unless', 'each', 'with', 'lookup', 'log']);
// Merge tags the server fills only while sending a campaign, and what each one needs.
const SEND_TAGS = { presentationUrl: 'presentation', consentAcceptUrl: 'consent', consentRejectUrl: 'consent' };
const CAMPAIGN_ROOTS = 'contact, me (the sender) and the campaign variables';
const blocksMarker = (templateId) => `<!-- pl-blocks-template:${templateId} -->\n`;

class Blocked extends Error {}

// ─── API ─────────────────────────────────────────────────────────────────────

function hintFor(message) {
  if (/oauth|token|sender|scope|provider|proveedor|provedor|remitente/i.test(message)) {
    return 'Campaign e-mails go out from the mailbox of the user who owns this API key. That user must connect '
      + 'Google or Microsoft with send permission in the Prolibu app (or the account must enable SendGrid). Nothing was saved.';
  }
  if (/suppressed/i.test(message)) return 'The contact unsubscribed, bounced or complained: Prolibu will not e-mail them.';
  if (/forbidden|denied|permiso|permission/i.test(message)) {
    return 'Only the campaign creator, its assignee or a collaborator may send, pause or see the live stats of a campaign, even an admin.';
  }
  return undefined;
}

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const message = body.error || body.message || 'no message';
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${message}`);
    err.status = res.status;
    err.hint = hintFor(message);
    throw err;
  }
  return res.body;
}

const qs = (params) => new URLSearchParams(params).toString();
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const idOf = (ref) => (ref && typeof ref === 'object' ? ref._id : ref) || null;
const fullName = (r) => (r ? (`${r.firstName || ''} ${r.lastName || ''}`.trim() || r.email || '') : '');

// ─── Handlebars subset: what the server's message engine accepts ─────────────
// The server renders with an isolated Handlebars instance that has exactly these five helpers
// (plus the built-in block helpers). Same semantics, so a preview matches the e-mail that goes out.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');
const HELPERS = {
  default(value, ...rest) {
    const fallback = rest.length ? rest[0] : '';
    return value === undefined || value === null || value === '' ? fallback : value;
  },
  uppercase: (v) => (v === undefined || v === null ? '' : String(v).toUpperCase()),
  lowercase: (v) => (v === undefined || v === null ? '' : String(v).toLowerCase()),
  shortDate(value, format) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const fmt = typeof format === 'string' && format ? format : 'YYYY-MM-DD';
    const tokens = {
      YYYY: String(d.getUTCFullYear()), YY: String(d.getUTCFullYear()).slice(-2), MMMM: MONTHS[d.getUTCMonth()],
      MMM: MONTHS[d.getUTCMonth()].slice(0, 3), MM: pad2(d.getUTCMonth() + 1), DD: pad2(d.getUTCDate()),
      D: String(d.getUTCDate()), HH: pad2(d.getUTCHours()), mm: pad2(d.getUTCMinutes()),
    };
    return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|DD|D|HH|mm/g, (m, literal) => (literal !== undefined ? literal : tokens[m]));
  },
  toCurrency(amount, currency) {
    const num = Number(amount);
    if (!Number.isFinite(num)) return '';
    const cur = typeof currency === 'string' && currency ? currency : 'USD';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(num);
    } catch {
      return String(num);
    }
  },
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '`': '&#x60;', '=': '&#x3D;' };
function toText(value) {
  if (value === undefined || value === null) return '';
  return String(value); // objects print "[object Object]", exactly like the real e-mail
}
const escapeHtml = (value) => toText(value).replace(/[&<>"'`=]/g, (c) => ESCAPES[c]);

function tokenize(src) {
  const parts = [];
  const errors = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    if (open === -1) {
      parts.push({ type: 'text', text: src.slice(i) });
      break;
    }
    if (open > 0 && src[open - 1] === '\\') {
      parts.push({ type: 'text', text: `${src.slice(i, open - 1)}{{` });
      i = open + 2;
      continue;
    }
    if (open > i) parts.push({ type: 'text', text: src.slice(i, open) });
    if (src.startsWith('{{!--', open)) {
      const end = src.indexOf('--}}', open + 5);
      if (end === -1) {
        errors.push('Unclosed comment "{{!--".');
        break;
      }
      i = end + 4;
      continue;
    }
    const triple = src.startsWith('{{{', open);
    const close = triple ? '}}}' : '}}';
    const end = src.indexOf(close, open + close.length);
    if (end === -1) {
      errors.push(`Unclosed "${triple ? '{{{' : '{{'}" near "${src.slice(open, open + 40)}".`);
      break;
    }
    parts.push({ type: 'mustache', raw: src.slice(open, end + close.length), inner: src.slice(open + close.length, end), triple });
    i = end + close.length;
  }
  return { parts, errors };
}

function classify(token) {
  const quoted = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/s.exec(token);
  if (quoted) return { lit: quoted[1] !== undefined ? quoted[1] : quoted[2] };
  if (/^-?\d+(\.\d+)?$/.test(token)) return { lit: Number(token) };
  if (token === 'true' || token === 'false') return { lit: token === 'true' };
  if (token === 'null' || token === 'undefined') return { lit: null };
  if (token.startsWith('(') || token.includes('=') || token.startsWith('../') || token.startsWith('@')) return { complex: true };
  return { path: token.replace(/^(this|\.)[./]/, '') };
}

function parseExpression(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\([^)]*\)|\S+/g) || [];
  const [name = '', ...rest] = tokens;
  const params = rest.map(classify);
  return { name, params, complex: params.some((p) => p.complex) || name.startsWith('@') || name.startsWith('../') };
}

function parseMustache(part) {
  const s = part.inner.replace(/^~/, '').replace(/~$/, '').trim();
  if (s.startsWith('!')) return { kind: 'comment' };
  if (part.triple) return { kind: 'raw', ...parseExpression(s) };
  const c = s[0];
  if (c === '#' && (s[1] === '>' || s[1] === '*')) return { kind: 'partial' };
  if (c === '#') return { kind: 'open', ...parseExpression(s.slice(1).trim()) };
  if (c === '^' && s.length === 1) return { kind: 'else' };
  if (c === '^') return { kind: 'open', ...parseExpression(s.slice(1).trim()) };
  if (c === '/') return { kind: 'close', name: s.slice(1).trim() };
  if (c === '>') return { kind: 'partial' };
  if (c === '&') return { kind: 'raw', ...parseExpression(s.slice(1).trim()) };
  if (/^else(\s|$)/.test(s)) return { kind: 'else' };
  return { kind: 'var', ...parseExpression(s) };
}

function lookup(context, path) {
  if (path === 'this' || path === '.') return context;
  return path.split(/[./]/).filter(Boolean).reduce((obj, key) => {
    if (obj === null || obj === undefined) return undefined;
    return Object.prototype.hasOwnProperty.call(Object(obj), key) ? obj[key] : undefined;
  }, context);
}

// Validates and renders a template source. `errors` are what the server rejects when saving
// (it compiles and runs every template). Blocks ({{#if}}, {{#each}}…) are left unrendered and
// mark the result `approximate`; the server still validates them.
function processTemplate(source, context, { escape = true } = {}) {
  const { parts, errors } = tokenize(String(source || ''));
  const out = [];
  const paths = [];
  const stack = [];
  let approximate = false;
  const collect = (m, includeName) => {
    if (includeName && m.name && !HELPERS[m.name] && !BUILTIN_HELPERS.has(m.name) && !m.name.startsWith('@')) {
      paths.push(m.name.replace(/^(this|\.)[./]/, ''));
    }
    m.params.filter((p) => p.path).forEach((p) => paths.push(p.path));
  };
  for (const part of parts) {
    if (part.type === 'text') {
      out.push(part.text);
      continue;
    }
    const m = parseMustache(part);
    if (m.kind === 'comment') continue;
    if (m.kind === 'partial') {
      errors.push(`Partials and inline blocks are not available in messages: ${part.raw}`);
      continue;
    }
    if (m.kind === 'open') {
      if (!stack.length) collect(m, false);
      if (m.params.length && !BUILTIN_HELPERS.has(m.name) && !HELPERS[m.name]) errors.push(`Missing helper: "${m.name}".`);
      stack.push(m.name);
      approximate = true;
      out.push(part.raw);
      continue;
    }
    if (m.kind === 'close') {
      const top = stack.pop();
      if (top !== m.name) errors.push(`"{{/${m.name}}}" does not close "${top ? `{{#${top}}}` : 'any block'}".`);
      out.push(part.raw);
      continue;
    }
    if (m.kind === 'else') {
      if (!stack.length) errors.push('"{{else}}" outside a block.');
      out.push(part.raw);
      continue;
    }
    if (!m.name) {
      errors.push(`Empty expression: ${part.raw}`);
      continue;
    }
    const isHelper = Boolean(HELPERS[m.name]) || BUILTIN_HELPERS.has(m.name);
    if (!isHelper && m.params.length) {
      errors.push(`Missing helper: "${m.name}". Available: ${Object.keys(HELPERS).join(', ')}.`);
      continue;
    }
    if (stack.length) {
      out.push(part.raw);
      continue;
    }
    collect(m, !isHelper);
    if (m.complex || BUILTIN_HELPERS.has(m.name)) {
      approximate = true;
      out.push(part.raw);
      continue;
    }
    const value = HELPERS[m.name]
      ? HELPERS[m.name](...m.params.map((p) => (p.path !== undefined ? lookup(context, p.path) : p.lit)))
      : lookup(context, m.name.replace(/^(this|\.)[./]/, ''));
    out.push(escape && m.kind !== 'raw' ? escapeHtml(value) : toText(value));
  }
  if (stack.length) errors.push(`Unclosed block "{{#${stack[stack.length - 1]}}}".`);
  return { output: out.join(''), errors, paths: [...new Set(paths)], approximate };
}

// Walks a path through the account's field lists (GET /v2/user/me → modelSchemas).
function walkSchema(schemas, modelName, segs) {
  let node = schemas[modelName];
  let model = modelName;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (!node || typeof node !== 'object') return { ok: true };
    if (i === 0 && seg === 'fullName') return { ok: true };
    const attr = node[seg];
    const last = i === segs.length - 1;
    if (attr === undefined || attr === null) {
      if (/^\d+$/.test(seg)) return { ok: true };
      return { ok: false, reason: `${model} has no field "${segs.slice(0, i + 1).join('.')}"` };
    }
    const isArray = Array.isArray(attr.type);
    if (attr.ref) {
      if (last) return { ok: true, endsOnRecord: true };
      if (isArray) return { ok: true };
      model = attr.ref;
      node = schemas[attr.ref];
      continue;
    }
    if (typeof attr.type === 'string' || isArray) {
      if (last || isArray || attr.type === 'mixed') return { ok: true };
      return { ok: false, reason: `${model} field "${segs.slice(0, i + 1).join('.')}" is a single value` };
    }
    if (last) return { ok: true, endsOnRecord: true };
    node = attr;
  }
  return { ok: true };
}

// What each {{path}} turns into inside a campaign e-mail. Blockers stop a save; warnings render empty.
function lintPaths(paths, { schemas, variables = null, campaign = null }) {
  const warnings = [];
  const blockers = [];
  for (const path of paths) {
    const segs = path.split(/[./]/).filter(Boolean);
    const root = segs[0];
    if (SEND_TAGS[root] && segs.length === 1) {
      if (!campaign) {
        warnings.push(`{{${root}}} is filled only while a campaign sends (${SEND_TAGS[root] === 'consent' ? 'consent-request campaigns' : 'campaigns with a presentation'}).`);
      } else if (SEND_TAGS[root] === 'consent' && !campaign.consentRequest) {
        blockers.push(`{{${root}}} works only in consent-request campaigns; the server refuses to save it here.`);
      } else if (SEND_TAGS[root] === 'presentation' && !(campaign.presentation && campaign.presentation.layout)) {
        blockers.push('{{presentationUrl}} needs a presentation on the campaign; the server refuses to save it here.');
      }
      continue;
    }
    if (root === 'contact' || root === 'me' || root === 'sender') {
      if (segs.length === 1) {
        warnings.push(`{{${path}}} prints "[object Object]": name a field, such as {{${root}.firstName}}.`);
        continue;
      }
      const res = walkSchema(schemas, root === 'contact' ? 'Contact' : 'User', segs.slice(1));
      if (!res.ok) warnings.push(`{{${path}}} renders empty: ${res.reason}.`);
      else if (res.endsOnRecord) warnings.push(`{{${path}}} prints "[object Object]": name a field inside it, such as ${path}.<field>.`);
      continue;
    }
    if (root === 'variables') {
      if (segs.length < 2) warnings.push('{{variables}} prints "[object Object]": use {{variables.<name>}}.');
      else if (variables && !(segs[1] in variables)) warnings.push(`{{${path}}} renders empty: the campaign has no variable "${segs[1]}".`);
      continue;
    }
    if (schemas.Contact && schemas.Contact[root] !== undefined) {
      warnings.push(`{{${path}}} renders empty in a campaign: write {{contact.${path}}}.`);
      continue;
    }
    warnings.push(`{{${path}}} renders empty: a campaign e-mail only knows ${CAMPAIGN_ROOTS}.`);
  }
  return { warnings, blockers };
}

// Mirrors the server's populate of a template's {{contact.a.b}} paths (any depth), as populatePath.
function populateTree(paths, schemas, root, modelName) {
  const tree = { select: new Set(), children: new Map() };
  for (const path of paths) {
    const segs = path.split(/[./]/).filter(Boolean);
    if (segs[0] !== root) continue;
    let node = tree;
    let schema = schemas[modelName];
    for (let i = 1; i < segs.length && schema; i += 1) {
      const attr = schema[segs[i]];
      if (!attr) break;
      if (!attr.ref) {
        node.select.add(segs[i]);
        break;
      }
      if (!node.children.has(segs[i])) node.children.set(segs[i], { select: new Set(), children: new Map() });
      node = node.children.get(segs[i]);
      schema = schemas[attr.ref];
    }
  }
  const toSpec = (node) => [...node.children.entries()].map(([path, child]) => {
    const spec = { path };
    if (child.select.size) spec.select = [...child.select, ...child.children.keys()].join(' ');
    const nested = toSpec(child);
    if (nested.length) spec.populate = nested;
    return spec;
  });
  return toSpec(tree);
}

// ─── Account reads ───────────────────────────────────────────────────────────

async function loadMe(client, cache) {
  if (!cache.me) {
    const body = await call(client, 'GET', '/v2/user/me');
    cache.me = { profile: body.profile || {}, schemas: body.modelSchemas || {} };
  }
  return cache.me;
}

async function loadContactsById(client, ids, select) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const body = await call(client, 'GET', `/v2/contact?${qs({ xquery: JSON.stringify({ _id: { $in: chunk } }), select, limit: '500' })}`);
    (body.data || []).forEach((c) => found.set(String(c._id), c));
  }
  return found;
}

async function campaignEmailRows(client, campaignId) {
  const rows = [];
  for (let page = 1; page < 200; page += 1) {
    const body = await call(client, 'GET', `/v2/email?${qs({
      xquery: JSON.stringify({ emailCampaign: campaignId }), select: 'contact status to error', sort: 'createdAt', limit: '500', page: String(page),
    })}`);
    rows.push(...(body.data || []));
    if (!body.pagination || page >= body.pagination.lastPage) break;
  }
  return rows;
}

// Who of these contact ids an e-mail campaign would reach, by the server's own send gates.
async function analyzeRecipients(client, ids, { campaignId } = {}) {
  const all = (ids || []).map(String);
  const unique = [...new Set(all)];
  const found = await loadContactsById(client, unique, 'firstName lastName email emailStatus consent');
  const already = new Map();
  if (campaignId) (await campaignEmailRows(client, campaignId)).forEach((row) => already.set(String(idOf(row.contact)), row.status));
  const r = {
    contacts: unique.length, repeatedIds: all.length - unique.length, notFound: [], noEmail: 0,
    unsubscribed: 0, bounced: 0, complained: 0, alreadyEmailed: 0, duplicateEmails: 0,
    consent: { accepted: 0, pending: 0, rejected: 0 }, willReceive: 0, sampleContact: null,
  };
  const seen = new Set();
  for (const id of unique) {
    const c = found.get(id);
    if (!c) {
      r.notFound.push(id);
      continue;
    }
    const state = c.emailStatus && c.emailStatus.state;
    if (!c.email) r.noEmail += 1;
    else if (SUPPRESSED.includes(state)) r[state] += 1;
    else if (already.has(id)) r.alreadyEmailed += 1;
    else {
      r.willReceive += 1;
      const consent = (c.consent && c.consent.state) || 'pending';
      r.consent[consent] = (r.consent[consent] || 0) + 1;
      const email = c.email.toLowerCase();
      if (seen.has(email)) r.duplicateEmails += 1;
      seen.add(email);
      if (!r.sampleContact) r.sampleContact = id;
    }
  }
  r.notFound = { count: r.notFound.length, ids: r.notFound.slice(0, 10) };
  return r;
}

function recipientWarnings(r) {
  const w = [];
  if (r.notFound.count) w.push(`${r.notFound.count} contact id(s) do not exist or you cannot see them; the server drops them silently.`);
  if (r.noEmail) w.push(`${r.noEmail} contact(s) have no e-mail address.`);
  const suppressed = r.unsubscribed + r.bounced + r.complained;
  if (suppressed) w.push(`${suppressed} contact(s) unsubscribed, bounced or complained: Prolibu skips them.`);
  if (r.alreadyEmailed) w.push(`${r.alreadyEmailed} contact(s) already have an e-mail from this campaign (a test or an earlier run): they will not get another.`);
  if (r.duplicateEmails) w.push(`${r.duplicateEmails} contact(s) share an e-mail address with another recipient: that address gets more than one copy.`);
  if (r.consent.pending || r.consent.rejected) {
    w.push(`If the account enforces habeas data consent, ${r.consent.pending + r.consent.rejected} of them (consent pending or rejected) are skipped too; only ${r.consent.accepted} have accepted.`);
  }
  return w;
}

// Renders subject and body for one contact with the same context the server builds:
// {contact (full record + fullName), sender and me (the campaign creator), variables}.
async function renderSample(client, cache, { subject, message, contactId, creatorId, variables, campaign }) {
  if (!contactId) return null;
  const { profile, schemas } = await loadMe(client, cache);
  const subj = processTemplate(subject, {});
  const body = processTemplate(message, {});
  const paths = [...new Set([...subj.paths, ...body.paths])];
  const tree = populateTree(paths, schemas, 'contact', 'Contact');
  const q = tree.length ? `?${qs({ populatePath: JSON.stringify(tree) })}` : '';
  const contact = await call(client, 'GET', `/v2/contact/${contactId}${q}`);
  contact.fullName = fullName(contact);
  const notPreviewed = [];
  let me = null;
  if (!creatorId || String(creatorId) === String(profile._id)) {
    me = { ...profile, fullName: fullName(profile) };
    paths.filter((p) => /^(me|sender)[./]/.test(p) && lookup({ me }, p.replace(/^sender/, 'me')) === undefined)
      .forEach((p) => notPreviewed.push(p));
  } else {
    paths.filter((p) => /^(me|sender)[./]/.test(p)).forEach((p) => notPreviewed.push(p));
  }
  // Values this key cannot read show as "[me.field]" instead of looking empty.
  const shownMe = me ? JSON.parse(JSON.stringify(me)) : {};
  notPreviewed.forEach((p) => {
    const segs = p.split(/[./]/).filter(Boolean).slice(1);
    let node = shownMe;
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) node[seg] = `[${p}]`;
      else node = (node[seg] = node[seg] && typeof node[seg] === 'object' ? node[seg] : {});
    });
  });
  const context = { contact, sender: shownMe, me: shownMe, variables: variables || {} };
  if (campaign && campaign.presentation && campaign.presentation.layout) context.presentationUrl = '[presentation link created at send time]';
  const s = processTemplate(subject, context, { escape: false });
  const m = processTemplate(message, context);
  const empty = paths.filter((p) => !notPreviewed.includes(p) && !SEND_TAGS[p]
    && [undefined, null, ''].includes(lookup(context, p)));
  return {
    contactId: String(contact._id),
    to: contact.email || null,
    subject: s.output,
    text: m.output.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    emptyForThisContact: empty,
    notPreviewed,
    approximate: s.approximate || m.approximate,
  };
}

// ─── Plans ───────────────────────────────────────────────────────────────────

function readPlan(arg, rootDir) {
  let text = String(arg || '');
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
  const kinds = ['template', 'list', 'campaign'].filter((k) => plan && plan[k]);
  if (kinds.length !== 1) throw new UsageError('The plan needs exactly one of "template", "list" or "campaign".');
  const kind = kinds[0];
  const spec = plan[kind];
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new UsageError(`"${kind}" must be an object.`);
  if (spec.id !== undefined && !ID_RE.test(String(spec.id))) throw new UsageError(`"${kind}.id" must be 24 hex characters.`);
  const ALLOWED = {
    template: ['id', 'name', 'subject', 'content'],
    list: ['id', 'name', 'description', 'add', 'remove'],
    campaign: ['id', 'name', 'provider', 'templateId', 'subject', 'message', 'listIds', 'addContacts', 'removeContacts', 'testContact', 'variables', 'scheduledAt'],
  };
  Object.keys(spec).forEach((key) => {
    if (!ALLOWED[kind].includes(key)) {
      throw new UsageError(`"${kind}.${key}" is not supported. Allowed: ${ALLOWED[kind].join(', ')}. Sequences, consent requests and presentations are set up in the app.`);
    }
  });
  for (const key of ['add', 'remove', 'listIds', 'addContacts', 'removeContacts']) {
    if (spec[key] === undefined) continue;
    if (!Array.isArray(spec[key]) || spec[key].some((id) => !ID_RE.test(String(id)))) {
      throw new UsageError(`"${kind}.${key}" must be an array of ids (24 hex characters).`);
    }
  }
  for (const key of ['templateId', 'testContact']) {
    if (spec[key] !== undefined && spec[key] !== null && !ID_RE.test(String(spec[key]))) throw new UsageError(`"${kind}.${key}" must be 24 hex characters.`);
  }
  if (plan.sampleContact !== undefined && !ID_RE.test(String(plan.sampleContact))) throw new UsageError('"sampleContact" must be 24 hex characters.');
  return { kind, spec, sampleContact: plan.sampleContact };
}

function diff(record, wanted) {
  const changes = [];
  const body = {};
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined) continue;
    const before = record ? record[field] : undefined;
    if (JSON.stringify(before === undefined ? null : before) === JSON.stringify(value)) continue;
    body[field] = value;
    const short = (v) => (Array.isArray(v) ? `${v.length} item(s)` : typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v);
    changes.push({ field, before: short(before === undefined ? null : before), after: short(value) });
  }
  return { body, changes };
}

async function planTemplate(client, cache, spec, sampleContact) {
  const record = spec.id ? await call(client, 'GET', `/v2/messagetemplate/${spec.id}`) : null;
  const blockers = [];
  const warnings = [];
  if (!record && (!spec.name || !spec.content)) throw new UsageError('A new template needs "name" and "content" (HTML).');
  if (record && record.modelName === 'Message') {
    blockers.push('This is a WhatsApp template: saving it submits it to WhatsApp for review. Change it in the app.');
  }
  if (record && record.modelName && record.modelName !== 'Email') {
    warnings.push(`This template is for ${record.modelName} records; e-mail campaigns only offer templates with no type or type Email.`);
  }
  const isBlocks = record && record.design && record.design.format === 'blocks';
  if (isBlocks && spec.content !== undefined) {
    blockers.push('This template was built with the block editor: its HTML is regenerated from the blocks. Change the content in the app\'s block editor; only the name and subject can change here.');
  }
  const subject = spec.subject !== undefined ? spec.subject : record && record.subject;
  const content = spec.content !== undefined ? spec.content : record && record.content;
  const { schemas } = await loadMe(client, cache);
  const s = processTemplate(subject, {});
  const c = processTemplate(content, {});
  [...s.errors.map((e) => `Subject: ${e}`), ...c.errors.map((e) => `Content: ${e}`)].forEach((e) => blockers.push(`${e} The server refuses to save an invalid template.`));
  const lint = lintPaths([...new Set([...s.paths, ...c.paths])], { schemas });
  warnings.push(...lint.warnings);
  if (!subject) warnings.push('No subject: a campaign built from it needs one.');
  const wanted = { messageTemplateName: spec.name, subject: spec.subject, content: spec.content };
  if (!record) wanted.modelName = 'Email';
  const { body, changes } = diff(record, wanted);
  const sample = await renderSample(client, cache, { subject, message: content, contactId: sampleContact });
  return {
    action: record ? 'update' : 'create', object: 'messagetemplate', id: record ? record._id : null, body, changes,
    variables: [...new Set([...s.paths, ...c.paths])], sample, warnings, blockers,
    version: fingerprint(['template', record ? record.updatedAt : null, body]),
    check: (after) => Object.entries(body).filter(([k, v]) => JSON.stringify(after[k]) !== JSON.stringify(v)).map(([k]) => `${k} did not save as sent.`),
  };
}

async function planList(client, cache, spec) {
  const record = spec.id ? await call(client, 'GET', `/v2/contactlist/${spec.id}`) : null;
  if (!record && !spec.name) throw new UsageError('A new list needs "name".');
  const before = ((record && record.contacts) || []).map((c) => String(idOf(c)));
  const remove = new Set((spec.remove || []).map(String));
  const contacts = [...new Set([...before.filter((id) => !remove.has(id)), ...(spec.add || []).map(String)])];
  const blockers = [];
  const added = contacts.filter((id) => !before.includes(id));
  const addedFound = await loadContactsById(client, added, '_id');
  const missing = added.filter((id) => !addedFound.has(id));
  if (missing.length) blockers.push(`These contact ids do not exist (or you cannot see them): ${missing.join(', ')}. The server would save them anyway.`);
  const recipients = await analyzeRecipients(client, contacts);
  const wanted = { contactListName: spec.name, description: spec.description };
  if (spec.add || spec.remove || !record) wanted.contacts = contacts;
  const { body, changes } = diff(record ? { ...record, contacts: before } : null, wanted);
  return {
    action: record ? 'update' : 'create', object: 'contactlist', id: record ? record._id : null, body, changes,
    added: added.length, removed: before.filter((id) => !contacts.includes(id)).length, recipients,
    warnings: recipientWarnings(recipients), blockers,
    version: fingerprint(['list', record ? record.updatedAt : null, body]),
    check: (after) => {
      const problems = [];
      if (body.contacts) {
        const saved = (after.contacts || []).map((c) => String(idOf(c)));
        if (saved.length !== contacts.length || contacts.some((id) => !saved.includes(id))) problems.push('contacts did not save as sent.');
      }
      if (body.contactListName && after.contactListName !== body.contactListName) problems.push('contactListName did not save as sent.');
      return problems;
    },
  };
}

async function planCampaign(client, cache, spec, sampleContact) {
  const record = spec.id ? await call(client, 'GET', `/v2/emailcampaign/${spec.id}`) : null;
  const blockers = [];
  const warnings = [];
  if (record) {
    if (record.status !== 'Paused') blockers.push(`The campaign is ${record.status}: content cannot change after it was launched.`);
    if (record.sequence) blockers.push('This campaign runs a sequence; sequences are managed in the app.');
    if (record.consentRequest) blockers.push('This is a consent-request campaign; manage it in the app.');
    if (record.sentAt) warnings.push('This campaign already sent part of its e-mails and was paused.');
  } else {
    if (!spec.name) throw new UsageError('A new campaign needs "name".');
    if (!spec.provider) throw new UsageError(`A new campaign needs "provider": ${PROVIDERS.join(', ')} (the mailbox it goes out from).`);
  }
  if (spec.provider !== undefined && !PROVIDERS.includes(spec.provider)) throw new UsageError(`"provider" must be one of ${PROVIDERS.join(', ')}.`);

  let subject = spec.subject;
  let message = spec.message;
  let template = null;
  if (spec.templateId) {
    template = await call(client, 'GET', `/v2/messagetemplate/${spec.templateId}`);
    if (template.modelName && template.modelName !== 'Email') {
      blockers.push(`Template "${template.messageTemplateName}" is for ${template.modelName}; campaigns use templates with no type or type Email.`);
    }
    // The app copies the template: later edits to the template do not reach the campaign.
    if (message === undefined) {
      const isBlocks = template.design && template.design.format === 'blocks';
      message = `${isBlocks ? blocksMarker(template._id) : ''}${template.content || ''}`;
    }
    if (subject === undefined) subject = template.subject;
  }
  const finalSubject = subject !== undefined ? subject : record && record.subject;
  const finalMessage = message !== undefined ? message : record && record.message;
  if (!finalSubject || !finalMessage) blockers.push('A campaign needs a subject and a message (or a template that has both).');

  const before = ((record && record.contacts) || []).map((c) => String(idOf(c)));
  const fromLists = [];
  const listInfo = [];
  for (const listId of spec.listIds || []) {
    const list = await call(client, 'GET', `/v2/contactlist/${listId}`);
    const ids = (list.contacts || []).map((c) => String(idOf(c)));
    listInfo.push({ id: list._id, name: list.contactListName, contacts: ids.length, updatedAt: list.updatedAt });
    fromLists.push(...ids);
  }
  const remove = new Set((spec.removeContacts || []).map(String));
  const touchesContacts = Boolean(spec.listIds || spec.addContacts || spec.removeContacts);
  const contacts = touchesContacts
    ? [...new Set([...before, ...fromLists, ...(spec.addContacts || []).map(String)])].filter((id) => !remove.has(id))
    : before;
  if (!contacts.length) warnings.push('The campaign has no recipients yet.');

  let variables;
  if (spec.variables !== undefined) {
    if (!spec.variables || typeof spec.variables !== 'object' || Array.isArray(spec.variables)
      || Object.values(spec.variables).some((v) => typeof v !== 'string')) {
      throw new UsageError('"variables" must be an object of text values: {"promo": "NOV-10"}.');
    }
    variables = Object.entries(spec.variables).map(([k, v]) => ({ [k]: v }));
  }
  const variableMap = Object.assign({}, ...((variables || (record && record.variables) || []).map((v) => v)));

  if (spec.scheduledAt !== undefined && spec.scheduledAt !== null) {
    const when = new Date(spec.scheduledAt);
    if (Number.isNaN(when.getTime())) throw new UsageError('"scheduledAt" must be an ISO date with a time zone, e.g. 2026-11-05T14:00:00-05:00.');
    if (when.getTime() <= Date.now()) blockers.push('"scheduledAt" is in the past: launching would send right away.');
    warnings.push('A send date does nothing by itself: the campaign is scheduled only when it is launched with "send --live".');
  }

  const { schemas, profile } = await loadMe(client, cache);
  const s = processTemplate(finalSubject, {});
  const m = processTemplate(finalMessage, {});
  [...s.errors.map((e) => `Subject: ${e}`), ...m.errors.map((e) => `Message: ${e}`)].forEach((e) => blockers.push(`${e} The server refuses to save it.`));
  const lint = lintPaths([...new Set([...s.paths, ...m.paths])], { schemas, variables: variableMap, campaign: record || {} });
  warnings.push(...lint.warnings);
  blockers.push(...lint.blockers);

  const recipients = await analyzeRecipients(client, contacts, { campaignId: record && record._id });
  warnings.push(...recipientWarnings(recipients));
  if (!record) warnings.push(`It will go out from your connected ${spec.provider} mailbox (the campaign creator's); {{me.*}} uses your profile.`);

  const wanted = {
    emailCampaignName: spec.name,
    provider: spec.provider,
    subject,
    message,
    contacts: touchesContacts || !record ? contacts : undefined,
    testContact: spec.testContact,
    variables,
    scheduledAt: spec.scheduledAt,
  };
  const { body, changes } = diff(record ? { ...record, contacts: before } : null, wanted);
  const sample = await renderSample(client, cache, {
    subject: finalSubject,
    message: finalMessage,
    contactId: sampleContact || recipients.sampleContact,
    creatorId: record ? record.createdBy : profile._id,
    variables: variableMap,
    campaign: record,
  });
  return {
    action: record ? 'update' : 'create', object: 'emailcampaign', id: record ? record._id : null, body, changes,
    template: template ? { id: template._id, name: template.messageTemplateName, copied: true } : null,
    lists: listInfo.map(({ updatedAt, ...rest }) => rest), recipients, sample, warnings, blockers,
    sends: 'Nothing. Saving keeps the campaign as a draft (status Paused).',
    version: fingerprint(['campaign', record ? record.updatedAt : null, template ? template.updatedAt : null, listInfo.map((l) => l.updatedAt), body]),
    check: (after) => {
      const problems = [];
      if (after.status !== 'Paused') problems.push(`The campaign status is ${after.status}, not Paused.`);
      if (body.contacts) {
        const saved = (after.contacts || []).map((c) => String(idOf(c)));
        if (saved.length !== contacts.length - recipients.notFound.count) problems.push(`${saved.length} recipients saved, ${contacts.length} sent.`);
      }
      ['emailCampaignName', 'subject', 'message', 'provider'].forEach((k) => {
        if (body[k] !== undefined && after[k] !== body[k]) problems.push(`${k} did not save as sent.`);
      });
      return problems;
    },
  };
}

const PLANNERS = { template: planTemplate, list: planList, campaign: planCampaign };

// ─── Commands: reads ─────────────────────────────────────────────────────────

async function listOrSearch(client, object, term, params) {
  const path = term ? `/v2/${object}/search?${qs({ term, ...params })}` : `/v2/${object}?${qs(params)}`;
  const body = await call(client, 'GET', path);
  return body.data || [];
}

async function cmdTemplates(client, [term], flags) {
  if (flags.whatsapp) {
    const rows = await listOrSearch(client, 'messagetemplate', term, {
      xquery: JSON.stringify({ modelName: 'Message' }),
      select: 'messageTemplateName language category whatsappStatus syncStatus rejectionReason channel updatedAt',
      sort: '-updatedAt', limit: '50',
    });
    return { whatsappTemplates: rows, note: 'Read only: creating or changing a WhatsApp template submits it to WhatsApp for review, so it is done in the app.' };
  }
  const rows = await listOrSearch(client, 'messagetemplate', term, {
    xquery: JSON.stringify({ modelName: { $in: [null, 'Email'] } }),
    select: 'messageTemplateName modelName subject content design.format updatedAt', sort: '-updatedAt', limit: '50',
  });
  return {
    templates: rows.map((t) => ({
      id: t._id, name: t.messageTemplateName, type: t.modelName || 'generic', subject: t.subject || null,
      blocks: Boolean(t.design && t.design.format === 'blocks'),
      variables: processTemplate(`${t.subject || ''} ${t.content || ''}`, {}).paths, updatedAt: t.updatedAt,
    })),
  };
}

async function cmdLists(client, [term]) {
  const rows = await listOrSearch(client, 'contactlist', term, { select: 'contactListName description contacts updatedAt', sort: '-updatedAt', limit: '50' });
  return { lists: rows.map((l) => ({ id: l._id, name: l.contactListName, description: l.description || null, contacts: (l.contacts || []).length, updatedAt: l.updatedAt })) };
}

function campaignSummary(c) {
  return {
    id: c._id, name: c.emailCampaignName, status: c.status, provider: c.provider || null, from: c.from || null,
    recipients: (c.contacts || []).length, type: c.sequence ? 'sequence' : 'single send', consentRequest: Boolean(c.consentRequest),
    testContact: idOf(c.testContact), scheduledAt: c.scheduledAt || null, sentAt: c.sentAt || null, stats: c.stats || {}, updatedAt: c.updatedAt,
  };
}

async function cmdCampaigns(client, [term]) {
  const rows = await listOrSearch(client, 'emailcampaign', term, {
    select: 'emailCampaignName status provider from contacts sequence consentRequest testContact scheduledAt sentAt stats updatedAt',
    sort: '-updatedAt', limit: '50',
  });
  return { campaigns: rows.map(campaignSummary) };
}

async function cmdContacts(client, [term]) {
  if (!term) throw new UsageError('Usage: contacts <domain> <name, e-mail or contact id>');
  const select = 'firstName lastName email emailStatus consent';
  const rows = ID_RE.test(term)
    ? [await call(client, 'GET', `/v2/contact/${term}?${qs({ select })}`)]
    : await listOrSearch(client, 'contact', term, { select, limit: '20' });
  return {
    contacts: rows.map((c) => ({
      id: c._id, name: fullName(c), email: c.email || null,
      emailStatus: (c.emailStatus && c.emailStatus.state) || 'subscribed', consent: (c.consent && c.consent.state) || 'pending',
    })),
  };
}

async function cmdShow(client, [kind, id], flags, ctx) {
  if (!['template', 'list', 'campaign'].includes(kind) || !ID_RE.test(String(id))) {
    throw new UsageError('Usage: show <domain> <template|list|campaign> <id> [--sample <contactId>]');
  }
  if (kind === 'template') {
    const t = await call(client, 'GET', `/v2/messagetemplate/${id}`);
    const { schemas } = await loadMe(client, ctx.cache);
    const paths = processTemplate(`${t.subject || ''} ${t.content || ''}`, {}).paths;
    return {
      template: {
        id: t._id, name: t.messageTemplateName, type: t.modelName || 'generic', subject: t.subject || null,
        blocks: Boolean(t.design && t.design.format === 'blocks'), contentLength: (t.content || '').length,
        whatsappStatus: t.whatsappStatus, updatedAt: t.updatedAt,
      },
      variables: paths,
      warnings: t.modelName === 'Message' ? [] : lintPaths(paths, { schemas }).warnings,
      sample: flags.sample ? await renderSample(client, ctx.cache, { subject: t.subject, message: t.content, contactId: flags.sample }) : null,
    };
  }
  if (kind === 'list') {
    const l = await call(client, 'GET', `/v2/contactlist/${id}`);
    const recipients = await analyzeRecipients(client, (l.contacts || []).map((c) => String(idOf(c))));
    return { list: { id: l._id, name: l.contactListName, description: l.description || null, updatedAt: l.updatedAt }, recipients, warnings: recipientWarnings(recipients) };
  }
  const c = await call(client, 'GET', `/v2/emailcampaign/${id}`);
  let liveStats = null;
  try {
    liveStats = await call(client, 'GET', `/v2/emailcampaign/${id}/stats`);
  } catch (err) {
    liveStats = { unavailable: err.hint || err.message };
  }
  const recipients = await analyzeRecipients(client, (c.contacts || []).map((x) => String(idOf(x))), { campaignId: id });
  // What each recipient's e-mail ended as, with the server's reason for every failure or skip.
  const delivery = { sent: 0, failed: 0, pending: 0, failedReasons: {} };
  (await campaignEmailRows(client, id)).forEach((row) => {
    delivery[row.status] = (delivery[row.status] || 0) + 1;
    if (row.status === 'failed') {
      const reason = String(row.error || 'unknown').slice(0, 120);
      delivery.failedReasons[reason] = (delivery.failedReasons[reason] || 0) + 1;
    }
  });
  const { schemas } = await loadMe(client, ctx.cache);
  const paths = processTemplate(`${c.subject || ''} ${c.message || ''}`, {}).paths;
  const variables = Object.assign({}, ...((c.variables || []).map((v) => v)));
  const lint = lintPaths(paths, { schemas, variables, campaign: c });
  return {
    campaign: { ...campaignSummary(c), subject: c.subject, messageLength: (c.message || '').length },
    variables: paths,
    liveStats,
    delivery,
    recipients,
    warnings: [...lint.blockers, ...lint.warnings, ...recipientWarnings(recipients)],
    sample: flags.sample ? await renderSample(client, ctx.cache, {
      subject: c.subject, message: c.message, contactId: flags.sample, creatorId: c.createdBy, variables, campaign: c,
    }) : null,
  };
}

// ─── Commands: plan and save (never sends) ──────────────────────────────────

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await PLANNERS[plan.kind](client, ctx.cache, plan.spec, flags.sample || plan.sampleContact);
  const { check, body, ...shown } = result;
  return {
    ...shown,
    nextStep: result.blockers.length
      ? 'Blocked: tell the user why in plain words; do not apply.'
      : !Object.keys(body).length ? 'Nothing to change.'
        : 'Show the user what changes and the sample. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run apply with the same plan and --version.',
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const result = await PLANNERS[plan.kind](client, ctx.cache, plan.spec, flags.sample || plan.sampleContact);
  if (result.version !== flags.version) throw new Blocked('Something changed since the preview (the record, the template or a list). Preview again and show the user.');
  if (result.blockers.length) throw new Blocked(result.blockers.join(' '));
  if (!Object.keys(result.body).length) return { saved: true, unchanged: true, id: result.id, problems: [] };
  let saved;
  try {
    saved = result.id
      ? await call(client, 'PATCH', `/v2/${result.object}/${result.id}`, { data: result.body, confirmed: true })
      : await call(client, 'POST', `/v2/${result.object}`, { data: result.body, confirmed: true });
  } catch (err) {
    // Messages come translated; a campaign save that fails is most often the sender's mailbox.
    if (result.object === 'emailcampaign' && err.status === 400 && !err.hint) err.hint = `${hintFor('provider')} (Or: ${err.message.split(': ').slice(1).join(': ')})`;
    throw err;
  }
  const id = result.id || saved._id;
  const after = await call(client, 'GET', `/v2/${result.object}/${id}`);
  const problems = result.check(after);
  return {
    saved: problems.length === 0, action: result.action, object: result.object, id,
    name: after.messageTemplateName || after.contactListName || after.emailCampaignName,
    status: after.status, from: after.from, sent: false, changes: result.changes, problems,
  };
}

// ─── Commands: sending ───────────────────────────────────────────────────────

async function ownContact(client, cache, campaign) {
  const { profile } = await loadMe(client, cache);
  if (!profile.email) return { blocker: 'Your profile has no e-mail address; name a test contact with --test-contact.' };
  const body = await call(client, 'GET', `/v2/contact?${qs({ xquery: JSON.stringify({ email: profile.email.toLowerCase() }), select: 'firstName lastName email emailStatus workspace', limit: '20' })}`);
  let rows = body.data || [];
  if (rows.length > 1 && campaign.workspace) {
    const same = rows.filter((r) => String(idOf(r.workspace)) === String(idOf(campaign.workspace)));
    if (same.length) rows = same;
  }
  if (!rows.length) {
    return { blocker: `No contact has your e-mail (${profile.email}). The test goes to a contact: create one with your e-mail in the app, or name a test contact with --test-contact.` };
  }
  if (rows.length > 1) {
    return { blocker: `Several contacts have your e-mail (${rows.map((r) => r._id).join(', ')}). Ask which one and pass it with --test-contact.` };
  }
  return { contact: rows[0], own: true };
}

async function planSend(client, cache, campaignId, flags) {
  if (!ID_RE.test(String(campaignId))) throw new UsageError('Usage: send-preview <domain> <campaignId> [--live] [--test-contact <id>]');
  const campaign = await call(client, 'GET', `/v2/emailcampaign/${campaignId}`);
  const { profile } = await loadMe(client, cache);
  const blockers = [];
  const warnings = [];
  const live = Boolean(flags.live);
  if (campaign.status !== 'Paused') blockers.push(`The campaign is ${campaign.status}; only a paused draft can be sent or tested.`);
  if (campaign.sequence) blockers.push('This campaign enrolls contacts in a sequence; launch it from the app.');
  if (campaign.consentRequest) blockers.push('This is a consent-request campaign; launch it from the app.');
  if (!campaign.subject || !campaign.message) blockers.push('The campaign has no subject or message.');
  const isOwner = [campaign.createdBy, campaign.assignee, ...(campaign.collaborators || [])].map((x) => String(idOf(x))).includes(String(profile._id));
  if (!isOwner) blockers.push('Only the campaign creator, its assignee or a collaborator can send it (even an admin cannot).');
  const s = processTemplate(campaign.subject, {});
  const m = processTemplate(campaign.message, {});
  if (s.errors.length || m.errors.length) blockers.push(`The template is invalid: ${[...s.errors, ...m.errors].join(' ')}`);
  const variables = Object.assign({}, ...((campaign.variables || []).map((v) => v)));
  const contacts = (campaign.contacts || []).map((c) => String(idOf(c)));
  const from = campaign.from || null;

  if (!live) {
    let test;
    if (flags.testContact) {
      const contact = await call(client, 'GET', `/v2/contact/${flags.testContact}?${qs({ select: 'firstName lastName email emailStatus' })}`);
      test = { contact, own: String(contact.email || '').toLowerCase() === String(profile.email || '').toLowerCase() };
    } else {
      test = await ownContact(client, cache, campaign);
    }
    if (test.blocker) blockers.push(test.blocker);
    const contact = test.contact;
    if (contact) {
      if (!contact.email) blockers.push('The test contact has no e-mail address.');
      if (SUPPRESSED.includes(contact.emailStatus && contact.emailStatus.state)) blockers.push('The test contact unsubscribed, bounced or complained: Prolibu will not e-mail it.');
      const rows = await call(client, 'GET', `/v2/email?${qs({ xquery: JSON.stringify({ emailCampaign: campaignId, contact: String(contact._id) }), select: 'status', limit: '1' })}`);
      if ((rows.pagination && rows.pagination.count) || (rows.data || []).length) {
        blockers.push('This contact already received an e-mail from this campaign; the server allows one per contact per campaign. Choose another test contact.');
      }
      if (!test.own) warnings.push(`The test goes to ${contact.email}, which is not your own address. Confirm the user chose it.`);
      if (contacts.includes(String(contact._id))) warnings.push('The test contact is also a recipient: after the test, the real launch skips them.');
    }
    warnings.push('The test e-mail is counted in the campaign statistics, and a test cannot be repeated to the same contact.');
    const sample = contact && contact.email ? await renderSample(client, cache, {
      subject: campaign.subject, message: campaign.message, contactId: contact._id, creatorId: campaign.createdBy, variables, campaign,
    }) : null;
    const testContactId = contact ? String(contact._id) : null;
    return {
      campaign, live, contacts, testContactId,
      shown: {
        mode: 'test', campaign: { id: campaign._id, name: campaign.emailCampaignName, status: campaign.status },
        sendsTo: contact ? { contactId: testContactId, email: contact.email, ownAddress: Boolean(test.own) } : null,
        emails: contact ? 1 : 0, from, setsTestContact: Boolean(contact && String(idOf(campaign.testContact)) !== testContactId),
        sample, warnings, blockers,
        sendVersion: fingerprint(['test', campaign.updatedAt, testContactId]),
      },
    };
  }

  const recipients = await analyzeRecipients(client, contacts, { campaignId });
  warnings.push(...recipientWarnings(recipients));
  if (!contacts.length) blockers.push('The campaign has no recipients.');
  const when = campaign.scheduledAt && new Date(campaign.scheduledAt).getTime() > Date.now() ? campaign.scheduledAt : null;
  if (campaign.sentAt) {
    warnings.push('This campaign was launched before and paused. Its queued e-mails keep their original time and id for 7 days: '
      + 'a relaunch may send at the old scheduled time, or skip the contacts whose turn came while it was paused. A new campaign is safer.');
  }
  const sample = await renderSample(client, cache, {
    subject: campaign.subject, message: campaign.message, contactId: flags.sample || recipients.sampleContact,
    creatorId: campaign.createdBy, variables, campaign,
  });
  return {
    campaign, live, contacts,
    shown: {
      mode: 'live', campaign: { id: campaign._id, name: campaign.emailCampaignName, status: campaign.status },
      recipients: contacts.length, willReceive: recipients.willReceive, recipientDetail: recipients, from,
      when: when ? `scheduled for ${when} (UTC)` : 'now, about 5 e-mails per second',
      cannotBeUndone: 'E-mails that left cannot be recalled or edited. Pause stops only the ones not sent yet.',
      sample, warnings, blockers,
      sendVersion: fingerprint(['live', campaign.updatedAt, contacts.length, campaign.scheduledAt || null]),
    },
  };
}

async function cmdSendPreview(client, [campaignId], flags, ctx) {
  const { shown } = await planSend(client, ctx.cache, campaignId, flags);
  return {
    ...shown,
    nextStep: shown.blockers.length
      ? 'Blocked: tell the user why; send nothing.'
      : `Tell the user exactly who gets it and that this cannot be undone. Send only after a separate, explicit yes to THIS send${shown.mode === 'live' ? ` that names ${shown.recipients} recipients` : ''}.`,
  };
}

async function cmdSend(client, [campaignId], flags, ctx) {
  if (flags.confirmed && !flags.confirmedSend) {
    throw new UsageError('A send needs --confirmed-send, after its own send-preview and the user\'s separate yes to this send. --confirmed is for saving.');
  }
  if (!flags.confirmedSend) throw new UsageError('Refusing to send without --confirmed-send. Run send-preview, show it, and wait for an explicit yes to send.');
  if (!flags.sendVersion) throw new UsageError('Missing --send-version. Run send-preview first and pass its sendVersion.');
  if (flags.live && flags.recipients === undefined) throw new UsageError('A live send needs --recipients <n>: the number of recipients the user agreed to.');
  if (!flags.live && flags.recipients !== undefined) throw new UsageError('--recipients goes with --live. Without --live, send makes one test e-mail.');
  const planned = await planSend(client, ctx.cache, campaignId, flags);
  const { shown } = planned;
  if (shown.sendVersion !== flags.sendVersion) throw new Blocked('The campaign changed since the send-preview. Preview the send again and ask again.');
  if (shown.blockers.length) throw new Blocked(shown.blockers.join(' '));
  if (flags.live && Number(flags.recipients) !== shown.recipients) {
    throw new UsageError(`--recipients ${flags.recipients} does not match the ${shown.recipients} recipients of the campaign. Nothing was sent.`);
  }

  if (!flags.live) {
    if (shown.setsTestContact) {
      await call(client, 'PATCH', `/v2/emailcampaign/${campaignId}`, { data: { testContact: planned.testContactId }, confirmed: true });
      const after = await call(client, 'GET', `/v2/emailcampaign/${campaignId}`);
      if (String(idOf(after.testContact)) !== planned.testContactId || after.status !== 'Paused') {
        throw new Blocked('Could not set the test contact on the campaign. Nothing was sent.');
      }
    }
    const email = await call(client, 'PUT', '/v2/emailcampaign/sendCampaign', { data: { emailCampaignId: campaignId, testMode: true }, confirmed: true, reachesPeople: true });
    const emailId = idOf(email);
    const row = emailId ? await call(client, 'GET', `/v2/email/${emailId}?${qs({ select: 'status error to' })}`) : {};
    return {
      sent: row.status === 'sent', mode: 'test', emailId, to: row.to || shown.sendsTo.email, status: row.status || null,
      error: row.error || null, problems: row.status === 'sent' ? [] : [`The test e-mail is ${row.status || 'unknown'}${row.error ? `: ${row.error}` : ''}.`],
    };
  }

  await call(client, 'PUT', '/v2/emailcampaign/sendCampaign', { data: { emailCampaignId: campaignId, testMode: false }, confirmed: true, reachesPeople: true });
  const after = await call(client, 'GET', `/v2/emailcampaign/${campaignId}`);
  const launched = ['Sending', 'Scheduled', 'Sent'].includes(after.status);
  return {
    sent: launched, mode: 'live', status: after.status, scheduledAt: after.scheduledAt || null, recipients: shown.recipients,
    problems: launched ? [] : [`The campaign status is ${after.status}${after.error ? `: ${after.error}` : ''}.`],
    nextStep: 'Follow progress with "show <domain> campaign <id>". To stop the e-mails not yet sent: pause.',
  };
}

async function cmdPause(client, [campaignId], flags) {
  if (!ID_RE.test(String(campaignId))) throw new UsageError('Usage: pause <domain> <campaignId> --confirmed');
  if (!flags.confirmed) throw new UsageError('Refusing to pause without --confirmed. Tell the user what pausing stops and wait for a yes.');
  const campaign = await call(client, 'GET', `/v2/emailcampaign/${campaignId}`);
  if (campaign.status === 'Paused') throw new Blocked('The campaign is already paused.');
  if (campaign.status === 'Sent') throw new Blocked('The campaign already finished sending; there is nothing left to pause.');
  await call(client, 'PUT', '/v2/emailcampaign/pauseCampaign', { data: { emailCampaignId: campaignId }, confirmed: true });
  const after = await call(client, 'GET', `/v2/emailcampaign/${campaignId}`);
  return { paused: after.status === 'Paused', status: after.status, stats: after.stats || {}, problems: after.status === 'Paused' ? [] : [`Status is ${after.status}.`] };
}

// ─── Commands: WhatsApp and conversations (read only) ───────────────────────

async function cmdChannels(client) {
  const body = await call(client, 'GET', `/v2/channel?${qs({ select: 'channelName active phoneNumber aiAgentProfile syncStatus', populate: 'phoneNumber', limit: '50' })}`);
  return {
    channels: (body.data || []).map((c) => ({
      id: c._id, name: c.channelName, active: c.active !== false, aiAgentReplies: Boolean(c.aiAgentProfile), syncStatus: c.syncStatus || null,
      numbers: (c.phoneNumber || []).map((p) => (p && typeof p === 'object' ? { number: p.phoneNumber, whatsapp: Boolean(p.whatsapp), sms: Boolean(p.sms), voice: Boolean(p.voice) } : p)),
    })),
  };
}

async function cmdConversations(client, rest, flags) {
  const filter = {};
  if (flags.contact) {
    if (!ID_RE.test(flags.contact)) throw new UsageError('--contact must be a contact id.');
    filter.contact = flags.contact;
  }
  if (flags.channelType) filter.channelType = flags.channelType;
  const body = await call(client, 'GET', `/v2/conversation?${qs({
    xquery: JSON.stringify(filter), select: 'channelType status contact participantName lastInboundAt unreadCount updatedAt',
    populate: 'contact', sort: '-updatedAt', limit: String(Math.min(Number(flags.limit) || 20, 100)),
  })}`);
  const now = Date.now();
  return {
    count: body.pagination ? body.pagination.count : (body.data || []).length,
    conversations: (body.data || []).map((c) => ({
      id: c._id, channelType: c.channelType, status: c.status, contact: c.contact && typeof c.contact === 'object' ? { id: c.contact._id, name: fullName(c.contact) } : idOf(c.contact),
      participantName: c.participantName || null, lastInboundAt: c.lastInboundAt || null, unread: c.unreadCount || 0,
      whatsappWindowOpen: c.channelType === 'whatsapp' ? Boolean(c.lastInboundAt && now - new Date(c.lastInboundAt).getTime() < 24 * 3600 * 1000) : undefined,
      updatedAt: c.updatedAt,
    })),
  };
}

async function cmdMessages(client, [conversationId], flags) {
  if (!ID_RE.test(String(conversationId))) throw new UsageError('Usage: messages <domain> <conversationId> [--limit <n>]');
  const body = await call(client, 'GET', `/v2/message?${qs({
    xquery: JSON.stringify({ conversation: conversationId }),
    select: 'direction channelType contentType body templateName status errorCode errorMessage createdAt',
    sort: '-createdAt', limit: String(Math.min(Number(flags.limit) || 30, 200)),
  })}`);
  return {
    count: body.pagination ? body.pagination.count : (body.data || []).length,
    messages: (body.data || []).reverse().map((m) => ({
      at: m.createdAt, direction: m.direction, type: m.contentType || null, template: m.templateName || undefined,
      body: m.body ? String(m.body).slice(0, 500) : '', status: m.status || null,
      error: m.errorMessage || m.errorCode ? `${m.errorCode || ''} ${m.errorMessage || ''}`.trim() : undefined,
    })),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const VALUE_FLAGS = {
    '--version': 'version', '--send-version': 'sendVersion', '--profile': 'profile', '--sample': 'sample', '--test-contact': 'testContact',
    '--recipients': 'recipients', '--contact': 'contact', '--channel-type': 'channelType', '--limit': 'limit',
  };
  const BOOL_FLAGS = { '--confirmed': 'confirmed', '--confirmed-send': 'confirmedSend', '--live': 'live', '--whatsapp': 'whatsapp' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (BOOL_FLAGS[arg]) flags[BOOL_FLAGS[arg]] = true;
    else if (VALUE_FLAGS[arg]) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[VALUE_FLAGS[arg]] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  for (const key of ['sample', 'testContact']) {
    if (flags[key] !== undefined && !ID_RE.test(flags[key])) throw new UsageError(`--${key === 'sample' ? 'sample' : 'test-contact'} must be a contact id.`);
  }
  if (flags.recipients !== undefined && !/^\d+$/.test(flags.recipients)) throw new UsageError('--recipients must be a whole number.');
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  templates: cmdTemplates,
  lists: cmdLists,
  campaigns: cmdCampaigns,
  contacts: cmdContacts,
  show: cmdShow,
  preview: cmdPreview,
  apply: cmdApply,
  'send-preview': cmdSendPreview,
  send: cmdSend,
  pause: cmdPause,
  channels: cmdChannels,
  conversations: cmdConversations,
  messages: cmdMessages,
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
    if (!handler || !domain) throw new UsageError(`Usage: messaging.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir, cache: {} });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (['apply', 'send', 'pause'].includes(command) && result.problems && result.problems.length) return 1;
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
    if (err && err.hint) stderr.write(`Hint: ${err.hint}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, processTemplate, lintPaths, walkSchema, populateTree, readPlan, analyzeRecipients, HELPERS,
};
