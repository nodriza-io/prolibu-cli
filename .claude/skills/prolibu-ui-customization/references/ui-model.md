# CustomFilter and CustomUi: how the platform and the V2 app use them

Verified against the backend, the V2 app and live reads on a test account (2026-11-03).

## CustomFilter

| Field | Meaning |
| --- | --- |
| `customFilterCode` | `CSF-…`, generated. The REST path accepts the id or this code. |
| `customFilterName` | Required. The app does not check that names are unique. |
| `modelName` | Singular model name (`Deal`). The app lists `{$in: ['Deal', 'Deals']}` for old records. |
| `filter` | Mixed. A compiled Mongo query. A PATCH replaces it whole. |
| `allowEveryone` | `{view, edit}`, both false by default. The app's "Equipo" toggle sets `view` only. |

- **The app's shape.** Date ranges go as `$and: [{f: {$gte: day}}, {f: {$lt: nextDay}}]`, with
  one operator per object (the app's code says the server keeps only the last operator when
  one object holds several). Contains is `{$regex: "(?i)text"}`, never `$options`. Ref values
  are ids.
- **No dynamic values.** Date presets and the "me" token are turned into literal dates and
  the creator's id before saving. Nothing rolls forward.
- **Listing.** The app calls `/v2/customfilter/search` with `xquery: {modelName}` and
  `searchTerm: ''`, because sales roles have `search` but not `find` on CustomFilter (a
  seller's `GET /v2/customfilter` is a 403).
- **Applying.** The query is merged into the list's `xquery`, on top of the viewer's own
  record access. A field the visual editor does not know still applies, as raw JSON.
- **Who sees it.** The record ACL applies: the creator, admins, `allowEveryone.view`, and
  users whose shared workspaces include the filter's workspace. A filter created by a user
  with a primary workspace is stamped with it. Editing needs creator, admin or
  `allowEveryone.edit`. The app shows edit and delete buttons from role permissions only.
- **Favorites and last used** live in the browser (`localStorage`), not on the server.

## CustomUi

Common fields: `customUiName` (required), `customUiType`, `active`, `assignee`,
`collaborators`, `allowEveryone` (`view` defaults to **true**), `code`.

| Type | Sub-object | Notes |
| --- | --- | --- |
| Default Table Columns | `defaultColumns {modelName, columns[]}` | Columns `{name, width, path?, selectKey?, stickyColumn?}`; sticky first. |
| Sidebar | `sideBar {label, url, target, icon, insertBefore}` | `insertBefore` matches a menu key, model name or label; else the end. |
| Table Row Action | `rowAction {modelName, label, icon, slot, order}` | `code` is an async body that gets `ctx`. |
| Table Cell Widget | `cellWidget {modelName, fieldName}` | `code` is `<template>` + `<script>` (setup body) + `<style>`. |
| Field Widget | `fieldWidget {modelName, fieldName}` | Same as the cell widget; only on fields that exist. |

- **Loading.** The V2 app reads every active CustomUi in one request (newest first, up to
  500), caches it per session in the browser, and reloads on realtime changes. Users who
  already have the app open pick up changes on reload.
- **Visibility in the app.** Inactive → hidden. Admin → shown. `allowEveryone.view` not false
  → shown. Otherwise only the assignee and collaborators. No role targeting exists.
- **Precedence.** Columns: one record per model, the newest `updatedAt` wins; the user's own
  saved columns beat it. Widgets: the newest per `model:field` wins.
- **Code.** The first non-empty line must contain `customui v2`, or V2 ignores it (V1 code
  does not run in V2, and V1 skips V2 code). It runs with `new Function` in the app's
  window. Some globals are shadowed, but the app's own docs say this is not a security
  boundary. `ctx.api(model)` reads and writes records as the user, `ctx.fetch` calls any URL
  without credentials, and `ctx.openUrl` opens any URL in a new tab. Row actions are not
  gated by any permission.
- **Links.** The sidebar blocks `javascript:`, `data:` and `vbscript:` and turns a bare host
  into `https://`. There is no domain allowlist. `ctx.openUrl` checks nothing.
- **Server checks.** Only the type enum, the model name enum, the slot and target enums. It
  accepts unknown fields, any URL and any code.

## Permissions

- CustomUi: base roles have `find`, `findOne` and `search` only. Only admins (or a role
  granted CustomUi create/update) can write.
- CustomFilter: base roles have `findOne`, `search`, `create`, `update` and `delete` (record
  access still applies).
