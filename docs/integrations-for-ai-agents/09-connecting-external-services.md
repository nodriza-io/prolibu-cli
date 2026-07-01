# Connecting to External Services

> Salesforce analogy: this is Prolibu's equivalent of **Named Credential callouts + integration patterns** — you register a third party's credentials once in a secure store, then make authenticated callouts *out* to its API from your automation, receive callbacks *in* through custom endpoints, and stitch the two directions into a bi-directional sync. Nothing here requires platform source code: it is built entirely on public resources — credentials, [scripts](05-automation-and-scripts.md), [endpoints](07-sites-forms-and-endpoints.md), and [webhooks](06-webhooks-and-events.md).

## When to use this

Reach for this when a Prolibu account has to talk to a system you don't control — a CRM (Salesforce, HubSpot), an ERP, a data warehouse, a messaging provider, or any HTTP API. You will (1) **store the third party's credentials** as a `serviceCredential` or connect a per-user account, (2) **call out** to that API from an automation [script](05-automation-and-scripts.md), (3) **receive inbound calls** through a custom [endpoint](07-sites-forms-and-endpoints.md) or by pushing your own record events out via a [webhook](06-webhooks-and-events.md), and (4) compose those into a **push, pull, or two-way sync**. This document is a patterns cookbook — it assembles the primitives documented elsewhere into complete, copy-pasteable integrations, using a generic external CRM as the running example.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Direction |
|---|---|---|
| `serviceCredential` (`providerType`, encrypted secret, referenced by id) | **Named Credential + External Credential** | Prolibu → external (static key) |
| Per-user Auth Providers (Google / Microsoft / HubSpot) | **Named Credential with per-user OAuth** | Prolibu → external (as a user) |
| Outbound HTTP from a [Script](05-automation-and-scripts.md) (`axios`) | **Apex callout** (`Http.send`) | Prolibu → external |
| Script on a record event (`lifecycleHooks`) that calls out | **Trigger + callout / Outbound Message** | Prolibu → external (on change) |
| Scheduled script (cron) that pulls and reconciles | **Scheduled Apex integration job** | external → Prolibu (poll) |
| Custom [Endpoint](07-sites-forms-and-endpoints.md) (`/v2/endpoint/{method}/{routeName}`) | **Apex REST** (`@RestResource`) | external → Prolibu (inbound) |
| [Webhook](06-webhooks-and-events.md) subscribed to `<Object>.create/update/delete` | **Outbound Message** | Prolibu → external (notify) |
| An `externalId` custom field on the Prolibu record | External Id field on the mapped object | correlation key |

Sibling documents: [REST API](03-rest-api.md) (how you read/write account data and the response envelope), [Authentication & Connected Apps](04-authentication-and-connected-apps.md) (where credentials live and how tokens work), [Automation & Scripts](05-automation-and-scripts.md) (the outbound callout runtime), [Webhooks & Events](06-webhooks-and-events.md) (pushing record events out), [Sites, Forms & Custom Endpoints](07-sites-forms-and-endpoints.md) (receiving inbound calls), [Custom Objects & Fields](02-custom-objects-and-fields.md) (where you add the correlation field), and [Security & Permissions](10-security-and-permissions.md).

