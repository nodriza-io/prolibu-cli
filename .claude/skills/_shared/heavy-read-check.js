'use strict';

// Static checks for page code that would overload the account's database.
// Every account on a server shares one database: a list call sorted on a field without an index
// reads and sorts the whole collection on every call, and enough of them at once take every
// account on the server down. Only `_id` is indexed on every object. See HEAVY-READS.md.
//
// heavyReadFindings(files) → [{ level: 'blocker'|'warning', rule, file, line, field?, message }]
// files: [{ rel, text }] — files without text (binaries) are skipped.

const path = require('path');

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.html', '.htm', '.svelte']);
const SKIP_BASENAMES = new Set(['prolibu-session.js', 'prolibu-extended-quote.js']);

// The file talks to the Prolibu API: the session helper, a /v2 path or a fetch.
const API_RE = /\/v2\/|\.api\(\s*[`'"]\/|\bfetch\(/;
// `sort` given as a value: sort: '…', sort="…", sort=… inside a URL.
const SORT_RES = [
  /\bsort["']?\s*:\s*[`'"]([^`'"]+)[`'"]/g,
  /[?&]sort=([^&`'"\s)+]+)/g,
  /\.set\(\s*[`'"]sort[`'"]\s*,\s*[`'"]([^`'"]+)[`'"]/g,
];
// Fields whose order needs a full sort on large objects: dates, timestamps and amounts.
const HEAVY_FIELD_RE = /(^|\.)(createdAt|updatedAt|\w+At|\w*[dD]ate|amount|total|\w+Total)$/;
const LIMIT_RE = /\blimit["']?\s*[:=]\s*(?:String\()?\s*[`'"]?(\d+)/g;
const COUNT_CALL_RE = /\blimit["']?\s*[:=]\s*[`'"]?1\b(?!\d)/;
const LOOP_RE = /\bfor\s*\(|\.forEach\(|\.map\(|\bwhile\s*\(/;
const PARALLEL_RE = /Promise\.(?:all|allSettled)\(/g;

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// The text of the bracketed argument that starts at `open`, capped.
function argumentOf(text, open, cap = 800) {
  let depth = 0;
  for (let i = open; i < text.length && i < open + cap; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open, open + cap);
}

function checkFile(f) {
  const findings = [];
  const { text } = f;
  if (!API_RE.test(text)) return findings;
  const seen = new Set();
  const add = (item) => {
    const key = `${item.rule}:${item.line}:${item.field || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ file: f.rel, ...item });
    }
  };

  for (const re of SORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const fields = decodeURIComponent(m[1]).split(/[,\s]+/).map((s) => s.replace(/^-/, '')).filter(Boolean);
      const line = lineOf(text, m.index);
      const heavy = fields.find((name) => name !== '_id' && HEAVY_FIELD_RE.test(name));
      const other = fields.find((name) => name !== '_id' && !HEAVY_FIELD_RE.test(name));
      if (heavy) {
        add({
          level: 'blocker',
          rule: 'heavyListSort',
          line,
          field: heavy,
          message: `Sorts a list by ${heavy}, which has no index: the database reads and sorts the whole collection on every call, and enough of them at once take down every account on the server. Use sort=-_id (newest first) or _id, or read the rows once from a report (/v2/report/generate/?reportId=…&downloadFormat=json) and sort in memory.`,
        });
      } else if (other) {
        add({
          level: 'warning',
          rule: 'listSort',
          line,
          field: other,
          message: `Sorts a list by ${other}. Only _id is indexed on every object: this is fine for small configuration lists (stages, users, workspaces), never for deals, contacts, tasks or e-mails. Use _id there.`,
        });
      }
    }
  }

  LIMIT_RE.lastIndex = 0;
  let lm;
  while ((lm = LIMIT_RE.exec(text))) {
    if (Number(lm[1]) >= 200) {
      add({
        level: 'warning',
        rule: 'bulkListRead',
        line: lineOf(text, lm.index),
        message: `Reads ${lm[1]} records per call from the page. For many records read the rows once from a report (/v2/report/generate/?reportId=…&downloadFormat=json); never loop over pages.`,
      });
    }
  }

  PARALLEL_RE.lastIndex = 0;
  let pm;
  while ((pm = PARALLEL_RE.exec(text))) {
    const arg = argumentOf(text, pm.index + pm[0].length - 1);
    const pool = /Array\.from\(\s*\{\s*length/.test(arg);
    const mapped = /\.map\(/.test(arg) && API_RE.test(arg);
    if (pool || mapped) {
      add({
        level: 'blocker',
        rule: 'parallelListCalls',
        line: lineOf(text, pm.index),
        message: 'Runs API calls in parallel over a list (or a pool of workers). Each one can read a whole collection; together they overload the shared database. Make one call at a time, or read the rows once from a report and group them in memory.',
      });
    }
  }

  if (COUNT_CALL_RE.test(text) && LOOP_RE.test(text)) {
    const m = COUNT_CALL_RE.exec(text);
    add({
      level: 'warning',
      rule: 'countPerGroup',
      line: lineOf(text, m.index),
      message: 'Counts with limit=1, likely once per stage, advisor or month: each call reads the whole collection. Use a report for the figures, or load the rows once (report stream) and count in memory.',
    });
  }
  return findings;
}

function heavyReadFindings(files) {
  const out = [];
  for (const f of files) {
    if (typeof f.text !== 'string') continue;
    const ext = path.extname(f.rel).toLowerCase();
    if (!CODE_EXT.has(ext)) continue;
    if (SKIP_BASENAMES.has(path.basename(f.rel))) continue;
    out.push(...checkFile(f));
  }
  return out;
}

module.exports = { heavyReadFindings };
