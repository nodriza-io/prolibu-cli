#!/usr/bin/env node
'use strict';

// Ad leads (Meta Lead Ads and similar) the way the Prolibu app handles them: the connected ad
// accounts (AdHub), the mirrored lead forms (AdHubForm + Form type meta), the ads (AdCampaign),
// who receives each lead, campaign attribution and the stage → event reports sent to Meta.
//
//   ads.js hubs      <domain>                                    connected ad accounts, pages, forms, last lead
//   ads.js forms     <domain> [--hub <code|id>] [--page <pageId>] mirrored lead forms and their routing
//   ads.js campaigns <domain> [--search <text>] [--with-group] [--limit <n>]
//   ads.js group     <domain> <group name | code | id>           members, active, load balancing, next in turn
//   ads.js report    <domain> --from YYYY-MM-DD --to YYYY-MM-DD [--by campaign|ad|adset|form|page|source|account]
//                             [--tz <IANA zone>] [--page <pageId>] [--form <formId>] [--campaign <Meta campaign id|name>]
//   ads.js diagnose  <domain> <contact e-mail | id>              why an ad lead landed where it did
//   ads.js preview   <domain> '<plan>'                           writes nothing; returns a version
//   ads.js apply     <domain> '<plan>' --version <v> --confirmed [--reports-to-meta]
//
// Plan kinds: campaign-group | form-group | hub (see SKILL.md for each shape).
// Plans are inline JSON or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).
//
// Never here: connecting or disconnecting an ad account (OAuth), Meta credentials or tokens,
// the test Conversions API event, creating contacts or submitting leads.

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGITS_RE = /^\d+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BLOCKED = 3;
const MAX_TARGETS = 200;
const PAGE_SIZE = 500;
const MAX_REPORT_PAGES = 40;
const MAX_SCAN_PAGES = 20;
const REPORT_DIMENSIONS = {
  campaign: { id: 'campaignId', name: 'campaignName' },
  ad: { id: 'adCampaignCode', name: 'adCampaignName' },
  adset: { id: 'adSetId', name: 'adSetName' },
  form: { id: 'formId', name: 'formName' },
  page: { id: 'pageId', name: 'pageName' },
  source: { id: 'source', name: 'source' },
  account: { id: 'accountId', name: 'accountName' },
};
// Contact attributes the lead ingestion resolves by itself: a form map pointing at them is ignored.
const UNMAPPABLE_ROOTS = new Set(['workspace', 'createdBy', 'updatedBy', 'refId', 'notes', 'stage', 'source',
  'direction', 'adCampaign', 'adCampaignMeta', 'assignee']);
const HUB_KEYS = new Set(['qualificationMappings', 'pageWorkspaces']);
const HUB_SELECT = 'adHubCode adHubName adProvider state active workspace pageWorkspaces qualificationMappings '
  + 'metaCredential details.pageId details.pageName createdAt updatedAt';
const META_SELECT = ['provider', 'source', 'campaignId', 'campaignName', 'adSetId', 'adSetName', 'adCampaignCode',
  'adCampaignName', 'formId', 'formName', 'pageId', 'pageName', 'accountId', 'accountName', 'accountTimezone']
  .map((k) => `adCampaignMeta.${k}`).join(' ');
const CONTACT_SELECT = `firstName lastName email assignee assignedAt assignedBy assignmentGroup adCampaign stage workspace source createdAt createdBy submissions ${META_SELECT}`;

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fullName = (r) => (r && typeof r === 'object' ? [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null : null);
const exactI = (text) => ({ $regex: `(?i)^${escapeRegex(String(text).trim())}$` });
const pagesOf = (hub) => (Array.isArray(hub && hub.details) ? hub.details : [])
  .filter((d) => d && d.pageId)
  .map((d) => ({ pageId: String(d.pageId), pageName: d.pageName || null }));

// The Contact mapping of a meta Form and what the lead ingestion actually applies from it: the
// field map without the attributes it resolves by itself, and the group (mapping's wins).
function formConfig(form) {
  const mappings = Array.isArray(form && form.mappings) ? form.mappings : [];
  const mapping = mappings.find((m) => m && m.modelName === 'Contact') || null;
  const fieldMap = Object.fromEntries(Object.entries((mapping && mapping.fieldMap) || {})
    .filter(([, path]) => typeof path === 'string' && path.trim()
      && !path.trim().startsWith('_') && !UNMAPPABLE_ROOTS.has(path.trim().split('.')[0])));
  const mappingGroup = idOf(mapping && mapping.assignmentGroup) || null;
  const formGroup = idOf(form && form.assignmentGroup) || null;
  const schema = flatSchema(form && form.formSchema);
  return {
    mapping,
    fieldMap,
    mappedCount: Object.keys(fieldMap).length,
    questions: Object.keys(schema).length,
    emailMapped: Object.values(fieldMap).some((p) => p.trim() === 'email'),
    group: mappingGroup || formGroup,
    groupLevel: mappingGroup ? 'mapping' : formGroup ? 'form' : null,
  };
}

function flatSchema(formSchema) {
  if (!formSchema || typeof formSchema !== 'object') return {};
  if (!Array.isArray(formSchema.pages)) return formSchema;
  return formSchema.pages.reduce((acc, p) => Object.assign(acc, (p && p.fields) || {}), {});
}

// Whether the ingestion uses this bridge's form (map and group) for a new lead.
function bridgeApplies(bridge, form) {
  const reasons = [];
  if (!bridge) return { applies: false, reasons: ['No mirrored form for this Meta form yet: the lead used the default dictionary and no form group.'] };
  if (bridge.active === false) reasons.push('The mirrored form is switched off in the Ad Hub: its field map and group are ignored.');
  if (!idOf(bridge.form)) reasons.push('The mirror lost its form; the next lead or discovery recreates it.');
  if (form && form.active === false) reasons.push('The meta form is inactive: its field map and group are ignored.');
  if (form && !formConfig(form).mappedCount) reasons.push('The form maps no question to a contact field: the ingestion ignores its field map AND its group.');
  return { applies: reasons.length === 0, reasons };
}

// Offset in ms of an IANA zone at a given instant (positive east of UTC).
function tzOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant;
}

// Midnight of a calendar day in a zone, as an ISO instant.
function zonedMidnight(dateStr, timeZone) {
  const m = DATE_RE.exec(String(dateStr || ''));
  if (!m) throw new UsageError(`Invalid date "${dateStr}". Use YYYY-MM-DD.`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess) || new Date(guess).getUTCDate() !== Number(m[3])) throw new UsageError(`Invalid date "${dateStr}".`);
  let t = guess - tzOffsetMs(guess, timeZone);
  t = guess - tzOffsetMs(t, timeZone);
  return new Date(t).toISOString();
}

