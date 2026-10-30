#!/usr/bin/env node
'use strict';

// Builds and changes Prolibu reports (the app's BI dashboards: pages of widgets) and
// dashboards (canvases that bring pages and widgets of several reports together) through the
// platform's own report tools, the ones the app's AI assistant uses. Those tools validate the
// resulting report on the server and write nothing when it does not check out; the plain
// REST API accepts the same broken configurations with a 201 and the page only fails when it
// renders. Reads go through the REST API.
//
//   dashboard.js status     <domain>
//   dashboard.js reports    <domain> [text]
//   dashboard.js dashboards <domain> [text]
//   dashboard.js show       <domain> report|dashboard <id or code>
//   dashboard.js fields     <domain> <Model>
//   dashboard.js schema     <domain> <tool> [argument]
//   dashboard.js diagnose   <domain> report|dashboard <id or code>
//   dashboard.js preview    <domain> '<plan json>'
//   dashboard.js apply      <domain> '<plan json>' --version <v> --confirmed [--allow-sharing] [--allow-removal]
//
// Plan: {"tool": "buildReport" | "editReport" | "buildDashboard" | "editDashboard", "args": {…}}
// The plan is inline JSON, or the path of a JSON file in a temp folder.
// Every command accepts --profile <name>.
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const crypto = require('crypto');
const fs = require('fs');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const MCP_PATH = '/v2/mcpsession/ses';
const TOOLS = ['buildReport', 'editReport', 'buildDashboard', 'editDashboard'];
const ID_RE = /^[a-f0-9]{24}$/i;
const BLOCKED = 3;

// Arguments that belong to the in-app chat (an editor open in the browser) or to the script.
const RESERVED_ARGS = {
  buildReport: ['dryRun', 'progressive', 'reportId'],
  editReport: ['dryRun', 'target'],
  buildDashboard: ['dryRun'],
  editDashboard: ['dryRun'],
};
const CANVAS_ONLY_OPS = ['undo', 'activatePage'];
// They render, but the app's chart picker hides them: whoever owns the report could not pick
// them again. Nothing goes through the CLI that the app cannot do.
const HIDDEN_CHART_TYPES = ['gauge', 'insightCard', 'boxplot', 'matrix'];
const REMOVAL_OPS = { editReport: ['removeWidget', 'removePage'], editDashboard: ['removeWidget'] };

class Blocked extends Error {}

class ApiError extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => ({ ...out, [key]: canonical(value[key]) }), {});
  }
  return value;
}

