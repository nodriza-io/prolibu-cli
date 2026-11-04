#!/usr/bin/env node
'use strict';

// Support work the way the Prolibu app does it: read the support setup (case types, teams,
// routing rules, mailboxes, pipelines), find and show tickets, create and update tickets, reply
// or add an internal note, write help articles and the portal's article lists.
//
//   support.js setup    <domain>
//   support.js find     <domain> <text or ticket number>
//   support.js show     <domain> <ticket id or number>
//   support.js contacts <domain> <name or email>
//   support.js route    <domain> --subject "<text>" --from <email> [--hub <code or id>]
//   support.js content  <domain> [text]
//   support.js create|update|reply|article|portal <domain> '<plan json>'      preview, writes nothing
//     … the same plus --version <v> --confirmed [--sends-email] [--publish]  write
//
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const crypto = require('crypto');
const fs = require('fs');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const BLOCKED = 3;
const REOPENED_CODE = 'ticket-stage-reopened';
// Never select authorizationHeader: it is a credential and the shared helper does not mask it.
const HUB_SELECT = 'emailHubCode emailHubName caseType adProvider state active routingRules';
const TICKET_SELECT = 'ticketNumber subject description caseType requester channel stage priority assignee '
  + 'collaborators group tags deal dates emailHubCode to ccEmails customerResponded comments notes updatedAt createdAt';