function nextDay(dateStr) {
  const m = DATE_RE.exec(dateStr);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

// Counts per dimension: every submission is a lead (as Meta counts them); sequence 1 is a new
// contact, 2+ a re-contact of someone already in the account.
function tally(rows, by) {
  const dim = REPORT_DIMENSIONS[by];
  const groups = new Map();
  const total = { leads: 0, newContacts: 0, recontacts: 0, contacts: new Set() };
  for (const r of rows) {
    const meta = r.adCampaignMeta || {};
    const key = String(meta[dim.id] || (by === 'ad' && idOf(r.adCampaign)) || '(none)');
    if (!groups.has(key)) groups.set(key, { key, name: meta[dim.name] || null, leads: 0, newContacts: 0, recontacts: 0, contacts: new Set() });
    const g = groups.get(key);
    if (!g.name && meta[dim.name]) g.name = meta[dim.name];
    for (const t of [g, total]) {
      t.leads += 1;
      if (Number(r.sequence) > 1) t.recontacts += 1;
      else t.newContacts += 1;
      if (r.contact) t.contacts.add(idOf(r.contact));
    }
  }
  const out = (g) => ({ ...g, uniqueContacts: g.contacts.size, contacts: undefined });
  return {
    rows: [...groups.values()].map(out).sort((a, b) => b.leads - a.leads || String(a.name).localeCompare(String(b.name))),
    total: out(total),
  };
}

function parsePlan(raw, rootDir) {
  if (!raw) throw new UsageError('Missing plan JSON.');
  let text = raw;
  if (!raw.trim().startsWith('{')) {
    assertDataFileAllowed(raw, rootDir);
    text = fs.readFileSync(raw, 'utf8');
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  if (!['campaign-group', 'form-group', 'hub'].includes(plan.kind)) {
    throw new UsageError('Plan "kind" must be campaign-group, form-group or hub.');
  }
  return plan;
}

// ─── API helpers ───────────────────────────────────────────────────────────────

function apiError(res, what) {
  const msg = (res.body && (res.body.error || res.body.message)) || `HTTP ${res.status}`;
  const err = new Error(`${what}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  err.status = res.status;
  return err;
}

async function get(client, path, what) {
  const res = await client.request('GET', path);
  if (!res.ok) throw apiError(res, what);
  return res.body;
}

async function getOrNull(client, path, what) {
  const res = await client.request('GET', path);
  if (res.status === 404) return null;
  if (!res.ok) throw apiError(res, what);
  return res.body && res.body.data && !Array.isArray(res.body.data) ? res.body.data : res.body;
}

async function list(client, model, params, what) {
  return rowsOf(await get(client, `/v2/${model}?${qs(params)}`, what || `Reading ${model}`));
}

// Pages through a list; returns the rows and whether the cap cut it.
async function scan(client, model, params, maxPages) {
  const rows = [];
  let truncated = false;
  for (let page = 1; ; page += 1) {
     
    const body = await get(client, `/v2/${model}?${qs({ ...params, limit: PAGE_SIZE, page })}`, `Reading ${model}`);
    rows.push(...rowsOf(body));
    const last = (body && body.pagination && body.pagination.lastPage) || 1;
    if (page >= last) break;
    if (page >= maxPages) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

async function findHub(client, ref) {
  if (!ref || typeof ref !== 'string') throw new UsageError('Give the Ad Hub as its ADH- code or id.');
  if (ID_RE.test(ref)) {
    const hub = await getOrNull(client, `/v2/adhub/${ref}?${qs({ select: HUB_SELECT })}`, 'Reading the Ad Hub');
    if (hub && hub._id) return hub;
  }
  const rows = await list(client, 'adhub', { xquery: { adHubCode: ref.trim() }, select: HUB_SELECT, limit: 2 }, 'Reading the Ad Hub');
  if (!rows.length) throw new Blocked(`No Ad Hub "${ref}" on this account. Run: ads.js hubs <domain>.`);
  return rows[0];
}

async function findGroup(client, ref) {
  if (ref === null) return null;
  if (!ref || typeof ref !== 'string') throw new UsageError('Give the user group as its name, code or id (or null to remove it).');
  const select = 'userGroupCode userGroupName userGroupType enableLoadBalancing users updatedAt';
  if (ID_RE.test(ref)) {
    const g = await getOrNull(client, `/v2/usergroup/${ref}?${qs({ select })}`, 'Reading the user group');
    if (g && g._id) return g;
  }
  let rows = await list(client, 'usergroup', { xquery: { userGroupCode: ref.trim() }, select, limit: 2 }, 'Reading the user group');
  if (!rows.length) rows = await list(client, 'usergroup', { xquery: { userGroupName: exactI(ref) }, select, limit: 5 }, 'Reading the user group');
  if (!rows.length) throw new Blocked(`No user group "${ref}". Ask the user for the exact name; create groups in the app (Settings → User groups).`);
  if (rows.length > 1) throw new Blocked(`Several user groups are named "${ref}": ${rows.map((g) => `${g.userGroupName} (${g.userGroupCode})`).join(', ')}. Use the code.`);
  return rows[0];
}

// Members in the group's order, with who is active and who the balancer picks next.
async function describeGroup(client, group) {
  if (!group) return null;
  const ids = (group.users || []).map(idOf);
  const users = ids.length
    ? await list(client, 'user', { xquery: { _id: { $in: ids } }, select: 'email firstName lastName status', limit: ids.length }, 'Reading the group members')
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const members = ids.map((id) => {
    const u = byId.get(id);
    return { id, name: fullName(u), email: (u && u.email) || null, active: Boolean(u && u.status === 'Active') };
  });
  const active = members.filter((m) => m.active);
  return {
    id: String(group._id),
    name: group.userGroupName,
    code: group.userGroupCode,
    type: group.userGroupType || null,
    loadBalancing: group.enableLoadBalancing === true,
    members,
    activeMembers: active.length,
    nextInTurn: group.enableLoadBalancing === true && active.length ? active[0] : null,
    mode: group.enableLoadBalancing === true
      ? 'Round robin: each new lead gets the next active member in this order, who then moves to the end of the list.'
      : 'Pool: the lead stays without owner and every member gets an in-app notice that it is available.',
  };
}

function groupProblems(desc, warnings, blockers) {
  if (!desc) return;
  if (!desc.members.length) blockers.push(`The group "${desc.name}" has no members: the platform would ignore it and the leads would stay without owner or group.`);
  else if (!desc.activeMembers) blockers.push(`No member of "${desc.name}" is active: the balancer finds nobody and the leads stay without owner.`);
  if (!desc.loadBalancing) warnings.push(`"${desc.name}" has load balancing off: leads will wait without owner and every member is notified each time. Turning it on is done in the app (Settings → User groups).`);
  if (desc.type && desc.type !== 'Contact Assignment') warnings.push(`"${desc.name}" is a "${desc.type}" group; it works, but the app's own reception groups are "Contact Assignment".`);
  const inactive = desc.members.filter((m) => !m.active);
  if (inactive.length && desc.activeMembers) warnings.push(`${inactive.length} member(s) of "${desc.name}" are not active and are skipped.`);
}

const groupLabel = (g) => (g ? `${g.userGroupName} (${g.userGroupCode})` : null);

async function groupNames(client, ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const rows = await list(client, 'usergroup', {
    xquery: { _id: { $in: uniq } }, select: 'userGroupCode userGroupName enableLoadBalancing', limit: uniq.length,
  }, 'Reading user groups');
  return new Map(rows.map((g) => [String(g._id), g]));
}

async function submissionsEnabled(client) {
  try {
    const prefs = await get(client, '/v2/user/preferences', 'Reading the account settings');
    const sub = prefs && prefs.modules && prefs.modules.directory && prefs.modules.directory.contacts
      && prefs.modules.directory.contacts.submissions;
    return sub ? sub.enabled === true : null;
  } catch (err) {
    if (err.status === 403) return null;
    throw err;
  }
}

async function lastLead(client, xquery) {
  const rows = await list(client, 'contactsubmission', {
    xquery: { 'adCampaignMeta.provider': { $exists: true }, ...xquery }, sort: '-createdAt', limit: 1, select: 'createdAt',
  }, 'Reading lead submissions');
  return rows[0] ? rows[0].createdAt : null;
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdHubs(client) {
  const hubs = await list(client, 'adhub', { select: HUB_SELECT, sort: '-updatedAt', limit: 100 }, 'Reading Ad Hubs');
  const enabled = await submissionsEnabled(client);
  const out = [];
  for (const hub of hubs) {
     
    const bridges = await list(client, 'adhubform', { adHub: String(hub._id), select: 'pageId formId formName active form formStatus', limit: 500 }, 'Reading lead forms');
    const pages = [];
    for (const page of pagesOf(hub)) {
      const mine = bridges.filter((b) => String(b.pageId) === page.pageId);
      const row = (hub.pageWorkspaces || []).find((r) => r && String(r.pageId) === page.pageId);
      pages.push({
        ...page,
        workspaceCode: (row && row.workspaceCode) || null,
        forms: mine.length,
        formsOff: mine.filter((b) => b.active === false).length,
         
        lastLeadAt: await lastLead(client, { 'adCampaignMeta.pageId': page.pageId }),
      });
    }
    const problems = [];
    if (hub.state !== 'Connected') problems.push('Not connected (state Pending): finish or redo the connection in the app.');
    if (hub.active === false) problems.push('Inactive: the ad service stops delivering its leads.');
    if (!pages.length) problems.push('No pages connected: no lead can arrive. Reconnect in the app and pick the pages.');
    out.push({
      id: String(hub._id),
      code: hub.adHubCode,
      name: hub.adHubName,
      provider: hub.adProvider,
      state: hub.state,
      active: hub.active !== false,
      workspace: idOf(hub.workspace) || null,
      pages,
      qualificationMappings: (hub.qualificationMappings || []).map((m) => ({ stageCode: m && m.stageCode, eventName: m && m.eventName })),
      conversionsCredential: Boolean(idOf(hub.metaCredential)),
      problems,
    });
  }
  return {
    leadSubmissionsEnabled: enabled,
    note: enabled === false
      ? 'Contact submissions are OFF in the account settings: every ad lead is refused (403) and no Ad Hub can be saved. An admin turns it on in the app.'
      : 'A lead that never reached the account (no e-mail, page token expired, ad service down) leaves no trace here: check the connection in the app.',
    hubs: out,
  };
}

async function cmdForms(client, rest, flags) {
  const filter = { select: 'adHub pageId pageName formId formName formStatus form active lastSeenAt discoveredAt updatedAt', sort: 'formName', limit: 500 };
  if (flags.hub) filter.adHub = String((await findHub(client, flags.hub))._id);
  if (flags.page) filter.pageId = flags.page;
  const bridges = await list(client, 'adhubform', filter, 'Reading lead forms');
  const formIds = bridges.map((b) => idOf(b.form)).filter(Boolean);
  const forms = formIds.length
    ? await list(client, 'form', { xquery: { _id: { $in: formIds } }, select: 'formName type active mappings assignmentGroup formSchema updatedAt', limit: formIds.length }, 'Reading meta forms')
    : [];
  const formById = new Map(forms.map((f) => [String(f._id), f]));
  const names = await groupNames(client, forms.map((f) => formConfig(f).group));
  const out = [];
  for (const b of bridges) {
    const form = formById.get(idOf(b.form)) || null;
    const cfg = form ? formConfig(form) : null;
    const use = bridgeApplies(b, form);
    out.push({
      id: String(b._id),
      metaFormId: b.formId,
      name: b.formName,
      page: { id: b.pageId, name: b.pageName || null },
      metaStatus: b.formStatus || null,
      active: b.active !== false,
      form: form ? String(form._id) : null,
      mapped: cfg ? `${cfg.mappedCount}/${cfg.questions}` : null,
      emailMapped: cfg ? cfg.emailMapped : null,
      group: cfg && cfg.group ? { id: cfg.group, name: (names.get(cfg.group) || {}).userGroupName || null, level: cfg.groupLevel } : null,
      applied: use.applies,
      notes: use.reasons,
       
      lastLeadAt: await lastLead(client, { 'adCampaignMeta.formId': String(b.formId) }),
    });
  }
  return { count: out.length, forms: out };
}

async function cmdCampaigns(client, rest, flags) {
  const params = { select: 'adCampaignCode adCampaignName assignmentGroup createdAt updatedAt', sort: '-createdAt', limit: flags.limit || 50 };
  const xquery = {};
  if (flags.search) xquery.$or = [{ adCampaignName: { $regex: `(?i)${escapeRegex(flags.search)}` } }, { adCampaignCode: flags.search.trim() }];
  if (flags.withGroup) xquery.assignmentGroup = { $exists: true, $ne: null };
  if (Object.keys(xquery).length) params.xquery = xquery;
  const body = await get(client, `/v2/adcampaign?${qs(params)}`, 'Reading ad campaigns');
  const rows = rowsOf(body);
  const names = await groupNames(client, rows.map((r) => idOf(r.assignmentGroup)));
  return {
    total: (body && body.pagination && body.pagination.count) ?? rows.length,
    note: 'Each AdCampaign is one Meta AD (its code is the ad id), created by its first lead. A Meta campaign groups several ads: use a campaign-group plan with "metaCampaign".',
    campaigns: rows.map((r) => {
      const g = names.get(idOf(r.assignmentGroup));
      return {
        id: String(r._id),
        code: r.adCampaignCode,
        name: r.adCampaignName,
        group: idOf(r.assignmentGroup) ? { id: idOf(r.assignmentGroup), name: g ? g.userGroupName : '(missing group)' } : null,
        createdAt: r.createdAt,
      };
    }),
  };
}

async function cmdGroup(client, rest) {
  if (!rest[0]) throw new UsageError('Usage: ads.js group <domain> <group name | code | id>');
  const group = await findGroup(client, rest[0]);
  const desc = await describeGroup(client, group);
  const warnings = [];
  const blockers = [];
  groupProblems(desc, warnings, blockers);
  const [campaigns, forms] = await Promise.all([
    list(client, 'adcampaign', { assignmentGroup: desc.id, select: 'adCampaignCode adCampaignName', limit: 200 }, 'Reading ad campaigns'),
    list(client, 'form', { xquery: { type: 'meta', $or: [{ assignmentGroup: desc.id }, { 'mappings.assignmentGroup': desc.id }] }, select: 'formName', limit: 200 }, 'Reading meta forms'),
  ]);
  return {
    ...desc,
    usedBy: {
      campaigns: campaigns.map((c) => ({ id: String(c._id), code: c.adCampaignCode, name: c.adCampaignName })),
      metaForms: forms.map((f) => ({ id: String(f._id), name: f.formName })),
    },
    warnings,
    issues: blockers,
  };
}

async function cmdReport(client, rest, flags) {
  if (!flags.from || !flags.to) throw new UsageError('Usage: ads.js report <domain> --from YYYY-MM-DD --to YYYY-MM-DD [--by campaign|ad|adset|form|page|source|account] [--tz <zone>]');
  const by = flags.by || 'campaign';
  if (!REPORT_DIMENSIONS[by]) throw new UsageError(`--by must be one of ${Object.keys(REPORT_DIMENSIONS).join(', ')}.`);
  if (flags.to < flags.from) throw new UsageError('--to is before --from.');
  let tz = flags.tz;
  let tzSource = '--tz';
  if (!tz) {
    const me = await get(client, '/v2/user/me', 'Reading the current user');
    tz = me && me.profile && me.profile.locale && me.profile.locale.timeZone;
    tzSource = tz ? 'user profile' : 'default (UTC)';
    tz = tz || 'UTC';
  }
  if (!validZone(tz)) throw new UsageError(`Unknown time zone "${tz}". Use an IANA name such as America/Bogota.`);
  const start = zonedMidnight(flags.from, tz);
  const end = zonedMidnight(nextDay(flags.to), tz);
  // One operator per field survives the server's rewrite: the range goes inside $and.
  const xquery = { 'adCampaignMeta.provider': { $exists: true }, $and: [{ createdAt: { $gte: start } }, { createdAt: { $lt: end } }] };
  if (flags.page) xquery['adCampaignMeta.pageId'] = flags.page;
  if (flags.form) xquery['adCampaignMeta.formId'] = flags.form;
  if (flags.campaign) {
    if (DIGITS_RE.test(flags.campaign)) xquery['adCampaignMeta.campaignId'] = flags.campaign;
    else xquery['adCampaignMeta.campaignName'] = exactI(flags.campaign);
  }
  const { rows, truncated } = await scan(client, 'contactsubmission', {
    xquery, sort: 'createdAt', select: `contact sequence createdAt adCampaign ${META_SELECT}`,
  }, MAX_REPORT_PAGES);
  const result = tally(rows, by);
  const zones = [...new Set(rows.map((r) => r.adCampaignMeta && r.adCampaignMeta.accountTimezone).filter(Boolean))];
  const notes = [
    'Each submission is one lead, as the ad platform counts them; newContacts are first-time people, recontacts people who were already in the account.',
    'Only submissions this user may see are counted; a seller sees only their own.',
  ];
  if (zones.length && !zones.includes(tz)) notes.push(`The ad account counts days in ${zones.join(', ')}; this report used ${tz}. Rerun with --tz ${zones[0]} to match the ad platform's numbers.`);
  if (truncated) notes.push(`Stopped after ${MAX_REPORT_PAGES * PAGE_SIZE} submissions: narrow the dates or filter by page or form.`);
  if (!rows.length) notes.push('No ad lead in this period. If leads were expected, run hubs to see the last lead per page.');
  return {
    period: { from: flags.from, to: flags.to, timeZone: tz, timeZoneSource: tzSource, start, end },
    by,
    filters: { page: flags.page || null, form: flags.form || null, campaign: flags.campaign || null },
    total: result.total,
    rows: result.rows,
    truncated,
    notes,
    spend: 'Spend is not summed here: adCampaignMeta.stats are lifetime snapshots per ad. Period spend comes from the ad platform.',
  };
}

async function findContact(client, ref) {
  if (!ref) throw new UsageError('Give the contact e-mail or id.');
  if (ID_RE.test(ref)) {
    const c = await getOrNull(client, `/v2/contact/${ref}?${qs({ select: CONTACT_SELECT })}`, 'Reading the contact');
    if (c && c._id) return c;
  }
  if (!EMAIL_RE.test(ref)) throw new Blocked(`No contact "${ref}". Give an e-mail or a contact id.`);
  const rows = await list(client, 'contact', { email: ref.trim().toLowerCase(), select: CONTACT_SELECT, limit: 5 }, 'Reading the contact');
  if (!rows.length) throw new Blocked(`No contact with e-mail ${ref} that this user can see. A lead without e-mail is refused by the platform and never becomes a contact.`);
  if (rows.length > 1) throw new Blocked(`${rows.length} contacts have ${ref} (one per workspace). Use the id: ${rows.map((r) => r._id).join(', ')}.`);
  return rows[0];
}

async function adminRead(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err.status === 403) return { forbidden: true };
    throw err;
  }
}

async function cmdDiagnose(client, rest) {
  const contact = await findContact(client, rest[0]);
  const meta = contact.adCampaignMeta || {};
  const findings = [];
  const out = {
    contact: {
      id: String(contact._id), name: fullName(contact), email: contact.email, source: contact.source || null, createdAt: contact.createdAt,
      owner: idOf(contact.assignee) || null, assignedAt: contact.assignedAt || null, group: idOf(contact.assignmentGroup) || null,
      workspace: idOf(contact.workspace) || null, stage: idOf(contact.stage) || null,
    },
  };
  if (!meta.provider) {
    out.adLead = false;
    findings.push('This contact did not come from an ad (no adCampaignMeta). Web forms belong to prolibu-forms; manual or imported contacts have no ad routing.');
    return { ...out, findings };
  }
  out.adLead = true;
  out.firstTouch = {
    provider: meta.provider, source: meta.source || null, page: { id: meta.pageId || null, name: meta.pageName || null },
    form: { id: meta.formId || null, name: meta.formName || null }, metaCampaign: meta.campaignName || null,
    ad: { id: idOf(contact.adCampaign) || null, code: meta.adCampaignCode || null, name: meta.adCampaignName || null },
  };
  const subs = await list(client, 'contactsubmission', {
    contact: String(contact._id), sort: 'createdAt', limit: 50, select: `sequence createdAt source adCampaign refId ${META_SELECT}`,
  }, 'Reading submissions');
  out.submissions = subs.map((s) => ({
    sequence: s.sequence, at: s.createdAt, source: s.source || null,
    metaCampaign: (s.adCampaignMeta || {}).campaignName || null, ad: (s.adCampaignMeta || {}).adCampaignName || null,
    form: (s.adCampaignMeta || {}).formName || null, hasLeadId: DIGITS_RE.test(String(s.refId || '')),
  }));
  if (subs.length > 1) findings.push(`${subs.length} submissions: only the first created the contact and could route it; re-contacts never change the owner.`);

  // Admin-only pieces: the Ad Hub, the mirrored form, the campaign and the group.
  const hubRead = await adminRead(async () => (meta.pageId
    ? (await list(client, 'adhub', { xquery: { 'details.pageId': String(meta.pageId) }, sort: '-updatedAt', select: HUB_SELECT, limit: 1 }, 'Reading Ad Hubs'))[0] || null
    : null));
  if (hubRead.forbidden) {
    findings.push('This user cannot read Ad Hubs, forms or groups (admin only): routing and the Meta report cannot be explained with this profile.');
    return { ...out, findings };
  }
  const hub = hubRead.value;
  out.hub = hub ? { id: String(hub._id), code: hub.adHubCode, name: hub.adHubName, state: hub.state, active: hub.active !== false } : null;
  if (!hub) findings.push(`No Ad Hub owns page ${meta.pageId || '?'} now: no workspace by page, no form field map or group, and no stage report to Meta.`);

  // Workspace expected by page.
  if (hub) {
    const row = (hub.pageWorkspaces || []).find((r) => r && String(r.pageId) === String(meta.pageId));
    out.workspace = {
      contact: idOf(contact.workspace) || null,
      byPage: (row && row.workspaceCode) || null,
      hubDefault: idOf(hub.workspace) || null,
    };
    if (!out.workspace.contact) findings.push('The contact has no workspace: only admins see it. Set a workspace per page (hub plan, pageWorkspaces) for future leads.');
  }

  // Routing: the form's group fills the gap first, then the ad's group.
  const bridge = meta.formId
    ? (await list(client, 'adhubform', { provider: 'Meta', formId: String(meta.formId), select: 'formId formName pageId active form updatedAt', limit: 1 }, 'Reading lead forms'))[0] || null
    : null;
  const form = bridge && idOf(bridge.form)
    ? await getOrNull(client, `/v2/form/${idOf(bridge.form)}?${qs({ select: 'formName active type mappings assignmentGroup formSchema' })}`, 'Reading the meta form')
    : null;
  const use = bridgeApplies(bridge, form);
  const cfg = form ? formConfig(form) : null;
  const campaign = idOf(contact.adCampaign)
    ? await getOrNull(client, `/v2/adcampaign/${idOf(contact.adCampaign)}?${qs({ select: 'adCampaignCode adCampaignName assignmentGroup createdAt' })}`, 'Reading the ad campaign')
    : null;
  const formGroupId = use.applies && cfg ? cfg.group : null;
  const campaignGroupId = campaign ? idOf(campaign.assignmentGroup) || null : null;
  const expected = formGroupId ? { from: 'form', group: formGroupId } : campaignGroupId ? { from: 'ad campaign', group: campaignGroupId } : null;
  const groupIds = [formGroupId, campaignGroupId, idOf(contact.assignmentGroup)].filter(Boolean);
  const names = await groupNames(client, groupIds);
  const nameOf = (id) => (id ? (names.get(id) || {}).userGroupName || '(missing group)' : null);
  out.routing = {
    form: bridge ? { metaFormId: bridge.formId, name: bridge.formName, active: bridge.active !== false, applied: use.applies, group: cfg && cfg.group ? nameOf(cfg.group) : null, notes: use.reasons } : null,
    adCampaign: campaign ? { id: String(campaign._id), name: campaign.adCampaignName, group: nameOf(campaignGroupId), createdAt: campaign.createdAt } : null,
    expectedGroupToday: expected ? { ...expected, name: nameOf(expected.group) } : null,
    contactGroup: nameOf(idOf(contact.assignmentGroup)),
  };
  if (!idOf(contact.assignee) && idOf(contact.assignmentGroup)) {
    const g = names.get(idOf(contact.assignmentGroup));
    findings.push(g && g.enableLoadBalancing
      ? 'Group with load balancing but no owner: the group had no active member when the lead arrived.'
      : 'No owner and a group without load balancing: the lead is in the pool waiting for a member to take it (pool mode).');
  } else if (!idOf(contact.assignee) && !idOf(contact.assignmentGroup)) {
    findings.push('No owner and no group: neither its form nor its ad had a usable group when it arrived (or the group had no members).');
  } else if (campaign && campaign.createdAt && contact.createdAt && String(campaign.createdAt) >= String(contact.createdAt) && campaignGroupId && !formGroupId) {
    findings.push('The ad campaign was created by this same lead, so the ad group was set later: it applies only to leads after it.');
  }
  if (expected && idOf(contact.assignmentGroup) && expected.group !== idOf(contact.assignmentGroup)) {
    findings.push('The group configured today differs from the contact\'s: the setting changed after it arrived, or someone changed the contact. New settings only route new leads.');
  }

  // Stage report to Meta (Conversions API) for this contact's current stage.
  if (hub) {
    const mappings = Array.isArray(hub.qualificationMappings) ? hub.qualificationMappings : [];
    const stage = idOf(contact.stage)
      ? await getOrNull(client, `/v2/stage/${idOf(contact.stage)}?${qs({ select: 'stageCode stageName index' })}`, 'Reading the stage')
      : null;
    const code = stage && stage.stageCode ? String(stage.stageCode).trim() : null;
    const row = mappings.find((m) => m && String(m.stageCode || '').trim() === code && String(m.eventName || '').trim());
    const firstMeta = subs.find((s) => (s.adCampaignMeta || {}).provider === 'Meta' && DIGITS_RE.test(String(s.refId || '')));
    const reasons = [];
    if (meta.provider !== 'Meta') reasons.push('Only Meta leads are reported.');
    if (!mappings.length) reasons.push('The Ad Hub maps no stage to a Meta event.');
    else if (!row) reasons.push(`The current stage (${(stage && stage.stageName) || 'none'}) is not mapped.`);
    if (!idOf(hub.metaCredential)) reasons.push('The Ad Hub has no Conversions API credential (an admin links it in the app).');
    if (!firstMeta) reasons.push('No Meta lead id on its first submission.');
    if (stage && !Number.isFinite(stage.index)) reasons.push('The stage has no order (index): moves into it are never reported.');
    out.metaReport = {
      currentStage: stage ? { code, name: stage.stageName, index: stage.index ?? null } : null,
      event: row ? row.eventName : null,
      wouldReport: reasons.length === 0,
      reasons,
      rule: 'Sent once per forward stage move (higher index) into a mapped stage; backward moves and re-contacts are never reported. Nothing here sends anything.',
    };
  }
  return { ...out, findings };
}

// ─── Plans ─────────────────────────────────────────────────────────────────────

async function resolveCampaignRefs(client, refs, blockers) {
  const found = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) throw new UsageError('Each entry of "campaigns" is an id, an ad code or an exact name.');
    let rows = [];
    if (ID_RE.test(ref)) {
       
      const c = await getOrNull(client, `/v2/adcampaign/${ref}?${qs({ select: 'adCampaignCode adCampaignName assignmentGroup updatedAt' })}`, 'Reading the ad campaign');
      if (c && c._id) rows = [c];
    }
     
    if (!rows.length) rows = await list(client, 'adcampaign', { xquery: { adCampaignCode: ref.trim() }, select: 'adCampaignCode adCampaignName assignmentGroup updatedAt', limit: 2 });
     
    if (!rows.length) rows = await list(client, 'adcampaign', { xquery: { adCampaignName: exactI(ref) }, select: 'adCampaignCode adCampaignName assignmentGroup updatedAt', limit: 20 });
    if (!rows.length) blockers.push(`No ad campaign "${ref}". List them with: ads.js campaigns <domain> --search "<text>".`);
    else if (rows.length > 1 && !ID_RE.test(ref)) {
      // Several ads share a name (one per creative or country): all are listed, the user picks.
      blockers.push(`${rows.length} ads are named "${ref}": ${rows.map((r) => `${r.adCampaignCode} (${r._id})`).join(', ')}. Give their codes or use "metaCampaign".`);
    } else found.push(rows[0]);
  }
  return found;
}

