# Automation & Scripts

> Salesforce analogy: this is Prolibu's equivalent of **Apex triggers + Scheduled Apex + Flows** — server-side automation you configure, not client code. A `Script` is a unit of server-side logic that you can run on demand, wire to a record create/update/delete event, or schedule with cron. It runs in an isolated sandbox with an execution timeout, and it reads and writes account data through the same [REST API](03-rest-api.md) you use from outside.

## When to use this

Use a `Script` when a declarative rule is not enough and you need custom server-side logic: call an external API when a record changes, validate or enrich a record before it is saved, periodically sync data to another system, or expose an on-demand operation you can trigger over HTTP. Scripts are edited through the API and take effect on the next run — there is no build or deploy step. Everything the script does with account data goes through your account's own REST API (authenticated with an API key), so nothing here requires access to platform internals.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Notes |
|---|---|---|
| `Script` resource (`code`, `active`, `timeout`) | Apex class / Flow | The configurable unit of automation |
| `GET /v2/script/run?scriptId=...` | Anonymous Apex / Apex REST | Run a script manually over HTTP |
| `lifecycleHooks: ["Deal"]` | Apex trigger (`before/after insert/update/delete`) | React to record create/update/delete events |
| `scheduledTask.periodicity` (cron) + `timeZone` | Scheduled Apex (`System.schedule`) | Run on a recurring schedule |
| `variables[]` (persistent key/value) | Custom Settings / Custom Metadata | Per-script persistent state |
| `timeout` (execution budget) | Governor limit (CPU time) | Hard ceiling per run |
| `active: true` required to run/schedule | active/inactive Flow | Inactive scripts never execute |
| Outbound HTTP + your account's REST API | Named Credentials + callouts / DML | How a script reads/writes data and reaches other systems |

Sibling documents: [Platform & Data Model](01-platform-and-data-model.md) (objects, fields, identifiers), [Custom Objects & Fields](02-custom-objects-and-fields.md) (the fields a trigger sees), [REST API](03-rest-api.md) (how a script reads/writes account data), [Authentication & Connected Apps](04-authentication-and-connected-apps.md) (the API key a script uses for callbacks), [Webhooks & Events](06-webhooks-and-events.md) (push-style alternative to triggers), and [Security & Permissions](10-security-and-permissions.md).

---

## 1. The `Script` resource

A script is a normal API resource. You create, read, update and delete it through `/v2/script/`, exactly like any other object (see [REST API](03-rest-api.md)). Managing scripts requires administrative privileges on the account.

### Fields you set

