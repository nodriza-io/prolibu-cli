# Import model: how the platform imports records

Reference for `prolibu-imports`. Verified against the server code, the app's code and a live
non-production account. Read the section you need.

## The importer

One endpoint, `PUT /v2/service/importdata` (PUT on purpose: the server would otherwise add the
author fields to the body). Two ways to call it:

| | JSON body | File upload (multipart, field `file`) |
| --- | --- | --- |
| Body | A JSON array of records | An `.xlsx` or a `.json` file (an array) |
| `modelName` | Required, in the query | Required, unless the workbook has a `datamap` sheet |
| Runs | While the request waits | In the background, as an import job |
| Answer | `200 {created: [records], updated: [records], errors: [{type, row, error}]}`; with `?silent=true`, counts instead of records | `202 [{id, modelName, status, totalRows…}]`, one job per sheet |
| Row numbers in errors | 0-based index in the array | 1-based (see "Row numbers") |
| Dates without zone | Passed as sent: `2026-03-04` is stored as midnight UTC | Read in the user's time zone (else the account's, else America/Chicago) |
| Used by | Integrations; this skill | The app's Import menu and its bulk edit |

- `modelName` is the object's model name, singular. Case does not matter (`contact` works);
  a plural (`contacts`) answers `400 The model 'contacts' does not exist`.
- CSV is not accepted by either way (`Unsupported file type`). The app's file picker offers
  Excel and JSON; the newer app's import panel accepts only `.xlsx`. This skill reads CSV and
  Excel itself and sends JSON.
- An uploaded file is limited by the account's upload size (Preference
  `modules.tools.cloudDrive.uploadRestrictions.maxFileSizeMB`, 20 MB by default, never above the
  platform ceiling); over it the answer is `413`. A JSON body is limited to 10 MB.
- Permission: `Service.importdata`, `importjob`, `importjobs` and `cancelimportjob` are in the
  basic permissions every role gets. Each row then runs with the caller's own permissions: a
  row on a record the user may not change fails with that row's error.

## What happens to each row

For each record, in order, one at a time:

1. Look it up by `_id`, or else by the object's **primary key**: Contact `email`, Company
   `companyCode`, Deal `dealCode`. The lookup ignores the user's permissions and workspaces.
   Contact emails are stored lower case and the lookup matches any case.
2. Found: `PATCH` it with the row's fields. Not found: `POST` a new record **with the row's
   `_id` if it had one** (an unknown `_id` creates a record with that id; it does not fail).
3. The `PATCH`/`POST` is an internal API call with the caller's key and two headers: one that
   skips the per-key request limit and one that skips the live screen refresh. Everything else
   of a normal save runs: validation, model hooks, webhooks (`<Model>.create` / `.update`),
   lifecycle scripts, AI agent triggers, notifications (new record, owner assigned,
   collaborator added), stage history, deal numbering.

Not done by the importer:

- No lookup by name, tax id, `refId` or any other field. A company file imported twice creates
  every company twice; a deal file likewise. Contact, Company, Deal and Product reject a second
  record with the same text `refId`, so a re-imported row with a `refId` fails with
  `refId '…' already exists` instead of updating.
- No look-ahead: two rows with the same email in one file create the contact and then update
  it with the second row.

### Values

- **Empty cell** (or a `null` in JSON) = do not touch the field. The text `null` (any case)
  clears it; on a create it is dropped so the field's default applies.
- **References** (`company`, `contact`, `stage`, `assignee`, `tags`…) take an `_id` or the
  referenced record's primary key (a company's code, a contact's email, a user's email, a
  stage's code). A name fails the row with `Document not found by primaryKey '<value>'`. The
  server does not check that an `_id` exists.
