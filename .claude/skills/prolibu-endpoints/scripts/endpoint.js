#!/usr/bin/env node
'use strict';

// Creates, updates, inspects and calls a Prolibu Endpoint (the record that exposes a Script
// at /v2/endpoint/<method>/<routeName>). The Script itself is published with
// `./prolibu script dev|prod`; this file only binds it to a URL and tests the URL.
//
//   endpoint.js list    <domain> [<part of routeName>]
//   endpoint.js show    <domain> <routeName>
//   endpoint.js roles   <domain> <part of a role name>
//   endpoint.js preview <domain> '<plan json>'
//   endpoint.js apply   <domain> '<plan json>' --confirmed
//   endpoint.js call    <domain> <routeName> --confirmed [--method <verb>] [--data '<json>']
//                       [--query '<a=1&b=2>'] [--header '<name: value>']… [--no-auth]
//
// Plan: { routeName, endpointName, method, script: <scriptCode or _id>,
//         authentication: { enabled, requiredRoles? }, active? }
// The plan is inline JSON, or the path of a JSON file in a temp folder.
// Every command accepts --profile <name>. Exit codes: 0 ok, 1 API error, 2 usage, 3 blocked.

const fs = require('fs');
const {
  createClient, loadApiKey, validateTarget, redactFields, assertDataFileAllowed, isLikelyProduction, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const ROUTE_RE = /^[a-z0-9_-]{1,63}$/i; // the server's Validator.dns
const ID_RE = /^[a-f0-9]{24}$/i;
const ENDPOINT_SELECT = 'endpointName routeName method active authentication script endpointCode updatedAt';
const SCRIPT_SELECT = 'scriptCode scriptName active lifecycleHooks timeout';
const PLAN_KEYS = new Set(['routeName', 'endpointName', 'method', 'script', 'authentication', 'active']);
const CALL_TIMEOUT_MS = 330000; // a script may run up to 300 s

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function endpointUrl(domain, method, routeName) {
  return `https://${domain}/v2/endpoint/${String(method).toLowerCase()}/${routeName}`;
}

function idOf(ref) {
  return ref && typeof ref === 'object' ? ref._id : ref;
}

// Checks a plan without the network. Returns the normalized plan or throws UsageError.
function validatePlan(plan, { creating }) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.has(key)) throw new UsageError(`Unknown plan field "${key}". Allowed: ${[...PLAN_KEYS].join(', ')}.`);
  }
  if (typeof plan.routeName !== 'string' || !ROUTE_RE.test(plan.routeName)) {
    throw new UsageError('"routeName" must be 1–63 letters, digits, "-" or "_" (it is the last part of the URL).');
  }
  const out = { routeName: plan.routeName };
  if (plan.method !== undefined) {
    const method = String(plan.method).toUpperCase();
    if (!METHODS.includes(method)) throw new UsageError(`"method" must be one of ${METHODS.join(', ')}.`);
    out.method = method;
  }
  if (plan.endpointName !== undefined) {
    if (typeof plan.endpointName !== 'string' || !plan.endpointName.trim()) throw new UsageError('"endpointName" must be a non-empty string.');
    out.endpointName = plan.endpointName.trim();
  }
  if (plan.script !== undefined) {
    if (typeof plan.script !== 'string' || !plan.script.trim()) throw new UsageError('"script" must be a scriptCode or a Script _id.');
    out.script = plan.script.trim();
  }
  if (plan.active !== undefined) {
    if (typeof plan.active !== 'boolean') throw new UsageError('"active" must be true or false.');
    out.active = plan.active;
  }
  if (plan.authentication !== undefined) {
    const auth = plan.authentication;
    if (!auth || typeof auth !== 'object' || typeof auth.enabled !== 'boolean') {
      throw new UsageError('"authentication" must be { "enabled": true|false, "requiredRoles"?: [roleId] }.');
    }
    out.authentication = { enabled: auth.enabled };
    if (auth.requiredRoles !== undefined) {
      if (!Array.isArray(auth.requiredRoles) || !auth.requiredRoles.every((r) => typeof r === 'string' && ID_RE.test(r))) {
        throw new UsageError('"authentication.requiredRoles" must be an array of Role _id strings (use the roles command).');
      }
      out.authentication.requiredRoles = auth.requiredRoles;
    }
  }
  if (creating) {
    const missing = ['endpointName', 'method', 'script'].filter((k) => out[k] === undefined);
    if (out.authentication === undefined) missing.push('authentication.enabled');
    if (missing.length) {
      throw new UsageError(`A new endpoint needs ${missing.join(', ')}. Decide authentication.enabled on purpose: true needs a Bearer token, false is open to anyone.`);
    }
  }
  return out;
}