| Field | Type | Notes |
|---|---|---|
| `scriptName` | `String`, required | Human-readable name |
| `scriptCode` | `String` | Stable unique key, auto-generated if omitted. Use it, not the name, to reference a script from tooling |
| `code` | `String`, required | The executable body of the automation (see [§2](#2-the-execution-model)) |
| `active` | `Boolean` | **Must be `true` for the script to run manually, on an event, or on a schedule.** Inactive scripts are skipped everywhere |
| `readme` | `String` | Optional embedded documentation (Markdown) |
| `lifecycleHooks` | `[String]` | Object API names whose create/update/delete events trigger this script — e.g. `["Deal"]` (see [§3.2](#32-run-on-a-record-event-triggers)) |
| `variables` | `[{ key, value }]` | Persistent key/value store scoped to this script (see [§4](#4-persisting-variables)) |
| `scheduledTask.periodicity` | `String` (cron) | Cron expression, e.g. `"0 * * * *"` (see [§3.3](#33-run-on-a-schedule-cron)) |
| `scheduledTask.timeZone` | `String` (IANA) | **Required when `periodicity` is set**, e.g. `"America/Bogota"` |
| `timeout` | `Number` (ms) | Execution budget. Default `30000`, min `5000`, max `300000` |

### Create a script

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Ping external API",
    "active": true,
    "timeout": 15000,
    "code": "(async () => { const res = await axios.get(\"https://jsonplaceholder.typicode.com/todos/1\"); output = res.data; })();"
  }'
```

Response (`201`):

```json
{
  "_id": "665f0c9a1b2c3d4e5f001122",
  "scriptName": "Ping external API",
  "scriptCode": "SCP-1717430000000",
  "active": true,
  "timeout": 15000,
  "code": "(async () => { ... })();",
  "createdAt": "2026-07-01T12:00:00.000Z"
}
```

> Editing `code`, `variables`, `active`, `timeout`, or the schedule takes effect on the **next** execution. There is no restart or deploy.

---

## 2. The execution model

Every run happens in an **isolated sandbox** with a strict time budget. It is plain JavaScript plus a small, fixed set of helpers — there is no filesystem, no arbitrary module loading, and no direct database access. All data access to the platform is done over HTTP against your account's [REST API](03-rest-api.md).

### 2.1 What is available inside `code`

| Helper | Purpose |
|---|---|
| `axios` | The HTTP client for all outbound and callback requests (there is no `fetch`) |
| `console.log` / `console.error` / `console.warn` / `console.info` | Logging. `log` is streamed for live debugging; `error`/`warn`/`info` are also recorded as run log entries |
| `setVariable(key, value)` | Persist a value into this script's `variables` store (async; see [§4](#4-persisting-variables)) |
| `variables` | Read-only snapshot of the persistent store as loaded at the start of the run |
| `output` | **Write your result here.** The value of `output` is what the run returns |
| `eventName` | What triggered this run: `"ApiRun"`, `"ScheduledTask"`, or `"<Object>.<event>"` (e.g. `"Deal.beforeUpdate"`) |
| `eventData` | The trigger payload — the HTTP request for manual runs, the record for triggers, the schedule info for cron (see [§3](#3-the-three-trigger-modes)) |
| `localDomain` | Your account's host, so you can build REST calls back to your own API |
| `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` / `URLSearchParams` | Standard timing and query-string helpers |
| `requestUser` | For manual runs carrying a user context, basic identity fields (`_id`, `firstName`, `lastName`, `email`, roles) |

### 2.2 Returning a result — write to `output`

The run's result is **whatever you assign to the global `output` variable** — not what the code returns. Because most useful scripts do I/O, the canonical pattern is an async IIFE that assigns `output` at the end:

```js
(async () => {
  const res = await axios.get(`https://${localDomain}/v2/deal?limit=1`, {
    headers: { Authorization: `Bearer ${variables.find(v => v.key === 'apiKey')?.value}` },
  });
  output = { firstDeal: res.data.data[0] || null };
})();
```

A script that does `return {...}` without assigning `output` returns `output: null`. Always assign to `output`.

### 2.3 Sandbox limits & isolation

- **Execution timeout.** A run is capped by the script's `timeout` (5000–300000 ms). If it exceeds the budget it is terminated and the run reports a timeout error. Keep the budget realistic and leave headroom below the maximum for cleanup.
- **Isolation.** Each run is independent. Do not rely on in-memory state surviving between runs — use `variables` for anything that must persist (see [§4](#4-persisting-variables)).
- **No platform internals.** There is no direct model or database access from inside a script. To read or write account records, call your own REST API with `axios` (see [§5](#5-reading-and-writing-account-data)).

---

## 3. The three trigger modes

A single script is defined once; how it is invoked depends on how you configure and call it. The three modes are not mutually exclusive — a script can be run manually and also carry a schedule and/or lifecycle hooks. Inspect `eventName` inside `code` to branch on how it was invoked.

### 3.1 Run manually (on demand)

Invoke a script over HTTP with `GET /v2/script/run` and the script's `scriptId` (its `_id`) as a query parameter. Authenticate with an API key (Bearer) exactly like any other API call.

```
GET /v2/script/run?scriptId=<SCRIPT_ID>
```

Inside the run, `eventName === "ApiRun"` and `eventData` carries the full request:

```json
{ "query": { "scriptId": "<SCRIPT_ID>", "foo": "bar" }, "body": { } }
```

So you can pass inputs as additional query params or a request body and read them from `eventData.query` / `eventData.body`.

| Response code | Meaning |
|---|---|
| `200` | Ran; body is the run result (see [§6](#6-run-result-shape)) |
| `401` | Missing/invalid credentials |
| `403` | Not permitted to run this script |
| `404` | No such script |
| `429` | Rate limited |

### 3.2 Run on a record event (triggers)

Set `lifecycleHooks` to the object API names whose events should fire the script. When a record of that object is created, updated, or deleted, the script runs automatically — this is the equivalent of an Apex trigger.

- `eventName` is `"<Object>.<event>"`, e.g. `"Deal.beforeUpdate"`, `"Contact.afterCreate"`, `"Deal.beforeDelete"`.
- `eventData` contains the record involved (and, for updates, the version being applied). Field values arrive as JSON, so non-serializable types (dates, ids) are strings — compare and forward them accordingly.
- The available events cover **before** and **after** each of create, update, and delete, so you can validate/enrich before persistence or react after it.

**Enabling triggers is a deliberate, two-part step.** Reacting to record events is off by default. Beyond setting `lifecycleHooks` on the script, event-triggered automation must be **enabled at the account level for each object** you want to hook. If the object is not enabled, saving a script that hooks it is rejected. This prevents accidental server-side side effects on core objects; enable it explicitly per object in your account's integration settings.

> Prefer [Webhooks & Events](06-webhooks-and-events.md) when you only need to be *notified* of a change in an external system. Use a trigger script when you need to run logic **inside** the save — to validate, enrich, or block the operation before it completes.

### 3.3 Run on a schedule (cron)

Set `scheduledTask.periodicity` to a cron expression and `scheduledTask.timeZone` to an IANA time zone. The script then runs on that cadence with no external caller.

```json
{
  "scheduledTask": { "periodicity": "0 * * * *", "timeZone": "America/Bogota" },
  "active": true
}
```

- `eventName === "ScheduledTask"` and `eventData` carries `{ scheduledAt, periodicity }`.
- `timeZone` is **required** whenever `periodicity` is set; without it the schedule is invalid.
- The cron expression must be valid. Very high frequencies (sub-minute) are not allowed on production accounts — schedule per-minute or slower.
- Changing `periodicity`, `timeZone`, or `active` re-registers the schedule automatically on the next save; deactivating the script removes it.

---

## 4. Persisting variables

`variables` is a per-script key/value store — the analog of mutable Custom Settings. Use it for cursors, counters, last-sync timestamps, or the API key a scheduled script uses to call back into your account.

- **Read** at the start of a run from the injected `variables` array: `variables.find(v => v.key === 'cursor')?.value`.
- **Write** with `await setVariable(key, value)`. Both arguments are required and values are stored as strings — serialize with `String(...)` or `JSON.stringify(...)`.
- The `variables` array is a **snapshot from the start of the run**. Calling `setVariable` during a run persists the value but does **not** update the local array in that same run — you will read the new value on the next run.

```js
(async () => {
  const runs = Number(variables.find(v => v.key === 'runs')?.value || 0) + 1;
  await setVariable('runs', String(runs));
  output = { runs };
})();
```

You can also seed variables directly on the resource when you create or update the script:

```bash
curl -s -X PATCH "https://<domain>/v2/script/<SCRIPT_ID>" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "variables": [{ "key": "apiKey", "value": "<CALLBACK_API_KEY>" }] }'
```

> Treat variable values as configuration, not a secrets vault. If a script needs an API key to call back into your account, provision a dedicated token (see [Authentication & Connected Apps](04-authentication-and-connected-apps.md)) with only the access it needs.

---

## 5. Reading and writing account data

There is no direct database access inside a script. To work with account records, call your own [REST API](03-rest-api.md) using `axios`, authenticated with an API key you provide (typically stored as a `variable`). Build the base URL from `localDomain`:

```js
const apiKey = variables.find(v => v.key === 'apiKey')?.value;
const client = axios.create({
  baseURL: `https://${localDomain}/v2`,
  headers: { Authorization: `Bearer ${apiKey}` },
});

// Read (list responses use the envelope { pagination, data: [...] })
const { data: page } = await client.get('/deal?status=open&limit=100');
const openDeals = page.data;

// Create
await client.post('/deal', { title: 'From automation', amount: 1000 });

// Update
await client.patch(`/deal/${openDeals[0]._id}`, { stage: 'Won' });
```

This uses the exact same endpoints, query params, and response envelope documented in [REST API](03-rest-api.md). Record-level visibility applies to the API key the script uses, so scope that token appropriately.

**Outbound calls to other systems** work the same way — `axios` is a general HTTP client, so you can push to an ERP, a data warehouse, or any webhook receiver:

```js
await axios.post('https://erp.example.com/sync/deals', { deals: openDeals });
```

---

## 6. Run result shape

A manual run (`GET /v2/script/run`) returns a JSON envelope:

```json
{
  "output": { "response": { "id": 1, "title": "delectus aut autem", "completed": false } },
  "eventData": { "query": { "scriptId": "<SCRIPT_ID>" }, "body": {} },
  "error": null,
  "timeMs": 123
}
```

| Field | Meaning |
|---|---|
| `output` | Whatever the script assigned to the global `output` (`null` if it assigned nothing) |
| `eventData` | The trigger payload the run received |
| `error` | `null` on success, or the error message on failure |
| `timeMs` | Wall-clock execution time in milliseconds |

Failed runs also record a log entry (from `console.error`/`warn`/`info` and from runtime errors), which you can review to debug behavior. Log entries are retained for a limited period, so capture anything you need to keep elsewhere.

---

## 7. Worked examples

### 7.1 Outbound call when a record changes (trigger)

Notify an external system whenever a deal is updated, and enrich the record with a computed flag before it is saved.

**Prerequisites:** the account has event-triggered automation enabled for `Deal` (see [§3.2](#32-run-on-a-record-event-triggers)).

Create the script:

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Deal change notifier",
    "active": true,
    "lifecycleHooks": ["Deal"],
    "timeout": 20000,
    "code": "(async () => { const deal = eventData.doc || eventData.payload || {}; if (eventName === \"Deal.afterUpdate\") { await axios.post(\"https://hooks.example.com/deal-updated\", { id: deal._id, stage: deal.stage, amount: deal.amount }); } output = { notified: true }; })();"
  }'
```

The readable `code`:

```js
(async () => {
  const deal = eventData.doc || eventData.payload || {};
  if (eventName === 'Deal.afterUpdate') {
    await axios.post('https://hooks.example.com/deal-updated', {
      id: deal._id,
      stage: deal.stage,
      amount: deal.amount,
    });
  }
  output = { notified: true };
})();
```

Every time a `Deal` is updated, the script runs with `eventName === "Deal.afterUpdate"` and posts to the external endpoint. To *block* an invalid save instead of just reacting, use a `before` event and return an error from the run — the platform aborts the operation, the equivalent of `addError()` on an Apex trigger.

### 7.2 Scheduled sync

Every hour, pull open deals from your account and push them to an external ERP.

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Hourly deal sync",
    "active": true,
    "timeout": 60000,
    "scheduledTask": { "periodicity": "0 * * * *", "timeZone": "America/Bogota" },
    "variables": [{ "key": "apiKey", "value": "<CALLBACK_API_KEY>" }],
    "code": "(async () => { const apiKey = variables.find(v => v.key === \"apiKey\").value; const { data } = await axios.get(`https://${localDomain}/v2/deal?status=open&limit=100`, { headers: { Authorization: `Bearer ${apiKey}` } }); const deals = data.data || []; await axios.post(\"https://erp.example.com/sync/deals\", { deals }); output = { synced: deals.length, at: new Date().toISOString() }; })();"
  }'
```

The readable `code`:

```js
(async () => {
  const apiKey = variables.find(v => v.key === 'apiKey').value;
  const { data } = await axios.get(
    `https://${localDomain}/v2/deal?status=open&limit=100`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const deals = data.data || [];          // list envelope: records are in data.data
  await axios.post('https://erp.example.com/sync/deals', { deals });
  output = { synced: deals.length, at: new Date().toISOString() };
})();
```

On each run `eventName === "ScheduledTask"` and `eventData` carries `{ scheduledAt, periodicity }`. Store the callback `apiKey` as a `variable` so the script can authenticate against your own REST API.

### 7.3 On-demand operation with inputs

A manually invoked script that reads its inputs from the request and returns a computed result.

```js
(async () => {
  const { dealId } = eventData.query;                 // from ?dealId=...
  const apiKey = variables.find(v => v.key === 'apiKey').value;
  const { data: deal } = await axios.get(
    `https://${localDomain}/v2/deal/${dealId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  output = { dealId, title: deal.title, amount: deal.amount };
})();
```

Invoke it:

```bash
curl -s "https://<domain>/v2/script/run?scriptId=<SCRIPT_ID>&dealId=665f...abcd" \
  -H "Authorization: Bearer <API_KEY>"
```

Response:

```json
{
  "output": { "dealId": "665f...abcd", "title": "Acme renewal", "amount": 12000 },
  "eventData": { "query": { "scriptId": "<SCRIPT_ID>", "dealId": "665f...abcd" }, "body": {} },
  "error": null,
  "timeMs": 87
}
```

---

## 8. Common pitfalls

1. **The result comes from `output`, not `return`.** A script that does `return {...}` without assigning `output` returns `output: null`. Always assign the global `output`.
2. **`active: true` is mandatory.** An inactive script never runs — not manually, not on an event, not on a schedule.
3. **No direct data access.** There is no model or database access inside a script and no `fetch`. Read/write account data with `axios` against your own [REST API](03-rest-api.md), authenticated with an API key.
4. **Triggers require per-object enablement.** Setting `lifecycleHooks` is not enough — event-triggered automation must also be enabled for that object at the account level, or saving the script is rejected. Both parts are off by default.
5. **`scheduledTask.timeZone` is required with `periodicity`.** Omitting it makes the schedule invalid. Sub-minute frequencies are rejected on production accounts.
6. **`variables` is a start-of-run snapshot.** Values written with `setVariable` during a run are visible only on the next run, not the current one. Values are always strings — serialize accordingly.
7. **Mind the timeout.** Long callouts or large syncs can exceed the `timeout` budget and be terminated. Raise `timeout` (up to 300000 ms), paginate large reads, and keep runs bounded.
8. **Trigger payloads are JSON.** Dates and ids arrive as strings inside `eventData`. Parse or compare them as strings; don't assume native `Date`/id types.
9. **Scope the callback key.** A script that calls your REST API acts with the permissions of the API key it carries. Use a least-privilege token, not a full-admin key, and store it as a `variable` rather than hard-coding it.
10. **Run logs are short-lived.** Use `console.error`/`warn`/`info` to record diagnostics, but export anything you need long-term — log entries are retained only for a limited window.

---

## 9. Checklist

- [ ] Set `scriptName`, `code`, and `active: true`. Without `active`, nothing runs.
- [ ] Wrap `code` that does I/O in an async IIFE: `(async () => { ... output = ...; })()`.
- [ ] **Assign the result to `output`** — never rely on `return`.
- [ ] To read/write account data, call your own REST API with `axios` against `https://${localDomain}/v2/...`, using a scoped API key stored as a `variable`.
- [ ] For persistent state, read from `variables` and write with `await setVariable(key, String(value))`.
- [ ] Set `timeout` (5000–300000 ms) with headroom for the work the script does.
- [ ] For **triggers**: set `lifecycleHooks: ["<Object>"]` **and** enable event-triggered automation for that object at the account level. Mutate the record before save to enrich it, or return an error to block the save.
- [ ] For **schedules**: set both `scheduledTask.periodicity` (valid cron) and `scheduledTask.timeZone`. Avoid sub-minute frequency on production.
- [ ] Invoke manually with `GET /v2/script/run?scriptId=<id>` (Bearer/API key); read `output`, `error`, and `timeMs` from the response.
- [ ] Remember: editing `code`, `variables`, `active`, `timeout`, or the schedule takes effect on the **next** run — no restart, no deploy.

---

**See also:** [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Security & Permissions](10-security-and-permissions.md)
