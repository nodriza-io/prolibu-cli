# External References (`refId` / `refUrl`)

> Salesforce analogy: this is Prolibu's **External ID field** plus a deep link back to the source system. Every object already has the two fields; you don't create them. You store the other system's id in `refId`, a link that opens the record there in `refUrl`, and you find the record again with `?refId=<value>`.

## When to use this

Reach for `refId` / `refUrl` whenever a Prolibu record **mirrors or points to a record in another system**: a contact that also lives in your ERP, a deal that came from a marketing tool, a product imported from a catalog. They give you two things without adding a custom field:

- a **correlation key**, so an import or sync can find the record it created last time and update it instead of creating a duplicate;
- a **link back**, so a person or another integration can open the original record in the other system.

The platform's own integrations use them the same way: telephony stores the provider's id for a phone number or message template in `refId` and a link to the provider's console in `refUrl`, and built-in CRM sync connections store the external record's id and a deep link to it.

The two fields are marked "hidden" in the data model. That only keeps them out of the app's list columns and edit inputs: the app shows both **read-only** at the bottom of a record's form, with `refUrl` as a link, and offers no way to edit them. **Through the REST API they are ordinary fields:** you can write them, read them back and filter on them.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Key difference |
|---|---|---|
| `refId` (on every object) | A custom field marked **External ID** | Built in, one per record. Unique only on a few objects (see [§2](#2-uniqueness)). |
| `refUrl` (on every object) | A URL field or formula hyperlink | Plain text, not validated. |
| `GET /v2/<object>?refId=<value>` | SOQL `WHERE External_Id__c = '<value>'` | Flat equality filter, like any other field. |
| Upsert = filter by `refId`, then `PATCH` or `POST` | `upsert` on an External ID field | There is no single upsert call; do it in two steps ([§3](#3-worked-example--upsert-by-refid)). |

Sibling documents: [Platform & Data Model](01-platform-and-data-model.md) (standard fields on every object), [REST API](03-rest-api.md) (filters, `select`, errors), [Connecting to External Services](09-connecting-external-services.md) (sync patterns; it uses a custom `externalId` field, which is the alternative described in [§4](#4-refid-or-a-custom-field)) and [Custom Objects & Fields](02-custom-objects-and-fields.md).

---

## 1. The fields

| Field | Type | What to store | Behavior |
|---|---|---|---|
| `refId` | any JSON value; **send a string** | The record's id in the external system, e.g. `"CUS-10482"` or `"0035e00000AbCdE"`. | Set on `POST`, changed on `PATCH`, cleared with `null`. Returned on every read. Filterable with `?refId=`. |
| `refUrl` | `String` | A link that opens this record in the external system's UI. | Set on `POST`, changed on `PATCH`, cleared with `null`. Returned on every read. No format check: any text is accepted. |

Both are returned on a plain read, on a list, and when asked for with `select`:

```
GET /v2/contact/<id>
GET /v2/contact/<id>?select=refId%20refUrl
GET /v2/contact?refId=CUS-10482
```

Both also appear in the OpenAPI spec (`GET /v2/openapi/specification/<object>`) in the read, create and update schemas, with no description. The spec types `refId` as `object` because the field accepts any value; send a string anyway (see [§5](#5-common-pitfalls)).

## 2. Uniqueness

Among the objects you will normally write, only **Contact, Company, Deal and Product** enforce it: a text `refId` is unique within the account, across all of its workspaces, and **per object** (a contact and a company may share the same value). A second record with the same value is rejected with a `400` duplicate-value error, both on `POST` and on a `PATCH` that would create the clash.

**Contact Submission** (the log entry the platform writes for each lead submission, for example from a lead ad) has its own stricter rule: its `refId` holds the lead platform's submission id, is unique for any value, text or not, and never changes after the entry is written. You read these entries; you do not write them. This is also why a `refId` sent to `POST /v2/contact/submit` lands on the submission entry, not on the contact. The same `refId` sent to that endpoint again is taken as a retry and ignored (the answer is `"resubmission"`). To link the contact itself, upsert it as in [§3](#3-worked-example--upsert-by-refid).

The rule has gaps, so never rely on it as your only duplicate guard:

- **On Contact, Company, Deal and Product only text values are covered.** A numeric `refId` is not checked: two contacts with `refId: 900001` are both accepted. An empty string or `null` is not checked either.
- **The remaining objects have no uniqueness.** On tickets, tasks, custom objects and every other object not named above, nothing stops two records from sharing a `refId`.
- An account whose data already held duplicates when the rule was introduced may have the check off on that object.

So the integration itself must **search before it creates** ([§3](#3-worked-example--upsert-by-refid)) and treat a `400` on create as "someone else created it first": read the record by `refId` and update it.

## 3. Worked example — upsert by `refId`

Goal: an ERP sends customers to Prolibu. Each customer has an id (`CUS-10482`) and a page in the ERP. The same customer may arrive many times, and must never become two contacts.

**Step 1: look for the record.** Ask for at most two matches so you can detect a duplicate that slipped in.

```bash
curl -s "https://<your-domain>/v2/contact?refId=CUS-10482&limit=2&select=_id%20email%20refId" \
  -H "Authorization: Bearer <token>"
# -> 200 { "pagination": { "count": 1, ... }, "data": [ { "_id": "665f...", "email": "ana@acme.com", "refId": "CUS-10482" } ] }
```

**Step 2a: found one → update it.**

```bash
curl -s -X PATCH "https://<your-domain>/v2/contact/665f0a3b2c1d4e5f6a7b8c9d" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{ "firstName": "Ana", "lastName": "Ruiz", "refUrl": "https://erp.example.com/customers/CUS-10482" }'
# -> 200, the updated record
```

**Step 2b: found none → create it,** with `refId` in the create body (not in a later `PATCH`), so the record is never without its key.

```bash
curl -s -X POST "https://<your-domain>/v2/contact" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{ "firstName": "Ana", "lastName": "Ruiz", "email": "ana@acme.com",
        "refId": "CUS-10482", "refUrl": "https://erp.example.com/customers/CUS-10482" }'
# -> 201, the created record with refId and refUrl
```

**Step 2c: found more than one → stop** and report the duplicates; do not pick one at random.

**Before Step 2b, when the record may already exist without a `refId`** (a first sync against existing data, a contact someone typed in by hand): look for it by a natural key such as the email. One match with no `refId` → `PATCH` the `refId` and `refUrl` onto it (link it) instead of creating a second record. One match that already holds another `refId` → stop and report it. Skipping this step is the usual cause of duplicates on a first import.

The same flow in JavaScript, including the race where two runs create at the same time:

```js
const base = 'https://<your-domain>/v2';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function findByRef(object, refId) {
  const qs = new URLSearchParams({ refId: String(refId), limit: '2', select: '_id refId' });
  const res = await fetch(`${base}/${object}?${qs}`, { headers });
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
  const { data } = await res.json();
  if (data.length > 1) throw new Error(`duplicate refId ${refId} on ${object}`);
  return data[0] || null;
}

// `match` (optional, equality only, e.g. { email }) links a record that exists without a refId.
async function findUnlinked(object, match) {
  const qs = new URLSearchParams({ ...match, limit: '2', select: '_id refId' });
  const res = await fetch(`${base}/${object}?${qs}`, { headers });
  if (!res.ok) throw new Error(`match lookup failed: ${res.status}`);
  const { data } = await res.json();
  if (data.length > 1) throw new Error(`more than one ${object} matches ${JSON.stringify(match)}`);
  if (data[0] && data[0].refId != null && data[0].refId !== '') throw new Error(`${object} ${data[0]._id} already holds another refId`);
  return data[0] || null;
}

async function upsertByRef(object, refId, fields, match) {
  const body = { ...fields, refId: String(refId) };
  let existing = await findByRef(object, refId);
  if (!existing && match) existing = await findUnlinked(object, match);
  if (existing) {
    const res = await fetch(`${base}/${object}/${existing._id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`update failed: ${res.status}`);
    return res.json();
  }
  const res = await fetch(`${base}/${object}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 400) {
    // Another run may have created it in between (Contact, Company, Deal, Product reject the duplicate).
    const winner = await findByRef(object, refId);
    if (winner) return upsertByRef(object, refId, fields, match);
  }
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}
```

## 4. `refId` or a custom field?

`refId` holds **one** external id per record. Use it when one external system owns the link for that object. Add a custom field instead (see [Connecting to External Services](09-connecting-external-services.md) §6.1 and [Custom Objects & Fields](02-custom-objects-and-fields.md)) when:

- the same record must carry ids from **two or more** systems;
- the account already has a **built-in CRM sync connection** for that object. The sync writes its own id into `refId` and uses whatever `refId` holds to update the external record, so a value you write there would point the sync at the wrong record. Check first with `GET /v2/syncconnection`: the object is synced when an active connection lists it in `objects[].objectType` with that entry `active` and its `direction` other than `off`. If that read is refused (`403`) or fails, you cannot tell; ask the account admin before writing `refId`;
- you need uniqueness on an object that does not enforce it ([§2](#2-uniqueness)).

## 5. Common pitfalls

1. **Sending the id as a number.** `refId` keeps the type you send. A number is stored as a number, the flat filter `?refId=900001` does **not** find it (the query value arrives as text), and uniqueness does not apply. Always send `String(id)`.
2. **Creating without searching first.** Uniqueness exists only on a few objects ([§2](#2-uniqueness)). Everywhere else a second `POST` silently creates a duplicate.
3. **Treating a `400` on create as a failure.** On Contact, Company, Deal and Product it usually means the `refId` already exists. Read that record and update it.
4. **Stamping `refId` after the create.** A crash between the `POST` and the `PATCH` leaves a record without its key, and the next run creates it again. Put `refId` in the create body.
5. **Expecting to edit the fields in the Prolibu app.** The app shows both read-only at the bottom of a record's form, but has no input or list column for them. Write and filter them through the API.
6. **Writing over a sync's `refId`.** If a built-in sync connection manages the object, `refId` belongs to it ([§4](#4-refid-or-a-custom-field)).
7. **Putting secrets in `refUrl`.** It is returned in clear on every read, to anyone who can read the record. Never include tokens, API keys or signed links; store a plain link to the record's page and let the other system handle its own login.
8. **Storing a non-link in `refUrl`.** Any text is accepted, so a typo goes unnoticed, and the app shows the value as a link people click. Build it from a fixed `https://` pattern of the other system.
9. **Typos in the filter name.** An unknown filter field is ignored and returns unfiltered results (see [REST API](03-rest-api.md) §4). Spell it exactly `refId`.
10. **Writing refs on a closed deal.** A deal in an end-of-flow stage (Approved, Denied) rejects changes to `refId` and `refUrl` like any other field (`400`), unless an admin allowed edits in end-flow stages. Link deals before they close.
11. **Creating a record that already exists without a `refId`.** Searching by `refId` alone misses it; match it by a natural key and link it ([§3](#3-worked-example--upsert-by-refid)).

---

## 6. Checklist

- [ ] Decided that one external system owns `refId` on this object; otherwise use a custom field.
- [ ] Checked `GET /v2/syncconnection` for an active connection whose `objects[].objectType` is this object; if the read was refused, asked the account admin.
- [ ] Every write sends `refId` as a string, inside the create body.
- [ ] Every create is preceded by `GET /v2/<object>?refId=<value>&limit=2`; one match → `PATCH`, none → `POST`, two → stop.
- [ ] Records that may exist without a `refId` are matched by a natural key (e.g. the email) and linked, not created again.
- [ ] A `400` on create is handled by re-reading by `refId` and updating.
- [ ] `refUrl` is built from a fixed `https://` pattern and holds no secret.
- [ ] To unlink a record, `PATCH` it with `{ "refId": null, "refUrl": null }`.
