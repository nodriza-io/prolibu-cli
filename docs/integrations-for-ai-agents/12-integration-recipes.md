# Integration Recipes

> Salesforce analogy: this is the **integration cookbook** every ISV keeps open while building — the end-to-end playbooks that compose Connected Apps, Named Credentials, Apex triggers/Flows, Outbound Messages, Web-to-Lead, Scheduled Apex, and Agentforce tool-calling into working integrations. Each recipe here assembles the public Prolibu primitives — [Custom Objects & Fields](02-custom-objects-and-fields.md), the [REST API](03-rest-api.md), [scripts/automation](05-automation-and-scripts.md), [webhooks](06-webhooks-and-events.md), [endpoints & forms](07-sites-forms-and-endpoints.md), [OAuth / connected apps & credentials](04-authentication-and-connected-apps.md), and [MCP](08-ai-and-mcp.md) — into a complete, copy-pasteable integration you can test against a sandbox account.

## When to use this

Reach for this document when you already understand the individual surfaces and now need to **wire several of them together** to solve a real problem: keeping a Prolibu object in step with an external CRM, standing up a brand-new business object with validation, capturing web leads, running a nightly sync, or letting an AI agent operate the account safely. Every recipe states its **goal**, its **Salesforce analogy**, the **primitives** it composes, **numbered steps with real public payloads**, and **how to test it against a sandbox/test account** through the public API. Where a deeper reference exists, the recipe links to it rather than repeating it.

The recipes are ordered from most-requested to most-specialized. They share a small set of conventions, established once here:

- `https://<domain>` is your account host (for example `https://acme.prolibu.com`). Use your **sandbox host** while building.
- `<API_KEY>` is an API key or OAuth access token sent as `Authorization: Bearer <API_KEY>` (see [Authentication & Connected Apps](04-authentication-and-connected-apps.md)). `<ADMIN_API_KEY>` denotes a key with configuration privileges (creating scripts, endpoints, webhooks, custom objects); `<SCOPED_KEY>` denotes a least-privilege key an automation uses to read/write data.
- All resource paths under `/v2/` are **lowercase**; JSON field names are **camelCase**.
- New schema (Custom Objects / Custom Fields) is applied **asynchronously** — poll for readiness before writing records.

## Prolibu ↔ Salesforce

| Recipe | Salesforce equivalent | Primitives composed |
|---|---|---|
| 1. Bi-directional CRM sync | Connected App + Named Credential + Trigger + Outbound Message + Apex REST | `oauthapp` / `servicecredential` / `script` (`lifecycleHooks`) / `webhook` / `endpoint` |
| 2. New business object end-to-end | Custom Object + Custom Field + validation Trigger | `cob` / `customfield` / REST CRUD / `script` (`lifecycleHooks` before-event) |
| 3. Web-to-lead capture | Web-to-Lead + Flow + Outbound Message | `form` / `endpoint` / `script` / `webhook` |
| 4. Scheduled sync job | Scheduled Apex integration job | `servicecredential` / `script` (`scheduledTask`) / REST upsert |
| 5. AI-native integration | Agentforce agent + external actions | MCP `oauthapp` / `token` / built-in tools |

Sibling documents: [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Sites, Forms & Custom Endpoints](07-sites-forms-and-endpoints.md) · [AI & MCP](08-ai-and-mcp.md) · [Connecting External Services](09-connecting-external-services.md) · [Security & Permissions](10-security-and-permissions.md) · [Best Practices](11-best-practices.md).

---

## Recipe 1 — Bi-directional sync with an external CRM

**Goal.** Keep a Prolibu `Deal` and an external CRM's opportunity object (Salesforce-style `Opportunity`) continuously in step: a change on either side propagates to the other, without duplicates and without infinite echo loops.

**Salesforce analogy.** A **Connected App** (so the external system can call you) + a **Named/External Credential** (so you can call it) + an **Apex trigger** that fires an **Outbound Message** on change + **Apex REST** to receive their callbacks — plus a **Scheduled Apex** reconcile as the safety net.

**Primitives composed.** A correlation custom field (`customfield`); the secure credential/variable store; an outbound push [script](05-automation-and-scripts.md) on a record event (`lifecycleHooks`); an inbound custom [endpoint](07-sites-forms-and-endpoints.md); and a scheduled reconcile script. (This recipe is the assembled, testable version of the patterns in [Connecting External Services](09-connecting-external-services.md).)

### Step 1 — Add the correlation key

Every sync step keys off a stable id shared by both records. Add an `externalId` custom field to `Deal` so you can store the external opportunity's id on the Prolibu record.

```bash
curl -s -X POST "https://<domain>/v2/customfield" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "objectAssigned": "Deal",
    "overrides": {
      "externalId": { "isCustomField": true, "type": "string", "unique": true }
    }
  }'
```

`overrides` puts `externalId` at the record **root** (so you read/write `deal.externalId` directly), and `unique` on a custom field is made **sparse** automatically — deals with no external id don't collide on `null`. Wait for the schema to apply before writing to it (see [Custom Objects & Fields](02-custom-objects-and-fields.md)):

```bash
until curl -sf -o /dev/null "https://<domain>/v2/deal?limit=1&select=externalId" \
  -H "Authorization: Bearer <ADMIN_API_KEY>"; do sleep 2; done
```