function versionOf(plan, stamp) {
  const text = `${JSON.stringify(canonical(plan))}|${stamp}`;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// The MCP endpoint answers JSON-RPC either as JSON or as one server-sent event.
function parseRpc(body) {
  if (body && typeof body === 'object') return body;
  const text = String(body || '');
  const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new ApiError(`The report tools answered something unexpected: ${text.slice(0, 200)}`);
  return JSON.parse(data[data.length - 1]);
}

function parseToolText(result) {
  const text = ((result && result.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the plan file ${arg}.`);
    }
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  return checkPlan(plan);
}

// Refuses what this script must never send, and says what the plan touches.
function checkPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  const { tool, args } = plan;
  if (!TOOLS.includes(tool)) {
    throw new UsageError(`"tool" must be one of ${TOOLS.join(', ')}. Other changes go through their own skill.`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new UsageError('The plan needs "args", an object.');
  const extra = Object.keys(plan).filter((k) => k !== 'tool' && k !== 'args');
  if (extra.length) throw new UsageError(`Unknown plan keys: ${extra.join(', ')}. Put the tool's arguments inside "args".`);
  for (const key of RESERVED_ARGS[tool]) {
    if (key in args) {
      throw new UsageError(`"${key}" is not allowed in args: ${key === 'dryRun' ? 'preview and apply set it' : 'it is for the in-app editor, not for the CLI'}.`);
    }
  }
  if (tool === 'editReport' && !ID_RE.test(String(args.reportId))) throw new UsageError('editReport needs "reportId" (the report _id; show resolves a code).');
  if (tool === 'editDashboard' && !args.dashboardId) throw new UsageError('editDashboard needs "dashboardId" (_id or dashboardCode).');
  const operations = tool.startsWith('edit') ? args.operations : [];
  if (tool.startsWith('edit') && (!Array.isArray(operations) || !operations.length)) {
    throw new UsageError(`${tool} needs a non-empty "operations" list. To read the current state use show or diagnose.`);
  }
  const ops = operations.map((o) => o && o.op);
  const canvasOnly = ops.filter((op) => CANVAS_ONLY_OPS.includes(op));
  if (canvasOnly.length) throw new UsageError(`"${canvasOnly[0]}" only works with the editor open in the browser.`);
  const hidden = chartTypesOf(tool, args).filter((t) => HIDDEN_CHART_TYPES.includes(t));
  if (hidden.length) throw new UsageError(`"${hidden[0]}" cannot be chosen in the app's editor, so its owner could not change it back. Use another chart type.`);
  if (widgetsOf(tool, args).some((w) => w && w.config && 'internalFilters' in w.config)) {
    throw new UsageError('"internalFilters" has no editor in the app. Filter the widget with config.localFilters (operators eq, neq, in, nin…).');
  }
  const removals = operations.filter((o) => (REMOVAL_OPS[tool] || []).includes(o && o.op))
    .map((o) => ({ op: o.op, widgetId: o.widgetId, widgetTitle: o.widgetTitle, pageId: o.pageId }));
  return { plan: { tool, args }, sharing: sharingOf(tool, args), removals };
}

function widgetsOf(tool, args) {
  const widgets = [];
  if (tool === 'buildReport') (args.pages || []).forEach((p) => widgets.push(...((p && p.widgets) || [])));
  if (tool === 'buildDashboard') widgets.push(...(args.widgets || []));
  for (const o of args.operations || []) {
    if (o && o.widget) widgets.push(o.widget);
    if (o && o.op === 'updateWidget' && o.patch) widgets.push(o.patch);
  }
  return widgets.filter((w) => w && typeof w === 'object');
}

function chartTypesOf(tool, args) {
  return widgetsOf(tool, args).map((w) => w.chartType).filter(Boolean);
}

// Sharing grants other people view, edit and delete rights: it needs its own yes.
function sharingOf(tool, args) {
  const out = [];
  const opens = (ae) => ae && (ae.view || ae.edit);
  if (tool === 'buildReport' || tool === 'buildDashboard') {
    if (Array.isArray(args.collaborators) && args.collaborators.length) out.push({ collaborators: args.collaborators });
    if (opens(args.allowEveryone)) out.push({ allowEveryone: args.allowEveryone });
  }
  for (const o of args.operations || []) {
    if (!o) continue;
    if (o.op === 'shareReport') out.push({ op: 'shareReport', ...o });
    const patch = o.op === 'updateDashboard' && o.patch ? o.patch : null;
    if (patch && ('collaborators' in patch || 'allowEveryone' in patch)) out.push({ op: 'updateDashboard', patch });
  }
  return out;
}

// ─── API ───────────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new ApiError(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

function query(params) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString();
}

// The helper sends `Accept: application/json`; the MCP transport answers 406 unless the
// client also accepts server-sent events.
function mcpFetch(fetchImpl) {
  return (url, init) => {
    if (String(url).includes(MCP_PATH)) init.headers = { ...init.headers, Accept: 'application/json, text/event-stream' };
    return fetchImpl(url, init);
  };
}

// One stateless JSON-RPC `tools/call`. No `initialize`: the server needs none and records an
// McpSession only on `initialize`. `confirmed` is passed because the helper treats every POST
// as a write; whether this call writes is decided by `dryRun`, which the callers set.
async function callTool(client, name, args) {
  const res = await client.request('POST', MCP_PATH, {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    confirmed: true,
  });
  if (res.status === 403) {
    throw new Blocked('The report tools are turned off on this account (Settings › Integrations › MCP). An admin must turn them on in the app; this skill never changes account settings.');
  }
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : {};
    const message = typeof body.error === 'string' ? body.error : (body.error && body.error.message);
    throw new ApiError(`The report tools answered ${res.status}: ${message || 'no message'}`);
  }
  const rpc = parseRpc(res.body);
  if (rpc.error) throw new ApiError(`The report tools refused the call: ${rpc.error.message}`);
  const result = rpc.result || {};
  const parsed = parseToolText(result);
  return { isError: Boolean(result.isError), ...parsed };
}

async function mcpEnabled(client) {
  const prefs = await call(client, 'GET', '/v2/user/preferences');
  return Boolean(prefs && prefs.integrations && prefs.integrations.mcp && prefs.integrations.mcp.enabled);
}

// ─── Reads ─────────────────────────────────────────────────────────────────────

const suiteUrl = (domain, path) => `https://${domain}/ui/spa/suite/${path}`;

async function getReport(client, ref) {
  return call(client, 'GET', `/v2/report/${encodeURIComponent(ref)}`);
}

async function getDashboard(client, ref) {
  return call(client, 'GET', `/v2/dashboard/${encodeURIComponent(ref)}`);
}

async function listByIds(client, object, ids, select) {
  if (!ids.length) return [];
  const body = await call(client, 'GET', `/v2/${object}?${query({ xquery: { _id: { $in: ids } }, select, limit: '500' })}`);
  return body.data || [];
}

async function widgetsOfReport(client, reportId, select) {
  const body = await call(client, 'GET', `/v2/widget?${query({ xquery: { reportId }, select, limit: '500', sort: '_id' })}`);
  return body.data || [];
}

function widgetSummary(w) {
  const out = { widgetId: w._id, title: w.title, chartType: w.chartType };
  if (w.chartType !== 'livePage') {
    for (const key of ['yField', 'aggregation', 'groupByField', 'legendField', 'topN']) if (w[key] !== undefined && w[key] !== null) out[key] = w[key];
  }
  if (w.layout) out.layout = [w.layout.x, w.layout.y, w.layout.w, w.layout.h].join(',');
  return out;
}

function timeRangeOf(settingsHolder) {
  const range = settingsHolder && settingsHolder.savedTimeRange;
  if (!range || !range.active) return null;
  return range.mode === 'custom'
    ? { mode: 'custom', startDate: range.startDate, endDate: range.endDate, dateField: range.dateField }
    : { mode: 'preset', presetKey: range.presetKey, dateField: range.dateField };
}

async function describeReport(client, report) {
  const config = report.config || {};
  const pages = await listByIds(client, 'page', report.pages || [], 'pageTitle widgets');
  const widgets = await widgetsOfReport(client, report._id, 'title chartType yField aggregation groupByField legendField topN layout');
  const byId = new Map(widgets.map((w) => [String(w._id), w]));
  const pageById = new Map(pages.map((p) => [String(p._id), p]));
  const datasets = config.additionalDatasets || [];
  const supports = await listByIds(client, 'report', datasets.map((d) => d.reportId).filter(Boolean), 'reportName entity');
  const supportById = new Map(supports.map((r) => [String(r._id), r]));
  return {
    kind: 'report',
    reportId: report._id,
    reportCode: report.reportCode,
    reportName: report.reportName,
    entity: report.useExternalData ? 'External' : report.entity,
    createdBy: report.createdBy,
    shared: { collaborators: (report.collaborators || []).length, allowEveryone: report.allowEveryone || null },
    timeRange: timeRangeOf(config.settings && config.settings.savedFilters),
    pages: (report.pages || []).map((id) => {
      const page = pageById.get(String(id));
      if (!page) return { pageId: id, missing: true };
      return {
        pageId: page._id,
        title: page.pageTitle,
        widgets: (page.widgets || []).map((wid) => (byId.has(String(wid)) ? widgetSummary(byId.get(String(wid))) : { widgetId: wid, missing: true })),
      };
    }),
    datasets: datasets.map((d) => ({
      id: d.id,
      label: d.label,
      reportId: d.reportId,
      entity: supportById.has(String(d.reportId)) ? supportById.get(String(d.reportId)).entity : null,
      missing: !supportById.has(String(d.reportId)),
      cohortDateField: d.cohortDateField,
    })),
    relationships: (config.relationships || []).map((r) => ({
      from: `${r.from && r.from.datasetId ? r.from.datasetId : 'main'}.${r.from && r.from.field}`,
      to: `${r.to && r.to.datasetId}.${r.to && r.to.field}`,
      cardinality: r.cardinality,
      enabled: r.enabled !== false,
    })),
    measures: (report.measures || []).map((m) => ({ id: m.id, label: m.label, expression: m.expression, dataType: m.dataType })),
    urls: {
      view: suiteUrl(client.domain, `reports/view/${report.reportCode}`),
      // The tools answer `reports/edit/<id>`, which is the list's record form, not the editor.
      edit: suiteUrl(client.domain, `reports/editor/${report._id}`),
    },
    updatedAt: report.updatedAt,
  };
}

async function describeDashboard(client, dashboard) {
  const widgets = await listByIds(client, 'widget', dashboard.widgets || [], 'title chartType reportId config layout yField aggregation groupByField');
  const byId = new Map(widgets.map((w) => [String(w._id), w]));
  const settings = (dashboard.layoutConfig || []).find((item) => item && item._type === 'dashboardSettings');
  return {
    kind: 'dashboard',
    dashboardId: dashboard._id,
    dashboardCode: dashboard.dashboardCode,
    dashboardName: dashboard.dashboardName,
    createdBy: dashboard.createdBy,
    shared: { collaborators: (dashboard.collaborators || []).length, allowEveryone: dashboard.allowEveryone || null },
    timeRange: timeRangeOf(settings),
    widgets: (dashboard.widgets || []).map((id) => {
      const w = byId.get(String(id));
      if (!w) return { widgetId: id, missing: true };
      const c = w.config || {};
      const out = widgetSummary(w);
      if (w.chartType === 'livePage') {
        out.livePage = { reportId: c.sourceReportId || w.reportId, reportName: c.sourceReportName, pageId: c.sourcePageId };
      } else if (w.reportId) {
        out.reportId = w.reportId;
      }
      return out;
    }),
    urls: { view: suiteUrl(client.domain, `dashboards/view/${dashboard.dashboardCode}`) },
    updatedAt: dashboard.updatedAt,
  };
}

// A stamp of everything a change could touch, so apply can tell whether it moved.
async function reportStamp(client, reportId) {
  const report = await getReport(client, reportId);
  const pages = await listByIds(client, 'page', report.pages || [], 'updatedAt');
  const widgets = await widgetsOfReport(client, report._id, 'updatedAt');
  const supportIds = ((report.config && report.config.additionalDatasets) || []).map((d) => d.reportId).filter(Boolean);
  const supports = await listByIds(client, 'report', supportIds, 'updatedAt');
  return [report, ...pages, ...widgets, ...supports].map((d) => `${d._id}@${d.updatedAt}`).sort().join(',');
}

async function dashboardStamp(client, dashboardId) {
  const dashboard = await getDashboard(client, dashboardId);
  const widgets = await listByIds(client, 'widget', dashboard.widgets || [], 'updatedAt');
  return [dashboard, ...widgets].map((d) => `${d._id}@${d.updatedAt}`).sort().join(',');
}

async function stampFor(client, plan) {
  if (plan.tool === 'editReport') return reportStamp(client, plan.args.reportId);
  if (plan.tool === 'editDashboard') return dashboardStamp(client, plan.args.dashboardId);
  return 'new';
}

// What a dashboard preview cannot see: the app's viewer merges the measures of every report on
// a dashboard by id (the first one wins), and a single pinned widget loses its report's
// datasets, so a cross-dataset figure shows empty.
async function dashboardWarnings(client, plan) {
  if (!plan.tool.endsWith('Dashboard')) return [];
  const { args } = plan;
  const reportIds = new Set();
  const pinnedWidgetIds = [];
  const addRef = (o) => {
    if (o.reportId) reportIds.add(String(o.reportId));
    if (o.widgetId && (o.op === 'pinWidget' || !o.op)) pinnedWidgetIds.push(String(o.widgetId));
  };
  (args.livePages || []).forEach(addRef);
  (args.widgets || []).forEach(addRef);
  (args.pinnedWidgets || []).forEach(addRef);
  (args.operations || []).filter((o) => o && ['pinPage', 'pinWidget'].includes(o.op)).forEach(addRef);
  (args.operations || []).filter((o) => o && o.op === 'addWidget' && o.widget).forEach((o) => addRef(o.widget));
  const pinned = await listByIds(client, 'widget', pinnedWidgetIds, 'title reportId');
  pinned.forEach((w) => w.reportId && reportIds.add(String(w.reportId)));
  if (plan.tool === 'editDashboard') {
    const current = await getDashboard(client, args.dashboardId);
    const widgets = await listByIds(client, 'widget', current.widgets || [], 'reportId config');
    widgets.forEach((w) => {
      const id = (w.config && w.config.sourceReportId) || w.reportId;
      if (id) reportIds.add(String(id));
    });
  }
  const reports = await listByIds(client, 'report', [...reportIds], 'reportName measures config.additionalDatasets');
  const warnings = [];
  const seen = new Map();
  for (const r of reports) {
    for (const m of r.measures || []) {
      const prior = seen.get(m.id);
      if (prior && prior.expression !== m.expression) {
        warnings.push(`Measure id "${m.id}" means different things in "${prior.report}" and "${r.reportName}": on one dashboard the app uses only one of them, so a figure can be wrong. Rename it in one report (editReport updateReport) first.`);
      } else if (!prior) seen.set(m.id, { report: r.reportName, expression: m.expression });
    }
  }
  const byId = new Map(reports.map((r) => [String(r._id), r]));
  for (const w of pinned) {
    const source = byId.get(String(w.reportId));
    if (source && ((source.config && source.config.additionalDatasets) || []).length) {
      warnings.push(`"${w.title}" comes from "${source.reportName}", which joins other datasets: a single pinned widget loses them, and a figure that crosses them shows empty. Pin the whole page instead.`);
    }
  }
  return warnings;
}

async function ownerWarning(client, plan) {
  if (!plan.tool.startsWith('edit')) return null;
  const me = await call(client, 'GET', '/v2/user/me?select=profile');
  const myId = me && me.profile && me.profile._id;
  const target = plan.tool === 'editReport' ? await getReport(client, plan.args.reportId) : await getDashboard(client, plan.args.dashboardId);
  if (target.createdBy && myId && String(target.createdBy) !== String(myId)) {
    return 'This was created by another user: everyone who uses it will see the change.';
  }
  return null;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus(client) {
  const enabled = await mcpEnabled(client);
  const me = await call(client, 'GET', '/v2/user/me?select=profile');
  const p = (me && me.profile) || {};
  return {
    domain: client.domain,
    user: { _id: p._id, name: [p.firstName, p.lastName].filter(Boolean).join(' '), isAdmin: Boolean(p.isAdmin) },
    reportToolsEnabled: enabled,
    nextStep: enabled
      ? 'Ready.'
      : 'The report tools are off on this account. Tell the user an admin must turn on the MCP integration in the app; reads still work, writes do not.',
  };
}

async function cmdList(client, object, [text], nameField, codeField) {
  const params = { select: `${nameField} ${codeField} createdBy updatedAt${object === 'report' ? ' entity pages config.additionalDatasets' : ' widgets'}`, sort: '-updatedAt', limit: '25' };
  if (text) params.xquery = { [nameField]: { $regex: `(?i)${String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } };
  const body = await call(client, 'GET', `/v2/${object}?${query(params)}`);
  const rows = (body.data || []).map((r) => ({
    _id: r._id,
    name: r[nameField],
    code: r[codeField],
    ...(object === 'report'
      ? { entity: r.entity, pages: (r.pages || []).length, datasets: ((r.config && r.config.additionalDatasets) || []).length }
      : { widgets: (r.widgets || []).length }),
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
  }));
  return { count: body.pagination ? body.pagination.count : rows.length, [`${object}s`]: rows };
}

async function cmdShow(client, [kind, ref]) {
  if (!['report', 'dashboard'].includes(kind) || !ref) throw new UsageError('Usage: show <domain> report|dashboard <id or code>');
  return kind === 'report' ? describeReport(client, await getReport(client, ref)) : describeDashboard(client, await getDashboard(client, ref));
}

async function cmdFields(client, [model]) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(model || ''))) throw new UsageError('Usage: fields <domain> <Model> (for example Deal, Task, Goal)');
  const out = await callTool(client, 'describeModel', { modelName: model });
  if (out.isError || !out.attrs) throw new ApiError(`No model "${model}" on this account (${out.message || 'not found'}).`);
  const fields = [];
  const walk = (attrs, prefix) => {
    for (const [name, def] of Object.entries(attrs)) {
      if (!def || typeof def !== 'object' || def.hidden) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (!def._type && !def.type) {
        walk(def, path);
        continue;
      }
      const field = { path, type: def._type || String(def.type) };
      if (def.ref) field.ref = def.ref;
      if (def.enum) field.values = def.enum.slice(0, 20);
      if (def.stageValues) field.stages = def.stageValues.map((s) => ({ stageCode: s.stageCode, stageName: s.stageName, final: Boolean(s.endFlowStage) }));
      fields.push(field);
    }
  };
  walk(out.attrs, '');
  return { model, fields };
}

// The tools' arguments change often: read them live instead of trusting a copy. The catalog is
// public and the same one the app's developer docs render.
async function cmdSchema(client, [toolName, arg]) {
  if (!TOOLS.includes(toolName)) throw new UsageError(`Usage: schema <domain> <${TOOLS.join('|')}> [argument]`);
  const meta = await call(client, 'GET', '/v2/mcpsession/metadata');
  const found = ((meta && meta.tools) || []).find((t) => t.name === toolName);
  if (!found) throw new ApiError(`${toolName} is not in this account's tool catalog.`);
  const props = (found.inputSchema && found.inputSchema.properties) || {};
  if (arg) {
    if (!props[arg]) throw new UsageError(`${toolName} has no argument "${arg}". Arguments: ${Object.keys(props).join(', ')}.`);
    return { tool: toolName, argument: arg, schema: props[arg], note: 'Written for the app\'s assistant: preview and the user\'s yes still come first.' };
  }
  return {
    tool: toolName,
    note: 'This text is written for the app\'s assistant, which writes directly. Use its rules about the platform, but in the CLI nothing is written before preview and the user\'s yes.',
    description: found.description,
    required: (found.inputSchema && found.inputSchema.required) || [],
    arguments: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v.description || v.type || '').split('\n')[0].slice(0, 300)])),
  };
}

