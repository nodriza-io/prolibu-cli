# Thousands of prices: how `bulk-prices.js` loads them

Reference for `prolibu-catalog`. Read it before loading or updating more than a few hundred
prices (price-list entries), or when a bulk run stops halfway. Verified against the server code
and read-only calls on a non-production account; what was checked only in code says so.

## Why not one call per price

`catalog.js apply` sends one `POST` or `PATCH` per price. For tens of thousands of prices:

- **The per-key request limit.** Each API key counts its calls; a call made more than a minute
  after the previous one resets the count to 1. At the 2,500th call without such a gap (the
  default; a server can set another), every call answers `429 Too many requests` — and the
  refused call counts as activity, so retrying at once keeps it blocked. Only a full minute
  without calls clears it. Every program using the same key shares the count.
- **Time and load.** Each call is a full round trip; the shared database sees the same row
  writes either way, but thousands of separate requests add per-request work (session check,
  permission check, activity stamp) on top.

## The importer, for prices

`PUT /v2/service/importdata?modelName=PricebookEntry` with a JSON array body:

- Runs while the request waits and answers `200 {created, updated, errors}`. With
  `&silent=true`, `created` and `updated` are counts and `errors` stays a list of
  `{type, row, error}`, `row` being the 0-based index in the array sent (checked live: a row
  with an unknown price list answered `errors: [{type: "create", row: 0, error: "…not found
  by the primary key…"}]`, in the user's language). An empty body or a non-array is refused.
- For each row, one at a time: look it up by `_id`, or else by `pricebookEntryCode` (the
  price's primary key). Found: `PATCH` with the row's non-null fields (the text `null`
  clears a field). Not found: `POST` the row. **A row without `_id` and without a code is
  always a create**: when that product already has a price in that list it fails with
  `pricebook '…' already exists` (the unique pair).
- **A code that exists elsewhere moves that price.** A row with the code of a price in another
  list and another product `PATCH`es that price to the row's product and list. The script
  refuses such rows.
- The lookup ignores the user's permissions; the `PATCH`/`POST` then run with them. A user who
  cannot see some prices of a list (lists can be shared by workspace) gets those rows as
  creates in the preview, and the importer fails them as duplicates.
- Each row's `PATCH`/`POST` is an internal call with the caller's key and a header that skips
  the request limit: **one importer call counts once, whatever its size.** Each row still runs
  a whole save: validation (`netUnitPrice = price − discountAmount`; a "Percent Of Total"
  price needs its base and percent), the `PricebookEntry.create`/`.update` webhooks when the
  account has webhooks on and one listens to prices, lifecycle scripts when the account
  enables them for PricebookEntry, and AI agent triggers on PricebookEntry. The live screen
  refresh is skipped.
- Body limit 10 MB (about 30,000 short price rows); the script sends far less per call.
- The file way (multipart, background job) keeps only the first 100 row errors in its import
  job, reports progress over the account socket only, and was seen waiting 15 minutes in the
  queue. For a run that must say what happened to every row, use the JSON way.

## Indexes (what each lookup costs)

Declared in the model and present on the non-production account (`getIndexes` and
`explain`): unique `pricebookEntryCode`; unique `pricebook + product`; `product`; `_id`.
Product `productCode` and price list `pricebookCode` are unique indexes too. So the importer's
lookup by `_id` or by code is an index hit, not a collection scan. The script still sends
**`_id` for every existing price**: `_id` is indexed on every account by definition, and the
preview already read it.

A read filtered by price list and paged by `_id` walks the `_id` index and filters by list
(checked with `explain`): one pass over the collection, spread over its pages. That is why the
script reads all target lists in **one** cursor (`pricebook $in [...]`) instead of one per list.

## How the script works

```
bulk-prices.js preview <domain> <file.csv|.xlsx|.json> [--map '<json>'] [--sheet <name>] [--pricebooks a,b]
bulk-prices.js preview <domain> --pricebooks a,b --factor <n> [--round <step>] [--fields price,cost] [--include-inactive]
bulk-prices.js apply   <domain> --version <v> --confirmed [--chunk 100] [--pause-ms 500] [--max-rows <n>]
```

**Mapping.** Columns default to the API names (`product`, `pricebook`, `price`, `currency`,
`cost`, `discountAmount`, `taxes`, `taxRate`, `active`, `pricebookEntryCode`; case and accents
ignored). `--map` names other columns, or a constant with `{"value": …}`:

```json
{ "product": "Código", "pricebook": "Lista", "price": "Valor", "currency": { "value": "COP" }, "taxRate": "IVA" }
```

A sheet with one price column per list uses `wide`; each filled cell becomes one price:

```json
{ "product": "Código", "currency": { "value": "COP" }, "wide": { "Bogotá Plan A": "bog-a", "Bogotá Plan B": "bog-b" } }
```

**Preview** reads, one call at a time: the account's currencies, the price lists by code, the
products by code (100 per call, on the unique index), all taxes, every price of the target
lists (one cursor on `_id`, 500 per page) and the codes the file gives that are not in those
lists. Then per row: product and list exist; price, cost and discount are numbers ≥ 0
(`1.234` alone is refused as ambiguous); currency is one the account accepts and present on
every new price; taxes exist with a rate above 0 and at most 1 (`taxRate` 19, 19% or 0.19 finds
the one tax with that rate; 0 means no tax); no pair twice in the file; a given code matches
the existing price's code. It decides create, update (only the fields that differ), unchanged
or error, and writes the job (rows, `_id`s, values before and after) to
`<temp>/prolibu-catalog-bulk/<version>/` with `preview.csv` (every row). It also counts the
active webhooks, lifecycle scripts and agent triggers on prices (`unknown` when the key cannot
read them), and says in `canWritePrices` whether the user's roles allow creating and changing
prices. For 75,000 prices over 27 lists: about 150 reads of prices plus one per 100
products.

**Factor mode** (the yearly update): every price of the given lists times `--factor` (new
reference value ÷ old), rounded to `--round` (default 0.01). Inactive prices are left out
unless `--include-inactive`; "Percent Of Total" prices are always left out. A factor below 0.5
or above 2 is refused. The preview gives `priceTotals`: how many prices go up and down, the
sum before and after, and the smallest and largest change in percent.

**Apply:**

1. Loads the job by `--version` (same computer, same account).
2. Re-reads the target lists (one cursor) and sorts each planned row: already holding the new
   values → `already written` (skipped; this is the resume); still holding the preview's
   values → pending; anything else → `changed since preview (not written)`.
3. Sends the pending rows in chunks (`--chunk`, default 100, at most 250), one call after the
   other, waiting `--pause-ms` (default 500) between calls. Existing prices go as
   `{_id, <changed fields>}`; new ones as `{pricebook: <_id>, product: <_id>, currency, price, …}`.
4. Counts every call of the run; after 2,000 it waits 65 seconds; on a 429 it waits 65 seconds
   and retries that call once (the server refuses a 429 before running the import, so nothing
   is written twice).
5. Appends each chunk's rows to `result.csv` in the job folder as soon as it answers
   (`updated`, `created`, `failed` with the server's error, `unknown`).
6. Stops at the first call that does not answer or is refused; those rows are `unknown` or
   `not sent`. The importer may still be writing an unanswered chunk: wait a couple of minutes
   before running apply again.
7. Re-reads the lists and checks every sent row now holds its new values (`verified`).

`--max-rows` writes only that many pending rows (a first small run, or a run that must end
before a time). Running apply again with the same version continues.

## Sizing and pacing

| | 75,000 new prices, 27 lists | 36,000 price updates |
| --- | --- | --- |
| Reads in preview | ~150 price pages + products ÷ 100 | ~75 price pages + products ÷ 100 |
| Importer calls (100 rows) | 750 | 360 |
| Reads in apply | twice the price pages | twice the price pages |
| Calls of the run | ~1,050 | ~510 |

Both stay under the 2,000-call budget, so the pause rarely triggers; it is there for reruns
and shared keys. The time per row is the server's save time per price, not measured yet on
this account (see the private report); a first run with `--max-rows 500` gives `seconds` to
estimate the rest. A call must answer within the client's 30 seconds: lower `--chunk` if a
call comes close.

## Not done

- No deletes and no `drop`; deactivation is `active: false` in the file.
- No discount schedules, rules or "Percent Of Total" settings in bulk: use `catalog.js` for
  those prices.
- The quotable check of `catalog.js apply` (pricing one unit on the server) is not run per
  row; run `catalog.js product <code>` on a few products afterwards.

## Who can do it, and what it exposes

- The script acts with the user's own key: creating or changing prices needs the role's
  permission on PricebookEntry (pricing roles have it; plain sales roles only read). A row on a
  price the user may not change fails with its own error; nothing is widened.
- The importer finds a price by `_id` or code even when the user cannot list it; the script
  only sends `_id`s it read with the user's key, and refuses codes owned by other prices.
- The job folder (`<temp>/prolibu-catalog-bulk/<version>/`) holds the prices, ids and the
  result file on this computer only. It has no key. Delete it when the user no longer needs
  the result file; never attach it anywhere public.
- Undo: there is no bulk undo. `preview.csv` keeps every value before the change; a reverse
  file built from its `before` column, previewed and applied the same way, puts them back.