On the external side, store the Prolibu `_id` in *its* external-id field so the correlation is symmetric.

### Step 2 — Store the outbound credential

Prolibu must authenticate when it calls the external CRM. A generic CRM isn't in the fixed `serviceCredential` `providerType` enum (`openai`, `anthropic`, `deepseek`, `twilio`, `sendgrid`, `google`), so keep its base URL and OAuth token in the push script's persistent `variables` (a least-privilege token issued on the external side). You'll also need a **scoped callback key** so the inbound receiver can write Prolibu data — create it with only what it needs:

```bash
curl -s -X POST "https://<domain>/v2/token" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "tokenType": "API",
    "appName": "CRM sync callback",
    "scopes": ["Resource@Deal.find", "Resource@Deal.create", "Resource@Deal.update"]
  }'
# -> 201; copy the plaintext "apiKey" now — it is never returned again
```

### Step 3 — Outbound push on change (record-event script)

A `lifecycleHooks` script runs **inside the save**, so the push is part of the operation. On `Deal.afterCreate` it creates the external opportunity and writes the returned id back to `externalId`; on `Deal.afterUpdate` it patches the opportunity. It guards against echo loops by skipping writes that originated from the sync.

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Deal -> CRM push",
    "active": true,
    "lifecycleHooks": ["Deal"],
    "timeout": 20000,
    "variables": [
      { "key": "crmBaseUrl",  "value": "https://acme.my.salesforce.com" },
      { "key": "crmToken",    "value": "<EXTERNAL_OAUTH_ACCESS_TOKEN>" },
      { "key": "apiKey",      "value": "<SCOPED_KEY>" }
    ],
    "code": "SEE READABLE VERSION BELOW"
  }'
```

The readable `code` (paste this, JSON-escaped, into the `code` field above):

```js
(async () => {
  if (eventName !== 'Deal.afterCreate' && eventName !== 'Deal.afterUpdate') {
    output = { skipped: true };
    return;
  }
  const deal = eventData.doc || {};

  // Echo-loop guard: a write that came from the inbound sync is tagged; don't re-push it.
  if (deal.syncedFrom === 'crm') { output = { skipped: 'inbound-origin' }; return; }

  const base = variables.find(v => v.key === 'crmBaseUrl').value;
  const tok  = variables.find(v => v.key === 'crmToken').value;
  const key  = variables.find(v => v.key === 'apiKey').value;
  const body = { Name: deal.dealName, Amount: deal.amount, StageName: deal.stage };

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
      // Write the new external id back to the Prolibu record via our own REST API.
      await axios.patch(`https://${localDomain}/v2/deal/${deal._id}`,
        { externalId: r.data.id },
        { headers: { Authorization: `Bearer ${key}` } });
      output = { pushed: 'create', externalId: r.data.id };
    }
  } catch (e) {
    console.error('CRM push failed', e.response?.status, e.response?.data);
    output = { pushed: false, error: e.message };
  }
})();
```

> **Triggers are two-part and off by default.** Setting `lifecycleHooks: ["Deal"]` is not enough — event-triggered automation must also be **enabled for `Deal` at the account level** in your integration settings, or saving the script is rejected. See [Automation & Scripts §3.2](05-automation-and-scripts.md#32-run-on-a-record-event-triggers).

### Step 4 — Inbound receiver (custom endpoint)

The external CRM (via its outbound message / middleware) calls a public Prolibu endpoint. First the receiver script — it correlates by `externalId`, upserts the `Deal`, and tags the write with `syncedFrom: "crm"` so Step 3 won't bounce it back:

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "CRM inbound sync",
    "active": true,
    "timeout": 20000,
    "variables": [
      { "key": "apiKey",        "value": "<SCOPED_KEY>" },
      { "key": "inboundSecret", "value": "<SHARED_SECRET>" }
    ],
    "code": "SEE READABLE VERSION BELOW"
  }'
```

Readable `code`:

```js
(async () => {
  // 1. Authenticate the caller: this endpoint is public, so verify inside the script.
  const secret = eventData.headers['x-webhook-secret'];
  if (secret !== variables.find(v => v.key === 'inboundSecret')?.value) {
    output = { error: 'unauthorized' };
    return;
  }

  const evt = eventData.body || {};
  const key = variables.find(v => v.key === 'apiKey').value;
  const client = axios.create({
    baseURL: `https://${localDomain}/v2`,
    headers: { Authorization: `Bearer ${key}` },
  });

  // 2. Upsert keyed by externalId (the external opportunity id).
  const found = await client.get(`/deal?externalId=${encodeURIComponent(evt.Id)}&limit=1`);
  const patch = { dealName: evt.Name, amount: evt.Amount, stage: evt.StageName, syncedFrom: 'crm' };
  if (found.data.data.length) {
    await client.patch(`/deal/${found.data.data[0]._id}`, patch);
    output = { updated: true };
  } else {
    await client.post('/deal', { ...patch, externalId: evt.Id });
    output = { created: true };
  }
})();
```

(If you use a `syncedFrom` tag, add it as a Custom Field on `Deal` the same way as `externalId` in Step 1.)

Then the endpoint that exposes the script publicly — `authentication.enabled: false` because the CRM can't present your API key; the shared-secret header is checked inside the script:

```bash
curl -s -X POST "https://<domain>/v2/endpoint/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointName": "CRM inbound",
    "routeName": "crm-sync",
    "method": "POST",
    "script": "<INBOUND_SCRIPT_ID>",
    "active": true,
    "authentication": { "enabled": false }
  }'
