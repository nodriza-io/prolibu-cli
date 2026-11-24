# Reading many records without taking the server down

Read this before any page, script or export that reads more than one page of records, or that
shows totals, counts or a table over a whole object (deals, contacts, tasks, e-mails…).

## Why it matters

Every account on a server shares one database. A list call that **sorts or filters on a field
without an index** makes the database read and sort the whole collection, on every call: the
page size does not change that. On an account with about 14,000 deals, one page of 500 sorted
by `createdAt` read about 300 MB; sixteen such calls at once filled the server and **every
account on it went down**, not only that one.

The request limit per API key (about 2,500 calls) does not protect the database. Few calls can
still be too heavy: what costs is what each call makes the database read.

## What is indexed

- `_id`, on every object. It is the only field you may assume is indexed.
- Usually the object's code (`dealCode`, `contactCode`…), the text-search index, and a few
  references (on `deal`: `contact`, `refId`, `tags`).
- **Not indexed on `deal`** (checked on the server): `createdAt`, `updatedAt`, `stage`,
  `assignee`, `closeDate`, amounts. Treat every other field of every object the same way.

`_id` carries its creation time, so **newest first is `sort=-_id`** and oldest first is
`sort=_id`. Both use the index; `-createdAt` does not. The same holds for a period on the
creation date: the first 8 hex digits of an `_id` are its creation time in seconds, so
"created since a day" is `{"_id":{"$gte":"<seconds of that UTC midnight, 8 hex digits><16
zeros>"}}` (2026-01-01 → `6955b900` then 16 zeros), which walks the index instead of the
collection. Keep the
`createdAt` condition next to it in `$and` when the exact boundary matters.

## The recipe, by what is needed

| Need | Do this |
| --- | --- |
| Figures: totals, counts, sums by stage, advisor or month; a funnel; goals | A Prolibu **report** (`prolibu-dashboards`). The page links to it or a dashboard shows it. |
| The rows of a report, in a page or a file | **One** call: `GET /v2/report/generate/?reportId=<reportCode>&downloadFormat=json`, plus `&xquery=<period>` when there is one. No `sort`, no `page`. The server streams one pass with the visitor's permissions and only the report's columns. Group, sum and sort those rows in memory. |
| A table in a site that shows a page at a time | `limit` 25–50, `select` only the columns shown, `sort=-_id` (or `_id`). Other orders apply to the rows already loaded. |
| Every record, in a script (export, scan, clean-up) | Cursor on `_id`: `sort=_id`, `limit=500`, `select` the fields used, and each next call adds `{"_id":{"$gt":"<last _id>"}}` to `xquery` (inside `$and` with the other filters). One call at a time; stop at a cap you state. Sort by date afterwards, in memory. |
| How many records match | One call with `limit=1&select=_id`; read `pagination.count`. Over 2,000 rows, use the report stream instead of pages. |

## Never

- `sort` on any field other than `_id` while paging through an object: each page re-reads and
  re-sorts the whole collection. A cursor on `createdAt` has the same cost.
- One call per group (one count per stage, per advisor, per month): each call reads the whole
  collection. Load the rows once (report stream) and group in memory, or use a report.
- Calls in parallel to the same object (`Promise.all` over pages or groups, "3 at a time").
- Reloading everything on every filter change, on a timer, or on every visit to a page many
  people open. Load once; filter in memory.
- `populate` over many pages; read the references once by `_id` with `$in` (100 per call).

## Before you ship

Say, in one line, how many calls the page or script makes per visit or per run, on which
objects, and what each one sorts and filters on. If any of them sorts on a field other than
`_id`, or the number of calls grows with the number of stages, users or pages, redo it with
the recipe above.
