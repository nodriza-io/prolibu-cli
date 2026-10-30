#!/usr/bin/env node
'use strict';

// Checks what a branch adds to this PUBLIC repo for things that must stay private:
// record ids, e-mail addresses, keys and tokens, home-directory paths, and any pattern
// listed in private-patterns.local.txt next to this file (git ignores it: put internal
// domains, server paths and customer names there, one regular expression per line).
//
//   node check-public.js [--base <ref>]
//
// It scans the added lines of `git diff <base>` and every untracked file. Exit 1 when it
// finds something. Allowed exceptions (public constants) live in public-allowlist.txt.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..');

const GENERIC = [
  { name: 'record id', re: /\b[a-f0-9]{24}\b/ },
  { name: 'e-mail', re: /[A-Za-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?![A-Za-z0-9])/ },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: 'api key value', re: /"?api[_-]?key"?\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/i },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'home path', re: /\/(Users|home)\/[A-Za-z0-9._-]+\// },
];

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function pickBase(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  for (const ref of ['upstream/main', 'origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      // try the next one
    }
  }
  throw new Error('No base ref found; pass --base <ref>.');
}

function main() {
  const base = pickBase(process.argv.slice(2));
  const patterns = GENERIC.concat(readLines(path.join(SKILL_DIR, 'private-patterns.local.txt'))
    .map((p) => ({ name: 'private pattern', re: new RegExp(p, 'i') })));
  const allow = readLines(path.join(SKILL_DIR, 'public-allowlist.txt')).map((p) => new RegExp(p));
  const ignored = (file) => /^(accounts\/|node_modules\/)|package-lock\.json$/.test(file);

  const findings = [];
  const check = (file, lineNo, text) => {
    if (ignored(file) || allow.some((re) => re.test(text))) return;
    for (const p of patterns) {
      if (p.re.test(text)) findings.push(`${file}:${lineNo}  [${p.name}]  ${text.trim().slice(0, 140)}`);
    }
  };

  let file = null;
  let lineNo = 0;
  for (const line of git(['diff', '--unified=0', base, '--', '.']).split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(6);
    } else if (line.startsWith('@@')) {
      lineNo = Number((/\+(\d+)/.exec(line) || [])[1] || 0);
    } else if (line.startsWith('+') && file) {
      check(file, lineNo, line.slice(1));
      lineNo += 1;
    }
  }
  for (const untracked of git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    fs.readFileSync(untracked, 'utf8').split('\n').forEach((text, i) => check(untracked, i + 1, text));
  }

  if (findings.length) {
    process.stdout.write(`${findings.length} finding(s) against ${base}:\n${findings.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Nothing private found in the changes against ${base}.\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 2;
}