```

Point the external system at (note the lowercase method segment):

```
https://<domain>/v2/endpoint/post/crm-sync
```

### Step 5 — Reconcile safety net (scheduled script)

Both pushes and webhooks are best-effort; a scheduled pull makes the sync eventually consistent. Configure the reconcile script from [Connecting External Services §6.3](09-connecting-external-services.md#63-reconciliation-the-safety-net) with a cron schedule and a persisted `cursor` variable:

```bash
curl -s -X PATCH "https://<domain>/v2/script/<RECONCILE_SCRIPT_ID>" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "active": true,
    "scheduledTask": { "periodicity": "0 * * * *", "timeZone": "America/Bogota" }
  }'
```

`scheduledTask.timeZone` is **required** with `periodicity`, and the minimum interval is once per minute.

### Testing Recipe 1 against a sandbox

Do all of this on your **sandbox host** with a least-privilege `<SCOPED_KEY>`.

1. **Prove the correlation field applied:** `GET /v2/deal?limit=1&select=externalId` returns `200` (not `404` on the field).
2. **Test inbound in isolation** — simulate the CRM by calling the endpoint directly with the shared-secret header:

   ```bash
   curl -s -X POST "https://<domain>/v2/endpoint/post/crm-sync" \
     -H "Content-Type: application/json" \
     -H "X-Webhook-Secret: <SHARED_SECRET>" \
     -d '{ "Id": "0065g00000ABCDEAA3", "Name": "Acme renewal", "Amount": 12000, "StageName": "Proposal" }'
   ```

   Expected `200`:

   ```json
   {
     "authenticated": false,
     "output": { "created": true }
   }
   ```

   Call it a second time with the same `Id` and a changed `Amount`; `output` becomes `{ "updated": true }` and `GET /v2/deal?externalId=0065g00000ABCDEAA3` shows a single record — proving the upsert deduped.
3. **Verify the auth guard:** repeat the call with a wrong/missing `X-Webhook-Secret`; `output` is `{ "error": "unauthorized" }` and no `Deal` is written.
4. **Test outbound** — create a `Deal` over REST and confirm the push wrote `externalId` back:

   ```bash
   curl -s -X POST "https://<domain>/v2/deal/" \
     -H "Authorization: Bearer <SCOPED_KEY>" -H "Content-Type: application/json" \
     -d '{ "dealName": "Sandbox push test", "amount": 5000, "stage": "negotiation" }'
   # then read it back and check externalId is populated
   ```

5. **Prove no echo loop:** confirm that the inbound upsert (which sets `syncedFrom: "crm"`) does **not** trigger a re-push — the push script's guard returns `{ skipped: "inbound-origin" }` in its run log.

---

## Recipe 2 — New business object, end-to-end

**Goal.** Model a brand-new entity — a `Vehicle` inspection record — as a first-class object: define it, expose it over REST, and enforce a validation rule that blocks bad writes before they persist.

**Salesforce analogy.** Create a **Custom Object** (`Vehicle__c`) with **Custom Fields**, get its auto-generated REST resource, and add a **before-save validation** (Validation Rule / before-insert trigger).

**Primitives composed.** A Custom Object (`cob`); its generated REST-CRUD resource; and a `lifecycleHooks` **before-event** script that validates and blocks invalid saves.

### Step 1 — Define the Custom Object

```bash
curl -s -X POST "https://<domain>/v2/cob" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "Vehicle",
    "vin":         { "type": "string", "required": true, "primaryKey": true, "unique": true,
                     "minLength": 17, "maxLength": 17, "displayName": true, "example": "1HGCM82633A004352" },
    "make":        { "type": "string", "required": true, "example": "Toyota" },
    "modelYear":   { "type": "number", "min": 1950, "max": 2027, "example": 2022 },
    "status":      { "type": "string", "enum": ["pending", "passed", "failed"], "default": "pending" },
    "mileage":     { "type": "number", "min": 0 },
    "inspector":   { "type": "objectid", "ref": "User" },
    "active": true
  }'
```

`modelName` is normalized to PascalCase singular on save — read it back from the `201` response (`"Vehicle"`) and derive the REST path from its lowercase form: `/v2/vehicle`. `primaryKey: true` on `vin` lets you address records by VIN, not only by `_id`.

### Step 2 — Wait for the resource to go live

Schema is applied asynchronously; until it is, `/v2/vehicle` returns `404`. Poll a lightweight list call:

```bash
until curl -sf -o /dev/null "https://<domain>/v2/vehicle?limit=1" \
  -H "Authorization: Bearer <ADMIN_API_KEY>"; do sleep 2; done
