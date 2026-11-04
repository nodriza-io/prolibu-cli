#!/usr/bin/env node
'use strict';

// Checks and runs a script deployed with `./prolibu script dev|prod`, the parts the CLI
// leaves to you:
//   - `./prolibu script dev` exits 0 even when a field was rejected, so `status` compares
//     the account with the local folder;
//   - a run by scriptCode can execute stale cached code, so `run` always runs by _id;
//   - console.log is never stored and logs cannot be filtered by script on the server,
//     so `run` and `logs` pick this script's stored log lines.
//
//   script.js status <domain> <prefix> [--env dev|prod]
//   script.js run    <domain> <prefix> [--env dev|prod] [--query key=value]... --confirmed
//   script.js logs   <domain> <prefix> [--env dev|prod] [--limit <n>]
//
// --env dev (default) is the script `<prefix>-dev`; --env prod is the script `<prefix>`.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error or the run failed, 2 usage error (nothing sent),
// 3 blocked: not deployed, inactive, or out of sync (nothing run).

const fs = require('fs');
const path = require('path');
const {
  createClient, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const QUERY_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const LOG_PAGE = 100;
const LOG_SETTLE_MS = 800;
const RUN_TIMEOUT_MS = 310000;
const SCRIPT_FIELDS = '_id scriptCode scriptName active timeout lifecycleHooks variables scheduledTask runOnQuoteCalculate code updatedAt';
const SIBLING_FIELDS = '_id scriptCode active lifecycleHooks scheduledTask runOnQuoteCalculate';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function scriptCodeFor(prefix, env) {
  return env === 'prod' ? prefix : `${prefix}-dev`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readLocal(rootDir, domain, prefix) {
  const dir = path.join(rootDir, 'accounts', domain, 'scripts', prefix);
  if (!fs.existsSync(dir)) return { dir, exists: false };
  const config = readJson(path.join(dir, 'config.json'));
  const bundlePath = path.join(dir, 'dist', 'bundle.js');
  let bundle;
  let bundleBuiltAt;
  if (fs.existsSync(bundlePath)) {
    bundle = fs.readFileSync(bundlePath, 'utf8');
    bundleBuiltAt = fs.statSync(bundlePath).mtime.toISOString();
  }
  return { dir, exists: true, config, bundle, bundleBuiltAt };
}

function sameList(a, b) {
  const x = [...(a || [])].sort();
  const y = [...(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function variableKeys(list) {
  return (Array.isArray(list) ? list : []).map((v) => v && v.key).filter(Boolean);
}

function fires(script) {
  if (!script || !script.active) return false;
  return (script.lifecycleHooks || []).length > 0
    || Boolean(script.scheduledTask && script.scheduledTask.periodicity)
    || script.runOnQuoteCalculate === true;
}

// Compares what the account holds with the local folder. Variable values are never printed.
function compare(local, account, sibling) {
  const problems = [];
  const warnings = [];
  const config = local.config || {};

  if (!account.active) problems.push('The script is inactive: every run, hook and schedule skips it.');

  let code = { matchesBundle: null, accountLength: (account.code || '').length };
  if (local.bundle !== undefined) {
    code = {
      matchesBundle: account.code === local.bundle,
      accountLength: (account.code || '').length,
      bundleLength: local.bundle.length,
      bundleBuiltAt: local.bundleBuiltAt,
    };
    if (!code.matchesBundle) {
      problems.push('The code on the account differs from dist/bundle.js. Deploy again and read the CLI output for "Failed to PATCH code".');
    }
  } else {
    warnings.push('No local dist/bundle.js: deploy with ./prolibu script dev|prod to build and upload it.');
  }

  const localHooks = config.lifecycleHooks;
  if (local.config && !sameList(localHooks, account.lifecycleHooks)) {
    problems.push('lifecycleHooks differ between config.json and the account. Look for "Failed to PATCH lifecycleHooks" in the CLI output: the object may not be enabled for hooks on this account.');
  }

  const localKeys = variableKeys(config.variables);
  const accountKeys = variableKeys(account.variables);
  const missing = localKeys.filter((k) => !accountKeys.includes(k));
  const droppedOnNextDeploy = local.config ? accountKeys.filter((k) => !localKeys.includes(k)) : [];
  if (local.config && missing.length) {
    problems.push(`Variables in config.json are missing on the account: ${missing.join(', ')}.`);
  }
  if (droppedOnNextDeploy.length) {
    warnings.push(`The account has variables that config.json does not (${droppedOnNextDeploy.join(', ')}), probably saved by setVariable. The next deploy replaces the whole list and drops them.`);
  }

  if (sibling && fires(account) && fires(sibling)) {
    warnings.push(`Both ${account.scriptCode} and ${sibling.scriptCode} are active with hooks, a schedule or quote calculation: both run on every event. Keep triggers on one copy.`);
  }

  return {
    code,
    lifecycleHooks: { local: localHooks === undefined ? null : localHooks, account: account.lifecycleHooks || [] },
    variables: { localKeys, accountKeys, droppedOnNextDeploy },
    problems,
    warnings,
  };
}

// Log lines of one script that were not there before the run.
function newLogLines(before, after, scriptId) {
  const seen = new Set(before.map((l) => l._id));
  return after.filter((l) => !seen.has(l._id) && l.meta && String(l.meta.scriptId) === String(scriptId));
}

function shapeLog(line) {
  const out = {
    createdAt: line.createdAt,
    status: line.status,
    message: line.message,
    eventName: line.meta && line.meta.eventName,
  };
  if (line.meta && line.meta.errorStack) out.errorStack = line.meta.errorStack;
  return out;
}

function parseQuery(pairs) {
  const params = [];
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw new UsageError(`Invalid --query ${pair}. Use key=value.`);
    const key = pair.slice(0, at);
    if (!QUERY_KEY_RE.test(key) || key === 'scriptId') {
      throw new UsageError(`Invalid --query key ${key}. Letters, digits, dot, dash or underscore, and not scriptId.`);
    }
    params.push([key, pair.slice(at + 1)]);
  }
  return params;
}

// ─── API calls ─────────────────────────────────────────────────────────────────

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

async function findScript(client, scriptCode, fields) {
  const res = await client.request('GET', `/v2/script/${encodeURIComponent(scriptCode)}?select=${encodeURIComponent(fields)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    throw new Error(`GET /v2/script/${scriptCode} answered ${res.status}: ${body.error || 'no message'}`);
  }
  return res.body;
}

// The log API cannot filter by script, so this reads the newest Script lines and filters here.
async function recentLogs(client) {
  const body = await call(client, 'GET', `/v2/log?logType=Script&sort=-createdAt&limit=${LOG_PAGE}`);
  return Array.isArray(body && body.data) ? body.data : [];
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus(client, ctx) {
  const scriptCode = scriptCodeFor(ctx.prefix, ctx.env);
  const otherCode = scriptCodeFor(ctx.prefix, ctx.env === 'prod' ? 'dev' : 'prod');
  const local = readLocal(ctx.rootDir, client.domain, ctx.prefix);
  const account = await findScript(client, scriptCode, SCRIPT_FIELDS);
  if (!account) throw new Blocked(`${scriptCode} is not on ${client.domain}. Deploy it with ./prolibu script ${ctx.env} --domain ${client.domain} --prefix ${ctx.prefix} --no-git.`);
  const sibling = await findScript(client, otherCode, SIBLING_FIELDS);
  const result = compare(local, account, sibling);
  return {
    domain: client.domain,
    scriptCode,
    _id: account._id,
    active: account.active,
    timeout: account.timeout,
    scheduledTask: account.scheduledTask || null,
    runOnQuoteCalculate: account.runOnQuoteCalculate === true,
    updatedAt: account.updatedAt,
    localFolder: local.exists ? path.relative(ctx.rootDir, local.dir) : null,
    ...result,
    otherCopy: sibling ? {
      scriptCode: sibling.scriptCode,
      _id: sibling._id,
      active: sibling.active,
      lifecycleHooks: sibling.lifecycleHooks || [],
      scheduledTask: sibling.scheduledTask || null,
    } : null,
    inSync: result.problems.length === 0,
  };
}

async function cmdRun(client, ctx) {
  if (!ctx.flags.confirmed) {
    throw new UsageError('Refusing to run without --confirmed. A run executes the code on the account: tell the user what it does and ask first.');
  }
  const scriptCode = scriptCodeFor(ctx.prefix, ctx.env);
  const params = parseQuery(ctx.flags.query);
  const script = await findScript(client, scriptCode, '_id scriptCode active');
  if (!script) throw new Blocked(`${scriptCode} is not on ${client.domain}. Deploy it first.`);
  if (!script.active) throw new Blocked(`${scriptCode} is inactive, so the platform refuses to run it.`);

  const before = await recentLogs(client);
  const qs = new URLSearchParams([['scriptId', script._id], ...params]).toString();
  let res;
  try {
    // Always by _id: a run by scriptCode can serve code cached before the last deploy.
    res = await client.request('GET', `/v2/script/run?${qs}`);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      return {
        scriptCode, _id: script._id, ran: 'unknown', timedOutLocally: true,
        note: `No answer within ${RUN_TIMEOUT_MS / 1000} s. The run may still be going on the server: check \`logs\` in a minute.`,
      };
    }
    throw err;
  }
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`GET /v2/script/run answered ${res.status}: ${body.error || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  await ctx.sleep(LOG_SETTLE_MS);
  const after = await recentLogs(client);
  const body = res.body || {};
  const result = {
    scriptCode,
    _id: script._id,
    output: body.output === undefined ? null : body.output,
    error: body.error || null,
    timeMs: body.timeMs,
    logs: newLogLines(before, after, script._id).map(shapeLog),
    note: 'console.log lines are not stored: only console.info, warn and error appear in logs.',
  };
  if (body.errorStack) result.errorStack = body.errorStack;
  return result;
}

async function cmdLogs(client, ctx) {
  const scriptCode = scriptCodeFor(ctx.prefix, ctx.env);
  const script = await findScript(client, scriptCode, '_id scriptCode');
  if (!script) throw new Blocked(`${scriptCode} is not on ${client.domain}.`);
  const lines = (await recentLogs(client))
    .filter((l) => l.meta && String(l.meta.scriptId) === String(script._id))
    .slice(0, ctx.flags.limit)
    .map(shapeLog);
  return {
    scriptCode,
    _id: script._id,
    logs: lines,
    note: `Searched the newest ${LOG_PAGE} Script log lines of the account. Lines expire after 7 days; console.log is never stored.`,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = { env: 'dev', query: [], limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--env') flags.env = next();
    else if (arg === '--query') flags.query.push(next());
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 20, 1), LOG_PAGE);
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (!['dev', 'prod'].includes(flags.env)) throw new UsageError('--env must be dev or prod.');
  return { command: positional[0], domain: positional[1], prefix: positional[2], extra: positional.slice(3), flags };
}

const COMMANDS = { status: cmdStatus, run: cmdRun, logs: cmdLogs };

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const {
      command, domain, prefix, extra, flags,
    } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain || !prefix || extra.length) {
      throw new UsageError('Usage: script.js <status|run|logs> <domain> <prefix> [--env dev|prod] … (see the header of this file)');
    }
    if (!PREFIX_RE.test(prefix)) throw new UsageError('Invalid prefix. Letters, digits, dash and underscore only.');
    client = createClient({
      domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr,
      // A run can last up to the script's timeout (at most 300 s); other calls keep the default.
      ...(command === 'run' ? { timeoutMs: RUN_TIMEOUT_MS } : {}),
    });
    const result = await handler(client, {
      rootDir, prefix, env: flags.env, flags, sleep,
    });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'status' && !result.inSync) return BLOCKED;
    if (command === 'run' && (result.error || result.timedOutLocally)) return 1;
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
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, compare, newLogLines, parseQuery, scriptCodeFor,
};
