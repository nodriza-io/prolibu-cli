# Platform & Data Model

> Salesforce analogy: this is Prolibu's **sObjects + Object Manager**. Every business entity is an *object* with typed *fields*; the platform exposes each one as an auto-generated REST resource, and you discover the full catalog through a machine-readable describe/OpenAPI spec.

## When to use this

Read this first. Prolibu is an API-first business data platform: everything you integrate with — deals, contacts, companies, users, and any custom object your account defines — is a record on an *object* reachable over REST. This document establishes the vocabulary the rest of the series relies on: **objects** (standard vs custom), **fields and field types**, **record identifiers**, the **camelCase** naming standard, the **standard/audit fields** present on every record, **relationships** between objects, and how to **discover** objects and fields at runtime instead of hard-coding them. It also explains, at the capability level, how you can make automation react when records are created, updated, or deleted.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce |
|---|---|
| Object (a REST resource under `/v2/<object>`) | sObject |
| Standard object (ships with the account) | Standard object (`Account`, `Contact`, `Opportunity`, …) |
| Custom object (defined in your account) | Custom object (`MyObject__c`) |
| Field descriptor (`{ type, ref, enum, required, unique, … }`) | Field metadata / Custom Field |
| Field types (`string`, `number`, `date`, `boolean`, `objectid`, `mixed`, …) | Field data types (Text, Number, Date, Checkbox, Lookup, …) |
| `_id` (ObjectId) or an object's `primaryKey` field | Record `Id` / External Id |
| `ref` field (populatable relationship) | Lookup / Master-Detail relationship |
| `createdAt` / `updatedAt` / `createdBy` / `updatedBy` / `active` | `CreatedDate` / `LastModifiedDate` / `CreatedById` / `LastModifiedById` / `IsActive` |
| camelCase field & path naming | API Name convention |
| `GET /v2/openapi/specification` (OpenAPI 3.0.3) | Describe / Object Manager metadata |
| Automation on record create/update/delete | Triggers / Flow / Process Builder |

Sibling documents: [Custom Objects & Fields](02-custom-objects-and-fields.md), [REST API](03-rest-api.md), [Authentication & Connected Apps](04-authentication-and-connected-apps.md), [Automation & Scripts](05-automation-and-scripts.md), [Webhooks & Events](06-webhooks-and-events.md), [AI & MCP](08-ai-and-mcp.md).

---

## 1. Objects: standard vs custom

An **object** is a typed collection of records. Prolibu ships with a set of **standard objects** (for example `Deal`, `Contact`, `Company`, `User`, `Stage`, `File`) and lets your account define its own **custom objects** to model data the standard set does not cover.

The important property for an integrator: **every object — standard or custom — behaves identically over the API.** Each one automatically exposes a full CRUD surface under a lowercase path:

```
/v2/<object>/          GET (list)   · POST (create)
/v2/<object>/search    GET (full-text search)
/v2/<object>/{id}      GET (read)   · PATCH (update) · DELETE (delete)
```

Notes:

- **Paths are always lowercase.** An object named `EventProspect` is served at `/v2/eventprospect/`, even though its identifier keeps camelCase everywhere else.
- The object name in a path is singular and matches the object's API name lowercased (e.g. the `Deal` object → `/v2/deal`).
- You do not write controllers or routes to get this surface; it exists for every object the moment the object exists.

Custom objects are created and managed as configuration — see [Custom Objects & Fields](02-custom-objects-and-fields.md). Once a custom object exists, everything in this document applies to it unchanged.

### Reserved object names

A custom object cannot reuse the name of an existing object (standard or custom) — the platform rejects the definition with a `400` and a message that the name is already in use. Choose a unique, singular, PascalCase name.

---

## 2. Fields and field types

A field is described by a small descriptor: a **type** plus a set of options. Types are written in a compact, string-based vocabulary:

| Type | Meaning |
|---|---|
| `string` | Text |
| `number` | Numeric |
| `decimal128` | High-precision decimal (money) |
| `boolean` | True / false |
| `date` | Date / timestamp (ISO 8601) |
| `objectid` | Reference to a record on another object (see §5) |
| `mixed` | Arbitrary JSON object |
| `buffer` | Binary |
| `map` | Key/value map |
| `[string]`, `[number]`, `[date]`, `[boolean]`, `[objectid]`, `[mixed]` | Arrays of the above |

Any type outside this list is rejected when the field is defined.

### Common field options

These options appear in an object's field metadata and shape how the field validates, is stored, and is returned by the API:

| Option | Effect |
|---|---|
| `type` | One of the field types above (required). |
| `ref` | For an `objectid` field, the name of the referenced object; makes the field populatable (see §5). |
| `enum` | Allowed values; the API rejects anything outside the set. |
| `required` | Field must be present on create. |
| `unique` | Enforces uniqueness across records of the object. |
| `default` | Value assigned when the field is omitted on create. |
| `displayName` | Marks the field as the object's human-readable label. |
| `description` | Documentation for the field (surfaced in the OpenAPI spec). |
| `example` | Example value (surfaced in the OpenAPI spec). |
| `primaryKey` | Marks the field as the object's alternate primary key (see §3). |
| `enum` / `validate` | Server-side validation of the value. |

Standard objects also expose fields with server-managed values (totals, timestamps, audit fields). Those are read-only over the API: you receive them in responses, but write attempts to them are ignored. The audit set is documented in §4.

You add fields to an existing object, or define fields on a brand-new custom object, as configuration — see [Custom Objects & Fields](02-custom-objects-and-fields.md).

---

## 3. Record identifiers

Every record has an immutable `_id` — a 24-character hex ObjectId — that is unique across the object and never changes. This is the canonical identifier and always works in the by-id path:

```
GET /v2/deal/6408d61d2f88f1d606048139
```

### Alternate primary keys

An object may designate one field as its **primary key** via the `primaryKey` option. When it does, that field also resolves in the by-id path. For example, the `Contact` object uses `email` as its primary key, so both of these read the same record:

```
GET /v2/contact/665f0a3b2c1d4e5f6a7b8c9d      # by _id
GET /v2/contact/jane@acme.com                 # by primaryKey (email)
```

The same holds for relationship writes: when you set a `ref` field (§5), you may pass either the target's `_id` **or** the target's primary-key value, and the platform resolves it. If the primary-key value does not identify a record, the request fails with a "document not found" error.

> Gotcha: if a primary-key value is not globally unique on its own, a by-id lookup can be ambiguous. In that case the API returns an error asking you to disambiguate; pass a `workspace` query param to scope the lookup, or use the unambiguous `_id`.

---

## 4. Standard & audit fields

Every object — standard and custom — automatically includes a common set of system fields. You do not declare these; they are always present in responses and are maintained by the platform.

| Field | Type | Behavior |
|---|---|---|
| `_id` | `objectid` | Immutable record identifier (see §3). |
| `createdAt` | `date` | Set when the record is created; read-only. |
| `updatedAt` | `date` | Updated on every write; read-only. |
| `createdBy` | `ref` → `User` | The user (or connected app) that created the record; read-only. |
| `updatedBy` | `ref` → `User` | The user that last modified the record; read-only. |

Beyond that core set, many standard objects carry an `active` boolean (default `true`) used as a soft on/off flag for the record — the analog of Salesforce's `IsActive`. Filter on it like any other field, e.g. `?active=true`.

Because `createdBy` / `updatedBy` are relationships to `User`, you can populate them to get the full user record instead of just the id (see §5):

```
GET /v2/deal/6408d61d2f88f1d606048139?populate=createdBy updatedBy
```

> These audit fields are server-managed. Sending them in a `POST`/`PATCH` body has no effect — the platform assigns and updates them for you.

---

## 5. Relationships between objects

A relationship is a field of type `objectid` that carries a `ref` to another object. It is the equivalent of a Salesforce Lookup. For example, a `Deal` has `contact` (`ref` → `Contact`) and `company` (`ref` → `Company`).

### Writing a relationship

Set the field to the target's `_id` **or** to the target's primary-key value:

```json
{ "dealName": "Acme renewal", "contact": "665f0a3b2c1d4e5f6a7b8c9d" }
```
```json
{ "dealName": "Acme renewal", "contact": "jane@acme.com" }
```

Both resolve to the same related record. To clear a relationship, send `null` for the field on update.

### Reading a relationship (populate)

By default a relationship field returns just the referenced id. Use the `populate` query param to expand it into the full related record, or `populate=*` to expand every relationship on the object:

```
GET /v2/deal/6408d61d2f88f1d606048139?populate=contact company
GET /v2/deal/6408d61d2f88f1d606048139?populate=*
```

For deep or field-limited expansion, use `populatePath` with a JSON structure. Full details on `populate`, `populatePath`, filtering and pagination live in [REST API](03-rest-api.md).

> Array relationships (`[objectid]` with a `ref`) hold multiple related records — the analog of a related list. They populate the same way.

---

## 6. The camelCase naming standard