- **Lists** in an Excel cell: ids separated by commas, or a JSON array.
- Fields the platform sets (`avoid: always` in the schema, such as `createdAt`, `notes`, a
  deal's `company`) are dropped silently.

### Object specifics

- **Contact.** `email` is required and is the key. It is unique per workspace: two workspaces
  may hold the same email, and the lookup takes the first it finds. `companyName` is a free-text
  fallback: it is emptied when `company` is set. If the account links contacts to companies by
  email domain, a new or changed email can set `company` by itself.
- **Company.** `companyName` is required; `companyCode` is generated (`CMP-…`) when missing.
  Nothing else is unique.
- **Deal.** `dealName` is required; `dealCode` is generated (`DEA-…`). A deal's `company` is set
  by the platform from its contact. A deal has no amount: its value is its quote
  (`prolibu-quotes`). If the account numbers deals in sequence, the number replaces any
  `dealCode` sent, so `dealCode` is not a stable key there (use `refId`). A deal created in the
  Approved stage may create a work order; a deal in a closed stage rejects later edits.

## Import jobs (file uploads)

- One job per data sheet. Jobs run one after another per account, in batches of 500 rows;
  progress is saved after each batch, so a failed job resumes from the last batch.
- Progress reaches the uploader's screen through the account socket (event `importProgress`
  on the user's private channel): counts, percentage, estimated time and the latest row errors.
- `GET /v2/service/importjobs?status=&modelName=&fileKey=&limit=&skip=&sort=` → `{docs, total}`;
  `GET /v2/service/importjob/<id>`; `DELETE /v2/service/importjob/<id>` cancels (checked about
  about once a second, every 10 rows). These list and cancel **every user's** jobs, not only yours.
- A job keeps the first 100 row errors (`errors: [{row, error}]`); older jobs kept none.
- On a non-production account an import of 300 contacts waited about 15 minutes in the queue
  behind other jobs and then took 8 minutes. The JSON body way answered 2 rows in half a second.

### Row numbers

- JSON file: row N is the Nth item of the array.
- Excel: row N is the Nth data row under the header **counting only rows that have data and are
  not marked `skip`** within each batch of 500. Empty or skipped rows above an error make the
  reported number smaller than the spreadsheet row. `job` says so.

### The Excel template and the datamap sheet

`GET /v2/service/downloadExcelTemplate?modelNames=Contact` (the app's "download template")
returns a workbook with a README, a `datamap` sheet and one sheet per object whose headers are
field paths (`address.city`), a `skip` column (any value skips the row) and `_id` last.

The `datamap` sheet lists `sheetName`, `objectType`, `from`, `to`, `skip` and `drop` per data
sheet. **`drop` set on a Contact, Product, PricebookEntry or Store sheet deletes every record
of that object before importing**, with no permission check. Never set it; never upload a
datamap you did not read.

## Bulk edit in the app

"Edit selected" has no endpoint of its own. The app writes a JSON file with one
`{...changes, _id}` per selected record, named `bulk-edit-<object>.json`, and uploads it to the
importer (a job like any import, shown as a bulk edit in the import panel). A cleared field is
sent as the text `null`. When the change moves records to another stage, the newer app checks
that stage's required fields before sending. In this skill a bulk edit is an import matched by `_id`
with `"missing": "skip"`; moving stages stays with `prolibu-stages`.

## The importer or one call per record

| | Importer (this skill) | One `POST`/`PATCH` per record |
| --- | --- | --- |
| Calls from the CLI | One per chunk of 20 rows | One per row, plus the lookups |
| Per-key request limit | Skipped for the rows | Counted: by default, after 2,500 requests with no pause of a full minute, every call answers `429 Too many requests` until the caller pauses a full minute |
| Duplicate check | The script's preview (by name, tax id, `refId`) plus the importer's primary key | Whatever the caller searched |
| Side effects | Same hooks, webhooks, scripts, triggers and notifications per row | Same, plus a live refresh on everyone's screen per row |
| Errors | Per row, the rest continues | Per call |

Use the importer for any batch. Use one call per record only for a handful of records that
need something the importer cannot do, such as reading the answer of each write before
deciding the next.

## Limits of this skill's script

- Contacts, companies and deals. Up to 5,000 rows read, 300 rows written per `apply` (more:
  `export`, then the app's Import → JSON), 20 rows per importer call (`--chunk`, up to 50).
- Fields: text, numbers, yes/no, dates, options, references and lists of references or text.
  Not: phone lists, free-form (`mixed`) fields, files, the quote, scoring and other fields the
  platform computes.
- It never sends the text `null`: clearing fields is done in the app.
