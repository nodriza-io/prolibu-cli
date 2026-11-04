/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dashboard = require('../.claude/skills/prolibu-dashboards/scripts/dashboard');

const D = 'dev99.example.com';
const ME = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const REPORT = 'c'.repeat(24);
const PAGE = 'd'.repeat(24);
const W1 = 'e'.repeat(24);
const DASH = 'f'.repeat(24);
const LIVE = '1'.repeat(24);

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let state;
let seq;

const newId = () => {
  seq += 1;
  return String(seq).padStart(24, '9');
};

function respond(status, body, raw) {
  return { status, text: async () => (raw !== undefined ? raw : JSON.stringify(body)) };
}

// The MCP endpoint answers one server-sent event, as the live server does.
function sse(payload, isError) {
  const rpc = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) } };
  return respond(200, null, `event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
}

function byIds(collection, xquery) {
  const ids = (xquery._id && xquery._id.$in) || [];
  return ids.map((id) => collection[id]).filter(Boolean);
}

// Each report tool, shaped after its live answers on a test account (2026-10-30).
function tool(name, args) {
  state.toolCalls.push({ name, args });
  if (name === 'describeModel') {
    if (args.modelName === 'Deal') return sse({ modelName: 'Deal', attrs: { dealName: { type: 'String', _type: 'string' }, proposal: { sentAt: { type: 'Date', _type: 'date' } }, closeDate: { type: 'Date', _type: 'date' }, createdAt: { type: 'Date', _type: 'date' }, stage: { type: 'String', _type: 'stage' } } });
    if (args.modelName !== 'Goal') return sse('Model "Nope" not found', true);
    return sse({ modelName: 'Goal', attrs: { _id: { type: 'ObjectId', hidden: true }, assignee: { type: 'ObjectId', ref: 'User', _type: 'objectid' }, dates: { startAt: { type: 'Date', _type: 'date' } }, targetValue: { type: 'Number', _type: 'number' } } });
  }
  if (name === 'buildReport') {
    if (state.invalid) return sse({ created: false, message: 'Nothing was created.', errors: [{ where: 'widgets[0] "Negocios"', message: 'layout.h is too tall' }], warnings: [] });
    if (args.dryRun) return sse({ created: false, dryRun: true, message: 'The configuration is valid.', warnings: [{ where: 'widgets[0]', message: 'staggered band' }] });
    if (state.writeFails) return sse({ created: false, error: 'Validation passed but the write failed: E11000', hint: 'A half-written report may have been left behind; check it with find.' }, true);
    const reportId = newId();
    const pageId = newId();
    const widgetIds = args.pages[0].widgets.map(() => newId());
    args.pages[0].widgets.forEach((w, i) => { state.widgets[widgetIds[i]] = { _id: widgetIds[i], reportId, ...w, updatedAt: 'T1' }; });
    const kept = state.dropWidget ? widgetIds.slice(1) : widgetIds;
    state.pages[pageId] = { _id: pageId, pageTitle: args.pages[0].title, widgets: kept, updatedAt: 'T1' };
    state.reports[reportId] = { _id: reportId, reportCode: 'RPT-2', reportName: args.reportName, entity: args.entity, pages: [pageId], createdBy: ME, updatedAt: 'T1', config: {} };
    return sse({ created: true, reportId, pageIds: [pageId], widgetIds, counts: { widgets: widgetIds.length, pages: 1, datasets: 0 }, attention: ['There are no records in the period this_month.'], warnings: [] });
  }
  if (name === 'editReport') {
    if (state.invalid) return sse({ ok: false, message: 'Nothing was modified.', errors: [{ where: 'pages[1]', message: 'The page has no widgets.' }], warnings: [] }, true);
    if (args.dryRun) return sse({ ok: true, dryRun: true, message: 'The changes are valid.', applied: args.operations.map((o) => `(${o.op})`), preexistingIssues: state.issues || [], warnings: [] });
    for (const o of args.operations) {
      if (o.op === 'removeWidget') {
        const page = state.pages[PAGE];
        page.widgets = page.widgets.filter((id) => id !== o.widgetId);
        delete state.widgets[o.widgetId];
      }
    }
    state.reports[REPORT].updatedAt = 'T9';
    return sse({ ok: true, message: 'Applied.', applied: args.operations.map((o) => o.op), warnings: [] });
  }
  if (name === 'buildDashboard') {
    if (args.dryRun) return sse({ created: false, dryRun: true, message: 'The configuration is valid.', warnings: [] });
    const id = newId();
    const widgets = (args.livePages || []).map((lp) => {
      const wid = newId();
      state.widgets[wid] = { _id: wid, title: 'Ventas', chartType: 'livePage', reportId: lp.reportId, config: { sourceReportId: lp.reportId, sourcePageId: PAGE, sourceReportName: 'QA' }, updatedAt: 'T1' };
      return wid;
    });
    state.dashboards[id] = { _id: id, dashboardCode: 'dashboard2', dashboardName: args.dashboardName, widgets, layoutConfig: [], createdBy: ME, updatedAt: 'T1' };
    return sse({ created: true, dashboardId: id, dashboardCode: 'dashboard2', widgetIds: widgets });
  }
  if (name === 'editDashboard') {
    if (args.dryRun) return sse({ ok: true, dryRun: true, message: 'Valid.', warnings: [] });
    return sse({ ok: true, applied: args.operations.map((o) => o.op) });
  }
  return respond(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: `Tool ${name} not found` } });
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: q, body, accept: init.headers.Accept, auth: init.headers.Authorization });
  if (u.pathname === '/v2/mcpsession/ses') {
    if (!state.mcp) return respond(403, { error: 'MCP server is disabled by the administrator.' });
    if (!/text\/event-stream/.test(init.headers.Accept)) return respond(406, { jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable' } });
    return tool(body.params.name, body.params.arguments);
  }
  if (init.method !== 'GET') return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
  if (u.pathname === '/v2/mcpsession/metadata') {
    return respond(200, { tools: [{ name: 'buildDashboard', description: 'Builds a NEW DASHBOARD.', inputSchema: { required: ['dashboardName'], properties: { dashboardName: { type: 'string', description: 'Visible name' }, livePages: { type: 'array', items: { required: ['reportId'] } } } } }] });
  }
  if (u.pathname === '/v2/user/preferences') return respond(200, { integrations: { mcp: { enabled: state.mcp } } });
  if (u.pathname === '/v2/user/me') return respond(200, { profile: { _id: ME, firstName: 'Ana', isAdmin: true } });
  const one = u.pathname.match(/^\/v2\/(report|dashboard)\/([^/]+)$/);
  if (one) {
    const col = one[1] === 'report' ? state.reports : state.dashboards;
    const rec = col[one[2]] || Object.values(col).find((r) => r.reportCode === one[2] || r.dashboardCode === one[2]);
    return rec ? respond(200, rec) : respond(404, { statusCode: 404, error: 'Not found' });
  }
  if (u.pathname === '/v2/stage') {
    const xquery = JSON.parse(q.xquery);
    const data = xquery.stageCode === 'deal-stage-won' ? [{ _id: 'won', stageCode: 'deal-stage-won' }] : [];
    return respond(200, { pagination: { count: data.length }, data });
  }
  if (u.pathname === '/v2/deal') {
    const xquery = q.xquery ? JSON.parse(q.xquery) : {};
    let rows = state.deals.filter((d) => Object.entries(xquery).every(([k, v]) => (v === null ? d[k] == null : d[k] === v)));
    if (q.sort) {
      const key = q.sort.replace(/^-/, '');
      rows = rows.filter((d) => d[key] != null).sort((a, b) => (a[key] < b[key] ? 1 : -1));
    }
    return respond(200, { pagination: { count: rows.length }, data: rows.slice(0, Number(q.limit || 10)) });
  }
  const list = u.pathname.match(/^\/v2\/(report|page|widget|dashboard)$/);
  if (list) {
    const col = { report: state.reports, page: state.pages, widget: state.widgets, dashboard: state.dashboards }[list[1]];
    const xquery = q.xquery ? JSON.parse(q.xquery) : {};
    let data;
    if (xquery._id) data = byIds(col, xquery);
    else if (xquery.reportId) data = Object.values(col).filter((w) => w.reportId === xquery.reportId);
    else data = Object.values(col);
    return respond(200, { pagination: { count: data.length }, data });
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => dashboard.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const buildPlan = (extra = {}) => JSON.stringify({
  tool: 'buildReport',
  args: {
    reportName: 'QA Skills · ventas', entity: 'Deal', columns: ['_id', 'dealName'],
    pages: [{ title: 'Ventas', widgets: [{ title: 'Negocios', chartType: 'kpi-card', yField: '_count', aggregation: 'count', layout: { x: 1, y: 2, w: 30, h: 12 } }] }],
    ...extra,
  },
});

const removePlan = JSON.stringify({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'removeWidget', widgetId: W1, widgetTitle: 'Negocios' }] } });

async function previewVersion(plan) {
  out = '';
  expect(await run(['preview', D, plan])).toBe(0);
  const { version } = JSON.parse(out);
  out = '';
  return version;
}

const writes = () => state.toolCalls.filter((c) => c.name !== 'describeModel' && !c.args.dryRun);

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-dash-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-dash-plan-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  seq = 0;
  state = {
    deals: [],
    mcp: true,
    toolCalls: [],
    reports: {
      [REPORT]: { _id: REPORT, reportCode: 'RPT-1', reportName: 'QA Skills · ventas', entity: 'Deal', pages: [PAGE], createdBy: ME, updatedAt: 'T1', config: { additionalDatasets: [{ id: 'ds_metas', label: 'Metas', reportId: 'gone' }] } },
    },
    pages: { [PAGE]: { _id: PAGE, pageTitle: 'Ventas', widgets: [W1], updatedAt: 'T1' } },
    widgets: {
      [W1]: { _id: W1, reportId: REPORT, title: 'Negocios', chartType: 'kpi-card', yField: '_count', aggregation: 'count', updatedAt: 'T1' },
      [LIVE]: { _id: LIVE, title: 'Ventas', chartType: 'livePage', reportId: REPORT, config: { sourceReportId: REPORT, sourcePageId: 'old-page', sourceReportName: 'QA' }, updatedAt: 'T1' },
    },
    dashboards: { [DASH]: { _id: DASH, dashboardCode: 'dashboard1', dashboardName: 'QA Skills · tablero', widgets: [LIVE], layoutConfig: [{ _type: 'dashboardSettings', savedTimeRange: { active: true, mode: 'preset', presetKey: 'this_month', dateField: 'createdAt' } }], createdBy: OTHER, updatedAt: 'T1' } },
  };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkPlan', () => {
  test('only the four report tools are allowed', () => {
    expect(() => dashboard.checkPlan({ tool: 'delete', args: {} })).toThrow('must be one of');
    expect(() => dashboard.checkPlan({ tool: 'update', args: { model: 'Report' } })).toThrow('must be one of');
    expect(() => dashboard.checkPlan({ tool: 'buildReport' })).toThrow('"args"');
  });

  test('refuses what belongs to the in-app editor or to the script', () => {
    expect(() => dashboard.checkPlan({ tool: 'buildReport', args: { dryRun: false } })).toThrow('preview and apply set it');
    expect(() => dashboard.checkPlan({ tool: 'buildReport', args: { progressive: true } })).toThrow('in-app editor');
    expect(() => dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, target: 'canvas', operations: [{ op: 'addPage' }] } })).toThrow('in-app editor');
    expect(() => dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'undo' }] } })).toThrow('editor open');
    expect(() => dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'activatePage', page: 'Ventas' }] } })).toThrow('editor open');
  });

  test('refuses chart types the app editor cannot pick again', () => {
    const gauge = { title: 'G', chartType: 'gauge', layout: {} };
    expect(() => dashboard.checkPlan({ tool: 'buildReport', args: { pages: [{ title: 'P', widgets: [gauge] }] } })).toThrow('cannot be chosen');
    expect(() => dashboard.checkPlan({ tool: 'buildDashboard', args: { dashboardName: 'D', widgets: [{ ...gauge, chartType: 'matrix' }] } })).toThrow('cannot be chosen');
    expect(() => dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'updateWidget', widgetId: W1, patch: { chartType: 'insightCard' } }] } })).toThrow('cannot be chosen');
    expect(() => dashboard.checkPlan({ tool: 'editDashboard', args: { dashboardId: DASH, operations: [{ op: 'addWidget', widget: { ...gauge, chartType: 'boxplot' } }] } })).toThrow('cannot be chosen');
    expect(dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'updateWidget', widgetId: W1, patch: { chartType: 'bar' } }] } }).plan.tool).toBe('editReport');
  });

  test('refuses internalFilters, which the app cannot edit', () => {
    const kpi = { title: 'K', chartType: 'kpi-card', layout: {}, config: { internalFilters: { logic: 'AND', conditions: [] } } };
    expect(() => dashboard.checkPlan({ tool: 'buildReport', args: { pages: [{ title: 'P', widgets: [kpi] }] } })).toThrow('localFilters');
    expect(() => dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'updateWidget', widgetId: W1, patch: { config: { internalFilters: null } } }] } })).toThrow('localFilters');
  });

  test('edits need a target and at least one operation', () => {
    expect(() => dashboard.checkPlan({ tool: 'editReport', args: { reportId: 'RPT-1', operations: [{ op: 'addPage' }] } })).toThrow('_id');
    expect(() => dashboard.checkPlan({ tool: 'editDashboard', args: { dashboardId: DASH, operations: [] } })).toThrow('non-empty');
  });

  test('flags sharing and removals', () => {
    expect(dashboard.checkPlan(JSON.parse(buildPlan({ collaborators: [OTHER] }))).sharing).toHaveLength(1);
    expect(dashboard.checkPlan(JSON.parse(buildPlan({ allowEveryone: { view: false, edit: false } }))).sharing).toHaveLength(0);
    expect(dashboard.checkPlan({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'shareReport', private: true }] } }).sharing).toHaveLength(1);
    expect(dashboard.checkPlan({ tool: 'editDashboard', args: { dashboardId: DASH, operations: [{ op: 'updateDashboard', patch: { allowEveryone: { view: true } } }] } }).sharing).toHaveLength(1);
    expect(dashboard.checkPlan(JSON.parse(removePlan)).removals).toEqual([{ op: 'removeWidget', widgetId: W1, widgetTitle: 'Negocios', pageId: undefined }]);
  });
});

describe('versionOf', () => {
  test('changes with the plan and with the record, not with key order', () => {
    const a = { tool: 'buildReport', args: { a: 1, b: 2 } };
    expect(dashboard.versionOf(a, 'new')).toBe(dashboard.versionOf({ args: { b: 2, a: 1 }, tool: 'buildReport' }, 'new'));
    expect(dashboard.versionOf(a, 'new')).not.toBe(dashboard.versionOf({ tool: 'buildReport', args: { a: 1, b: 3 } }, 'new'));
    expect(dashboard.versionOf(a, 'x@T1')).not.toBe(dashboard.versionOf(a, 'x@T2'));
  });
});

describe('the report tools over HTTP', () => {
  test('preview sends a dry run, accepts server-sent events and never initializes a session', async () => {
    expect(await run(['preview', D, buildPlan()])).toBe(0);
    const mcp = calls.filter((c) => c.path === '/v2/mcpsession/ses');
    expect(mcp).toHaveLength(1);
    expect(mcp[0].accept).toContain('text/event-stream');
    expect(mcp[0].body).toMatchObject({ method: 'tools/call', params: { name: 'buildReport', arguments: { dryRun: true } } });
    expect(calls.some((c) => c.body && c.body.method === 'initialize')).toBe(false);
    expect(writes()).toHaveLength(0);
    const result = JSON.parse(out);
    expect(result).toMatchObject({ valid: true, tool: 'buildReport' });
    expect(result.version).toMatch(/^[0-9a-f]{16}$/);
    expect(result.warnings[0]).toContain('staggered band');
  });

  test('a configuration the platform rejects is blocked, with its errors and no version', async () => {
    state.invalid = true;
    expect(await run(['preview', D, buildPlan()])).toBe(3);
    const result = JSON.parse(out);
    expect(result.valid).toBe(false);
    expect(result.version).toBeNull();
    expect(result.errors[0].message).toContain('too tall');
  });

  test('an edit the platform rejects keeps its detailed errors', async () => {
    state.invalid = true;
    const plan = JSON.stringify({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'addPage', newPage: { title: 'X' } }] } });
    expect(await run(['preview', D, plan])).toBe(3);
    expect(JSON.parse(out).errors[0].message).toBe('The page has no widgets.');
  });

  test('with the report tools off, preview stops before calling them', async () => {
    state.mcp = false;
    expect(await run(['preview', D, buildPlan()])).toBe(3);
    expect(err).toContain('turned off');
    expect(calls.some((c) => c.path === '/v2/mcpsession/ses')).toBe(false);
    out = '';
    expect(await run(['status', D])).toBe(0);
    expect(JSON.parse(out).reportToolsEnabled).toBe(false);
  });

  test('the API key never reaches the output, even when a record echoes it', async () => {
    expect(await run(['preview', D, buildPlan()])).toBe(0);
    expect(calls[0].auth).toBe('Bearer SECRET123');
    state.reports[REPORT].reportName = 'leak SECRET123';
    out = '';
    expect(await run(['show', D, 'report', REPORT])).toBe(0);
    expect(out).toContain('leak ***');
    expect(out + err).not.toContain('SECRET123');
  });
});

describe('apply', () => {
  test('needs --version and --confirmed, and sends nothing without them', async () => {
    expect(await run(['apply', D, buildPlan(), '--confirmed'])).toBe(2);
    expect(await run(['apply', D, buildPlan(), '--version', 'abc'])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('builds after a preview and reads the report back', async () => {
    const version = await previewVersion(buildPlan());
    expect(await run(['apply', D, buildPlan(), '--version', version, '--confirmed'])).toBe(0);
    const result = JSON.parse(out);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].args.dryRun).toBeUndefined();
    expect(result.saved).toBe(true);
    expect(result.record.pages[0].widgets[0]).toMatchObject({ title: 'Negocios', chartType: 'kpi-card' });
    expect(result.record.urls.view).toBe(`https://${D}/ui/spa/suite/reports/view/RPT-2`);
  });

  test('passes on what the platform only checks on the real write', async () => {
    const version = await previewVersion(buildPlan());
    expect(await run(['apply', D, buildPlan(), '--version', version, '--confirmed'])).toBe(0);
    expect(JSON.parse(out).attention).toEqual(['There are no records in the period this_month.']);
  });

  test('a write that fails after validation is an API error, not "nothing written"', async () => {
    const version = await previewVersion(buildPlan());
    state.writeFails = true;
    expect(await run(['apply', D, buildPlan(), '--version', version, '--confirmed'])).toBe(1);
    expect(err).toContain('half-written');
    expect(err).not.toContain('BLOCKED');
  });

  test('a different plan than the one previewed is blocked', async () => {
    const version = await previewVersion(buildPlan());
    expect(await run(['apply', D, buildPlan({ reportName: 'QA Skills · otro' }), '--version', version, '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('an edit is blocked when the report changed after the preview', async () => {
    const plan = JSON.stringify({ tool: 'editReport', args: { reportId: REPORT, operations: [{ op: 'addPage', newPage: { title: 'Actividades' } }] } });
    const version = await previewVersion(plan);
    state.widgets[W1].updatedAt = 'T2';
    expect(await run(['apply', D, plan, '--version', version, '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(writes()).toHaveLength(0);
  });

  test('removals and sharing need their own flag', async () => {
    const version = await previewVersion(removePlan);
    expect(await run(['apply', D, removePlan, '--version', version, '--confirmed'])).toBe(3);
    expect(err).toContain('--allow-removal');
    expect(writes()).toHaveLength(0);
    expect(await run(['apply', D, removePlan, '--version', version, '--confirmed', '--allow-removal'])).toBe(0);
    expect(state.pages[PAGE].widgets).toEqual([]);
    const shared = buildPlan({ collaborators: [OTHER] });
    const v2 = await previewVersion(shared);
    expect(await run(['apply', D, shared, '--version', v2, '--confirmed'])).toBe(3);
    expect(err).toContain('--allow-sharing');
  });

  test('a read-back that does not match what the tool reported fails the apply', async () => {
    state.dropWidget = true;
    const plan = JSON.stringify({ tool: 'buildReport', args: { ...JSON.parse(buildPlan()).args, pages: [{ title: 'Ventas', widgets: [{ title: 'A', chartType: 'kpi-card', layout: {} }, { title: 'B', chartType: 'column', layout: {} }] }] } });
    const version = await previewVersion(plan);
    expect(await run(['apply', D, plan, '--version', version, '--confirmed'])).toBe(1);
    const result = JSON.parse(out);
    expect(result.saved).toBe(false);
    expect(result.problems[0]).toContain('reported 2 widgets');
  });

  test('builds a dashboard that shows a report page live', async () => {
    const plan = JSON.stringify({ tool: 'buildDashboard', args: { dashboardName: 'QA Skills · tablero', livePages: [{ reportId: REPORT, page: 'Ventas' }] } });
    const version = await previewVersion(plan);
    expect(await run(['apply', D, plan, '--version', version, '--confirmed'])).toBe(0);
    const result = JSON.parse(out);
    expect(result.record.widgets[0].livePage).toMatchObject({ reportId: REPORT, pageId: PAGE });
    expect(result.record.urls.view).toBe(`https://${D}/ui/spa/suite/dashboards/view/dashboard2`);
  });
});

describe('dashboard previews', () => {
  const OTHER_REPORT = '2'.repeat(24);
  const OTHER_WIDGET = '3'.repeat(24);
  beforeEach(() => {
    state.reports[REPORT].measures = [{ id: 'm_venta', expression: 'SUM([amount])' }];
    state.reports[OTHER_REPORT] = { _id: OTHER_REPORT, reportCode: 'RPT-3', reportName: 'Otro', entity: 'Deal', pages: [], createdBy: ME, updatedAt: 'T1', measures: [{ id: 'm_venta', expression: 'COUNT()' }], config: { additionalDatasets: [{ id: 'ds_x', reportId: REPORT }] } };
    state.widgets[OTHER_WIDGET] = { _id: OTHER_WIDGET, reportId: OTHER_REPORT, title: 'Pipeline', chartType: 'kpi-card', updatedAt: 'T1' };
  });

  test('warns when two reports on one dashboard use the same measure id for different things', async () => {
    const plan = JSON.stringify({ tool: 'editDashboard', args: { dashboardId: DASH, operations: [{ op: 'pinPage', reportId: OTHER_REPORT, page: 0 }] } });
    expect(await run(['preview', D, plan])).toBe(0);
    expect(JSON.parse(out).warnings.join(' ')).toContain('Measure id "m_venta"');
  });

  test('warns when a single widget is pinned from a report that joins datasets', async () => {
    const plan = JSON.stringify({ tool: 'buildDashboard', args: { dashboardName: 'QA', pinnedWidgets: [{ widgetId: OTHER_WIDGET }] } });
    expect(await run(['preview', D, plan])).toBe(0);
    expect(JSON.parse(out).warnings.join(' ')).toContain('Pin the whole page instead');
  });

  test('same measure with the same formula is not a conflict', async () => {
    state.reports[OTHER_REPORT].measures[0].expression = 'SUM([amount])';
    const plan = JSON.stringify({ tool: 'buildDashboard', args: { dashboardName: 'QA', livePages: [{ reportId: REPORT }, { reportId: OTHER_REPORT }] } });
    expect(await run(['preview', D, plan])).toBe(0);
    expect(JSON.parse(out).warnings.join(' ')).not.toContain('Measure id');
  });
});

describe('reads', () => {
  test('show resolves a code and lists pages, widgets and datasets', async () => {
    expect(await run(['show', D, 'report', 'RPT-1'])).toBe(0);
    const result = JSON.parse(out);
    expect(result.reportId).toBe(REPORT);
    expect(result.pages[0].widgets[0]).toMatchObject({ widgetId: W1, title: 'Negocios' });
    expect(result.datasets[0]).toMatchObject({ label: 'Metas', missing: true });
    expect(result.urls.edit).toBe(`https://${D}/ui/spa/suite/reports/editor/${REPORT}`);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('diagnose a report reports the platform issues and missing pieces without writing', async () => {
    state.issues = [{ where: 'widgets[0]', message: 'needs aggregation measure' }];
    expect(await run(['diagnose', D, 'report', REPORT])).toBe(0);
    const result = JSON.parse(out);
    expect(result.platformIssues[0].message).toContain('aggregation measure');
    expect(result.problems.join(' ')).toContain('Dataset "Metas"');
    expect(writes()).toHaveLength(0);
    expect(state.toolCalls[0].args).toMatchObject({ operations: [], dryRun: true });
  });

  test('diagnose a dashboard finds a live page that is no longer in its report', async () => {
    expect(await run(['diagnose', D, 'dashboard', 'dashboard1'])).toBe(0);
    const result = JSON.parse(out);
    expect(result.problems[0]).toContain('no longer in that report');
    expect(result.dashboard.timeRange).toEqual({ mode: 'preset', presetKey: 'this_month', dateField: 'createdAt' });
  });

  test('fields flattens nested fields and fails on an unknown model', async () => {
    expect(await run(['fields', D, 'Goal'])).toBe(0);
    const paths = JSON.parse(out).fields.map((f) => f.path);
    expect(paths).toEqual(['assignee', 'dates.startAt', 'targetValue']);
    expect(await run(['fields', D, 'Nope'])).toBe(1);
  });

  test('dates says how many records leave each date field empty, inside a filter', async () => {
    state.deals = [
      { _id: '1', stage: 'won', closeDate: '2026-07-10', createdAt: '2026-01-02' },
      { _id: '2', stage: 'won', closeDate: null, createdAt: '2026-11-01' },
      { _id: '3', stage: 'won', createdAt: '2026-11-02' },
      { _id: '4', stage: 'open', closeDate: '2026-11-03', createdAt: '2026-11-03' },
    ];
    expect(await run(['dates', D, 'Deal', '--where', '{"stage":"deal-stage-won"}'])).toBe(0);
    const result = JSON.parse(out);
    expect(result.records).toBe(3);
    expect(result.dates).toEqual([
      { path: 'closeDate', filled: 1, empty: 2, latest: '2026-07-10' },
      { path: 'createdAt', filled: 3, empty: 0, latest: '2026-11-02' },
      { path: 'proposal.sentAt', filled: 0, empty: 3, latest: null },
    ]);
    expect(calls.every((c) => c.method === 'GET' || c.path === '/v2/mcpsession/ses')).toBe(true);
  });

  test('dates refuses a stage code the account does not have', async () => {
    expect(await run(['dates', D, 'Deal', '--where', '{"stage":"deal-stage-nope"}'])).toBe(2);
    expect(err).toContain('deal-stage-nope');
  });

  test('dates refuses a filter that is not a JSON object', async () => {
    expect(await run(['dates', D, 'Deal', '--where', '[1]'])).toBe(2);
    expect(await run(['dates', D, 'Deal', '--where', '{"$where":"1"}'])).toBe(2);
  });

  test('schema reads the live tool catalog', async () => {
    expect(await run(['schema', D, 'buildDashboard'])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ required: ['dashboardName'], arguments: { dashboardName: 'Visible name' } });
    out = '';
    expect(await run(['schema', D, 'buildDashboard', 'livePages'])).toBe(0);
    expect(JSON.parse(out).schema.items.required).toEqual(['reportId']);
    expect(await run(['schema', D, 'delete'])).toBe(2);
  });

  test('a plan file must be in a temp folder', async () => {
    const file = path.join(rootDir, 'accounts', D, 'plan.json');
    fs.writeFileSync(file, buildPlan());
    expect(await run(['preview', D, file])).toBe(2);
    const ok = path.join(tmpDir, 'plan.json');
    fs.writeFileSync(ok, buildPlan());
    expect(await run(['preview', D, ok])).toBe(0);
  });
});
