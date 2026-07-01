# Integration Best Practices

> Salesforce analogy: this is Prolibu's equivalent of the **integration best-practices + sandbox-testing** guide every partner reads before building — the naming conventions, correct error handling, idempotent and bulk-safe write patterns, governor-friendly (rate-limit-friendly) design, and how to validate everything against a **test/sandbox org** before it touches production.

## When to use this

Read this **first**, before you write a line of client code. The other documents tell you *what* each surface does — objects and fields, the REST API, auth, automation, webhooks, MCP. This one tells you *how to build against them reliably*: the camelCase naming standard the platform enforces everywhere, how to read and react to the error response shape and HTTP status codes, how to make writes idempotent, how to page and bulk-load without tripping limits, how to stay friendly to rate limits, what observability you actually get, how to think about versioning, and how to test the whole thing safely against a **test account** using only the public API. These rules apply to *everything* you build on Prolibu, regardless of which surface you use.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Operational note |
|---|---|---|
| camelCase everywhere (paths lowercase, identifiers camelCase) | API-name / field-name conventions | Hard rule — mismatched case fails or is dropped silently |
| `{ statusCode, error, details }` error body + HTTP status | `[{ errorCode, message, fields }]` REST error array | Parse the body **and** branch on the status |
| `401` / `403` / `404` distinction on single-record calls | INVALID_SESSION / INSUFFICIENT_ACCESS / NOT_FOUND | "exists but hidden" is `403`, "doesn't exist" is `404` |
| `429` + back-off | `REQUEST_LIMIT_EXCEEDED` (governor / API limit) | Respect `Retry-After`; use exponential back-off |
| `primaryKey` upsert / `POST`-then-`PATCH` idempotency | External Id upsert (`PATCH .../sobjects/X/ExtId/val`) | Dedupe on a stable business key you own |
| `page` + `limit` (≤ 500) / `exportData` streaming | `queryMore` / Bulk API 2.0 | Iterate pages, or stream a file for large extracts |
| Test account (separate host + API key) | Sandbox / scratch org | Never rehearse against production |
| Script run logs, run result `error`/`timeMs`, webhook deliveries | Debug logs / Apex jobs / Event Monitoring | The observability you can actually see |
| OpenAPI 3.0.3 self-describe (`/v2/openapi/...`) | `/services/data` describe + WSDL | Discover, don't guess; pin what you depend on |

Sibling documents: [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Sites, Forms & Endpoints](07-sites-forms-and-endpoints.md) · [AI & MCP](08-ai-and-mcp.md) · [Connecting External Services](09-connecting-external-services.md) · [Security & Permissions](10-security-and-permissions.md).

---

## 1. The camelCase naming standard

Prolibu is **camelCase end to end**, and it is not cosmetic — send the wrong case and the platform will either reject the request or, worse, *silently ignore* the field. Two rules cover every case you will hit:

1. **HTTP resource paths are lowercase.** An object named `Deal` is served at `/v2/deal/`; `EventProspect` at `/v2/eventprospect/`. Custom action segments are lowercase too (`/v2/deal/approve`).
2. **Everything else is camelCase**, verbatim, and case-sensitive: field names, query parameters, enum values, `sort` keys, `select` lists, request-body keys, response keys, webhook event names (`Contact.create`, using the object's camelCase API name), MCP tool arguments, and OpenAPI `operationId`s.

This holds **even when you are implementing an external standard**. OAuth 2.0's own spec uses snake_case, but Prolibu exposes its OAuth parameters in camelCase:

```
✅ /calendarEvents        ❌ /calendar-events
✅ accessToken            ❌ access_token
✅ grantType              ❌ grant_type
✅ redirectUri            ❌ redirect_uri
✅ refreshToken           ❌ refresh_token
```

The failure mode that bites integrators most is the **silent drop**: an unknown filter field, `select` token, or body key is not an error — it is discarded, and the request proceeds as if you never sent it. A filter on `close_date` instead of `closeDate` returns *unfiltered* results, not a `400`. A create that sends `deal_name` writes a record with no `dealName`. **Always confirm the exact identifier against the object schema** (see [Custom Objects & Fields](02-custom-objects-and-fields.md)) or the OpenAPI spec (see [§6](#6-versioning-and-machine-discovery)) — never guess casing.

---

## 2. Error handling

### 2.1 The error response shape

Every error returns a JSON body with this shape (see [REST API](03-rest-api.md) §6):

```json
{ "statusCode": 400, "error": "Human-readable message", "details": "optional extra context" }
```

- `statusCode` mirrors the HTTP status; it defaults to `400` when a specific status is not set.
- `error` is a human-readable, localized message — do **not** pattern-match on its exact text for control flow (it can be translated per the caller's locale). Branch on `statusCode` / the HTTP status instead.
- `details` is optional additional context and may be absent.

### 2.2 Status codes and how to react

| Status | Meaning | What your client should do |
|---|---|---|
| `200` | OK (list, read, search, update, custom action) | Parse per operation (§5 of [REST API](03-rest-api.md)) |
| `201` | Created (`POST`) | Read the returned record; capture its `_id` |
| `204` | No Content (`DELETE`) | Success, no body to parse |
| `400` | Bad request — invalid param, bad `sort`/`format`, validation failure, malformed body | **Fix and do not blindly retry** — it will fail identically |
| `401` | Missing or invalid credential | Refresh/replace the token; re-auth (see [Authentication](04-authentication-and-connected-apps.md)) |
| `403` | Authenticated but not permitted — **including a record that exists but is hidden** from the caller | Do not retry; the caller lacks access |
| `404` | Object or record does not exist (a brand-new custom object also `404`s until its schema is applied) | Treat as "not found", distinct from `403` |
| `409` | Conflict — typically a duplicate on a `unique` field | Reconcile (fetch the existing record) rather than re-create |
| `429` | Rate limited | Back off and retry (see [§4](#4-rate-limit-friendliness)) |
| `5xx` | Transient server-side error | Retry with exponential back-off; safe only for idempotent operations |

**The `403` vs `404` distinction is load-bearing.** Because record-level visibility is enforced silently, a single-record read/update/delete of a record that *exists but is hidden* from the caller returns `403`, while a record that *does not exist* returns `404`. On **list/search** these hidden records simply don't appear (and don't count toward `pagination.count`) — there is no `403`. Design for all three cases; do not collapse `403` and `404` into one "error" branch.

### 2.3 Which errors are retryable

| Class | Retry? | Notes |
|---|---|---|
| `400`, `403`, `404`, `409`, `422` | **No** | Deterministic client errors — retrying repeats the failure. Fix the request. |
| `401` | Only after refreshing the credential | A blind retry with the same bad token loops. |
| `429` | **Yes**, with back-off | Honor `Retry-After` if present; otherwise exponential back-off + jitter. |
| `5xx`, network timeouts | **Yes**, if the operation is idempotent | See [§3](#3-idempotency) before retrying a write. |

A robust client centralizes this: one wrapper that inspects `statusCode`, decides retryable vs terminal, and surfaces `error`/`details` to your logs.

```js
async function prolibu(path, init = {}, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://<domain>/v2${path}`, {
      ...init,
      headers: { Authorization: 'Bearer <API_KEY>', ...(init.headers || {}) },
    });

    if (res.ok) return res.status === 204 ? null : res.json();

    // Terminal client errors — never retry, surface immediately.
    if ([400, 401, 403, 404, 409, 422].includes(res.status)) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${body.error || res.statusText}: ${body.details || ''}`);
    }

    // 429 / 5xx — back off and retry.
    if (attempt >= retries) throw new Error(`giving up after ${res.status}`);
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    const backoff = retryAfter * 1000 || Math.min(2 ** attempt * 250, 8000);
    await new Promise((r) => setTimeout(r, backoff + Math.random() * 250)); // jitter
  }
}
```

---

## 3. Idempotency

The write endpoints are **not** idempotent by themselves: a repeated `POST /v2/<object>/` creates a **second** record. Because retries (yours, or a proxy's) and at-least-once webhook deliveries are facts of distributed life, make your writes safe to repeat.

### 3.1 Dedupe on a stable business key

Pick a field that is unique in *your* source system and store it on the Prolibu record — an order number, an external id, an email. Two options:

- **Declare it as the object's `primaryKey`** (or put a `unique` constraint on it). A duplicate then fails with `409`, which you catch and treat as "already exists" rather than an error. See [Custom Objects & Fields](02-custom-objects-and-fields.md).
- **Check-then-write:** query for the key first; `PATCH` if it exists, `POST` if it doesn't.

```js
// Idempotent upsert keyed on an external order number.
async function upsertDeal(order) {
  const q = encodeURIComponent(JSON.stringify({ externalOrderId: order.id }));
  const { data } = await prolibu(`/deal/?query=${q}&limit=1`);

  if (data.length) {
    return prolibu(`/deal/${data[0]._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: order.amount }),
    }); // 200 — updated in place, no duplicate
  }
  return prolibu('/deal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dealName: order.name, amount: order.amount, externalOrderId: order.id }),
  }); // 201 — created once
}
```

> Check-then-write has a race window if two calls run concurrently for the same key. For hard guarantees, back it with a `unique`/`primaryKey` constraint so the database rejects the second write with `409`, and treat that `409` as success.

### 3.2 Idempotency on the receiving side (webhooks)

Prolibu webhooks are **at-least-once and best-effort** — no built-in retry, no HMAC, and a delivery can arrive more than once or be lost entirely. Your receiver must:

- **Dedupe** on a stable key derived from the payload — for an `update`, e.g. `afterUpdateDoc._id` + `afterUpdateDoc.updatedAt`. Skip work you've already committed.
- **Reconcile** on a schedule to catch anything missed: poll the REST API for records changed since your last checkpoint, `GET /v2/<object>/?query={"updatedAt":{"$gt":"<lastCheckpoint>"}}&sort=updatedAt`.

See [Webhooks & Events](06-webhooks-and-events.md) §4–5 for the full pattern. If a change must *never* be missed, prefer a **script on a record event** (reliable, in-transaction) over a webhook — [Automation & Scripts](05-automation-and-scripts.md).

---

## 4. Rate-limit friendliness

Treat `429` as normal back-pressure, not an exceptional failure. A well-behaved client rarely *sees* one because it is designed not to hammer.

- **Honor `429`.** When you get one, back off — respect a `Retry-After` header if present, otherwise exponential back-off with jitter (as in the wrapper above). Never retry a `429` in a tight loop.
- **Bound your concurrency.** A fixed-size worker pool (e.g. 4–8 in flight) is far friendlier than firing hundreds of parallel requests. Concurrency, not raw request count, is what tips a system into throttling.
- **Fetch less.** Every unnecessary field and relationship is load. Use `select` to project only the fields you need, and an explicit `populate` / `populatePath` rather than `populate=*` (which expands *every* relationship and is expensive). See [REST API](03-rest-api.md) §3.
- **Batch reads with generous pages** instead of many tiny requests — `limit` up to `500` (§5). One page of 500 beats 500 single reads.
- **Filter server-side.** Push predicates into the `query` param so the server returns only what you need; don't fetch broadly and filter in your client.
- **Cache what rarely changes.** Object schemas (via OpenAPI), stage lists, and reference data change slowly — cache them instead of refetching per request.
- **Schedule background work off-peak** and spread it out; a cron automation that runs `0 * * * *` for every account at the top of the hour is a self-inflicted spike. Add an offset (`17 * * * *`) or jitter your outbound calls.

---

## 5. Pagination and bulk patterns

### 5.1 Iterating a large result set

List and search return a `pagination` envelope. `limit` is capped at **`500`** (default `20` on list, `10` on search); `page` is **1-based**. Iterate while `page < lastPage`:

```js
async function* allRecords(object, query = {}) {
  const qs = encodeURIComponent(JSON.stringify(query));
  let page = 1;
  while (true) {
    const res = await prolibu(`/${object}/?query=${qs}&page=${page}&limit=500&sort=_id`);
    yield* res.data;
    if (page >= res.pagination.lastPage) break;
    page += 1;
  }
}