Prolibu uses **camelCase** consistently for every identifier you send or receive: field names (`dealName`, `closeDate`, `firstName`), nested paths (`proposal.enabled`, `urls.linkedIn`), enum values, query params, and custom object/field names. Never use snake_case.

- Field and property names: `camelCase` (`companyName`, `stageMovedAt`).
- Custom object names: `PascalCase`, singular (`EventProspect`, not `event_prospects`).
- HTTP paths: lowercased object name (`/v2/eventprospect/`), even though the object name itself is PascalCase.

Consistency matters because filters are applied only to fields that actually exist on the object — a misspelled or wrong-cased field name in a filter is silently ignored rather than raising an error (see [REST API](03-rest-api.md)). Discover the exact names from the spec (§7) instead of guessing.

---

## 7. Discovering objects & fields (describe / OpenAPI)

Do not hard-code object names, field names, or paths. The platform serves a live, machine-readable **OpenAPI 3.0.3** specification that describes every object, every field (with type and description), and every operation. This is the equivalent of Salesforce's describe/Object Manager.

| Endpoint | Returns |
|---|---|
| `GET /v2/openapi/specification` | The full spec: every object, path, and schema. |
| `GET /v2/openapi/specification/<object>` | The spec for a single object (e.g. `/v2/openapi/specification/deal`). |
| `GET /v2/openapi/specification?key=<path>` | A sub-tree of the spec (drill into one node). |
| `GET /v2/openapi/download-sdk/?lang=<lang>` | A generated client SDK. |
| `GET /v2/openapi/sdk-docs/` | Human-readable SDK docs. |

The spec's `servers[0].url` is your account's base URL, and its `securitySchemes` declare the supported auth methods:

```
bearerKeyHeader: { type: apiKey, name: Authorization, in: header }   # Authorization: Bearer <token>
bearerKeyQuery:  { type: apiKey, name: apiKey,        in: query  }   # ?apiKey=<token>
oauth2:          { type: oauth2, authorizationCode flow }            # see 04-authentication-and-connected-apps.md
```

A robust integration flow is: **discover** the object and its fields from the spec → **build** the request → **call** it. See [Authentication & Connected Apps](04-authentication-and-connected-apps.md) for credentials and [REST API](03-rest-api.md) for query construction.

---

## 8. Reacting to record events (automation)

You do not have to poll to know when data changes. Prolibu can run automation **when a record is created, updated, or deleted** on any object. This is the analog of Salesforce triggers/Flow, exposed to you as configuration — you never touch platform internals.

Two complementary mechanisms:

- **Webhooks** — the platform delivers an HTTP payload to a URL you control whenever a record on a subscribed object is created, updated, or deleted. Event names follow the pattern `<Object>.create`, `<Object>.update`, `<Object>.delete` (for example `Deal.create`). Payload shapes and delivery guarantees are covered in [Webhooks & Events](06-webhooks-and-events.md).
- **Scripts / AI automation** — you can attach an account script or an AI agent that runs on a record create/update/delete for a chosen object, inspects the record, and takes action (validate, enrich, call an external system). Trigger modes, sandbox limits, persisted variables and outbound HTTP are covered in [Automation & Scripts](05-automation-and-scripts.md) and [AI & MCP](08-ai-and-mcp.md).

When automation needs to read or write account data, it does so through the same REST API described here and in [REST API](03-rest-api.md) — there is no separate data path.

---

## 9. Worked examples

> Examples use `https://demos.prolibu.com` as the base URL and the `deal` object. Replace with your account's base URL (from `servers[0].url` in the spec) and a valid credential.

### 9.1 Create a record, then read it back with a populated relationship

```bash
# Create a Deal, linking it to a Contact by that contact's primaryKey (email)
curl -X POST 'https://demos.prolibu.com/v2/deal' \
  -H 'Authorization: Bearer <API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{ "dealName": "Acme renewal", "contact": "jane@acme.com", "closeDate": "2026-09-30" }'
```
Response (`201`) — the created record, including the audit fields the platform assigned:
```json
{
  "_id": "6408d61d2f88f1d606048139",
  "dealName": "Acme renewal",
  "contact": "665f0a3b2c1d4e5f6a7b8c9d",
  "closeDate": "2026-09-30T00:00:00.000Z",
  "active": true,
  "createdAt": "2026-07-01T14:05:11.000Z",
  "updatedAt": "2026-07-01T14:05:11.000Z",
  "createdBy": "6402aa11bb22cc33dd44ee55",
  "updatedBy": "6402aa11bb22cc33dd44ee55"
}
```