```

### Step 3 — Add a validation automation (before-event trigger)

Declarative constraints (`required`, `enum`, `min`/`max`, `unique`) are enforced automatically. For a **cross-field business rule** — "a `Vehicle` may only be marked `passed` if it has a recorded `mileage`" — use a `lifecycleHooks` **before** event and throw to abort the save (the equivalent of a Validation Rule / `addError()`):

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Vehicle inspection validation",
    "active": true,
    "lifecycleHooks": ["Vehicle"],
    "timeout": 10000,
    "code": "SEE READABLE VERSION BELOW"
  }'
```

Readable `code`:

```js
(async () => {
  // Only guard writes; run on before-create and before-update.
  if (eventName !== 'Vehicle.beforeCreate' && eventName !== 'Vehicle.beforeUpdate') {
    output = { ok: true };
    return;
  }
  const doc = eventData.doc || eventData.payload || {};
  if (doc.status === 'passed' && (doc.mileage === undefined || doc.mileage === null)) {
    // Throwing from a before-event aborts the save and surfaces the message to the caller.
    throw new Error('A Vehicle cannot be marked "passed" without a recorded mileage.');
  }
  output = { ok: true };
})();
```

Remember to **enable event-triggered automation for `Vehicle`** at the account level (Step 3 only takes effect once both parts are on — see [Automation & Scripts §3.2](05-automation-and-scripts.md#32-run-on-a-record-event-triggers)).

### Step 4 — CRUD it over REST

```bash
# Create (declarative validation runs first, then your before-event rule)
curl -s -X POST "https://<domain>/v2/vehicle" \
  -H "Authorization: Bearer <SCOPED_KEY>" -H "Content-Type: application/json" \
  -d '{ "vin": "1HGCM82633A004352", "make": "Honda", "modelYear": 2003, "mileage": 82000, "status": "passed" }'
# -> 201

# Read by primaryKey (VIN)
curl -s "https://<domain>/v2/vehicle/1HGCM82633A004352?populate=inspector" \
  -H "Authorization: Bearer <SCOPED_KEY>"

# Update
curl -s -X PATCH "https://<domain>/v2/vehicle/1HGCM82633A004352" \
  -H "Authorization: Bearer <SCOPED_KEY>" -H "Content-Type: application/json" \
  -d '{ "mileage": 83500 }'
```

### Testing Recipe 2 against a sandbox

1. **Confirm activation:** the `until` loop in Step 2 exits (the object is live) before you write anything.
2. **Happy path:** the create in Step 4 (with `mileage` present) returns `201`.
3. **Declarative validation fires:** a create missing `vin` (or with `status: "invalid"`, or `modelYear: 1900`) returns `400` naming the offending field — no custom code needed.
4. **Business rule fires:** a create with `status: "passed"` and **no** `mileage` is rejected with a `400` carrying your message *"A Vehicle cannot be marked \"passed\" without a recorded mileage."* — proving the before-event blocked the save.
5. **Uniqueness:** a second create with the same `vin` returns `400`/`409` (duplicate on a `unique` field).
6. **Undeclared field is dropped silently:** create with an extra `"color": "red"`; read the record back and confirm `color` was discarded (declare it first if you need it).

---

## Recipe 3 — Web-to-lead capture

**Goal.** Publish a public contact form that turns anonymous submissions into `Contact` (and optionally `Deal`) records, enriches them, and notifies an external marketing system.

**Salesforce analogy.** **Web-to-Lead** capturing into a lead/contact, a **Flow** that enriches the new record, and an **Outbound Message** to your marketing platform.

**Primitives composed.** A public [Form](07-sites-forms-and-endpoints.md) with `formSchema` + `mappings`; a `Contact.create` [webhook](06-webhooks-and-events.md) to notify the external system; and (optionally) a record-event [script](05-automation-and-scripts.md) to enrich the new contact.

### Step 1 — Create the public form

`formSchema` is the single source of truth for the fields; `mappings` turns a submission into a record on an existing object. Here a submission creates a `Contact`.

```bash
curl -s -X POST "https://<domain>/v2/form/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "formName": "Website contact form",
    "formSchema": {
      "title": "Talk to us",
      "fullName":    { "type": "string", "required": true },
      "email":       { "type": "email",  "required": true },
      "companyName": { "type": "string" },
      "message":     { "type": "textarea" }
    },
    "mappings": [
      {
        "modelName": "Contact",
        "action": "create",
        "fieldMap": {
          "fullName":    "firstName",
          "email":       "email",
          "companyName": "company.companyName"
        },
        "defaults": { "source": "web-form" }
      }
    ],
    "access": { "mode": "public", "enableCaptcha": true },
    "submissions": { "persist": true },
    "thankYou": { "title": "Thanks!", "message": "We will be in touch shortly." },
    "active": true
  }'
```

Response (`201`, abridged) — capture the `_id`; you submit against it:

```json
{ "_id": "665f0c9a1b2c3d4e5f0022aa", "formCode": "FRM-a1b2c3", "formName": "Website contact form", "active": true }
```

Every `fieldMap` value must reference a key present in `formSchema`, and every `modelName` must be an existing object, or the form is rejected with `400`. Because `submissions.persist` is `true`, each submission is also stored as a queryable `FormSubmission`.

### Step 2 — Notify the external system on new contacts

Subscribe a webhook to `Contact.create` so your marketing platform learns of every new lead. Trim the payload to the fields you need and authenticate with a shared-secret header (webhooks carry no HMAC signature):

```bash
curl -s -X POST "https://<domain>/v2/webhook/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookName": "New web leads -> marketing",
    "endpoint": "https://marketing.example.com/hooks/prolibu-lead",
    "eventNames": ["Contact.create"],
    "selectedFields": [
      { "entity": "Contact", "fields": ["firstName", "email", "company", "source"] }
    ],
    "headers": [{ "name": "X-Api-Key", "value": "<SHARED_SECRET>" }],
    "active": true
  }'
```

When a form submission (or any create) produces a `Contact`, your endpoint receives:

```json
{
  "eventName": "Contact.create",
  "eventData": { "firstName": "Ada Lovelace", "email": "ada@acme.com", "source": "web-form" }
}
```

### Step 3 (optional) — Enrich the lead before/after it is saved

If you need server-side enrichment (score the lead, normalize the name, look up the company), add a `Contact` record-event script. Use an **after** event to enrich without blocking the submission, calling your own REST API with a scoped key:

```js
(async () => {
  if (eventName !== 'Contact.afterCreate') { output = { skipped: true }; return; }
  const c = eventData.doc || {};
  if (c.source !== 'web-form') { output = { skipped: 'not-a-web-lead' }; return; }

  const key = variables.find(v => v.key === 'apiKey').value;
  // Example enrichment: split the submitted full name into first/last.
  const [firstName, ...rest] = String(c.firstName || '').trim().split(' ');
  await axios.patch(`https://${localDomain}/v2/contact/${c._id}`,
    { firstName, lastName: rest.join(' ') || undefined, leadScore: 10 },
    { headers: { Authorization: `Bearer ${key}` } });
  output = { enriched: true };
})();
```

(Add `source`, `leadScore` as Custom Fields on `Contact` first if they aren't already present — see Recipe 2 / [Custom Objects & Fields](02-custom-objects-and-fields.md).)

### Step 4 — Submit the form

The public submit route is **`PUT /v2/form/register`** (not `POST`) and takes `{ id, data }`. A `public` form with captcha needs a `captchaToken`; for headless server-side testing you can validate access with `verifyOnly`.

```bash
curl -s -X PUT "https://<domain>/v2/form/register" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "665f0c9a1b2c3d4e5f0022aa",
    "data": {
      "fullName": "Ada Lovelace",
      "email": "ada@acme.com",
      "companyName": "Acme Inc.",
      "message": "Interested in a demo."
    },
    "captchaToken": "<captcha token from the rendered form>"
  }'
