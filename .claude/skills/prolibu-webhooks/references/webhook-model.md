# Webhook model: what the platform stores, sends and checks

Reference for `prolibu-webhooks`. Read the section you need.

## The record

Webhooks are ordinary records at `/v2/webhook` (list, `GET /<id>`, `POST`, `PATCH /<id>`,
`DELETE /<id>`). Creating answers `201`, deleting `204`.

| Field | Notes |
| --- | --- |
| `webhookCode` | Set by the server, `WHK-…`. |
| `webhookName` | Required. |
| `endpoint` | Required, unique in the account. The server only checks that it starts with `http://` or `https://`. |
| `eventNames` | Required, at least one, each from the server's list (below). |
| `selectedFields` | `[{ entity, fields }]`, one entry per object. Optional. |
| `headers` | `[{ name, value }]`, sent on every delivery. Both keys are required in each entry. |
| `timeoutMs` | Default `5000`. No limit on the server; the app offers 1–60 s. |
| `active` | **Default `true`.** A webhook created without it starts sending at once. |

- `GET` returns header values in clear, to anyone who can read webhooks.
- `PATCH` replaces `eventNames`, `selectedFields` and `headers` whole. To change one header,
  send all of them; that is why only the script writes webhooks.
- Access: admins and users with the Developer profile. Others get `403`.

## Events

- Every object has `<Object>.create`, `.update`, `.delete` and `.*` (all three), custom objects
  included. A few system objects have none (preferences, custom fields, notifications, tokens
  and similar).
- The name is the model name, exactly: `Contact.update`, `EventProspect.create`. Any other
  spelling is rejected.
- The full list is in the schema: `GET /v2/service/getschema?modelNames=Webhook&type=attrs`,
  field `eventNames.enum`. `webhook.js events <domain> <object>` reads it for one object.
- There are no business events (approved, stage changed, won). Subscribe to `update` and compare
  `beforeUpdateDoc` with `afterUpdateDoc`.
- `Quote.*` is the reusable quote library. The quote of a deal lives inside the deal
  (`proposal.quote`), so its changes fire `Deal.update`.
- Every record write through the API, the app, forms, scripts or imports fires the event,
  **even an update that changes nothing**.

## What is delivered

`POST <endpoint>` with `Content-Type: application/json`, the webhook's headers, and:

```json
{ "eventName": "Contact.create", "eventData": { "_id": "…", "firstName": "Ana", "email": "ana@example.com" } }
```

```json
{
  "eventName": "Contact.update",
  "eventData": {
    "payload":         { "firstName": "Ana María", "updatedBy": "…" },
    "beforeUpdateDoc": { "_id": "…", "firstName": "Ana", "email": "ana@example.com" },
    "afterUpdateDoc":  { "_id": "…", "firstName": "Ana María", "email": "ana@example.com" }
  }
}
```

```json
{ "eventName": "Contact.delete", "eventData": { "_id": "…", "firstName": "Ana María" } }
```

- `create` and `delete`: the record as stored, after the server's own hooks ran. References are
  ids, not objects.
- `update`: `payload` holds the fields the writer sent plus what the server stamps (such as
  `updatedBy`); it is **not** a diff. Compute changes from the two documents.
- Encrypted secrets in `payload` are replaced by `[redacted]`.

## Trimming with `selectedFields`

- An entry applies to events of the object named in `entity`, compared **case-sensitively**
  at delivery. With no matching entry the whole record is sent.
- The server accepts `entity` in the wrong case when saving (`contact` for one-word objects),
  then ignores it: the full record goes out. For multi-word objects (`eventprospect`) saving
  fails with "Forbidden. The schema is not accessible."
- Only listed paths are sent, `_id` included. `webhook.js` always adds `_id`.
- Valid paths are the object's columns: `GET /v2/service/getschema?modelNames=<Object>&type=columns`
  (`webhook.js fields`). A parent path (`address`) sends its whole subtree. Paths through lists
  work (`proposal.quote.lineItems.productName` sends that field of every line).
- On `update`, `payload`, `beforeUpdateDoc` and `afterUpdateDoc` are trimmed with the same list.
- Each webhook is trimmed from the full record. Older server versions trimmed one shared copy,
  so a webhook could lose fields that another webhook on the same event left out.

## Delivery

- After the write is saved, in the background. The writer's response does not wait.
- One attempt per webhook, with `timeoutMs`. A timeout, a network error or a non-2xx answer is
  dropped: no retry, no queue, and no delivery log in Prolibu. Only the receiver's logs show what
  arrived.
- Webhooks that match the same event are called one after another, each waiting for the
  previous one. A slow receiver delays every webhook after it.
- Redirects are followed.
- Nothing is sent while the account switch is off, or from a sandbox copy of an account.

## The account switch

Preferences → Integrations → Webhooks (`integrations.webhooks.enabled`), off by default.

- Off: nothing is sent, and creating **or changing** any webhook answers
  `400 "Webhooks are disabled, please enable them in preferences."`, even to turn one off.
  Deleting still works.
- Only admins can read it (`GET /v2/preference/read`). The app shows a "Webhooks disabled"
  notice above the webhook list.
- Turning it on is an admin decision. Skills never change preferences.

## Server messages

The text comes in the user's language.

| Message | Meaning |
| --- | --- |
| "Webhooks are disabled, please enable them in preferences." | Account switch off. |
| "…`eventNames.0` must be one of (AdCampaign.*, …)" | Unknown event name or wrong case. |
| "Please select at least one event name to subscribe to." | Empty `eventNames`. |
| "Field `x` does not exist in …" | A `selectedFields` path the object does not have. |
| "Selected fields must have a non-empty fields array." | An entry with `fields: []`. |
| "Forbidden. The schema is not accessible." | `entity` misspelled, often lowercase. |
| "Invalid object shape" | A header without `name` or `value`. |
| "Invalid URL address" | `endpoint` does not start with `http://` or `https://`. |

## How the app does it

Settings → Webhooks. The form has name, destination, events (labelled "Contact · update"), a
"fields to send" picker per object of the chosen events (same column list the server checks,
saved as paths), headers, a timeout with presets of 1, 3, 5, 10 and 30 s (custom 1–60 s) and an
on/off switch that starts **on**. Saving drops field lists for objects with no event. The list
has an on/off toggle per row, which saves `active` alone.

## Receiver checklist (for the receiver's owner)

1. Compare the secret header with the stored value in constant time; reject anything else.
2. Answer `2xx` within the timeout and do the work afterwards.
3. Skip repeats: key on `_id` plus `updatedAt` (`afterUpdateDoc` on updates).
4. Do not trust the body for anything important: read the record again through the API by its
   `_id`.
5. Close gaps with a scheduled reconcile: records changed since the last checkpoint,
   `GET /v2/<object>?xquery={"updatedAt":{"$gt":"<checkpoint>"}}&sort=updatedAt`. The filter
   goes in `xquery`; a `query` parameter is ignored and returns everything.
