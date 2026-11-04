#!/usr/bin/env node
'use strict';

// Hosted Sites (https://<domain>/site/<siteCode>/): check a build, publish it, read it back.
//
//   site.js list             <domain> [--search <text>]
//   site.js show             <domain> <siteCode>                     record, package, what visitors get
//   site.js check            <domain> <folder | backup.zip>          local checks only; writes nothing
//   site.js preview          <domain> <siteCode> <folder | zip> [--site-type Static|SPA] [--name <siteName>]
//   site.js publish          <domain> <siteCode> <folder | zip> --version <v> --confirmed [--prod]
//   site.js settings-preview <domain> <siteCode> [--active on|off] [--gate on|off] [--site-type Static|SPA]
//   site.js settings         <domain> <siteCode> <same flags> --version <v> --confirmed [--prod]
//
// <folder> is a site folder under accounts/<domain>/sites/ (its public/, or the build output
// named by settings.json when package.json has a build script) or a folder or zip in a temp
// folder. A publish first saves the package that is live now; publishing that zip is the rollback.
// Every command accepts --profile <name>. Output is JSON.
// Exit codes: 0 ok, 1 request failed, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { createClient, loadApiKey, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const BLOCKED = 3;
const SITE_CODE_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NEW_SITE_CODE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SITE_TYPES = ['Static', 'SPA'];
const DEFAULT_MAX_MB = 20;
const MB = 1024 * 1024;
const BIG_FILE_BYTES = 10 * MB;
const MAX_SCAN_BYTES = 5 * MB;
const MANY_FILES = 1500;
const MAX_BACKUP_BYTES = 150 * MB;
const UPLOAD_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 20000;
const PROBE_ATTEMPTS = 5;
const PROBE_DELAY_MS = 3000;
const NEW_SITE_PROBE_DELAY_MS = 16000;
const MAX_ASSET_CHECKS = 10;
const ZIP_DATE = new Date('2000-01-01T00:00:00Z');
const SITE_SELECT = 'siteCode siteName siteType active authenticationRequired package publicUrl createdBy updatedAt';
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.svg', '.xml', '.map', '.webmanifest']);
const SCANNED_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.txt', '.md', '.svg', '.xml', '.csv']);
const JUNK = new Set(['.DS_Store', 'Thumbs.db']);

const STOP = 'Show this to the user in plain words. STOP HERE and end your turn; never write in the same turn as this '
  + 'preview. Only after the user answers with an explicit yes in a later message, run ';

// What the account's content scanner rejects when an admin turned it on (cloud drive advanced security).
const SCANNER_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i, /javascript:/i, /vbscript:/i, /onload\s*=/i, /onerror\s*=/i,
  /onclick\s*=/i, /<iframe\b/i, /<object\b/i, /<embed\b/i, /eval\s*\(/i, /document\.write/i,
];

// Secrets that must never ship in a site: every file of a site is public, gate or not.
const SECRET_PATTERNS = [
  { rule: 'privateKey', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'awsAccessKey', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'stripeSecretKey', re: /\b[sr]k_live_[0-9A-Za-z]{16,}/ },
  { rule: 'githubToken', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { rule: 'slackToken', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { rule: 'aiProviderKey', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { rule: 'hardcodedBearer', re: /Bearer\s+[A-Za-z0-9._~+/-]{24,}/ },
  { rule: 'hardcodedApiKey', re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|password)\s*["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i },
];

const SECRET_FILES = [
  { rule: 'envFile', re: /(^|\/)\.env(\.[^/]*)?$/ },
  { rule: 'npmrc', re: /(^|\/)\.npmrc$/ },
  { rule: 'keyFile', re: /\.(pem|key|p12|pfx)$/i },
  { rule: 'sshKey', re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/ },
  { rule: 'profileFile', re: /(^|\/)profile(\.[a-z0-9-]+)?\.json$/i },
];

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hash = (value) => sha256(JSON.stringify(value)).slice(0, 16);
const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const mb = (bytes) => Math.round((bytes / MB) * 100) / 100;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const isProdCode = (code) => !/-dev$/.test(code);

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const isInside = (child, dir) => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function tempDirs() {
  const dirs = [os.tmpdir(), process.env.TMPDIR, process.env.CLAUDE_SCRATCHPAD, process.platform === 'win32' ? null : '/tmp'].filter(Boolean);
  return [...new Set(dirs.flatMap((d) => [path.resolve(d), realOrResolved(d)]))];
}

// A site's files become public: only a site folder of this account or a temp folder may be published,
// never the account folder itself (it holds the profiles) or anything else on the disk.
function assertSourceAllowed(rootDir, domain, input) {
  const real = realOrResolved(input);
  const sitesDirs = [path.resolve(rootDir, 'accounts', domain, 'sites'), realOrResolved(path.resolve(rootDir, 'accounts', domain, 'sites'))];
  const inSites = sitesDirs.some((dir) => real !== dir && isInside(real, dir));
  const accountsDirs = [path.resolve(rootDir, 'accounts'), realOrResolved(path.resolve(rootDir, 'accounts'))];
  const inAccounts = accountsDirs.some((dir) => isInside(real, dir));
  const inTemp = tempDirs().some((dir) => isInside(real, dir));
  if (!inSites && (inAccounts || !inTemp)) {
    throw new UsageError(`Refusing ${input}: publish only a folder under accounts/${domain}/sites/<prefix>/ or a folder or zip in a temp folder.`);
  }
}

// Mirrors the CLI: package.json with a build script publishes settings.json outputDir (default dist),
// otherwise public/. A folder that already holds index.html (a dist/ or public/ given directly) is used as is.
function resolveSource(rootDir, domain, input) {
  if (!input) throw new UsageError('Missing <folder | zip>.');
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new UsageError(`Not found: ${input}`);
  assertSourceAllowed(rootDir, domain, abs);
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (!/\.zip$/i.test(abs)) throw new UsageError('A file source must be a .zip (for example a backup printed by publish).');
    return { kind: 'zip', zipPath: abs, siteFolder: null, notes: [] };
  }
  const notes = [];
  let siteFolder = abs;
  let dir = abs;
  let build = null;
  const pkgPath = path.join(abs, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      throw new UsageError('package.json is not valid JSON.');
    }
    if (pkg.scripts && pkg.scripts.build) {
      let outputDir = 'dist';
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(abs, 'settings.json'), 'utf8'));
        if (settings.outputDir) outputDir = String(settings.outputDir);
      } catch {
        // No settings.json: the CLI also defaults to dist.
      }
      if (path.isAbsolute(outputDir) || outputDir.split(/[\\/]/).includes('..')) throw new UsageError('settings.json outputDir must be a folder inside the site.');
      dir = path.join(abs, outputDir);
      build = { outputDir };
    }
  }
  if (!build && fs.existsSync(path.join(abs, 'public')) && fs.statSync(path.join(abs, 'public')).isDirectory()) {
    dir = path.join(abs, 'public');
  } else if (!build) {
    siteFolder = fs.existsSync(path.join(abs, 'config.json')) ? abs : path.dirname(abs);
  }
  if (build && !fs.existsSync(dir)) {
    return { kind: 'folder', dir, siteFolder, build, missingBuild: true, notes };
  }
  return { kind: 'folder', dir, siteFolder, build, notes };
}

