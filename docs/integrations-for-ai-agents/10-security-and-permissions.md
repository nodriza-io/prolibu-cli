# Security & Permissions

> Salesforce analogy: this area maps onto **Profiles + Permission Sets** (`role`, a bag of permission strings assigned to users and keys), **Sharing rules / Org-Wide Defaults** (record-level access modes that decide *which records* a caller sees), **Field-Level Security** (`ProtectedField@...` locks on individual fields), and **Orgs / workspaces** (tenant isolation and the `workspace` partition inside a tenant).

## When to use this

Read this before you build any integration that **reads or writes data on someone's behalf**. You need to decide: under which identity the integration runs (a dedicated service user + an API key), the *minimum* permissions to grant that identity, and how to guarantee it only touches the records it should. Every call you make through the [REST API](03-rest-api.md) passes through two authorization layers — an **object layer** ("may you call this operation on this object?") and a **record layer** ("which specific records may you see or change?"). This document explains both as configuration and policy, so a `403` in production never surprises you and no data leaks across tenants.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Applies at |
|---|---|---|
| `role` (a bag of `Resource@` / `Record@` / `ProtectedField@` / `Special@` strings) | Profile **+** Permission Set | Assigned to `user.roles` |
| `revocationRoles` on a user | A restriction / "muted" permission set (subtracts permissions) | Effective-permission computation |
| `Resource@<Model>.<fn>` scope | Object-Level Security (CRUD on a Profile) | Object layer |
| Record access mode + record-sharing permissions | Org-Wide Defaults + Sharing Rules + Role Hierarchy | Record layer (list / read / update / delete) |
| `ProtectedField@<Model>.<action>.<field>` | Field-Level Security (FLS) | Object layer (on write) |
| `Special@...` capability strings | System Permissions (e.g. "Modify All Data") | Escalation & delete guards |
| `isAdmin` | System Administrator | Short-circuits both layers |
| `team` / record-sharing groups | Public Groups / Sharing Teams | Record layer |
| `workspace` (primary / shared / selectable) | Restriction Rules / partition by unit | Create + record layer |
| A separate account domain (tenant) | **Org** (a complete, isolated tenant) | Everything |
| API key (`token`, `tokenType: "API"`, `scopes`) | Connected App / OAuth scopes | Object layer |

> **Rule of thumb.** Two layers, two questions. The *object layer* asks "can this credential call `create`/`update`/`find`/… on this object?" and is governed by the credential's **scopes**. The *record layer* asks "of the records this operation could touch, which are visible to this caller?" and is governed by the account's **record access mode** plus any record-sharing permissions. A credential can pass the object layer and still see zero records, and vice-versa.

All endpoints below live under the versioned prefix `/v2/`. Resource paths in the URL are **lowercase** (`/v2/token`, `/v2/role`, `/v2/workspace`), while JSON field names are camelCase. See [REST API](03-rest-api.md) for the shared request/response conventions and [Authentication & Connected Apps](04-authentication-and-connected-apps.md) for how credentials are issued.

