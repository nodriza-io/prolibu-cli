#!/usr/bin/env node
'use strict';

// Template for a skill script. Copy it to .claude/skills/prolibu-<topic>/scripts/<topic>.js,
// rename OBJECT and the commands, and replace buildChange() with the task's real rules.
// As it stands it safely changes fields of one record of OBJECT:
//
//   <topic>.js show    <domain> <id>
//   <topic>.js preview <domain> '<plan json>'                 writes nothing; returns a version
//   <topic>.js apply   <domain> '<plan json>' --version <v> --confirmed
//
// Plan: {"id": "<24 hex>", "set": {"<field>": <value>}}
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const { createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const OBJECT = 'example'; // REST path of the object, e.g. 'deal'
const ID_RE = /^[a-f0-9]{24}$/i;
const BLOCKED = 3;

class Blocked extends Error {}

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

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    text = fs.readFileSync(text, 'utf8');
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || !ID_RE.test(String(plan.id))) throw new UsageError('The plan needs "id" (24 hex characters).');
  if (!plan.set || typeof plan.set !== 'object' || !Object.keys(plan.set).length) {
    throw new UsageError('The plan changes nothing: add "set".');
  }
  return plan;
}

// The task's rules go here: validate against the verified behavior, keep what must not
// change, and return the exact body to send plus what to tell the user.
function buildChange(record, plan) {
  const body = {};
  const changes = [];
  for (const [field, value] of Object.entries(plan.set)) {
    if (field.startsWith('_') || field === 'createdAt' || field === 'updatedAt') {
      throw new UsageError(`"${field}" is set by the platform.`);
    }
    if (JSON.stringify(record[field]) === JSON.stringify(value)) continue;
    body[field] = value;
    changes.push({ field, before: record[field] === undefined ? null : record[field], after: value });
  }
  return { body, changes, warnings: [], blockers: [] };
}

async function load(client, id) {
  return call(client, 'GET', `/v2/${OBJECT}/${id}`);
}

async function cmdShow(client, [id]) {
  if (!ID_RE.test(String(id))) throw new UsageError('Usage: show <domain> <id>');
  const record = await load(client, id);
  return { record, version: record.updatedAt };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const record = await load(client, plan.id);
  const change = buildChange(record, plan);
  return {
    ...change,
    version: record.updatedAt,
    nextStep: change.blockers.length
      ? 'Blocked: tell the user why; do not apply.'
      : 'Show the changes to the user. Only after an explicit yes, run apply with the same plan and --version.',
  };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const record = await load(client, plan.id);
  if (record.updatedAt !== flags.version) throw new Blocked('The record changed since the preview. Preview again.');
  const change = buildChange(record, plan);
  if (change.blockers.length) throw new Blocked(change.blockers.join(' '));
  if (!Object.keys(change.body).length) return { saved: true, unchanged: true, problems: [] };

  await call(client, 'PATCH', `/v2/${OBJECT}/${plan.id}`, { data: change.body, confirmed: true });

  const after = await load(client, plan.id);
  const problems = Object.entries(change.body)
    .filter(([field, value]) => JSON.stringify(after[field]) !== JSON.stringify(value))
    .map(([field]) => `${field} did not save as sent.`);
  return { saved: problems.length === 0, version: after.updatedAt, changes: change.changes, problems };
}

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
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = { show: cmdShow, preview: cmdPreview, apply: cmdApply };

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError('Usage: <topic>.js <show|preview|apply> <domain> …');
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
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

module.exports = { main, buildChange, readPlan };
