# How Prolibu decides access

Read this when a verdict code needs explaining or a case falls outside SKILL.md.

## Permission strings

`<Type>@<Model>.<action>[.<key>]`, kept in roles (`Role.permissions`). The full list is
`GET /v2/permission/library` (`?organizedBy=resource` groups it by object).

| Type | Example | Meaning |
| --- | --- | --- |
| `Resource` | `Resource@Deal.update` | May call that action on the object. `find`/`findOne`/`search` read, `create`, `update`, `delete`, plus object-specific actions (`Quote.calculate`). `Resource@Deal.*` = every action; `Resource@*.*` = everything. |
| `Record` | `Record@Deal.view.sameTeamUsers` | Which records the action reaches (see below). Actions: `view`, `edit`, `delete`, `*`. |
| `ProtectedField` | `ProtectedField@Deal.update.assignee` | **Forbids** sending that field on that action (`*` = any write). Never grants. |
| `Special` | `Special@*.allowDeleteBy.assignee` | One-off switches (list below). |
| `CustomPermission` | `CustomPermission@…` | Free keys an account's own scripts check. |

A user's permissions = union of their roles' permissions − their revocation roles'
permissions. Some routes are open to any signed-in user without a permission (their own
profile, the permission library, notices settings).

### Specials

| Special | Effect |
| --- | --- |
| `Special@*.allowDeleteBy.*` | Delete records created by others (if the record gate lets them reach it). |
| `Special@*.allowDeleteBy.assignee` / `.collaborators` | Same, only when assignee / collaborator. |
| `Special@User.allow.manageRoles` / `manageWorkspaces` | A non-admin may change other users' roles / workspaces. Treat as admin-like. |
| `Special@User.security.mfaRequired` | MFA asked at sign-in. |
| `Special@CommercialException.allow.decide` | Approve or reject exceptions; also widens what exceptions are visible (below). |
| `Special@Meeting.allow.viewOthersEventDetails` | See details of others' meetings. |
| `Special@Product.minPrice.allowBreakRule` | Sell below the minimum price. |
| `Special@Proposal.status.approvedProposalCannotBeModifed` | Approved proposals locked. |
| `Special@Comment.forbbeden.updateOnTickets` / `deleteOnTickets` | Forbids editing / deleting ticket comments. |

## Account modes (`settings`)

- **resourceAccessMode**: `Strict` (a non-admin needs a permission for every action; no roles
  = nothing) or `Unrestricted` (a user **without roles** may call everything; a user with
  roles is still checked against them).
- **recordAccessMode**: `Owned` (default rule only), `Observer` (everyone views all, edits
  own), `Team …`, `Company …`, `Workspace …` (`Unrestricted` = view and edit the group's
  records; `Observer` = view only), `Unrestricted` (everyone reaches every record).
- **allowEveryone by object**: opens view and/or edit of one object to every user.

## Record gate: the codes in `recordGate.granted`

| Code | Why the record is reachable |
| --- | --- |
| `admin` | The user is an admin. |
| `accountModeUnrestricted` / `accountAllowEveryone` | Account-wide opening. |
| `createdByUser` | The user created it. |
| `assignedToUser` | The user is the assignee. |
| `collaboratorOnRecord` | The user is in `collaborators`. |
| `recordSharedWithUsersTeam` | The record's `teams` includes one of the user's teams. |
| `recordInUsersSharedWorkspace` | The record's workspace is one of the user's **shared workspaces**. Applies to view, edit and delete, in every mode. |
| `recordAllowEveryone.view` / `.edit` | The record itself is open to everyone. |
| `roleRuleAll` / `roleRuleAllInMyWorkspaces` | Role rule `Record@M.<action>.*`: all records in the user's primary and shared workspaces (all records if the user has none). |
| `roleRuleSameWorkspace` | `…sameWorkspaceUsers`: records in the user's primary or shared workspaces. |
| `roleRuleSameTeam` | `…sameTeamUsers`: created by, assigned to or shared with a teammate. Teammates come from the user's `team` field **and** from teams whose member list includes the user. |
| `roleRuleSameCompany` | `…sameCompanyUsers`: same, for users of the same company. |
| `roleRuleSameRecordSharingGroup` | `…sameGroupUsers`: same, for members of a user group of type *Record Sharing*. |
| `accountModeTeam` / `accountModeCompany` / `accountModeWorkspace` / `accountModeObserver` | The account's record mode. |
| `userDirectorySameWorkspace` | Users are visible to colleagues of the same workspace (for @mentions). |
| `approverSeesExceptionsWithoutWorkspace` | A user with `allow.decide` sees and edits every commercial exception whose deal has no workspace. |
| `inheritsFromParent` | Page or Widget: decided by the parent report/dashboard (`can` returns `null`). |

Restricting rules and caps (`recordGate.notes`):

- `roleRuleRestricts`: with a same-team / company / group rule for the action (and no
  wildcard), only own, assigned, collaborator, record teams, record allowEveryone, the rule's
  set and `sameWorkspaceUsers` count. Shared workspaces and the account mode stop widening it.
- `roleRuleOwnedOrAssigned`: `…ownedOrAssigned` adds a condition: the user must also be
  creator, assignee or collaborator.
- `cappedByView`: edit/delete without their own rule are limited to what the user can view
  when the view is restricted.
- `deleteOwnOnly`: delete by a non-admin needs to be the creator unless a `Special@*.allowDeleteBy…`.

## Action gate codes (`resourceGate.by`)

`admin`, the permission that matched (`Resource@Deal.update`), `missingPermission` with
`needs`, `strictModeNoRoles`, `unrestrictedModeNoRoles`, `workspaceViewOpen`.

## Tokens and sessions

- A **session** (sign-in) copies the user's permissions when it starts and lasts the account's
  `sessionDays`. When an admin changes a user's own roles, the user's sessions are refreshed.
  When an admin edits a **role**, open sessions keep the old permissions until the next sign-in.
- An **API token** is created by the user (any role with `Resource@Token.create` or
  `Resource@Token.*`) with their current permissions, a subset of them, or some of their roles.
  It has no expiry unless one is set and keeps its scopes when the user's roles change. An
  admin's API token with scopes is limited to those scopes. Deactivating the user stops every
  token. Tokens cannot be edited, only deleted by their owner.
- The platform lists only the profile's own tokens, even to an admin. Never print the key.

## Authentication rules

Each rule has allowed domains and e-mails and what a new user inherits (roles, revocation
roles, primary and shared workspaces, company). It applies only to sign-in with Google,
Microsoft or Okta and only creates users; existing users keep their access. An inactive
matching rule blocks that sign-in. A rule can also deactivate users that the Google or
Microsoft directory no longer has (an admin runs it in the app).

## What the evaluation cannot see

- Special routes (proposal wizard, public links, exports, reports, AI tools) may apply other
  checks; `can` covers the object's standard read, edit and delete.
- A non-admin profile cannot read teams, groups, other users or the account mode; `can me`
  then relies on the live read for viewing.
