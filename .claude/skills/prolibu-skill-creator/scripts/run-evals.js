#!/usr/bin/env node
'use strict';

// Runs skill evals the way a user would: `claude -p` inside the repo, then an optional
// second turn on the same session (usually the user's "yes"). Cases run one after another,
// because they may touch the same test records.
//
//   node run-evals.js --cases <cases.json> --out <dir> [--cwd <repo>] [--only id1,id2] [--max-turns 50]
//
// cases.json (keep it out of the repo: it names records of a real test account):
//   {
//     "allow": ["Bash(./prolibu site dev:*)"],          // extra tools, optional
//     "cases": [{ "id": "q1", "prompt": "Add 3 units of …", "reply": "Yes, go ahead." }]
//   }
//
// Each turn's transcript goes to <out>/<id>-t1.jsonl and <id>-t2.jsonl (stream-json).
// Summarize them with summarize-evals.js.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = { maxTurns: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    if (argv[i] === '--cases') args.cases = next();
    else if (argv[i] === '--out') args.out = next();
    else if (argv[i] === '--cwd') args.cwd = next();
    else if (argv[i] === '--only') args.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--max-turns') args.maxTurns = Number(next()) || 50;
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!args.cases || !args.out) {
    throw new Error('Usage: run-evals.js --cases <cases.json> --out <dir> [--cwd <repo>] [--only a,b] [--max-turns n]');
  }
  return args;
}

// The skills' own commands, read tools, and writes limited to accounts/ and temp folders.
function defaultTools(cwd) {
  const tools = ['Bash(node .claude/skills/_shared/prolibu-api.js:*)'];
  const skillsDir = path.join(cwd, '.claude', 'skills');
  for (const skill of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
    const dir = path.join(skillsDir, skill, 'scripts');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      tools.push(`Bash(node .claude/skills/${skill}/scripts/${file}:*)`);
    }
  }
  return tools.concat([
    'Bash(./prolibu script dev:*)', 'Bash(./prolibu site dev:*)',
    'Bash(./prolibu object list:*)', 'Bash(./prolibu object pull:*)',
    'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(grep:*)', 'Bash(mkdir:*)', 'Bash(cp:*)',
    'Read', 'Glob', 'Grep',
    'Write(accounts/**)', 'Edit(accounts/**)', 'Write(//private/tmp/**)', 'Write(//tmp/**)',
  ]);
}

// A child session must not believe it runs inside the current one.
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_USE_BEDROCK')) {
      delete env[key];
    }
  }
  return env;
}

function sessionOf(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.session_id) return j.session_id;
    } catch {
      // not a JSON line
    }
  }
  return null;
}

function turn({ cwd, out, name, prompt, resume, tools, maxTurns }) {
  const file = path.join(out, `${name}.jsonl`);
  const errFile = path.join(out, `${name}.err`);
  const outFd = fs.openSync(file, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const argv = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns)];
  if (resume) argv.push('--resume', resume);
  argv.push('--allowedTools', ...tools);
  const res = spawnSync('claude', argv, { cwd, env: childEnv(), stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  if (res.error) throw res.error;
  return file;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd || process.cwd());
  const spec = JSON.parse(fs.readFileSync(args.cases, 'utf8'));
  const tools = defaultTools(cwd).concat(spec.allow || []);
  fs.mkdirSync(args.out, { recursive: true });
  const cases = (spec.cases || []).filter((c) => !args.only || args.only.includes(c.id));
  for (const c of cases) {
    const stamp = () => new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${stamp()}] ${c.id}: turn 1\n`);
    const first = turn({ cwd, out: args.out, name: `${c.id}-t1`, prompt: c.prompt, tools, maxTurns: args.maxTurns });
    if (c.reply) {
      const sid = sessionOf(first);
      if (!sid) {
        process.stdout.write(`[${stamp()}] ${c.id}: no session id, skipping turn 2\n`);
        continue;
      }
      process.stdout.write(`[${stamp()}] ${c.id}: turn 2\n`);
      turn({ cwd, out: args.out, name: `${c.id}-t2`, prompt: c.reply, resume: sid, tools, maxTurns: args.maxTurns });
    }
    process.stdout.write(`[${stamp()}] ${c.id}: done\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 2;
}
