/* global describe, test, expect, beforeEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ac = require('../.claude/skills/prolibu-access-review/scripts/access');

const D = 'dev99.example.com';
const KEY = 'SECRET123';
const SELLER_KEY = 'SELLERKEY456';
const TOKEN_VALUE = 'tok-VALUE-never-print';
const id = (c) => c.repeat(24);
const ADMIN = id('1');
const SELLER = id('2');
const OTHER = id('3');
const TEAMMATE = id('4');
const WS_A = id('a');
const WS_B = id('b');
const WS_C = id('c');
const ROLE_SALES = id('5');
const ROLE_PRICING = id('6');
const ROLE_REVOKE = id('7');
const DEAL_OWN = id('8');
const DEAL_SHARED = id('9');
const DEAL_FOREIGN = id('d');
const CE_NO_WS = id('e');
const TEAM = id('f');

const ATTRS = new Set(['createdBy', 'assignee', 'collaborators', 'workspace']);
const sellerUser = {
  _id: SELLER, isAdmin: false, primaryWorkspace: WS_A, sharedWorkspaces: [WS_A, WS_B], team: null, company: null,
};
const MODES = { resourceAccessMode: 'Strict', recordAccessMode: 'Owned' };
const gate = (over) => ac.recordGate({
  user: sellerUser, perms: [], modes: MODES, model: 'Deal', attrs: ATTRS, record: {}, action: 'view', ctx: {}, prefRecordPermissions: {}, ...over,
});

describe('permission math', () => {
  test('effective permissions are the union of roles minus revocation roles', () => {
    const perms = ac.effectivePermissions(
      [{ permissions: ['Resource@Deal.find', 'Resource@Deal.delete'] }, { permissions: ['Resource@Contact.find'] }],
      [{ permissions: ['Resource@Deal.delete'] }],
    );
    expect(perms).toEqual(['Resource@Contact.find', 'Resource@Deal.find']);
  });

  test('sourcesOf names the roles that give and take away a permission, wildcards included', () => {
    const src = ac.sourcesOf(
      ['Resource@Token.*', 'Special@CommercialException.allow.decide'],
      [{ roleName: 'Sales', permissions: ['Resource@Token.*'] }, { roleName: 'Pricing', permissions: ['Resource@Token.*', 'Special@CommercialException.allow.decide'] }],
      [{ roleName: 'No delete', permissions: ['Resource@Deal.delete'] }],
      'Resource@Deal.delete',
    );
    expect(src['Resource@Token.create']).toEqual({ held: true, grantedBy: ['Sales', 'Pricing'], revokedBy: [] });
    expect(src['Special@CommercialException.allow.decide'].grantedBy).toEqual(['Pricing']);
    expect(src['Resource@Deal.delete']).toEqual({ held: false, grantedBy: [], revokedBy: ['No delete'] });
  });

  test('summarize groups actions, record rules (default when none) and protected fields', () => {
    const s = ac.summarize(['Resource@Deal.find', 'Resource@Deal.update', 'Record@Deal.view.sameTeamUsers', 'ProtectedField@Deal.update.assignee', 'Special@*.allowDeleteBy.*']);
    expect(s.models.Deal.actions).toEqual(['find', 'update']);
    expect(s.models.Deal.record.view).toEqual(['sameTeamUsers']);
    expect(s.models.Deal.record.edit).toEqual(['default']);
    expect(s.models.Deal.protectedFieldsCount).toBe(1);
    expect(s.specials).toEqual(['Special@*.allowDeleteBy.*']);
  });

  test('action gate needs the action, a model wildcard or the global wildcard', () => {
    expect(ac.resourceGate({ user: sellerUser, perms: ['Resource@Deal.findOne'], modes: MODES, model: 'Deal', action: 'view' }).ok).toBe(true);
    const no = ac.resourceGate({ user: sellerUser, perms: ['Resource@Deal.findOne'], modes: MODES, model: 'Deal', action: 'edit' });
    expect(no.ok).toBe(false);
    expect(no.needs).toEqual(['Resource@Deal.update']);
    expect(ac.resourceGate({ user: sellerUser, perms: [], modes: MODES, model: 'Deal', action: 'view' }).by).toBe('strictModeNoRoles');
    expect(ac.resourceGate({ user: sellerUser, perms: [], modes: { ...MODES, resourceAccessMode: 'Unrestricted' }, model: 'Deal', action: 'view' }).ok).toBe(true);
    expect(ac.resourceGate({ user: { ...sellerUser, isAdmin: true }, perms: [], modes: MODES, model: 'Deal', action: 'delete' }).by).toBe('admin');
  });
});

describe('record gate (port of the server filter)', () => {
  test('owner, assignee and collaborator reach the record', () => {
    expect(gate({ record: { createdBy: SELLER } }).granted).toContain('createdByUser');
    expect(gate({ record: { createdBy: OTHER, assignee: SELLER } }).granted).toContain('assignedToUser');
    expect(gate({ record: { createdBy: OTHER, collaborators: [SELLER] } }).granted).toContain('collaboratorOnRecord');
    expect(gate({ record: { createdBy: OTHER, workspace: WS_C } }).ok).toBe(false);
  });

  test('a shared workspace opens view and edit of others\' records, not delete', () => {
    const rec = { createdBy: OTHER, workspace: WS_B };
    expect(gate({ record: rec }).granted).toEqual(['recordInUsersSharedWorkspace']);
    expect(gate({ record: rec, action: 'edit' }).ok).toBe(true);
    const del = gate({ record: rec, action: 'delete', perms: ['Resource@Deal.delete'] });
    expect(del.ok).toBe(false);
    expect(del.notes.join(' ')).toMatch(/deleteOwnOnly/);
    expect(gate({ record: rec, action: 'delete', perms: ['Resource@Deal.delete', 'Special@*.allowDeleteBy.*'] }).ok).toBe(true);
  });

  test('a same-team rule restricts: shared workspaces stop widening, teammates count', () => {
    const perms = ['Record@Deal.view.sameTeamUsers'];
    expect(gate({ perms, record: { createdBy: OTHER, workspace: WS_B } }).ok).toBe(false);
    const ok = gate({ perms, record: { createdBy: TEAMMATE, workspace: WS_C }, ctx: { teammateIds: [TEAMMATE] } });
    expect(ok.granted).toContain('roleRuleSameTeam');
    // Edit has no rule of its own: capped by the restricted view.
    const edit = gate({ perms, action: 'edit', record: { createdBy: OTHER, workspace: WS_B } });
    expect(edit.ok).toBe(false);
    expect(edit.notes.join(' ')).toMatch(/cappedByView/);
  });

  test('ownedOrAssigned adds a condition on top of the other branches', () => {
    const perms = ['Record@Deal.view.ownedOrAssigned'];
    expect(gate({ perms, record: { createdBy: OTHER, workspace: WS_B } }).ok).toBe(false);
    expect(gate({ perms, record: { createdBy: OTHER, assignee: SELLER, workspace: WS_B } }).ok).toBe(true);
  });

  test('a role wildcard reaches every record of the user\'s workspaces', () => {
    const r = gate({ perms: ['Record@Deal.view.*'], record: { createdBy: OTHER, workspace: WS_A } });
    expect(r.granted).toContain('roleRuleAllInMyWorkspaces');
  });

  test('approvers see commercial exceptions without workspace, others do not', () => {
    const args = { model: 'CommercialException', attrs: new Set(['createdBy', 'workspace']), record: { createdBy: OTHER, workspace: null } };
    expect(gate(args).ok).toBe(false);
    const r = gate({ ...args, perms: ['Special@CommercialException.allow.decide'] });
    expect(r.granted).toEqual(['approverSeesExceptionsWithoutWorkspace']);
    expect(gate({ ...args, perms: ['Special@CommercialException.allow.decide'], record: { createdBy: OTHER, workspace: WS_C } }).ok).toBe(false);
  });

  test('admin, account modes and allowEveryone open everything; pages defer to the parent', () => {
    expect(gate({ user: { ...sellerUser, isAdmin: true }, record: { createdBy: OTHER } }).granted).toEqual(['admin']);
    expect(gate({ modes: { ...MODES, recordAccessMode: 'Unrestricted' }, record: { createdBy: OTHER } }).ok).toBe(true);
    expect(gate({ modes: { ...MODES, recordAccessMode: 'Observer' }, record: { createdBy: OTHER } }).ok).toBe(true);
    expect(gate({ modes: { ...MODES, recordAccessMode: 'Observer' }, action: 'edit', record: { createdBy: OTHER } }).ok).toBe(false);
    expect(gate({ prefRecordPermissions: { Deal: { allowEveryone: { view: true } } }, record: { createdBy: OTHER } }).granted).toEqual(['accountAllowEveryone']);
    expect(gate({ model: 'Page', record: { createdBy: OTHER } }).ok).toBeNull();
  });

  test('teammates come from the user\'s team field and from team member lists', () => {
    const dir = {
      users: [{ _id: SELLER, team: TEAM }, { _id: TEAMMATE, team: TEAM }, { _id: OTHER, team: null }],
      teams: [{ _id: TEAM, teamName: 'North', users: [OTHER] }],
      groups: [{ _id: id('0'), userGroupName: 'Share', users: [SELLER, OTHER] }],
    };
    const ctx = ac.contextFor({ _id: SELLER, team: TEAM }, dir);
    expect(ctx.teammateIds.sort()).toEqual([OTHER, SELLER, TEAMMATE].sort());
    expect(ctx.groupUserIds).toEqual([OTHER]);
    expect(ctx.teamNames).toEqual(['North']);
  });
});

// ─── CLI against a fake server ─────────────────────────────────────────────────

let rootDir;
let out;
let err;
let calls;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}
const list = (rows) => ({ pagination: { count: rows.length, page: 1, lastPage: 1 }, data: rows });

const roles = [
  { _id: ROLE_SALES, roleName: 'Profile - Sales Agent', keyname: 'profile-sales-agent', system: true, permissions: ['Resource@Deal.findOne', 'Resource@Deal.update', 'Resource@Deal.delete', 'Resource@Token.*'] },
  { _id: ROLE_PRICING, roleName: 'Profile - Pricing Manager', keyname: 'profile-pricing-manager', system: true, permissions: ['Resource@CommercialException.findOne', 'Special@CommercialException.allow.decide'] },
  { _id: ROLE_REVOKE, roleName: 'No delete', keyname: 'no-delete', system: false, permissions: ['Resource@Deal.delete'] },
];
const users = [
  { _id: ADMIN, firstName: 'Ada', email: 'ada@example.com', isAdmin: true, status: 'Active', roles: [] },
  { _id: SELLER, firstName: 'Sam', email: 'sam@example.com', isAdmin: false, status: 'Active', roles: [ROLE_SALES, ROLE_PRICING], revocationRoles: [], primaryWorkspace: WS_A, sharedWorkspaces: [WS_A, WS_B] },
  { _id: OTHER, firstName: 'Olga', email: 'olga@example.com', isAdmin: false, status: 'Active', roles: [ROLE_SALES], revocationRoles: [ROLE_REVOKE], primaryWorkspace: WS_C, sharedWorkspaces: [] },
];
const records = {
  [`deal/${DEAL_OWN}`]: { _id: DEAL_OWN, createdBy: SELLER, workspace: WS_A },
  [`deal/${DEAL_SHARED}`]: { _id: DEAL_SHARED, createdBy: OTHER, assignee: OTHER, workspace: WS_B },
  [`deal/${DEAL_FOREIGN}`]: { _id: DEAL_FOREIGN, createdBy: OTHER, workspace: WS_C },
  [`commercialexception/${CE_NO_WS}`]: { _id: CE_NO_WS, createdBy: ADMIN, workspace: null },
};
const sellerSees = new Set([`deal/${DEAL_OWN}`, `deal/${DEAL_SHARED}`, `commercialexception/${CE_NO_WS}`]);

async function fakeFetch(url, init) {
  const u = new URL(url);
  const p = u.pathname;
  const seller = init.headers.Authorization === `Bearer ${SELLER_KEY}`;
  calls.push({ method: init.method, path: p, seller });
  if (init.method !== 'GET') return respond(500, { error: 'the test server only answers GET' });
  if (p === '/v2/user/me') {
    const prof = seller
      ? { ...users[1], roles: [roles[0], roles[1]], revocationRoles: [], selectableWorkspaces: [{ _id: WS_A, workspaceName: 'A' }, { _id: WS_B, workspaceName: 'B' }] }
      : users[0];
    return respond(200, {
      profile: prof,
      permissions: seller ? [...roles[0].permissions, ...roles[1].permissions, 'Resource@User.me'] : [],
      modelSchemas: { Deal: { createdBy: {}, assignee: {}, collaborators: {}, workspace: {} }, CommercialException: { createdBy: {}, workspace: {} } },
    });
  }
  if (seller && /^\/v2\/(preference|user$|role|team|usergroup|workspace|authenticationrule)/.test(p)) {
    return respond(403, { error: 'Forbidden. User has no permission.' });
  }
  if (p === '/v2/preference/read') {
    return respond(200, {
      preference: {
        security: {
          permissionsMode: { resourceAccessMode: 'Strict', recordAccessMode: 'Owned', recordPermissions: {} },
          token: { expirationDays: 30, secret: TOKEN_VALUE },
          mfa: { requiredForAll: false, requiredForAdmins: true },
          newUsers: { defaultRoles: [ROLE_SALES] },
          oauthProviders: { google: { enabled: true, allowSingIn: true, clientSecret: TOKEN_VALUE } },
        },
      },
    });
  }
  if (p === '/v2/user') return respond(200, list(u.searchParams.get('xquery') === '{"isAdmin":true}' ? users.filter((x) => x.isAdmin) : users));
  if (p === '/v2/role') return respond(200, list(roles));
  if (p === '/v2/team' || p === '/v2/usergroup') return respond(200, list([]));
  if (p === '/v2/workspace') return respond(200, list([{ _id: WS_A, workspaceName: 'A' }, { _id: WS_B, workspaceName: 'B' }, { _id: WS_C, workspaceName: 'C' }]));
  if (p === '/v2/authenticationrule') return respond(200, list([{ _id: id('0'), authenticationRuleName: 'Staff', allowedDomains: ['example.com'], allowedEmails: [], inherit: { roles: [ROLE_SALES] }, active: true }]));
  if (p === '/v2/token') {
    return respond(200, list([
      { _id: id('0'), tokenType: 'API', appName: 'Zapier', apiKey: TOKEN_VALUE, apiKeyLastDigits: '1234', scopes: ['Resource@Deal.findOne', 'Resource@Contact.delete'], roles: [] },
      { _id: id('0'), tokenType: 'Session', expiresAt: '2099-01-01T00:00:00Z', scopes: ['Resource@Deal.findOne'], roles: [ROLE_SALES] },
    ]));
  }
  const m = p.match(/^\/v2\/(deal|commercialexception)\/([a-f0-9]{24})$/);
  if (m) {
    const key = `${m[1]}/${m[2]}`;
    if (!records[key]) return respond(404, { error: 'Not found' });
    if (seller && !sellerSees.has(key)) return respond(403, { error: 'Forbidden' });
    return respond(200, records[key]);
  }
  return respond(404, { error: `unexpected ${p}` });
}

const run = (argv) => ac.main([argv[0], D, ...argv.slice(1)], {
  rootDir,
  fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-access-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.vendedor.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  out = '';
  err = '';
  calls = [];
});

describe('access.js commands', () => {
  test('can: admin evaluates the seller on a deal of a shared workspace', async () => {
    expect(await run(['can', 'sam@example.com', 'Deal', DEAL_SHARED])).toBe(0);
    const r = json();
    const by = Object.fromEntries(r.results.map((x) => [x.action, x]));
    expect(by.view.can).toBe(true);
    expect(by.view.recordGate.granted).toEqual(['recordInUsersSharedWorkspace']);
    expect(by.edit.can).toBe(true);
    expect(by.delete.can).toBe(false);
    expect(r.notes.join(' ')).toMatch(/Shared workspaces open every record/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('can: a foreign deal is denied with the reason, revocation roles are applied', async () => {
    expect(await run(['can', 'olga@example.com', 'Deal', DEAL_OWN, '--action', 'delete'])).toBe(0);
    const v = json().results[0];
    expect(v.resourceGate).toMatchObject({ ok: false, by: 'missingPermission', needs: ['Resource@Deal.delete'] });
  });

  test('can me with the seller profile reads the record live and explains it', async () => {
    expect(await run(['can', 'me', 'CommercialException', CE_NO_WS, '--profile', 'vendedor'])).toBe(0);
    const r = json();
    expect(r.live.view).toBe('visible');
    expect(r.results[0].recordGate.granted).toEqual(['approverSeesExceptionsWithoutWorkspace']);
    out = '';
    expect(await run(['can', 'me', 'Deal', DEAL_FOREIGN, '--profile', 'vendedor'])).toBe(0);
    expect(json().live.view).toBe('exists but not visible to this user');
  });

  test('a missing record is blocked (exit 3)', async () => {
    expect(await run(['can', 'sam@example.com', 'Deal', id('0')])).toBe(3);
    expect(err).toMatch(/does not exist/);
  });

  test('seller profile: user stops at the first 403 with FORBIDDEN and no retry', async () => {
    expect(await run(['user', 'olga@example.com', '--profile', 'vendedor'])).toBe(1);
    expect(err).toMatch(/^FORBIDDEN/);
    expect(calls.filter((c) => c.path === '/v2/user')).toHaveLength(1);
    expect(calls.every((c) => c.seller)).toBe(true);
  });

  test('seller profile: who and can on another user refuse as forbidden', async () => {
    expect(await run(['who', 'Deal', DEAL_OWN, '--profile', 'vendedor'])).toBe(1);
    expect(err).toMatch(/FORBIDDEN/);
    err = '';
    expect(await run(['can', 'olga@example.com', 'Deal', DEAL_OWN, '--profile', 'vendedor'])).toBe(1);
    expect(err).toMatch(/FORBIDDEN/);
  });

  test('who lists the users that reach a record and why', async () => {
    expect(await run(['who', 'Deal', DEAL_SHARED])).toBe(0);
    const r = json();
    const emails = r.allowed.users.map((x) => x.email).sort();
    expect(emails).toEqual(['ada@example.com', 'olga@example.com', 'sam@example.com']);
    expect(r.allowed.users.find((x) => x.email === 'sam@example.com').by).toEqual(['recordInUsersSharedWorkspace']);
  });

  test('user shows roles, revocation roles and per-object rules', async () => {
    expect(await run(['user', 'olga@example.com'])).toBe(0);
    const r = json();
    expect(r.user.revocationRoles.map((x) => x.roleName)).toEqual(['No delete']);
    expect(r.permissions.models.Deal.actions).toEqual(['findOne', 'update']);
  });

  test('role resolves by name and lists holders; ambiguous names ask', async () => {
    expect(await run(['role', 'sales agent'])).toBe(0);
    expect(json().heldBy.count).toBe(2);
    out = '';
    expect(await run(['role', 'profile'])).toBe(0);
    expect(json().ambiguous).toBe(true);
  });

  test('admins and roles list', async () => {
    expect(await run(['admins'])).toBe(0);
    expect(json().admins.map((a) => a.email)).toEqual(['ada@example.com']);
    out = '';
    expect(await run(['roles'])).toBe(0);
    expect(json().roles[0]).toMatchObject({ roleName: 'Profile - Sales Agent', users: 2 });
  });

  test('settings reports modes and rules but never secrets', async () => {
    expect(await run(['settings'])).toBe(0);
    const r = json();
    expect(r.sessionDays).toBe(30);
    expect(r.mfa.requiredForAdmins).toBe(true);
    expect(r.newUsersDefaultRoles).toEqual(['Profile - Sales Agent']);
    expect(r.authenticationRules[0].givesRoles).toEqual(['Profile - Sales Agent']);
    expect(out).not.toContain(TOKEN_VALUE);
  });

  test('tokens never print the key and flag scopes the user no longer has', async () => {
    expect(await run(['tokens', '--profile', 'vendedor'])).toBe(0);
    expect(out).not.toContain(TOKEN_VALUE);
    expect(out).not.toContain('1234');
    const api = json().tokens.find((t) => t.type === 'API');
    expect(api.neverExpires).toBe(true);
    expect(api.keepsPermissionsUserNoLongerHas).toEqual({ count: 1, sample: ['Resource@Contact.delete'] });
  });

  test('write flags and bad input are refused before any request', async () => {
    expect(await run(['can', 'sam@example.com', 'Deal', DEAL_OWN, '--confirmed'])).toBe(2);
    expect(await run(['can', 'sam@example.com', 'deal', DEAL_OWN])).toBe(2);
    expect(await run(['can', 'sam@example.com', 'Deal', 'abc'])).toBe(2);
    expect(await run(['user', '{"$ne":null}'])).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
