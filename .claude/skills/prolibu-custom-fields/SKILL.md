---
name: prolibu-custom-fields
description: Add, change or remove custom fields on a Prolibu object (Deal, Contact, Company, Product, a custom object…) and create new custom objects, the way the app does it — read the object's current fields, plan the change with the user, preview the exact save, then save it in one grouped write, wait for the account's restart and confirm the fields are live. Use it whenever someone wants an extra field, attribute, dropdown, checkbox or link on a record, a new kind of record, or reports custom fields that do not save, vanished, do not show up, or a Custom Field "switched off" with an Error or "Index sync error" status. Spanish triggers: "campo personalizado", "agregar un campo", "nuevo campo en negocios", "objeto personalizado", "lista desplegable", "los campos desaparecieron".
---

# Prolibu Custom Fields

## Central idea

Each object has at most **one Custom Field record** (`objectAssigned: "Deal"`). It holds two
blocks of field definitions:

- `customFields`: fields stored under `customFields.<name>` on each record. The default for
  new fields on built-in objects: the namespace never collides with built-in fields.
- `overrides`: fields at the record's root. Used for the fields of a custom object, and to
  tighten a built-in field (for example make it required).

Saving replaces each block **whole**, so a save built from a partial block deletes the
fields it left out. Every save restarts **all** of the account's servers to load the new
schema. A field that fails to load switches the **whole** record off.

`scripts/customfields.js` does the fragile parts in code, the same way the app's admin does:

- it starts from the stored blocks and only applies the plan's changes;
- it checks names, types, options, `index` and links before anything is sent;
- it counts records that a new "required" leaves empty and repeated values that would break
  a new "unique";
- it sends one write, waits for the restart, then reads the record back and checks that each
  field is live.

Your job is the conversation: understand the request, agree on the fields and the time of
the restart, show the preview, and apply only after a clear yes.

```
node .claude/skills/prolibu-custom-fields/scripts/customfields.js <command> <domain> …
  list    <domain>                     custom field records and custom objects, with their state
  show    <domain> <Object>            one object's fields, state, and which fields are live
  preview <domain> '<plan json>'       what would be saved; writes nothing
  apply   <domain> '<plan json>' --version <version from preview> --confirmed [--timeout <seconds>]
```

Output is JSON. Exit codes: 0 ok, 1 API error or failed check, 2 usage error (nothing
sent), 3 blocked (nothing written). Run it from the repo root.

## Ask the user first

In plain business terms:

1. **Which object?** A field on an existing object is almost always right. A new object only
   when its records have a life of their own (their own list, owner, search).
2. **For each field:** the label people will see, the kind of value (text, long text, number,
   yes/no, date, one option from a list, several options, a link to another record, a file),
   the options, and whether it is required.
3. **When may the account restart?** About half a minute on a dev account, possibly more on
   production. Everyone using the account sees errors meanwhile and can lose unsaved edits.
4. **Who may see or edit it?** Everyone with access to the object, unless an admin adds a
   field permission to a role (see `references/custom-field-model.md`). This skill does not
   change roles.

If `accounts/` has several domains, ask which one.

## Steps

1. **Read the object.** Run `show <domain> <Object>`. Note `record.state`, the existing
   fields and `live.missing`. If the state is not `loaded`, explain `meaning` and fix that
   first (see Symptoms).
2. **Write the plan** as JSON, inline in single quotes (a path to a temp file also works).

   ```json
   {
     "object": "Deal",
     "add": [
       { "label": "Event type", "type": "string", "enum": ["Wedding", "Congress"] },
       { "name": "guestCount", "label": "Guests", "type": "number", "required": true },
       { "label": "Venue", "type": "objectid", "ref": "Company" }
     ],
     "update": [{ "name": "priority", "set": { "enum": ["Low", "High", "Urgent"] }, "unset": ["required"] }],
     "remove": [{ "name": "oldField" }]
   }
   ```

   - The key comes from the label as the app makes it (`"Año de creación"` → `anoDeCreacion`),
     or set `name` yourself in English camelCase. Keys never change after saving: show them.
   - `add` goes to `customFields` unless the entry says `"in": "overrides"`. Overriding a
     built-in field needs `"overrideBuiltIn": true` and keeps its original type.
   - Kinds of value, as the app stores them:

     | The user says | Plan attributes |
     | --- | --- |
     | text / long text / rich text | `"type": "string"` (+ `"uiCom": "TextArea"` / `"HtmlEditor"`) |
     | number | `"type": "number"` |
     | yes/no | `"type": "boolean"` |
     | date | `"type": "date"` |
     | one option from a list | `"type": "string", "enum": [...]` |
     | several options / several values | `"type": ["string"]` (+ `"enum"`) |
     | link to a record | `"type": "objectid", "ref": "<Object>"`; several: `["objectid"]` |
     | file | `"type": "objectid", "ref": "File"` |

     More (time, color, phone, checklist, object editor) in `references/custom-field-model.md`.
   - `"index": true` makes a text field searchable; only plain text, never lists or passwords.
   - A switched-off record needs `"reactivate": true` (or `false` to keep it off); the
     preview blocks until the plan says which.
   - For a **new object**, use `"createObject": "Vehicle"` (PascalCase, singular, English)
     instead of `"object"`, with only `add` entries. It is created empty, then its fields go
     on its Custom Field record: two restarts.
