---
name: prolibu-ui-customization
description: Customize Prolibu's lists and menu the way the V2 app does — saved filters on an object's list (create, share with the team, fix, explain why a seller does not see one), the account's default table columns per object, sidebar links, row actions that open a site, and cell or field widgets (code that runs in every user's browser, so it is reviewed and needs its own yes); switch any of them off. Validates every field against the object's live schema, resolves stages by code and users by e-mail, and shows who will get each change. Use it whenever someone asks for default columns, a saved or shared filter, a menu link, a row button, a widget on a field or column, or why a filter or button is missing. Spanish triggers: "columnas por defecto", "pon por defecto las columnas", "filtro guardado", "crea un filtro", "compártelo con el equipo", "el vendedor no ve el filtro", "agrega una acción en la fila", "botón en la fila", "enlace en el menú", "quita el widget", "widget en el campo".
---

# Prolibu UI customization

## Central idea

Two objects change what users see in lists, without code deploys:

- **CustomFilter** — a saved filter on one object's list (`modelName`, e.g. `Deal`). Its
  `filter` is a plain Mongo query the app sends as `xquery`. Values are literal: "me" is
  saved as the creator's user id and "this month" as fixed days, so a shared "Mis negocios
  de este mes" shows the creator's deals of that month to everyone, forever. Sharing is
  `allowEveryone.view`. Each viewer still sees only the records they may see.
- **CustomUi** — one record per piece: `Default Table Columns` (one per object; the newest
  wins), `Sidebar` (a menu link), `Table Row Action`, `Table Cell Widget`, `Field Widget`.
  The last three carry `code` that runs **in the app's own window with the user's session**.
  It is not a sandbox. Only admins can write CustomUi. A new record reaches **every user**
  unless its audience is narrowed (`allowEveryone.view` defaults to true).

`scripts/ui.js` does all of it with the app's rules: schema checks, the app's filter shape,
one default per object, safe links, code review, audience and read-back.

```
node .claude/skills/prolibu-ui-customization/scripts/ui.js <command> <domain> …
  filters <domain> [--model Deal] [--search text]   saved filters this profile can see
  filter  <domain> <id|CSF-code>                    check one: fields, ids, matches, sharing
  ui      <domain> [--type columns|sidebar|rowAction|cellWidget|fieldWidget] [--model M] [--all]
  ui-show <domain> <id|code>                        one CustomUi with its code
  fields  <domain> <Model> [--search text]          field paths for columns and filters
  preview <domain> '<plan>'  →  apply <domain> '<plan>' --version <v> --confirmed [--runs-code]
```

Output is JSON. Exit codes: 0 ok, 1 request failed (a 403 prints `FORBIDDEN`), 2 usage
error (nothing sent), 3 blocked (nothing written). Every command takes `--profile <name>`.

## Ask the user first

1. **Which account** (if `accounts/` has several) and **which object** (Deal, Contact…).
2. **For a filter:** the conditions in words, whether to share it, and if "mine" should mean
   the creator (it cannot mean "whoever opens it").
3. **For columns:** the fields in order and which one stays fixed on the left (default: first).
4. **For links and row actions:** the exact URL, which record fields go in it, and who gets
   it: everyone, or a list of user e-mails.
5. **For widgets:** the code (or what it must show). Say plainly it runs in each user's browser.

## Steps

**Find fields.** `fields <domain> Deal --search stage`. A ref field (stage, assignee) takes
ids; in a filter plan you may write stage codes and user e-mails and the script turns them
into ids. A nested path (`proposal.quote`, `stage.stageName`) is a valid column.

**Saved filter.**

```json
{"kind": "filter", "set": {"name": "Mis negocios abiertos de este mes", "model": "Deal",
  "query": {"assignee": {"$in": ["$me"]}, "stage": {"$nin": ["deal-stage-approved", "deal-stage-denied"]}},
  "dates": [{"field": "createdAt", "preset": "thisMonth"}], "shared": true}}
```