// The ads (AdCampaigns) that brought leads under one Meta campaign, read from the submissions.
async function adsOfMetaCampaign(client, ref, warnings) {
  const xquery = DIGITS_RE.test(ref) ? { 'adCampaignMeta.campaignId': ref } : { 'adCampaignMeta.campaignName': exactI(ref) };
  const { rows, truncated } = await scan(client, 'contactsubmission', {
    xquery, select: 'adCampaign adCampaignMeta.campaignId adCampaignMeta.campaignName adCampaignMeta.formId', sort: '-createdAt',
  }, MAX_SCAN_PAGES);
  if (truncated) warnings.push(`Only the latest ${MAX_SCAN_PAGES * PAGE_SIZE} leads of the Meta campaign were scanned for its ads.`);
  const campaignIds = new Set(rows.map((r) => (r.adCampaignMeta || {}).campaignId).filter(Boolean));
  if (campaignIds.size > 1) warnings.push(`"${ref}" names ${campaignIds.size} Meta campaigns (${[...campaignIds].join(', ')}); all their ads are included. Use the campaign id to pick one.`);
  const ids = [...new Set(rows.map((r) => idOf(r.adCampaign)).filter(Boolean))];
  const ads = ids.length
    ? await list(client, 'adcampaign', { xquery: { _id: { $in: ids } }, select: 'adCampaignCode adCampaignName assignmentGroup updatedAt', limit: ids.length })
    : [];
  return { ads, formIds: [...new Set(rows.map((r) => (r.adCampaignMeta || {}).formId).filter(Boolean))], leads: rows.length };
}