```

Response (`200`) — one `results` entry per mapping:

```json
{
  "results": [
    { "modelName": "Contact", "action": "create", "recordId": "665f0c9a1b2c3d4e5f0033bb", "status": "success" }
  ],
  "redirectURL": null
}
```

### Testing Recipe 3 against a sandbox

1. **Render headlessly:** `GET /v2/form/jsonschema/<formId>` returns the schema (`fields` keyed by field key) — confirm your fields appear and that `mappings`/`access.password` are correctly **omitted** from the public payload.
2. **Submit a lead:** the `PUT /v2/form/register` call returns `200` with `status: "success"` and a `recordId`. Read it back: `GET /v2/contact/<recordId>` shows `source: "web-form"` from `defaults`.
3. **Confirm persistence:** `GET /v2/formsubmission?form=<formId>&sort=-createdAt&limit=1` returns the stored submission with `status: "processed"`.
4. **Confirm the webhook fired:** your `marketing.example.com` receiver logs a `Contact.create` delivery carrying only the `selectedFields`; assert `X-Api-Key` matches before trusting the body.
5. **Enrichment (if used):** after the after-event runs, the `Contact` shows a split `firstName`/`lastName` and `leadScore: 10`.
6. **Negative paths:** submit with `POST` instead of `PUT` (it won't hit `register`); omit the required `email` (→ `400`); and hammer the endpoint to observe per-IP/per-form rate limiting (`429`).

---

## Recipe 4 — Scheduled sync job

**Goal.** Every night, pull records from an external API and upsert them into a Prolibu object — the classic one-way batch import / reconcile.

**Salesforce analogy.** **Scheduled Apex** that makes a callout using a **Named Credential** and upserts on an **External Id**.

**Primitives composed.** A stored credential (or a script `variable` for non-enum providers); a scheduled [script](05-automation-and-scripts.md) (`scheduledTask.periodicity` + `timeZone`); and idempotent **upsert** against the [REST API](03-rest-api.md), keyed by a correlation field and advanced with a persisted `cursor`.

### Step 1 — Store the provider credential

If the source is a supported provider, store it in `serviceCredential`; otherwise keep a least-privilege token in the script's `variables`. Example with a supported provider:

```bash
curl -s -X POST "https://<domain>/v2/servicecredential" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "serviceCredentialName": "Data source (SendGrid slot)",
    "providerType": "sendgrid",
    "priority": 1,
    "active": true,
    "sendgrid": { "apiKey": "<PROVIDER_KEY>" }
  }'
