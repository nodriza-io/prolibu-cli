# Custom fields and custom objects: how they work

Read this when a case falls outside the steps in `SKILL.md`.

## The Custom Field record (`/v2/customfield`)

| Key | Meaning |
| --- | --- |
| `objectAssigned` | The object's name (`Deal`, `Contact`, `Vehicle`). Unique: one record per object. It must be an object the servers loaded at their last start. |
| `customFields` | Fields stored under `customFields.<name>` on each record. May hold groups: `{ "group": { "field": {…} } }` → `customFields.group.field`. |
| `overrides` | Fields at the record's root. A name that is already a built-in field changes that field's rules and keeps its type; a new name adds a root field (type required). Nested names work too (`denied.reason`). |
| `active` | Only active records are loaded when the servers start. |
| `status` | Written by the server, never by you: `Success: …`, `Error: …` or `Index sync error: …`. |

Every field entry carries `"isCustomField": true`; the server keeps only entries that have it.
It also adds `"sparse": true` to every `unique` field, so empty values never collide.

Saving rules, as the server applies them:

- `POST` creates the record; a second record for the same object is rejected.
- `PATCH` replaces each block it receives with exactly what it receives, and `{}` clears a
  block. The app always sends both blocks whole, and so does the script.
- When a change leaves no field at all, the app deletes the record (`DELETE`), and so does
  the script.
- Each `POST`, `PATCH` or `DELETE` that succeeds restarts every server of the account. A
  request the server rejects (400) changes nothing and does not restart.

## Field attributes

Checked by the server:

| Attribute | Rule |
| --- | --- |
| name | Letters, digits, `_`, `$`; not starting with a digit; not a JavaScript keyword in any case (`default`, `class`, `new`…). The app also refuses `id`, `type`, `schema`, `errors`, `createdAt`, `workspace`, `customFields` and other system names. |
| `type` | `string`, `number`, `boolean`, `date`, `objectid`, `mixed`, `decimal128`, `buffer`, `map`, `array`, or a list: `["string"]` (app form) or `"[string]"`. Required in `customFields` and for new root fields. |
| `index: true` | Only on plain `string` fields that are not passwords (`uiCom: "PasswordInput"`). It makes the field part of the record search. |
| `unique: true` | Builds a unique index when the servers start. If saved records already repeat a value, the index fails and the record is switched off. |

Used by the app (sent as they are, read by the forms):

| Attribute | Effect |
| --- | --- |
| `label`, `description` | Name and help text in forms. The app always sets `label`. |
| `enum` | The options of a list. Non-empty, no repeats. |
| `ref` | The object a link points to (`User`, `Company`, `File`…). Case-sensitive. |
| `required` | Saving a record without a value fails. Records saved before keep loading, but fail on their next save until they get a value. |
| `default`, `min`, `max`, `maxLength`, `hidden`, `readOnly`, `displayName` | As named. |
| `uiCom` | Which editor the form uses (see below). |
| `objectShape` | The inner fields of an object or list-of-objects field; never empty. |
| `ext`, `maxBytes`, `maxElements`, `isPublic` | File fields: allowed extensions, size limit, count, public link. |

## Field kinds in the app's admin

| Kind in the app | Stored as |
| --- | --- |
| Text | `type: "string"` |
| Dropdown | `type: "string"`, `enum` |
| Text area | `type: "string"`, `uiCom: "TextArea"` |
| Rich text | `type: "string"`, `uiCom: "HtmlEditor"` |
| Phone number | `type: "string"`, `eg: "+1 212 456 7890"` |
| Number | `type: "number"` |
| Yes/no | `type: "boolean"` |
| Date | `type: "date"` |
| Several dates | `type: ["date"]`, `uiCom: "DatesArray"` |
| Time | `type: "string"`, `uiCom: "TimePicker"` |
| Color | `type: "string"`, `uiCom: "ColorPicker"` |
| Password | `type: "string"`, `uiCom: "PasswordInput"` |
| Code | `type: "string"`, `uiCom: "CodeEditor"` |
| Schedule (cron) | `type: "string"`, `uiCom: "CronEditor"` |
| File | `type: "objectid"`, `ref: "File"`, `maxElements: 1`, `maxBytes` |
| Profile picture | `type: "objectid"`, `ref: "File"`, `uiCom: "ProfilePicture"` |
| Link to a record | `type: "objectid"`, `ref: "<Object>"` |
| Comments | `type: ["objectid"]`, `ref: "Comment"`, `uiCom: "CommentsCom"` |
| Checklist | `type: ["mixed"]`, `uiCom: "ChecklistCom"`, `objectShape` |
| Object / list of objects | `type: "mixed"` / `["mixed"]`, `uiCom: "objectEditor"`, `objectShape` |

"Multiple" in the app turns the type into a one-item list (`["string"]`); it is not offered for
yes/no or dates. There is no email, URL or currency kind: use text (or number for amounts).

## The restart