// Forms whose own group would win over the ads' group.
async function formsOverriding(client, formIds) {
  if (!formIds.length) return [];
  const bridges = await list(client, 'adhubform', { xquery: { provider: 'Meta', formId: { $in: formIds } }, select: 'formId formName active form', limit: formIds.length });
  const ids = bridges.map((b) => idOf(b.form)).filter(Boolean);
  const forms = ids.length ? await list(client, 'form', { xquery: { _id: { $in: ids } }, select: 'formName active mappings assignmentGroup formSchema', limit: ids.length }) : [];
  const byId = new Map(forms.map((f) => [String(f._id), f]));
  return bridges.filter((b) => {
    const f = byId.get(idOf(b.form));
    return f && bridgeApplies(b, f).applies && formConfig(f).group;
  }).map((b) => b.formName || b.formId);
}

async function planCampaignGroup(client, plan) {
  const warnings = [];
  const blockers = [];
  if (!Object.prototype.hasOwnProperty.call(plan, 'group')) throw new UsageError('campaign-group needs "group": a name, code or id, or null to remove it.');
  const refs = plan.campaigns === undefined ? [] : plan.campaigns;
  const register = plan.register === undefined ? [] : plan.register;
  if (!Array.isArray(refs) || !Array.isArray(register)) throw new UsageError('"campaigns" and "register" are lists.');
  if (!refs.length && !register.length && !plan.metaCampaign) throw new UsageError('Give "campaigns", "metaCampaign" or "register".');
  const group = await findGroup(client, plan.group);
  const desc = await describeGroup(client, group);
  groupProblems(desc, warnings, blockers);

  let targets = await resolveCampaignRefs(client, refs, blockers);
  let formIds = [];
  if (plan.metaCampaign) {
    if (typeof plan.metaCampaign !== 'string' || !plan.metaCampaign.trim()) throw new UsageError('"metaCampaign" is a Meta campaign id or its exact name.');
    const found = await adsOfMetaCampaign(client, plan.metaCampaign.trim(), warnings);
    if (!found.ads.length) blockers.push(`No lead has arrived from the Meta campaign "${plan.metaCampaign}", so it has no ads here yet. Route its form instead (form-group plan), or register its ad ids.`);
    targets = targets.concat(found.ads);
    ({ formIds } = found);
  }
  const creates = [];
  for (const item of register) {
    if (!item || typeof item !== 'object') throw new UsageError('Each "register" entry is {"adCampaignCode": "<ad id>", "adCampaignName": "<name>"}.');
    const code = String(item.adCampaignCode || '').trim();
    const name = String(item.adCampaignName || '').trim();
    if (!code || !name || code.length > 100 || name.length > 200) throw new UsageError('Each "register" entry needs adCampaignCode (≤100) and adCampaignName (≤200).');
     
    const existing = await list(client, 'adcampaign', { xquery: { adCampaignCode: code }, select: 'adCampaignCode adCampaignName assignmentGroup updatedAt', limit: 1 });
    if (existing.length) {
      warnings.push(`Ad ${code} is already registered as "${existing[0].adCampaignName}": it is updated instead.`);
      targets.push(existing[0]);
    } else {
      if (!DIGITS_RE.test(code)) warnings.push(`"${code}" is not a Meta ad id (digits): no Meta lead will ever match it.`);
      creates.push({ adCampaignCode: code, adCampaignName: name });
    }
  }
  const seen = new Set();
  targets = targets.filter((t) => (seen.has(String(t._id)) ? false : seen.add(String(t._id))));
  if (targets.length + creates.length > MAX_TARGETS) blockers.push(`${targets.length + creates.length} ads in one plan; the limit is ${MAX_TARGETS}. Split it.`);

  const to = group ? String(group._id) : null;
  const names = await groupNames(client, targets.map((t) => idOf(t.assignmentGroup)));
  const changes = targets.filter((t) => (idOf(t.assignmentGroup) || null) !== to).map((t) => ({
    action: 'update', id: String(t._id), code: t.adCampaignCode, name: t.adCampaignName,
    from: idOf(t.assignmentGroup) ? groupLabel(names.get(idOf(t.assignmentGroup))) || '(missing group)' : null,
    to: groupLabel(group),
  }));
  creates.forEach((c) => changes.push({ action: 'register', code: c.adCampaignCode, name: c.adCampaignName, from: null, to: groupLabel(group) }));
  const unchanged = targets.length - changes.filter((c) => c.action === 'update').length;

  if (!formIds.length && targets.length) {
    const subs = await list(client, 'contactsubmission', { xquery: { adCampaign: { $in: targets.map((t) => String(t._id)) } }, select: 'adCampaignMeta.formId', limit: PAGE_SIZE });
    formIds = [...new Set(subs.map((s) => (s.adCampaignMeta || {}).formId).filter(Boolean))];
  }
  const overriding = await formsOverriding(client, formIds);
  if (overriding.length) warnings.push(`These forms have their own group, which wins over the ad's: ${overriding.join(', ')}. Their leads keep going to the form's group.`);
  warnings.push('Only NEW people who arrive from now on with no owner inherit the group. Contacts already in the account and re-contacts keep their owner.');
  if (!group) warnings.push('Without a group, new leads of these ads arrive without owner unless their form has one.');

  const version = hash({ plan, targets: targets.map((t) => [String(t._id), t.updatedAt]), group: group && group.updatedAt });
  return {
    kind: 'campaign-group',
    changes,
    unchanged,
    group: desc,
    futureRecipients: desc ? desc.members.filter((m) => m.active).map((m) => m.email || m.id) : [],
    warnings,
    blockers,
    version,
    apply: { updates: changes.filter((c) => c.action === 'update').map((c) => c.id), creates, group: to },
  };
}