```bash
# Read it back with the relationship and audit user expanded
curl -G 'https://demos.prolibu.com/v2/deal/6408d61d2f88f1d606048139' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'populate=contact createdBy' \
  --data-urlencode 'select=dealName contact createdBy createdAt'
```
Response (`200`) — the raw record, with `contact` and `createdBy` now full objects:
```json
{
  "_id": "6408d61d2f88f1d606048139",
  "dealName": "Acme renewal",
  "contact": { "_id": "665f0a3b2c1d4e5f6a7b8c9d", "firstName": "Jane", "email": "jane@acme.com" },
  "createdBy": { "_id": "6402aa11bb22cc33dd44ee55", "firstName": "API", "email": "svc@acme.com" },
  "createdAt": "2026-07-01T14:05:11.000Z"
}
```

### 9.2 Discover an object's fields from the spec (JS fetch)

```js
const res = await fetch(
  'https://demos.prolibu.com/v2/openapi/specification/deal',
  { headers: { Authorization: 'Bearer <API_KEY>' } }
);
const spec = await res.json();
// Walk the spec to enumerate the object's fields, their types and descriptions,
// instead of hard-coding field names. This is the reliable way to learn the schema.
```

### 9.3 List recently created records, filtered on a standard field

```bash
curl -G 'https://demos.prolibu.com/v2/deal' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'active=true' \
  --data-urlencode 'select=dealName closeDate createdAt' \
  --data-urlencode 'sort=-createdAt' \
  --data-urlencode 'limit=5'
```
Response (`200`) — the list endpoint wraps results in `{ pagination, data }`:
```json
{
  "pagination": { "count": 128, "page": 1, "limit": 5, "lastPage": 26, "startIndex": 0 },
  "data": [
    { "_id": "6408d61d2f88f1d606048139", "dealName": "Acme renewal", "closeDate": "2026-09-30T00:00:00.000Z", "createdAt": "2026-07-01T14:05:11.000Z" }
  ]
}
```

---

## 10. Common pitfalls

1. **Paths are lowercase; identifiers are camelCase.** The `EventProspect` object is served at `/v2/eventprospect/`, but its fields (`prospectName`, …) stay camelCase. Do not lowercase field names.
2. **Unknown filter fields are ignored silently.** Filtering on a field the object doesn't have (a typo, wrong case, or a field that only exists after populate) returns results unfiltered rather than an error. Verify field names against the spec (§7).
3. **Audit fields are read-only.** `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, and `_id` are set by the platform. Sending them in a write body has no effect.
4. **`_id` never changes; primary keys can.** Prefer `_id` for durable links between systems. A primary-key field like `email` can be edited, which changes the record's by-key URL.
5. **Populate is opt-in and can be costly.** Relationships return just an id unless you `populate` them; `populate=*` expands every relationship and can be expensive on wide objects. Populate only what you need.
6. **`null` clears a relationship on update.** To detach a `ref`, send `null` for it in the `PATCH` body.
7. **Custom objects are not live the instant you define them.** Creating a custom object or new field is a configuration change that the platform applies before the new schema is queryable — see [Custom Objects & Fields](02-custom-objects-and-fields.md). Don't assume a brand-new object responds on the very next request.
8. **Custom object names must be unique and singular.** Reusing an existing object's name (standard or custom) is rejected with a `400`.

---

## 11. Checklist

- [ ] I discovered the object and its fields from `GET /v2/openapi/specification/<object>` instead of guessing names.
- [ ] I used the **lowercase** object path with the `/v2/` prefix (`/v2/<object>/`).
- [ ] I referenced records by `_id`, or by the object's `primaryKey` where it has one (and disambiguated with `workspace` if the key could be ambiguous).
- [ ] I wrote relationships by passing the target's `_id` or primary-key value, and used `populate` / `populatePath` to read them back.
- [ ] I treated `_id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` as read-only, and read `active` as the record's on/off flag where present.
- [ ] I used **camelCase** for every field, path segment, and enum value — never snake_case.
- [ ] I verified every field used in a filter, `sort`, or `select` actually exists on the object (a typo is ignored, not rejected).
- [ ] To react to changes, I chose **webhooks** ([Webhooks & Events](06-webhooks-and-events.md)) or **scripts / AI automation** ([Automation & Scripts](05-automation-and-scripts.md), [AI & MCP](08-ai-and-mcp.md)) on record create/update/delete.
- [ ] I authenticated every request — see [Authentication & Connected Apps](04-authentication-and-connected-apps.md).
