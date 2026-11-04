---
name: prolibu-imports
description: Import contacts, companies or deals in bulk from a CSV or Excel file the way the Prolibu app does — read the file, map its columns to fields, find the records that already exist (email, company name or tax id, external id) so nothing is duplicated, preview every row, write through the account's importer after a yes, and report the result row by row; also read the result of imports run from the app, and change one field on many records (bulk edit). Use it whenever someone wants to load, upload, migrate or update many records from a spreadsheet, avoid duplicates on an import, or asks why an import created duplicates, failed rows, put dates a day off or "did nothing". Spanish triggers: "importar contactos", "cargar un Excel", "subir un CSV", "importación masiva", "sin duplicar", "mapeo de columnas", "resultado de la importación", "edición masiva".
---

# Prolibu Imports

## Central idea

The app imports through one endpoint, the account's **importer** (`PUT /v2/service/importdata`).
For each row it looks the record up **only by `_id` or the object's primary key** (a contact's
email, a company's `companyCode`, a deal's `dealCode`), updates it if found and creates it
otherwise. It does not look at names, tax ids or `refId`: a company file imported twice
creates every company twice. So the duplicate check is ours, before the importer runs.

`scripts/imports.js` does the fragile parts in code:

- reads `.csv` (any delimiter, UTF-8 or Windows) and `.xlsx`, keeping spreadsheet row numbers;
- converts each cell to the field's type (numbers, yes/no, dates in the account's time zone,
  lists, options) and links companies, contacts and stages to their `_id`;
- finds duplicates inside the file and records that already exist, and sends each existing
  record's `_id` so the importer updates the right one, with only the fields that change;
- sends rows in chunks, reports every row, and reads the records back.

Your job is the conversation: agree on the mapping, the matching key and what to do with
records that exist, show the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-imports/scripts/imports.js <command> <domain> …
  inspect <domain> <contact|company|deal> <file> [--sheet <name>]   columns, sample, suggested mapping
  preview <domain> '<plan json>'                       writes nothing; returns a version
  apply   <domain> '<plan json>' --version <v> --confirmed [--chunk <n>]
  export  <domain> '<plan json>' --version <v>         JSON file for the app's Import (over 300 rows)
  jobs    <domain> [--limit <n>]                       imports run from the app, newest first
  job     <domain> <jobId>                             one of them, with its row errors