# -> 201; the secret comes back encrypted, referenced later by _id
```

For a generic HTTP source, skip this and put the token in the script's `variables` (Step 2). Either way you also need a **scoped callback key** (`Resource@<Object>.find|create|update`) so the job can upsert account data.

### Step 2 — Create the scheduled upsert script

Set both `scheduledTask.periodicity` (a valid ≥ 1-minute cron) and `scheduledTask.timeZone` (IANA). Read the last checkpoint from a `cursor` variable, pull only what changed since, and upsert idempotently.

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Nightly external upsert",
    "active": true,
    "timeout": 120000,
    "scheduledTask": { "periodicity": "0 2 * * *", "timeZone": "America/Bogota" },
    "variables": [
      { "key": "apiKey",     "value": "<SCOPED_KEY>" },
      { "key": "sourceUrl",  "value": "https://data.example.com/api/records" },
      { "key": "sourceToken","value": "<PROVIDER_KEY>" },
      { "key": "cursor",     "value": "2000-01-01T00:00:00Z" }
    ],
    "code": "SEE READABLE VERSION BELOW"
  }'
```

Readable `code`:

```js
(async () => {
  const key    = variables.find(v => v.key === 'apiKey').value;
  const srcUrl = variables.find(v => v.key === 'sourceUrl').value;
  const srcTok = variables.find(v => v.key === 'sourceToken').value;
  const since  = variables.find(v => v.key === 'cursor')?.value || '2000-01-01T00:00:00Z';

  const local = axios.create({
    baseURL: `https://${localDomain}/v2`,
    headers: { Authorization: `Bearer ${key}` },
  });

  // 1. Pull records changed on the external side since our checkpoint.
  const { data: page } = await axios.get(srcUrl, {
    params: { modifiedSince: since, limit: 500 },
    headers: { Authorization: `Bearer ${srcTok}` },
    timeout: 30000,
  });
  const records = page.records || [];

  // 2. Upsert each into Prolibu, keyed by externalId (idempotent — no duplicates).
  let created = 0, updated = 0;
  for (const rec of records) {
    const found = await local.get(`/vehicle?externalId=${encodeURIComponent(rec.id)}&limit=1`);
    const body = { make: rec.make, modelYear: rec.year, mileage: rec.mileage };
    if (found.data.data.length) {
      await local.patch(`/vehicle/${found.data.data[0]._id}`, body);
      updated++;
    } else {
      await local.post('/vehicle', { ...body, vin: rec.vin, externalId: rec.id });
      created++;
    }
  }

  // 3. Advance the checkpoint for the next run (visible on the NEXT run only).
  await setVariable('cursor', new Date().toISOString());
  output = { pulled: records.length, created, updated, cursor: since };
})();
```

- `scheduledTask.timeZone` is mandatory whenever `periodicity` is present; sub-minute frequency is rejected on production.
- `variables` are a **start-of-run snapshot**; `setVariable('cursor', ...)` takes effect on the **next** run — checkpoint conservatively (a slight overlap is safe because the upsert is idempotent).
- Set `timeout` with headroom (up to `300000` ms) and paginate large pulls (`limit` on the source; the Prolibu REST `limit` caps at `500`, use `exportData=true` for larger reads).

### Testing Recipe 4 against a sandbox

1. **Dry-run manually before scheduling.** A script with a schedule can also be invoked on demand — run it and read the result envelope:

   ```bash
   curl -s "https://<domain>/v2/script/run?scriptId=<SCRIPT_ID>" \
     -H "Authorization: Bearer <ADMIN_API_KEY>"
   # -> { "output": { "pulled": 3, "created": 3, "updated": 0, "cursor": "2000-01-01T00:00:00Z" }, "error": null, "timeMs": ... }
   ```

2. **Prove idempotency:** run it a second time with the same source data — `created` drops to `0` and `updated` reflects the same set; `GET /v2/vehicle?externalId=<id>` still returns a single record.
3. **Prove the cursor advances:** after the first run, `GET /v2/script/<SCRIPT_ID>?select=variables` shows `cursor` bumped to a recent timestamp, so the next run only pulls newer records.
4. **Attach the schedule and let it fire:** `PATCH` the script with the `scheduledTask` (Step 2 already includes it), wait for the next minute-aligned tick on a fast test cron (e.g. `* * * * *`), and confirm a fresh run appears in the run log — then restore the real cadence.
5. **Failure handling:** point `sourceUrl` at an endpoint that returns `500` and confirm the script logs `err.response?.status` and returns a clean `{ ok: false }`-style result rather than crashing opaquely.

---

## Recipe 5 — AI-native integration (MCP)

**Goal.** Connect an external AI agent to the account through the MCP interface and let it perform **safe** CRUD — discover the schema, read records, create a deal-with-proposal — bounded by a least-privilege credential.

**Salesforce analogy.** An **Agentforce agent** (or an external client using **external actions**) that calls the account's exposed tools on behalf of an authenticated user, gated by that user's permission set.

**Primitives composed.** The MCP endpoint and its built-in tools; a bearer credential — either a scoped [API key](04-authentication-and-connected-apps.md#2-inbound-api-keys-machine-to-machine) or a user-delegated [OAuth 2.0](04-authentication-and-connected-apps.md#3-inbound-connected-apps-oauth-20-authorization-server) token; and the account's per-token authorization model.

### Step 1 — Enable MCP and issue a scoped credential

MCP is **off by default** — an administrator enables it in the account's integration preferences (until then `/v2/mcpsession/ses` returns `403`). The agent acts **as the user of the token you give it**, so mint a least-privilege key rather than an admin key:

```bash
curl -s -X POST "https://<domain>/v2/token" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "tokenType": "API",
    "appName": "Sales AI agent",
    "scopes": [
      "Resource@Contact.find", "Resource@Deal.find",
      "Resource@Deal.create", "Resource@Deal.update"
    ]
  }'