async function resolveBridge(client, ref) {
  if (!ref || typeof ref !== 'string') throw new UsageError('form-group needs "form": the Meta form id, the AdHubForm id or the meta Form id.');
  const select = 'adHub pageId pageName formId formName active form updatedAt';
  if (ID_RE.test(ref)) {
    const b = await getOrNull(client, `/v2/adhubform/${ref}?${qs({ select })}`, 'Reading the lead form');
    if (b && b._id) return b;
    const byForm = (await list(client, 'adhubform', { form: ref, select, limit: 1 }, 'Reading lead forms'))[0];
    if (byForm || !DIGITS_RE.test(ref)) return byForm || null;
  }
  if (DIGITS_RE.test(ref)) {
    return (await list(client, 'adhubform', { provider: 'Meta', formId: ref, select, limit: 1 }, 'Reading lead forms'))[0] || null;
  }
  const rows = await list(client, 'adhubform', { xquery: { formName: exactI(ref) }, select, limit: 5 }, 'Reading lead forms');
  if (rows.length > 1) throw new Blocked(`${rows.length} lead forms are named "${ref}": ${rows.map((r) => `${r.formId} (page ${r.pageName || r.pageId})`).join(', ')}. Use the Meta form id.`);
  return rows[0] || null;
}

async function planFormGroup(client, plan) {
  const warnings = [];
  const blockers = [];
  if (!Object.prototype.hasOwnProperty.call(plan, 'group')) throw new UsageError('form-group needs "group": a name, code or id, or null to remove it.');
  const bridge = await resolveBridge(client, plan.form);
  if (!bridge) throw new Blocked(`No mirrored lead form "${plan.form}". Run: ads.js forms <domain>. A form appears once an Ad Hub owns its page (after the connection, or with its first lead).`);
  if (!idOf(bridge.form)) throw new Blocked('This lead form lost its configuration form; the next lead or a discovery in the app recreates it. Try again after that.');
  const form = await getOrNull(client, `/v2/form/${idOf(bridge.form)}?${qs({ select: 'formName type active mappings assignmentGroup formSchema updatedAt' })}`, 'Reading the meta form');
  if (!form || form.type !== 'meta') throw new Blocked('The configuration form of this lead form was not found.');
  const group = await findGroup(client, plan.group);
  const desc = await describeGroup(client, group);
  groupProblems(desc, warnings, blockers);
  const use = bridgeApplies(bridge, form);
  const cfg = formConfig(form);
  if (!cfg.mappedCount) blockers.push('This form maps no question to a contact field, and then the platform ignores its group too. Map at least the e-mail in the app (Ad Hub → Forms) first.');
  use.reasons.filter((r) => !/maps no question/.test(r)).forEach((r) => warnings.push(r));
  const to = group ? String(group._id) : null;
  const body = { assignmentGroup: to };
  if (cfg.mapping && idOf(cfg.mapping.assignmentGroup)) {
    // The mapping's own group wins over the form's: change it too, or the edit does nothing.
    body.mappings = form.mappings.map((m) => {
      const copy = { ...m };
      if (copy.assignmentGroup) copy.assignmentGroup = idOf(copy.assignmentGroup);
      if (m === cfg.mapping) {
        if (to) copy.assignmentGroup = to;
        else delete copy.assignmentGroup;
      }
      return copy;
    });
  }
  const names = await groupNames(client, [cfg.group]);
  const from = cfg.group ? groupLabel(names.get(cfg.group)) || '(missing group)' : null;
  const changes = (cfg.group || null) === to ? [] : [{ form: bridge.formName, metaFormId: bridge.formId, page: bridge.pageName || bridge.pageId, from, to: groupLabel(group) }];
  warnings.push('The form\'s group wins over every ad\'s group, including ads that have not brought a lead yet. Only NEW people who arrive from now on without owner are routed; existing contacts keep theirs.');
  const version = hash({ plan, form: form.updatedAt, bridge: bridge.updatedAt, group: group && group.updatedAt });
  return {
    kind: 'form-group',
    changes,
    unchanged: changes.length ? 0 : 1,
    group: desc,
    futureRecipients: desc ? desc.members.filter((m) => m.active).map((m) => m.email || m.id) : [],
    warnings,
    blockers,
    version,
    apply: { formId: String(form._id), body },
  };
}