- A successful write publishes a restart to every server of the account. On production each
  server process exits and is started again; on dev accounts it reloads in place.
- A dev account's servers took 20 to 33 seconds to start in the observed logs. Production can
  take longer. The app's newer admin waits up to 90 seconds; the script waits up to 240
  (`--timeout`).
- How to tell the servers are back: the public `GET https://<domain>/prlversion` answers with
  `uptime` and `podBirth`. A server is new when its uptime is shorter than the time since the
  write. The script (like the app) waits for two new answers in a row, then for the API.
- Unique indexes are built 15 seconds after start on production (1 second elsewhere). The
  script waits 20 seconds more before it reads the status.
- Meanwhile every request to the account can fail, the app shows "Synchronizing changes",
  and values sent for the new fields are dropped silently.

## States of a record

| `status` starts with | `active` | What happened | What to do |
| --- | --- | --- | --- |
| `Success:` | true | Loaded. | Nothing. |
| `Error:` | false | A field could not be built when the servers started, or the database failed at that moment (`MongoNetworkError`, `MongoPoolClearedError`). The servers restarted once more without it. | Read the message. If it is a database error, reactivate. Otherwise fix the field, then reactivate. |
| `Index sync error:` | false | An index could not be built, usually `E11000 duplicate key` on a unique field. It can be a built-in unique field too: indexes are only rebuilt on objects that have custom fields. | Fix the repeated values (or drop `unique`), then reactivate. |
| (empty) | true | Saved, not loaded yet. | Wait for the restart. |

Reactivating is `"reactivate": true` in the plan: the script sends `active: true` with the
blocks. The app's admin does it by itself only for `Error:` states, not for index errors.

## Values in records

- `customFields` fields: `{"customFields": {"eventType": "Wedding"}}`. Read them at
  `customFields.eventType`. When changing one value, send the record's whole `customFields`
  object with that key changed (the app does that).
- `overrides` fields: at the root, `{"eventType": "Wedding"}`.
- Links: the `_id` string; lists: an array of `_id` strings. An object makes the API answer
  "Document not found by primaryKey '[object Object]'".
- `Product` and `PricebookEntry` custom fields also appear on quote lines.
- Search: a custom text field enters the record search (`/v2/<object>/search`) with `index: true`.

## Custom objects (`/v2/cob`)

- Create: `POST /v2/cob` with `{"modelName": "Vehicle", "active": true}`. The server splits the
  name on spaces, makes each word singular (English rules) and capitalizes it: `"pets"` →
  `Pet`, `"My Models"` → `MyModel`. Read the stored name back before using it.
- The REST path is `/v2/<lowercased name>`: list, `search?term=`, read, create, update and
  delete records there. Records get `createdAt`, `updatedAt`, `createdBy`, `updatedBy`.
- Rejected names: platform internals (`Test`, `Cache`, `Core`, `Db`, `Msg`…) and any name an
  object already uses.
- Fields: the app creates the object empty and adds its fields as `overrides` on a Custom
  Field record with `objectAssigned` = the stored name. That record can only be created after
  the object's own restart.
- An active custom object cannot be edited: every `PATCH /v2/cob/<id>` is rejected with "The
  model name '…' is already used by an existing model". Change its fields through its Custom
  Field record.
- Deleting one (`DELETE /v2/cob/<id>`) removes its API after a restart; its saved records stay
  in the database.

## Field permissions on roles

A role can carry `ProtectedField@<Object>.<action>.<path>`, for example
`ProtectedField@Deal.update.customFields.eventType`:

- `create` or `update`: users with that role cannot send the field on that action (403
  "Protected Field violation").
- `*`: the field is also removed from what they read.

Roles are edited by an admin in the app. This skill only explains them.

## The CLI's object commands

Only `./prolibu object …` is routed. The older `./prolibu customfield …`, `cob …` and
`objects …` print "Unknown object type".

| Command | Non-interactive? | What it does |
| --- | --- | --- |
| `object list --domain <d>` | yes | Lists custom objects and Custom Field records with their state. |
| `object get --domain <d> --type cf\|cob --id <id>` | yes | Prints one record. |
| `object pull --domain <d>` | yes | Writes every record to `accounts/<d>/objects/Cob/<Name>.json` and `accounts/<d>/objects/CustomField/<Object>.json`, overwriting local copies. Run it from the repo root. |
| `object create --domain <d> --file <json>` | yes | One `POST` of the file (`modelName` → custom object, `objectAssigned` → Custom Field). No checks, no wait. |
| `object update --domain <d> --type cf\|cob --id <id> --file <json>` | yes | One `PATCH` with the file as it is. No merge, no wait. |
| `object sync --domain <d>` | no | Asks which files to send, then sends each one and waits for each restart. |
| `object delete …` | no | Always asks for confirmation. |

For agents, the script replaces `create` and `update`: they send whatever the file holds, so a
partial file deletes fields. Use `list`, `get` and `pull` freely.
