# Reports and dashboards: how the platform stores and builds them

Reference for `prolibu-dashboards`. Read the section you need. The tools' arguments change
often: when a shape here and the server disagree, the server wins. Read the live arguments
with `dashboard.js schema <domain> <tool> [argument]`.

## The objects

| Object | API path | Holds |
| --- | --- | --- |
| Report (app: "Reportes") | `/v2/report` | `reportCode` (`RPT-…`), `reportName`, `entity`, `columns`, `expandedColumns`, `repeatOnField`, `filter`, `measures`, `config` (free-form), `pages[]`, `collaborators`, `allowEveryone` |
| Page | `/v2/page` | `pageTitle`, `widgets[]`, `canvaConfig` (canvas size only). No access fields: it inherits the report's. |
| Widget | `/v2/widget` | `reportId`, `title`, `chartType`, `yField`, `groupByField`, `legendField`, `aggregation`, `topN`, `layout {x,y,w,h}`, `style`, `config` (free-form) |
| Dashboard (app: "Tableros") | `/v2/dashboard` | `dashboardCode`, `dashboardName`, `widgets[]`, `layoutConfig[]`, `collaborators`, `allowEveryone` |

- A widget inherits access from its report, or from a dashboard that lists it.
- `Report.config` keeps what the editor needs:
  - `additionalDatasets: [{id: "ds_<id>", reportId, label, cohortDateField, periodEndField?}]`:
    other entities. Each one is a **support report** named `"<report> · <label> (dataset)"`.
  - `relationships: [{id, from: {datasetId: null, field}, to: {datasetId, field}, enabled, …}]`:
    how a dataset joins the main entity, usually `assignee._id` on both sides.
  - `settings.savedFilters`: `savedTimeRange` (the period bar), `globalFilters`,
    `crossFilters` (page filters, by `pageId`).
  - `calculatedColumns` (ids start with `_cc_`), `columnAliases`, `columnFormats`,
    `columnConditionalFormats`.
- `Dashboard.layoutConfig` has one `{i: <widgetId>, x, y, w, h, zIndex}` per widget, which
  wins over `Widget.layout`, plus one `{_type: "dashboardSettings", savedTimeRange,
  refreshInterval}`.
- A page shown live on a dashboard is a widget with `chartType: "livePage"` and
  `config: {sourceReportId, sourcePageId, sourceReportName, pinnedFilters}`. It draws the
  page's current widgets with that report's datasets.
- A widget pinned alone is a **copy** with `config.sourceWidgetId`. Later changes to the
  report do not reach it, and it does not carry the report's datasets.

## The tools

All four validate the whole resulting report or dashboard. A `dryRun` returns
`{created:false, dryRun:true, message, warnings}` (build) or `{ok:true, dryRun:true, applied,
preexistingIssues, warnings}` (edit). A rejected call returns `errors: [{where, message}]` and
writes nothing.

- `buildReport` creates support reports first, then the report, its pages and widgets.
  Success: `{created, reportId, pageIds, widgetIds, counts, configured, attention?, warnings}`.
- `editReport` applies all its operations or none. It blocks only new problems; old ones come
  back as `preexistingIssues`.
- `buildDashboard` turns its lists into operations: `widgets`, `livePages`, `pinnedWidgets`,
  `texts`, `images`, then `timeRange`. Success: `{created, dashboardId, dashboardCode,
  widgetIds, applied, configured}`.
