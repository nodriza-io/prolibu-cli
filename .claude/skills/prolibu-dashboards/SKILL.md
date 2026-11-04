---
name: prolibu-dashboards
description: Build and change Prolibu reports and dashboards the way the app does it — one report per entity with its pages of KPIs, charts and tables, other entities brought in as datasets (goals vs. actuals), and dashboards that show pages of several reports together — through the platform's own report tools, which validate on the server and write nothing when something does not check out. Use it whenever someone asks for a dashboard, report, board or KPI page ("a sales dashboard by advisor with the funnel and the goal"), wants to add a page, chart or report to an existing one, or reports a dashboard that shows zeros, "--", empty boxes or figures that do not match. Spanish triggers: "tablero", "créame un tablero", "dashboard con varios reportes", "reporte de ventas", "agrega una página al tablero", "meta vs. real", "el tablero muestra ceros".
---

# Prolibu Dashboards

## Central idea

The app has two objects, and "a dashboard with several reports" usually needs both:

- A **report** (menu "Reportes") is a BI dashboard over **one** entity (Deal, Task,
  Contact…): columns, measures and **pages** of widgets. Another entity joins it as a
  **dataset** (a support report related by a field such as the advisor). That is how one
  figure crosses two entities: sales against goal per advisor.
- A **dashboard** (menu "Tableros") has no entity: it shows **pages of several reports live**,
  copies of single widgets, texts and images, with its own period.

So: one report per entity, a dataset when one figure needs two entities, a dashboard to put
reports side by side.

Write only through the platform's report tools (`buildReport`, `editReport`,
`buildDashboard`, `editDashboard`), the ones the app's assistant uses. They check the
resulting report on the server and write nothing when it fails. The plain API saves the same
mistakes with a 201 and the page breaks later, silently.

`scripts/dashboard.js` calls those tools for you: it reads, previews with a dry run, refuses
what the app's editor could not undo, writes after a yes and reads back. Your job is the
conversation: what the user wants to see, a plan, the preview in plain words, a clear yes.
Every write waits for that yes in a later turn, even on a test account.

