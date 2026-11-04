---
name: prolibu-webhooks
description: Create, change, pause and troubleshoot Prolibu outbound webhooks the way the app does it — pick the object and its create/update/delete events, a public https destination, the fields to send (always with the record id), a shared-secret header and whether it starts on or off; preview, save after the user agrees, read back. Use it whenever someone wants another system told about changes in Prolibu (contacts to a CRM, won deals to billing, tickets to a help desk), wants to rotate a webhook secret or turn one off, or reports a webhook that delivers nothing, sends the whole record instead of the chosen fields, lacks the record id, or fails with "Webhooks are disabled". Spanish triggers: "webhook", "avisar a otro sistema", "notificar cambios", "sincronizar con otro sistema", "el webhook no llega", "rotar el secreto".
---

# Prolibu Webhooks

## Central idea

A webhook is a record that says: "each time a record of this object is created, changed or
deleted, POST it as JSON to this URL." It is fire-and-forget: one attempt, no retry, and no
delivery log in Prolibu.

The server saves several mistakes without complaint: an object name in the wrong case (then
the field list is ignored and the whole record goes out), a field list without the record id,
a webhook that starts on because nobody said otherwise, plain-http or internal addresses. And
every read of a webhook returns its secret header values in clear.
`scripts/webhook.js` does these parts in code:

- it checks event names and field paths against the server's own lists and fixes the case;
- it always adds `_id` to a field list;
- it needs an explicit `active` on create;
- it only allows public https destinations, and one webhook per URL;
- it never prints header values, except a newly generated secret, once;
- on a change it sends only what changes, whole lists included, keeps the other headers,
  and reads the webhook back.