async function cmdDiagnose(client, [kind, ref]) {
  if (!['report', 'dashboard'].includes(kind) || !ref) throw new UsageError('Usage: diagnose <domain> report|dashboard <id or code>');
  if (kind === 'report') {
    const report = await getReport(client, ref);
    const shape = await describeReport(client, report);
    const problems = [];
    shape.pages.filter((p) => p.missing).forEach((p) => problems.push(`Page ${p.pageId} is listed in the report but no longer exists.`));
    shape.pages.forEach((p) => (p.widgets || []).filter((w) => w.missing).forEach((w) => problems.push(`Page "${p.title}" lists widget ${w.widgetId}, which no longer exists.`)));
    shape.datasets.filter((d) => d.missing).forEach((d) => problems.push(`Dataset "${d.label}" points to a support report that no longer exists.`));
    const checked = await callTool(client, 'editReport', { reportId: report._id, operations: [], dryRun: true });
    return {
      report: { reportId: shape.reportId, reportName: shape.reportName, entity: shape.entity, timeRange: shape.timeRange, urls: shape.urls },
      problems,
      platformIssues: checked.preexistingIssues || [],
      platformWarnings: checked.warnings || [],
      ...(checked.isError ? { platformError: checked.message } : {}),
    };
  }
  const dashboard = await getDashboard(client, ref);
  const shape = await describeDashboard(client, dashboard);
  const problems = [];
  shape.widgets.filter((w) => w.missing).forEach((w) => problems.push(`Widget ${w.widgetId} is listed in the dashboard but no longer exists.`));
  const live = shape.widgets.filter((w) => w.livePage);
  const reportIds = [...new Set([...live.map((w) => w.livePage.reportId), ...shape.widgets.map((w) => w.reportId)].filter(Boolean).map(String))];
  const reports = await listByIds(client, 'report', reportIds, 'reportName pages');
  const reportById = new Map(reports.map((r) => [String(r._id), r]));
  for (const w of shape.widgets) {
    const sourceId = w.livePage ? w.livePage.reportId : w.reportId;
    if (!sourceId) continue;
    const source = reportById.get(String(sourceId));
    if (!source) {
      problems.push(`"${w.title}" reads report ${sourceId}, which no longer exists (or this user cannot see it).`);
    } else if (w.livePage && !(source.pages || []).map(String).includes(String(w.livePage.pageId))) {
      problems.push(`"${w.title}" shows page ${w.livePage.pageId} of "${source.reportName}", which is no longer in that report.`);
    }
  }
  return { dashboard: { dashboardId: shape.dashboardId, dashboardName: shape.dashboardName, timeRange: shape.timeRange, urls: shape.urls }, widgets: shape.widgets, problems };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const { plan, sharing, removals } = readPlan(planArg, ctx.rootDir);
  if (!(await mcpEnabled(client))) throw new Blocked('The report tools are turned off on this account. An admin must turn on the MCP integration in the app; this skill never changes account settings.');
  const stamp = await stampFor(client, plan);
  const warning = await ownerWarning(client, plan);
  const ownWarnings = await dashboardWarnings(client, plan);
  const checked = await callTool(client, plan.tool, { ...plan.args, dryRun: true });
  const errors = [...(checked.errors || []), ...(checked.problems || [])];
  if (checked.isError && !errors.length) errors.push(checked.message);
  const valid = !checked.isError && checked.ok !== false && checked.created !== true && errors.length === 0;
  return {
    valid,
    tool: plan.tool,
    message: checked.message,
    errors,
    warnings: [...(warning ? [warning] : []), ...ownWarnings, ...(checked.warnings || []).map((w) => (typeof w === 'string' ? w : `${w.where ? `${w.where}: ` : ''}${w.message}`))],
    ...(checked.preexistingIssues && checked.preexistingIssues.length ? { preexistingIssues: checked.preexistingIssues } : {}),
    ...(checked.applied && checked.applied.length ? { wouldApply: checked.applied } : {}),
    sharing,
    removals,
    version: valid ? versionOf(plan, stamp) : null,
    nextStep: valid
      ? `STOP HERE and end your turn: tell the user in plain words what will be ${plan.tool.startsWith('build') ? 'created' : 'changed'}${sharing.length ? ', who gets access' : ''}${removals.length ? ', what is removed' : ''}, and the warnings that matter, and ask for a yes. Never apply in the same turn as its preview, whatever the account or the request. After their yes, run apply with the same plan and this version.${plan.tool === 'buildReport' ? ' Empty-period and empty-field checks only run on the real write: read `attention` after apply.' : ''}`
      : 'Nothing was written. Fix the plan from the errors (they are written for you, not for the user) and preview again; ask the user only about decisions.',
    blockers: valid ? [] : errors,
  };
}