function readConfigSiteType(siteFolder) {
  if (!siteFolder) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(siteFolder, 'config.json'), 'utf8'));
    return SITE_TYPES.includes(cfg.siteType) ? cfg.siteType : null;
  } catch {
    return null;
  }
}

function newestMtime(dir, skip = new Set()) {
  let newest = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

// Lists the files that would be zipped. Junk is skipped (and said); links and VCS/dependency folders block.
function walk(dir) {
  const files = [];
  const skipped = [];
  const blockers = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (JUNK.has(e.name) || e.name === '__MACOSX') {
        skipped.push(r);
      } else if (e.isSymbolicLink()) {
        blockers.push({ rule: 'symlink', file: r, message: 'Symbolic links are not published safely; copy the real file instead.' });
      } else if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') {
          blockers.push({ rule: e.name === '.git' ? 'gitFolder' : 'nodeModules', file: `${r}/`, message: `${e.name}/ must not be published (it is public and may hold history or secrets). Publish the build output only.` });
        } else {
          stack.push(r);
        }
      } else if (e.isFile()) {
        files.push({ rel: r, abs: path.join(dir, r), size: fs.statSync(path.join(dir, r)).size });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped, blockers };
}

// A zip's entries, read from the central directory as the app's own check does before an upload,
// with their contents inflated so a zip is checked like a folder. Anything unreadable throws:
// an unchecked package could empty the site.
function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let at = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new UsageError('The file is not a zip.');
  const count = buf.readUInt16LE(at + 10);
  const cdSize = buf.readUInt32LE(at + 12);
  const cdOffset = buf.readUInt32LE(at + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new UsageError('ZIP64 packages are not supported here; publish the folder instead.');
  if (cdOffset + cdSize > buf.length) throw new UsageError('The zip is damaged.');
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new UsageError('The zip is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rel = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extra + comment;
    if (rel.endsWith('/') || rel.startsWith('__MACOSX/') || JUNK.has(path.posix.basename(rel))) continue;
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new UsageError(`The zip has an unsafe path: ${rel}`);
    const entry = { rel, size };
    if (size <= MAX_SCAN_BYTES) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new UsageError('The zip is damaged.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + packed);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_SCAN_BYTES + 1 });
      else throw new UsageError(`The zip uses an unsupported compression for ${rel}.`);
      entry.buffer = data;
      entry.sha = sha256(data);
      if (TEXT_EXT.has(path.extname(rel).toLowerCase())) entry.text = data.toString('utf8');
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// Root-absolute references resolve to the app at the domain root, not to the site: a blank page.
// /v2/ (the API, the sign-in page) and /site/ are on purpose.
function absoluteRefs(rel, text) {
  const out = [];
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    const re = /<([a-zA-Z][\w-]*)\b[^>]*?\s(src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/g;
    let m;
    while ((m = re.exec(text))) {
      const ref = m[3];
      if (/^\/(v2|site)\//.test(ref)) continue;
      out.push({ tag: m[1].toLowerCase(), ref, line: lineOf(text, m.index) });
    }
  }
  if (ext === '.css' || ext === '.html' || ext === '.htm') {
    const re = /url\(\s*["']?(\/(?!\/)[^"')]*)/g;
    let m;
    while ((m = re.exec(text))) out.push({ tag: 'css', ref: m[1], line: lineOf(text, m.index) });
  }
  return out;
}

// Relative assets the index page loads, to check that each one is really served.
function relativeAssets(html, max = MAX_ASSET_CHECKS) {
  const refs = new Set();
  const re = /<(script|link|img|source)\b[^>]*?\s(src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[3].trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref)) continue;
    const clean = ref.replace(/^\.\//, '').split(/[?#]/)[0];
    if (clean && !clean.split('/').includes('..') && path.extname(clean)) refs.add(clean);
  }
  return [...refs].slice(0, max);
}

function profileKeys(rootDir, domain) {
  const dir = path.join(rootDir, 'accounts', domain);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^profile(\.[a-z0-9-]+)?\.json$/.test(n));
  } catch {
    return [];
  }
  const keys = [];
  for (const n of names) {
    const profile = n === 'profile.json' ? undefined : n.slice('profile.'.length, -'.json'.length);
    try {
      keys.push(loadApiKey(domain, rootDir, profile));
    } catch {
      // A profile without a key has nothing to leak.
    }
  }
  return keys.filter((k) => k.length >= 12);
}

// All local checks. Findings name the file and the rule, never the matched text.
function checkFiles({ files, limits, keys }) {
  const blockers = [];
  const warnings = [];
  const names = files.map((f) => f.rel);
  const nameSet = new Set(names);
  if (!names.includes('index.html')) {
    const nested = names.find((n) => /^[^/]+\/index\.html$/.test(n));
    blockers.push({
      rule: 'noIndex',
      message: nested
        ? `index.html is inside ${nested.split('/')[0]}/: publish the contents of that folder, not the folder. The server deletes the live site before it validates, so this upload would leave the site empty.`
        : 'There is no index.html at the root. The server deletes the live site before it validates, so this upload would leave the site empty.',
    });
  }
  for (const f of files) {
    for (const s of SECRET_FILES) {
      if (s.re.test(f.rel)) blockers.push({ rule: s.rule, file: f.rel, message: 'This file must never be published: every file of a site is public.' });
    }
    if (f.size > BIG_FILE_BYTES) warnings.push({ rule: 'bigFile', file: f.rel, message: `${mb(f.size)} MB in one file; visitors download it.` });
    const ext = path.extname(f.rel).toLowerCase();
    if (limits.blockExtensions.length && limits.blockExtensions.includes(ext.replace('.', ''))) {
      blockers.push({ rule: 'blockedExtension', file: f.rel, message: `The account blocks .${ext.replace('.', '')} files; the server would stop the unzip halfway and leave the site broken.` });
    }
    if (ext === '.map') warnings.push({ rule: 'sourceMap', file: f.rel, message: 'Source maps publish your source code. Turn them off in the build unless you need them.' });
    if (f.text === undefined) continue;
    const text = f.text;
    for (const s of SECRET_PATTERNS) {
      const m = s.re.exec(text);
      if (m) blockers.push({ rule: s.rule, file: f.rel, line: lineOf(text, m.index), message: 'Looks like a secret. Every file of a site is public (the gate only guards pages): move it to an Endpoint.' });
    }
    if (keys.some((k) => text.includes(k))) {
      blockers.push({ rule: 'accountApiKey', file: f.rel, message: 'Contains an API key of this account. Remove it; the page must use the visitor\'s session (prolibu-session.js).' });
    }
    for (const r of absoluteRefs(f.rel, text)) {
      const item = { rule: 'absolutePath', file: f.rel, line: r.line, ref: r.ref };
      if (r.tag === 'a') warnings.push({ ...item, message: 'Link to the domain root, outside the site. Use a relative link unless that is intended.' });
      else blockers.push({ ...item, message: 'Absolute path: it loads from the domain root, not the site (blank page, 404). Use a relative path (./…); in Vite set base: \'./\'.' });
    }
    if (ext === '.html' || ext === '.htm') {
      const base = path.posix.dirname(f.rel);
      for (const ref of relativeAssets(text, Infinity)) {
        const target = path.posix.normalize(base === '.' ? ref : `${base}/${ref}`);
        if (!nameSet.has(target)) warnings.push({ rule: 'missingFile', file: f.rel, ref, message: `Loads ${ref}, which is not in the folder: visitors get an error for it.${ref.endsWith('_prolibu_config.js') ? ' A published plain site has no _prolibu_config.js; remove the tag.' : ''}` });
      }
    }
    if (/\/v2\/auth\/login\b/.test(text)) warnings.push({ rule: 'authLogin', file: f.rel, message: '/v2/auth/login does not exist (404). Use the platform sign-in (/v2/auth/signin) through prolibu-session.js.' });
    if (/type\s*=\s*["']password["']/i.test(text)) warnings.push({ rule: 'passwordForm', file: f.rel, message: 'A password field: a site must not ask for passwords (it skips SSO and MFA). Use the sign-in page.' });
    if (/localStorage\.removeItem\(\s*["']apiKey["']/.test(text)) warnings.push({ rule: 'removesSession', file: f.rel, message: 'Removing localStorage.apiKey signs the user out of the app too. Redirect to sign-in instead.' });
    if (/\.map$/.test(f.rel) && /"sourcesContent"\s*:/.test(text)) warnings.push({ rule: 'sourceMapWithSource', file: f.rel, message: 'This map embeds the full source code.' });
    if (limits.scanMaliciousContent === true && SCANNED_EXT.has(ext) && SCANNER_PATTERNS.some((re) => re.test(text))) {
      blockers.push({ rule: 'contentScanner', file: f.rel, message: 'The account\'s content scanner is on and rejects this file (400 "Malicious content detected"). Only an admin can turn it off; do not rewrite the code to get around it.' });
    }
  }
  const index = files.find((f) => f.rel === 'index.html');
  if (index && index.text !== undefined && !/<meta[^>]+name\s*=\s*["']robots["']/i.test(index.text)) {
    warnings.push({ rule: 'noRobotsMeta', file: 'index.html', message: 'The platform sends no X-Robots-Tag. For an internal or private page add <meta name="robots" content="noindex, nofollow"> and <meta name="referrer" content="no-referrer">.' });
  }
  if (files.length > MANY_FILES) warnings.push({ rule: 'manyFiles', message: `${files.length} files: the server stores each one separately and the publish will be slow.` });
  return { blockers, warnings };
}

async function zipFiles(files) {
  // Required lazily so the read-only commands work even without the CLI's dependencies.
  const archiver = require('archiver');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (c) => chunks.push(c));
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const f of files) archive.append(f.buffer, { name: f.rel, date: ZIP_DATE });
    archive.finalize();
  });
}

// Reads the local source into memory and runs every check. Returns what a publish would upload.
async function readSource(src, limits, keys) {
  if (src.kind === 'zip') {
    const zip = fs.readFileSync(src.zipPath);
    const files = readZipEntries(zip);
    const { blockers, warnings } = checkFiles({ files, limits, keys });
    const index = files.find((f) => f.rel === 'index.html' && f.buffer);
    return {
      files, skipped: [], zip, zipSha: sha256(zip), contentHash: sha256(zip), indexHtml: index ? index.buffer.toString('utf8') : null, indexSha: index ? index.sha : null, blockers, warnings,
    };
  }
  if (src.missingBuild) {
    return {
      files: [], skipped: [], zip: null, zipSha: null, contentHash: null, indexHtml: null, indexSha: null, warnings: [],
      blockers: [{ rule: 'noBuild', message: `The build output ${src.build.outputDir}/ does not exist. Run npm install and npm run build in the site folder first.` }],
    };
  }
  const walked = walk(src.dir);
  const files = walked.files.map((f) => {
    const buffer = fs.readFileSync(f.abs);
    const ext = path.extname(f.rel).toLowerCase();
    const text = TEXT_EXT.has(ext) && f.size <= MAX_SCAN_BYTES ? buffer.toString('utf8') : undefined;
    return { ...f, buffer, text, sha: sha256(buffer) };
  });
  const { blockers, warnings } = checkFiles({ files, limits, keys });
  blockers.unshift(...walked.blockers);
  if (src.build) {
    const srcNewest = Math.max(newestMtime(path.join(src.siteFolder, 'src')), newestMtime(path.join(src.siteFolder, 'public')),
      fs.existsSync(path.join(src.siteFolder, 'index.html')) ? fs.statSync(path.join(src.siteFolder, 'index.html')).mtimeMs : 0);
    if (srcNewest > newestMtime(src.dir)) warnings.push({ rule: 'staleBuild', message: `Source files changed after the last build: run npm run build again so ${src.build.outputDir}/ is current.` });
  }
  const zip = files.length ? await zipFiles(files) : null;
  const index = files.find((f) => f.rel === 'index.html');
  return {
    files,
    skipped: walked.skipped,
    zip,
    zipSha: zip ? sha256(zip) : null,
    contentHash: sha256(files.map((f) => `${f.rel}:${f.sha}`).join('\n')),
    indexHtml: index ? index.buffer.toString('utf8') : null,
    indexSha: index ? index.sha : null,
    blockers,
    warnings,
  };
}

function filesSummary(files) {
  const total = files.reduce((s, f) => s + f.size, 0);
  const biggest = [...files].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => ({ file: f.rel, kb: Math.round(f.size / 1024) }));
  return { count: files.length, totalKB: Math.round(total / 1024), biggest, sample: files.slice(0, 15).map((f) => f.rel) };
}

// ─── Account reads ─────────────────────────────────────────────────────────────

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

async function me(client) {
  const body = await call(client, 'GET', '/v2/user/me');
  const p = body.profile || body;
  return { _id: idOf(p), email: p.email };
}

// Upload limits: the size cap is visible to every user; the scanner and blocked extensions only to admins.
async function accountLimits(client) {
  const limits = { maxFileSizeMB: DEFAULT_MAX_MB, blockExtensions: [], scanMaliciousContent: null, known: false };
  const prefs = await call(client, 'GET', '/v2/user/preferences');
  const p = prefs.preferences || prefs;
  const max = Number((((p.modules || {}).tools || {}).cloudDrive || {}).uploadRestrictions?.maxFileSizeMB);
  if (Number.isFinite(max) && max > 0) limits.maxFileSizeMB = max;
  const res = await client.request('GET', '/v2/preference/read');
  if (res.ok) {
    const pref = (res.body && (res.body.preference || res.body)) || {};
    const drive = ((pref.modules || {}).tools || {}).cloudDrive || {};
    const sec = drive.advancedSecurity || {};
    limits.blockExtensions = ((drive.uploadRestrictions || {}).blockExtensions || []).map((e) => String(e).toLowerCase());
    limits.scanMaliciousContent = Boolean(sec.enabled && sec.scanMaliciousContent);
    limits.known = true;
  }
  return limits;
}

async function readSite(client, siteCode) {
  if (!SITE_CODE_RE.test(siteCode || '')) throw new UsageError('Invalid siteCode.');
  const res = await client.request('GET', `/v2/site/${encodeURIComponent(siteCode)}?select=${encodeURIComponent(SITE_SELECT)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`GET /v2/site/${siteCode} answered ${res.status}: ${(res.body && res.body.error) || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function readPackage(client, site) {
  const id = idOf(site && site.package);
  if (!id) return null;
  const res = await client.request('GET', `/v2/file/${encodeURIComponent(id)}`);
  if (!res.ok) return { _id: id, readable: false };
  const f = res.body || {};
  return { _id: id, fileName: f.fileName, size: f.size, sha256: f.sha256 || null, updatedAt: f.updatedAt, url: f.url };
}

const siteView = (s, meId) => ({
  siteCode: s.siteCode,
  siteName: s.siteName,
  siteType: s.siteType || 'Static',
  active: s.active !== false,
  authenticationRequired: Boolean(s.authenticationRequired),
  publicUrl: s.publicUrl || null,
  published: Boolean(s.package),
  mine: meId ? idOf(s.createdBy) === meId : undefined,
  updatedAt: s.updatedAt,
});

// ─── What visitors get ─────────────────────────────────────────────────────────

// Package and asset downloads leave the account's domain: only https storage hosts are fetched.
function storageUrlAllowed(url, domain) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return u.hostname === domain || u.hostname === 's3.amazonaws.com' || /^[a-z0-9.-]+\.amazonaws\.com$/.test(u.hostname);
}

// Fetches the site the way an anonymous visitor does: no key, no cookie, redirects not followed.
async function probeSite(ctx, domain, siteCode, { expectSha, indexHtml } = {}) {
  const url = `https://${domain}/site/${encodeURIComponent(siteCode)}/`;
  const fetchImpl = ctx.publicFetch;
  const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const h = (name) => (res.headers && res.headers.get ? res.headers.get(name) : null);
  const out = { url, status: res.status };
  if (res.status >= 300 && res.status < 400) {
    out.location = h('location');
    out.gated = /^\/v2\/auth\/signin/.test(out.location || '');
  }
  out.headers = {
    'cache-control': h('cache-control'), 'content-type': h('content-type'), 'x-robots-tag': h('x-robots-tag'), 'referrer-policy': h('referrer-policy'),
  };
  const servedSha = h('x-amz-meta-sha256');
  if (res.status === 200 && expectSha) {
    out.servesNewVersion = servedSha ? servedSha === expectSha : null;
    if (!servedSha) out.note = 'The response has no checksum header; compare the page by eye.';
  }
  if (res.status === 403) out.note = 'Storage answered AccessDenied: the site is inactive, its type changed without a new publish, or the path does not exist.';
  if (res.status === 404) out.note = 'Not found: the site does not exist, or it was created less than 60 s ago (the server caches misses). Try again shortly.';
  if (indexHtml && (res.status === 200 || out.gated)) {
    out.assets = [];
    for (const ref of relativeAssets(indexHtml)) {
      const a = await fetchImpl(url + ref, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const loc = a.headers && a.headers.get ? a.headers.get('location') : null;
      let status = a.status;
      if (a.status >= 300 && a.status < 400 && loc && storageUrlAllowed(loc, domain)) {
        const s = await fetchImpl(loc, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        status = s.status;
      }
      out.assets.push({ path: ref, status });
    }
  }
  return out;
}

async function probeUntil(ctx, domain, siteCode, opts, done, delayMs = PROBE_DELAY_MS) {
  let last;
  for (let i = 0; i < PROBE_ATTEMPTS; i += 1) {
    last = await probeSite(ctx, domain, siteCode, opts);
    if (done(last)) return last;
    if (i < PROBE_ATTEMPTS - 1) await ctx.sleep(delayMs);
  }
  return last;
}

function visitorFindings(probe, indexHtml) {
  const out = [];
  const hasMeta = indexHtml && /<meta[^>]+name\s*=\s*["']robots["']/i.test(indexHtml);
  if (probe.status === 200 && !probe.headers['x-robots-tag'] && !hasMeta) {
    out.push('The platform sends no X-Robots-Tag or Referrer-Policy: an ungated site can be indexed if its link is shared. Gate it, or add the robots and referrer meta tags.');
  }
  for (const a of probe.assets || []) if (a.status !== 200) out.push(`Asset ${a.path} answered ${a.status}.`);
  return out;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(client, rest, flags) {
  const who = await me(client);
  const params = new URLSearchParams({ limit: '100', sort: '-updatedAt', select: SITE_SELECT });
  const body = await call(client, 'GET', `/v2/site?${params.toString()}`);
  const rows = Array.isArray(body) ? body : body.data || [];
  const term = (flags.search || '').toLowerCase();
  const sites = rows.map((s) => siteView(s, who._id))
    .filter((s) => !term || `${s.siteCode} ${s.siteName || ''}`.toLowerCase().includes(term));
  return { count: sites.length, sites };
}

async function cmdShow(client, rest, flags, ctx) {
  if (rest.length !== 1) throw new UsageError('Usage: show <domain> <siteCode>');
  const who = await me(client);
  const site = await readSite(client, rest[0]);
  if (!site) throw new Blocked(`There is no site ${rest[0]} on ${client.domain}.`);
  const pkg = await readPackage(client, site);
  const live = site.package ? await probeSite(ctx, client.domain, site.siteCode) : null;
  const { url, ...pkgView } = pkg || {};
  return {
    site: siteView(site, who._id),
    package: pkg ? pkgView : null,
    live,
    backups: listBackups(ctx, client.domain, site.siteCode),
    findings: [
      ...(site.package ? [] : ['Nothing has been published to this site yet.']),
      ...(idOf(site.createdBy) === who._id ? [] : ['Another user created this site: only that user can publish to it (a publish by anyone else fails after the live files were removed).']),
      ...(live ? visitorFindings(live) : []),
    ],
  };
}

async function cmdCheck(client, rest, flags, ctx) {
  if (rest.length !== 1) throw new UsageError('Usage: check <domain> <folder | zip>');
  const src = resolveSource(ctx.rootDir, client.domain, rest[0]);
  const limits = await accountLimits(client);
  const local = await readSource(src, limits, profileKeys(ctx.rootDir, client.domain));
  const blockers = [...local.blockers];
  if (local.zip && local.zip.length > limits.maxFileSizeMB * MB) {
    blockers.push({ rule: 'tooBig', message: `The package is ${mb(local.zip.length)} MB; this account accepts ${limits.maxFileSizeMB} MB per upload (413). Remove big files or ask an admin to raise the limit.` });
  }
  return {
    source: src.kind === 'zip' ? { zip: rest[0] } : { folder: src.dir, build: src.build || null },
    files: filesSummary(local.files),
    skipped: local.skipped,
    packageKB: local.zip ? Math.round(local.zip.length / 1024) : null,
    limits: { maxFileSizeMB: limits.maxFileSizeMB, scannerOn: limits.scanMaliciousContent, blockExtensions: limits.blockExtensions, adminSettingsRead: limits.known },
    blockers,
    warnings: local.warnings,
  };
}

async function buildPlan(client, ctx, siteCode, input, flags) {
  if (!SITE_CODE_RE.test(siteCode || '')) throw new UsageError('Invalid siteCode.');
  const src = resolveSource(ctx.rootDir, client.domain, input);
  const [who, site, limits] = await Promise.all([me(client), readSite(client, siteCode), accountLimits(client)]);
  const local = await readSource(src, limits, profileKeys(ctx.rootDir, client.domain));
  const blockers = [...local.blockers];
  const warnings = [...local.warnings];
  if (local.zip && local.zip.length > limits.maxFileSizeMB * MB) {
    blockers.push({ rule: 'tooBig', message: `The package is ${mb(local.zip.length)} MB; this account accepts ${limits.maxFileSizeMB} MB per upload (413).` });
  }
  if (flags.siteType && !SITE_TYPES.includes(flags.siteType)) throw new UsageError('--site-type must be Static or SPA.');
  const configType = readConfigSiteType(src.siteFolder);
  let siteType;
  if (site) {
    siteType = site.siteType || 'Static';
    if (idOf(site.createdBy) !== who._id) {
      blockers.push({ rule: 'notCreator', message: 'Another user created this site. The server unzips into the publisher\'s drive but looks for index.html in the creator\'s, so the publish would fail after deleting the live files. Publish with the creator\'s profile.' });
    }
    const wanted = flags.siteType || configType;
    if (wanted && wanted !== siteType) {
      warnings.push({ rule: 'siteTypeDiffers', message: `The site is ${siteType} but ${flags.siteType ? '--site-type' : 'config.json'} says ${wanted}. A publish keeps ${siteType}; change it with settings-preview --site-type ${wanted} first.` });
    }
  } else {
    if (!NEW_SITE_CODE_RE.test(siteCode)) throw new UsageError('A new siteCode must be lowercase letters, digits and hyphens (it becomes the URL).');
    siteType = flags.siteType || configType || 'Static';
  }
  const pkg = site ? await readPackage(client, site) : null;
  const siteName = flags.name || (site ? site.siteName : (siteCode.endsWith('-dev') ? `${siteCode.slice(0, -4)} - Dev` : `${siteCode} - Prod`));
  const version = hash({
    contentHash: local.contentHash, siteCode, exists: Boolean(site), updatedAt: site ? site.updatedAt : null, package: pkg ? pkg._id : null, siteType, siteName,
  });
  const { url, ...pkgView } = pkg || {};
  return {
    plan: {
      action: site ? 'replace' : 'create',
      site: site ? siteView(site, who._id) : { siteCode, siteName, siteType, publicUrl: `https://${client.domain}/site/${siteCode}/`, new: true },
      production: isProdCode(siteCode),
      source: src.kind === 'zip' ? { zip: input } : { folder: src.dir, build: src.build || null },
      files: filesSummary(local.files),
      skipped: local.skipped,
      packageKB: local.zip ? Math.round(local.zip.length / 1024) : null,
      replaces: pkg ? { ...pkgView, note: 'Every file of the site is replaced; publish saves this package first so it can be put back.' } : null,
      limits: { maxFileSizeMB: limits.maxFileSizeMB, scannerOn: limits.scanMaliciousContent, adminSettingsRead: limits.known },
      blockers,
      warnings,
    },
    version,
    local,
    site,
    pkg,
    siteType,
    siteName,
  };
}

async function cmdPreview(client, rest, flags, ctx) {
  if (rest.length !== 2) throw new UsageError('Usage: preview <domain> <siteCode> <folder | zip> [--site-type Static|SPA] [--name <siteName>]');
  const built = await buildPlan(client, ctx, rest[0], rest[1], flags);
  const { plan, version } = built;
  const prodFlag = plan.production ? ' --prod' : '';
  return {
    ...plan,
    version,
    nextStep: plan.blockers.length
      ? 'Blocked: explain each blocker to the user in plain words; do not publish until it is solved.'
      : `${STOP}site.js publish ${client.domain} ${rest[0]} ${rest[1]} --version ${version} --confirmed${prodFlag}.${plan.production ? ' This is the production site: it needs its own yes.' : ''}`,
  };
}

const backupDir = (ctx, domain, siteCode) => path.join(ctx.backupRoot, 'prolibu-sites-backups', domain, siteCode);

// Packages saved by earlier publishes of this site on this computer, newest first.
function listBackups(ctx, domain, siteCode) {
  const dir = backupDir(ctx, domain, siteCode);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.zip$/.test(n));
  } catch {
    return [];
  }
  return names.sort().reverse().slice(0, 5).map((n) => {
    const st = fs.statSync(path.join(dir, n));
    return { path: path.join(dir, n), savedAt: st.mtime.toISOString(), KB: Math.round(st.size / 1024) };
  });
}

// The live package is saved before it is replaced: the server keeps no history of a site.
async function backupPackage(ctx, domain, siteCode, pkg) {
  if (!pkg || !pkg.url) throw new Error('The live package could not be read, so it cannot be backed up. Nothing was published.');
  if (!storageUrlAllowed(pkg.url, domain)) throw new Error('The live package is stored on an unexpected host; not downloading it. Nothing was published.');
  const res = await ctx.publicFetch(pkg.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`Downloading the live package answered ${res.status}. Nothing was published.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BACKUP_BYTES) throw new Error('The live package is too big to back up. Nothing was published.');
  const sum = sha256(buf);
  if (pkg.sha256 && sum !== pkg.sha256) throw new Error('The downloaded package does not match its checksum. Nothing was published.');
  const dir = backupDir(ctx, domain, siteCode);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${sum.slice(0, 8)}.zip`);
  fs.writeFileSync(file, buf);
  return { path: file, sha256: sum, size: buf.length };
}

async function cmdPublish(client, rest, flags, ctx) {
  if (rest.length !== 2) throw new UsageError('Usage: publish <domain> <siteCode> <folder | zip> --version <v> --confirmed [--prod]');
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and show it to the user.');
  if (!flags.confirmed) throw new UsageError('Refusing to publish without --confirmed. Show the preview to the user and ask first.');
  const [siteCode, input] = rest;
  if (isProdCode(siteCode) && !flags.prod) {
    throw new UsageError(`${siteCode} is not a -dev site: publishing it needs --prod, given only after the user said yes to publishing production.`);
  }
  const built = await buildPlan(client, ctx, siteCode, input, flags);
  if (built.plan.blockers.length) throw new Blocked(`The preview has blockers: ${built.plan.blockers.map((b) => b.rule).join(', ')}. Nothing was written.`);
  if (built.version !== flags.version) throw new Blocked('The site or the files changed since the preview. Run preview again and show the user the new result. Nothing was written.');
  const { local, site, pkg } = built;
  const { zip } = local;
  const zipSha = sha256(zip);
  const problems = [];
  const backup = site && pkg ? await backupPackage(ctx, client.domain, siteCode, pkg) : null;
  if (!site) {
    await call(client, 'POST', '/v2/site', { data: { siteCode, siteName: built.siteName, siteType: built.siteType }, confirmed: true });
  }
  const form = new FormData();
  form.append('package', new Blob([zip], { type: 'application/zip' }), 'dist.zip');
  const uploader = createClient({
    domain: client.domain,
    rootDir: ctx.rootDir,
    profile: flags.profile,
    fetchImpl: (url, init) => ctx.apiFetch(url, { ...init, body: form }),
    stderr: ctx.stderr,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  const up = await uploader.request('PATCH', `/v2/site/${encodeURIComponent(siteCode)}`, { confirmed: true });
  if (!up.ok) {
    const msg = (up.body && (up.body.error || up.body.message)) || 'no message';
    const err = new Error(`Uploading the package answered ${up.status}: ${msg}.${backup ? ` The server may have removed the live files before failing; to put them back, preview and publish ${backup.path}.` : ''}`);
    err.status = up.status;
    throw err;
  }
  const after = await readSite(client, siteCode);
  const afterPkg = await readPackage(client, after);
  const packageMatches = Boolean(afterPkg && afterPkg.sha256 && afterPkg.sha256 === zipSha);
  if (!packageMatches) problems.push('The package stored on the server does not match what was uploaded.');
  const indexSha = local.indexSha;
  const live = await probeUntil(ctx, client.domain, siteCode, { expectSha: indexSha, indexHtml: local.indexHtml },
    (p) => p.gated || (p.status === 200 && p.servesNewVersion !== false),
    // A new code may sit in the server's 60 s cache of unknown sites.
    site ? PROBE_DELAY_MS : NEW_SITE_PROBE_DELAY_MS);
  if (!(live.status === 200 || live.gated)) problems.push(`The public URL answered ${live.status}${live.note ? `: ${live.note}` : ''}`);
  if (live.servesNewVersion === false) problems.push('The public URL still serves another version of index.html.');
  return {
    saved: true,
    action: site ? 'replaced' : 'created',
    site: siteView(after, null),
    package: { sha256: zipSha, storedMatches: packageMatches, KB: Math.round(zip.length / 1024) },
    backup: backup ? { ...backup, rollback: `Preview and publish ${backup.path} to put the previous version back.` } : null,
    live,
    findings: visitorFindings(live, local.indexHtml),
    problems,
  };
}

function parseOnOff(value, name) {
  if (value === undefined) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new UsageError(`${name} must be on or off.`);
}

async function settingsPlan(client, siteCode, flags) {
  const site = await readSite(client, siteCode);
  if (!site) throw new Blocked(`There is no site ${siteCode} on ${client.domain}.`);
  const want = {};
  const active = parseOnOff(flags.active, '--active');
  const gate = parseOnOff(flags.gate, '--gate');
  if (active !== undefined) want.active = active;
  if (gate !== undefined) want.authenticationRequired = gate;
  if (flags.siteType !== undefined) {
    if (!SITE_TYPES.includes(flags.siteType)) throw new UsageError('--site-type must be Static or SPA.');
    want.siteType = flags.siteType;
  }
  if (!Object.keys(want).length) throw new UsageError('Say what to change: --active on|off, --gate on|off or --site-type Static|SPA.');
  const current = { active: site.active !== false, authenticationRequired: Boolean(site.authenticationRequired), siteType: site.siteType || 'Static' };
  const changes = {};
  for (const [k, v] of Object.entries(want)) if (current[k] !== v) changes[k] = { from: current[k], to: v };
  const effects = [];
  if (changes.active && !want.active) effects.push('Every URL of the site answers 403 at once, until it is turned back on.');
  if (changes.active && want.active) effects.push('The site is served again at once.');
  if (changes.authenticationRequired) effects.push(`${want.authenticationRequired ? 'Anonymous visitors are sent to the sign-in page' : 'Anyone with the link can open the pages'}; it can take up to 60 s. Files (JS, images) stay public either way.`);
  if (changes.siteType) effects.push(`The site answers 403 until it is published again (the ${want.siteType} folder is empty). Publish right after, and change config.json too.`);
  return { site, changes, patch: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])), effects, version: String(site.updatedAt) };
}

async function cmdSettingsPreview(client, rest, flags) {
  if (rest.length !== 1) throw new UsageError('Usage: settings-preview <domain> <siteCode> [--active on|off] [--gate on|off] [--site-type Static|SPA]');
  const p = await settingsPlan(client, rest[0], flags);
  const args = [flags.active && `--active ${flags.active}`, flags.gate && `--gate ${flags.gate}`, flags.siteType && `--site-type ${flags.siteType}`].filter(Boolean).join(' ');
  const prod = isProdCode(rest[0]);
  return {
    site: siteView(p.site, null),
    production: prod,
    changes: p.changes,
    effects: p.effects,
    version: p.version,
    nextStep: Object.keys(p.changes).length
      ? `${STOP}site.js settings ${client.domain} ${rest[0]} ${args} --version ${p.version} --confirmed${prod ? ' --prod' : ''}.`
      : 'Nothing to change: the site already has these settings.',
  };
}

async function cmdSettings(client, rest, flags, ctx) {
  if (rest.length !== 1) throw new UsageError('Usage: settings <domain> <siteCode> [--active on|off] [--gate on|off] [--site-type Static|SPA] --version <v> --confirmed [--prod]');
  if (!flags.version) throw new UsageError('Missing --version. Run settings-preview first.');
  if (!flags.confirmed) throw new UsageError('Refusing to change the site without --confirmed. Show the preview to the user and ask first.');
  if (isProdCode(rest[0]) && !flags.prod) throw new UsageError(`${rest[0]} is not a -dev site: changing it needs --prod, given only after the user said yes.`);
  const p = await settingsPlan(client, rest[0], flags);
  if (p.version !== flags.version) throw new Blocked('The site changed since the preview. Run settings-preview again. Nothing was written.');
  if (!Object.keys(p.patch).length) return { saved: false, site: siteView(p.site, null), note: 'Nothing to change.', problems: [] };
  await call(client, 'PATCH', `/v2/site/${encodeURIComponent(rest[0])}`, { data: p.patch, confirmed: true });
  const after = await readSite(client, rest[0]);
  const problems = [];
  for (const [k, v] of Object.entries(p.patch)) {
    const got = k === 'active' ? after.active !== false : k === 'authenticationRequired' ? Boolean(after.authenticationRequired) : after.siteType;
    if (got !== v) problems.push(`${k} reads ${got} after the change.`);
  }
  let live = null;
  if (after.package) {
    const expectGate = p.patch.authenticationRequired;
    const expected = (r) => {
      if (after.active === false) return r.status === 403 || Boolean(r.gated);
      if (expectGate === true) return Boolean(r.gated);
      if (expectGate === false) return r.status === 200;
      return r.status === 200 || Boolean(r.gated);
    };
    // The gate is read through a cache of up to 60 s; the active switch applies at once.
    live = await probeUntil(ctx, client.domain, rest[0], {}, expected, expectGate === undefined ? PROBE_DELAY_MS : NEW_SITE_PROBE_DELAY_MS);
    if (!expected(live)) problems.push(`Visitors still get ${live.status}${live.gated ? ' (sign-in)' : ''}. The change is saved; the server may still be caching the old settings. Check again with show in a minute.`);
  }
  return { saved: true, site: siteView(after, null), live, note: p.patch.authenticationRequired !== undefined ? 'The gate can take up to 60 s to apply.' : undefined, problems };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = { '--version': 'version', '--search': 'search', '--profile': 'profile', '--site-type': 'siteType', '--name': 'name', '--active': 'active', '--gate': 'gate' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--prod') flags.prod = true;
    else if (valued[arg]) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[valued[arg]] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  list: cmdList,
  show: cmdShow,
  check: cmdCheck,
  preview: cmdPreview,
  publish: cmdPublish,
  'settings-preview': cmdSettingsPreview,
  settings: cmdSettings,
};

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can grant the permission.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: site.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    const apiFetch = opts.fetchImpl || globalThis.fetch;
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: apiFetch, stderr });
    const ctx = {
      rootDir,
      stderr,
      apiFetch,
      publicFetch: opts.publicFetch || opts.fetchImpl || globalThis.fetch,
      sleep: opts.sleep || sleep,
      backupRoot: opts.backupRoot || process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
    };
    const result = await handler(client, rest, flags, ctx);
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (result.blockers && result.blockers.length) return BLOCKED;
    if (result.problems && result.problems.length) return 1;
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
    if (err && err.status === 403) {
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
  main, readZipEntries, absoluteRefs, relativeAssets, checkFiles, storageUrlAllowed, resolveSource,
};