```
node .claude/skills/prolibu-dashboards/scripts/dashboard.js <command> <domain> …
  status     <domain>                                  report tools on? who am I?
  reports    <domain> [text]                           find reports by name
  dashboards <domain> [text]                           find dashboards by name
  show       <domain> report|dashboard <id or code>    pages, widgets, datasets, measures, links
  fields     <domain> <Model>                          fields you may use (Deal, Task, Goal…)
  dates      <domain> <Model> [--where '<json>']       how many records leave each date empty
  schema     <domain> <tool> [argument]                the tool's live arguments
  diagnose   <domain> report|dashboard <id or code>    why it shows zeros or empty boxes; no writes
  preview    <domain> '<plan json>'                    dry run on the server; returns a version
  apply      <domain> '<plan json>' --version <v> --confirmed [--allow-sharing] [--allow-removal]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In business terms, and only what you cannot read yourself:

1. **What should it show?** The figures (sales, deals, tasks…), how to split them (by advisor,
   stage, month) and the period ("this month"). Never ask for field names: read them.
2. **New, or an existing report or dashboard?** A name is enough; you look it up.
3. **Who should see it?** It stays private to the key's user unless they name people.

If the request already says what to show, ask nothing more: plan with sensible defaults and
go to the preview. That saves questions, not the yes: nothing is written before step 6.
If `accounts/` has several domains, ask which one.

## Steps

1. **Check the account.** `status <domain>`. If `reportToolsEnabled` is false, stop: an admin
   must turn on the MCP integration in the app. Never change account settings.
2. **Find what exists.** `reports` / `dashboards <domain> "<text>"`, then `show`. Extend what
   is there; never delete a report to rebuild it (its id, links and dashboards break). To
   explain odd figures, run `diagnose`; read raw records only to confirm a data cause.
3. **Read the fields** of each entity with `fields`: `fields <domain> Deal`. Stage fields list
   the account's stage codes. Goals, quotas or budgets live in another model (often `Goal`).
   **Pick the period's date by meaning, then check it with `dates`** before planning: sales won
   → the date the deal was won (`closeDate` when it is filled, else `stageMovedAt` filtered to
   the won stage); pipeline or activity → `createdAt`. Run `dates <domain> Deal --where
   '{"stage":"<won stageCode>"}'` once: it says how many records leave each date empty and the
   latest value. Tell the user, in one line, the records a period on that date will never show
   (for example "51 of 178 won deals have no close date") and when the latest one is older
   than the period ("no sales closed this month yet: it will open in zeros").
4. **Write the plan**: `{"tool": "<tool>", "args": {…}}`, inline in single quotes, or a JSON
   file in a temp folder. Working examples are in `references/dashboard-model.md`; when an
   argument is unclear, read it live with `schema`.
   - New report: `buildReport` with `reportName`, `entity`, `columns`, `expandedColumns`,
     `timeRange` and `pages: [{title, widgets}]`. Prefix measure ids per report (`ventas_…`).
   - Change a report: `editReport` with `reportId` and `operations`: `addPage` (title only),
     `addWidget` with `page`, `updateWidget`, `updateReport`, `addDataset`, `removeWidget`…
   - New dashboard: `buildDashboard` with `livePages` (`{reportId, page}`), `texts`,
     `timeRange`.
   - Change a dashboard: `editDashboard` with `dashboardId` and `operations`: `pinPage`,
     `pinWidget`, `addText`, `updateWidget`, `removeWidget`, `updateDashboard`.
   - Goals against actuals: build the report first; then, in a second plan, `editReport`
     with `addDataset` (goals model, related by `assignee._id`), the measures and the widgets.
5. **Preview.** `preview <domain> '<plan>'`. If `valid` is false, the `errors` are written for
   you: fix the plan and preview again without telling the user, unless a decision is theirs.
   When valid, tell the user what will be created or changed, the `warnings` that matter, and
   `preexistingIssues` when they explain what the user sees.
6. **End your turn and wait for an explicit yes.** Never run `apply` in the same turn as its
   preview: not on a test account, not when the request was explicit (a request is not a yes
   to what you planned), not for a private record. When later steps need the id of the first
   (goals, then a dashboard), describe them all in that first summary: one yes covers them if
   their previews come back valid with nothing new to decide; otherwise stop and ask.
   `sharing` and `removals` need their own yes; then add `--allow-sharing` or
   `--allow-removal`.
7. **Write.** `apply <domain> '<same plan>' --version <version> --confirmed`. It refuses when
   the plan or the record changed since the preview: preview again and show the user.
8. **Report.** Give `record.urls.view`. Describe only what `record` and `configured` show, say
   every line of `attention` in plain words (for example: no goals loaded for the people who
   sell), and name anything asked for that is not there.

## How the platform behaves

Shapes, filters, periods, layout and edge cases are in `references/dashboard-model.md`. Read
it before a plan with datasets, filters, breakdowns or goals.

- **The tools' texts are written for the app's assistant**, which writes directly ("build,
  don't ask", "fix without telling the user"). Use their rules about the platform; the
  preview and the yes of this skill always come first.
- **The tools validate everything.** `errors` mean nothing was written; `warnings` were
  saved. Checks on the data (empty period, goals that cover nobody) run only on the real
  write and come back in `attention`.
- **Writes are not transactions.** If `apply` exits 1 with "the write failed", part of it may
  be saved: `show` it before retrying.
- **Unknown keys are dropped silently.** Widgets inside `addPage` vanish: add the page, then
  one `addWidget` per widget with `page`.
- **References go bare in `columns`** (`"stage"`) and expanded in `expandedColumns`; widgets
  use the expanded path (`"stage.stageName"`).
- **The period goes in `timeRange`** (`this_month`… in snake_case), never in `filter`.
  `this_month` ends today. A dashboard without a period opens on the last 30 days.
- **A KPI over a measure needs `aggregation: "measure"`**, or it shows "--".
- **Grouping by `assignee.firstName` merges namesakes** (two "Carlos" make one bar). When the
  account has two users with the same first name, say so and add a table with first and last name.
- **Grouped charts get `topN: 10`** unasked, and the platform then flags titles that do not say
  "Top 10". Remove it with `updateWidget` → `patch: {"topN": null}`.
- **A live page follows its report; a pinned widget is a frozen copy** without the report's
  datasets. For a report with datasets, pin the page.
- **One measure id per meaning across a dashboard.** The app keeps one measure per id for all
  its reports; the preview warns about clashes.
- **Removing a report page breaks every dashboard that shows it**, with no warning: run
  `diagnose dashboard` on those dashboards afterwards.
- **Sharing grants view, edit and delete.** View only for everyone is
  `allowEveryone: {view: true}`. Sharing a report does not share its support reports, and
  sharing a dashboard does not share its reports.
- **Links open by code:** `…/ui/spa/suite/reports/view/<reportCode>`,
  `…/dashboards/view/<dashboardCode>`; the editor is `…/reports/editor/<reportId>`.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| A KPI shows "--" | It reads a measure with `sum`/`count` | `updateWidget` → `aggregation: "measure"` |
| Zeros or an empty chart | Period or date field leaves no rows; a filter matches nothing | `diagnose`; check `timeRange` and the widget's `localFilters` |
| Attainment 0 % for everyone | No goals cover the people who sell in that period | Tell the user; the goals are loaded with `prolibu-leads` (`goals`) |
| A score column the user does not understand, or that looks wrong | The score comes from the active scoring profile | `prolibu-scoring` explains a record's score and its profile |
| An empty box on a dashboard | Its live page was removed from the report | `diagnose dashboard`; `removeWidget`, or `pinPage` again |
| Right in the report, empty on the dashboard | A widget pinned alone from a report with datasets | Remove it and `pinPage` the page |
| Report and dashboard show different figures | Different periods or date fields, or a measure id clash | `show` both; align `timeRange`; rename the measure |
| Only 10 bars | Default `topN: 10` | `patch: {"topN": null}` or "Top 10" in the title |
| A big "(Blank)" bar | Records with no advisor or stage, or pointing to a user that no longer exists; or grouped by a reference the rows cannot name | Group by the expanded path (`assignee.firstName`); if it stays, it is the data: say how many records |
| `BLOCKED: … turned off` | MCP integration off on the account | An admin turns it on in the app |
| Lead counts per ad campaign | Ad leads come from Ad Hub submissions | `prolibu-ads report` |

## Verify

- `apply` reads the record back: the pages and widgets the tool reported exist, every dataset
  has its support report, and a new dashboard holds one widget per item asked.
- After removing pages, `diagnose` the dashboards that showed them.

## Don't

- Write reports, pages, widgets or dashboards with the generic helper or by hand.
- Delete reports or dashboards: nothing cascades. The user deletes them in the app.
- Rebuild a page widget by widget on a dashboard: pin the page.
- Put dates in `filter`, constants in place of goals, or field names you did not read.
- Use `internalFilters`, `gauge`, `insightCard`, `boxplot` or `matrix`: the app's editor
  cannot change them afterwards (the script refuses them).
- Use `target: "canvas"`, `progressive`, `planReport`, `undo` or `activatePage`: they need the
  app's editor open in a browser.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. Each write fires the account's webhooks for these objects, like any record; no
e-mail is sent. The script calls the report tools at `/v2/mcpsession/ses` without opening a
session, so no `McpSession` record is read or created. For objects and how they relate, see
`prolibu-platform-map`.