```

Output is JSON. Exit codes: 0 ok, 1 API error or rows not saved, 2 usage error (nothing sent),
3 blocked (nothing written).

## Ask the user first

In plain business terms:

1. **What the file holds** (contacts, companies or deals) and where it is. Several kinds in one
   file: import them in order — companies, then contacts, then deals — so each can link to the
   previous one.
2. **How to recognize a record that already exists.** Contacts: the email (default). Companies:
   the name (default) or the tax id. Deals: an id from another system (`refId`) when there is
   one; the name otherwise. Any of them can use `refId` if the file has another system's id.
3. **What to do with records that already exist:** leave them as they are (default) or update
   them with the file's values. Empty cells never erase anything.
4. **Values for every new record** the file does not have (for example the source "Fair 2026").
5. Only if the preview asks: day/month order of dates, the decimal separator, the time zone.

If `accounts/` has several domains, ask which one.

## Steps

1. **Inspect.** `inspect <domain> <object> <file>`. Show the columns, two sample rows and the
   suggested mapping. Confirm each column's field with the user; map anything unclear to `null`.
2. **Plan.** Inline JSON in single quotes, or a JSON file in a temp folder:

   ```json
   { "object": "contact", "file": "/path/to/leads.xlsx", "sheet": "Leads",
     "mapping": { "Correo": "email", "Nombre": "firstName", "Empresa": "company", "Notas": null },
     "match": "email", "existing": "skip", "missing": "create",
     "defaults": { "source": "Fair 2026" } }
   ```

   - `mapping`: column → field path from `inspect` (`address.city`, `identification.docId`).
     A contact's company column goes to `company` to link existing companies (a name that does
     not exist fails that row: import the companies first), or to `companyName` to keep it as
     text. Ask which, when some names are missing.
   - `match`: the key from question 2 (`email`, `companyName`, `identification.docId`,
     `companyCode`, `refId`, `dealCode`, `dealName`, `_id`); its column must be mapped.
   - `existing`: `skip` or `update`. With `update`, `updateFields` (for example
     `["address.city"]`) limits what changes on existing records; new ones get every column.
     `missing`: `create`, or `skip` to touch only existing ones.
   - `defaults` fill new records only. Add `dateOrder` (`DMY`/`MDY`), `decimalSeparator`
     (`,`/`.`) or `timeZone` only when the preview asks.
   - Instead of `file`, `rows` takes a list of objects (column → value): use it for records
     typed in the chat, with no file and no `inspect` (`preview` checks the fields).
3. **Preview.** `preview <domain> '<plan>'`. Tell the user, in plain words:
   - the counts: new, updated, unchanged, left as they are, and not imported;
   - every `error`, `ambiguous` and `duplicateInFile` row, with its spreadsheet row number and why;
   - each update with its changes (`from` → `to`);
   - every `warning`, and `sideEffects`: webhooks, scripts or AI triggers that run once per row;
   - `reportFile`, a CSV with every row they can open in Excel.
   On `blockers` (exit 3), ask what they say and preview again.
4. **Wait for an explicit yes.** Updating existing records needs its own yes.
5. **Write.** `apply <domain> '<same plan>' --version <version> --confirmed`. It refuses when
   the file or the account changed since the preview (preview again and show it), and above
   300 rows to write (step 7).
6. **Report.** Created and updated counts, every failed row with its reason, `problems`, and
   the `reportFile` with each row's result and record id. Rows that failed can be fixed in the
   file and imported again: rows already written now match and are left alone or updated.
7. **Big files (over 300 rows to write).** `export` with the same plan and version writes a
   JSON file. The user imports it in the app (the object's list, ⋯ menu, Import → JSON), which
   runs in the background with its progress panel. Then `jobs` and `job` read the result.

**Bulk edit** (one change on many existing records, like the app's "Edit selected"): rows with
the records' `_id` and the new value, `"match": "_id"`, `"existing": "update"`,
`"missing": "skip"`. Get the ids with a list call (see `prolibu-platform-map`). Show how many
records change before asking.

**An import made in the app:** `jobs` lists the latest, `job <id>` gives its row errors.

## How the platform behaves

Details, evidence and edge cases are in `references/imports-model.md`.

- **Every row is a normal save.** The importer creates or updates each row like the API would:
  webhooks, lifecycle scripts, AI agent triggers, notifications and owner assignment
  notifications run per row. Only the live refresh of other people's screens is skipped.
  `preview` lists what is active for the object.
- **The importer only knows `_id` and primary keys.** A company or deal name, a tax id or a
  `refId` is not looked up: without the script's check, a re-import duplicates companies and
  deals, and a repeated `refId` fails the row with "already exists".
- **An unknown `_id` creates a record with that id** instead of failing. The script refuses it.
- **Contact emails match whatever the case.** `Ana@Example.com` updates `ana@example.com`.
- **References take an `_id` or the other record's key, never its name.** A contact's
  `company` takes a company code; the script turns names into `_id`. A deal's `company` comes
  from its contact.
- **A deal has no amount field.** Its value is its quote: use `prolibu-quotes` afterwards.
- **Dates without a time zone** are read in the user's or the account's zone, as the app's Excel
  import does. A date sent as plain `2026-03-04` would be midnight UTC: a day early in America.
- **Empty cells never clear a field.** The importer clears a field only with the text `null`;
  this script never sends it.
- **Moving the stage of existing records** is not done here: use `prolibu-stages`. New records
  may start in a stage; a closed one (Approved, Denied) locks them.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Companies or deals duplicated after a second import | The importer matches only `_id` or code, not names | Preview with `match` by name, tax id or `refId`; merge the twins in the app |
| A row fails with "refId '…' already exists" | Another record holds that id; the importer tried to create | Match by `refId`; the script updates that record |
| "Document not found by primaryKey '…'" | A reference holds a name or an email that does not exist | Import the companies or contacts first; the preview names the row |
| Dates a day early | Plain dates read as UTC | Re-import with the script: it applies the time zone |
| `1.200` saved as 1.2 (or 1200) | The decimal separator was guessed | Set `decimalSeparator` |
| The app will not take a CSV ("Unsupported file type") | The app's Import reads Excel or JSON only | Use this script, or save as `.xlsx` |
| Error rows in an app import do not match the sheet | Row N counts only rows with data, under the header | `job` explains; empty or skipped rows shift the number |
| The app job says N errors but lists none | Older jobs kept errors only in the live panel | Import again with this script for row details |
| Duplicates that are already in the account | The import only checks what it creates | `prolibu-data-cleanup` |

## Verify

- `apply` matches every row to the importer's answer, then reads each record back and lists any
  field that did not save as sent in `problems`. `saved: true` means every row to write was
  created or updated and read back as sent.
- Give the user the counts, the failed rows with reasons, and the `reportFile` path.

## Don't

- Import through the generic helper, the importer by hand, or one `POST` per row from a loop:
  the duplicate check, type conversion and per-row report live in the script.
- Map a column to a field you guessed: confirm it, or map it to `null`.
- Pick one of several matching records yourself (`ambiguous`): show them and let the user decide.
- Upload an Excel "datamap" sheet to the app with `drop` set: it deletes every record of that
  object before importing.
- Import into other objects with this skill; it covers contacts, companies and deals.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. External ids follow `prolibu-external-refs` (the script runs its sync check whenever
`refId` is mapped). For how objects relate, see `prolibu-platform-map`.