const ARTICLE_SELECT = 'articleCode articleTitle summary status publishAt publishedAt expireAt active language updatedAt';
const ARTICLE_FIELDS = ['articleTitle', 'summary', 'body', 'status', 'publishAt', 'expireAt', 'language', 'tags', 'active'];
const ARTICLE_STATUS = ['draft', 'scheduled', 'published', 'archived'];
const LIVE = ['published', 'scheduled'];
const PORTAL_LIMITS = { articles: 200, slides: 20 };
const UPDATE_FIELDS = ['subject', 'description', 'caseType', 'assignee', 'collaborators', 'deal', 'dueAt', 'tags', 'ccEmails'];
const REFUSED = {
  stage: 'Move stages with the prolibu-stages skill (stages.js move … Ticket).',
  priority: 'Priority is a pipeline: use the prolibu-stages skill with --field priority.',
  comments: 'Use the reply command: the server links comments to the ticket.',
  notes: 'Use the reply command with "as": "note".',
  requester: 'Change the requester in the app; this script does not.',
};
const PLATFORM = ['channel', 'emailHubCode', 'threadId', 'to', 'customerResponded', 'ticketNumber', 'pipelineStages',
  'stageHistory', 'assignedAt', 'assignedBy', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', '_id', 'workspace'];

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

const qs = (o) => new URLSearchParams(o).toString();
const rows = (body) => (body && Array.isArray(body.data) ? body.data : []);
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v == null ? null : String(v));
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const normalize = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const fullName = (p) => (p && typeof p === 'object' ? [p.firstName, p.lastName].filter(Boolean).join(' ') : null);
const plain = (html, n = 200) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The app's editors send HTML. Plain text becomes paragraphs, one per blank-line block.
function toHtml(text) {
  const value = String(text || '').trim();
  if (/<[a-z][\s\S]*>/i.test(value)) return value;
  return value.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// CC the way the composer validates it: split on , ; or spaces, all valid or nothing,
// lowercase, no duplicates. The requester ("to") is never copied on their own thread.
function cleanEmails(list, to) {
  const items = (Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/))
    .map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const bad = items.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) throw new UsageError(`Not valid e-mail addresses: ${bad.join(', ')}.`);
  const requester = String(to || '').toLowerCase();
  return [...new Set(items)].filter((e) => e !== requester);
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim()) throw new UsageError('Give the plan as JSON, in single quotes.');
  if (!text.trim().startsWith('{')) {
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

// ---------- pure rules ----------

function stageNames(stage) {
  const names = [stage.stageName, stage.stageCode];
  if (stage.stageCode) names.push(String(stage.stageCode).split('-').pop());
  for (const tr of Object.values(stage.lang || {})) if (tr && tr.stageName) names.push(tr.stageName);
  return names.filter(Boolean).map(normalize);
}

function resolveStage(text, list, label) {
  const want = normalize(text);
  if (ID_RE.test(String(text))) {
    const found = list.find((s) => String(s._id) === String(text));
    if (!found) throw new UsageError(`${text} is not a ${label} of tickets.`);
    return found;
  }
  const exact = list.filter((s) => stageNames(s).includes(want));
  const partial = exact.length ? exact : list.filter((s) => stageNames(s).some((n) => n.includes(want)));
  if (partial.length === 1) return partial[0];
  const options = (partial.length ? partial : list).map((s) => `${s.stageName} (${s._id})`).join(', ');
  throw new UsageError(`No single ${label} "${text}". Options: ${options || 'none'}.`);
}

function resolveCaseType(text, list) {
  if (ID_RE.test(String(text))) {
    const found = list.find((c) => String(c._id) === String(text));
    if (!found) throw new UsageError(`No case type with _id ${text}.`);
    return found;
  }
  const want = normalize(text);
  const byCode = list.filter((c) => normalize(c.caseTypeCode) === want);
  const exact = byCode.length ? byCode : list.filter((c) => normalize(c.resolutionArea) === want);
  const partial = exact.length ? exact : list.filter((c) => normalize(c.resolutionArea).includes(want));
  if (partial.length === 1) return partial[0];
  const options = (partial.length ? partial : list).map((c) => `${c.resolutionArea} (${c._id})`).join(', ');
  throw new UsageError(`No single case type "${text}". Options: ${options || 'none'}.`);
}

// What a new ticket of this case type does about assignment (TicketNotifications on create).
function teamEffect(team, assigneeGiven) {
  if (!team) return null;
  if (team.unreadable) return `The case type points to the team ${team._id}, which this key cannot read.`;
  if (team.loadBalancing) {
    return assigneeGiven
      ? `The case type's team "${team.name}" rotates assignments, but an assignee is given: the rotation is skipped.`
      : `Assigned automatically to the next active member of "${team.name}" (rotation, ${team.members} member${team.members === 1 ? '' : 's'}).`;
  }
  return `Every member of "${team.name}" (${team.members}) is told the ticket is available; nobody is assigned by it.`;
}

// Mirrors RoutingRule.getMatchingResultByRoutingRuleIds: rules in the server's order (not the
// mailbox's list order), first Subject Matching hit sets the case type, first Domain Matching
// hit sets the group, the mailbox's case type is the fallback.
function routeEmail({ rules, hub, subject, from }) {
  const warnings = [];
  const subj = String(subject || '').toLowerCase();
  const domain = String(from || '').split('@')[1];
  const emailDomain = domain ? domain.toLowerCase() : '';
  let caseRule = null;
  let groupRule = null;
  for (const rule of rules) {
    if (rule.ruleType === 'Subject Matching') {
      const parts = String(rule.pattern || '').split(',').map((p) => p.trim().toLowerCase());
      if (parts.includes('')) warnings.push(`"${rule.routingRuleName}" has an empty keyword (a stray comma): it matches every subject.`);
      if (!caseRule && subj && parts.some((p) => subj.includes(p))) caseRule = rule;
    } else if (rule.ruleType === 'Domain Matching Group') {
      const domains = String(rule.domains || '').split(',').map((d) => d.trim());
      if (domains.some((d) => d.startsWith('@'))) warnings.push(`"${rule.routingRuleName}" lists a domain with "@": it never matches.`);
      if (!groupRule && emailDomain && domains.some((d) => d.toLowerCase() === emailDomain)) groupRule = rule;
    }
  }
  if (!subj) warnings.push('An e-mail without a subject never matches a subject rule.');
  return {
    caseType: caseRule ? idOf(caseRule.caseType) : (hub ? idOf(hub.caseType) : null),
    caseTypeFrom: caseRule ? `rule "${caseRule.routingRuleName}"` : 'the mailbox default',
    group: groupRule ? idOf(groupRule.ticketGroup) : null,
    groupFrom: groupRule ? `rule "${groupRule.routingRuleName}"` : null,
    warnings,
  };
}

function checkArticle(current, set, now = Date.now()) {
  const blockers = [];
  const warnings = [];
  const effects = [];
  for (const key of Object.keys(set)) {
    if (!ARTICLE_FIELDS.includes(key)) throw new UsageError(`"${key}" cannot be set here. Allowed: ${ARTICLE_FIELDS.join(', ')}.`);
  }
  const next = { ...current, ...set };
  if (!current._id && (!next.articleTitle || !next.summary)) blockers.push('A new article needs "articleTitle" and "summary".');
  if (next.summary && String(next.summary).length > 300) blockers.push(`The summary has ${String(next.summary).length} characters; the limit is 300.`);
  if (set.status && !ARTICLE_STATUS.includes(set.status)) throw new UsageError(`status must be one of ${ARTICLE_STATUS.join(', ')}.`);
  const status = next.status || 'draft';
  if (status === 'scheduled') {
    if (!next.publishAt) blockers.push('A scheduled article needs "publishAt".');
    else if (Date.parse(next.publishAt) <= now) warnings.push('publishAt is in the past: the article goes live within a minute.');
  }
  if (next.expireAt && next.publishAt && Date.parse(next.expireAt) <= Date.parse(next.publishAt)) {
    blockers.push('expireAt must be after publishAt.');
  }
  const wasLive = LIVE.includes(current.status);
  const goesLive = LIVE.includes(status) && (!wasLive || set.publishAt !== undefined);
  if (goesLive) {
    effects.push(status === 'published'
      ? 'Published at once: every signed-in user of the account can open it by its link, and every published portal that lists it shows it.'
      : `Scheduled: it goes live on ${next.publishAt} for every signed-in user, and in the portals that list it.`);
  }
  if (wasLive && ['draft', 'archived'].includes(status)) effects.push('It disappears from the portals and its link stops working.');
  if (next.expireAt) effects.push(`It is archived automatically on ${next.expireAt}.`);
  if (set.body !== undefined && /src=["']data:/i.test(String(set.body))) warnings.push('The body has inline images: add images in the app editor instead.');
  if (!current._id) effects.push('The article code becomes a slug of the title plus a timestamp; it never changes afterwards.');
  if (!LIVE.includes(status)) effects.push(`It stays ${status}: only editors see it.`);
  return { blockers, warnings, effects, goesLive };
}

function changePortalList(current, { add = [], remove = [], position = 'end' }, list) {
  const kept = current.map(String).filter((id) => !remove.includes(id));
  const fresh = add.filter((id) => !kept.includes(id));
  const next = position === 'start' ? [...fresh, ...kept] : [...kept, ...fresh];
  const blockers = [];
  if (next.length > PORTAL_LIMITS[list]) blockers.push(`A portal holds at most ${PORTAL_LIMITS[list]} ${list}; this would make ${next.length}.`);
  return { next, added: fresh, removed: current.map(String).filter((id) => remove.includes(id)), blockers };
}

// ---------- loaders ----------

async function loadStages(client) {
  const query = qs({
    xquery: JSON.stringify({ stageType: { $in: ['Ticket.stage', 'Ticket.priority'] } }),
    select: 'stageName stageCode stageType index active endFlowStage lang',
    sort: 'index',
    limit: '200',
  });
  const list = rows(await call(client, 'GET', `/v2/stage?${query}`));
  return {
    stage: list.filter((s) => s.stageType === 'Ticket.stage'),
    priority: list.filter((s) => s.stageType === 'Ticket.priority'),
  };
}

async function loadCaseTypes(client) {
  const query = qs({ select: 'caseTypeCode resolutionArea assignmentGroup', sort: 'resolutionArea', limit: '500' });
  return rows(await call(client, 'GET', `/v2/casetype?${query}`));
}

async function loadTeam(client, id) {
  if (!id) return null;
  const res = await client.request('GET', `/v2/usergroup/${id}?${qs({ select: 'userGroupName userGroupType users enableLoadBalancing' })}`);
  if (!res.ok || !res.body || !res.body._id) return { _id: id, unreadable: true };
  return {
    _id: id,
    name: res.body.userGroupName,
    type: res.body.userGroupType,
    members: (res.body.users || []).length,
    loadBalancing: !!res.body.enableLoadBalancing,
  };
}

// Full ticket settings are admin-only; /v2/user/preferences shows every user a subset.
async function loadPrefs(client) {
  let res = await client.request('GET', '/v2/preference/read');
  if (!res.ok) res = await client.request('GET', '/v2/user/preferences');
  if (!res.ok || !res.body) return null;
  const pref = res.body.preference || res.body;
  const tickets = (((pref || {}).modules || {}).support || {}).tickets;
  return tickets || null;
}

async function loadHubs(client) {
  const res = await client.request('GET', `/v2/emailhub?${qs({ select: HUB_SELECT, sort: 'createdAt', limit: '100' })}`);
  return res.ok ? rows(res.body) : null;
}

async function loadRules(client) {
  const query = qs({ select: 'routingRuleCode routingRuleName ruleType pattern domains caseType ticketGroup', sort: '_id', limit: '500' });
  return rows(await call(client, 'GET', `/v2/routingrule?${query}`));
}

async function loadTicket(client, ref, select = TICKET_SELECT, extra = {}) {
  const text = String(ref || '').trim();
  if (!text) throw new UsageError('Give the ticket _id or number.');
  if (ID_RE.test(text)) {
    const res = await client.request('GET', `/v2/ticket/${text}?${qs({ select, ...extra })}`);
    if (res.status === 404 || (res.ok && !(res.body && res.body._id))) throw new UsageError(`No ticket with _id ${text}.`);
    if (!res.ok) throw new Error(`GET /v2/ticket answered ${res.status}`);
    return res.body;
  }
  const found = rows(await call(client, 'GET', `/v2/ticket?${qs({ ticketNumber: text, select: '_id', limit: '2' })}`));
  if (found.length !== 1) throw new UsageError(`No single ticket numbered ${text}. Use find.`);
  return loadTicket(client, found[0]._id, select, extra);
}

async function loadMe(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || body;
  return { _id: String(p._id), email: p.email, name: fullName(p) };
}

async function resolveUser(client, value, me) {
  if (value === 'me') return { id: (await me())._id, label: 'you' };
  const text = String(value || '').trim();
  if (ID_RE.test(text)) return { id: text, label: text };
  if (EMAIL_RE.test(text)) return { id: text.toLowerCase(), label: text.toLowerCase(), byEmail: true };
  throw new UsageError(`"${value}" is not a user _id, an e-mail or "me".`);
}

async function loadContact(client, ref) {
  const text = String(ref || '').trim();
  if (!ID_RE.test(text) && !EMAIL_RE.test(text)) throw new UsageError(`"${ref}" is not a contact _id or e-mail. Use contacts to find it.`);
  const res = await client.request('GET', `/v2/contact/${encodeURIComponent(text.toLowerCase())}?${qs({ select: 'firstName lastName email company' })}`);
  if (res.status === 404 || (res.ok && !(res.body && res.body._id))) return null;
  if (!res.ok) throw new Error(`GET /v2/contact answered ${res.status}`);
  return res.body;
}

async function companyByDomain(client, email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) return null;
  const query = qs({ xquery: JSON.stringify({ domains: { $in: [domain.toLowerCase().trim()] } }), select: 'companyName', limit: '1' });
  const found = rows(await call(client, 'GET', `/v2/company?${query}`));
  return found[0] || null;
}

async function loadArticle(client, ref) {
  const res = await client.request('GET', `/v2/article/${encodeURIComponent(ref)}?${qs({ select: ARTICLE_SELECT })}`);
  if (res.status === 404 || (res.ok && !(res.body && res.body._id))) throw new UsageError(`No article ${ref}.`);
  if (!res.ok) throw new Error(`GET /v2/article answered ${res.status}`);
  return res.body;
}

async function findArticles(client, refs) {
  const ids = refs.filter((r) => ID_RE.test(r));
  const codes = refs.filter((r) => !ID_RE.test(r));
  const or = [];
  if (ids.length) or.push({ _id: { $in: ids } });
  if (codes.length) or.push({ articleCode: { $in: codes } });
  if (!or.length) return [];
  const query = qs({ xquery: JSON.stringify({ $or: or }), select: 'articleTitle articleCode status active publishAt expireAt', limit: '500' });
  return rows(await call(client, 'GET', `/v2/article?${query}`));
}

function deliverable(article, now = Date.now()) {
  if (!article.active && article.active !== undefined) return false;
  if (article.expireAt && Date.parse(article.expireAt) <= now) return false;
  if (article.status === 'published') return true;
  return article.status === 'scheduled' && article.publishAt && Date.parse(article.publishAt) <= now;
}

// ---------- read commands ----------

async function cmdSetup(client) {
  const [stages, caseTypes, rules, hubs, prefs] = await Promise.all([
    loadStages(client), loadCaseTypes(client), loadRules(client), loadHubs(client), loadPrefs(client),
  ]);
  const teams = {};
  for (const ct of caseTypes) {
    const gid = idOf(ct.assignmentGroup);
    if (gid && !teams[gid]) teams[gid] = await loadTeam(client, gid);
  }
  const ctName = (id) => (caseTypes.find((c) => String(c._id) === String(id)) || {}).resolutionArea || id;
  const usedBy = (ruleId) => (hubs || []).filter((h) => (h.routingRules || []).map(String).includes(String(ruleId))).map((h) => h.emailHubName);
  const notes = [
    'Routing rules only run on e-mail that reaches an active mailbox listing them; tickets created in the app are never routed.',
    'Rules run in the order the server reads them (oldest first), not in the order the mailbox lists them.',
  ];
  if (!prefs) notes.push('Ticket settings need an admin key: unknown here. Assume a reply to a closed ticket reopens it.');
  if (hubs === null) notes.push('This key cannot read the mailboxes.');
  return {
    caseTypes: caseTypes.map((ct) => {
      const team = teams[idOf(ct.assignmentGroup)] || null;
      return { _id: ct._id, code: ct.caseTypeCode, name: ct.resolutionArea, team, onNewTicket: teamEffect(team, false) || 'No automatic assignment.' };
    }),
    mailboxes: (hubs || []).map((h) => ({
      _id: h._id,
      code: h.emailHubCode,
      name: h.emailHubName,
      provider: h.adProvider,
      state: h.state,
      active: h.active !== false,
      defaultCaseType: ctName(idOf(h.caseType)),
      rules: (h.routingRules || []).map((r) => (rules.find((x) => String(x._id) === String(r)) || {}).routingRuleName || String(r)),
    })),
    routingRules: rules.map((r) => ({
      _id: r._id,
      code: r.routingRuleCode,
      name: r.routingRuleName,
      type: r.ruleType,
      match: r.ruleType === 'Subject Matching' ? `subject contains: ${r.pattern}` : `sender domain is: ${r.domains}`,
      result: r.ruleType === 'Subject Matching' ? `case type ${ctName(idOf(r.caseType))}` : `group ${idOf(r.ticketGroup)}`,
      usedBy: usedBy(r._id),
    })),
    pipelines: {
      stage: stages.stage.map((s) => ({ _id: s._id, name: s.stageName, code: s.stageCode, closing: !!s.endFlowStage, active: s.active !== false })),
      priority: stages.priority.map((s) => ({ _id: s._id, name: s.stageName, code: s.stageCode, active: s.active !== false })),
    },
    settings: prefs && {
      caseTypeIsRequired: !!prefs.caseTypeIsRequired,
      reopenTicketsWithComments: prefs.reopenTicketsWithComments !== false,
      surveyOnClosingStage: !!(prefs.customerSatisfaction || {}).sendSurveyOnEndStage,
      autoCloseResolvedAfterHours: (prefs.autoCloseResolvedTickets || {}).enabled ? (prefs.autoCloseResolvedTickets || {}).hoursBeforeClosing : null,
      companyFromEmailDomain: (prefs.companyAutoAssignation || {}).byRequesterCompanyDomains !== false,
    },
    notes,
  };
}

function ticketRow(t, stages) {
  const name = (list, id) => (list.find((s) => String(s._id) === String(idOf(id))) || {}).stageName || null;
  return {
    _id: t._id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    stage: name(stages.stage, t.stage),
    priority: name(stages.priority, t.priority),
    channel: t.channel || 'App',
    updatedAt: t.updatedAt,
  };
}

async function cmdFind(client, words) {
  const text = words.join(' ').trim();
  if (!text) throw new UsageError('Usage: find <domain> <text or ticket number>');
  const stages = await loadStages(client);
  const select = 'ticketNumber subject stage priority channel updatedAt';
  const byNumber = rows(await call(client, 'GET', `/v2/ticket?${qs({ ticketNumber: text, select, limit: '5' })}`));
  const res = await client.request('GET', `/v2/ticket/search?${qs({ term: text, select, limit: '20' })}`);
  const found = [...byNumber, ...(res.ok ? rows(res.body) : [])];
  const seen = new Set();
  const tickets = found.filter((t) => !seen.has(String(t._id)) && seen.add(String(t._id))).map((t) => ticketRow(t, stages));
  return { count: tickets.length, tickets };
}

async function cmdShow(client, [ref]) {
  const populatePath = JSON.stringify([
    { path: 'caseType', select: 'resolutionArea caseTypeCode assignmentGroup' },
    { path: 'requester.contact', select: 'firstName lastName email' },
    { path: 'requester.company', select: 'companyName' },
    { path: 'assignee', select: 'firstName lastName' },
    { path: 'deal', select: 'dealName' },
    {
      path: 'comments',
      select: 'contentText createdAt createdBy commentByContact ccRecipients generatedByTicketSubmit',
      populate: [{ path: 'createdBy', select: 'firstName lastName' }, { path: 'commentByContact', select: 'firstName lastName email' }],
    },
    { path: 'notes', select: 'contentText createdAt createdBy', populate: [{ path: 'createdBy', select: 'firstName lastName' }] },
  ]);
  const [t, stages] = await Promise.all([loadTicket(client, ref, TICKET_SELECT, { populatePath }), loadStages(client)]);
  const stage = stages.stage.find((s) => String(s._id) === String(idOf(t.stage)));
  const hubId = idOf(t.emailHubCode);
  let mailbox = null;
  if (hubId) {
    const res = await client.request('GET', `/v2/emailhub/${hubId}?${qs({ select: HUB_SELECT })}`);
    mailbox = res.ok && res.body ? { name: res.body.emailHubName, active: res.body.active !== false, state: res.body.state } : { unreadable: true };
  }
  const isEmail = t.channel === 'Email';
  const thread = [
    ...(t.comments || []).map((c) => ({
      kind: c.generatedByTicketSubmit || c.commentByContact ? 'customer e-mail' : (isEmail ? 'reply (e-mailed)' : 'comment'),
      by: fullName(c.commentByContact) || fullName(c.createdBy),
      at: c.createdAt,
      cc: c.ccRecipients && c.ccRecipients.length ? c.ccRecipients : undefined,
      text: plain(c.contentText),
    })),
    ...(t.notes || []).map((n) => ({ kind: 'internal note', by: fullName(n.createdBy), at: n.createdAt, text: plain(n.contentText) })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const contact = t.requester && t.requester.contact;
  return {
    ticket: {
      _id: t._id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      description: plain(t.description, 500),
      channel: t.channel || 'App',
      stage: stage ? { _id: stage._id, name: stage.stageName, closing: !!stage.endFlowStage } : null,
      priority: (stages.priority.find((s) => String(s._id) === String(idOf(t.priority))) || {}).stageName || null,
      caseType: t.caseType ? t.caseType.resolutionArea || idOf(t.caseType) : null,
      requester: contact ? { contact: fullName(contact), email: contact.email } : { user: idOf(t.requester && t.requester.user) },
      company: t.requester && t.requester.company ? t.requester.company.companyName || idOf(t.requester.company) : null,
      assignee: fullName(t.assignee) || idOf(t.assignee),
      collaborators: (t.collaborators || []).length,
      deal: t.deal ? t.deal.dealName || idOf(t.deal) : null,
      dueAt: (t.dates || {}).dueAt || null,
      waitingOnUs: !!t.customerResponded,
    },
    email: isEmail ? { to: t.to, cc: t.ccEmails || [], mailbox } : null,
    replyWould: isEmail
      ? `E-mail ${t.to}${(t.ccEmails || []).length ? ` with CC ${t.ccEmails.join(', ')}` : ''} from the support mailbox. An internal note e-mails nobody.`
      : 'Stay inside Prolibu: nobody gets an e-mail. The assignee and the creator are notified in the app.',
    thread,
    version: t.updatedAt,
  };
}

async function cmdContacts(client, words) {
  const term = words.join(' ').trim();
  if (!term) throw new UsageError('Usage: contacts <domain> <name or email>');
  const res = await client.request('GET', `/v2/contact/search?${qs({ term, select: 'firstName lastName email company', limit: '10' })}`);
  const list = res.ok ? rows(res.body) : [];
  return { count: list.length, contacts: list.map((c) => ({ _id: c._id, name: fullName(c), email: c.email, company: idOf(c.company) })) };
}

async function cmdRoute(client, _rest, flags) {
  if (!flags.subject && !flags.from) throw new UsageError('Usage: route <domain> --subject "<text>" --from <email> [--hub <code or id>]');
  const [hubs, rules, caseTypes] = await Promise.all([loadHubs(client), loadRules(client), loadCaseTypes(client)]);
  if (!hubs || !hubs.length) throw new Blocked('No mailbox is readable on this account: e-mail does not become tickets here.');
  let hub = hubs[0];
  if (flags.hub) hub = hubs.find((h) => [String(h._id), h.emailHubCode].includes(flags.hub));
  else if (hubs.length > 1) throw new UsageError(`Several mailboxes: pass --hub with one of ${hubs.map((h) => `${h.emailHubCode} (${h.emailHubName})`).join(', ')}.`);
  if (!hub) throw new UsageError(`No mailbox ${flags.hub}.`);
  const ids = (hub.routingRules || []).map(String);
  const hubRules = rules.filter((r) => ids.includes(String(r._id)));
  const result = routeEmail({ rules: hubRules, hub, subject: flags.subject, from: flags.from });
  const ctName = (id) => (caseTypes.find((c) => String(c._id) === String(id)) || {}).resolutionArea || id;
  if (hub.active === false) result.warnings.push('This mailbox is inactive: incoming e-mail creates nothing.');
  return {
    mailbox: hub.emailHubName,
    caseType: ctName(result.caseType),
    caseTypeFrom: result.caseTypeFrom,
    group: result.group,
    groupFrom: result.groupFrom,
    rulesChecked: hubRules.map((r) => r.routingRuleName),
    warnings: result.warnings,
    note: 'A reply on an existing e-mail thread adds a comment to its ticket; routing only runs for new threads.',
  };
}

async function cmdContent(client, words) {
  const term = words.join(' ').trim();
  const portals = rows(await call(client, 'GET', `/v2/portal?${qs({ select: 'portalCode portalName status active audience articles slides menu', limit: '50' })}`));
  const select = 'articleCode articleTitle status active publishAt expireAt';
  const articles = term
    ? rows((await client.request('GET', `/v2/article/search?${qs({ term, select, limit: '20' })}`)).body)
    : rows(await call(client, 'GET', `/v2/article?${qs({ select, sort: '-updatedAt', limit: '30' })}`));
  return {
    portals: portals.map((p) => ({
      _id: p._id,
      code: p.portalCode,
      name: p.portalName,
      status: p.status,
      active: p.active !== false,
      audience: (p.audience || {}).scope === 'businessUnits' ? `workspaces: ${(p.audience.businessUnits || []).length}` : 'everyone',
      roles: ((p.audience || {}).roles || []).length || 'all',
      articles: (p.articles || []).length,
      slides: (p.slides || []).length,
      menuItems: (p.menu || []).length,
    })),
    articles: articles.map((a) => ({
      _id: a._id, code: a.articleCode, title: a.articleTitle, status: a.status, live: deliverable(a), publishAt: a.publishAt || null,
    })),
    notes: portals.length ? [] : ['This account has no portal yet: an admin creates it in the app.'],
  };
}

// ---------- write commands (preview without --confirmed) ----------

function makeMe(client) {
  let cached;
  return async () => {
    if (!cached) cached = await loadMe(client);
    return cached;
  };
}

async function planCreate(client, plan, me) {
  const blockers = [];
  const warnings = [];
  const effects = [];
  const subject = String(plan.subject || '').trim();
  if (!subject) throw new UsageError('The plan needs "subject".');
  if (subject.length > 250) throw new UsageError('The subject is longer than 250 characters.');
  if (!String(plan.description || '').trim()) throw new UsageError('The plan needs "description".');
  for (const key of Object.keys(plan)) {
    if (!['subject', 'description', 'requester', 'caseType', 'stage', 'priority', 'assignee', 'collaborators', 'deal', 'dueAt', 'tags'].includes(key)) {
      throw new UsageError(`"${key}" cannot be set on create here.`);
    }
  }
  const [stages, caseTypes, prefs] = await Promise.all([loadStages(client), loadCaseTypes(client), loadPrefs(client)]);
  const body = { subject, description: toHtml(plan.description) };
  const summary = { subject };

  const req = typeof plan.requester === 'string' ? { contact: plan.requester } : (plan.requester || {});
  if (!req.contact === !req.user) throw new UsageError('The plan needs "requester": a contact (_id or e-mail), or {"user": "me" | <_id> | <e-mail>}.');
  let requesterEmail = null;
  let contact = null;
  if (req.contact) {
    contact = await loadContact(client, req.contact);
    if (!contact) blockers.push(`No contact ${req.contact}. Find one with contacts, or create the contact first.`);
    else {
      body.requester = { contact: String(contact._id) };
      requesterEmail = contact.email;
      summary.requester = `${fullName(contact)} <${contact.email}>`;
    }
  } else {
    const user = await resolveUser(client, req.user, me);
    body.requester = { user: user.id };
    summary.requester = `user ${user.label}`;
    if (user.byEmail) warnings.push('The requester user is given by e-mail; the read-back confirms the server found it.');
  }

  let team = null;
  if (plan.caseType) {
    const ct = resolveCaseType(plan.caseType, caseTypes);
    body.caseType = String(ct._id);
    summary.caseType = ct.resolutionArea;
    team = await loadTeam(client, idOf(ct.assignmentGroup));
  } else if (prefs && prefs.caseTypeIsRequired) {
    warnings.push('The account says a case type is required (only a setting: the server and the app do not enforce it). Ask which one.');
  }

  const openStages = stages.stage.filter((s) => s.active !== false);
  const stage = plan.stage ? resolveStage(plan.stage, openStages, 'stage') : openStages.find((s) => !s.endFlowStage);
  if (stage) {
    if (stage.endFlowStage) blockers.push(`"${stage.stageName}" is a closing stage. Create the ticket open, then move it with prolibu-stages.`);
    body.stage = String(stage._id);
    summary.stage = stage.stageName;
  }
  if (plan.priority) {
    const pr = resolveStage(plan.priority, stages.priority.filter((s) => s.active !== false), 'priority');
    body.priority = String(pr._id);
    summary.priority = pr.stageName;
  }
  if (plan.assignee) {
    const user = await resolveUser(client, plan.assignee, me);
    body.assignee = user.id;
    summary.assignee = user.label;
    effects.push(`${user.label === 'you' ? 'You are' : `${user.label} is`} notified as the assignee (not when you assign yourself).`);
  }
  const teamText = teamEffect(team, !!plan.assignee);
  if (teamText) (team && team.loadBalancing && plan.assignee ? warnings : effects).push(teamText);
  if (!plan.assignee && !(team && team.loadBalancing)) warnings.push('Nobody will be assigned. The app assigns the creator by default: ask who handles it.');
  if (plan.collaborators) {
    body.collaborators = [];
    for (const c of [].concat(plan.collaborators)) body.collaborators.push((await resolveUser(client, c, me)).id);
  }
  if (plan.deal) {
    if (!ID_RE.test(String(plan.deal))) throw new UsageError('"deal" must be the deal _id.');
    body.deal = String(plan.deal);
  }
  if (plan.tags) body.tags = [].concat(plan.tags).map(String);
  if (plan.dueAt) {
    if (Number.isNaN(Date.parse(plan.dueAt))) throw new UsageError('"dueAt" must be an ISO date-time.');
    body.dates = { dueAt: new Date(plan.dueAt).toISOString() };
  }

  if (contact && contact.company) effects.push('The ticket takes the contact\'s company.');
  else if (requesterEmail && (!prefs || (prefs.companyAutoAssignation || {}).byRequesterCompanyDomains !== false)) {
    const company = await companyByDomain(client, requesterEmail);
    if (company) effects.push(`The ticket takes the company "${company.companyName}" from the e-mail domain.`);
  }
  effects.push('No e-mail goes to the requester: a ticket created here is an App ticket.');
  return { body, summary, blockers, warnings, effects, version: hash({ body, team, prefs }) };
}

async function cmdCreate(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const me = makeMe(client);
  const p = await planCreate(client, plan, me);
  if (!flags.confirmed) return preview(p, 'create');
  guard(flags, p);
  const created = await call(client, 'POST', '/v2/ticket', { data: p.body, confirmed: true });
  const after = await loadTicket(client, created._id);
  const problems = [];
  for (const key of ['subject', 'caseType', 'stage', 'priority']) {
    if (p.body[key] !== undefined && String(idOf(after[key])) !== String(p.body[key])) problems.push(`${key} did not save as sent.`);
  }
  const reqKey = Object.keys(p.body.requester)[0];
  if (!idOf(after.requester && after.requester[reqKey])) problems.push('The requester did not save.');
  if (p.body.assignee && !ID_RE.test(String(idOf(after.assignee) || ''))) problems.push('The assignee was not found.');
  return {
    saved: problems.length === 0,
    _id: after._id,
    ticketNumber: after.ticketNumber,
    assignee: idOf(after.assignee),
    company: idOf(after.requester && after.requester.company),
    version: after.updatedAt,
    problems,
  };
}

async function planUpdate(client, plan, me) {
  const set = plan.set || {};
  if (!plan.ticket || !Object.keys(set).length) throw new UsageError('The plan needs "ticket" and "set".');
  for (const key of Object.keys(set)) {
    if (REFUSED[key]) throw new UsageError(REFUSED[key]);
    if (PLATFORM.includes(key)) throw new UsageError(`"${key}" is set by the platform or the mailbox.`);
    if (!UPDATE_FIELDS.includes(key)) throw new UsageError(`"${key}" cannot be changed here. Allowed: ${UPDATE_FIELDS.join(', ')}.`);
  }
  const t = await loadTicket(client, plan.ticket);
  const body = {};
  const changes = [];
  const warnings = [];
  const effects = [];
  const put = (field, value, before) => {
    if (same(value, before)) return;
    body[field] = value;
    changes.push({ field, before: before === undefined ? null : before, after: value });
  };
  if (set.subject !== undefined) {
    if (!String(set.subject).trim() || String(set.subject).length > 250) throw new UsageError('The subject must have 1 to 250 characters.');
    put('subject', String(set.subject).trim(), t.subject);
    if (t.channel === 'Email') warnings.push('The e-mail thread keeps its original subject; the app hides the subject of e-mail tickets.');
  }
  if (set.description !== undefined) put('description', toHtml(set.description), t.description);
  if (set.caseType !== undefined) {
    const ct = set.caseType ? resolveCaseType(set.caseType, await loadCaseTypes(client)) : null;
    put('caseType', ct ? String(ct._id) : null, idOf(t.caseType));
    effects.push('Changing the case type does not run its team assignment again: assign by hand if needed.');
  }
  if (set.assignee !== undefined) {
    const user = set.assignee ? await resolveUser(client, set.assignee, me) : null;
    put('assignee', user ? user.id : null, idOf(t.assignee));
    if (user) effects.push(`${user.label} is notified as the new assignee (not when you assign yourself).`);
  }
  if (set.collaborators !== undefined) {
    const ids = [];
    for (const c of [].concat(set.collaborators || [])) ids.push((await resolveUser(client, c, me)).id);
    put('collaborators', ids, (t.collaborators || []).map(String));
    effects.push('The list replaces the current collaborators: include everyone who stays.');
  }
  if (set.deal !== undefined) {
    if (set.deal && !ID_RE.test(String(set.deal))) throw new UsageError('"deal" must be the deal _id or null.');
    put('deal', set.deal || null, idOf(t.deal));
  }
  if (set.tags !== undefined) put('tags', [].concat(set.tags || []).map(String), (t.tags || []).map(String));
  if (set.dueAt !== undefined) {
    if (set.dueAt && Number.isNaN(Date.parse(set.dueAt))) throw new UsageError('"dueAt" must be an ISO date-time or null.');
    const value = set.dueAt ? new Date(set.dueAt).toISOString() : null;
    if (value !== ((t.dates || {}).dueAt || null)) {
      body.dates = { dueAt: value };
      changes.push({ field: 'dueAt', before: (t.dates || {}).dueAt || null, after: value });
    }
  }
  if (set.ccEmails !== undefined) {
    if (t.channel !== 'Email') throw new UsageError('Only e-mail tickets have a CC.');
    put('ccEmails', cleanEmails(set.ccEmails, t.to), t.ccEmails || []);
    effects.push('Nothing is sent now. The next reply copies this list; a customer e-mail on the thread replaces it with that e-mail\'s CC.');
  }
  return { ticket: t, body, changes, warnings, effects, blockers: [], version: t.updatedAt };
}

async function cmdUpdate(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planUpdate(client, plan, makeMe(client));
  if (!flags.confirmed) return preview(p, 'update');
  guard(flags, p);
  if (!Object.keys(p.body).length) return { saved: true, unchanged: true, problems: [] };
  await call(client, 'PATCH', `/v2/ticket/${p.ticket._id}`, { data: p.body, confirmed: true });
  const after = await loadTicket(client, p.ticket._id);
  const problems = [];
  for (const c of p.changes) {
    const value = c.field === 'dueAt' ? (after.dates || {}).dueAt || null : after[c.field];
    const norm = (v) => (Array.isArray(v) ? v.map(idOf) : idOf(v));
    if (c.field === 'assignee' && c.after && !ID_RE.test(c.after)) {
      if (!ID_RE.test(String(idOf(value) || ''))) problems.push('The assignee e-mail matched no user.');
    } else if (c.field === 'dueAt' ? (value ? new Date(value).toISOString() : null) !== c.after : !same(norm(value), norm(c.after))) {
      problems.push(`${c.field} did not save as sent.`);
    }
  }
  return { saved: problems.length === 0, changes: p.changes, version: after.updatedAt, problems };
}

async function planReply(client, plan) {
  if (!plan.ticket) throw new UsageError('The plan needs "ticket".');
  if (!String(plan.content || '').trim()) throw new UsageError('The plan needs "content".');
  const as = plan.as || 'reply';
  if (!['reply', 'note'].includes(as)) throw new UsageError('"as" is "reply" or "note".');
  const [t, stages, prefs] = await Promise.all([loadTicket(client, plan.ticket), loadStages(client), loadPrefs(client)]);
  const stage = stages.stage.find((s) => String(s._id) === String(idOf(t.stage)));
  const isEmail = t.channel === 'Email';
  const body = { content: toHtml(plan.content), origin: { modelName: 'Ticket', docId: String(t._id) } };
  const blockers = [];
  const warnings = [];
  const effects = [];
  const requires = [];
  let cc = null;
  if (plan.cc !== undefined && (as === 'note' || !isEmail)) throw new UsageError('Only a reply on an e-mail ticket has a CC.');
  if (as === 'note') {
    effects.push('Internal note: it stays inside Prolibu and e-mails nobody. Mentioned users are notified.');
  } else if (isEmail) {
    cc = plan.cc !== undefined ? cleanEmails(plan.cc, t.to) : cleanEmails(t.ccEmails || [], t.to);
    // Always the exact list the preview shows, even []: never let the server fall back to another CC.
    body.ccRecipients = cc;
    const hubId = idOf(t.emailHubCode);
    const res = hubId ? await client.request('GET', `/v2/emailhub/${hubId}?${qs({ select: HUB_SELECT })}`) : { ok: false, status: 404 };
    if (res.status === 404) blockers.push('The ticket\'s mailbox no longer exists: the server refuses the reply. Add an internal note instead.');
    else if (res.ok && (res.body.active === false || res.body.state !== 'Connected')) {
      warnings.push(`The mailbox "${res.body.emailHubName}" is ${res.body.active === false ? 'inactive' : res.body.state}: the e-mail may fail after the reply is saved.`);
    }
    requires.push('--sends-email');
    effects.push(`Sends an e-mail now to ${t.to}${cc.length ? ` with CC ${cc.join(', ')}` : ' (no CC)'}, from the support mailbox, in the same thread.`);
    effects.push('The ticket stops showing as waiting on you (customerResponded becomes false).');
    if (!same(cc, cleanEmails(t.ccEmails || [], t.to))) effects.push('The ticket CC is updated to this list, as the app does.');
  } else {
    effects.push('Comment on an App ticket: nobody gets an e-mail. The assignee and the creator are notified in the app.');
  }
  if (as === 'reply' && stage && stage.endFlowStage) {
    const reopens = !prefs || prefs.reopenTicketsWithComments !== false;
    if (reopens) effects.push(`The ticket is "${stage.stageName}": this reply moves it back to "Reopened"${prefs ? '' : ' (if the account keeps the default setting)'}.`);
  }
  return { ticket: t, as, isEmail, cc, body, blockers, warnings, effects, requires, version: t.updatedAt };
}

async function cmdReply(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planReply(client, plan);
  if (!flags.confirmed) return preview(p, 'reply');
  guard(flags, p);
  const path = p.as === 'note' ? '/v2/note' : '/v2/comment';
  const created = await call(client, 'POST', path, { data: p.body, confirmed: true });
  const problems = [];
  if (p.isEmail && p.as === 'reply' && !same(p.cc, cleanEmails(p.ticket.ccEmails || [], p.ticket.to))) {
    try {
      await call(client, 'PATCH', `/v2/ticket/${p.ticket._id}`, { data: { ccEmails: p.cc }, confirmed: true });
    } catch (err) {
      problems.push(`The reply was saved and sent, but the ticket CC was not updated: ${err.message}`);
    }
  }
  const after = await loadTicket(client, p.ticket._id, 'comments notes stage ccEmails customerResponded updatedAt');
  const list = p.as === 'note' ? after.notes : after.comments;
  if (!(list || []).map(String).includes(String(created._id))) problems.push(`The ${p.as} was created (${created._id}) but is not linked to the ticket.`);
  const stages = await loadStages(client);
  const name = (id) => (stages.stage.find((s) => String(s._id) === String(idOf(id))) || {}).stageName || null;
  const reopenedId = String((stages.stage.find((s) => s.stageCode === REOPENED_CODE) || {})._id);
  return {
    saved: problems.length === 0,
    [p.as === 'note' ? 'noteId' : 'commentId']: created._id,
    emailed: p.isEmail && p.as === 'reply',
    stageBefore: name(p.ticket.stage),
    stageAfter: name(after.stage),
    reopened: String(idOf(after.stage)) === reopenedId && String(idOf(p.ticket.stage)) !== reopenedId,
    version: after.updatedAt,
    problems,
  };
}

async function planArticle(client, plan) {
  const set = { ...(plan.set || {}) };
  if (!Object.keys(set).length) throw new UsageError('The plan needs "set".');
  const current = plan.article ? await loadArticle(client, plan.article) : {};
  if (set.body !== undefined) set.body = toHtml(set.body);
  const check = checkArticle(current, set);
  const body = {};
  const changes = [];
  for (const [key, value] of Object.entries(set)) {
    if (key !== 'body' && same(current[key], value)) continue;
    body[key] = value;
    changes.push({ field: key, before: key === 'body' ? '(not shown)' : current[key] ?? null, after: key === 'body' ? plain(value, 120) : value });
  }
  const requires = check.goesLive ? ['--publish'] : [];
  if (current._id) {
    const listed = rows(await call(client, 'GET', `/v2/portal?${qs({
      xquery: JSON.stringify({ $or: [{ articles: current._id }, { slides: current._id }] }), select: 'portalName status', limit: '50',
    })}`));
    if (listed.length) check.effects.push(`Listed in: ${listed.map((p) => `${p.portalName} (${p.status})`).join(', ')}.`);
    else if (check.goesLive) check.warnings.push('No portal lists it yet: add it with the portal command to show it there.');
  }
  return { article: current, body, changes, requires, ...check, version: current._id ? current.updatedAt : hash(body) };
}

async function cmdArticle(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planArticle(client, plan);
  if (!flags.confirmed) return preview(p, 'article');
  guard(flags, p);
  if (!Object.keys(p.body).length) return { saved: true, unchanged: true, problems: [] };
  const saved = p.article._id
    ? await call(client, 'PATCH', `/v2/article/${p.article._id}`, { data: p.body, confirmed: true })
    : await call(client, 'POST', '/v2/article', { data: p.body, confirmed: true });
  const after = await loadArticle(client, saved._id);
  const problems = [];
  for (const key of Object.keys(p.body)) {
    if (['body', 'tags', 'publishAt', 'expireAt'].includes(key)) continue;
    if (!same(after[key], p.body[key])) problems.push(`${key} did not save as sent.`);
  }
  const feed = await client.request('GET', `/v2/article/feed/${encodeURIComponent(after.articleCode)}`);
  return {
    saved: problems.length === 0,
    _id: after._id,
    articleCode: after.articleCode,
    status: after.status,
    publishedAt: after.publishedAt || null,
    liveNow: feed.ok,
    version: after.updatedAt,
    problems,
  };
}

async function planPortal(client, plan) {
  const list = plan.list || 'articles';
  if (!PORTAL_LIMITS[list]) throw new UsageError('"list" is "articles" (the news stream) or "slides" (the carousel).');
  if (!plan.portal) throw new UsageError('The plan needs "portal" (_id or code).');
  const add = [].concat(plan.add || []).map(String);
  const remove = [].concat(plan.remove || []).map(String);
  if (!add.length && !remove.length) throw new UsageError('The plan changes nothing: add "add" or "remove".');
  const res = await client.request('GET', `/v2/portal/${encodeURIComponent(plan.portal)}?${qs({ select: 'portalCode portalName status active audience articles slides updatedAt' })}`);
  if (res.status === 404 || (res.ok && !(res.body && res.body._id))) throw new UsageError(`No portal ${plan.portal}.`);
  if (!res.ok) throw new Error(`GET /v2/portal answered ${res.status}`);
  const portal = res.body;
  const found = await findArticles(client, [...add, ...remove]);
  const byRef = (ref) => found.find((a) => String(a._id) === ref || a.articleCode === ref);
  const blockers = [];
  const warnings = [];
  const toId = (ref) => {
    const a = byRef(ref);
    if (!a) blockers.push(`No article ${ref}.`);
    return a ? String(a._id) : ref;
  };
  const addIds = add.map(toId);
  const removeIds = remove.map(toId);
  for (const ref of add) {
    const a = byRef(ref);
    if (a && !deliverable(a)) warnings.push(`"${a.articleTitle}" is ${a.status}: it will not show until it is published.`);
  }
  const change = changePortalList(portal[list] || [], { add: addIds, remove: removeIds, position: plan.position }, list);
  blockers.push(...change.blockers);
  const live = portal.status === 'published' && portal.active !== false;
  const effects = [live
    ? `The portal is published: everyone it reaches (${(portal.audience || {}).scope === 'businessUnits' ? 'selected workspaces' : 'all users'}) sees the change at once.`
    : `The portal is ${portal.status}: nobody sees it yet.`];
  return {
    portal, list, next: change.next, added: change.added, removed: change.removed,
    blockers, warnings, effects, requires: live ? ['--publish'] : [], version: portal.updatedAt,
  };
}

async function cmdPortal(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const p = await planPortal(client, plan);
  if (!flags.confirmed) return preview(p, 'portal');
  guard(flags, p);
  await call(client, 'PATCH', `/v2/portal/${p.portal._id}`, { data: { [p.list]: p.next }, confirmed: true });
  const after = (await client.request('GET', `/v2/portal/${p.portal._id}?${qs({ select: `${p.list} updatedAt` })}`)).body || {};
  const problems = same((after[p.list] || []).map(String), p.next) ? [] : [`The ${p.list} list did not save as sent.`];
  return { saved: problems.length === 0, [p.list]: after[p.list], version: after.updatedAt, problems };
}

// ---------- preview / guard ----------

function preview(p, command) {
  const out = {
    command,
    summary: p.summary,
    changes: p.changes,
    effects: p.effects,
    warnings: p.warnings,
    blockers: p.blockers,
    requires: p.requires && p.requires.length ? p.requires : undefined,
    version: p.version,
  };
  if (command === 'portal') Object.assign(out, { list: p.list, added: p.added, removed: p.removed, result: p.next });
  if (command === 'reply') Object.assign(out, { as: p.as, content: plain(p.body.content, 300) });
  out.nextStep = p.blockers.length
    ? 'Blocked: tell the user why; do not write.'
    : `Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run the same command with --version ${p.version} --confirmed${(p.requires || []).map((r) => ` ${r}`).join('')}.`;
  return out;
}

function guard(flags, p) {
  if (!flags.version) throw new UsageError('Missing --version. Run the preview first and pass its version.');
  if (p.version !== flags.version) throw new Blocked('Something changed since the preview. Preview again and show the user.');
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  for (const flag of p.requires || []) {
    const key = flag === '--sends-email' ? 'sendsEmail' : 'publish';
    if (!flags[key]) throw new Blocked(`This write needs ${flag}: it reaches people. Add it only after the user agreed to that effect.`);
  }
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
    else if (arg === '--sends-email') flags.sendsEmail = true;
    else if (arg === '--publish') flags.publish = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--subject') flags.subject = next();
    else if (arg === '--from') flags.from = next();
    else if (arg === '--hub') flags.hub = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  setup: cmdSetup,
  find: cmdFind,
  show: cmdShow,
  contacts: cmdContacts,
  route: cmdRoute,
  content: cmdContent,
  create: cmdCreate,
  update: cmdUpdate,
  reply: cmdReply,
  article: cmdArticle,
  portal: cmdPortal,
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
    if (!handler || !domain) throw new UsageError(`Usage: support.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    if (flags.confirmed && !['create', 'update', 'reply', 'article', 'portal'].includes(command)) {
      throw new UsageError(`${command} only reads; --confirmed does nothing here.`);
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (flags.confirmed && result.saved === false) return 1;
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
  main, toHtml, cleanEmails, resolveStage, resolveCaseType, teamEffect, routeEmail, checkArticle, changePortalList, deliverable,
};
