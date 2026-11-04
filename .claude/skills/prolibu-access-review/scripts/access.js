#!/usr/bin/env node
'use strict';

// Read-only review of who can see or do what on a Prolibu account.
//
//   access.js whoami   <domain> [--model <Model>] [--permission <p>] the profile's own user and access
//   access.js user     <domain> <e-mail|id> [--model <Model>] [--permission <p>]  roles, workspaces, teams, rules
//   access.js role     <domain> <name|keyname|id> [--model <Model>] a role's permissions and who holds it
//   access.js roles    <domain>                                   every role with its holders count
//   access.js admins   <domain>                                   users with full admin access
//   access.js can      <domain> <e-mail|id|me> <Model> <recordId> [--action view|edit|delete|all]
//   access.js who      <domain> <Model> <recordId> [--action view|edit|delete]
//   access.js settings <domain>                                   access modes, MFA, sign-in rules
//   access.js tokens   <domain>                                   the profile's own tokens (never their keys)
//
// Every command only sends GET. Every command accepts --profile <name>.
// Exit codes: 0 ok, 1 API error (a 403 prints FORBIDDEN and stops), 2 usage error (nothing sent),
// 3 blocked (the user, role or record does not exist, or cannot be evaluated).

const { createClient, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const MODEL_RE = /^[A-Z][A-Za-z0-9]{1,60}$/;
const EMAIL_RE = /^[^\s@"'<>]{1,128}@[^\s@"'<>]{1,128}\.[a-z0-9-]{2,}$/i;
// Role names: printable text, no control characters, short.
const NAME_RE = { test: (s) => typeof s === 'string' && s.length >= 1 && s.length <= 120 && ![...s].some((c) => c.charCodeAt(0) < 32) };
const BLOCKED = 3;
const PAGE = 200;
const MAX_USERS = 2000;
const ACTIONS = ['view', 'edit', 'delete'];
const FN_OF = { view: 'findOne', edit: 'update', delete: 'delete' };
const USER_SET_SCOPES = ['sameTeamUsers', 'sameCompanyUsers', 'sameGroupUsers'];
// Models whose access comes from a parent record (verified in code: Page and Widget).
const PARENT_DERIVED = new Set(['Page', 'Widget']);
const DECIDE = 'Special@CommercialException.allow.decide';
const USER_FIELDS = 'firstName lastName email isAdmin isAccountOwner status active roles revocationRoles primaryWorkspace sharedWorkspaces selectableWorkspaces team company lastLogin';

class Blocked extends Error {}

// ─── Read-only transport ───────────────────────────────────────────────────────

async function get(client, reqPath) {
  const res = await client.request('GET', reqPath);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: String(res.body || '').slice(0, 200) };
    const err = new Error(`GET ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

// The same read, but a 403/404 is an answer (used for the live probe and optional context).
async function probe(client, reqPath) {
  const res = await client.request('GET', reqPath);
  return res.status;
}

const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const ids = (arr) => (Array.isArray(arr) ? arr.map(idOf).filter(Boolean) : []);
const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
const person = (u) => (u ? { _id: idOf(u), name: fullName(u), email: u.email || null } : null);

async function listAll(client, pathName, params, max = MAX_USERS) {
  const rows = [];
  let page = 1;
  let count = 0;
  for (;;) {
    const body = await get(client, `${pathName}?${qs({ ...params, limit: String(PAGE), page: String(page) })}`);
    const batch = rowsOf(body);
    count = body && body.pagination ? body.pagination.count : batch.length;
    rows.push(...batch);
    if (!batch.length || rows.length >= count || rows.length >= max) break;
    page += 1;
  }
  return { rows: rows.slice(0, max), truncated: count > max, count };
}

// A read that a non-admin profile may not do: noted, never retried another way.
async function optional(forbidden, name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status === 403) {
      forbidden.push(name);
      return undefined;
    }
    throw err;
  }
}

// ─── Permissions ───────────────────────────────────────────────────────────────

function parsePermission(p) {
  const [type, rest] = String(p).split('@');
  if (!rest) return null;
  const parts = rest.split('.');
  return { type, model: parts[0], action: parts[1] || '*', key: parts.slice(2).join('.') || '*' };
}

// The server's rule: union of the roles' permissions minus the revocation roles' permissions.
function effectivePermissions(roles, revocationRoles) {
  const granted = new Set();
  (roles || []).forEach((r) => (r.permissions || []).forEach((p) => granted.add(p)));
  const revoked = new Set();
  (revocationRoles || []).forEach((r) => (r.permissions || []).forEach((p) => revoked.add(p)));
  revoked.forEach((p) => granted.delete(p));
  return [...granted].sort();
}

// Groups a permission list by object: actions, record rules per action, specials, protected fields.
function summarize(perms, onlyModel) {
  const models = {};
  const specials = [];
  const custom = [];
  const global = [];
  const slot = (m) => {
    if (!models[m]) models[m] = { actions: [], record: {}, protectedFields: [] };
    return models[m];
  };
  perms.forEach((p) => {
    const d = parsePermission(p);
    if (!d) return;
    if (d.type === 'Special') { specials.push(p); return; }
    if (d.type === 'CustomPermission') { custom.push(p); return; }
    if (d.model === '*') { global.push(p); return; }
    if (onlyModel && d.model !== onlyModel) return;
    const s = slot(d.model);
    if (d.type === 'Resource') s.actions.push(d.action);
    else if (d.type === 'Record') {
      const acts = d.action === '*' ? ACTIONS : [d.action];
      acts.forEach((a) => { (s.record[a] = s.record[a] || []).push(d.key === '*' ? 'all' : d.key); });
    } else if (d.type === 'ProtectedField') s.protectedFields.push(`${d.action}:${d.key}`);
  });
  Object.values(models).forEach((m) => {
    m.actions = [...new Set(m.actions)].sort();
    ACTIONS.forEach((a) => {
      if (m.record[a]) m.record[a] = [...new Set(m.record[a])];
      else m.record[a] = ['default'];
    });
    m.protectedFieldsCount = m.protectedFields.length;
    m.protectedFields = m.protectedFields.slice(0, 15);
  });
  return { global, specials, custom, models };
}

// Which roles give (and which revocation roles take away) the special permissions and the
// asked one; a wildcard counts as giving it.
function sourcesOf(perms, roles, revocationRoles, asked) {
  const covers = (held, want) => {
    if (held === want) return true;
    const h = parsePermission(held);
    const w = parsePermission(want);
    if (!h || !w || h.type !== w.type) return false;
    return (h.model === '*' || h.model === w.model) && (h.action === '*' || h.action === w.action) && (h.key === '*' || h.key === w.key);
  };
  const wanted = [...new Set([...perms.filter((p) => p.startsWith('Special@')), 'Resource@Token.create', ...(asked ? [asked] : [])])];
  const out = {};
  wanted.forEach((w) => {
    out[w] = {
      held: perms.some((p) => covers(p, w)),
      grantedBy: (roles || []).filter((r) => (r.permissions || []).some((p) => covers(p, w))).map((r) => r.roleName),
      revokedBy: (revocationRoles || []).filter((r) => (r.permissions || []).some((p) => covers(p, w))).map((r) => r.roleName),
    };
  });
  return out;
}

function resourceGate({ user, perms, modes, model, action }) {
  if (user.isAdmin) return { ok: true, by: 'admin' };
  if (model === 'Workspace' && action === 'view') return { ok: true, by: 'workspaceViewOpen' };
  const fn = FN_OF[action];
  const needs = ['Resource@*.*', `Resource@${model}.*`, `Resource@${model}.${fn}`];
  if (!perms.length) {
    if (modes.resourceAccessMode === 'Unrestricted') return { ok: true, by: 'unrestrictedModeNoRoles' };
    return { ok: false, by: 'strictModeNoRoles', needs: needs.slice(2) };
  }
  const held = needs.find((n) => perms.includes(n));
  return held ? { ok: true, by: held } : { ok: false, by: 'missingPermission', needs: needs.slice(2) };
}

// Port of the server's record filter (getRecordPermissionsQuery + widenRecordScope + the delete
// owner check) as a yes/no on one record, with the branch that grants it.
function recordGate(args) {
  const {
    user, perms, modes, model, attrs, record, action, ctx, prefRecordPermissions,
  } = args;
  const uid = idOf(user);
  if (user.isAdmin) return { ok: true, granted: ['admin'] };
  if (modes.recordAccessMode === 'Unrestricted') return { ok: true, granted: ['accountModeUnrestricted'] };
  if (model === 'Workspace' && action === 'view') return { ok: true, granted: ['workspaceViewOpen'] };
  const every = (prefRecordPermissions[model] || {}).allowEveryone || {};
  if ((every.view && action === 'view') || (every.edit && action === 'edit')) return { ok: true, granted: ['accountAllowEveryone'] };
  if (PARENT_DERIVED.has(model)) return { ok: null, granted: ['inheritsFromParent'] };

  const wildcard = ['Record@*.*', `Record@${model}.*`, `Record@${model}.*.*`, `Record@${model}.${action}.*`];
  const matchable = [...wildcard, ...['sameCompanyUsers', 'sameTeamUsers', 'sameGroupUsers', 'ownedOrAssigned', 'sameWorkspaceUsers']
    .map((k) => `Record@${model}.${action}.${k}`)];
  const rules = perms.filter((p) => matchable.includes(p));
  const types = rules.map((p) => p.split('.').pop());
  const shareAll = rules.some((p) => wildcard.includes(p));

  const pw = idOf(user.primaryWorkspace);
  const sw = ids(user.sharedWorkspaces);
  const ws = idOf(record.workspace);
  const createdBy = idOf(record.createdBy);
  const assignee = idOf(record.assignee);
  const collaborators = ids(record.collaborators);
  const inSet = (set) => set.includes(createdBy) || (attrs.has('assignee') && set.includes(assignee))
    || (attrs.has('collaborators') && collaborators.some((c) => set.includes(c)));
  const inMyWorkspaces = (!!pw && ws === pw) || (!!ws && sw.includes(ws));

  const base = [];
  const scoped = [];
  const add = (code, match, both) => { base.push({ code, match }); if (both) scoped.push({ code, match }); };

  if (shareAll) {
    const anywhere = !pw && !sw.length;
    add(anywhere ? 'roleRuleAll' : 'roleRuleAllInMyWorkspaces', anywhere || inMyWorkspaces, false);
  }
  if (types.includes('sameCompanyUsers') && user.company) add('roleRuleSameCompany', inSet(ctx.companyUserIds || []), true);
  if (types.includes('sameTeamUsers')) add('roleRuleSameTeam', inSet(ctx.teammateIds || []), true);
  if (types.includes('sameGroupUsers')) add('roleRuleSameRecordSharingGroup', inSet(ctx.groupUserIds || []), true);
  if (types.includes('sameWorkspaceUsers')) {
    if (pw) add('roleRuleSameWorkspace', ws === pw, true);
    if (sw.length) add('roleRuleSameWorkspace', sw.includes(ws), true);
  }
  const mode = modes.recordAccessMode;
  const modeApplies = (m) => mode === `${m} Unrestricted` || (mode === `${m} Observer` && action === 'view');
  if (user.company && modeApplies('Company')) add('accountModeCompany', inSet(ctx.companyUserIds || []), false);
  if (user.team && modeApplies('Team')) add('accountModeTeam', inSet(ctx.teamFieldUserIds || []), false);
  if (modeApplies('Workspace')) {
    if (pw) add('accountModeWorkspace', ws === pw, false);
    if (sw.length) add('accountModeWorkspace', sw.includes(ws), false);
  }
  if (mode === 'Observer' && action === 'view') add('accountModeObserver', true, false);
  else add('createdByUser', createdBy === uid, false);
  scoped.push({ code: 'createdByUser', match: createdBy === uid });
  if (attrs.has('assignee')) add('assignedToUser', assignee === uid, true);
  if (attrs.has('collaborators')) add('collaboratorOnRecord', collaborators.includes(uid), true);
  if (attrs.has('teams') && (ctx.memberTeamIds || []).length) add('recordSharedWithUsersTeam', ids(record.teams).some((t) => ctx.memberTeamIds.includes(t)), true);
  if (sw.length) add('recordInUsersSharedWorkspace', sw.includes(ws), false);
  if (attrs.has('allowEveryone') && action !== 'delete') {
    const flag = record.allowEveryone && record.allowEveryone[action];
    if (action === 'view' || action === 'edit') add(`recordAllowEveryone.${action}`, !!flag, true);
  }
  if (model === 'User' && action === 'view' && pw) {
    const r = record;
    const match = idOf(r) === uid || [pw, ...sw].includes(idOf(r.primaryWorkspace))
      || ids(r.selectableWorkspaces).includes(pw) || ids(r.sharedWorkspaces).includes(pw);
    add('userDirectorySameWorkspace', match, true);
  }

  const restricted = !shareAll && types.some((t) => USER_SET_SCOPES.includes(t));
  const effective = restricted ? scoped : base;
  let ok = effective.some((b) => b.match);
  const granted = [...new Set(effective.filter((b) => b.match).map((b) => b.code))];
  const notes = [];
  if (restricted) notes.push('roleRuleRestricts: a same-team/company/group rule limits this action to own, assigned, shared and that set; shared workspaces no longer widen it.');

  if (types.includes('ownedOrAssigned')) {
    const own = createdBy === uid || (attrs.has('assignee') && assignee === uid) || (attrs.has('collaborators') && collaborators.includes(uid));
    if (!own) { ok = false; notes.push('roleRuleOwnedOrAssigned: the user must also be creator, assignee or collaborator.'); }
  }

  // Edit/delete without their own rule are also capped by a restricted view.
  if (action !== 'view' && !rules.length && model !== 'Workspace') {
    const viewScopes = ['sameTeamUsers', 'sameCompanyUsers', 'sameGroupUsers', 'ownedOrAssigned'].map((k) => `Record@${model}.view.${k}`);
    const viewWild = ['Record@*.*', `Record@${model}.*`, `Record@${model}.*.*`, `Record@${model}.view.*`];
    if (perms.some((p) => viewScopes.includes(p)) && !perms.some((p) => viewWild.includes(p))) {
      const view = recordGate({ ...args, action: 'view' });
      if (!view.ok) { ok = false; notes.push('cappedByView: the user cannot view it, so cannot change it either.'); }
    }
  }

  if (model === 'CommercialException' && ['view', 'edit'].includes(action) && perms.includes(DECIDE) && !ws) {
    if (!ok) { ok = true; granted.push('approverSeesExceptionsWithoutWorkspace'); }
  }

  if (action === 'delete' && ok && perms.length && createdBy !== uid) {
    let allowed = false;
    if (perms.includes('Special@*.allowDeleteBy.*')) allowed = true;
    else if (perms.includes('Special@*.allowDeleteBy.assignee')) allowed = assignee === uid;
    else if (perms.includes('Special@*.allowDeleteBy.collaborators')) allowed = collaborators.includes(uid);
    if (!allowed && model === 'Notification' && assignee === uid) allowed = true;
    if (!allowed) { ok = false; notes.push('deleteOwnOnly: only the creator deletes, unless a Special@*.allowDeleteBy permission says otherwise.'); }
  }
  return {
    ok, granted: ok ? granted : [], rules: rules.length ? rules : ['none (default rule)'], notes,
  };
}

// ─── Account context ───────────────────────────────────────────────────────────

async function me(client) {
  const body = await get(client, '/v2/user/me');
  const p = (body && body.profile) || {};
  return {
    profile: p,
    isAdmin: !!p.isAdmin,
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
    modelSchemas: body.modelSchemas || {},
  };
}

async function readModes(client, forbidden) {
  const body = await optional(forbidden, 'account security settings (admin only)', () => get(client, '/v2/preference/read'));
  const sec = (body && body.preference && body.preference.security) || null;
  if (!sec) {
    return {
      known: false, modes: { resourceAccessMode: 'Strict', recordAccessMode: 'Owned' }, recordPermissions: {}, security: null,
    };
  }
  const pm = sec.permissionsMode || {};
  return {
    known: true,
    modes: { resourceAccessMode: pm.resourceAccessMode || 'Unrestricted', recordAccessMode: pm.recordAccessMode || 'Unrestricted' },
    recordPermissions: pm.recordPermissions || {},
    security: sec,
  };
}

async function loadRoles(client) {
  const { rows } = await listAll(client, '/v2/role', { select: 'roleName keyname description system permissions' }, 1000);
  return new Map(rows.map((r) => [idOf(r), r]));
}

async function loadDirectory(client) {
  const users = await listAll(client, '/v2/user', { select: USER_FIELDS });
  const roles = await loadRoles(client);
  const teams = (await listAll(client, '/v2/team', { select: 'teamName users' }, 1000)).rows;
  const groups = (await listAll(client, '/v2/usergroup', { select: 'userGroupName userGroupType users', xquery: { userGroupType: 'Record Sharing' } }, 1000)).rows;
  const workspaces = (await listAll(client, '/v2/workspace', { select: 'workspaceName active' }, 1000)).rows;
  return {
    users: users.rows, usersTruncated: users.truncated, roles, teams, groups, workspaces,
  };
}

function contextFor(user, dir) {
  const uid = idOf(user);
  const memberTeams = dir.teams.filter((t) => ids(t.users).includes(uid));
  const teamIds = new Set(memberTeams.map(idOf));
  if (idOf(user.team)) teamIds.add(idOf(user.team));
  const teammates = new Set();
  dir.teams.filter((t) => teamIds.has(idOf(t))).forEach((t) => ids(t.users).forEach((x) => teammates.add(x)));
  dir.users.filter((u) => teamIds.has(idOf(u.team))).forEach((u) => teammates.add(idOf(u)));
  const groups = dir.groups.filter((g) => ids(g.users).includes(uid));
  const groupUsers = new Set();
  groups.forEach((g) => ids(g.users).forEach((x) => { if (x !== uid) groupUsers.add(x); }));
  const company = idOf(user.company);
  const team = idOf(user.team);
  return {
    memberTeamIds: memberTeams.map(idOf),
    teamNames: dir.teams.filter((t) => teamIds.has(idOf(t))).map((t) => t.teamName || idOf(t)),
    teammateIds: [...teammates],
    groupUserIds: [...groupUsers],
    groupNames: groups.map((g) => g.userGroupName || idOf(g)),
    companyUserIds: company ? dir.users.filter((u) => idOf(u.company) === company).map(idOf) : [],
    teamFieldUserIds: team ? dir.users.filter((u) => idOf(u.team) === team).map(idOf) : [],
  };
}

const rolesOf = (user, dir, field) => ids(user[field]).map((rid) => dir.roles.get(rid)).filter(Boolean);
const permsOf = (user, dir) => effectivePermissions(rolesOf(user, dir, 'roles'), rolesOf(user, dir, 'revocationRoles'));
const wsName = (dir, wid) => {
  const w = dir.workspaces.find((x) => idOf(x) === idOf(wid));
  return w ? w.workspaceName : idOf(wid) || null;
};

function findUser(dir, who) {
  const key = String(who).toLowerCase();
  return dir.users.find((u) => idOf(u) === who || String(u.email || '').toLowerCase() === key) || null;
}

function attrsOf(meInfo, model) {
  const schema = meInfo.modelSchemas[model];
  if (!schema) throw new Blocked(`The object "${model}" does not exist on this account (or this profile cannot see its schema). Use the object's name, e.g. Deal.`);
  return new Set(Object.keys(schema));
}

async function readRecord(client, model, recordId, attrs) {
  const fields = ['createdBy', 'assignee', 'collaborators', 'workspace', 'teams', 'allowEveryone', 'primaryWorkspace', 'sharedWorkspaces', 'selectableWorkspaces']
    .filter((f) => attrs.has(f));
  const body = await get(client, `/v2/${model.toLowerCase()}/${recordId}?${qs({ select: fields.join(' ') || '_id' })}`);
  return body && typeof body === 'object' ? body : null;
}

function userOut(user, dir) {
  return {
    ...person(user),
    status: user.status || null,
    isAdmin: !!user.isAdmin,
    isAccountOwner: !!user.isAccountOwner,
    roles: rolesOf(user, dir, 'roles').map((r) => ({ _id: idOf(r), roleName: r.roleName, system: !!r.system })),
    revocationRoles: rolesOf(user, dir, 'revocationRoles').map((r) => ({ _id: idOf(r), roleName: r.roleName })),
    primaryWorkspace: user.primaryWorkspace ? wsName(dir, user.primaryWorkspace) : null,
    sharedWorkspaces: ids(user.sharedWorkspaces).map((w) => wsName(dir, w)),
  };
}

const ADMIN_NOTE = 'An admin passes every role and record check (only an API token with scopes narrows an admin).';

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdWhoami(client, rest, flags) {
  checkPermissionFlag(flags);
  const m = await me(client);
  const forbidden = [];
  const acc = await readModes(client, forbidden);
  const p = m.profile;
  const roles = (p.roles || []).filter((r) => r && typeof r === 'object');
  const perms = effectivePermissions(roles, (p.revocationRoles || []).filter((r) => r && typeof r === 'object'));
  return {
    user: {
      ...person(p),
      status: p.status || null,
      isAdmin: m.isAdmin,
      roles: roles.map((r) => ({ _id: idOf(r), roleName: r.roleName, system: !!r.system })),
      primaryWorkspace: p.primaryWorkspace ? (p.primaryWorkspace.workspaceName || idOf(p.primaryWorkspace)) : null,
      sharedWorkspaces: (p.selectableWorkspaces || []).filter((w) => ids(p.sharedWorkspaces).includes(idOf(w))).map((w) => w.workspaceName || idOf(w)),
      team: idOf(p.team) || null,
      company: idOf(p.company) || null,
    },
    accountModes: acc.known ? acc.modes : 'unknown (admin only)',
    permissions: m.isAdmin ? ADMIN_NOTE : summarize(perms, flags.model),
    permissionSources: m.isAdmin ? undefined : sourcesOf(perms, roles, (p.revocationRoles || []).filter((r) => r && typeof r === 'object'), flags.permission),
    notes: m.isAdmin ? [] : ['Record rules: "default" means own, assigned, collaborator, the record\'s teams and every record in the user\'s shared workspaces.'],
    ...(forbidden.length ? { forbidden } : {}),
  };
}

async function requireDirectory(client) {
  return loadDirectory(client);
}

function checkPermissionFlag(flags) {
  if (flags.permission && !/^(Resource|Record|ProtectedField|Special|CustomPermission)@[A-Za-z0-9*]+\.[A-Za-z0-9*.]+$/.test(flags.permission)) {
    throw new UsageError('--permission is a permission string such as Resource@Token.create or Special@CommercialException.allow.decide.');
  }
}

async function cmdUser(client, rest, flags) {
  checkPermissionFlag(flags);
  const [who] = rest;
  if (!who || !(ID_RE.test(who) || EMAIL_RE.test(who))) throw new UsageError('Usage: access.js user <domain> <e-mail|id> [--model <Model>]');
  if (flags.model && !MODEL_RE.test(flags.model)) throw new UsageError('--model is the object name, e.g. Deal.');
  const forbidden = [];
  const acc = await readModes(client, forbidden);
  const dir = await requireDirectory(client);
  const user = findUser(dir, who);
  if (!user) throw new Blocked(`No user ${who} on this account.`);
  const perms = permsOf(user, dir);
  const ctx = contextFor(user, dir);
  const specials = perms.filter((p) => p.startsWith('Special@'));
  return {
    user: userOut(user, dir),
    team: ctx.teamNames,
    recordSharingGroups: ctx.groupNames,
    company: idOf(user.company) || null,
    mfaRequired: specials.includes('Special@User.security.mfaRequired') || null,
    accountModes: acc.known ? acc.modes : 'unknown (admin only)',
    permissions: user.isAdmin ? ADMIN_NOTE : summarize(perms, flags.model),
    permissionSources: user.isAdmin ? undefined : sourcesOf(perms, rolesOf(user, dir, 'roles'), rolesOf(user, dir, 'revocationRoles'), flags.permission),
    notes: [
      'Record rules: "default" means own, assigned, collaborator, the record\'s teams and every record in the user\'s shared workspaces.',
      'An open session keeps the permissions it had at sign-in when a role is edited; it picks them up when the user\'s own roles change or at the next sign-in.',
    ],
    ...(dir.usersTruncated ? { warning: `Only the first ${MAX_USERS} users were read.` } : {}),
    ...(forbidden.length ? { forbidden } : {}),
  };
}

async function cmdRole(client, rest, flags) {
  const [ref] = rest;
  if (!ref || !NAME_RE.test(ref)) throw new UsageError('Usage: access.js role <domain> <name|keyname|id> [--model <Model>]');
  if (flags.model && !MODEL_RE.test(flags.model)) throw new UsageError('--model is the object name, e.g. Deal.');
  const dir = await requireDirectory(client);
  const all = [...dir.roles.values()];
  const key = ref.toLowerCase();
  let matches = all.filter((r) => idOf(r) === ref || String(r.keyname || '').toLowerCase() === key || String(r.roleName || '').toLowerCase() === key);
  if (!matches.length) matches = all.filter((r) => String(r.roleName || '').toLowerCase().includes(key));
  if (!matches.length) throw new Blocked(`No role matches "${ref}".`);
  if (matches.length > 1) {
    return { ambiguous: true, matches: matches.slice(0, 20).map((r) => ({ _id: idOf(r), roleName: r.roleName, keyname: r.keyname })), nextStep: 'Ask the user which one, then run role with its id.' };
  }
  const role = matches[0];
  const rid = idOf(role);
  const holders = dir.users.filter((u) => ids(u.roles).includes(rid));
  const revoking = dir.users.filter((u) => ids(u.revocationRoles).includes(rid));
  return {
    role: {
      _id: rid, roleName: role.roleName, keyname: role.keyname, system: !!role.system, description: role.description || null, permissionsCount: (role.permissions || []).length,
    },
    permissions: summarize(role.permissions || [], flags.model),
    heldBy: { count: holders.length, users: holders.slice(0, 50).map((u) => ({ ...person(u), status: u.status || null, isAdmin: !!u.isAdmin })) },
    usedAsRevocationBy: revoking.map(person),
    notes: [
      'A user\'s access is the union of all their roles minus their revocation roles; this role alone may not explain it (run user).',
      'ProtectedField permissions FORBID writing those fields; they never grant anything.',
      role.system ? 'System roles are rebuilt by the platform; an admin copies one to customise it.' : 'Edited in the app by an admin.',
    ],
  };
}

async function cmdRoles(client) {
  const dir = await requireDirectory(client);
  const rows = [...dir.roles.values()].map((r) => {
    const rid = idOf(r);
    return {
      _id: rid, roleName: r.roleName, keyname: r.keyname, system: !!r.system, permissionsCount: (r.permissions || []).length, users: dir.users.filter((u) => ids(u.roles).includes(rid)).length,
    };
  }).sort((a, b) => b.users - a.users || String(a.roleName).localeCompare(String(b.roleName)));
  return { count: rows.length, inUse: rows.filter((r) => r.users).length, roles: rows };
}

async function cmdAdmins(client) {
  const { rows } = await listAll(client, '/v2/user', { select: 'firstName lastName email status isAdmin isAccountOwner lastLogin', xquery: { isAdmin: true } });
  const admins = rows.filter((u) => u.isAdmin === true);
  return {
    count: admins.length,
    active: admins.filter((u) => u.status === 'Active').length,
    admins: admins.map((u) => ({ ...person(u), status: u.status || null, isAccountOwner: !!u.isAccountOwner, lastLogin: u.lastLogin || null })),
    notes: [ADMIN_NOTE, 'Removing admin rights is done by another admin in the app (Users).'],
  };
}

function parseAction(flags, allowAll) {
  const a = flags.action || (allowAll ? 'all' : 'view');
  if (!(ACTIONS.includes(a) || (allowAll && a === 'all'))) throw new UsageError(`--action is ${allowAll ? 'view, edit, delete or all' : 'view, edit or delete'}.`);
  return a === 'all' ? ACTIONS : [a];
}

function verdict(user, perms, acc, model, attrs, record, action, ctx) {
  const resource = resourceGate({
    user, perms, modes: acc.modes, model, action,
  });
  const rec = recordGate({
    user, perms, modes: acc.modes, model, attrs, record, action, ctx, prefRecordPermissions: acc.recordPermissions,
  });
  let can = resource.ok && rec.ok;
  if (resource.ok && rec.ok === null) can = null;
  return { action, can, resourceGate: resource, recordGate: rec };
}

async function cmdCan(client, rest, flags) {
  const [who, model, recordId] = rest;
  if (!who || !model || !recordId || !(who === 'me' || ID_RE.test(who) || EMAIL_RE.test(who))
    || !MODEL_RE.test(model) || !ID_RE.test(recordId)) {
    throw new UsageError('Usage: access.js can <domain> <e-mail|id|me> <Model> <recordId> [--action view|edit|delete|all]');
  }
  const actions = parseAction(flags, true);
  const m = await me(client);
  const attrs = attrsOf(m, model);
  const forbidden = [];
  const acc = await readModes(client, forbidden);
  const self = who === 'me' || who === idOf(m.profile) || String(who).toLowerCase() === String(m.profile.email || '').toLowerCase();

  // The real answer for the profile's own user: read it and see what the server says.
  let live = null;
  if (self) {
    const status = await probe(client, `/v2/${model.toLowerCase()}/${recordId}?select=_id`);
    live = {
      view: status === 200 ? 'visible' : status === 403 ? 'exists but not visible to this user' : status === 404 ? 'does not exist' : `answered ${status}`,
      status,
    };
  }
  if (!m.isAdmin) {
    if (!self) throw Object.assign(new Error('Only an admin profile can evaluate another user (403 on the user directory).'), { status: 403 });
    // Own rules from /me; teams, groups and the account mode stay unknown to a non-admin.
    const p = m.profile;
    const perms = effectivePermissions((p.roles || []).filter((r) => r && typeof r === 'object'), (p.revocationRoles || []).filter((r) => r && typeof r === 'object'));
    const record = live.status === 200 ? await readRecord(client, model, recordId, attrs) : null;
    const results = record ? actions.map((a) => verdict(p, perms, acc, model, attrs, record, a, {})) : null;
    return {
      user: person(p),
      record: record ? { model, _id: recordId, createdBy: idOf(record.createdBy) || null, assignee: attrs.has('assignee') ? idOf(record.assignee) || null : undefined, workspaceId: attrs.has('workspace') ? idOf(record.workspace) || null : undefined } : { model, _id: recordId },
      live,
      ...(results ? { results } : {}),
      method: 'live read (the server\'s answer for viewing) + own rules',
      notes: [
        'This profile is not an admin: it cannot read other users, teams, groups or the account mode (Strict/Owned assumed). The live read is the authority for viewing; edit and delete are never tried.',
        ...(record ? [] : ['The record cannot be read, so its fields cannot be compared with the rules.']),
      ],
      ...(forbidden.length ? { forbidden } : {}),
    };
  }
  const dir = await requireDirectory(client);
  const user = self ? findUser(dir, idOf(m.profile)) : findUser(dir, who);
  if (!user) throw new Blocked(`No user ${who} on this account.`);
  const status = await probe(client, `/v2/${model.toLowerCase()}/${recordId}?select=_id`);
  if (status === 404) throw new Blocked(`${model} ${recordId} does not exist on this account.`);
  if (status !== 200) throw Object.assign(new Error(`GET /v2/${model.toLowerCase()}/${recordId} answered ${status}`), { status });
  const record = await readRecord(client, model, recordId, attrs);
  const perms = permsOf(user, dir);
  const ctx = contextFor(user, dir);
  const results = actions.map((a) => verdict(user, perms, acc, model, attrs, record, a, ctx));
  const notes = [];
  if (user.status && user.status !== 'Active') notes.push(`The user is ${user.status}: an inactive user cannot sign in or use any token, whatever the rules say.`);
  if (results.some((r) => r.recordGate.granted.includes('recordInUsersSharedWorkspace'))) notes.push('Shared workspaces open every record in them (view and edit), even in Owned mode, unless a same-team/company/group rule restricts that action.');
  if (results.some((r) => r.recordGate.granted.includes('approverSeesExceptionsWithoutWorkspace'))) notes.push('Users who may decide commercial exceptions also see every exception whose deal has no workspace, on any deal.');
  if (PARENT_DERIVED.has(model)) notes.push(`${model} takes its access from its report or dashboard: run can on that record.`);
  if (!acc.known) notes.push('Account modes could not be read; Strict/Owned was assumed.');
  return {
    user: userOut(user, dir),
    record: {
      model, _id: recordId, createdBy: idOf(record.createdBy) || null, assignee: attrs.has('assignee') ? idOf(record.assignee) || null : undefined, workspace: attrs.has('workspace') ? (record.workspace ? wsName(dir, record.workspace) : null) : undefined,
    },
    accountModes: acc.modes,
    results,
    ...(live ? { live } : {}),
    method: self ? 'rules + live read' : 'rules evaluated from the platform code (no impersonation)',
    notes,
  };
}

async function cmdWho(client, rest, flags) {
  const [model, recordId] = rest;
  if (!model || !recordId || !MODEL_RE.test(model) || !ID_RE.test(recordId)) throw new UsageError('Usage: access.js who <domain> <Model> <recordId> [--action view|edit|delete]');
  const [action] = parseAction(flags, false);
  const m = await me(client);
  if (!m.isAdmin) throw Object.assign(new Error('Only an admin profile can list who reaches a record (403 on the user directory).'), { status: 403 });
  const attrs = attrsOf(m, model);
  const forbidden = [];
  const acc = await readModes(client, forbidden);
  const status = await probe(client, `/v2/${model.toLowerCase()}/${recordId}?select=_id`);
  if (status === 404) throw new Blocked(`${model} ${recordId} does not exist on this account.`);
  const record = await readRecord(client, model, recordId, attrs);
  const dir = await requireDirectory(client);
  const allowed = [];
  const denied = [];
  dir.users.filter((u) => u.status === 'Active' || u.active === true).forEach((u) => {
    const v = verdict(u, permsOf(u, dir), acc, model, attrs, record, action, contextFor(u, dir));
    const row = { ...person(u), isAdmin: !!u.isAdmin };
    if (v.can) allowed.push({ ...row, by: u.isAdmin ? ['admin'] : v.recordGate.granted });
    else denied.push({ ...row, reason: !v.resourceGate.ok ? v.resourceGate.by : 'recordRule' });
  });
  return {
    record: { model, _id: recordId, workspace: record.workspace ? wsName(dir, record.workspace) : null },
    action,
    accountModes: acc.modes,
    allowed: { count: allowed.length, users: allowed },
    deniedCount: denied.length,
    denied: denied.slice(0, 50),
    notes: [
      'Active users only. Inactive users cannot sign in.',
      ...(PARENT_DERIVED.has(model) ? [`${model} takes its access from its report or dashboard: run who on that record.`] : []),
    ],
    ...(dir.usersTruncated ? { warning: `Only the first ${MAX_USERS} users were read.` } : {}),
  };
}

async function cmdSettings(client) {
  const forbidden = [];
  const acc = await readModes(client, forbidden);
  if (!acc.known) throw Object.assign(new Error('Account security settings are admin only.'), { status: 403 });
  const sec = acc.security;
  const roles = await loadRoles(client);
  const rules = (await listAll(client, '/v2/authenticationrule', { select: 'authenticationRuleName allowedDomains allowedEmails inherit active userLicenseAllocation' }, 500)).rows;
  const workspaces = (await listAll(client, '/v2/workspace', { select: 'workspaceName' }, 1000)).rows;
  const dir = { workspaces };
  const roleName = (rid) => (roles.get(idOf(rid)) || {}).roleName || idOf(rid);
  const allowEveryone = Object.entries(acc.recordPermissions)
    .filter(([, v]) => v && v.allowEveryone && (v.allowEveryone.view || v.allowEveryone.edit))
    .map(([model, v]) => ({ model, view: !!v.allowEveryone.view, edit: !!v.allowEveryone.edit }));
  const providers = Object.entries(sec.oauthProviders || {}).map(([name, v]) => ({ provider: name, enabled: !!v.enabled, signIn: v.allowSingIn === undefined ? null : !!v.allowSingIn }));
  return {
    accountModes: acc.modes,
    allowEveryoneByObject: allowEveryone,
    mfa: sec.mfa ? { requiredForAll: !!sec.mfa.requiredForAll, requiredForAdmins: !!sec.mfa.requiredForAdmins } : null,
    sessionDays: sec.token && typeof sec.token === 'object' ? sec.token.expirationDays || null : null,
    passwordPolicy: sec.passwordPolicy ? { lifetimeDays: sec.passwordPolicy.passwordLifetimeDays || null, requireChange: !!sec.passwordPolicy.requirePasswordChange, preventReuse: !!sec.passwordPolicy.preventPasswordReuse } : null,
    newUsersDefaultRoles: ((sec.newUsers || {}).defaultRoles || []).map(roleName),
    signInProviders: providers,
    authenticationRules: rules.map((r) => ({
      _id: idOf(r),
      name: r.authenticationRuleName,
      active: r.active !== false,
      domains: r.allowedDomains || [],
      emailsCount: (r.allowedEmails || []).length,
      givesRoles: ids((r.inherit || {}).roles).map(roleName),
      givesRevocationRoles: ids((r.inherit || {}).revocationRoles).map(roleName),
      givesPrimaryWorkspace: (r.inherit || {}).primaryWorkspace ? wsName(dir, r.inherit.primaryWorkspace) : null,
      givesSharedWorkspaces: ids((r.inherit || {}).sharedWorkspaces).map((w) => wsName(dir, w)),
      licenseLimit: r.userLicenseAllocation || null,
    })),
    notes: [
      'Strict: a non-admin needs a role permission for every action. Unrestricted: a user without roles can call everything.',
      'Authentication rules only act when someone signs in with Google, Microsoft or Okta: a matching e-mail without an account gets a new user with these roles and workspaces. Existing users are not changed.',
      'These settings are changed by an admin in the app (Settings → Security); this skill never writes them.',
    ],
  };
}

async function cmdTokens(client) {
  const m = await me(client);
  const current = new Set(m.permissions);
  const { rows } = await listAll(client, '/v2/token', { select: 'appName description tokenType provider createdAt expiresAt lastActivity roles scopes', sort: '-createdAt' }, 200);
  const roleNames = new Map((m.profile.roles || []).filter((r) => r && typeof r === 'object').map((r) => [idOf(r), r.roleName]));
  const now = Date.now();
  const tokens = rows.map((t) => {
    const scopes = Array.isArray(t.scopes) ? t.scopes : [];
    const extra = m.isAdmin ? [] : scopes.filter((s) => !current.has(s));
    return {
      type: t.tokenType || null,
      name: t.appName || null,
      provider: t.provider || null,
      createdAt: t.createdAt || null,
      expiresAt: t.expiresAt || null,
      expired: t.expiresAt ? new Date(t.expiresAt).getTime() < now : false,
      neverExpires: !t.expiresAt,
      lastActivity: t.lastActivity || null,
      roles: ids(t.roles).map((rid) => roleNames.get(rid) || rid),
      scopesCount: scopes.length,
      wildcardScopes: scopes.filter((s) => s.includes('*.*')),
      keepsPermissionsUserNoLongerHas: extra.length ? { count: extra.length, sample: extra.slice(0, 10) } : null,
    };
  });
  return {
    user: person(m.profile),
    count: tokens.length,
    apiTokens: tokens.filter((t) => t.type === 'API').length,
    sessions: tokens.filter((t) => t.type === 'Session').length,
    tokens,
    notes: [
      'The platform only lists the tokens of the profile\'s own user, even for an admin. The key itself is never shown.',
      'An API token keeps the scopes it was created with: removing a role from the user does not narrow it. Deactivating the user stops all of them.',
      'A user revokes their tokens in the app (profile → API tokens / sessions); this skill never deletes them.',
    ],
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = ['profile', 'model', 'action', 'permission'];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--') && valued.includes(arg.slice(2))) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[arg.slice(2)] = argv[i];
    } else if (['--confirmed', '--reaches-people', '--version'].includes(arg)) {
      throw new UsageError('This script is read-only: it changes nothing. Roles, users, tokens and settings are changed by an admin in the app.');
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  whoami: cmdWhoami,
  user: cmdUser,
  role: cmdRole,
  roles: cmdRoles,
  admins: cmdAdmins,
  can: cmdCan,
  who: cmdWho,
  settings: cmdSettings,
  tokens: cmdTokens,
};

const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; only an admin can review other users.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: access.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    const base = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    // Read-only: refuse any verb but GET before it reaches the network.
    client = {
      ...base,
      request: (method, reqPath, o) => {
        if (String(method).toUpperCase() !== 'GET') throw new UsageError('This script is read-only: it only sends GET requests.');
        return base.request('GET', reqPath, o);
      },
    };
    const result = await handler(client, rest, flags);
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
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
  main, sourcesOf, effectivePermissions, summarize, resourceGate, recordGate, contextFor, parsePermission,
};