// Usage
for await (const deal of allRecords('deal', { stage: 'open' })) {
  // process one deal at a time — bounded memory
}
```

- **Always set an explicit `sort`** (e.g. `sort=_id`) when paging. Without a stable order, records can shift between pages and you may skip or double-count. Sorting by an immutable field like `_id` is safest.
- Prefer a **checkpoint cursor** over deep page numbers for incremental syncs: filter on `updatedAt.$gt=<lastSeen>` and sort by `updatedAt`, persisting the last value you processed. This survives records being inserted mid-sync and lets you resume exactly where you left off.

### 5.2 Bulk extract — stream a file instead of paging

When you need *all* records of an object (an export, a nightly warehouse load), don't page 500 at a time. Pass `exportData=true` with a `format`; this **raises the `limit` cap** and streams the result as a downloadable file rather than the JSON envelope:

```bash
curl -G 'https://<domain>/v2/deal/' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'query={"stage":"won"}' \
  --data-urlencode 'select=dealName amount closeDate' \
  --data-urlencode 'exportData=true' \
  --data-urlencode 'format=xlsx' \
  -o deals.xlsx
```

Supported `format` values include `json`, `yaml`, `xlsx`, and `csv`. With `exportData=true` the response is the file itself; pagination metadata comes back in an `X-Pagination` response header rather than a JSON `pagination` block.

### 5.3 Bulk writes

There is no single "load 10,000 records in one call" endpoint — writes go one record per request. To load in bulk safely:

- **Bound concurrency** with a worker pool (§4), not an unthrottled `Promise.all` over thousands of items.
- **Make each write idempotent** (§3) so a mid-run failure can be re-run without creating duplicates.
- **Handle partial failure per item**: record which succeeded, retry only the transient failures (`429`/`5xx`), and surface terminal ones (`400`/`409`).
- For write-heavy syncs that must run *inside* Prolibu, a **scheduled automation script** can page and process in the background — see [Automation & Scripts](05-automation-and-scripts.md).

---

## 6. Versioning and machine discovery

### 6.1 The versioned prefix

Every endpoint lives under the `/v2/` version prefix. Pin it explicitly in your client; don't strip or hardcode a bare host. When Prolibu introduces a new major version, the `/v2/` surface continues to answer, giving you a migration window.

### 6.2 Discover, don't guess

The API describes itself in **OpenAPI 3.0.3**. Fetch it at runtime instead of hardcoding assumptions about which objects, fields, and custom actions exist:

| Endpoint | Returns |
|---|---|
| `GET /v2/openapi/specification` | The complete spec for the account |
| `GET /v2/openapi/specification/<object>` | The spec for one object (its fields, its custom actions) |
| `GET /v2/openapi/download-sdk/?lang=<lang>` | A generated client SDK for the given language |

Use the per-object spec to learn exact field names and casing before building filters and `select` lists, and to learn a custom action's exact request/response shape before calling it. See [REST API](03-rest-api.md) §7.

### 6.3 Design for additive change

- **Ignore unknown fields** in responses rather than failing when new ones appear — the platform adds fields additively.
- **Depend on the narrowest surface you can.** Request only the fields you use (`select`); don't couple to fields you don't read.
- **Re-fetch the spec when a custom object's schema changes.** A newly created custom object returns `404` until its schema is applied — poll a `limit=1` list call before writing to it (see [Custom Objects & Fields](02-custom-objects-and-fields.md)).

---

## 7. Observability you can actually see

You don't get platform backend logs, but the public surface gives you real signal — use it deliberately.

| Signal | Where you see it | Use it for |
|---|---|---|
| HTTP status + `{ statusCode, error, details }` | Every REST response | Primary success/failure signal — log all four on error |
| `pagination.count` | List / search envelope | Verify you processed the expected number of records |
| Script run result: `output`, `error`, `timeMs` | Response of `GET /v2/script/run` (see [Automation & Scripts](05-automation-and-scripts.md)) | Confirm a manual run succeeded and how long it took |
| Script run logs | Recorded from `console.error` / `warn` / `info` and runtime errors inside a script | Debug automation behavior — **retained for a limited window** |
| Webhook deliveries | The `POST` your endpoint receives | Observe events; log receipt for reconciliation |
| `X-Pagination` header | `exportData=true` responses | Total count on bulk exports |

Practical guidance:

- **Log the full error triple** (`statusCode`, `error`, `details`) plus the request path and a correlation id you generate. The localized `error` message alone is not enough to debug.
- **Run logs are short-lived.** Anything you need for an audit trail must be **exported to your own store** — do not treat platform-side logs as durable.
- **Instrument your own client:** count retries, `429`s, and latency percentiles. The absence of `429`s is the signal that your rate-limit design (§4) is working.
- **Reconcile counts.** After a sync, compare `pagination.count` on the source query against how many records you actually wrote downstream; a mismatch is your earliest signal of a missed webhook or a silently-dropped filter.

---

## 8. Testing safely against a test/sandbox account

Never rehearse an integration against production data. The Salesforce equivalent is a **sandbox / scratch org**; on Prolibu you use a **separate test account** — a distinct host and its own API key — and exercise it through the **same public REST API** you'll use in production. There is no separate "test mode" flag; isolation comes from using a different account.

### 8.1 Set up a test target

1. **Provision a test account** (a non-production host, e.g. `https://acme-sandbox.prolibu.com`) and mint an API key for it (see [Authentication & Connected Apps](04-authentication-and-connected-apps.md)).
2. **Parameterize the base URL and credential** in your client so switching between test and production is a config change, never a code change:

   ```js
   const BASE = process.env.PROLIBU_BASE;     // https://acme-sandbox.prolibu.com
   const KEY  = process.env.PROLIBU_API_KEY;  // the test account's key
   ```