async function readBack(client, plan, result) {
  const problems = [];
  if (plan.tool === 'buildReport') {
    const shape = await describeReport(client, await getReport(client, result.reportId));
    const widgetCount = shape.pages.reduce((n, p) => n + (p.widgets || []).filter((w) => !w.missing).length, 0);
    if (result.counts && widgetCount !== result.counts.widgets) problems.push(`The tool reported ${result.counts.widgets} widgets; the pages hold ${widgetCount}.`);
    if (result.counts && shape.pages.length !== result.counts.pages) problems.push(`The tool reported ${result.counts.pages} pages; the report has ${shape.pages.length}.`);
    shape.datasets.filter((d) => d.missing).forEach((d) => problems.push(`Dataset "${d.label}" has no support report.`));
    return { record: shape, problems };
  }
  if (plan.tool === 'buildDashboard') {
    const id = result.dashboardId || result._id;
    const shape = await describeDashboard(client, await getDashboard(client, id));
    const asked = ['widgets', 'livePages', 'pinnedWidgets', 'texts', 'images'].reduce((n, k) => n + ((plan.args[k] || []).length), 0);
    if (shape.widgets.length !== asked) problems.push(`The plan asked for ${asked} items; the dashboard holds ${shape.widgets.length}.`);
    shape.widgets.filter((w) => w.missing).forEach((w) => problems.push(`Widget ${w.widgetId} is listed but does not exist.`));
    return { record: shape, problems };
  }
  if (plan.tool === 'editReport') {
    const shape = await describeReport(client, await getReport(client, plan.args.reportId));
    shape.pages.filter((p) => p.missing).forEach((p) => problems.push(`Page ${p.pageId} is listed but does not exist.`));
    return { record: shape, problems };
  }
  const shape = await describeDashboard(client, await getDashboard(client, plan.args.dashboardId));
  shape.widgets.filter((w) => w.missing).forEach((w) => problems.push(`Widget ${w.widgetId} is listed but does not exist.`));
  return { record: shape, problems };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const { plan, sharing, removals } = readPlan(planArg, ctx.rootDir);
  if (sharing.length && !flags.allowSharing) throw new Blocked('The plan shares access with other people. Ask the user about the sharing on its own, then add --allow-sharing.');
  if (removals.length && !flags.allowRemoval) throw new Blocked('The plan removes widgets or pages. Ask the user about the removal on its own, then add --allow-removal.');
  const stamp = await stampFor(client, plan);
  if (versionOf(plan, stamp) !== flags.version) throw new Blocked('The plan or the record changed since the preview. Preview again and show the user the new result.');

  const result = await callTool(client, plan.tool, plan.args);
  if (result.error) {
    // Validation passed and the write failed part way: the tools do not roll back.
    throw new ApiError(`${result.error} ${result.hint || ''} Check what was saved with reports/dashboards and show before retrying.${result.orphaned ? ` Orphaned support reports: ${JSON.stringify(result.orphaned)}.` : ''}`);
  }
  const failed = result.isError || result.ok === false || (plan.tool.startsWith('build') && result.created !== true);
  if (failed) {
    const details = [...(result.errors || []), ...(result.problems || [])].map((e) => (typeof e === 'string' ? e : `${e.where ? `${e.where}: ` : ''}${e.message}`));
    throw new Blocked(`The platform rejected the change and wrote nothing. ${details.join(' | ') || result.message || ''}`);
  }
  const { record, problems } = await readBack(client, plan, result);
  return {
    saved: problems.length === 0,
    tool: plan.tool,
    record,
    warnings: (result.warnings || []).map((w) => (typeof w === 'string' ? w : `${w.where ? `${w.where}: ` : ''}${w.message}`)),
    ...(result.attention && result.attention.length ? { attention: result.attention } : {}),
    configured: result.configured,
    applied: result.applied,
    problems,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--allow-sharing') flags.allowSharing = true;
    else if (arg === '--allow-removal') flags.allowRemoval = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  status: cmdStatus,
  reports: (client, rest) => cmdList(client, 'report', rest, 'reportName', 'reportCode'),
  dashboards: (client, rest) => cmdList(client, 'dashboard', rest, 'dashboardName', 'dashboardCode'),
  show: cmdShow,
  fields: cmdFields,
  schema: cmdSchema,
  diagnose: cmdDiagnose,
  preview: cmdPreview,
  apply: cmdApply,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: dashboard.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    client = createClient({
      domain, rootDir, profile: flags.profile, fetchImpl: mcpFetch(opts.fetchImpl || globalThis.fetch), stderr,
    });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    return result.blockers && result.blockers.length ? BLOCKED : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, checkPlan, sharingOf, chartTypesOf, versionOf, parseRpc, canonical,
};
