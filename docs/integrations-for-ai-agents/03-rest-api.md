# REST API Reference

> Salesforce analogy: this is Prolibu's **REST / Composite API + SOQL-style query params**. Every object exposes an auto-generated REST-CRUD resource (like an `sObject` endpoint), you filter it with query parameters that mirror `SELECT / WHERE / ORDER BY`, and the entire catalog is described in a machine-readable **OpenAPI 3.0.3** spec (the equivalent of `/services/data` describe).

## When to use this

Use this whenever you need to **read or write records of any object from outside the platform** — another service, a scheduled job, an AI agent. List and filter records, fetch one by id, create/update/delete, run full-text search, or call an object's custom (RPC-style) actions. Every object — standard or custom — automatically gets a full CRUD resource under `/v2/<object>/` with no code to write. This document is the complete contract: base URL and version prefix, auth headers, the standard query params (`select`, `populate`, `where` filters, `sort`, `limit`, `page`), the response envelope and pagination metadata, the error shape and HTTP status codes, and how to discover it all at runtime via OpenAPI.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce |
|---|---|
| `GET /v2/<object>/?query={...}&select=...&sort=...` | SOQL `GET /services/data/vXX.0/query?q=SELECT ... WHERE ... ORDER BY ...` |
| `select=field1 field2 -field3` | field list / `fields` param |
| `populate` / `populatePath` (relationship expansion) | relationship queries (`SELECT Account.Name ...`) |
| `POST` → `201`, `PATCH /:id` → `200`, `DELETE /:id` → `204` | sObject REST Create / Update / Delete |
| `GET /v2/<object>/search?term=...` | SOSL `FIND {term}` |
| `pagination { count, page, limit, lastPage, startIndex }` | `totalSize` + `nextRecordsUrl` (queryMore) |
| Custom RPC action, e.g. `PUT /v2/deal/approve` | Apex REST / invocable actions |
| Record-level visibility applied silently to queries | Sharing rules (records outside scope don't appear) |
| `Authorization: Bearer` / `?apiKey=` / OAuth 2.0 | OAuth 2.0 bearer / session id |
| `GET /v2/openapi/specification` (OpenAPI 3.0.3) | `/services/data` describe |

Sibling documents: [Platform & Data Model](01-platform-and-data-model.md) (objects, fields, identifiers — the vocabulary this doc builds on), [Custom Objects & Fields](02-custom-objects-and-fields.md) (what fields you can filter and select), [Authentication & Connected Apps](04-authentication-and-connected-apps.md) (tokens, OAuth, API keys), and [Security & Permissions](10-security-and-permissions.md) (record-level visibility).

---

## 1. Base URL, version prefix and object paths

Every request goes to your account's base URL, followed by the version prefix `/v2/` and the lowercased object name:

```
https://<your-domain>/v2/<object>/
```

- **`<your-domain>`** is your account's host (for example `https://acme.prolibu.com`). The examples below use `https://<domain>` as a placeholder.
- **`/v2/`** is the API version prefix. All endpoints in this reference live under it.
- **`<object>`** is the object's API name, **lowercased**. An object named `Deal` is served at `/v2/deal/`; an object named `EventProspect` is served at `/v2/eventprospect/`. The camelCase identifier is preserved everywhere else (fields, OpenAPI `operationId`), but **HTTP paths are always lowercase**.

### The CRUD surface

Each object exposes exactly this set of operations. Nothing needs to be provisioned — the surface exists the moment the object exists.

| Method + Path | Operation | Returns |
|---|---|---|
| `GET /v2/<object>/` | List records (filter, sort, paginate) | `200` — list envelope |
| `POST /v2/<object>/` | Create a record | `201` — the created record |
| `GET /v2/<object>/search` | Full-text search | `200` — search envelope |
| `GET /v2/<object>/{id}` | Read one record | `200` — the record |
| `PATCH /v2/<object>/{id}` | Update a record | `200` — the updated record |
| `DELETE /v2/<object>/{id}` | Delete a record | `204` — no body |

`{id}` is the record's `_id` by default. If the object declares a `primaryKey` field (for example `Contact` uses `email`), you may address records by that field's value instead: `GET /v2/contact/{email}`. See [Platform & Data Model](01-platform-and-data-model.md) for record identifiers.

> **Non-`_id` primary keys can be ambiguous.** If a `primaryKey` value is not globally unique on its own, a by-id read/update may return an error asking you to disambiguate — pass `?workspace=<id-or-code>` to scope the lookup to one workspace.

### Custom (RPC-style) actions

Beyond CRUD, an object can expose additional named actions at `/v2/<object>/<action>`. These are the platform's equivalent of Apex REST / invocable actions: a named operation with its own verb, request body and responses. Two real examples:

```
PUT  /v2/deal/approve            body: { "dealId": "...", "approved": true, "deniedReason": "..." }
POST /v2/eventprospect/promote   body: { "prospectId": "...", "overrides": { ... } }
```

Like every path, the action segment is lowercase. Discover which actions an object supports — and their exact request/response shapes — from the OpenAPI spec (see [§7](#7-machine-discovery-via-openapi)); do not guess.

---

## 2. Authentication

Every data endpoint requires a credential. Send it in **one** of the following ways (listed in order of preference):

| # | How | Example |
|---|---|---|
| 1 | **Bearer token** (recommended) | `Authorization: Bearer <API_KEY>` |
| 2 | **Basic auth** with the literal username `apiKey` | `Authorization: Basic base64("apiKey:<API_KEY>")` |
| 3 | **Query param** (fallback) | `GET /v2/deal/?apiKey=<API_KEY>` |

```bash
# Bearer (recommended)
curl 'https://<domain>/v2/deal/' -H 'Authorization: Bearer <API_KEY>'

# Basic
curl 'https://<domain>/v2/deal/' -H "Authorization: Basic $(printf 'apiKey:<API_KEY>' | base64)"

# Query param
curl 'https://<domain>/v2/deal/?apiKey=<API_KEY>'
```

OAuth 2.0 access tokens are sent the same way as an API key: `Authorization: Bearer <access_token>`. For obtaining tokens (API keys, the OAuth authorization-code flow, refresh and scopes) see [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

**Record-level visibility is enforced silently.** Depending on the caller's permissions, queries are transparently narrowed to the records that caller may see. This has two consequences you must design for:

- On **list / search**: records outside the caller's scope simply **do not appear**, and `pagination.count` reflects only the visible set. There is no `403`.
- On **read / update / delete of one record**: a record that exists but is hidden from the caller returns `403`; a record that does not exist returns `404`. Treat these as distinct cases.

See [Security & Permissions](10-security-and-permissions.md) for the full model.

---

## 3. Standard query parameters

On list (`GET /v2/<object>/`) and, where noted, on read/search, the following reserved parameters shape the query. **Any field of the object may also be passed as a flat query parameter** to filter by equality (see [§4](#4-query-cookbook)).

| Param | Type | What it does | Applies to |
|---|---|---|---|
| `select` | string | Space-separated fields to include; prefix with `-` to exclude (`-customContent`). Sensitive fields such as `password` and `apiKey` are always stripped. | list / read / search |
| `populate` | string | Space-separated relationship fields to expand inline. `populate=*` expands **all** references (can be expensive). | list / read / search |
| `populatePath` | string (JSON) | A JSON-stringified relationship-expansion spec of arbitrary depth — an object or array of `{ path, select, populate }`. **Takes precedence over `populate`.** | list / read / search / create / update |
| `query` | string (JSON) | A JSON-stringified filter supporting mongo-style operators (`$or`, `$and`, `$in`, `$regex`, `$gte`, `$lte`, …). Merged with any flat params (flat params win on conflict). | list / search |
| `sort` | string | Comma-separated fields; `-field` = descending, `field` = ascending. The field must exist on the object, otherwise `400`. | list / search |
| `page` | integer ≥ 1 | Page number, **1-based**. Default `1`. `page ≤ 0` or non-numeric → `400`. | list / search |
| `limit` | integer ≥ 1 | Records per page. Default `20` on list, `10` on search. **Capped at `500`.** | list / search |
| `sum` | string | Name of a numeric field; adds `sum: { <field>: <total> }` to the response, aggregated over the full match set. Non-numeric field → `400`. | list |
| `exportData` | boolean | Returns the result as a downloadable file (respects `format`) and raises the `limit` cap for bulk export. | list |
| `format` | enum | Alternate output/rendering: `json`, `yaml`, `xlsx`, `csv`, `pretty`, `qr`. A value outside the enum is rejected. | list / read |
| `workspace` | string | Scopes a by-id read/update to one workspace (accepts a workspace id or code). Use to disambiguate non-`_id` primary keys. | read / update |

> The `query` parameter is named `query` in Prolibu. It plays the role of a SOQL `WHERE` clause expressed as JSON. Some tooling and older material may call the same concept a generic "where filter" — the parameter you send is `query`.

### Full-text search parameters

`GET /v2/<object>/search` accepts everything above, plus:

| Param | Type | What it does |
|---|---|---|
| `term` | string (**required**) | The search term, matched against the object's text-indexed fields. |
| `extendSearch` | string | Additional related fields to search across. Pass `extendSearch=false` to disable the object's defaults. |

On `search`, the defaults differ from list: `limit` defaults to `10`, and `select` / `populate` default to the object's search-optimized set.

---

## 4. Query cookbook

Filters can be expressed two ways, and they compose:

1. **Flat params** — pass a field name directly as a query param for equality, or use the `field.$op` suffix form for operators.
2. **The `query` param** — pass a JSON-stringified mongo-style filter for anything more complex (`$or`, ranges, `$in`, `$regex`).

When both are present, they are merged and **flat params win** on any key that appears in both.

| Goal | Query params |
|---|---|
| Equality | `?dealName=Acme%20renewal` |
| Operator via suffix | `?amount.$gte=1000` |
| Nested field | `?urls.linkedIn=https://...` (or `?proposal.enabled=true`) |
| Complex filter (`$or`, ranges) | `?query={"$or":[{"stage":"won"},{"amount":{"$gte":5000}}]}` |
| `IN` | `?query={"stage":{"$in":["won","lost"]}}` |
| Regex / contains (case-insensitive) | `?query={"dealName":{"$regex":"acme","$options":"i"}}` |
| Only some fields | `?select=dealName%20closeDate%20contact` |
| Exclude a field | `?select=-customContent` |
| Expand relationships | `?populate=contact%20company` |
| Expand all relationships | `?populate=*` |
| Deep relationship expansion | `?populatePath=[{"path":"contact","select":"email"}]` |
| Sort descending | `?sort=-closeDate` |
| Sort by multiple fields | `?sort=stage,-closeDate` |
| Paginate | `?page=2&limit=50` |
| Aggregate a numeric field | `?sum=amount` |
| Export to xlsx | `?exportData=true&format=xlsx` |

> **Unknown filter fields are ignored silently.** Only fields that exist on the object (plus `$…` operators) are applied. A typo in a field name does not error — it is simply dropped, so the query returns unfiltered results. Always confirm field names against the object schema (see [Custom Objects & Fields](02-custom-objects-and-fields.md)).

---

## 5. Response envelopes

There is **no single uniform envelope** — the shape depends on the operation. Parse accordingly.

### 5.1 List — `GET /v2/<object>/` → `200`

Wrapped in a `pagination` + `data` envelope:

```json
{
  "pagination": {
    "count": 137,
    "page": 2,
    "limit": 50,
    "lastPage": 3,
    "startIndex": 50
  },
  "data": [
    { "_id": "6408d61d2f88f1d606048139", "dealName": "Acme renewal", "closeDate": "2026-09-30T00:00:00.000Z" }
  ],
  "sum": { "amount": 12345 }
}
```

| Field | Meaning |
|---|---|
| `pagination.count` | Total records matching the query (within the caller's visibility). |
| `pagination.page` | Current page (1-based). |
| `pagination.limit` | Page size in effect. |
| `pagination.lastPage` | Last page number — iterate while `page < lastPage`. |
| `pagination.startIndex` | Zero-based index of the first record on this page. |
| `data` | Array of records for this page (`[]` when `count` is `0`). |
| `sum` | Present only when `?sum=<field>` was requested. |

With `exportData=true` + `format`, the response is the file itself (xlsx/csv/json), **not** this envelope; pagination is returned in an `X-Pagination` response header.

### 5.2 Read one — `GET /v2/<object>/{id}` → `200`

Returns the **record directly**, not wrapped in `{ data: ... }`:

```json
{ "_id": "6408d61d2f88f1d606048139", "dealName": "Acme renewal", "closeDate": "2026-09-30T00:00:00.000Z" }
```

### 5.3 Search — `GET /v2/<object>/search` → `200`

Same envelope as list, plus the echoed `term`:

```json
{
  "term": "acme",
  "pagination": { "count": 3, "page": 1, "limit": 10, "lastPage": 1, "startIndex": 0 },
  "data": [ { "_id": "...", "dealName": "Acme renewal" } ]
}
```

### 5.4 Create — `POST` → `201`

Returns the created record (with any `populatePath` applied).

### 5.5 Update — `PATCH /{id}` → `200`

Returns the updated record.

### 5.6 Delete — `DELETE /{id}` → `204`

Empty body.

---

## 6. Errors and HTTP status codes

Errors return a JSON body with this shape:

```json
{ "statusCode": 400, "error": "Human-readable message", "details": "optional extra context" }
```

`statusCode` defaults to `400`; `details` is optional. Common statuses:

| Status | Meaning |
|---|---|
| `200` | OK (list, read, search, update). |
| `201` | Created (POST). |
| `204` | No Content (DELETE). |
| `400` | Bad request — invalid parameter, bad `sort` field, invalid pagination, a `format` outside the enum, a validation failure on write, or a duplicate on a `unique` field. |
| `401` | Missing or invalid credential. |
| `403` | Authenticated but not permitted — including a record that exists but is hidden from the caller. |
| `404` | Object or record not found. A newly created custom object returns `404` until its schema is applied. |
| `429` | Rate limited — back off and retry. |

Write validation errors (missing `required` field, `enum`/`min`/`max`/`match` violations, etc.) come back as `400` (or `409` for duplicates) with a message identifying the offending field. See [Custom Objects & Fields](02-custom-objects-and-fields.md) for field constraints.

---

## 7. Machine discovery via OpenAPI

The API describes itself. Fetch the OpenAPI 3.0.3 spec at runtime to discover which objects exist, their endpoints, their fields, and the exact request/response shapes of custom actions — **discover, don't guess**.

| Endpoint | Returns |
|---|---|
| `GET /v2/openapi/specification` | The complete OpenAPI 3.0.3 spec for the account. |
| `GET /v2/openapi/specification/<object>` | The spec for a single object, e.g. `/v2/openapi/specification/deal`. |
| `GET /v2/openapi/download-sdk/?lang=<lang>` | A generated client SDK for the given language. |
| `GET /v2/openapi/sdk-docs/` | SDK documentation. |

The spec's `servers[0].url` is your account's base URL, and its `securitySchemes` document the supported auth: an API key sent as the `Authorization` header, an API key sent as the `apiKey` query param, and OAuth 2.0 (authorization-code flow). Use the per-object spec to learn an object's field names before building filters and `select` lists.

---

## 8. Worked example A — list with filter, select, populate, sort and pagination

Fetch deals where `proposal.enabled` is true and `closeDate` is on or after `2026-01-01`, expand the `contact` and `company` relationships, page 2 at 50 per page, newest first:

```bash
curl -G 'https://<domain>/v2/deal/' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'query={"proposal.enabled":true,"closeDate":{"$gte":"2026-01-01"}}' \
  --data-urlencode 'select=dealName closeDate proposal.enabled contact company' \
  --data-urlencode 'populate=contact company' \
  --data-urlencode 'sort=-closeDate' \
  --data-urlencode 'page=2' \
  --data-urlencode 'limit=50'
```

Response `200`:

```json
{
  "pagination": { "count": 137, "page": 2, "limit": 50, "lastPage": 3, "startIndex": 50 },
  "data": [
    {
      "_id": "6408d61d2f88f1d606048139",
      "dealName": "Acme renewal",
      "closeDate": "2026-06-30T00:00:00.000Z",
      "proposal": { "enabled": true },
      "contact": { "_id": "660a...", "firstName": "Ada", "email": "ada@acme.com" },
      "company": { "_id": "660b...", "companyName": "Acme Inc." }
    }
  ]
}
```

Because `pagination.page` (2) is less than `pagination.lastPage` (3), there is at least one more page — request `page=3` to continue.

---

## 9. Worked example B — read one with deep relationship expansion (JS `fetch`)

Read a single deal and expand two relationships with field projection. Note the response is the **record itself**, not `{ data: ... }`:

```js
const base = 'https://<domain>';
const qs = new URLSearchParams({
  select: 'dealName proposal contact company',
  populatePath: JSON.stringify([
    { path: 'contact', select: 'firstName lastName email' },
    { path: 'company', select: 'companyName' },
  ]),
});

const res = await fetch(`${base}/v2/deal/6408d61d2f88f1d606048139?${qs}`, {
  headers: { Authorization: 'Bearer <API_KEY>' },
});

if (res.status === 404) throw new Error('Deal not found');
if (res.status === 403) throw new Error('Not permitted to view this deal');

const deal = await res.json(); // the record directly
console.log(deal.dealName, deal.contact.email);
```

Expected shape of `deal`:

```json
{
  "_id": "6408d61d2f88f1d606048139",
  "dealName": "Acme renewal",
  "proposal": { "enabled": true },
  "contact": { "_id": "660a...", "firstName": "Ada", "lastName": "Lovelace", "email": "ada@acme.com" },
  "company": { "_id": "660b...", "companyName": "Acme Inc." }
}
```

---

## 10. Worked example C — create, update, delete and a custom action

```bash
# Create → 201, returns the created record
curl -X POST 'https://<domain>/v2/deal/' \
  -H 'Authorization: Bearer <API_KEY>' -H 'Content-Type: application/json' \
  -d '{ "dealName": "Acme renewal", "closeDate": "2026-09-30" }'
# -> 201 { "_id": "6408...", "dealName": "Acme renewal", "closeDate": "2026-09-30T00:00:00.000Z", "createdAt": "..." }

# Update → 200, returns the updated record
curl -X PATCH 'https://<domain>/v2/deal/6408d61d2f88f1d606048139' \
  -H 'Authorization: Bearer <API_KEY>' -H 'Content-Type: application/json' \
  -d '{ "proposal": { "enabled": true } }'
# -> 200 { "_id": "6408...", "proposal": { "enabled": true }, ... }

# Delete → 204, no body
curl -X DELETE 'https://<domain>/v2/deal/6408d61d2f88f1d606048139' \
  -H 'Authorization: Bearer <API_KEY>'
# -> 204

# Custom action (discovered via OpenAPI) → 200
curl -X PUT 'https://<domain>/v2/deal/approve' \
  -H 'Authorization: Bearer <API_KEY>' -H 'Content-Type: application/json' \
  -d '{ "dealId": "6408d61d2f88f1d606048139", "approved": true }'
```

The JS equivalent of the create call:

```js
const res = await fetch('https://<domain>/v2/deal/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer <API_KEY>' },
  body: JSON.stringify({ dealName: 'Acme renewal', closeDate: '2026-09-30' }),
});
// res.status === 201
const created = await res.json(); // the created record (raw, not wrapped)
```

A create that omits a `required` field returns `400` with a message naming the field, following the [error shape](#6-errors-and-http-status-codes).

---

## 11. Common pitfalls

1. **No uniform envelope.** List and search wrap results in `{ pagination, data }`; read, create and update return the **record directly**; delete returns an empty `204`. Do not blindly read `res.data` for every operation.
2. **Paths are always lowercase.** Use `/v2/eventprospect/`, not `/v2/EventProspect/`; `/v2/deal/approve`, not `/v2/deal/Approve`. The camelCase identifier is preserved elsewhere, but never in the HTTP path.
3. **Unknown filter fields are dropped silently.** Only real fields (plus `$…` operators) are applied. A misspelled field name is ignored and the query returns unfiltered — verify field names against the object schema.
4. **`limit` is capped at `500`.** For larger extracts use `exportData=true`, which raises the cap and streams a file; otherwise iterate with `page`.
5. **`page` is 1-based.** `page=0` or a negative/non-numeric value returns `400`.
6. **`sort` validates the field.** Sorting by a field the object doesn't have returns `400`.
7. **Sensitive fields are always stripped from `select`** (e.g. `password`, `apiKey`) even if you request them.
8. **`populatePath` overrides `populate`,** and `populate=*` expands every relationship — potentially expensive. Prefer an explicit `populate`/`populatePath` list.
9. **Flat params beat the `query` param on conflict.** If the same key appears both as a flat param and inside `query`, the flat value wins.
10. **Record visibility is invisible in lists but explicit on single-record calls.** Hidden records never appear in lists (and don't count toward `pagination.count`); a hidden single record returns `403`, a non-existent one `404` — don't conflate them.
11. **Non-`_id` primary keys may need `?workspace=`.** If a `primaryKey` value isn't globally unique, disambiguate the by-id call with `?workspace=<id-or-code>`.
12. **`format` must be one of the enum values** (`json`, `yaml`, `xlsx`, `csv`, `pretty`, `qr`); any other value is rejected.
13. **`sum` runs over the full match set,** not just the current page, and only accepts numeric fields — it's an extra aggregation, so use it deliberately.
14. **A brand-new custom object returns `404` until its schema is applied.** Poll a `limit=1` list call before writing records (see [Custom Objects & Fields](02-custom-objects-and-fields.md)).

---

## 12. Checklist

- [ ] Discovered the object and its operations via `GET /v2/openapi/specification/<object>` instead of guessing the path.
- [ ] Used the **lowercase** path with the `/v2/` prefix (`/v2/<object>/`).
- [ ] Confirmed the object's identifier: `_id` by default, or the `primaryKey` field — and added `?workspace=` if that key can be ambiguous.
- [ ] Sent the credential (`Authorization: Bearer <API_KEY>` recommended).
- [ ] Built filters with flat params and/or the `query` JSON param, remembering flat params win on conflict and operators go as `field.$op` or inside `query`.
- [ ] Verified every field in the filter / `sort` / `select` exists on the object (see [Custom Objects & Fields](02-custom-objects-and-fields.md)) — a typo is dropped silently.
- [ ] Set explicit `select` / `populate` / `populatePath` to avoid over-fetching (`populate=*` is expensive).
- [ ] Paginated with `page` (1-based) + `limit` (≤ 500; use `exportData` for more) and iterated while `page < pagination.lastPage`.
- [ ] Parsed the response per operation: list/search → `data` + `pagination`; read/create/update → the record itself; delete → `204` with no body.
- [ ] Handled `401` (auth), `403` (exists but hidden), `404` (not found) and `429` (rate limit) as distinct cases.

---

**See also:** [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Security & Permissions](10-security-and-permissions.md)