```
node .claude/skills/prolibu-webhooks/scripts/webhook.js <command> <domain> …
  list    <domain>                       account switch + every webhook, with its problems
  show    <domain> <webhookId>
  events  <domain> <object>              exact event names for an object
  fields  <domain> <object> [filter]     field paths the server accepts
  preview <domain> '<plan json>'         validates and shows the change; writes nothing
  apply   <domain> '<plan json>' --confirmed [--webhook-version <webhookVersion from preview>]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. **Which object, and which moments?** Created, changed, deleted, or all three.
2. **Where does the notice go?** The exact URL and who owns that system. Never guess it.
3. **Which fields does the receiver need?** A handful is usual; the record id always goes.
4. **How does the receiver know it is Prolibu?** A secret header. Agree on its name with the
   receiver's owner. Let the script generate the value, or use the one they gave you. It is
   not the Prolibu API key.
5. **On now, or off until the receiver is ready?** On means real data starts flowing.

If the account has several domains under `accounts/`, ask which one.

## Steps

1. **Look first.** Run `list <domain>`.
   - `accountSwitch` "off": stop. Tell the user an admin must turn on webhooks in
     Preferences → Integrations → Webhooks. Until then nothing is sent and no webhook can be
     created or changed.
   - A webhook already points to that URL: change it (add events) instead of creating one.
   - Read each webhook's `issues`: they explain most "it doesn't work" reports.
2. **Name the object.** Run `events <domain> <object>`. If `object` is null, show
   `similarObjects` and ask.
3. **Pick the fields.** Run `fields <domain> <Object> <filter>` and use the paths it returns.
   A parent path (`address`) sends the whole group.
4. **Write the plan** as JSON, inline in single quotes (a file in a temp folder also works).
   New webhook:

   ```json
   {
     "webhookName": "Contacts to CRM",
     "endpoint": "https://crm.example.com/hooks/prolibu",
     "eventNames": ["Contact.create", "Contact.update"],
     "selectedFields": [{ "entity": "Contact", "fields": ["firstName", "lastName", "email"] }],
     "headers": [{ "name": "X-Api-Key", "generate": true }],
     "timeoutMs": 5000,
     "active": false
   }
   ```

   Change one: `"id"` plus only the keys that change.
   - `eventNames` is the full new list.
   - `selectedFields` entries replace that object's list; `"fields": []` sends the whole
     record again. Other objects' lists stay.
   - `headers` work by name: `{"name","value"}` sets, `{"name","generate": true}` makes a new
     random secret, `{"name","remove": true}` deletes. Headers you leave out stay as they are.
   - `timeoutMs`: 1000–60000, as in the app. Default 5000.
5. **Preview.** Run `preview <domain> '<plan json>'`. Tell the user, in plain words: the
   destination host, the events, the fields, the header names (never values), on or off,
   every `warning` and `note`. On a change, show `changes` before and after.
6. **Wait for an explicit yes.** Turning a webhook on, or changing where it sends, needs its
   own yes.
7. **Save.** Run `apply` with the same plan and `--confirmed`. For a change, add
   `--webhook-version <webhookVersion>` from the preview; if the webhook changed since, it
   stops: preview again.
8. **Report.** Give the name, `webhookCode` and on/off. If `newSecrets` is present, show each
   value once and tell the user to hand it to the receiver's owner privately. Never repeat it.

To **rotate a secret**: plan `{"id": "<id>", "headers": [{"name": "X-Api-Key", "generate": true}]}`.
The receiver rejects deliveries until it has the new value, so agree on the moment with its
owner; events in between are lost.

To **pause** a webhook: plan `{"id": "<id>", "active": false}`. Prefer pausing to deleting. To
delete, after its own yes, use the helper:
`node .claude/skills/_shared/prolibu-api.js <domain> DELETE /v2/webhook/<id> --confirmed`.

## How the platform behaves

Payload examples, server messages and the receiver checklist are in
`references/webhook-model.md`. Read it when a case falls outside the steps above.

- **Events** are `<Object>.create`, `.update`, `.delete` and `.*`, with the exact model name
  (`Contact.update`, not `contact.update`). Custom objects have them too. There are no business
  events (won, approved, stage changed): use `update` and compare before and after.
- **What arrives:** `{eventName, eventData}`. On create and delete, `eventData` is the record.
  On update it is `{payload, beforeUpdateDoc, afterUpdateDoc}`; `payload` is what the writer
  sent, not a diff. References arrive as ids.
- **Every update fires**, even one that changes nothing. Receivers must skip repeats.
- **Field lists** trim all three parts of an update. An object without a list sends the whole
  record. `_id` only goes if listed (the script adds it).
- **Delivery** happens after the save, in the background, once, within `timeoutMs`. A slow,
  failing or down receiver loses that event. Webhooks on the same event are called one after
  another, so a slow receiver delays the rest.
- **The account switch** is off by default. Off means nothing is sent and every create or
  change is rejected, even turning a webhook off. Only admins can read it; skills never change it.
- **Sandbox copies** of an account never send webhooks.
- **A deal's quote** lives inside the deal: its changes fire `Deal.update`, not `Quote.*`
  (that is the quote library). Use `proposal.quote…` fields.
- **Header values** are stored in clear and returned on every read. Anyone who can read
  webhooks can read the secret.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing arrives | Account switch off, webhook off, sandbox account, or the receiver failed or was slow (no retry) | `list`: check `accountSwitch` and `active`; then the receiver's own logs |
| 400 "Webhooks are disabled…" | Account switch off | An admin turns it on; do not change preferences |
| The whole record arrives despite a field list | The list's object name has the wrong case, or the event's object has no list | `show` → `issues`; any `apply` on it fixes the case |
| The receiver cannot tell which record changed | `_id` not in the field list | Change the list; the script adds `_id` |
| 400 "…must be one of (AdCampaign.*, …)" | Wrong event name or case | `events <domain> <object>` |
| 400 "Field … does not exist" | Wrong field path | `fields <domain> <Object> <filter>` |
| 400 "Forbidden. The schema is not accessible." | Object name misspelled in the field list | Use the exact name; the script fixes it |
| Changes to a deal's quote never arrive | Subscribed to `Quote.*` | `Deal.update` with `proposal.quote…` fields |
| The same change arrives twice, or with nothing changed | Every save fires | Receiver skips repeats by `_id` + `updatedAt` |
| Deliveries come late, in bursts | Another receiver on the same event is slow | Lower `timeoutMs`; receivers answer `2xx` fast |
| A webhook gets fewer fields than it lists, only when another one on the same event trims | Older server versions trimmed one shared copy | Same field list on every webhook of that event, or one webhook per event |
| 403 | The user lacks webhook permission (admins and the Developer profile have it) | Say so and stop |

## Verify

- `apply` reads the webhook back and compares every field, header values included (without
  printing them). `"saved": true` with empty `problems` is the proof.
- Prolibu keeps no delivery log. If the webhook is on and the user controls the receiver, ask
  them to change one test record and check the receiver's logs.

## Don't

- Copy this configuration to another account by hand: use `prolibu-config-promotion`.
- Write a webhook with the generic helper or a hand-made `PATCH`: reads print header values,
  and `PATCH` replaces lists whole.
- Point a webhook at a URL the user did not give, or at http, an IP or an internal host.
- Subscribe to `Webhook.*` events: they carry other webhooks' secrets.
- Print, repeat or save a header value in a repo file.
- Turn on the account switch or change any preference.
- Rely on a webhook alone for something that must never be missed. Pair it with a scheduled
  reconcile, or use a script on the record event (`prolibu-scripts`).

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. If the receiver is a Prolibu Endpoint, see `prolibu-endpoints`. For objects and how
they relate, see `prolibu-platform-map`.