3. **Scope the test API key to least privilege** — the same permission model applies, so test with a token that mirrors production access, not a full-admin key that hides `403`s you'd hit in production.

### 8.2 Seed and tear down disposable data

Because everything is REST, your test fixtures are ordinary API calls. Tag test records with a recognizable marker (a prefix, or a dedicated field) so cleanup is a single filtered query:

```bash
# Seed a test record — mark it so you can find and delete it later.
curl -s -X POST 'https://acme-sandbox.prolibu.com/v2/deal/' \
  -H 'Authorization: Bearer <TEST_API_KEY>' -H 'Content-Type: application/json' \
  -d '{ "dealName": "TEST-fixture-001", "amount": 1000 }'
# -> 201 { "_id": "665f...", "dealName": "TEST-fixture-001", ... }
```

```js
// Teardown — list by marker, then delete each. Run only against the TEST host.
const { data } = await prolibu(`/deal/?query=${encodeURIComponent(
  JSON.stringify({ dealName: { $regex: '^TEST-', $options: 'i' } }),
)}&limit=500&select=_id`);

for (const rec of data) {
  await prolibu(`/deal/${rec._id}`, { method: 'DELETE' }); // -> 204
}
```

- **Isolate fixtures with a marker** (`TEST-…`, or a dedicated `externalOrderId` namespace) so a teardown query can never match real data.
- **Verify against the sandbox host only.** Gate destructive teardown behind an explicit check that `BASE` is the test host — a `DELETE` loop pointed at production is unrecoverable.
- **Exercise the failure paths, not just the happy path:** assert that a missing `required` field returns `400`, a hidden record returns `403`, a bad id returns `404`, and a duplicate on a `unique` key returns `409`. These are the branches your production error handling (§2) must get right.

