# Webhooks & Events

> Salesforce analogy: this is Prolibu's **Outbound Messages + Platform Events + Scheduled Jobs**. You subscribe an external URL to record events (`create` / `update` / `delete`), you configure per-user event subscriptions for notifications, and you schedule recurring work — all without writing server code.

## When to use this

Reach for this layer whenever your integration must **find out that something happened** in a Prolibu account, or must **do something out-of-band** on a schedule. Outbound **webhooks** push record changes to your HTTP endpoint; **event subscriptions** control which in-app / multichannel notifications a user receives; **scheduled automations** run recurring jobs. If instead you need logic to run *synchronously as part of a write* (validate, enrich, block), that belongs in an automation script triggered on a record event — see [Automation & Scripts](05-automation-and-scripts.md).

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Key difference |
|---|---|---|
| `Webhook` resource subscribed to `<Object>.create/update/delete` | Outbound Messages | POST JSON `{ eventName, eventData }`. Fire-and-forget, no built-in retry — authenticate with custom `headers`. |
| Event names `<Object>.create` / `.update` / `.delete` / `.*` | Change-data-enabled objects | Automatic for **every** object, standard and custom. |
| `EventSubscription` (per-user notification preferences) | Notification / Subscription settings | In-app + multichannel delivery preferences, **not** a message bus. |
| Notification channels: `notificationCenter`, `email`, `slack`, `telegram`, `discord`, `ultramsg` (WhatsApp) | Custom Notifications / channels | Honors each user's enabled delivery channels. |
| Scheduled automation (cron on a script) | Scheduled Apex / CronTrigger | Recurring server-side job; runs at most once per minute. |
| Async, durable background work with retries | Queueable / Batch Apex | Handled by the platform; you observe results via webhooks or by polling the REST API. |

Sibling documents: [REST API](03-rest-api.md) (how to read/write records and discover custom actions), [Custom Objects & Fields](02-custom-objects-and-fields.md) (the fields you can select into a payload), [Automation & Scripts](05-automation-and-scripts.md) (in-transaction logic and scheduled scripts), [Authentication & Connected Apps](04-authentication-and-connected-apps.md) (tokens), and [Security & Permissions](10-security-and-permissions.md).

---

## Decision guide: which mechanism do I use?

Everything here is reactive or scheduled, but each tool solves a different problem. Pick before you build:

| I need to… | Use | Salesforce equivalent | Section |
|---|---|---|---|
| Notify an **external HTTP system** when a record is created / updated / deleted | **Webhook** | Outbound Message | [§1](#1-outbound-webhooks) |
| Run **reliable, in-transaction** logic on create / update / delete (validate, derive fields, call an API and be sure it ran) | **Script on a record event** | Apex Trigger | [Automation & Scripts](05-automation-and-scripts.md) |
| Notify a **user** (in-app / email / Slack / WhatsApp…) according to their preferences | **`EventSubscription`** | Custom Notification / Subscription | [§2](#2-event-subscriptions-per-user-notifications) |
| Run something on a **recurring schedule** | **Scheduled automation** (cron on a script) | Scheduled Apex | [§3](#3-scheduled-automations) |

Rule of thumb: **a webhook is fire-and-forget HTTP output** — treat delivery as best-effort. **A script on a record event is reliable in-transaction logic** — use it for anything that must not be missed. If you need a guarantee that your system saw every change, pair a webhook with a periodic reconcile (poll the REST API for records changed since your last checkpoint).

---

## 1. Outbound Webhooks

A `Webhook` subscribes an external URL to the `create` / `update` / `delete` events of one or more objects. When a matching event occurs, the platform sends an HTTP `POST` with a JSON body to that URL. This is the direct analog of a Salesforce **Outbound Message**.

Webhooks are managed through the standard REST-CRUD surface at `/v2/webhook/` (create / read / update / delete), exactly like any other object — see [REST API](03-rest-api.md).

### 1.1 The `Webhook` resource

| Field | Type | Notes |
|---|---|---|
| `webhookCode` | `String` (auto) | Auto-generated unique code, prefixed `WHK-`. Read-only. |
| `webhookName` | `String`, required | Human-readable name. |
| `endpoint` | `String`, required, unique | The destination URL that receives the POST. Must be a valid URL and unique across your webhooks. |
| `eventNames` | `[String]`, required | The subscribed events, from the catalog in [§1.2](#12-event-names). At least one is required. |
| `selectedFields` | `[Object]` | Optional per-object field filter for the payload. Each entry is `{ entity, fields }` — see [§1.5](#15-trimming-the-payload-with-selectedfields). |
| `headers` | `[Object]` | Optional custom HTTP headers added to every request. Each entry is `{ name, value }`. Use these to authenticate your endpoint. |
| `timeoutMs` | `Number`, default `5000` | Request timeout in milliseconds before the destination is considered unresponsive. |
| `active` | `Boolean` | Only webhooks with `active: true` fire. |

There is no `secret` field and no built-in HMAC signature. Authenticate incoming deliveries by asserting a shared secret you place in a custom header (for example `X-Api-Key`) and/or by restricting your endpoint to Prolibu's egress IP range. See [§4](#4-signature-and-delivery-verification).

### 1.2 Event names

Every object — standard and custom — automatically exposes four event names. There is no catalog to provision; the events exist the moment the object exists:

| Event name | Fires when |
|---|---|
| `<Object>.create` | A record of that object is created |
| `<Object>.update` | A record is updated |
| `<Object>.delete` | A record is deleted |
| `<Object>.*` | Any of the above (wildcard) |

Examples of valid entries in `eventNames`: `Contact.create`, `Contact.update`, `Contact.delete`, `Contact.*`, `Deal.create`, `EventProspect.update`. Use the object's **camelCase API name** (not the lowercased URL segment) in event names — `Contact.create`, not `contact.create`.

> There are **no fine-grained business events** such as `Deal.approved` or `Deal.stageChanged`. Only `create` / `update` / `delete` are delivered over webhooks. Business-level state changes surface as ordinary `update` events (inspect the before/after documents to detect them) or as per-user notifications via [event subscriptions](#2-event-subscriptions-per-user-notifications).

### 1.3 Which writes fire a webhook

Any create, update, or delete performed through the platform's standard write path fires the corresponding event — whether the write came from the REST API, an automation script, a form submission, or an inbound integration. If you PATCH a `Contact` via the REST API, `Contact.update` fires. If an automation creates a `Deal`, `Deal.create` fires.

Delivery is **asynchronous and non-blocking**: the API response to the caller does not wait for your endpoint to answer. Do not assume any ordering between the webhook delivery and the HTTP response the writing client received.

### 1.4 Delivery payload shape

The envelope is **always** `{ eventName, eventData }`. The shape of `eventData` depends on the action (and on any `selectedFields` trimming from [§1.5](#15-trimming-the-payload-with-selectedfields)).

**`create`** — `eventData` is the created record:

```json
{
  "eventName": "Contact.create",
  "eventData": { "firstName": "John", "lastName": "Doe", "email": "john@acme.com" }
}
```

**`update`** — `eventData` is `{ payload, beforeUpdateDoc, afterUpdateDoc }`:

```json
{
  "eventName": "Contact.update",
  "eventData": {
    "payload":         { "firstName": "Jane" },
    "beforeUpdateDoc": { "firstName": "John", "lastName": "Doe", "email": "john@acme.com" },
    "afterUpdateDoc":  { "firstName": "Jane", "lastName": "Doe", "email": "john@acme.com" }
  }
}
```

- `payload` — only the fields that were sent in the update request (intersected with `selectedFields`, if configured). **This is not a full diff.**
- `beforeUpdateDoc` / `afterUpdateDoc` — the record before and after the change. **Compute the real diff from these two**, not from `payload`.

**`delete`** — `eventData` is the deleted record:

```json
{ "eventName": "Contact.delete", "eventData": { "firstName": "Jane", "lastName": "Doe", "email": "jane@acme.com" } }
```

### 1.5 Trimming the payload with `selectedFields`

By default the payload carries the **full record**. To restrict it to a chosen set of fields, set `selectedFields` — an array of `{ entity, fields }` entries, one per object:

```json
"selectedFields": [
  { "entity": "Contact", "fields": ["firstName", "lastName", "email"] }
]
```

Behavior:

- `entity` is the object's camelCase API name; `fields` is a non-empty list of field paths on that object. Every listed field must exist on the object, or the webhook is rejected at creation time with a `400` error naming the offending field.
- Nested paths are supported with dot notation, e.g. `proposal.quote.total`.
- **If there is no `selectedFields` entry for the object that fired, the payload is sent untrimmed** (the whole record). Trimming is opt-in, per object.
- For `update`, each of the three branches — `payload`, `beforeUpdateDoc`, `afterUpdateDoc` — is trimmed independently to the same field list.

### 1.6 Worked example — create a webhook and receive a delivery

**Step 1 — create the webhook** (REST):

```bash
curl -X POST "https://<domain>/v2/webhook/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookName": "Sync contacts to CRM",
    "endpoint": "https://my-integration.example.com/hooks/prolibu",
    "eventNames": ["Contact.create", "Contact.update", "Contact.delete"],
    "selectedFields": [
      { "entity": "Contact", "fields": ["firstName", "lastName", "email"] }
    ],
    "headers": [
      { "name": "X-Api-Key", "value": "s3cr3t-shared-token" }
    ],
    "timeoutMs": 5000,
    "active": true
  }'
```

Response (`201`):

```json
{
  "webhookCode": "WHK-a1b2c3",
  "webhookName": "Sync contacts to CRM",
  "endpoint": "https://my-integration.example.com/hooks/prolibu",
  "eventNames": ["Contact.create", "Contact.update", "Contact.delete"],
  "selectedFields": [
    { "entity": "Contact", "fields": ["firstName", "lastName", "email"] }
  ],
  "timeoutMs": 5000,
  "active": true,
  "_id": "665f1c2a9b4e2f0012a3b4c5"
}
```

**Step 2 — trigger it.** Any create of a `Contact` (via `POST /v2/contact/`, a form, or an automation) now posts to your endpoint:

```json
{
  "eventName": "Contact.create",
  "eventData": { "firstName": "John", "lastName": "Doe", "email": "john@acme.com" }
}
```

**Step 3 — handle it.** Your endpoint asserts `X-Api-Key: s3cr3t-shared-token`, processes the event, and returns a `2xx` promptly. If you respond with an error or take longer than `timeoutMs`, treat the delivery as potentially lost and rely on a reconcile pass (see [§5](#5-common-pitfalls)) to catch up.

### 1.7 Worked example — detect a stage change from an `update`

Because there is no dedicated "stage changed" event, subscribe to `Deal.update` and diff the two documents your endpoint receives:

```js
// Express-style handler for POST /hooks/prolibu
app.post('/hooks/prolibu', (req, res) => {
  if (req.get('X-Api-Key') !== process.env.PROLIBU_SHARED_SECRET) {
    return res.sendStatus(401);
  }

  const { eventName, eventData } = req.body;

  if (eventName === 'Deal.update') {
    const { beforeUpdateDoc, afterUpdateDoc } = eventData;
    if (beforeUpdateDoc.stage !== afterUpdateDoc.stage) {
      console.log(`Deal ${afterUpdateDoc._id} moved ${beforeUpdateDoc.stage} → ${afterUpdateDoc.stage}`);
      // enqueue your downstream sync here
    }
  }

  res.sendStatus(200); // ack quickly; do heavy work asynchronously
});
```

Acknowledge fast (`2xx`) and offload heavy processing to your own queue — the platform will not wait, and slow endpoints risk hitting `timeoutMs`.

---

## 2. Event Subscriptions (per-user notifications)

An `EventSubscription` is **not** a webhook and **not** a message bus. It is the per-user **notification-preference** system: which platform events a given user is notified about, and over which channels (in-app notification center, email, Slack, Telegram, Discord, WhatsApp). Salesforce analog: Notification / Subscription settings, not Platform Events.

There is exactly **one** subscription per user, created automatically when the user is created. You typically read and adjust your own subscription; you don't create or delete these directly.

### 2.1 Shape

An `EventSubscription` holds:

- `eventSubscriptionCode` — auto-generated unique code, prefixed `EVS-`. Read-only.
- `eventSubscriptionName` — human-readable name.
- `user` — the user this subscription belongs to (1:1).
- `events` — a nested tree of **category → event → channels**. Each leaf event carries the boolean delivery channels below.

**Delivery channels** (all booleans, present on each leaf event):

| Channel | Delivers to |
|---|---|
| `notificationCenter` | In-app notification center |
| `email` | Email |
| `slack` | Slack |
| `telegram` | Telegram |
| `discord` | Discord |
| `ultramsg` | WhatsApp (via UltraMsg) |
| `popup` | In-app popup (only on specific events, e.g. under `deals` and `presentations`) |

**Event catalog** (categories and representative events, verbatim):

| Category | Events (leaf keys) |
|---|---|
| `general` | `onMyBirthday`, `onOthersBirthday`, `onApiNotification` |
| `contacts` | `onSetAsAssignee`, `onAddedAsCollaborator`, `onCreate`, `onDelete`, `onEndFlowStage`, `onChangeStage`, `onChangePriority`, `onAvailableForAssignment`, `onResubmit` |
| `comments` | `onMentioned` |
| `notes` | `onSetAsAssignee`, `onAddedAsCollaborator`, `onMentioned`, `onCreate`, `onDelete` |
| `tasks` | `onDueReminder`, `onChangeStage`, `onChangePriority`, `onMentioned` |
| `tickets` | `onAddComment`, `onAvailableForAssignment`, `onDueReminder`, `onFiveStarRating` |
| `deals` | `onSetAsAssignee`, `onAddedAsCollaborator`, `onCreate`, `onDelete`, `onChangeStage`, `onChangePriority`, `onUnpublishedProposalView`, `onFiveStarRating`, `onEndFlowStage`, `onView` (+`popup`), `onApprove` (+`popup`), `onDeny` (+`popup`) |
| `presentations` | `onSetAsAssignee`, `onAddedAsCollaborator`, `onView` (+`popup`) |
| `calendar` | `onNewEvent`, `onAcceptEvent`, `onCancelEvent`, `onEventReminder` |
| `signatures` | `onSignerStatusChange`, `onCreate`, `onDelete`, `onCompleteAllSignatures`, `onReject`, `onChangeStatus` |
| `rewards` | `onGrantReward` |
| `badges` | `onAwardBadge` |
| `security` | `onSignin`, `onPasswordReset` |

Each event has a platform default (some off, some notification-center-only, some notification-center-plus-email, some also popup). Only keys present in this canonical catalog are selectable — any key you send that is not in the catalog is silently ignored.

### 2.2 Endpoints

| Method + Path | Purpose |
|---|---|
| `GET /v2/eventsubscription/getMine` | Return the calling user's subscription, merged with current platform defaults. |
| `PUT /v2/eventsubscription/updateMine` | Update the calling user's subscription. Body: `{ events }` where `events` is the category → event → channels object. |

Both require authentication and operate on **your own** subscription (derived from the token). `getMine` merges the latest defaults over what's stored, so newly introduced events appear without any migration.

> The `events` body is an **object** (the category → event → channels tree), not a flat array. You may address a leaf with a dotted key (`"deals.onApprove"`) or with nested objects (`"deals": { "onApprove": { ... } }`) — both are accepted. Keys outside the catalog are dropped.

### 2.3 Worked example — read and adjust my preferences

Read the current subscription:

```bash
curl "https://<domain>/v2/eventsubscription/getMine" \
  -H "Authorization: Bearer $TOKEN"
```

Response (`200`, abridged):

```json
{
  "eventSubscriptionCode": "EVS-9f8e7d",
  "events": {
    "deals": {
      "onApprove": { "notificationCenter": true, "email": false, "popup": false },
      "onChangeStage": { "notificationCenter": true, "email": false }
    },
    "tasks": {
      "onDueReminder": { "notificationCenter": true, "email": true }
    }
  }
}
```

Turn on `deals.onApprove` over notification center + email + popup:

```bash
curl -X PUT "https://<domain>/v2/eventsubscription/updateMine" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "events": {
      "deals.onApprove": {
        "notificationCenter": true,
        "email": true,
        "popup": true
      }
    }
  }'
```

The response echoes the updated `events` tree, trimmed to the canonical catalog. Any key you sent that isn't in the catalog simply won't appear.

---

## 3. Scheduled Automations

For work that must run **on a recurring schedule** — a nightly export, an hourly reconcile, a periodic outbound sync — configure an automation script with a cron trigger. This is the direct analog of **Scheduled Apex**.

You configure this on the script/automation resource (see [Automation & Scripts](05-automation-and-scripts.md) for the full script model and the execution sandbox). The scheduling fields are:

| Field | Type | Notes |
|---|---|---|
| `scheduledTask.periodicity` | `String` (cron expression) | e.g. `0 * * * *` (hourly) or `0 9 * * 1` (09:00 every Monday). |
| `scheduledTask.timeZone` | `String` (IANA time zone) | **Required** whenever `periodicity` is set, e.g. `America/Bogota`. |
| `active` | `Boolean` | The script must be `active: true` to be scheduled. |

Behavior and constraints:

- **Cron format:** standard 5-field cron (`minute hour day-of-month month day-of-week`). A 6-field form with a leading seconds field is also accepted, but the seconds field must be `0` or `*` — **a schedule cannot run more frequently than once per minute.** An expression like `*/2 * * * * *` (every 2 seconds) is rejected.
- **Time zone is mandatory** when a periodicity is present; the schedule fires in that zone.
- When the scheduled run fires, the script executes with a run context that identifies the trigger as a scheduled task (as opposed to a manual run or a record-event run). Inside the script, read/write account data over the [REST API](03-rest-api.md) — the same surface any external caller uses.
- Setting the script to `active: false` or removing `periodicity` **unschedules** it.
- Each schedule runs **once per fire**, regardless of how the account is deployed — you will not get duplicate runs.

### 3.1 Worked example — schedule an hourly reconcile

Configure a script to run at the top of every hour in Bogota time by setting its scheduling fields (`PATCH` the script resource):

```bash
curl -X PATCH "https://<domain>/v2/script/SCP-123456" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "active": true,
    "scheduledTask": {
      "periodicity": "0 * * * *",
      "timeZone": "America/Bogota"
    }
  }'
```

Response (`200`, abridged):

```json
{
  "scriptCode": "SCP-123456",
  "active": true,
  "scheduledTask": { "periodicity": "0 * * * *", "timeZone": "America/Bogota" }
}
```

Inside the script body, use the REST API (with the account's credentials) to fetch records changed since your last checkpoint and push them downstream — the canonical **reconcile** companion to fire-and-forget webhooks.

> A note on the `CronCreate` / `CronList` MCP tools: those schedule the AI agent harness's own prompts and are unrelated to scheduled automations. Don't confuse them with `scheduledTask`.

---

## 4. Signature and delivery verification

Prolibu webhooks do **not** carry an HMAC signature and do **not** include a `secret` field. Verify authenticity yourself using one (ideally both) of these:

1. **Shared-secret header.** Put a high-entropy token in a custom header (`headers: [{ "name": "X-Api-Key", "value": "<random-secret>" }]`) and reject any inbound request whose header doesn't match. Compare in constant time.
2. **IP allow-listing.** Restrict your endpoint to accept only Prolibu's egress IP range at your load balancer / firewall.

Because there is no built-in retry or dead-letter queue, also implement **idempotency** and **reconcile**:

- **Idempotency:** deliveries may (rarely) arrive more than once, or your handler may crash mid-processing. Derive a stable key from the payload (for `update`, e.g. `afterUpdateDoc._id` plus `afterUpdateDoc.updatedAt`) and skip work you've already done.
- **Reconcile:** on a schedule (see [§3](#3-scheduled-automations)), poll the REST API for records changed since your last successful checkpoint (`GET /v2/<object>/?query={"updatedAt":{"$gt":"<lastCheckpoint>"}}&sort=updatedAt`). This closes any gap left by a webhook your endpoint missed.

---

## 5. Common pitfalls

1. **Webhooks are best-effort, not guaranteed.** There is no built-in retry and no dead-letter queue. If your endpoint is down or slow, that delivery can be lost. Do not use a webhook alone for anything that must never be missed — pair it with a reconcile pass, or use a script on a record event for reliable in-transaction logic.
2. **Delivery is non-blocking.** The API response to the writing client does not wait for your endpoint. Don't rely on any ordering between the webhook and that response.
3. **Only `create` / `update` / `delete` exist.** There are no fine-grained business events (approve, stage change, etc.) over webhooks. Detect those by diffing `beforeUpdateDoc` / `afterUpdateDoc` on an `update`, or notify users via event subscriptions.
4. **`selectedFields` trims silently.** If you configure `selectedFields` for an object, the payload carries only those fields and everything else disappears. With **no** entry for an object, the payload is the **full** record. On `update`, the three branches (`payload`, `beforeUpdateDoc`, `afterUpdateDoc`) are trimmed separately.
5. **`payload` on `update` is not a diff.** It reflects the fields sent in the update request (intersected with `selectedFields`), not the full change set. Compute the real diff from `beforeUpdateDoc` vs `afterUpdateDoc`.
6. **Every field in `selectedFields` must exist.** Referencing a non-existent field rejects the webhook at creation time with a `400`. Verify field names against the object (see [Custom Objects & Fields](02-custom-objects-and-fields.md)).
7. **No HMAC signature.** Authenticate deliveries with a custom-header shared secret and/or IP allow-listing ([§4](#4-signature-and-delivery-verification)), not by trusting the source blindly.
8. **Event names use the camelCase API name.** Use `Contact.create`, not the lowercased URL segment `contact.create`.
9. **`EventSubscription` is per-user and auto-created.** You adjust it via `getMine` / `updateMine` on your own token; you don't create or delete these. Keys outside the canonical catalog are silently dropped by `updateMine`.
10. **Scheduled automations can't run sub-minute.** The minimum interval is once per minute; a `timeZone` is mandatory whenever `periodicity` is set. Setting the script inactive or clearing `periodicity` unschedules it.
11. **Ack webhooks fast.** Return `2xx` quickly and offload heavy processing to your own queue; slow handlers risk exceeding `timeoutMs` (default `5000` ms) and losing the delivery.

---

## 6. Checklist

**Configure a webhook**

- [ ] `POST /v2/webhook/` with `webhookName`, a unique `endpoint` URL, `eventNames` (from `<Object>.create|update|delete|*`), and `active: true`.
- [ ] Add a custom-header shared secret in `headers` (there is no HMAC signature) and/or IP allow-list your endpoint.
- [ ] Set `selectedFields` per object if you want a trimmed payload — remember `update` trims all three branches, and every field must exist on the object.
- [ ] Have your endpoint return `2xx` in under `timeoutMs` (default `5000`), and process heavy work asynchronously.
- [ ] Assume deliveries can be lost: implement idempotency (stable dedupe key) and a periodic reconcile against the REST API.

**Configure per-user notifications**

- [ ] `GET /v2/eventsubscription/getMine` to read the current tree (defaults merged in).
- [ ] `PUT /v2/eventsubscription/updateMine` with an `events` object; use only catalog keys (others are dropped).
- [ ] Enable the channels the user actually wants: `notificationCenter`, `email`, `slack`, `telegram`, `discord`, `ultramsg`, and `popup` where supported.

**Choose the right mechanism**

- [ ] External HTTP system must learn of a record change → **Webhook** ([§1](#1-outbound-webhooks)).
- [ ] Reliable in-transaction logic on a record event → **Script on a record event** ([Automation & Scripts](05-automation-and-scripts.md)).
- [ ] Notify a user per their preferences/channels → **`EventSubscription`** ([§2](#2-event-subscriptions-per-user-notifications)).
- [ ] Recurring, on a schedule → **Scheduled automation** ([§3](#3-scheduled-automations)).

---

**See also:** [REST API](03-rest-api.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Security & Permissions](10-security-and-permissions.md)