# -> 201; copy the plaintext apiKey now
```

For a user-delegated flow (Claude Desktop, Cursor, your own agent), register a **Connected App** and obtain a bearer token via the OAuth authorization-code flow instead — the MCP metadata document advertises the OAuth endpoints so the client auto-configures. See [Authentication & Connected Apps §3](04-authentication-and-connected-apps.md#3-inbound-connected-apps-oauth-20-authorization-server).

### Step 2 — Discover the endpoint

The public metadata document works even while MCP is disabled — use it to find the endpoint and auth flow:

```bash
curl -s "https://<domain>/v2/mcpsession/metadata"
```

```json
{
  "protocolVersion": "2025-03-26",
  "transportType": "streamable-http",
  "endpoint": "https://<domain>/v2/mcpsession/ses",
  "capabilities": { "tools": true, "resources": false, "prompts": false },
  "authentication": {
    "type": "oauth2",
    "authorizationEndpoint": "https://<domain>/v2/oauthgrant/authorize",
    "tokenEndpoint": "https://<domain>/v2/oauthgrant/token"
  }
}
```

### Step 3 — Initialize a session and capture the session id

```bash
curl -is -X POST "https://<domain>/v2/mcpsession/ses" \
  -H "Authorization: Bearer <SCOPED_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "sales-agent", "version": "1.0.0" }
    }
  }'
# Response header carries: Mcp-Session-Id: <uuid>  — echo it on every later call.
```

Send `Mcp-Session-Id` on every subsequent request; sessions expire after 30 minutes of inactivity.

### Step 4 — Ground the agent: who am I, and what can I touch

Always call `getMyProfile` first, then discover the schema before writing.

```bash
curl -s -X POST "https://<domain>/v2/mcpsession/ses" \
  -H "Authorization: Bearer <SCOPED_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <uuid>" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "getMyProfile", "arguments": {} } }'
```

The tool result is JSON-encoded in `content[0].text`; parse it for `profile`, `isAdmin`, and the `permissions` map. Then use `describeModel` (arg `modelName: "Deal"`) to learn field names before creating anything.

> **The permission map is advisory to the LLM, not the gate.** Real authorization is enforced by the **token's own scopes** — the same model as the REST API. Scope the key (Step 1); don't rely on the agent policing itself. See [Security & Permissions](10-security-and-permissions.md).

### Step 5 — Safe reads and writes with the built-in tools

Read with `find` / `findOne` / `search` (small pages by default). Create a deal **with a proposal** using `createProposal` — never the generic `create` for proposals:

```bash
curl -s -X POST "https://<domain>/v2/mcpsession/ses" \
  -H "Authorization: Bearer <SCOPED_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <uuid>" \
  -d '{
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {
      "name": "createProposal",
      "arguments": {
        "contactId": "665f0a...contactId",
        "dealName": "Acme rollout — Q3",
        "proposalTitle": "Acme Platform Subscription",
        "currency": "USD",
        "lineItems": [
          { "productName": "Platform license", "price": 1200, "quantity": 10 },
          { "productName": "Onboarding", "price": 3000, "quantity": 1, "discountRate": 0.1 }
        ],
        "expirationDate": "2026-09-30"
      }
    }
  }'