// What a PATCH must send to turn `current` into `plan` (plain-object fields merge on the
// server, arrays are replaced whole, so authentication travels complete).
function diffEndpoint(current, plan, scriptId) {
  const changes = {};
  if (plan.endpointName !== undefined && plan.endpointName !== current.endpointName) changes.endpointName = plan.endpointName;
  if (plan.method !== undefined && plan.method !== current.method) changes.method = plan.method;
  if (scriptId && scriptId !== String(idOf(current.script))) changes.script = scriptId;
  if (plan.active !== undefined && plan.active !== current.active) changes.active = plan.active;
  if (plan.authentication !== undefined) {
    const cur = current.authentication || {};
    const next = {
      enabled: plan.authentication.enabled,
      requiredRoles: plan.authentication.requiredRoles !== undefined ? plan.authentication.requiredRoles : (cur.requiredRoles || []).map(String),
    };
    const same = cur.enabled === next.enabled
      && JSON.stringify((cur.requiredRoles || []).map(String)) === JSON.stringify(next.requiredRoles);
    if (!same) changes.authentication = next;
  }
  return changes;
}

function warningsFor(endpoint, script) {
  const warnings = [];
  const auth = endpoint.authentication || {};
  if (auth.enabled === false) {
    warnings.push('Public: anyone who knows the URL can run the script. Check a shared secret or signature inside the script.');
    if ((auth.requiredRoles || []).length) warnings.push('requiredRoles is ignored while authentication.enabled is false.');
  }
  if (endpoint.active === false) warnings.push('The endpoint is inactive: every call answers 400 "Endpoint is not active".');
  if (script) {
    if (script.active === false) warnings.push(`Script ${script.scriptCode} is inactive: every call answers 400.`);
    if ((script.lifecycleHooks || []).length) warnings.push(`Script ${script.scriptCode} also runs on record changes (${script.lifecycleHooks.join(', ')}).`);
    if (/-dev$/.test(script.scriptCode || '')) warnings.push(`Script ${script.scriptCode} is the dev copy; point the endpoint at the prod script before going live.`);
  }
  warnings.push('The route answers any HTTP verb, not only its method: the script cannot tell which verb was used.');
  return warnings;
}

function summarize(domain, endpoint, script) {
  const auth = endpoint.authentication || {};
  return {
    _id: endpoint._id,
    endpointCode: endpoint.endpointCode,
    endpointName: endpoint.endpointName,
    routeName: endpoint.routeName,
    method: endpoint.method,
    url: endpointUrl(domain, endpoint.method, endpoint.routeName),
    active: endpoint.active,
    authentication: { enabled: auth.enabled, requiredRoles: (auth.requiredRoles || []).map(String) },
    script: script ? { _id: script._id, scriptCode: script.scriptCode, active: script.active, timeout: script.timeout } : String(idOf(endpoint.script) || ''),
    updatedAt: endpoint.updatedAt,
  };
}

function hintFor(status, body) {
  const message = body && typeof body === 'object' ? body.error : null;
  if (status === 200) return 'Success: the client must read response.output.';
  if (status === 401) return 'No valid Bearer token. On a public endpoint, any Authorization header that is not a valid key also gives 401.';
  if (status === 403) return 'The caller has none of requiredRoles (admins always pass).';
  if (status === 404 && typeof body === 'string') return 'The verb in the URL does not match the HTTP verb used, or the Origin is not allowed (CORS).';
  if (status === 404) return 'No endpoint has this routeName (the lookup is case-sensitive).';
  if (status === 400 && message === 'Invalid JSON') return 'The body is not valid JSON; nothing ran.';
  if (status === 400 && message === 'Script execution timeout') return 'The script ran longer than its timeout.';
  if (status === 400) return 'The script threw, rejected, or the endpoint or script is inactive. The message reaches the caller verbatim.';
  return null;
}

// ─── API helpers ───────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function findEndpoint(client, routeName) {
  const qs = new URLSearchParams({
    xquery: JSON.stringify({ routeName }),
    populatePath: JSON.stringify([{ path: 'script', select: SCRIPT_SELECT }]),
    select: ENDPOINT_SELECT,
    limit: '2',
  });
  const body = await call(client, 'GET', `/v2/endpoint?${qs}`);
  return (body.data || [])[0] || null;
}