function checkHubSet(set) {
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) throw new UsageError('hub needs "set" with qualificationMappings and/or pageWorkspaces.');
  const extra = Object.keys(set).filter((k) => !HUB_KEYS.has(k));
  if (extra.length) throw new UsageError(`hub may only set qualificationMappings and pageWorkspaces, not ${extra.join(', ')}. Connections, pages, credentials and on/off stay in the app.`);
}

async function planHub(client, plan, enabled) {
  const warnings = [];
  const blockers = [];
  const { set } = plan;
  checkHubSet(set);
  const hub = await findHub(client, plan.hub);
  if (enabled === false) blockers.push('Contact submissions are off in the account settings: the platform refuses to save any Ad Hub. An admin turns them on in the app.');
  if (hub.active === false) warnings.push('This Ad Hub is inactive: saving it tells the ad service again that it is off.');
  const changes = {};
  let reportsToMeta = false;

  if (set.qualificationMappings !== undefined) {
    if (!Array.isArray(set.qualificationMappings)) throw new UsageError('qualificationMappings is a list of {stageCode, eventName}.');
    const stages = await list(client, 'stage', { xquery: { stageType: 'Contact.stage' }, select: 'stageCode stageName index', limit: 500 }, 'Reading contact stages');
    const seen = new Set();
    const rows = set.qualificationMappings.map((m) => {
      if (!m || typeof m !== 'object') throw new UsageError('Each qualification mapping is {"stageCode": "...", "eventName": "..."}.');
      const stageCode = String(m.stageCode || '').trim();
      const eventName = String(m.eventName || '').trim();
      if (!stageCode || !eventName || eventName.length > 100) throw new UsageError('Each qualification mapping needs stageCode and eventName (≤100).');
      const stage = stages.find((s) => s.stageCode === stageCode);
      if (!stage) blockers.push(`No contact stage with code "${stageCode}". Codes: ${stages.map((s) => s.stageCode).join(', ')}.`);
      else if (!Number.isFinite(stage.index)) warnings.push(`Stage ${stageCode} has no order (index): moves into it are never reported to Meta.`);
      if (seen.has(stageCode)) blockers.push(`Stage ${stageCode} is mapped twice.`);
      seen.add(stageCode);
      return { stageCode, eventName, stageName: stage ? stage.stageName : null };
    });
    const before = (hub.qualificationMappings || []).map((m) => ({ stageCode: String((m && m.stageCode) || '').trim(), eventName: String((m && m.eventName) || '').trim() }));
    const after = rows.map(({ stageCode, eventName }) => ({ stageCode, eventName }));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.qualificationMappings = { from: before, to: rows };
      reportsToMeta = after.length > 0;
    }
    if (after.length && !idOf(hub.metaCredential)) warnings.push('This Ad Hub has no Conversions API credential: nothing is reported until an admin links one in the app.');
  }

  if (set.pageWorkspaces !== undefined) {
    if (!Array.isArray(set.pageWorkspaces)) throw new UsageError('pageWorkspaces is a list of {pageId, workspaceCode}.');
    const pages = pagesOf(hub);
    const workspaces = await list(client, 'workspace', { select: 'workspaceCode workspaceName active', limit: 500 }, 'Reading workspaces');
    const seen = new Set();
    const rows = set.pageWorkspaces.map((r) => {
      if (!r || typeof r !== 'object') throw new UsageError('Each page row is {"pageId": "...", "workspaceCode": "..."}.');
      const pageId = String(r.pageId || '').trim();
      const workspaceCode = String(r.workspaceCode || '').trim();
      if (!pageId || !workspaceCode) throw new UsageError('Each page row needs pageId and workspaceCode.');
      const page = pages.find((p) => p.pageId === pageId);
      if (!page) blockers.push(`Page ${pageId} is not connected to this Ad Hub. Pages: ${pages.map((p) => `${p.pageId} (${p.pageName})`).join(', ') || 'none'}.`);
      const ws = workspaces.find((w) => w.workspaceCode === workspaceCode);
      if (!ws) blockers.push(`No workspace with code "${workspaceCode}".`);
      else if (ws.active === false) blockers.push(`Workspace ${workspaceCode} is deactivated: its leads would be refused.`);
      if (seen.has(pageId)) blockers.push(`Page ${pageId} appears twice.`);
      seen.add(pageId);
      return { pageId, pageName: page ? page.pageName : null, workspaceCode };
    });
    const before = (hub.pageWorkspaces || []).map((r) => ({ pageId: String((r && r.pageId) || ''), workspaceCode: String((r && r.workspaceCode) || '').trim() }));
    if (JSON.stringify(before) !== JSON.stringify(rows.map(({ pageId, workspaceCode }) => ({ pageId, workspaceCode })))) {
      changes.pageWorkspaces = { from: before, to: rows };
      warnings.push('Only leads that arrive from now on land in the new workspace; existing contacts stay where they are.');
    }
  }
  const version = hash({ plan, hub: hub.updatedAt });
  return {
    kind: 'hub',
    hub: { id: String(hub._id), code: hub.adHubCode, name: hub.adHubName },
    changes,
    unchanged: Object.keys(changes).length ? 0 : 1,
    reportsToMeta,
    externalEffects: reportsToMeta
      ? ['From then on, every forward stage move of a Meta lead into a mapped stage sends that event to Meta (Conversions API). It changes how Meta optimises the ads and cannot be undone for events already sent.']
      : [],
    warnings,
    blockers,
    version,
    apply: { hubId: String(hub._id), body: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to.map((row) => {
      const { stageName, pageName, ...rest } = row;
      return k === 'pageWorkspaces' ? { ...rest, pageName: pageName || undefined } : rest;
    })])) },
  };
}