```

The decoded result carries `{ modelName: "Deal", data, webUrl, previewUrl, trackingUrl }`. To preview pricing without saving, call `calculateQuote` first; to change line items later, call `updateProposal` with the **complete** `lineItems` set (omitted items are removed).

### Testing Recipe 5 against a sandbox

1. **Discovery before enablement:** `GET /v2/mcpsession/metadata` returns `200` even before MCP is on — confirms the endpoint. A `tools/call` before enablement returns `403`, confirming the gate.
2. **Auth boundary:** call `/v2/mcpsession/ses` with no token → `401`; with the scoped key → session initializes and returns an `Mcp-Session-Id`.
3. **Least-privilege proof:** with the Step 1 scopes (no `Contact.create`), have the agent attempt `create` on `Contact`; the tool result comes back with `isError: true` and a `403`-style message — proving the token, not the LLM, enforces the boundary.
4. **Grounding:** `getMyProfile` returns the token user's `permissions` map matching the scopes you granted; `describeModel` for `Deal` inlines the `proposal.quote` line-item schema.
5. **Write path:** `createProposal` returns a `Deal` with `proposal.enabled: true` and a computed `quote.total`; read it back over REST (`GET /v2/deal/<id>?select=dealName proposal`) to confirm the agent's write landed and is stamped to the token's user.
6. **Session hygiene:** let the session idle > 30 minutes, reuse the stale `Mcp-Session-Id`, and confirm the call fails — then re-`initialize` to recover.

---

## Cross-recipe common pitfalls

1. **Schema is not live the instant you create it.** Custom Objects and Custom Fields (Recipes 1, 2, 3) are applied asynchronously — poll a `limit=1` list call until it stops returning `404` before writing records or referencing new fields, or writes silently drop the undeclared fields.
2. **Triggers are two-part and off by default.** Every `lifecycleHooks` script (Recipes 1, 2, 3) also needs event-triggered automation **enabled per object at the account level**, or saving the script is rejected.
3. **`output`, not `return`.** Every script's result is what it assigns to the global `output`; a bare `return` yields `output: null` (all recipes with scripts).
4. **Never hard-code third-party secrets.** Store provider keys in `serviceCredential` (encrypted, by id) or, for services outside the fixed `providerType` enum, in a script `variable` — never a literal in `code`, an `output`, a webhook payload, or a log line.
5. **Public endpoints/forms are not unprotected.** `authentication.enabled: false` (Recipe 1) means *you* verify the caller inside the script (shared-secret header / signature); public forms (Recipe 3) enforce captcha/password. "No bearer required" is never "no protection."
6. **Webhooks are best-effort.** No retry, no HMAC signature (Recipes 1, 3). Authenticate with a shared-secret header, dedupe on a stable key, and pair every sync with a scheduled reconcile.
7. **Upsert on a correlation key.** Without an `externalId` + find-then-create/update (Recipes 1, 4), inbound events create duplicates. Break echo loops by tagging sync-origin writes.
8. **`scheduledTask.timeZone` is mandatory with `periodicity`,** and no schedule runs sub-minute (Recipes 1, 4).
9. **The form submit route is `PUT /v2/form/register`,** not `POST`; endpoint responses are wrapped as `{ authenticated, output }` — read `response.output` (Recipes 1, 3).
10. **Scope every credential to the minimum.** The callback keys, agent keys, and Connected Apps in every recipe act with their token's full reach — grant the narrowest `scopes` that work, and never hand an autonomous agent an admin key.
11. **MCP is off by default and the permission map is advisory** (Recipe 5). Enablement is separate from discovery, and the token's scopes — not the LLM — enforce authorization.
12. **Use the proposal tools for proposals** (Recipe 5). `createProposal` / `updateProposal`, never the generic `create` / `update`, and `updateProposal` replaces the entire `lineItems` set.

---

## Master checklist

**Recipe 1 — CRM sync**
- [ ] Added an `externalId` correlation field on `Deal` (and confirmed it applied).
- [ ] Stored the external token in the push script's `variables`; minted a scoped callback key.
- [ ] Outbound `lifecycleHooks` push script (object enabled at account level) with an echo-loop guard.
- [ ] Inbound `POST` endpoint (`authentication.enabled: false`) verifying a shared-secret header inside the script; upsert keyed by `externalId`.
- [ ] Scheduled reconcile script with `timeZone` and a persisted `cursor`.
- [ ] Tested inbound/outbound/echo-loop/auth-guard against a sandbox host.

**Recipe 2 — New object**
- [ ] `POST /v2/cob` with a non-reserved `modelName`; read back the normalized name; polled until `/v2/<name>` is live.
- [ ] Declared every field; marked one `primaryKey`/`displayName`.
- [ ] Before-event `lifecycleHooks` validation script that throws to block bad saves (object enabled at account level).
- [ ] Tested happy path, declarative validation, business-rule block, uniqueness, and undeclared-field drop.

**Recipe 3 — Web-to-lead**
- [ ] `Form` with a valid `formSchema` and `mappings` referencing existing objects and schema keys; chose `access.mode` + captcha; set `submissions.persist`.
- [ ] `Contact.create` webhook (trimmed `selectedFields`, shared-secret header) to the external system.
- [ ] Optional after-event enrichment script.
- [ ] Submitted with **`PUT /v2/form/register`**; verified the record, the `FormSubmission`, the webhook delivery, and the `429`/`400` negative paths.

**Recipe 4 — Scheduled sync**
- [ ] Credential in `serviceCredential` (supported provider) or a least-privilege `variable`; scoped callback key.
- [ ] Scheduled script with valid cron + `timeZone`; pull-since-`cursor`; idempotent upsert keyed by `externalId`.
- [ ] Dry-ran via `GET /v2/script/run`; proved idempotency and cursor advance; exercised the failure branch.

**Recipe 5 — AI-native (MCP)**
- [ ] Admin enabled MCP; issued a least-privilege API key (or user-delegated OAuth token).
- [ ] Discovered via `/v2/mcpsession/metadata`; initialized a session and echoed `Mcp-Session-Id`.
- [ ] Called `getMyProfile` + `describeModel` before writing; used `find`/`findOne`/`search` for reads.
- [ ] Built deal proposals only with `createProposal` / `updateProposal`; previewed with `calculateQuote`.
- [ ] Verified the auth boundary (`401`/`403`), least-privilege enforcement, and session expiry against a sandbox.

---

**See also:** [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Sites, Forms & Custom Endpoints](07-sites-forms-and-endpoints.md) · [AI & MCP](08-ai-and-mcp.md) · [Connecting External Services](09-connecting-external-services.md) · [Security & Permissions](10-security-and-permissions.md) · [Best Practices](11-best-practices.md)