Throughout, `https://<domain>` is your account host (for example `https://acme.prolibu.com`) and `<API_KEY>` is an API key or OAuth access token sent as `Authorization: Bearer <API_KEY>` — see [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

---

## 1. The shape of an integration

Every integration with an external service is assembled from four public building blocks. You rarely need all four, but knowing which you need tells you which sections to read.

| Building block | Resource / surface | Role | Reference |
|---|---|---|---|
| **Credential store** | `serviceCredential` / Auth Providers | Hold the third party's secret securely, referenced by id | [§2](#2-store-the-external-credential) |
| **Outbound callout** | `Script` with `axios` | Call the external API from inside the account | [§3](#3-calling-out-to-an-external-api) |
| **Inbound receiver** | `Endpoint` → `Script` | Accept a request/webhook from the external system | [§4](#4-receiving-inbound-calls) |
| **Change notifier** | `Webhook` on record events | Push Prolibu record changes to the external system | [§5](#5-pushing-record-changes-outward) |

The direction of the arrow decides the tool:

- **Prolibu → external, on demand or on a schedule:** a script (manual or cron) that calls `axios`. [§3](#3-calling-out-to-an-external-api)
- **Prolibu → external, the instant a record changes:** either a script on a `lifecycleHooks` event (reliable, in-transaction) or a `Webhook` (fire-and-forget notification). [§5](#5-pushing-record-changes-outward)
- **External → Prolibu, arbitrary request:** a custom `Endpoint`. [§4](#4-receiving-inbound-calls)
- **External → Prolibu, they call your REST API directly:** issue them a scoped API key or a Connected App and let them hit `/v2/*` — see [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

---

## 2. Store the external credential

Never paste a third party's secret into a script, a webhook payload, or a request body. Store it once, encrypted, and reference it by id. There are two mechanisms depending on whether the third party uses a static API key or per-user OAuth.

### 2.1 Static API keys / tokens — `serviceCredential`

For a service you authenticate with a single account-wide secret, create a `serviceCredential`. Secrets are encrypted at rest and access is controlled **per record**; automation reads the credential back **by id** and never sees the plaintext again. This is the **Named Credential** analog.

| Field | Type | Notes |
|---|---|---|
| `serviceCredentialName` | `String`, required | Display name. |
| `providerType` | `String` | One of `openai`, `anthropic`, `deepseek`, `twilio`, `sendgrid`, `google`. |
| `priority` | `Number` | Selection order when several credentials match (lower = tried first). |
| `active` | `Boolean` | Only active credentials are used. |
| `<providerType>` | `Object` | Provider sub-object holding the secret(s) — see [Authentication & Connected Apps](04-authentication-and-connected-apps.md#41-static-third-party-api-keys--post-v2servicecredential). |
| `assignee` / `collaborators` / `allowEveryone` | access control | Who may use this credential. |

```bash
curl -X POST 'https://<domain>/v2/servicecredential' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "serviceCredentialName": "OpenAI Production",
    "providerType": "openai",
    "priority": 1,
    "active": true,
    "openai": { "apiKey": "sk-proj-...", "organizationId": "org-abc123" }
  }'
```

The response returns the secret **encrypted**, never in plaintext; your automation later references the record's `_id`.

> **`providerType` is a fixed enumeration.** The credential store recognizes the provider list above. For a service that is **not** in that list — a generic CRM, ERP, or in-house API — you have two supported options: (a) keep its token in a script's `variables` store, or (b) use a small `serviceCredential` slot such as `sendgrid.apiKey` only if that maps cleanly; otherwise use a `variable`. Whichever you choose, treat the value as configuration, not a hardened secrets vault — provision a **least-privilege** token on the external side. See [§3.4](#34-credentials-for-services-not-in-the-provider-list).

### 2.2 Per-user OAuth — Auth Providers

When Prolibu must act **as a specific user** against Google, Microsoft, or HubSpot (send mail as them, read their calendar or CRM), each user connects their own account through the Auth Providers surface. Prolibu stores the per-user tokens and refreshes them automatically.

```bash
curl 'https://<domain>/v2/oauth/getproviders' \
  -H 'Authorization: Bearer <USER_API_KEY>'
```

```json
[
  { "provider": "google",    "connected": true,  "scopes": ["gmail.send", "calendar.events"] },
  { "provider": "microsoft", "connected": false },
  { "provider": "hubspot",   "connected": false }
]
```

An administrator enables each provider first, and each user connects via `/v2/oauth/connect`. Because tokens are per-user, always check `connected` before assuming access. Full flow in [Authentication & Connected Apps](04-authentication-and-connected-apps.md#42-per-user-oauth-to-google--microsoft--hubspot-auth-providers).

---

## 3. Calling out to an external API

Outbound calls happen inside an automation [Script](05-automation-and-scripts.md). A script runs in an isolated sandbox with an execution timeout; the only HTTP client is `axios` (there is no `fetch`), and you assign your result to the global `output`. That same `axios` reaches **any** HTTPS API, so it is your callout mechanism for every external service.

### 3.1 The callout pattern

```js
(async () => {
  // 1. Read the external service's base URL + token from this script's variables.
  const sf = {
    instanceUrl: variables.find(v => v.key === 'sfInstanceUrl')?.value,
    token:       variables.find(v => v.key === 'sfAccessToken')?.value,
  };

  // 2. Call the external API with axios.
  const res = await axios.get(`${sf.instanceUrl}/services/data/v60.0/query`, {
    params: { q: 'SELECT Id, Name, Amount FROM Opportunity WHERE StageName = \'Closed Won\'' },
    headers: { Authorization: `Bearer ${sf.token}` },
    timeout: 15000,
  });

  // 3. Return the result.
  output = { count: res.data.totalSize, records: res.data.records };
})();
```

Key points, all documented in [Automation & Scripts](05-automation-and-scripts.md):

- **Wrap I/O in an async IIFE** and assign `output` at the end. A bare `return` yields `output: null`.
- **Set a per-call `timeout`** on `axios` *and* a realistic script `timeout` (5000–300000 ms). A slow external API can otherwise exhaust the whole run budget.
- **Read tokens from `variables`**, not from hard-coded literals in `code`. Seed them when you create the script (see below).

### 3.2 Where the callout token comes from

For an external CRM whose `providerType` is not in the credential enum, store its base URL and access token as script `variables`:

```bash
curl -s -X PATCH 'https://<domain>/v2/script/<SCRIPT_ID>' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "variables": [
      { "key": "sfInstanceUrl", "value": "https://acme.my.salesforce.com" },
      { "key": "sfAccessToken", "value": "<OAUTH_ACCESS_TOKEN>" }
    ]
  }'
```

If the external token expires, refresh it inside the script (exchange a stored `refreshToken` against the provider's token endpoint, then `await setVariable('sfAccessToken', newToken)` for the next run). Because `variables` written mid-run are only visible on the **next** run, refresh eagerly at the start when the current token is near expiry.

### 3.3 Handling callout errors

External APIs fail — time out, rate-limit, or reject a payload. Catch, log, and surface a clean result rather than letting the run crash opaquely:

```js
(async () => {
  try {
    const res = await axios.post(`${instanceUrl}/services/data/v60.0/sobjects/Account`,
      { Name: 'Acme Corp' },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    output = { ok: true, id: res.data.id };
  } catch (err) {
    // axios surfaces the remote status/body on err.response
    console.error('Salesforce callout failed', err.response?.status, err.response?.data);
    output = { ok: false, status: err.response?.status || 0, error: err.message };
  }
})();
```

- Inspect `err.response?.status` and `err.response?.data` for the remote error; `err.request` (no `response`) means the call never got a reply (DNS/timeout).
- For transient `429` / `5xx`, back off and retry a bounded number of times **within** the script's `timeout` budget — do not loop unbounded.
- Log with `console.error` / `console.warn`; run logs are retained for a limited window, so persist anything you must keep (write it back to a record or an external log sink).

### 3.4 Credentials for services not in the provider list

The `serviceCredential` enum covers a fixed set of providers. For everything else:

- **Preferred:** store the external token as a script `variable` and reference it as in [§3.2](#32-where-the-callout-token-comes-from). Provision a dedicated, least-privilege token on the external side.
- **Never** embed the token as a literal in `code` (it becomes visible to anyone who can read the script) or echo it into `output`, a webhook payload, or a log line.
- If the external service supports per-user OAuth **and** it is Google / Microsoft / HubSpot, prefer Auth Providers ([§2.2](#22-per-user-oauth--auth-providers)) so refresh is handled for you.

---

## 4. Receiving inbound calls

When the external system needs to **call you** — a Salesforce Outbound Message, a Stripe webhook, a partner pushing an update — stand up a custom [Endpoint](07-sites-forms-and-endpoints.md). An endpoint binds a public URL to one of your scripts: the platform runs the script, hands it the request, and returns whatever the script assigns to `output`. This is the inbound mirror of an outbound callout, and the direct analog of Apex REST.

### 4.1 Create the receiver script, then the endpoint

First the script that processes the inbound request. It reads the request from `eventData` (`eventData.body`, `eventData.query`, `eventData.headers`) and writes account records through your own [REST API](03-rest-api.md):

```bash
curl -s -X POST 'https://<domain>/v2/script/' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "scriptName": "Salesforce inbound sync",
    "active": true,
    "timeout": 20000,
    "variables": [{ "key": "apiKey", "value": "<SCOPED_CALLBACK_KEY>" }],
    "code": "(async () => { const evt = eventData.body || {}; const apiKey = variables.find(v => v.key === \"apiKey\").value; const client = axios.create({ baseURL: `https://${localDomain}/v2`, headers: { Authorization: `Bearer ${apiKey}` } }); const found = await client.get(`/deal?externalId=${encodeURIComponent(evt.Id)}&limit=1`); if (found.data.data.length) { await client.patch(`/deal/${found.data.data[0]._id}`, { amount: evt.Amount, stage: evt.StageName }); output = { updated: true }; } else { await client.post(\"/deal\", { title: evt.Name, amount: evt.Amount, externalId: evt.Id }); output = { created: true }; } })();"
  }'
```

The readable `code`:

```js
(async () => {
  const evt = eventData.body || {};                       // the inbound JSON
  const apiKey = variables.find(v => v.key === 'apiKey').value;
  const client = axios.create({
    baseURL: `https://${localDomain}/v2`,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // Correlate by the external system's id (stored on the Prolibu record as externalId).
  const found = await client.get(`/deal?externalId=${encodeURIComponent(evt.Id)}&limit=1`);
  if (found.data.data.length) {
    await client.patch(`/deal/${found.data.data[0]._id}`, { amount: evt.Amount, stage: evt.StageName });
    output = { updated: true };
  } else {
    await client.post('/deal', { title: evt.Name, amount: evt.Amount, externalId: evt.Id });
    output = { created: true };
  }
})();
```

Then the endpoint that exposes it publicly:

```bash
curl -s -X POST 'https://<domain>/v2/endpoint/' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "endpointName": "Salesforce inbound",
    "routeName": "salesforce-sync",
    "method": "POST",
    "script": "<SCRIPT_ID>",
    "active": true,
    "authentication": { "enabled": false }
  }'
```

The external system now POSTs to:

```
https://<domain>/v2/endpoint/post/salesforce-sync
```

`{method}` in the URL is the lowercased HTTP verb; it must match the endpoint's `method`. See [Sites, Forms & Custom Endpoints](07-sites-forms-and-endpoints.md) for the full `Endpoint` reference.

### 4.2 Authenticating the inbound caller

With `authentication.enabled: false` the URL is fully public — appropriate only if you verify the caller **inside** the script. Choose one:

- **Shared secret in a header.** Have the external system send a secret header and assert it in `code`:

  ```js
  const secret = eventData.headers['x-webhook-secret'];
  if (secret !== variables.find(v => v.key === 'inboundSecret')?.value) {
    output = { error: 'unauthorized' };            // reject without touching data
    return;
  }
  ```

- **Provider signature.** If the external system signs its payload (an HMAC over the raw body), recompute it in the script and compare. Store the signing secret as a `variable`.
- **Require an API key at the router.** Set `authentication.enabled: true` and issue the external system a scoped API key; a missing/invalid key then returns `401` before your script runs. Use this when the caller can send an `Authorization` header.

> Treat "no bearer required" as "I authenticate it myself," never as "no protection." An unauthenticated write endpoint that trusts its body is an open door.

### 4.3 Letting the external system call your REST API directly

If the external side can speak your REST API, you often don't need a custom endpoint at all: issue it a **scoped API key** (`tokenType: "API"` with narrow `scopes`) or register it as a **Connected App** for per-user OAuth, and let it CRUD `/v2/*` resources directly. This is the cleanest inbound path when the external system is programmable. See [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

---

## 5. Pushing record changes outward

To notify the external system the moment a Prolibu record changes, you have two tools with different guarantees.

### 5.1 Reliable, in-transaction — a script on a record event

A script with `lifecycleHooks` runs **inside the save**, so the callout is part of the operation and you can be sure it ran (or fail loudly). Use this when the external update must not be missed, or when you must validate/enrich before the record is persisted.

```bash
curl -s -X POST 'https://<domain>/v2/script/' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "scriptName": "Deal → Salesforce push",
    "active": true,
    "lifecycleHooks": ["Deal"],
    "timeout": 20000,
    "variables": [
      { "key": "sfInstanceUrl", "value": "https://acme.my.salesforce.com" },
      { "key": "sfAccessToken", "value": "<OAUTH_ACCESS_TOKEN>" }
    ],
    "code": "(async () => { if (eventName !== \"Deal.afterUpdate\" && eventName !== \"Deal.afterCreate\") { output = { skipped: true }; return; } const deal = eventData.doc || {}; const base = variables.find(v => v.key === \"sfInstanceUrl\").value; const tok = variables.find(v => v.key === \"sfAccessToken\").value; const body = { Name: deal.title, Amount: deal.amount, StageName: deal.stage }; try { if (deal.externalId) { await axios.patch(`${base}/services/data/v60.0/sobjects/Opportunity/${deal.externalId}`, body, { headers: { Authorization: `Bearer ${tok}` }, timeout: 12000 }); output = { pushed: \"update\" }; } else { const r = await axios.post(`${base}/services/data/v60.0/sobjects/Opportunity`, body, { headers: { Authorization: `Bearer ${tok}` }, timeout: 12000 }); output = { pushed: \"create\", externalId: r.data.id }; } } catch (e) { console.error(\"SF push failed\", e.response?.status, e.response?.data); output = { pushed: false, error: e.message }; } })();"
  }'
```

The readable `code`:

```js
(async () => {
  if (eventName !== 'Deal.afterUpdate' && eventName !== 'Deal.afterCreate') {
    output = { skipped: true };
    return;
  }
  const deal = eventData.doc || {};
  const base = variables.find(v => v.key === 'sfInstanceUrl').value;
  const tok  = variables.find(v => v.key === 'sfAccessToken').value;
  const body = { Name: deal.title, Amount: deal.amount, StageName: deal.stage };
  try {
    if (deal.externalId) {
      await axios.patch(
        `${base}/services/data/v60.0/sobjects/Opportunity/${deal.externalId}`,
        body, { headers: { Authorization: `Bearer ${tok}` }, timeout: 12000 });
      output = { pushed: 'update' };
    } else {
      const r = await axios.post(
        `${base}/services/data/v60.0/sobjects/Opportunity`,
        body, { headers: { Authorization: `Bearer ${tok}` }, timeout: 12000 });
      output = { pushed: 'create', externalId: r.data.id };
    }
  } catch (e) {
    console.error('SF push failed', e.response?.status, e.response?.data);
    output = { pushed: false, error: e.message };
  }
})();
```

Reacting to record events is off by default: besides setting `lifecycleHooks`, event-triggered automation must be **enabled per object at the account level**, or saving the script is rejected. See [Automation & Scripts §3.2](05-automation-and-scripts.md#32-run-on-a-record-event-triggers).

### 5.2 Fire-and-forget notification — a Webhook

If you only need to *notify* an external listener (and it, or an intermediary, will do the work), subscribe a `Webhook` to the object's events. The platform POSTs `{ eventName, eventData }` to your URL. It's simpler than a script but **best-effort**: no built-in retry, and no HMAC signature — authenticate by adding a shared-secret custom header.

```bash
curl -s -X POST 'https://<domain>/v2/webhook/' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "webhookName": "Deal changes → middleware",
    "endpoint": "https://middleware.example.com/prolibu/deal",
    "eventNames": ["Deal.create", "Deal.update", "Deal.delete"],
    "headers": [{ "name": "X-Api-Key", "value": "<SHARED_SECRET>" }],
    "active": true
  }'
```

See [Webhooks & Events](06-webhooks-and-events.md) for the payload shape, event catalog, and delivery guarantees.

> **Script-on-event vs Webhook.** Use the **script** when the outbound update must be reliable (part of the save) or must transform data; use the **webhook** when a lightweight, best-effort notification to a receiver you already run is enough. Neither guarantees the *external* side succeeded — pair either with a periodic reconcile ([§6.3](#63-reconciliation-the-safety-net)).

---

## 6. Bi-directional sync patterns

Combine the primitives to keep a Prolibu object and an external object in step. The recurring ingredients: a **correlation key**, an outbound path, an inbound path, and a **reconcile** job.

### 6.1 The correlation key (`externalId`)

Add an `externalId` custom field to the Prolibu object (see [Custom Objects & Fields](02-custom-objects-and-fields.md)) and store the external record's id there; on the external side, store the Prolibu `_id` in *its* external-id field. Every sync step then keys off this pair, so the same change flowing back and forth resolves to the same two records instead of creating duplicates.

- Outbound: after creating the external record, write its id back to `externalId` on the Prolibu record.
- Inbound: look up the Prolibu record by `externalId` (as in [§4.1](#41-create-the-receiver-script-then-the-endpoint)); update if found, create if not (**upsert**).

### 6.2 Avoiding echo loops

A push triggers the other system, whose webhook pushes back, which re-triggers your push — an infinite echo. Break the loop:

- **Skip no-op writes.** Before writing, compare incoming values to the current record; if nothing changed, do nothing.
- **Mark the origin.** When applying an inbound change, tag the write (for example a `syncedFrom` field or a header the receiver recognizes) so the outbound script can detect "this change came from the sync" and not re-push it.
- **Sequence the events.** In a `lifecycleHooks` push script, branch on `eventName` and on which fields actually changed, so a sync-originated update doesn't re-emit.

### 6.3 Reconciliation: the safety net

Webhooks and callouts are best-effort; deliveries get dropped. A scheduled script that periodically **pulls** the external system and reconciles by `externalId` is what makes the sync eventually consistent.

```js
(async () => {
  const apiKey = variables.find(v => v.key === 'apiKey').value;
  const base   = variables.find(v => v.key === 'sfInstanceUrl').value;
  const tok    = variables.find(v => v.key === 'sfAccessToken').value;
  const since  = variables.find(v => v.key === 'cursor')?.value || '2000-01-01T00:00:00Z';

  const local = axios.create({
    baseURL: `https://${localDomain}/v2`,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // 1. Pull records changed on the external side since our last checkpoint.
  const q = `SELECT Id, Name, Amount, StageName FROM Opportunity WHERE LastModifiedDate > ${since}`;
  const { data } = await axios.get(`${base}/services/data/v60.0/query`, {
    params: { q }, headers: { Authorization: `Bearer ${tok}` }, timeout: 20000,
  });

  // 2. Upsert each into Prolibu, keyed by externalId.
  for (const rec of data.records) {
    const found = await local.get(`/deal?externalId=${rec.Id}&limit=1`);
    if (found.data.data.length) {
      await local.patch(`/deal/${found.data.data[0]._id}`, { amount: rec.Amount, stage: rec.StageName });
    } else {
      await local.post('/deal', { title: rec.Name, amount: rec.Amount, externalId: rec.Id });
    }
  }

  // 3. Advance the checkpoint for next run.
  await setVariable('cursor', new Date().toISOString());
  output = { reconciled: data.records.length };
})();
```

Schedule it with `scheduledTask.periodicity` (cron) + `scheduledTask.timeZone` (see [Automation & Scripts §3.3](05-automation-and-scripts.md#33-run-on-a-schedule-cron)). The persisted `cursor` variable is a start-of-run snapshot, so it advances only on the next run — checkpoint conservatively (a slight overlap re-processes a few records but, because the upsert is idempotent, never duplicates).

---

## 7. Worked example: end-to-end two-way Deal ↔ Opportunity sync

Assembling the pieces into a complete integration between a Prolibu `Deal` and a Salesforce `Opportunity`.

**Prerequisites**
- An `externalId` field on `Deal` ([Custom Objects & Fields](02-custom-objects-and-fields.md)).
- A scoped callback API key with just `Resource@Deal.find`, `Resource@Deal.create`, `Resource@Deal.update` ([Authentication & Connected Apps](04-authentication-and-connected-apps.md)).
- The Salesforce instance URL and an OAuth access/refresh token pair.

**1. Outbound push (on change).** The `lifecycleHooks` script from [§5.1](#51-reliable-in-transaction--a-script-on-a-record-event). On `Deal.afterCreate` it creates the Opportunity and writes the returned id back to `externalId`; on `Deal.afterUpdate` it PATCHes the Opportunity. Guard it with the echo-loop check from [§6.2](#62-avoiding-echo-loops).

**2. Inbound receive (on their change).** Salesforce (via Outbound Message or middleware) POSTs to your endpoint `https://<domain>/v2/endpoint/post/salesforce-sync` ([§4.1](#41-create-the-receiver-script-then-the-endpoint)), authenticated with a shared-secret header ([§4.2](#42-authenticating-the-inbound-caller)). The receiver script upserts the `Deal` keyed by `externalId`.

**3. Reconcile (nightly).** The scheduled pull script from [§6.3](#63-reconciliation-the-safety-net) runs on cron, catches anything the webhooks dropped, and advances its `cursor`.

Expected shape of a manual test of the inbound endpoint:

```bash
curl -s -X POST 'https://<domain>/v2/endpoint/post/salesforce-sync' \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: <SHARED_SECRET>' \
  -d '{ "Id": "0065g00000ABCDEAA3", "Name": "Acme renewal", "Amount": 12000, "StageName": "Proposal" }'
```

```json
{
  "output": { "updated": true },
  "eventData": { "body": { "Id": "0065g00000ABCDEAA3", "Name": "Acme renewal", "Amount": 12000, "StageName": "Proposal" } },
  "error": null,
  "timeMs": 142
}
```

The three scripts share the same `externalId` correlation key, so a change made on either side converges to the same pair of records without duplication.

---

## 8. Common pitfalls

1. **Hard-coded secrets.** A token pasted into `code` or echoed into `output`/logs is readable by anyone who can read the script. Store it as a `serviceCredential` (for a supported provider) or a script `variable`, and provision least-privilege tokens on the external side.
2. **`providerType` is a fixed enum.** `serviceCredential` only recognizes `openai`, `anthropic`, `deepseek`, `twilio`, `sendgrid`, `google`. A generic CRM/ERP token goes in a script `variable`, not an invented provider slot.
3. **Timeout stacking.** A slow external call plus your own retries can blow the script `timeout` (max 300000 ms). Set a per-call `axios` `timeout` well below the script budget and cap retries.
4. **Unbounded retry loops.** Retrying `429`/`5xx` forever will hit the run timeout and be killed mid-flight. Retry a small, fixed number of times with backoff, then give up and report.
5. **Open write endpoints.** `authentication.enabled: false` means *you* must verify the caller inside the script (shared-secret header or payload signature). Never trust an unauthenticated request body to mutate data.
6. **No duplicate protection.** Without an `externalId` correlation key and an upsert (find-then-create/update), inbound events create duplicate records. Always key sync writes off the external id.
7. **Echo loops.** Push → their webhook → inbound → push again. Skip no-op writes and tag the origin of sync-driven changes so you don't re-emit them ([§6.2](#62-avoiding-echo-loops)).
8. **Treating a webhook as reliable.** Outbound webhooks are fire-and-forget with no retry and no signature. For must-not-miss updates use a `lifecycleHooks` script; always back any sync with a scheduled reconcile.
9. **`output`, not `return`.** A script that `return`s its result without assigning `output` yields `output: null`. Assign the global `output`.
10. **Stale external tokens.** OAuth access tokens expire. Refresh them inside the script and persist the new value with `setVariable`; remember variables written mid-run are visible only on the **next** run.
11. **Short-lived run logs.** `console.error`/`warn` entries are retained briefly. For durable audit of sync failures, write them back to a record or an external log sink.
12. **Trigger enablement.** A `lifecycleHooks` push script also needs event-triggered automation enabled for that object at the account level, or the save is rejected.

---

## 9. Checklist

**Credentials**
- [ ] Supported provider (OpenAI / Twilio / SendGrid / etc.)? Stored the secret in a `serviceCredential`, set `providerType` + the provider sub-object, and configured record-level access. Reference it **by id**.
- [ ] Other service? Stored a least-privilege token as a script `variable` — never a literal in `code`.
- [ ] Per-user Google/Microsoft/HubSpot? Admin enabled the provider; each user connected via `/v2/oauth/*`; checked `connected` before assuming access.

**Outbound (Prolibu → external)**
- [ ] Call the external API with `axios` inside an async IIFE; assign the result to `output`.
- [ ] Set a per-call `axios` `timeout` below the script `timeout`; cap retries on `429`/`5xx`.
- [ ] Catch errors, inspect `err.response?.status`/`data`, and return a clean failure result.
- [ ] On change: `lifecycleHooks` script for reliable in-transaction pushes (object enabled at account level), or a `Webhook` for best-effort notification.

**Inbound (external → Prolibu)**
- [ ] Custom `Endpoint` (`routeName` + `method` + `script`), invoked at `/v2/endpoint/{method}/{routeName}`.
- [ ] Authenticated the caller: `authentication.enabled: true` + scoped API key, or a shared-secret header / signature verified inside the script.
- [ ] Or let the external system hit your REST API directly with a scoped API key / Connected App.

**Two-way sync**
- [ ] Added an `externalId` correlation field on the Prolibu object; store the Prolibu `_id` on the external side.
- [ ] All sync writes are **upserts** keyed by `externalId` — no duplicates.
- [ ] Broke echo loops (skip no-ops, tag sync origin).
- [ ] Scheduled a reconcile script (cron + `timeZone`) with a persisted `cursor` to catch dropped deliveries.

---

**See also:** [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Sites, Forms & Custom Endpoints](07-sites-forms-and-endpoints.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [Security & Permissions](10-security-and-permissions.md)
