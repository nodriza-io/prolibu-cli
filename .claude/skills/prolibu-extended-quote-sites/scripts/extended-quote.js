#!/usr/bin/env node
'use strict';

// Extended quote sites: which site the quote editor opens, whether a URL can work there, a
// static check of the site's code, and attaching a site to one workspace (preview → apply).
//
//   extended-quote.js config    <domain>                  tenant + workspace overrides, and what each user gets
//   extended-quote.js check-url <domain> <url>            can the quote editor use this URL? (origin, Site, package, framing)
//   extended-quote.js lint      <index.html | folder>     static checks of the site's code (no network)
//   extended-quote.js preview   <domain> '<plan>'         writes nothing; returns a version
//   extended-quote.js apply     <domain> '<plan>' --version <v> --confirmed
//
// Plan: {"workspace":"<id>","action":"attach","url":"https://<domain>/site/<siteCode>/"}
//    or {"workspace":"<id>","action":"inherit"}   (clears the workspace override)
// The account-wide setting (account preferences) is never written: an admin changes it in the app.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 request failed, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const path = require('path');
const { createClient, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');
const { cobaltFindings } = require('../../_shared/cobalt-check');

const BLOCKED = 3;
const ID_RE = /^[a-f0-9]{24}$/i;
const SITE_PATH_RE = /^\/site\/([A-Za-z0-9_-]+)\/?$/;
const PREF_PATH = ['modules', 'sales', 'deals', 'quote', 'extendedQuote'];
const MAX_WORKSPACE_PAGES = 10;
const PROBE_TIMEOUT_MS = 10000;
const LINT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.vue']);
const LINT_MAX_FILES = 200;
const LINT_MAX_BYTES = 2 * 1024 * 1024;
const INVENTED_TYPES = ['site:ready', 'suite:init', 'form:ready', 'quote:update', 'quote:set', 'form:init', 'form:submit'];

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const getPath = (obj, keys) => keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const cleanConfig = (c) => (c && typeof c === 'object' ? { enabled: c.enabled, url: c.url } : {});

// The workspace override counts in the browser only when it has BOTH enabled=true and a url
// (V1 and V2 resolveExtendedQuoteConfig). Anything else falls back to the preference tree.
const isComplete = (ws) => Boolean(ws && ws.enabled && ws.url);

// What GET /v2/user/preferences returns for a user standing in that workspace: per-leaf merge,
// only an explicit boolean overrides `enabled`, an empty url inherits.
function backendMerge(tenant, ws) {
  const t = tenant || {};
  if (!ws || typeof ws !== 'object') return cleanConfig(t);
  return {
    enabled: typeof ws.enabled === 'boolean' ? ws.enabled : t.enabled,
    url: ws.url || t.url,
  };
}

// What the button opens. V1 (everyone) and V2 non-admins read the backend-merged preferences;
// V2 admins read the raw account preference (preference/read), so they skip the merge.
function effectiveFor(tenant, ws) {
  const merged = backendMerge(tenant, ws);
  const v1AndSellers = isComplete(ws) ? cleanConfig(ws) : merged;
  const v2Admins = isComplete(ws) ? cleanConfig(ws) : cleanConfig(tenant);
  const shown = (c) => ({ button: Boolean(c.enabled && c.url), url: c.enabled && c.url ? c.url : null });
  const a = shown(v1AndSellers);
  const b = shown(v2Admins);
  return { v1AndV2Sellers: a, v2Admins: b, divergent: a.button !== b.button || a.url !== b.url };
}

function partialWarning(ws) {
  if (!ws || typeof ws !== 'object' || isComplete(ws)) return null;
  const hasAny = typeof ws.enabled === 'boolean' || ws.url;
  if (!hasAny) return null;
  return 'Partial override (not both enabled=true and url): V1 and V2 sellers get a per-field mix with the account '
    + 'setting, V2 admins get the account setting. Set both fields, or clear the override.';
}

// Static checks of a URL against the account. No network.
function urlProblems(rawUrl, domain) {
  const problems = [];
  const add = (code, severity, message) => problems.push({ code, severity, message });
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch {
    add('INVALID_URL', 'error', 'Not an absolute URL. Use https://<domain>/site/<siteCode>/.');
    return { problems, siteCode: null };
  }
  if (u.protocol !== 'https:') add('NOT_HTTPS', 'error', 'The URL must be https.');
  if (/(^|[?&])(token|apikey|api_key|access_token|key)=/i.test(u.search)) {
    add('TOKEN_IN_URL', 'error', 'The URL carries a token or key: anyone who sees it gets that access. Remove it; the site reads the app session.');
  }
  if (u.hostname.toLowerCase() !== String(domain).toLowerCase()) {
    add('CROSS_ORIGIN', 'warning', `The page is not on ${domain}, so it has no app session (localStorage is per origin) and cannot `
      + 'call the Prolibu API as the seller. It only works if it needs no session, does not redirect, and lets the app frame it; '
      + 'this script does not load other domains to check that. To search the catalog, host it as a Prolibu Site.');
  }
  const m = SITE_PATH_RE.exec(u.pathname);
  if (!m) {
    add('NOT_A_SITE_PATH', 'warning', 'The path is not /site/<siteCode>/: the script cannot check the Site record.');
  } else if (!u.pathname.endsWith('/')) {
    add('NO_TRAILING_SLASH', 'warning', 'Without the final slash the server answers 302 and relative assets resolve one level up. End the URL with /.');
  }
  return { problems, siteCode: m ? m[1] : null, origin: u.origin };
}

function frameAncestors(csp) {
  const part = String(csp || '').split(';').map((s) => s.trim()).find((s) => /^frame-ancestors\s/i.test(s));
  return part ? part.split(/\s+/).slice(1) : null;
}

// ─── Lint of the site's code ───────────────────────────────────────────────────

function collectFiles(target) {
  const base = path.basename(target);
  if (/^profile.*\.json$/i.test(base)) throw new UsageError('Refusing to read profile files.');
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new UsageError(`Cannot read ${target}.`);
  }
  const files = [];
  const walk = (p) => {
    if (files.length >= LINT_MAX_FILES) return;
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      const name = path.basename(p);
      if (name === 'node_modules' || name.startsWith('.')) return;
      for (const child of fs.readdirSync(p).sort()) walk(path.join(p, child));
    } else if (LINT_EXT.has(path.extname(p).toLowerCase()) && s.size <= LINT_MAX_BYTES) {
      files.push(p);
    }
  };
  if (stat.isDirectory()) walk(target);
  else if (LINT_EXT.has(path.extname(target).toLowerCase())) files.push(target);
  else throw new UsageError('lint takes an .html/.js file or a folder with the site code.');
  return files;
}