- `editDashboard` operations: `pinPage`, `pinWidget`, `addWidget`, `addText`, `addImage`,
  `updateWidget`, `removeWidget`, `updateDashboard`. With `operations: []` it returns the
  current widgets (the script's `show` does the same through the API).
- **Checks that run only on the real write** (`attention`): periods with no records, goals
  that cover none of the people who sell, fields that are almost empty. The dry run cannot
  show them; read `attention` after `apply`.
- **Writes are not transactions.** A failure after validation ("Validation passed but the
  write failed") can leave a half-written report. The script exits 1 and says so: check with
  `show` before retrying.
- Side effects: each create or update fires the account's webhooks and data events for
  Report, Page, Widget and Dashboard, like any record. A dashboard open in a browser reloads
  after `editDashboard`. No e-mail or notification is sent.
- Only for the app's editor, refused by the script: `target: "canvas"` (over HTTP it answers
  ok and saves nothing), `undo`, `activatePage`, `progressive`, `reportId` on `buildReport`,
  `planReport`, `captureSnapshot`.

## Plans that work

New report, two pages (period in `timeRange`, references bare in `columns`):

```json
{"tool": "buildReport", "args": {
  "reportName": "Ventas del mes", "entity": "Deal",
  "columns": ["_id", "dealName", "stage", "assignee", "proposal.quote.total", "createdAt"],
  "expandedColumns": [{"path": "stage", "select": "_id stageName stageCode"},
                      {"path": "assignee", "select": "_id firstName lastName"}],
  "timeRange": {"mode": "preset", "presetKey": "this_month", "dateField": "createdAt"},
  "pages": [
    {"title": "Ventas", "widgets": [
      {"title": "Negocios", "chartType": "kpi-card", "yField": "_count", "aggregation": "count",
       "layout": {"x": 1, "y": 2, "w": 46, "h": 12}},
      {"title": "Monto cotizado", "chartType": "kpi-card", "yField": "proposal.quote.total", "aggregation": "sum",
       "config": {"valueConfig": {"format": {"type": "compact", "decimals": 1, "decimalsExplicit": true}}},
       "layout": {"x": 49, "y": 2, "w": 46, "h": 12}},
      {"title": "Monto por asesor", "chartType": "column", "yField": "proposal.quote.total", "aggregation": "sum",
       "groupByField": "assignee.firstName", "layout": {"x": 1, "y": 16, "w": 94, "h": 26}}]},
    {"title": "Embudo", "widgets": [
      {"title": "Monto por etapa", "chartType": "funnel", "yField": "proposal.quote.total", "aggregation": "sum",
       "groupByField": "stage.stageName", "layout": {"x": 1, "y": 2, "w": 94, "h": 34}}]}]}}
```

Goals against actuals on that report (second plan). The goals model on most accounts is
`Goal` (`assignee`, `startDate`, `endDate`, `targetValue`); read it with `fields`:

```json
{"tool": "editReport", "args": {"reportId": "<report _id>", "operations": [
  {"op": "addDataset", "newDataset": {"label": "Metas", "entity": "Goal",
    "columns": ["_id", "goalName", "assignee", "startDate", "endDate", "targetValue"],
    "expandedColumns": [{"path": "assignee", "select": "_id firstName lastName"}],
    "includeReferenceIds": true, "cohortDateField": "startDate",
    "measures": [{"id": "ventas_meta", "label": "Meta", "expression": "SUM([targetValue])", "dataType": "decimal"}],
    "relationship": {"fromField": "assignee._id", "toField": "assignee._id", "cardinality": "manyToMany"}}},
  {"op": "updateReport", "patch": {"measures": [
    {"id": "ventas_venta", "label": "Venta", "dataType": "decimal",
     "expression": "SUMX(IF([stage.stageCode] == \"deal-stage-approved\", [proposal.quote.total], 0))"},
    {"id": "ventas_meta_total", "label": "Meta", "expression": "[Metas.ventas_meta]", "dataType": "decimal"},
    {"id": "ventas_cumplimiento", "label": "% Cumplimiento", "expression": "DIVIDE([ventas_venta], [Metas.ventas_meta])", "dataType": "percentage"}]}},
  {"op": "addPage", "newPage": {"title": "Meta vs. real"}},
  {"op": "addWidget", "page": "Meta vs. real", "widget": {"title": "% Cumplimiento", "chartType": "kpi-card",
    "yField": "ventas_cumplimiento", "aggregation": "measure",
    "config": {"valueConfig": {"format": {"type": "percentage", "decimals": 1}}},
    "layout": {"x": 1, "y": 2, "w": 30, "h": 12}}},
  {"op": "addWidget", "page": "Meta vs. real", "widget": {"title": "Venta vs. meta por asesor", "chartType": "column",
    "yField": "ventas_venta", "aggregation": "measure", "legendField": "ventas_meta_total",
    "groupByField": "assignee.firstName", "layout": {"x": 1, "y": 16, "w": 94, "h": 28}}}]}}
```

- `updateReport` → `measures` replaces the whole list: send the existing ones too.
- A cross measure is `[Label.measureId]`. A percentage is the fraction (no `* 100`), with
  `dataType: "percentage"`.
- The won stage code is the account's own: read it with `fields <domain> Deal` (`stages`).
- Give measure ids a prefix per report (`ventas_…`): on a dashboard the app merges the
  measures of all its reports by id and keeps only one per id. The preview warns when two
  reports clash.

Dashboard with pages of two reports:

```json
{"tool": "buildDashboard", "args": {"dashboardName": "Tablero comercial",
  "livePages": [
    {"reportId": "<sales report _id>", "page": "Ventas", "layout": {"x": 1, "y": 2, "w": 94, "h": 54}},
    {"reportId": "<activities report _id>", "page": "Actividades", "layout": {"x": 1, "y": 58, "w": 94, "h": 54}}],
  "timeRange": {"mode": "preset", "presetKey": "this_month", "dateField": "createdAt"}}}
```

Other operations:

```json
{"op": "pinPage", "reportId": "<id>", "page": "Actividades"}
{"op": "removeWidget", "widgetId": "<dashboard widget _id>", "widgetTitle": "Embudo"}
{"op": "updateWidget", "widgetId": "<id>", "patch": {"chartType": "bar"}}
{"op": "updateWidget", "widgetId": "<id>", "patch": {"topN": null}}
```

- Several widgets on a new page: `addPage` with only `title`, then one `addWidget` per widget
  with `page`. Extra keys inside an operation are dropped without an error.
- On `updateWidget`, `config` is merged: send only the keys that change, `null` deletes one.

## Filters: four levels, two vocabularies

| Level | Where | Compares against | Notes |
| --- | --- | --- | --- |
| Report filter | `filter` (Mongo query) | stored values (`_id`s) | Only one that reduces what the server sends. Never dates. |
| Whole report | `globalFilters` / `setGlobalFilters` | shown values | The viewer can remove it. |
| One page | `pages[].filters` / `setPageFilters` | shown values | Fixed and invisible: for "let the user choose", add a `segmentador` widget. |
| One widget | `config.localFilters` | shown values | Operators `eq`, `neq`, `in`, `nin`, `gt`… |

- KPI breakdown slots (`config.valueConfig.breakdown`) use the other vocabulary: `equals`,
  `notEquals`, `notIn`. The tools reject a mix.
- `notIn` inside `localFilters` is unknown to the app and drops every row: use `nin`.
- `internalFilters` has no editor in the app: the script refuses it.

## The period

- `timeRange` is the period bar: `{mode: "preset", presetKey, dateField}` or
  `{mode: "custom", startDate, endDate, dateField}`. Presets: `today`, `yesterday`,
  `last_7_days`, `last_30_days`, `last_90_days`, `last_3_months`, `last_6_months`,
  `last_12_months`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`,
  `last_year`.
- `this_month`, `this_quarter` and `this_year` end today: deals that close later this month
  are left out. A report saved without `timeRange` shows all records; a dashboard without
  one opens on the last 30 days. A dashboard applies its period to each report through that
  report's own date field, and the tools warn when the two disagree.
- A period for some cards only goes in their `config.localFilters` (date with `dateRange`).

## Layout

96 columns, rows of 10 px. Start at x 1, y 2; usable width 94; gap 2.

| Widget | Size |
| --- | --- |
| KPI | h 9–14; 3 in a row w 30 (x 1, 33, 65); 4 in a row w 22 (x 1, 25, 49, 73) |
| Column, bar, line | w 46 or 94, h 24–35 |
| Table | w 94, h 34 |
| Pie, donut | w ≤ 46, h 46 |
| Segmentador (slicer) | w 16, h 21 |
| Live page on a dashboard | w 94, h 54 |

The tools reject a KPI taller than 14 and warn about bands of different heights, rows that
leave space, and overlaps.

## Sharing

- New reports and dashboards are private to the key's user.
- A collaborator can view, edit **and delete**. View only for the whole account is
  `allowEveryone: {view: true}` (with `shareWithEveryoneIsIntentional: true` for edit).
- `shareReport` changes only the main report, not its support reports: a collaborator then
  sees cross-dataset figures as 0. Sharing a dashboard does not share its reports.

## Deleting

- Nothing cascades. Deleting a report leaves its pages, widgets, support reports and the
  dashboards' live pages behind; the tools have no delete operation for reports or
  dashboards. Deleting is done by the user in the app; this skill does not delete reports or
  dashboards.
- `removePage` / `removeWidget` on a report delete those records, but dashboards that show the
  page keep a `livePage` widget pointing to nothing (an empty box). Check with
  `diagnose <domain> dashboard …` and fix with `removeWidget` or a new `pinPage`.
- `removeWidget` on a dashboard deletes the widget record only when no page or other
  dashboard lists it.

## Chart types

The editor offers: `column`, `bar`, `stackedColumn`, `stackedBar`, `100StackedColumn`,
`100StackedBar`, `line`, `smoothLine`, `area`, `stackedArea`, `pie`, `donut`, `kpi-card`,
`lineBar`, `table`, `scatter`, `bubble`, `heatmap`, `treemap`, `sunburst`, `radar`, `funnel`,
`funnelHorizontal`, `waterfall`, `bulletBar`, `geoMap`, `segmentador`, `textbox`, `image`.
`gauge`, `insightCard`, `boxplot` and `matrix` render but cannot be chosen in the editor:
the script refuses them. An unknown type draws columns without an error; the tools reject it.

## Diagnosing "zeros", "--" and empty boxes

`diagnose` runs the platform's check on the existing report (`editReport` dry run with no
operations: `preexistingIssues`, `warnings`) and checks what that misses: pages, widgets and
support reports that no longer exist, and dashboard widgets whose report or page is gone.
Then, by symptom:

- "--" on a KPI: `aggregation` is not `"measure"` on a measure.
- 0 % attainment for everyone: the goals do not cover the people who sell in the period
  (the tools say it in `attention`). The data must be loaded; do not hide it.
- A figure right in the report and empty on a dashboard: a widget pinned alone from a report
  with datasets. Pin the page.
- Figures differ between report and dashboard: their periods or date fields differ.
- Only 10 bars: the default `topN: 10`.
