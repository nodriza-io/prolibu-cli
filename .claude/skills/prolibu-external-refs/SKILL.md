---
name: prolibu-external-refs
description: Link Prolibu records to the same records in another system (ERP, CRM, billing, help desk, marketing tool) with the built-in refId and refUrl fields every object has — store the other system's id and a link back, find a record again by that id, import or sync without creating duplicates, link records that already exist, and unlink. Use it whenever someone mentions refId or refUrl, an external id, a correlation or matching key, "the id from our ERP", an upsert, avoiding duplicates on an import or sync, or a link from a Prolibu record to the original elsewhere; and when an import created duplicates, a search by external id finds nothing, or a create answers 400 "refId … already exists". Spanish triggers: "id externo", "id del ERP/HubSpot", "no duplicar", "enlazar con otro sistema", "refId".
---

# Prolibu External References

## Central idea

Every record, on every object, has two built-in fields: `refId` (the record's id in the other
system) and `refUrl` (a link that opens it there). Nothing has to be created to use them. An
import or sync searches by `refId`, updates the record it finds and creates one only when there
is none. The app shows both fields read-only at the bottom of a record's form; they are written
through the API.

The fragile part is the upsert: search, decide, write, check that exactly one record answers to
the id. `scripts/refs.js` does it in code, so no step can be forgotten:

- it refuses an id sent as a number, and finds records that stored the same id as a number;
- it stops when a built-in CRM sync owns `refId` on that object, or when it cannot tell;
- it links a record that already exists (found by a natural key such as the email) instead of
  creating a second one;
- it sends only the fields that change, and reads back that exactly one record has the id.

```
node .claude/skills/prolibu-external-refs/scripts/refs.js <command> <domain> <object> …
  check   <domain> <object>                    can refId be written here? (sync, uniqueness)
  find    <domain> <object> <refId>            records with this refId (and numeric twins)
  preview <domain> <object> '<plan json>'      what upsert would do; writes nothing
  upsert  <domain> <object> '<plan json>' --expect <create|recordId> --confirmed
```

`<object>` is the API path: `contact`, `company`, `deal`, `product`, `ticket`, a custom object…
Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. **Which other system,** and which Prolibu records mirror its records (contacts, deals…).
2. **One example id** from that system, so you send it exactly as it is (as text).
3. **A web address that opens a record there,** with the id in it, for `refUrl`. If there is
   none, leave `refUrl` out.
4. **How to recognize a record that already exists in Prolibu** without the id (for contacts,
   usually the email). That becomes the plan's `match`.
5. **Does another integration already link these records?** One record holds one `refId`.

If there are several domains under `accounts/`, ask which one.

## Steps

1. **Check the object.** Run `check <domain> <object>`. If `canWriteRefId` is false, stop:
   either a built-in sync owns `refId` there (suggest a custom field for this id, with the
   `prolibu-custom-fields` skill) or the sync connections could not be read (ask an admin).
2. **Write the plan,** inline in single quotes (a JSON file in a temp folder also works):

   ```json
   {
     "refId": "CUS-10482",
     "refUrl": "https://erp.example.com/customers/CUS-10482",
     "fields": { "firstName": "Ana", "lastName": "Ruiz", "email": "ana@acme.com" },
     "match": { "email": "ana@acme.com" }
   }
   ```

   - `refId` is text, exactly as the other system has it. Never `900001`; always `"900001"`.
   - `fields` are the record's own fields, by their API names. Read the object's schema first
     if you are not sure of a name (see `prolibu-platform-map`). A reference to another record
     is that record's `_id` string, also inside `customFields`.
   - `match` (optional, equality only) finds a record that exists without the id, so it is
     linked instead of created again. Leave it out only when the user says the records are new.
3. **Preview.** Run `preview <domain> <object> '<plan>'`. It writes nothing. `action` is:
   - `create`: no record has the id or matches; `body` is what will be sent.
   - `update`: one record has the id; `changes` lists each field `from` → `to`.
   - `link`: one record matches and has no `refId` yet; it gets the id and the fields.
   - `none`: nothing to change. Tell the user and stop.
   - `stop`: duplicates, a record that holds another id, or the id stored as a number. Show the
     `records` to the user and let them decide. Never pick one yourself.

   Also tell the user every `warning` and `blocker`.
