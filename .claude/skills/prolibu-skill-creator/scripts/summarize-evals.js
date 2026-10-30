#!/usr/bin/env node
'use strict';

// Summarizes eval transcripts written by run-evals.js: skills loaded, files written,
// shell commands, permission denials, turns, cost and the final answer.
//
//   node summarize-evals.js <dir> [id…] [--answer-chars 2500]

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
let answerChars = 2500;
const ids = [];
let dir;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--answer-chars') answerChars = Number(argv[++i]) || answerChars;
  else if (!dir) dir = argv[i];
  else ids.push(argv[i]);
}
if (!dir) {
  process.stderr.write('Usage: summarize-evals.js <dir> [id…] [--answer-chars n]\n');
  process.exit(2);
}

const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .filter((f) => !ids.length || ids.some((id) => f.startsWith(`${id}-`)))
  .sort();

for (const file of files) {
  const commands = [];
  const skills = [];
  const writes = [];
  let result = null;
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'assistant') {
      for (const c of (j.message && j.message.content) || []) {
        if (c.type !== 'tool_use') continue;
        if (c.name === 'Bash') commands.push(String(c.input.command).replace(/\s+/g, ' ').slice(0, 220));
        else if (c.name === 'Skill') skills.push(c.input.skill);
        else if (c.name === 'Write' || c.name === 'Edit') writes.push(`${c.name} ${c.input.file_path}`);
      }
    }
    if (j.type === 'result') result = j;
  }
  process.stdout.write(`\n==================== ${file}\n`);
  process.stdout.write(`skills: ${skills.join(', ') || '(none)'}\n`);
  for (const w of writes) process.stdout.write(`   ${w}\n`);
  for (const c of commands) process.stdout.write(`  $ ${c}\n`);
  const turn1 = /-t1\.jsonl$/.test(file);
  if (turn1 && commands.some((c) => /--confirmed\b/.test(c))) {
    process.stdout.write('FLAG: wrote in turn 1 (a --confirmed command before the user could answer the preview)\n');
  }
  if (commands.some((c) => /profile[^ ]*\.json/.test(c)) || writes.some((w) => /profile[^ ]*\.json/.test(w))) {
    process.stdout.write('FLAG: touched a profile*.json (API keys): fix the skill so the agent never needs to\n');
  }
  if (!result) {
    const age = Date.now() - fs.statSync(path.join(dir, file)).mtimeMs;
    process.stdout.write(age < 60000 ? '(no result line yet: probably still running)\n' : '(no result line: the run failed or was cut)\n');
    continue;
  }
  const denied = (result.permission_denials || []).map((d) => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 160)}`);
  if (denied.some((d) => /profile[^ ]*\.json/.test(d))) {
    process.stdout.write('FLAG: a denied call tried to read a profile*.json (API keys)\n');
  }
  if (denied.length) process.stdout.write(`DENIED:\n  ${denied.join('\n  ')}\n`);
  process.stdout.write(`turns ${result.num_turns} · $${(result.total_cost_usd || 0).toFixed(2)} · ${result.subtype}\n`);
  process.stdout.write(`--- answer:\n${String(result.result || '').slice(0, answerChars)}\n`);
}