function lintSource(files) {
  const texts = files.map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));
  const all = texts.map((t) => t.text).join('\n');
  const findings = [];
  const add = (code, severity, message, where) => findings.push({ code, severity, message, ...(where ? { files: where } : {}) });
  const where = (re) => texts.filter((t) => re.test(t.text)).map((t) => t.file);

  const usesHelper = /ProlibuQuote\.connect\s*\(/.test(all);
  if (!usesHelper && !/['"`]form:get:model['"`]/.test(all)) {
    add('NO_GET_MODEL', 'error', 'The site never sends form:get:model. The host never speaks first: V2 shows an error after 15 s and V1 waits forever.');
  }
  for (const type of INVENTED_TYPES) {
    const re = new RegExp(`['"\`]${type}['"\`]`);
    if (re.test(all)) add('INVENTED_MESSAGE', 'error', `"${type}" is not part of the contract; the host ignores it. Only form:get:model, form:set:model and form:close (or close:<process>).`, where(re));
  }
  if (/\bunitPrice\b/.test(all)) add('UNIT_PRICE', 'error', 'unitPrice is not a line field (it is price), and a hand-built line becomes virtual. Build lines with formatLineItem.', where(/\bunitPrice\b/));
  const sendsLines = usesHelper || /['"`]form:set:model['"`]/.test(all);
  if (sendsLines && !/formatLineItem|lineItemFromEntry/.test(all)) {
    add('HAND_BUILT_LINES', 'error', 'The site sends lines but never calls /v2/quote/formatLineItem: lines without pricebookEntry are saved as virtual.');
  }
  if (/[?&](token|apiKey|access_token)=/.test(all)) add('TOKEN_IN_URL', 'error', 'A token goes in a URL. Send it only in the Authorization header.', where(/[?&](token|apiKey|access_token)=/));
  const keyRe = /(apiKey|Authorization)\s*[:=]\s*['"`](Bearer\s+)?[A-Za-z0-9._-]{24,}['"`]/;
  if (keyRe.test(all)) add('EMBEDDED_KEY', 'error', 'An API key is written in the code: anyone who opens the site can use it. Read the app session from localStorage.', where(keyRe));
  const listens = /addEventListener\(\s*['"`]message['"`]/.test(all);
  if (listens && !usesHelper && !/\.origin\b/.test(all)) {
    add('NO_ORIGIN_CHECK', 'warning', 'The message listener does not check event.origin: any page that frames the site could feed it a fake deal.');
  }
  if (!usesHelper && !/['"`]form:close['"`]|close:/.test(all)) {
    add('NO_CLOSE', 'warning', 'The site never sends form:close: the seller has to close the modal by hand after applying.');
  }
  if (!usesHelper && /['"`]form:set:model['"`]/.test(all) && /lineItems\s*:\s*(newLines|selected|nuevas|items)\b/.test(all)) {
    add('ONLY_NEW_LINES', 'warning', 'form:set:model seems to send only the new lines; it REPLACES the whole list. Send the lines that arrived plus the new ones.');
  }
  // Design: the quote editor is a Cobalt app, so the site should look like it.
  for (const f of cobaltFindings(texts.map((t) => ({ rel: t.file, text: t.text })))) {
    add(f.rule.replace(/([A-Z])/g, '_$1').toUpperCase(), 'warning', f.message, f.file ? [f.file] : undefined);
  }
  return {
    files: files.length,
    usesHelper,
    findings,
    ok: !findings.some((f) => f.severity === 'error'),
  };
}

// ─── API helpers ───────────────────────────────────────────────────────────────

async function call(client, method, reqPath, opts) {
  const res = await client.request(method, reqPath, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${reqPath.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

const forbidden = (err) => err && err.status === 403;
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = (body && body.profile) || body || {};
  const ws = p.primaryWorkspace;
  return {
    isAdmin: p.isAdmin === true,
    primaryWorkspace: ws && typeof ws === 'object' ? String(ws._id) : ws ? String(ws) : null,
  };
}

// Tenant setting. Admins read the raw account preference; anyone else only gets the copy
// already merged with their own workspace.
async function readTenant(client, who) {
  if (who.isAdmin) {
    try {
      const body = await call(client, 'GET', '/v2/preference/read');
      return { config: cleanConfig(getPath(body && body.preference ? body.preference : body, PREF_PATH)), source: 'account preference' };
    } catch (err) {
      if (!forbidden(err)) throw err;
    }
  }
  const body = await call(client, 'GET', '/v2/user/preferences');
  return { config: cleanConfig(getPath(body, PREF_PATH)), source: 'your preferences (already merged with your workspace)' };
}

async function readWorkspace(client, id) {
  const body = await call(client, 'GET', `/v2/workspace/${id}?${qs({ select: 'workspaceName extendedQuote active updatedAt' })}`);
  return body;
}

async function listOverrides(client) {
  const xquery = { $or: [{ 'extendedQuote.enabled': { $exists: true } }, { 'extendedQuote.url': { $exists: true } }] };
  const rows = [];
  for (let page = 1; page <= MAX_WORKSPACE_PAGES; page += 1) {
    const body = await call(client, 'GET', `/v2/workspace?${qs({
      xquery, select: 'workspaceName extendedQuote active updatedAt', limit: '100', page: String(page),
    })}`);
    const data = (body && body.data) || [];
    rows.push(...data);
    const last = body && body.pagination ? body.pagination.lastPage : page;
    if (!data.length || page >= last) break;
  }
  return rows;
}

async function findSite(client, siteCode) {
  const body = await call(client, 'GET', `/v2/site?${qs({
    xquery: { siteCode }, select: 'siteCode siteName siteType active package updatedAt', limit: '1',
  })}`);
  const site = ((body && body.data) || [])[0];
  if (!site) return null;
  return {
    _id: site._id, siteCode: site.siteCode, siteName: site.siteName, siteType: site.siteType, active: site.active !== false, published: Boolean(site.package),
  };
}

// GET of the page itself, only on the account's own domain, without a token and without
// following redirects.
async function probe(url, fetchImpl) {
  const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const header = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
  const fa = frameAncestors(header('content-security-policy'));
  const origin = new URL(url).origin;
  return {
    status: res.status,
    location: header('location'),
    framingAllowed: fa ? fa.includes("'self'") || fa.includes('*') || fa.includes(origin) : null,
    xFrameOptions: header('x-frame-options'),
  };
}

async function checkUrl(client, domain, url, { fetchImpl, probeUrl = true } = {}) {
  const { problems, siteCode, origin } = urlProblems(url, domain);
  const add = (code, severity, message) => problems.push({ code, severity, message });
  let site = null;
  if (siteCode && !problems.some((p) => p.code === 'CROSS_ORIGIN')) {
    try {
      site = await findSite(client, siteCode);
      if (!site) add('SITE_NOT_FOUND', 'error', `No Site with siteCode "${siteCode}" on ${domain}.`);
      else if (!site.active) add('SITE_INACTIVE', 'error', 'The Site is inactive.');
      else if (!site.published) add('SITE_NOT_PUBLISHED', 'error', 'The Site has no package yet: the URL answers 403 AccessDenied. Publish it first (prolibu-sites).');
    } catch (err) {
      if (!forbidden(err)) throw err;
      add('SITE_UNREADABLE', 'warning', 'This key cannot read Sites (403): the Site record was not checked.');
    }
  }
  let http = null;
  if (probeUrl && origin && !problems.some((p) => ['CROSS_ORIGIN', 'INVALID_URL', 'NOT_HTTPS', 'TOKEN_IN_URL'].includes(p.code))) {
    try {
      http = await probe(url, fetchImpl || globalThis.fetch);
      if (http.status >= 300 && http.status < 400) {
        let target = null;
        try { target = new URL(http.location, url).origin; } catch { target = null; }
        if (target !== origin) add('REDIRECT_CROSS_ORIGIN', 'error', `The URL redirects to ${target || 'another origin'}: V2 discards every message from it.`);
      } else if (http.status === 403) add('HTTP_403', 'error', 'The page answers 403 (Site without package, or private).');
      else if (http.status === 404) add('HTTP_404', 'error', 'The page answers 404.');
      else if (http.status >= 400) add('HTTP_ERROR', 'error', `The page answers ${http.status}.`);
      if (http.framingAllowed === false) {
        add('FRAME_BLOCKED', 'error', 'Its Content-Security-Policy frame-ancestors does not allow the app: the iframe stays blank.');
      }
      if (/^deny$/i.test(String(http.xFrameOptions || ''))) add('FRAME_BLOCKED', 'error', 'X-Frame-Options DENY: the iframe stays blank.');
    } catch (err) {
      add('PROBE_FAILED', 'warning', `Could not load the page: ${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'}.`);
    }
  }
  return {
    url, siteCode, site, http, problems, usable: !problems.some((p) => p.severity === 'error'),
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdConfig(client, rest, flags, ctx) {
  const who = await me(client);
  const tenant = await readTenant(client, who);
  const out = {
    domain: client.domain,
    you: { isAdmin: who.isAdmin, primaryWorkspace: who.primaryWorkspace },
    tenant: { ...tenant.config, source: tenant.source },
    tenantUrlCheck: null,
    workspaces: [],
    notes: [
      'V1 (everyone) and V2 sellers read the preferences merged per field with their workspace; V2 admins read the raw account preference.',
      'A workspace override counts in the browser only with both enabled=true and url.',
      'The editor shows the button only on a deal\'s quote, never on a standalone quote.',
    ],
  };
  if (tenant.config.url) out.tenantUrlCheck = await checkUrl(client, client.domain, tenant.config.url, ctx);
  let rows;
  if (who.isAdmin) {
    rows = await listOverrides(client);
  } else {
    rows = [];
    if (who.primaryWorkspace) {
      try {
        const ws = await readWorkspace(client, who.primaryWorkspace);
        if (ws && ws.extendedQuote) rows.push(ws);
      } catch (err) {
        if (!forbidden(err)) throw err;
      }
    }
    out.notes.push('Non-admin key: only your own workspace is shown, and "tenant" is already merged with it.');
  }
  for (const ws of rows) {
    const ov = cleanConfig(ws.extendedQuote);
    out.workspaces.push({
      _id: ws._id,
      workspaceName: ws.workspaceName,
      active: ws.active !== false,
      override: ov,
      effective: effectiveFor(tenant.config, ov),
      warning: partialWarning(ov),
      urlCheck: ov.url ? await checkUrl(client, client.domain, ov.url, ctx) : null,
    });
  }
  return out;
}

async function cmdCheckUrl(client, rest, flags, ctx) {
  if (!rest[0]) throw new UsageError('Usage: extended-quote.js check-url <domain> <url>');
  return checkUrl(client, client.domain, rest[0], ctx);
}

function readPlan(arg) {
  const text = String(arg || '').trim();
  if (!text.startsWith('{')) throw new UsageError('The plan must be inline JSON: {"workspace":"<id>","action":"attach","url":"…"}.');
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  const unknown = Object.keys(plan).filter((k) => !['workspace', 'action', 'url', 'scope'].includes(k));
  if (unknown.length) throw new UsageError(`Unknown plan keys: ${unknown.join(', ')}.`);
  if (plan.scope === 'tenant' || plan.scope === 'account' || plan.workspace === undefined) {
    throw new Blocked('This script never writes account preferences. An admin sets the account preference '
      + 'modules.sales.deals.quote.extendedQuote = {enabled: true, url} in the app. Give the user the exact values.');
  }
  if (typeof plan.workspace !== 'string' || !ID_RE.test(plan.workspace)) throw new UsageError('"workspace" must be a workspace _id (24 hex characters).');
  if (!['attach', 'inherit'].includes(plan.action)) {
    throw new UsageError('"action" must be "attach" (with url) or "inherit" (clear the override). To hide the button in one workspace '
      + 'while the account has it on, there is no reliable setting: V2 admins would still see it.');
  }
  if (plan.action === 'attach' && typeof plan.url !== 'string') throw new UsageError('"attach" needs "url".');
  if (plan.action === 'inherit' && plan.url !== undefined) throw new UsageError('"inherit" takes no url.');
  return plan;
}

async function buildPreview(client, plan, ctx) {
  const who = await me(client);
  if (!who.isAdmin) {
    throw new Blocked('Only an admin can change a workspace. Nothing was sent; ask an admin to run this, or to set it in the app.');
  }
  const ws = await readWorkspace(client, plan.workspace);
  if (!ws || !ws._id) throw new Blocked('Workspace not found.');
  const tenant = await readTenant(client, who);
  const before = cleanConfig(ws.extendedQuote);
  const after = plan.action === 'attach' ? { enabled: true, url: plan.url } : { enabled: null, url: null };
  const blockers = [];
  const warnings = [];
  let urlCheck = null;
  if (plan.action === 'attach') {
    urlCheck = await checkUrl(client, client.domain, plan.url, ctx);
    for (const p of urlCheck.problems) (p.severity === 'error' ? blockers : warnings).push(`${p.code}: ${p.message}`);
  }
  if (ws.active === false) blockers.push('The workspace is inactive (read-only).');
  if (before.enabled === after.enabled && (before.url || null) === (after.url || null)) blockers.push('Nothing to change: the workspace already has this setting.');
  let usersStandingHere = null;
  try {
    const body = await call(client, 'GET', `/v2/user?${qs({ xquery: { primaryWorkspace: ws._id }, select: '_id', limit: '1' })}`);
    usersStandingHere = body && body.pagination ? body.pagination.count : null;
  } catch (err) {
    if (!forbidden(err)) throw err;
  }
  return {
    workspace: { _id: ws._id, workspaceName: ws.workspaceName },
    action: plan.action,
    before: { override: before, effective: effectiveFor(tenant.config, before) },
    after: { override: plan.action === 'attach' ? after : {}, effective: effectiveFor(tenant.config, plan.action === 'attach' ? after : {}) },
    tenant: tenant.config,
    usersStandingHere,
    urlCheck,
    blockers,
    warnings,
    version: String(ws.updatedAt || ''),
    patch: { extendedQuote: after },
  };
}

async function cmdPreview(client, rest, flags, ctx) {
  const plan = readPlan(rest[0]);
  const p = await buildPreview(client, plan, ctx);
  const { patch, ...shown } = p;
  return {
    ...shown,
    nextStep: p.blockers.length
      ? 'Blocked: fix the blockers first; nothing was written.'
      : `${STOP}apply ${client.domain} '${JSON.stringify(plan)}' --version ${p.version} --confirmed`,
  };
}

async function cmdApply(client, rest, flags, ctx) {
  const plan = readPlan(rest[0]);
  if (!flags.version) throw new UsageError('apply needs --version from the preview.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and ask first.');
  const p = await buildPreview(client, plan, ctx);
  if (p.blockers.length) throw new Blocked(p.blockers.join(' '));
  if (p.version !== flags.version) throw new Blocked('The workspace changed since the preview. Run preview again and show the user the new result.');
  await call(client, 'PATCH', `/v2/workspace/${p.workspace._id}`, { data: p.patch, confirmed: true });
  const back = cleanConfig((await readWorkspace(client, p.workspace._id)).extendedQuote);
  const ok = plan.action === 'attach'
    ? back.enabled === true && back.url === plan.url
    : !(typeof back.enabled === 'boolean') && !back.url;
  return {
    saved: ok,
    workspace: p.workspace,
    readBack: back,
    effective: effectiveFor(p.tenant, back),
    ...(ok ? {} : { problem: 'The read-back does not match the plan. Tell the user; do not retry another way.' }),
    reminder: 'Users already in the app see the change after reloading. Test on a NEW test deal.',
  };
}

const COMMANDS = {
  config: cmdConfig, 'check-url': cmdCheckUrl, preview: cmdPreview, apply: cmdApply,
};

const USAGE = 'Usage: extended-quote.js config <domain> | check-url <domain> <url> | lint <file|folder> | '
  + 'preview <domain> \'<plan>\' | apply <domain> \'<plan>\' --version <v> --confirmed   [--profile <name>]';

function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirmed') flags.confirmed = true;
    else if (a === '--no-probe') flags.noProbe = true;
    else if (a === '--profile' || a === '--version') {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${a}.`);
      i += 1;
      flags[a.slice(2)] = argv[i];
    } else if (a.startsWith('--')) throw new UsageError(`Unknown option ${a}.`);
    else positional.push(a);
  }
  const [command, domain, ...rest] = positional;
  return { command, domain, rest, flags };
}

const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can do it.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    if (command === 'lint') {
      if (!domain) throw new UsageError(USAGE);
      const result = lintSource(collectFiles(domain));
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : BLOCKED;
    }
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(USAGE);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const ctx = { fetchImpl: opts.probeFetch || opts.fetchImpl, probeUrl: !flags.noProbe };
    const result = await handler(client, rest, flags, ctx);
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    if (command === 'preview' && result.blockers.length) return BLOCKED;
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    if (forbidden(err)) {
      stderr.write(`FORBIDDEN: ${hide(err.message)}\n${FORBIDDEN_HINT}\n`);
      return 1;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, backendMerge, effectiveFor, isComplete, urlProblems, frameAncestors, lintSource, collectFiles,
};