3. **Preview.** Run `preview <domain> '<plan json>'`. It writes nothing. Tell the user:
   - each change (`changes`) and how many fields stay untouched (`fieldsKept`);
   - every `warning` and `check` (records left empty by "required", repeated values);
   - the restart (`restart`), and the production warning if there is one;
   - for a `blocker`, why, in plain words; then stop.
4. **Wait for an explicit yes.** Removing a field, changing a type, and any "required" or
   "unique" on an object that already has records each need their own yes: they affect saved
   data (a new required field makes every older record fail its next save until filled).
5. **Apply.** Run `apply <domain> '<same plan json>' --version <version> --confirmed`. It
   takes about a minute. It refuses if the record changed since the preview: preview again.
   Send nothing else to the account until it returns.
6. **Report.** On `"saved": true`, give the fields and where they live (`recordPath`). On
   `problems`, show them all and say what `meaning` means.
7. **Local files.** If `accounts/<domain>/objects/` exists, the user versions objects with the
   CLI. Run `./prolibu object pull --domain <domain>` so the files match (it overwrites every
   file there; ask first if the user has local edits).

## How the platform behaves

Details, sources of each status and the CLI commands are in
`references/custom-field-model.md`. Read it when a case falls outside the steps.

- **One write = one restart of every server.** The app and the API go down for about half a
  minute on a dev account. The script detects the new servers on the public `/prlversion`
  (shorter uptime than the time since the write), as the app does. Group all changes into one
  plan.
- **Writes before the restart lose the values.** The API drops fields it does not know yet,
  without an error. Write values only after `apply` returns.
- **A failed load switches everything off.** On start, a field that cannot be built sets the
  record `active: false` with `status: "Error: …"` (the servers restart once more without
  it). A database index that cannot be built (a "unique" field whose records repeat a value)
  sets `"Index sync error: …"`. Either way none of that object's custom fields apply until the
  cause is fixed and the record is reactivated (another restart).
- **Values in records.** A `customFields` field is read and written at
  `customFields.<name>`; an `overrides` field at the root. Links go as `_id` strings (lists
  as arrays of `_id`), never as objects. When changing one value, send the record's whole
  `customFields` object back with that key changed.
- **Custom objects.** The REST path is the lowercased name (`Vehicle` → `/v2/vehicle`). An
  active custom object cannot be edited (`PATCH /v2/cob` answers 400), so its fields live on
  its Custom Field record. A new object accepts fields only after its own restart (the
  script waits).
- **Removing is not erasing.** Saved values stay in the database; the app stops showing them.
  Renaming a key is remove + add: the old values do not move. To change the name people
  see, update `label`; the key stays.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every custom field of an object vanished at once | Record switched off (`state` `loadError` / `indexError`) | `show`; fix the cause; plan with `"reactivate": true` |
| `status` "Error: MongoNetworkError…" or "MongoPoolClearedError…" | A database hiccup while the servers started | Nothing to fix: reactivate (one restart) |
| "Index sync error … E11000 duplicate key … dup key" | A unique index over repeated values | Fix the repeated values, or drop `unique`, then reactivate |
| Field defined but `live.missing` lists it | Switched off, or the restart has not happened yet | `show` again in a minute; then the row above |
| Value sent but not saved, no error | Written before the restart, or wrong path (`customFields.x` vs root) | Check `recordPath`; write again after `apply` |
| "Document not found by primaryKey '[object Object]'" | A link sent as an object | Send the `_id` string |
| 400 "Only string fields can be indexed." | `index` on a non-text field | Drop `index` |
| 400 "The type is required in customFields." / "Invalid attribute name." | Hand-made payload | Use the script |
| 400 "…is already used by an existing model…" on a custom object | Active custom objects cannot be edited | Change its fields through its Custom Field record |
| 403 "Protected Field violation" | A role field permission blocks that field | An admin decides; do not work around it |
| `./prolibu customfield …` says "Unknown object type" | Those commands are no longer routed | `./prolibu object …` (see the reference) |

## Verify

- `apply` returns `"saved": true`, `record.state` `loaded`, and `live.missing` empty.
- If the user wants proof on data, write one value on a test record they pick (the helper
  below, `PATCH /v2/<object>/<id>`), read it back at `recordPath`, and give them the `_id`.

## Don't

- Write a Custom Field record with the generic helper, `./prolibu object update/create`, or a
  hand-made payload: a partial block deletes fields.
- Edit a custom object with `PATCH /v2/cob`, or create one when a field on an existing object
  does the job.
- Rename, retype or remove a field, or reactivate a record, without its own yes.
- Retry in a loop while the account restarts; read back first with `show`.
- Run `./prolibu object sync` or `object delete` from an agent: they always prompt.
- Change roles or field permissions from this skill.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and
`apply` the write. Values on records go through the helper in that file. For how objects
relate, see the `prolibu-platform-map` skill.
