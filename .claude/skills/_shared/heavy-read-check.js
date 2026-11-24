'use strict';

// Static checks for page code that would overload the account's database.
// Every account on a server shares one database: a list call sorted on a field without an index
// reads and sorts the whole collection on every call, and enough of them at once take every
// account on the server down. Only `_id` is indexed on every object. See HEAVY-READS.md.
//
// heavyReadFindings(files) → [{ level: 'blocker'|'warning', rule, file, line, field?, message }]
// A finding is accepted on purpose with `// heavy-read-ok: <reason>` on its line or the line above
// (a reason is required: a small configuration list, a single lookup by _id…).
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
// Values of `sort` that are not field names (chart and table options).
const NOT_FIELDS = new Set(['none', 'asc', 'desc', 'ascending', 'descending']);
const LIMIT_RE = /\blimit["']?\s*[:=]\s*(?:String\()?\s*[`'"]?(\d+)/g;
const COUNT_CALL_RE = /\blimit["']?\s*[:=]\s*[`'"]?1\b(?!\d)/;
const LOOP_RE = /\bfor\s*\(|\.forEach\(|\.map\(|\bwhile\s*\(/;
const PARALLEL_RE = /Promise\.(?:all|allSettled)\(/g;
// A string that can only be a sort on a heavy field: '-createdAt', '-closeDate'…
const DESC_LITERAL_RE = /[`'"]-([A-Za-z_][\w.]*)[`'"]/g;
// A sort kept in a variable or given as a default: sort || 'createdAt', orden = '-createdAt', sort = 'createdAt'.
const SORT_VAR_RES = [
  /\b(?:sort|sortBy|orden|order|orderBy|ordenar)\b[^;\n]{0,40}?(?:\|\||\?\?)\s*[`'"]([^`'"]+)[`'"]/g,
  /\b(?:sort|sortBy|orden|order|orderBy|ordenar)\s*=\s*[`'"]([^`'"]+)[`'"]/g,
];
// Two operators on one field in one object: the API keeps only the last one, so a range
// { $gte: a, $lte: b } becomes "everything up to b" and the page reads far more than it shows.
const SAME_FIELD_OPS_RE = /\{\s*['"]?\$(gte|gt|lte|lt)['"]?\s*:[^{}]*?,\s*['"]?\$(gte|gt|lte|lt|ne|in|nin)['"]?\s*:/g;
// Function definitions, to follow calls that reach the API through the page's own helpers.
const FN_DEF_RES = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
];

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

// Body of the function whose definition ends at `from`: the braces after it, or a short expression.
function bodyAt(text, from) {
  const arrow = /=>\s*$/.test(text.slice(Math.max(0, from - 4), from));
  if (arrow && /^\s*[^\s{]/.test(text.slice(from, from + 20))) return text.slice(from, from + 400);
  const brace = text.indexOf('{', from);
  return brace !== -1 && brace - from < 200 ? argumentOf(text, brace, 6000) : text.slice(from, from + 400);
}

// Names of functions (in any of the files) that call the API, directly or through another one.
function apiWrappers(files) {
  const defs = [];
  for (const f of files) {
    for (const re of FN_DEF_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(f.text))) defs.push({ name: m[1], body: bodyAt(f.text, m.index + m[0].length) });
    }
  }
  const names = new Set(defs.filter((d) => API_RE.test(d.body)).map((d) => d.name));
  for (let pass = 0; pass < 6; pass += 1) {
    const re = callRe(names);
    if (!re) break;
    let grew = false;
    for (const d of defs) {
      if (names.has(d.name)) continue;
      re.lastIndex = 0;
      if (re.test(d.body)) { names.add(d.name); grew = true; }
    }
    if (!grew) break;
  }
  return names;
}

function callRe(names, flags = '') {
  const list = [...names].filter((n) => n.length > 2).map((n) => n.replace(/\$/g, '\\$'));
  return list.length ? new RegExp(`(?:^|[^\\w$])(?:${list.join('|')})\\s*\\(`, flags) : null;
}

// How many API calls (direct or through a helper) a piece of code makes.
function apiCallCount(snippet, wrappers) {
  const direct = (snippet.match(/\.api\(\s*[`'"]\/|\bfetch\(/g) || []).length;
  const re = callRe(wrappers, 'g');
  return direct + (re ? (snippet.match(re) || []).length : 0);
}

function checkFile(f, wrappers = new Set()) {
  const findings = [];
  const { text } = f;
  const viaHelper = callRe(wrappers);
  if (!API_RE.test(text) && !(viaHelper && viaHelper.test(text))) return findings;
  const seen = new Set();
  const lines = text.split('\n');
  // `// heavy-read-ok: <reason>` on the line or the line above accepts a finding on purpose.
  const accepted = (line) => [lines[line - 1], lines[line - 2]].some((l) => l && /heavy-read-ok:\s*\S/.test(l));
  const add = (item) => {
    const key = `${item.rule}:${item.line}:${item.field || ''}`;
    if (accepted(item.line)) return;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ file: f.rel, ...item });
    }
  };

  for (const re of SORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const fields = decodeURIComponent(m[1]).split(/[,\s]+/).map((s) => s.replace(/^-/, '')).filter((name) => name && !NOT_FIELDS.has(name.toLowerCase()));
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

  // A heavy sort kept in a variable or a default value ('-createdAt', sort || 'closeDate').
  const flagHeavy = (name, index) => {
    if (name === '_id' || !HEAVY_FIELD_RE.test(name)) return;
    add({
      level: 'blocker',
      rule: 'heavyListSort',
      line: lineOf(text, index),
      field: name,
      message: `Sorts a list by ${name} (a sort kept in a variable or a default), which has no index: the database reads and sorts the whole collection on every call. Use sort=-_id (newest first) or _id, or read the rows once from a report and sort in memory.`,
    });
  };
  DESC_LITERAL_RE.lastIndex = 0;
  let dm;
  while ((dm = DESC_LITERAL_RE.exec(text))) flagHeavy(dm[1], dm.index);
  for (const re of SORT_VAR_RES) {
    re.lastIndex = 0;
    let vm;
    while ((vm = re.exec(text))) {
      for (const name of vm[1].split(/[,\s]+/).map((x) => x.replace(/^-/, '')).filter(Boolean)) flagHeavy(name, vm.index);
    }
  }

  SAME_FIELD_OPS_RE.lastIndex = 0;
  let sm;
  while ((sm = SAME_FIELD_OPS_RE.exec(text))) {
    add({
      level: 'blocker',
      rule: 'sameFieldOperators',
      line: lineOf(text, sm.index),
      message: `Puts $${sm[1]} and $${sm[2]} on one field in one object: the API keeps only the last operator, so the filter returns far more records than asked (a date range becomes "everything up to the end date"). Put each condition in its own object inside $and: {"$and":[{"field":{"$gte":a}},{"field":{"$lte":b}}]}.`,
    });
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
    const calls = apiCallCount(arg, wrappers);
    const mapped = /\.map\(/.test(arg) && calls > 0;
    // Two different lookups at once are fine; three or more reads at once are not.
    const many = calls >= 3;
    if (pool || mapped || many) {
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
  const code = files.filter((f) => typeof f.text === 'string'
    && CODE_EXT.has(path.extname(f.rel).toLowerCase())
    && !SKIP_BASENAMES.has(path.basename(f.rel)));
  const wrappers = apiWrappers(code);
  const out = [];
  for (const f of code) out.push(...checkFile(f, wrappers));
  return out;
}

module.exports = { heavyReadFindings };