4. **Wait for an explicit yes.** Updating or linking an existing record needs its own yes.
5. **Write.** Run `upsert` with the same plan, `--expect` set to the preview's `expect`, and
   `--confirmed`. It refuses (exit 3) when the account changed since the preview: preview again
   and show the user.
6. **Report** the `_id`, the `refId` and the `refUrl` from the result. On `problems`, show them.

**Many records (an import).** Preview each record. Show the user one summary: how many
create, update, link, and every `stop` with its reason. After one yes for the batch, run
`upsert` for each record, one at a time, each with its own `--expect`. Stop at the first exit
code 1 or 3 and report what was written so far.

**Unlink a record** (its own confirmation): through the helper,
`PATCH /v2/<object>/<_id>` with `{"refId": null, "refUrl": null}`. Both fields disappear from
the record. Read it back.

## How the platform behaves

- **The type is kept as sent.** `refId` accepts any JSON value. A number stays a number:
  `?refId=900001` does not find it (a query string value is always text), and the duplicate
  rule skips it. `refUrl` is plain text.
- **Duplicates are rejected only on Contact, Company, Deal and Product,** and only for text
  values. The rule is account-wide (every workspace) and per object: a contact and a company
  may share an id. A second record answers `400` with a message like
  `refId '<value>' already exists`, in the account's language, on a create and on an update.
  An account that already had duplicates when the rule arrived may have it off for that object.
  Every other object accepts duplicates silently: the script's search is the only guard there.
- **A built-in CRM sync owns `refId`** on the objects an active `SyncConnection` lists in
  `objects[]` (entry active, `direction` not `off`). It writes the external id there and uses
  whatever `refId` holds to update the external record.
- **Contact form submissions keep their own id.** A `refId` sent to `POST /v2/contact/submit`
  is stored on the submission record, not on the contact. The same `refId` sent again is taken
  as a retry and ignored (the answer is `"resubmission"`). To link the contact, upsert it.
- **Closed deals are locked.** A deal in an end-of-flow stage (Approved, Denied) rejects
  changes to `refId` and `refUrl` too, unless an admin allowed edits in end-flow stages. Only
  when the user confirms that, add `--allow-end-flow-stage` to `preview` and `upsert`.
- **An update merges plain objects key by key** (`address: {city}` keeps `address.street`) and
  **replaces arrays and free-form (`mixed`) fields whole.** Send the full array or value.
- **Unknown fields are dropped silently,** on writes and in filters. A misspelled `?refld=`
  returns every record. The script always spells it `refId`.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Search by external id finds nothing, but the record exists | The id was stored as a number | `find` lists it under `numericTwins`; with the user's yes, `PATCH` that record with `{"refId": "<the id as text>"}` through the helper |
| An import created a second contact for the same person | It created without searching, or without a `match` for records that had no id | Upsert with `match`; show the user both records and let them merge in the app |
| `400 … already exists` on create | The id is already on another record of that object | `find`, then upsert: it updates that record |
| `400 Document not found by primaryKey '[object Object]'` | A reference was sent as an object | Send the referenced record's `_id` string |
| A reference reads back as `null` | The `_id` sent does not exist; the server accepts it anyway | Look up the real `_id` before writing |
| `400 This deal is in a closed stage…` | End-of-flow deal | Tell the user; an admin decides |
| `refId` changed by itself after a sync ran | A sync owns `refId` on that object | Use a custom field for your id |

## Verify

- `upsert` reads back by `refId`: exactly one record, the one written, with the same `refId`
  and `refUrl`. `saved: true` means all of that held.
- To check by hand: `find <domain> <object> <refId>` returns `count: 1` and no `numericTwins`.

## Don't

- Send `refId` as a number, or store several systems' ids in it as a list or a joined string.
- Create a record and add `refId` in a later update: put it in the create (the script does).
- Overwrite a `refId` that holds another value without asking; it may belong to another
  integration.
- Put tokens, keys, passwords or signed links in `refUrl`: anyone who can read the record sees
  it. The script refuses links with credentials.
- Write `refId` on an object a sync owns, or on `Token`, `User`, `Role`, `SyncConnection` and
  other access objects (the script refuses them).
- Delete a record to "fix" a duplicate. Show both and let the user decide.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `upsert`
the write. API rules shared by every object (filters, paging, errors) are in
`../prolibu-platform-map/references/api-conventions.md`.