Sibling docs: [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [AI & MCP](08-ai-and-mcp.md) · [Best Practices](11-best-practices.md).

---

## 1. The two-layer model

Authorization is enforced at two distinct points. Internalizing this is most of the work.

1. **Object layer — "may you invoke this operation on this object?"** A gate applied per route. The caller's credential carries a set of **scopes**; the operation requires one of the object-level permissions for the model and function it targets. This is object-level CRUD, exactly like a Profile's CRUD checkboxes.

2. **Record layer — "which specific records may you view / edit / delete?"** Applied as a silent filter inside every read and mutating operation, derived from the account's **record access mode** and the caller's **record-sharing permissions**. This is Org-Wide Defaults + Sharing Rules.

Two sub-layers refine these:

- **Field-Level Security** (`ProtectedField@...`) blocks specific fields on specific write operations.
- **Special capabilities** (`Special@...`) grant narrow, ad-hoc powers (for example, deleting records you didn't create).

Tenant isolation is achieved with **workspaces** (a logical partition inside one tenant) and, at the outer boundary, with **separate account domains** (each tenant is a fully isolated Org — separate data, separate credentials).

An integration's identity is normally an **API key** (`tokenType: "API"`) whose `scopes` freeze a subset of its creating user's permissions.

---

## 2. Anatomy of a permission string

Permissions are plain strings of the form:

```
<permissionType>@<Resource>.<action>[.<key>]
```

There are **four** permission types:

| permissionType | Examples | What it governs | Enforced at |
|---|---|---|---|
| `Resource` | `Resource@*.*`, `Resource@Deal.*`, `Resource@Deal.create` | Object-level CRUD / actions | Object layer |
| `Record` | `Record@Deal.view.sameCompanyUsers`, `Record@Deal.edit.*` | Visibility / edit / delete of *specific* records | Record layer |
| `ProtectedField` | `ProtectedField@Ticket.update.subject`, `ProtectedField@Ticket.*.stage` | Blocking specific fields on write | Object layer (on write) |
| `Special` | `Special@*.allowDeleteBy.assignee`, `Special@User.allow.manageRoles` | Narrow, ad-hoc capabilities | Escalation & delete guards |

- For a `Resource` permission, `action` is one of the CRUD functions: `find`, `findOne`, `search`, `create`, `update`, `delete`.
- For a `Record` permission, `action` is `view`, `edit`, or `delete`, and the optional `.key` names a **record type** (see below).
- For a `ProtectedField` permission, `.key` is the field path being locked; `action` may be a specific write function or `*` (all writes).
- For a `Special` permission, `.key` is a semantic capability name.

### 2.1 Record types (the `.key` on a `Record` permission)

A `Record` permission's `.key` selects a sharing rule. The supported record types are:

```
sameCompanyUsers    · share with users in the same company
sameTeamUsers       · share with users on the same team
sameGroupUsers      · share with members of the same record-sharing group
sameWorkspaceUsers  · share within the same workspace
ownedOrAssigned     · records you created, are assigned to, or collaborate on
```

A wildcard `.key` (`Record@Deal.view.*` or `Record@Deal.*`) shares broadly, still bounded to the caller's workspace(s).

### 2.2 Record access modes (the account-wide default)

The account chooses how permissive the record layer is by default. The available modes:

```
Unrestricted        · no record filter — everyone sees everything (default)
Observer            · everyone may VIEW; edit/delete stay restricted to the owner
Team Unrestricted / Team Observer
Company Unrestricted / Company Observer
Workspace Unrestricted / Workspace Observer
Owned               · only records you own / are assigned to / collaborate on
```

For the object layer there is a parallel account-wide setting with two modes:

```
Unrestricted  · a credential with NO scopes passes the object gate (default)
Strict        · every operation requires the matching Resource@... scope; a
                credential with no scopes is rejected with 403
```

> **Defaults matter.** A brand-new tenant is `Unrestricted` on both axes. That means: a credential **with no scopes** passes the object gate, and the record filter is empty (everyone sees everything). Sharing only "bites" when the record access mode is set to something other than `Unrestricted`, **or** when the credential carries scopes. Always test your integration against a **non-admin** user and a non-`Unrestricted` record mode to confirm your access scoping actually applies.

### 2.3 Special capabilities

`Special@...` strings are a closed, curated set of narrow powers. The ones an integrator is most likely to encounter:

| Special permission | Grants |
|---|---|
| `Special@*.allowDeleteBy.*` | Delete any record regardless of owner |
| `Special@*.allowDeleteBy.assignee` | Delete records where you are the assignee |
| `Special@*.allowDeleteBy.collaborators` | Delete records where you are a collaborator |
| `Special@User.allow.manageRoles` | Change other users' `roles` (privilege management) |
| `Special@User.allow.manageWorkspaces` | Change other users' workspace membership |
| `Special@User.security.mfaRequired` | Require MFA for the user |

Treat these as high-value grants. An integration credential should almost never hold `Special@User.allow.manageRoles` or `Special@*.allowDeleteBy.*`.

---

## 3. `role` — the Profile / Permission Set analog

A `role` is literally **a named bag of permission strings**. There is no runtime role hierarchy; a user's effective permissions are simply the union of all their roles' permissions, minus any revocations.

### 3.1 Fields

| Field | Type | Notes |
|---|---|---|
| `keyname` | string | Stable machine key, e.g. `"sales-agent"`. |
| `roleName` | string | Human-readable display name, e.g. `"Sales Agent"`. |
| `description` | string | Free-text note. |
| `permissions` | `[string]` | The permission strings this role grants. De-duplicated. |
| `home` | string | Default landing route for users with this role. |

Every permission you place in `permissions` must be a real, existing permission string (a valid `Resource@` / `Record@` / `ProtectedField@` / `Special@`) or a `CustomPermission@...` you have defined. Submitting an unknown permission fails validation with `Permissions does not exist`.

### 3.2 Creating a role — `POST /v2/role`

```bash
curl -X POST 'https://<domain>/v2/role' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "roleName": "Sync — Read-only Sales",
    "keyname": "sync-readonly-sales",
    "description": "Least-privilege role for the sales dashboard integration",
    "permissions": [
      "Resource@Deal.find",
      "Resource@Deal.findOne",
      "Resource@Company.find",
      "Resource@Contact.find"
    ]
  }'
```

Response (`201`):

```json
{
  "_id": "6608a1b2c3d4e5f60708090a",
  "roleName": "Sync — Read-only Sales",
  "keyname": "sync-readonly-sales",
  "permissions": [
    "Resource@Company.find",
    "Resource@Contact.find",
    "Resource@Deal.find",
    "Resource@Deal.findOne"
  ]
}
```

> **Editing a role re-flows to derived credentials.** When you change a role's `permissions`, every credential that inherited its access is updated automatically. That is why a single credential may carry **either** `roles` **or** `scopes`, never both — mixing the two would leave the literal `scopes` inconsistent after a role edit. See §5.

### 3.3 Assigning roles to a user

Roles are assigned through the `roles` array on a user record, and revoked through `revocationRoles`:

```bash
curl -X PATCH 'https://<domain>/v2/user/6501a2b3c4d5e6f708091a2b' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "roles": ["6608a1b2c3d4e5f60708090a"],
    "revocationRoles": []
  }'
```

**`revocationRoles` is a negative permission set.** A role listed here has its permissions *subtracted* from the user's effective set, even if another role grants them. It is set subtraction — order does not matter. Use it to carve an exception out of a broad role without redefining the role.

> A user's **effective permissions** = union(permissions of `roles`) − union(permissions of `revocationRoles`).

### 3.4 Additive sharing roles (Permission Set pattern)

A role can contain **only** `Record@` permissions and be assigned additively alongside a functional role. This is the "additive sharing Permission Set" pattern: grant *visibility* without granting CRUD.

```json
{
  "roleName": "View all sales records",
  "keyname": "view-all-sales-records",
  "permissions": [
    "Record@Company.view.*",
    "Record@Contact.view.*",
    "Record@Deal.view.*"
  ]
}
```

Assign this alongside a `Resource@`-only role, and the user gains read visibility over all sales records without gaining the ability to create or delete them.

---

## 4. The object layer in practice

Every protected operation compares the credential's `scopes` against the object and function being called. The operation is allowed if the credential holds **any** of:

```
Resource@*.*
Resource@<Model>.*
Resource@<Model>.<fn>
```

If none match, the API responds `403` naming the required scope. Admin credentials bypass the object gate — **unless** the caller is using an API key that was deliberately locked to scopes, in which case even an admin's key is held to those scopes (this prevents accidental over-privilege on a machine key).

**Field-Level Security on write.** If the credential carries a `ProtectedField@<Model>.<action>.<field>` (or `ProtectedField@<Model>.*.<field>`) and the matching write operation includes that field in the request body, the operation is rejected:

```json
{ "statusCode": 403, "message": "Forbidden. Protected Field violation." }
```

> The block triggers on the field's **presence** in the body, not on a value change. Sending `stage` with its current value still fails if `ProtectedField@Ticket.*.stage` is in scope. Omit the field entirely.

**Deleting records you don't own.** Deleting a record you didn't create requires one of the delete capabilities:

| Capability in scope | Allows deleting a record you don't own when… |
|---|---|
| `Special@*.allowDeleteBy.*` | always |
| `Special@*.allowDeleteBy.assignee` | you are the record's `assignee` |
| `Special@*.allowDeleteBy.collaborators` | you are in the record's `collaborators` |

Without an applicable capability the delete returns `403 Forbidden. You can only delete your own records.`

**Rate limiting.** Requests are rate-limited per credential. Exceeding the per-minute ceiling returns `429 Too many requests` — back off and retry, and split heavy workloads across purpose-specific keys.

---

## 5. The record layer in practice

On every list, read, update, and delete, a silent record filter is merged into your query, derived from the account's **record access mode** and the caller's **`Record@` permissions**. This is the direct analog of Sharing Rules + Org-Wide Defaults.

**When the filter is empty (caller sees everything):**

- The caller is an admin.
- The account record access mode is `Unrestricted`.
- The object is configured to allow everyone to view/edit (an account-level `allowEveryone` override exists for a small set of objects such as `User`, `Company`, `Contact`, `Deal`).

**How `fn` maps to a record action:** `find` / `findOne` / `search` → `view`; `update` → `edit`; `delete` → `delete`.

**Record-sharing permissions widen the filter.** Holding `Record@<Model>.view.sameCompanyUsers` lets the caller view records created by users in their company; `sameTeamUsers`, `sameGroupUsers`, `sameWorkspaceUsers`, and `ownedOrAssigned` widen it along other dimensions. A wildcard (`Record@<Model>.view.*` or `Record@<Model>.*`) shares broadly but is still bounded to the caller's workspace(s).

**Base visibility always present** (unless the mode grants broader view): records you created, records assigned to you (`assignee`), records you collaborate on (`collaborators`), records belonging to a team you're on (`teams`), and any record whose document-level `allowEveryone.view` / `allowEveryone.edit` flag is set.

### 5.1 The critical `403` vs `404` distinction

Because the record filter is silent, single-record operations must distinguish two failure modes, and the API does:

- **List / search:** records outside your scope simply **do not appear**, and `pagination.count` reflects only the visible set. There is no `403`.
- **Read / update / delete of one record:** a record that **exists but is hidden** from you returns `403`; a record that **does not exist** returns `404`.

Do **not** treat `404` as "absent" in your error handling — a `403` on a by-id call means the record exists but is outside your visibility. See [REST API](03-rest-api.md#2-authentication) for the same rule from the request side.

---

## 6. Issuing a least-privilege integration credential

An integration authenticates with an **API key** — a `token` with `tokenType: "API"`. The full issuance reference (fields, one-time `apiKey` capture, sending the bearer) is in [Authentication & Connected Apps](04-authentication-and-connected-apps.md#21-creating-an-api-key--post-v2token); here is the **security policy** for it.

### 6.1 The `roles` XOR `scopes` rule

A token carries **either** `roles` (role ids) **or** `scopes` (literal permission strings), never both. Submitting both is rejected:

```json
{ "statusCode": 400, "message": "Both 'roles' and 'scopes' options cannot be selected at the same time." }
```

A `Session` token (an interactive login) always uses scopes derived from its user's roles. An `API` token may pin literal `scopes` for a fixed, auditable least-privilege set.

### 6.2 De-escalation is guaranteed

An API key **can never exceed the permissions of the user who created it**. If a non-admin creator requests a scope or role the user doesn't hold, issuance fails:

```json
{ "statusCode": 400, "message": "Invalid Scope for API Token.", "invalidScope": "Resource@Deal.delete" }
```

If you omit `scopes` (and `roles`) entirely, the key inherits the creating user's full permission set — which is usually *too much*. Always pin the narrowest `scopes` the job needs.

### 6.3 Least-privilege rules for integration credentials

Follow these explicitly:

1. **Dedicated service user.** Run the integration as a purpose-built service user, never as a real person and never as an administrator unless the task genuinely requires admin-only operations.
2. **Pin scopes, don't inherit.** Always set explicit `scopes`. Never issue a key with an empty scope set (it inherits everything the user has).
3. **Narrowest verbs.** Grant `Resource@<Model>.find` / `.findOne` for read-only work; add `.create` / `.update` / `.delete` only when the integration actually writes. Prefer specific verbs over `Resource@<Model>.*`, and never grant `Resource@*.*` to an integration.
4. **One key, one purpose.** A read-only reporting pipeline and a webhook-driven writer should hold **separate** keys with separate scopes. This limits blast radius and makes rate-limiting and revocation surgical.
5. **Lock sensitive fields.** Add `ProtectedField@<Model>.<action>.<field>` for any field the integration must never write (status/stage transitions, pricing, ownership).
6. **No privilege management.** An integration credential should not hold `Special@User.allow.manageRoles`, `Special@User.allow.manageWorkspaces`, or `Special@*.allowDeleteBy.*` unless that *is* its job.
7. **Verify the workspace.** Records the service user creates default to the service user's `primaryWorkspace`. Confirm that is the workspace you intend (see §7).
8. **Rotate and revoke.** The plaintext `apiKey` is shown once at creation. Store it in a secret manager, rotate on a schedule, and revoke immediately if leaked.

---

## 7. Tenant & workspace isolation

There are two levels of isolation.

**(A) Tenant isolation (the Org boundary).** Each customer account is a fully separate tenant with its own domain and completely separate data. A credential issued in one tenant is meaningless in another; there is no cross-tenant read path. This is the equivalent of separate Salesforce **Orgs**.

**(B) Workspace isolation (inside one tenant).** A `workspace` is a logical partition *within* a tenant. Records carry a `workspace` field, and each user has three workspace arrays that govern what they can reach:

| User field | Meaning |
|---|---|
| `primaryWorkspace` | The user's active workspace. New records they create default here. |
| `sharedWorkspaces` | Workspaces whose data the user may see/edit (`"*"` means all). |
| `selectableWorkspaces` | Workspaces the user may switch into. |

### 7.1 Workspace fields

Creating a workspace — `POST /v2/workspace`:

| Field | Type | Notes |
|---|---|---|
| `workspaceCode` | string | Stable machine key. |
| `workspaceName` | string | **Required.** Display name. |
| `color` | string | UI color. |
| `allowEveryone` | object | `{ view, edit }` — opens this workspace's records account-wide. |

### 7.2 How workspace scoping applies

1. **On create.** If the request omits `workspace`, the record inherits the creating user's `primaryWorkspace`. If it sets `workspace`, a non-admin must have that workspace in their `primaryWorkspace` / `sharedWorkspaces` / `selectableWorkspaces`, otherwise the create returns `403 You do not have permission to create records in this workspace.`
2. **On read / edit.** The record filter narrows to the caller's workspace(s) whenever the record access mode is workspace-scoped or a wildcard `Record@` share is in effect.
3. **Anti-escalation.** A non-admin cannot change another user's `sharedWorkspaces` / `selectableWorkspaces` without `Special@User.allow.manageWorkspaces`, and cannot grant or change `roles` without `Special@User.allow.manageRoles`.

### 7.3 Workspace operations

| Endpoint | Method | Purpose |
|---|---|---|
| `PUT /v2/workspace/switch` | `PUT` | Change the caller's active `primaryWorkspace` (target must be in `selectableWorkspaces`). |
| `PUT /v2/workspace/moveDocs` | `PUT` | Move records between workspaces (target must be in the user's reachable set). |

> **Design decision for integrations:** if workspace isolation matters, set the service user's `primaryWorkspace` deliberately, and pass an explicit `workspace` on create rather than relying on the default. A service user that spans workspaces should have the needed workspaces listed in `sharedWorkspaces`.

---

## 8. Just-in-time provisioning for SSO users

If the tenant uses SSO, new users signing in via a corporate identity provider are provisioned by an **authentication rule**: it captures a domain (or specific emails) and defines what a newly created user *inherits* — roles, revocation roles, workspaces, and company. This is the analog of SSO domain capture + JIT provisioning + license allocation.

The `inherit` block on such a rule assigns, at minimum, `roles` (required), plus optional `revocationRoles`, `primaryWorkspace`, `sharedWorkspaces`, and `company`. Rules cannot overlap on the same domain/email, and their combined license allocation cannot exceed the account's licensed-user count.

For an integration builder this matters for one reason: **if your integration expects SSO-provisioned users to already hold specific permissions, verify the authentication rule's `inherit.roles`** — that is where new users' baseline permissions come from. See [Authentication & Connected Apps](04-authentication-and-connected-apps.md) for the sign-in flows.

---

## 9. Authorizing a custom action on a specific record

When you build a custom action — a [Script](05-automation-and-scripts.md), an [Endpoint](07-sites-forms-and-endpoints.md), or an [MCP tool](08-ai-and-mcp.md) — that operates on one record by id, **do not reimplement sharing**. Enforce the same record layer the CRUD API uses by reading the record through the caller's own credential before you act on it.

The safe pattern, expressed as REST calls the automation makes on behalf of the invoking user:

1. `GET /v2/<object>/{id}` **with the invoking caller's credential.** If the record is outside their visibility you receive `403` (exists but hidden) or `404` (absent) — either way, stop.
2. Only after that read succeeds, perform the privileged operation.

This guarantees a custom action never becomes a confused-deputy that exposes records the caller couldn't otherwise see. Never bypass it by fetching with a broader admin credential and returning data the invoking user isn't allowed to see.

---

## Worked examples

### Example 1 — Issue a read-only sales key and consume it

Create a dedicated role, assign it to a service user, then mint an API key scoped narrower still (read-only Deal).

```bash
# 1. Mint the API key for the service user, scoped to read Deals only.
curl -X POST 'https://<domain>/v2/token' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "tokenType": "API",
    "appName": "Sales Dashboard Sync",
    "description": "Read-only deal sync",
    "scopes": ["Resource@Deal.find", "Resource@Deal.findOne"]
  }'
```

Response (`201`) — capture `apiKey` now; it is never returned again:

```json
{
  "_id": "6408d61d2f88f1d606048139",
  "tokenType": "API",
  "appName": "Sales Dashboard Sync",
  "apiKey": "64d266180886c6dc9b5f74cc-1691511959894",
  "apiKeyLastDigits": "1959894",
  "scopes": ["Resource@Deal.find", "Resource@Deal.findOne"]
}
```

If the service user lacks `Resource@Deal.find`, issuance fails with `Invalid Scope for API Token.` (de-escalation, §6.2).

Consume it — the record filter applies automatically:

```bash
curl -G 'https://<domain>/v2/deal' \
  -H 'Authorization: Bearer 64d266180886c6dc9b5f74cc-1691511959894' \
  --data-urlencode 'limit=20' \
  --data-urlencode 'sort=-createdAt'
```

Response (`200`) — only records visible to the service user appear:

```json
{
  "pagination": { "count": 340, "page": 1, "limit": 20, "lastPage": 17, "startIndex": 0 },
  "data": [ /* only the deals visible under this user's record access */ ]
}
```

The key cannot write or delete: a `POST /v2/deal` or `DELETE /v2/deal/{id}` with this key returns `403` naming the missing scope. Sensitive fields such as `password` and `apiKey` are stripped from every response regardless of `select`.

### Example 2 — Lock a field with Field-Level Security

You want the integration to update tickets but **never** change their `stage`. Add a `ProtectedField@Ticket.*.stage` alongside the update scope:

```bash
curl -X POST 'https://<domain>/v2/token' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "tokenType": "API",
    "appName": "Ticket Enricher",
    "scopes": ["Resource@Ticket.update", "ProtectedField@Ticket.*.stage"]
  }'
```

Any update that includes `stage` in the body is refused:

```bash
curl -X PATCH 'https://<domain>/v2/ticket/64f0a1b2c3d4e5f607080910' \
  -H 'Authorization: Bearer <TICKET_ENRICHER_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{ "subject": "Updated", "stage": "closed" }'
```

Response:

```json
{ "statusCode": 403, "message": "Forbidden. Protected Field violation." }
```

The same request **without** `stage` succeeds. The block is on the field's presence, not on a value change.

### Example 3 — Additive sharing without CRUD

A reporting integration needs to *see* all sales records but must not create, edit, or delete anything. Compose two roles: a read-only `Resource@` role and a `Record@`-only sharing role.

```bash
# Sharing role: visibility only, no CRUD.
curl -X POST 'https://<domain>/v2/role' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "roleName": "View all sales records",
    "keyname": "view-all-sales-records",
    "permissions": [
      "Record@Company.view.*",
      "Record@Contact.view.*",
      "Record@Deal.view.*"
    ]
  }'
```

Assign both `view-all-sales-records` and a read-only `Resource@` role to the service user (via the user's `roles` array). Now an API key minted for that user with `scopes: ["Resource@Deal.find", "Resource@Deal.findOne"]` can *list* every deal in the account (the `Record@Deal.view.*` widens the record filter) but cannot mutate any of them (no write scopes). Visibility and mutation are decided by different layers — this is the payoff of separating them.

---

## Common pitfalls

1. **Admin skips almost everything.** An admin's record filter is empty and the object gate doesn't apply — *except* when the admin uses an API key locked to scopes. Test your access rules with a **non-admin** user, or you'll ship a policy that never actually engages.
2. **`Unrestricted` (the default) means no sharing.** With a fresh tenant's default record access mode, the record filter is empty and everyone sees everything. Your `Record@` permissions only take effect once the mode is set to something other than `Unrestricted`.
3. **`Unrestricted` object mode means no object gate for scope-less credentials.** The `Resource@...` check is only forced when the credential carries scopes, or when the object mode is `Strict`. A scope-less session token passes under the default.
4. **`roles` XOR `scopes` on a token.** Setting both is a `400`. Session tokens always use scopes derived from roles; only API keys pin literal `scopes`.
5. **Editing a role re-flows to derived credentials.** Changing a role's `permissions` updates every credential that inherited it. Don't cache a credential's permissions elsewhere and assume they're static.
6. **`revocationRoles` subtracts, it doesn't add.** A permission granted by one role vanishes if another listed in `revocationRoles` also grants it. It's set subtraction; order is irrelevant.
7. **`403` and `404` are intentionally different on by-id calls.** A hidden-but-existing record returns `403`; a truly absent one returns `404`. Don't conflate them in error handling.
8. **Field-Level Security triggers on presence, not change.** Sending a locked field with its current value still returns `403`. Omit the field entirely.
9. **Empty scopes = full inheritance.** Omitting `scopes` when minting an API key inherits the creating user's *entire* permission set. Always pin the minimum.
10. **New records inherit the creator's `primaryWorkspace`.** Records a service user creates land in the service user's primary workspace unless you pass `workspace` explicitly. Verify this if workspace isolation matters.
11. **Two levels of `allowEveryone`.** There is an account-level override for a small set of objects and a document-level `allowEveryone.{view,edit}` flag on individual records. Either can short-circuit the record filter — audit both when a record is unexpectedly visible.
12. **De-escalation is enforced at issuance, not at use.** A non-admin cannot mint a key with more than they hold; the failure happens when you create the key, so validate scopes against the service user's own permissions first.

## Checklist

- [ ] The integration runs under a **dedicated service user** with the minimum roles — never an administrator unless genuinely required.
- [ ] You issued an **API key** (`tokenType: "API"`, `appName` set), not a session token, for the machine identity.
- [ ] The key's `scopes` are the **minimum** needed (specific `Resource@<Model>.<fn>`, never `Resource@*.*`), and you know `scopes ⊆ the service user's permissions` unless the creator is an admin.
- [ ] You used `scopes` **or** `roles` on the token, never both.
- [ ] You added `ProtectedField@<Model>.<action>.<field>` for every field the integration must never write.
- [ ] You gave read-only and write workloads **separate keys**.
- [ ] You tested the flow with a **non-admin** user and a record access mode other than `Unrestricted`, confirming the record filter engages.
- [ ] For custom actions on one record, you re-read the record with the **invoking caller's** credential before acting (no confused deputy).
- [ ] You verified which `workspace` the service user's created records fall into (default = its `primaryWorkspace`).
- [ ] Your error handling distinguishes `403` (exists but hidden) from `404` (absent).
- [ ] If the tenant uses SSO, you reviewed the authentication rule's `inherit.roles` so provisioned users hold the permissions your integration expects.
- [ ] You captured the plaintext `apiKey` at creation, stored it in a secret manager, and have a rotation/revocation plan.

---

Related: [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Sites, Forms & Endpoints](07-sites-forms-and-endpoints.md) · [AI & MCP](08-ai-and-mcp.md) · [Best Practices](11-best-practices.md).