async function findScript(client, ref) {
  const res = await client.request('GET', `/v2/script/${encodeURIComponent(ref)}?${new URLSearchParams({ select: SCRIPT_SELECT })}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /v2/script answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
  return res.body;
}

function readPlan(arg, rootDir) {
  if (arg === undefined) throw new UsageError('Missing the plan JSON.');
  let text = String(arg);
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the plan file ${arg}.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(client, rest) {
  const query = rest[0] ? { routeName: { $regex: `(?i)${rest[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } : {};
  const qs = new URLSearchParams({
    xquery: JSON.stringify(query),
    populatePath: JSON.stringify([{ path: 'script', select: SCRIPT_SELECT }]),
    select: ENDPOINT_SELECT,
    limit: '100',
  });
  const body = await call(client, 'GET', `/v2/endpoint?${qs}`);
  return { count: (body.pagination || {}).count, endpoints: (body.data || []).map((e) => summarize(client.domain, e, typeof e.script === 'object' ? e.script : null)) };
}

async function cmdShow(client, rest) {
  if (!rest[0]) throw new UsageError('Usage: endpoint.js show <domain> <routeName>');
  const endpoint = await findEndpoint(client, rest[0]);
  if (!endpoint) throw new Blocked(`No endpoint has routeName "${rest[0]}" (the lookup is case-sensitive).`);
  const script = typeof endpoint.script === 'object' ? endpoint.script : null;
  return { endpoint: summarize(client.domain, endpoint, script), warnings: warningsFor(endpoint, script) };
}

async function cmdRoles(client, rest) {
  if (!rest[0]) throw new UsageError('Usage: endpoint.js roles <domain> <part of a role name>');
  const qs = new URLSearchParams({
    xquery: JSON.stringify({ roleName: { $regex: `(?i)${rest[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }),
    select: 'roleName',
    limit: '50',
  });
  const body = await call(client, 'GET', `/v2/role?${qs}`);
  return { roles: (body.data || []).map((r) => ({ _id: r._id, roleName: r.roleName })) };
}

async function buildPreview(client, rawPlan) {
  const probe = validatePlan(rawPlan, { creating: false });
  const current = await findEndpoint(client, probe.routeName);
  const plan = validatePlan(rawPlan, { creating: !current });
  const blockers = [];

  let script = null;
  if (plan.script) {
    script = await findScript(client, plan.script);
    if (!script) blockers.push(`Script "${plan.script}" does not exist. Publish it first with ./prolibu script dev|prod.`);
  } else if (current && typeof current.script === 'object') {
    script = current.script;
  }

  const roleNames = [];
  for (const roleId of (plan.authentication && plan.authentication.requiredRoles) || []) {
    const res = await client.request('GET', `/v2/role/${roleId}?select=roleName`);
    if (res.ok) roleNames.push(`${res.body.roleName} (${roleId})`);
    else blockers.push(`Role ${roleId} does not exist.`);
  }

  let action;
  let changes;
  let after;
  if (current) {
    changes = diffEndpoint(current, plan, script && String(script._id));
    action = Object.keys(changes).length ? 'update' : 'none';
    after = { ...current, ...changes, authentication: changes.authentication || current.authentication };
  } else {
    action = 'create';
    changes = {
      endpointName: plan.endpointName,
      routeName: plan.routeName,
      method: plan.method,
      script: script ? String(script._id) : plan.script,
      active: plan.active !== undefined ? plan.active : true,
      authentication: { enabled: plan.authentication.enabled, requiredRoles: plan.authentication.requiredRoles || [] },
    };
    after = { ...changes };
  }

  return {
    action,
    current: current ? summarize(client.domain, current, typeof current.script === 'object' ? current.script : null) : null,
    changes,
    url: endpointUrl(client.domain, after.method, plan.routeName),
    script: script ? { _id: script._id, scriptCode: script.scriptCode, active: script.active, timeout: script.timeout } : null,
    requiredRoles: roleNames,
    warnings: warningsFor(after, script),
    blockers,
    _internal: { current, changes },
  };
}

function publicPreview(result) {
  const rest = { ...result };
  delete rest._internal;
  return rest;
}

async function cmdPreview(client, rest, flags, ctx) {
  return publicPreview(await buildPreview(client, readPlan(rest[0], ctx.rootDir)));
}

async function cmdApply(client, rest, flags, ctx) {
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Run preview, show it to the user and ask first.');
  const result = await buildPreview(client, readPlan(rest[0], ctx.rootDir));
  if (result.blockers.length) throw new Blocked(result.blockers.join(' '));
  if (result.action === 'none') return { saved: true, action: 'none', endpoint: result.current, problems: [] };

  let saved;
  if (result.action === 'create') {
    saved = await call(client, 'POST', '/v2/endpoint', { data: result.changes, confirmed: true });
  } else {
    saved = await call(client, 'PATCH', `/v2/endpoint/${result._internal.current._id}`, { data: result.changes, confirmed: true });
  }

  const after = await findEndpoint(client, saved.routeName || result.changes.routeName || result._internal.current.routeName);
  const problems = [];
  if (!after) problems.push('The endpoint is missing after saving.');
  else {
    const expect = result.changes;
    if (expect.method && after.method !== expect.method) problems.push(`method is ${after.method}, expected ${expect.method}.`);
    if (expect.script && String(idOf(after.script)) !== String(expect.script)) problems.push('script did not change.');
    if (expect.authentication && (after.authentication || {}).enabled !== expect.authentication.enabled) problems.push('authentication.enabled did not change.');
    if (expect.active !== undefined && after.active !== expect.active) problems.push('active did not change.');
  }
  return {
    saved: problems.length === 0,
    action: result.action,
    endpoint: after ? summarize(client.domain, after, typeof after.script === 'object' ? after.script : null) : null,
    warnings: after ? warningsFor(after, typeof after.script === 'object' ? after.script : null) : [],
    problems,
  };
}

async function cmdCall(client, rest, flags, ctx) {
  const routeName = rest[0];
  if (!routeName || !ROUTE_RE.test(routeName)) throw new UsageError('Usage: endpoint.js call <domain> <routeName> --confirmed […]');
  if (!flags.confirmed) throw new UsageError('Calling an endpoint runs its script, which may change data. Ask the user, then add --confirmed.');

  let method = flags.method;
  if (!method) {
    const endpoint = await findEndpoint(client, routeName);
    if (!endpoint) throw new Blocked(`No endpoint has routeName "${routeName}".`);
    method = endpoint.method;
  }
  method = String(method).toUpperCase();
  if (!METHODS.includes(method)) throw new UsageError(`--method must be one of ${METHODS.join(', ')}.`);

  let body;
  if (flags.data !== undefined) {
    if (method === 'GET') throw new UsageError('A GET call cannot carry --data; use --query.');
    try {
      body = JSON.stringify(JSON.parse(flags.data));
    } catch {
      throw new UsageError('--data must be valid JSON.');
    }
  }
  const query = flags.query ? `?${new URLSearchParams(flags.query)}` : '';
  const path = `/v2/endpoint/${method.toLowerCase()}/${routeName}${query}`;
  validateTarget(client.domain, path);

  const headers = { Accept: 'application/json' };
  for (const raw of flags.headers) {
    const at = raw.indexOf(':');
    const name = at > 0 ? raw.slice(0, at).trim().toLowerCase() : '';
    if (!/^[a-z0-9-]+$/.test(name)) throw new UsageError(`Bad --header "${raw}". Use "name: value".`);
    if (name === 'authorization' || name === 'cookie' || name === 'host') throw new UsageError(`--header cannot set ${name}.`);
    headers[name] = raw.slice(at + 1).trim();
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!flags.noAuth) headers.Authorization = `Bearer ${ctx.key()}`;
  if (isLikelyProduction(client.domain)) ctx.stderr.write(`WARNING: ${client.domain} looks like a production account.\n`);

  const res = await ctx.fetchImpl(`https://${client.domain}${path}`, {
    method, headers, body, redirect: 'error', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    request: { method, url: `https://${client.domain}${path}`, authenticated: !flags.noAuth, headers: Object.keys(headers).filter((h) => h !== 'Authorization') },
    status: res.status,
    body: redactFields(parsed),
    hint: hintFor(res.status, parsed),
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = { headers: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--no-auth') flags.noAuth = true;
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--method') flags.method = next();
    else if (arg === '--data') flags.data = next();
    else if (arg === '--query') flags.query = next();
    else if (arg === '--header') flags.headers.push(next());
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  list: cmdList, show: cmdShow, roles: cmdRoles, preview: cmdPreview, apply: cmdApply, call: cmdCall,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) {
      throw new UsageError('Usage: endpoint.js <list|show|roles|preview|apply|call> <domain> … (see the header of this file)');
    }
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl, stderr });
    const ctx = { rootDir, fetchImpl, stderr, key: () => loadApiKey(domain, rootDir, flags.profile) };
    const result = await handler(client, rest, flags, ctx);
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    if (command === 'call') return result.status >= 200 && result.status < 300 ? 0 : 1;
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
    if (err && err.name === 'TimeoutError') {
      stderr.write('Request failed: timed out.\n');
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
  main, validatePlan, diffEndpoint, warningsFor, endpointUrl, hintFor,
};