### 8.3 Promote to production

Once green in the test account, promotion is a **config swap** — repoint `PROLIBU_BASE` / `PROLIBU_API_KEY` at production. Nothing about the request shapes changes. Before flipping:

- Re-fetch the **OpenAPI spec from the production account** and diff it against the test account's — custom objects/fields and available actions must match.
- Confirm the production API key's **scopes** match what you tested with.
- Dry-run read-only calls (a `limit=1` list per object you touch) against production before enabling writes.

---

## 9. Worked example A — a resilient, idempotent create-or-update

Push an external order into Prolibu safely: dedupe on your own `externalOrderId`, retry only transient failures, and never create a duplicate.

```js
async function syncOrder(order) {
  const q = encodeURIComponent(JSON.stringify({ externalOrderId: order.id }));

  // 1. Look for an existing record keyed on the business id.
  const found = await prolibu(`/deal/?query=${q}&limit=1&select=_id`);

  const payload = {
    dealName: order.name,
    amount: order.amount,
    externalOrderId: order.id,     // stable dedupe key you own
  };

  // 2. PATCH if present (idempotent), POST if new.
  if (found.data.length) {
    return prolibu(`/deal/${found.data[0]._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  try {
    return await prolibu('/deal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // 3. Lost a create race → the unique key rejected us with 409. Fetch & update.
    if (String(e.message).startsWith('409')) {
      const again = await prolibu(`/deal/?query=${q}&limit=1&select=_id`);
      return prolibu(`/deal/${again.data[0]._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    throw e;
  }
}
```

Expected outcomes:

```
first call   → 201  { "_id": "665f...", "dealName": "...", "externalOrderId": "ORD-42" }
repeat call  → 200  (PATCH the same record — no duplicate created)
race loser   → 409 caught → 200 (PATCH the winner's record)
```

(`prolibu(...)` is the wrapper from [§2.3](#23-which-errors-are-retryable), which already retries `429`/`5xx` with back-off and throws on terminal `4xx`.)

---

## 10. Worked example B — incremental sync with a checkpoint cursor

Pull everything changed since the last run, page through it at the cap, and persist a resumable checkpoint. This is the reconcile companion to fire-and-forget webhooks.

```js
async function incrementalSync(object, lastCheckpoint, onRecord) {
  let checkpoint = lastCheckpoint;              // ISO string from your store
  let page = 1;

  while (true) {
    const query = encodeURIComponent(JSON.stringify({ updatedAt: { $gt: checkpoint } }));
    const res = await prolibu(
      `/${object}/?query=${query}&sort=updatedAt&page=${page}&limit=500`,
    );

    for (const rec of res.data) {
      await onRecord(rec);                      // your idempotent downstream write
      checkpoint = rec.updatedAt;               // advance as you go
    }

    if (page >= res.pagination.lastPage) break;
    page += 1;
  }
  return checkpoint;                            // persist for the next run
}
```

```bash
# The single page underneath, as a curl for clarity:
curl -G 'https://<domain>/v2/deal/' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'query={"updatedAt":{"$gt":"2026-06-30T00:00:00.000Z"}}' \
  --data-urlencode 'sort=updatedAt' \
  --data-urlencode 'limit=500'
```

Response `200`:

```json
{
  "pagination": { "count": 812, "page": 1, "limit": 500, "lastPage": 2, "startIndex": 0 },
  "data": [ { "_id": "665f...", "dealName": "Acme renewal", "updatedAt": "2026-06-30T09:14:00.000Z" } ]
}
```

Sorting by `updatedAt` and advancing the checkpoint per record makes the sync **resumable**: if it dies mid-run, the next invocation picks up from the last persisted `updatedAt` and processes no record twice (as long as `onRecord` is idempotent — §3).

---

## 11. Worked example C — verifying the error branches against a test account

Prove your error handling before you ship. Run these against the **test host** and assert the status of each.

```bash
BASE='https://acme-sandbox.prolibu.com'; H='Authorization: Bearer <TEST_API_KEY>'

# 400 — missing a required field (message names the field)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v2/deal/" \
  -H "$H" -H 'Content-Type: application/json' -d '{}'
# -> 400

# 404 — a well-formed but non-existent id
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v2/deal/000000000000000000000000" -H "$H"
# -> 404

# 401 — no / bad credential
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v2/deal/?limit=1"
# -> 401

# 429 — sanity-check your back-off (only if you deliberately burst; expect your client to recover)
```

A `400` body confirms the shape your client parses:

```json
{ "statusCode": 400, "error": "'dealName' is required" }
```

Assert on the **status code and the presence of `statusCode`/`error`**, never on the exact wording of `error` (it is localized). Wire these four cases into your test suite so a regression in your handler is caught before production.

---

## 12. Common pitfalls

1. **Wrong casing is silently dropped, not rejected.** A misspelled or snake_cased field in a filter/`select`/body is discarded — the request "succeeds" with the wrong result. Verify every identifier against the schema (§1).
2. **Paths are lowercase, identifiers are camelCase.** `/v2/eventprospect/` (path) but `eventName` (field). Mixing these up is the #1 first-day mistake.
3. **Matching on `error` message text.** Messages are localized and can change — branch on `statusCode` / HTTP status, not on the human-readable string (§2.1).
4. **Collapsing `403` and `404`.** "Exists but hidden" (`403`) and "doesn't exist" (`404`) are different outcomes on single-record calls; on lists, hidden records just vanish. Handle all three (§2.2).
5. **Blindly retrying `4xx`.** `400`/`403`/`404`/`409` are deterministic — retrying repeats the failure and wastes rate budget. Only `429` and (for idempotent ops) `5xx` are retryable (§2.3).
6. **Non-idempotent writes.** A repeated `POST` makes a second record. Dedupe on a business key with `primaryKey`/`unique` + `409`-as-success, or check-then-write (§3).
7. **`populate=*` and over-fetching.** Expanding every relationship (or selecting fields you don't use) multiplies load and invites `429`s. Project with `select` and an explicit `populate` (§4).
8. **Paging without a stable `sort`.** Records shift between pages under concurrent writes; you skip or double-count. Always `sort` by an immutable field (e.g. `_id`) or use an `updatedAt` cursor (§5.1).
9. **Paging to extract everything.** For a full dump, `exportData=true` + `format` is one streamed file and raises the `limit` cap — far better than thousands of `limit=500` pages (§5.2).
10. **Treating webhooks as guaranteed.** They're at-least-once **and** best-effort (no retry, no HMAC). Dedupe on the receiver and add a reconcile pass; use a record-event script for anything that must not be missed (§3.2).
11. **Relying on run logs as an audit trail.** Script run logs are retained only briefly — export anything durable to your own store (§7).
12. **Testing against production.** Use a separate test account (distinct host + least-privilege key) and gate teardown behind a host check. A `DELETE` loop pointed at production is unrecoverable (§8).
13. **Hardcoding the schema.** Objects, fields, and custom actions can change; a new custom object `404`s until applied. Discover via OpenAPI and ignore unknown response fields (§6).
14. **Forgetting the `/v2/` prefix.** Every endpoint is versioned; pin the prefix in config rather than assembling bare hosts.

---

## 13. Checklist

- [ ] Every identifier is **camelCase** (paths lowercase); no snake_case, no kebab-case, and no reliance on the platform "fixing" case.
- [ ] Verified every field name in filters / `sort` / `select` / bodies against the object schema or OpenAPI — a typo is dropped silently.
- [ ] A single error wrapper branches on `statusCode` / HTTP status (not `error` text) and distinguishes `400` / `401` / `403` / `404` / `409` / `429` / `5xx`.
- [ ] Retries are limited to `429` (honoring `Retry-After` / back-off + jitter) and, for **idempotent** operations, `5xx`; `4xx` are never blindly retried.
- [ ] Writes are **idempotent**: deduped on a stable business key via `primaryKey`/`unique` + `409`-as-success, or check-then-write.
- [ ] Webhook receivers dedupe on a stable key **and** a scheduled reconcile poll closes any gap; critical logic uses a record-event script instead.
- [ ] Rate-limit-friendly: bounded concurrency, `select`/explicit `populate` (never `populate=*` by default), server-side filtering, generous page sizes, cached slow-changing data, jittered schedules.
- [ ] Pagination uses a **stable `sort`** (or an `updatedAt` checkpoint cursor); bulk extracts use `exportData=true` + `format`, not deep paging.
- [ ] The `/v2/` prefix and base URL/credential are **configuration**, so test↔production is a config swap; the OpenAPI spec is fetched, not hardcoded.
- [ ] Observability captured: full `{ statusCode, error, details }` + request path + correlation id logged; run logs and counts exported to your own store; retries/`429`s/latency instrumented.
- [ ] Validated end to end against a **test/sandbox account** (separate host + least-privilege key), including the `400`/`403`/`404`/`409` failure branches, with teardown gated behind a host check — before promoting to production.

---

**See also:** [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Sites, Forms & Endpoints](07-sites-forms-and-endpoints.md) · [AI & MCP](08-ai-and-mcp.md) · [Connecting External Services](09-connecting-external-services.md) · [Security & Permissions](10-security-and-permissions.md)
</content>
</invoke>