async function buildPlan(client, plan) {
  if (plan.kind === 'campaign-group') return planCampaignGroup(client, plan);
  if (plan.kind === 'form-group') return planFormGroup(client, plan);
  checkHubSet(plan.set);
  return planHub(client, plan, await submissionsEnabled(client));
}

const strip = (p) => {
  const { apply, ...rest } = p;
  return rest;
};

async function cmdPreview(client, rest, flags, ctx) {
  const plan = parsePlan(rest[0], ctx.rootDir);
  const p = await buildPlan(client, plan);
  const nothing = !p.blockers.length && (Array.isArray(p.changes) ? !p.changes.length : !Object.keys(p.changes).length);
  const extra = p.reportsToMeta ? ' --reports-to-meta' : '';
  return {
    preview: true,
    ...strip(p),
    nextStep: p.blockers.length
      ? 'Blocked: explain the blockers to the user in plain words. Nothing was written.'
      : nothing
        ? 'Nothing to change: tell the user it is already like that.'
        : `${STOP}apply <domain> '<same plan>' --version ${p.version} --confirmed${extra}`,
  };
}

async function cmdApply(client, rest, flags, ctx) {
  const plan = parsePlan(rest[0], ctx.rootDir);
  if (!flags.version) throw new UsageError('apply needs --version from the preview.');
  if (!flags.confirmed) throw new UsageError('apply needs --confirmed, given only after the user said yes to the preview.');
  const p = await buildPlan(client, plan);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The records changed since the preview. Preview again and show the user the new result.');
  if (p.reportsToMeta && !flags.reportsToMeta) {
    throw new Blocked('This plan makes stage moves report to Meta. It needs --reports-to-meta, given only after the user said yes to exactly that.');
  }
  const problems = [];
  const done = [];
  if (p.kind === 'campaign-group') {
    for (const id of p.apply.updates) {
       
      const res = await client.request('PATCH', `/v2/adcampaign/${id}`, { data: { assignmentGroup: p.apply.group }, confirmed: true });
      if (!res.ok) throw apiError(res, `Updating ad campaign ${id}`);
       
      const back = await getOrNull(client, `/v2/adcampaign/${id}?${qs({ select: 'adCampaignCode adCampaignName assignmentGroup' })}`, 'Reading back');
      if ((idOf(back && back.assignmentGroup) || null) !== p.apply.group) problems.push(`Ad campaign ${id} did not keep the group.`);
      done.push({ id, code: back && back.adCampaignCode, group: idOf(back && back.assignmentGroup) || null });
    }
    for (const c of p.apply.creates) {
      const data = { ...c, ...(p.apply.group ? { assignmentGroup: p.apply.group } : {}) };
       
      const res = await client.request('POST', '/v2/adcampaign', { data, confirmed: true });
      if (!res.ok) throw apiError(res, `Registering ad ${c.adCampaignCode}`);
      const id = idOf(res.body && (res.body.data || res.body));
       
      const back = id ? await getOrNull(client, `/v2/adcampaign/${id}?${qs({ select: 'adCampaignCode adCampaignName assignmentGroup' })}`, 'Reading back') : null;
      if (!back || (idOf(back.assignmentGroup) || null) !== p.apply.group || back.adCampaignCode !== c.adCampaignCode) problems.push(`Ad ${c.adCampaignCode} did not save as planned.`);
      done.push({ id, code: c.adCampaignCode, registered: true, group: back ? idOf(back.assignmentGroup) || null : null });
    }
  } else if (p.kind === 'form-group') {
    if (p.changes.length) {
      const res = await client.request('PATCH', `/v2/form/${p.apply.formId}`, { data: p.apply.body, confirmed: true });
      if (!res.ok) throw apiError(res, 'Updating the meta form');
      const back = await getOrNull(client, `/v2/form/${p.apply.formId}?${qs({ select: 'formName mappings assignmentGroup formSchema active' })}`, 'Reading back');
      const effective = back ? formConfig(back).group : null;
      if ((effective || null) !== p.apply.body.assignmentGroup) problems.push('The form\'s effective group is not the planned one.');
      done.push({ formId: p.apply.formId, group: effective || null });
    }
  } else if (Object.keys(p.apply.body).length) {
    const res = await client.request('PATCH', `/v2/adhub/${p.apply.hubId}`, { data: p.apply.body, confirmed: true });
    if (!res.ok) throw apiError(res, 'Updating the Ad Hub');
    const back = await getOrNull(client, `/v2/adhub/${p.apply.hubId}?${qs({ select: 'qualificationMappings pageWorkspaces' })}`, 'Reading back');
    for (const key of Object.keys(p.apply.body)) {
      const want = p.apply.body[key].map((r) => (key === 'pageWorkspaces' ? `${r.pageId}=${r.workspaceCode}` : `${r.stageCode}=${r.eventName}`));
      const got = ((back && back[key]) || []).map((r) => (key === 'pageWorkspaces' ? `${r.pageId}=${r.workspaceCode}` : `${r.stageCode}=${r.eventName}`));
      if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`${key} did not save as planned.`);
    }
    done.push({ hub: p.hub.code, saved: Object.keys(p.apply.body) });
  }
  return { applied: true, kind: p.kind, done, problems };
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
    else if (arg === '--reports-to-meta') flags.reportsToMeta = true;
    else if (arg === '--with-group') flags.withGroup = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--hub') flags.hub = next();
    else if (arg === '--page') flags.page = next();
    else if (arg === '--form') flags.form = next();
    else if (arg === '--campaign') flags.campaign = next();
    else if (arg === '--search') flags.search = next();
    else if (arg === '--from') flags.from = next();
    else if (arg === '--to') flags.to = next();
    else if (arg === '--by') flags.by = next();
    else if (arg === '--tz') flags.tz = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 50, 1), 200);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  hubs: cmdHubs,
  forms: cmdForms,
  campaigns: cmdCampaigns,
  group: cmdGroup,
  report: cmdReport,
  diagnose: cmdDiagnose,
  preview: cmdPreview,
  apply: cmdApply,
};

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'the first refusal. Tell the user an admin must do it; never retry it another way or with another profile.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: ads.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    if (['date', 'from', 'to'].some((k) => flags[k] && !DATE_RE.test(flags[k]))) throw new UsageError('Dates are YYYY-MM-DD.');
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
  main, formConfig, bridgeApplies, tally, zonedMidnight, tzOffsetMs, parsePlan,
};