`dates` presets: today, yesterday, last7Days, last30Days, last90Days, thisWeek, thisMonth,
lastMonth, thisYear, or `from`/`to` (YYYY-MM-DD). One operator per field object
(`$eq $ne $regex $in $nin $exists $gt $gte $lt $lte`); combine with `$and`/`$or`. Case-free
text is `{"$regex": "(?i)acme"}`. To edit, add `"id"` and send only what changes (`query`
replaces the whole filter). The preview gives `matchesForThisProfile` and the stage and user
names behind the ids: read them to the user.

**Default columns.** `{"kind":"columns","model":"Deal","columns":["dealName","stage",{"path":"proposal.quote","name":"proposal"},"assignee"],"sticky":"dealName"}`.
If the object already has a default, the script updates the one the app uses (it never adds
a second). Width defaults to 180.

**Sidebar link.** `{"kind":"sidebar","set":{"label":"Planes","url":"/planes","target":"_self","insertBefore":"Directory"}}`.
`url` is an app path or an `https://` link; `target` defaults to `_blank`.

**Row action that opens a site.**
`{"kind":"rowAction","model":"Contact","label":"Abrir en el sitio","openUrl":"https://example.com/c?email={{email}}"}`.
The script writes the code. `{{field}}` values go URL-encoded in the path or query only.
The preview lists `opens` (host) and `dataSentOut` (fields that leave Prolibu).

**Widgets or custom row-action code.** `{"kind":"cellWidget"|"fieldWidget","model":"Deal","field":"stage","code":"// CustomUi v2\n<template>…</template>"}`
or `{"kind":"rowAction",…,"code":"// CustomUi v2\n…"}`. The first line must be
`// CustomUi v2`. The preview shows `codeReview` (URLs, external fetch, record writes). Apply
needs `--runs-code` on top of `--confirmed`, after the user approved the code itself.

**Audience** (any CustomUi plan, or alone as `{"kind":"audience","id":"…","audience":…}`):
`"everyone"` or `{"users":["ana@example.com"]}`. Admins always see every record.

**Remove.** `{"kind":"deactivate","id":"<id|code>"}` (or `activate`). Never delete.

Every write: `preview`, tell the user `changes`, `recipients`, `opens`, `dataSentOut`,
`warnings` and `blockers` in plain words, stop. After a yes, `apply` with `--version` and
`--confirmed`.

## How the platform behaves

Details and evidence are in `references/ui-model.md`.

- **Who sees a filter:** its creator, admins, and everyone when shared. A seller's private
  filter is also visible to users who share the seller's workspace. Sellers can create
  filters; editing someone else's needs `allowEveryone.edit`, which this skill never sets.
- **Columns order of precedence:** the user's own saved columns (browser) → the account default
  (CustomUi) → the app's built-in default. A user who changed columns keeps them until
  "Restablecer".
- **CustomUi is cached per session:** users see changes after reloading the app.
- **The server accepts anything:** unknown fields, `javascript:` links, code without the
  marker. The app then hides it or shows an empty column. The script blocks these first.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Seller does not see a filter | Not shared, or seller cannot open that list | `filter <code> --profile <seller>`; share it |
| Shared "my deals" shows the creator's deals | "me" is saved as a fixed id | Explain; each seller saves their own |
| Filter empty from next month on | Dates are fixed days | Re-save with a new preset |
| Default columns not applied | User has saved columns, or a newer default exists | "Restablecer"; `ui --type columns` (`conflicts`) |
| Widget or row button missing | Inactive, no `// CustomUi v2` first line, audience, or not reloaded | `ui-show` |
| Column empty | Field not in the schema | `fields`, then fix the columns |

## Verify

- `apply` reads the record back and lists any field that did not save under `problems`.
- For a shared filter, run `filters <domain> --model <M> --profile <seller>` to see it as a
  seller would.

## Don't

- Set `allowEveryone.edit` on anything, or write CustomUi as a non-admin (it is a 403: stop).
- Save hand-written code without showing it and getting a yes to `--runs-code`.
- Put record values in a link's host, or use `http:`, `javascript:` or `data:` links.
- Delete filters or CustomUi records; deactivate them.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md). A `403` means
the profile's user may not do that: stop and say so; never retry it another way or with
another profile. Stage ids and pipelines go to `prolibu-stages`; who can see which records
to `prolibu-access-review`; new fields to `prolibu-custom-fields`; report columns and
dashboards to `prolibu-dashboards`.
