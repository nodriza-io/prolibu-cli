#!/usr/bin/env node
'use strict';

// Safe wrapper around `./prolibu vt push` for one tour folder, plus the reads the CLI lacks.
//
//   vt.js list    <domain> [--search <text>]
//   vt.js show    <domain> <tour id or code>
//   vt.js preview <domain> <prefix> <folder>        writes nothing; returns a version
//   vt.js push    <domain> <prefix> <folder> --version <v> --confirmed [--accept-losses]
//
// The folder is accounts/<domain>/vt/<prefix>/virtualTours/<folder>. `preview` replays what
// `vt push` will do with it (create or update, what it deletes, what it uploads, what is lost).
// `push` runs `./prolibu vt push --tour <folder>` only when nothing changed since the preview,
// then re-links scenes to their colors (the CLI drops that link on every update) and reads back.
// Exit codes: 0 ok, 1 API or CLI error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createClient, UsageError, DEFAULT_ROOT } = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The CLI parses --tour with minimist: a name made of digits arrives as a number and matches no folder.
const FOLDER_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const BLOCKED = 3;
const THEMES = ['modern', 'flow', 'cascade', 'classic'];
const CONFIG_KEYS = ['theme', 'automotiveColors', 'ui', 'floorPlan', 'hotspots', 'panorama', 'camera', 'sequence', 'customCode'];
// What `vt push` picks up as an image, and what the server accepts on Scene.media / FloorPlan.media.
const CLI_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
const SERVER_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_COLOR_BYTES = 2 * 1024 * 1024;
const AUTOMOTIVE_FOLDERS = [
  { folder: 'external', type: 'external' },
  { folder: 'exterior', type: 'external' },
  { folder: 'internal', type: 'internal' },
  { folder: 'interior', type: 'internal' },
];
const CLI_TIMEOUT_MS = 60 * 60 * 1000;

class Blocked extends Error {}

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

// ─── The CLI's own rules (cli/commands/vt/push.js), replayed without writing ───────────────

function slugToName(slug) {
  return slug.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function nameToSlug(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function listDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function isDir(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function imageFiles(dir) {
  return listDir(dir)
    .filter((f) => CLI_IMAGE_EXT.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))
    .sort();
}

function parseFileName(file) {
  const prefixes = { '2d': '2d_', 360: '360_', sequence: 'seq_' };
  const base = path.basename(file, path.extname(file));
  for (const [sceneType, prefix] of Object.entries(prefixes)) {
    if (base.toLowerCase().startsWith(prefix)) {
      let rest = base.substring(prefix.length);
      if ((sceneType === '2d' || sceneType === '360') && /_\d{1,3}$/.test(rest)) rest = rest.replace(/_\d{1,3}$/, '');
      return { sceneType, sceneName: slugToName(rest), originalName: base };
    }
  }
  return null;
}

function extractNumber(name) {
  const m = name.match(/(\d+)(?:\.\w+)?$/);
  return m ? parseInt(m[1], 10) : null;
}

function groupScenes(files, colorSlug) {
  const scenes = [];
  const seq = [];
  for (const f of files) {
    if (f.sceneType === 'sequence') seq.push(f);
    else scenes.push({ sceneName: f.sceneName || `${slugToName(colorSlug)} ${f.sceneType}`, sceneType: f.sceneType, files: [f.rel] });
  }
  if (seq.length) {
    seq.sort((a, b) => {
      const na = extractNumber(a.originalName);
      const nb = extractNumber(b.originalName);
      if (na !== null && nb !== null) return na - nb;
      return a.originalName.localeCompare(b.originalName);
    });
    let name = seq[0].sceneName;
    if (!name) name = `${slugToName(colorSlug)} Sequence`;
    scenes.push({ sceneName: name, sceneType: 'sequence', files: seq.map((f) => f.rel) });
  }
  return scenes;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Reads the folder the way `vt push` will, and notes everything it skips or the server rejects.
function readLocal(tourDir) {
  const out = {
    config: {}, configText: null, type: 'automotive', colors: [], scenes: [], floorPlans: [],
    skipped: [], blockers: [], warnings: [], files: [],
  };
  const configPath = path.join(tourDir, '_config.json');
  if (fs.existsSync(configPath)) {
    out.configText = fs.readFileSync(configPath, 'utf8');
    try {
      out.config = JSON.parse(out.configText);
    } catch {
      out.blockers.push('_config.json is not valid JSON. The CLI would ignore it silently and use the folder name as the tour name. Fix the file first.');
    }
  } else {
    out.warnings.push('No _config.json: the CLI names the tour after the folder and uses Automotive.');
  }
  out.type = String(out.config.eventType || '').toLowerCase() === 'spaces' ? 'spaces' : 'automotive';
  const track = (rel) => {
    const st = fs.statSync(path.join(tourDir, rel));
    out.files.push({ rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    return st.size;
  };
  const checkMedia = (rel, size, limit = MAX_MEDIA_BYTES) => {
    const ext = path.extname(rel).toLowerCase();
    if (!SERVER_IMAGE_EXT.includes(ext)) out.blockers.push(`${rel}: the server rejects ${ext} files (use jpg, png, webp or gif).`);
    if (size > limit) out.blockers.push(`${rel}: ${(size / 1048576).toFixed(1)} MB is over the ${limit / 1048576} MB limit.`);
  };
  const noteOthers = (dir, relDir) => {
    for (const f of listDir(dir)) {
      const ext = path.extname(f).toLowerCase();
      if (f.startsWith('.') || isDir(path.join(dir, f)) || CLI_IMAGE_EXT.includes(ext)) continue;
      out.skipped.push(`${relDir}/${f}${VIDEO_EXT.includes(ext) ? ' (the CLI does not upload videos)' : ''}`);
    }
  };

  if (out.type === 'spaces') {
    for (const f of imageFiles(path.join(tourDir, 'scenes'))) {
      const rel = `scenes/${f}`;
      checkMedia(rel, track(rel));
      const parsed = parseFileName(f);
      out.scenes.push({
        sceneName: parsed ? parsed.sceneName : slugToName(path.basename(f, path.extname(f))),
        sceneType: parsed ? parsed.sceneType : '360',
        automotiveType: 'external',
        colorSlug: null,
        files: [rel],
      });
    }
    noteOthers(path.join(tourDir, 'scenes'), 'scenes');
    for (const f of imageFiles(path.join(tourDir, '_floorplans'))) {
      const rel = `_floorplans/${f}`;
      checkMedia(rel, track(rel));
      out.floorPlans.push({ floorPlanName: slugToName(path.basename(f, path.extname(f))), file: rel });
    }
    for (const f of listDir(tourDir)) {
      if (isDir(path.join(tourDir, f)) && !['scenes', '_floorplans'].includes(f)) out.skipped.push(`${f}/ (a Spaces tour only reads scenes/ and _floorplans/)`);
    }
    if (isDir(path.join(tourDir, '_colors'))) out.warnings.push('_colors/ is ignored in a Spaces tour.');
    return out;
  }

  const colorKeys = { external: new Set(), internal: new Set() };
  for (const type of ['external', 'internal']) {
    for (const f of imageFiles(path.join(tourDir, '_colors', type))) {
      const rel = `_colors/${type}/${f}`;
      const size = track(rel);
      checkMedia(rel, size, Infinity);
      if (size > MAX_COLOR_BYTES) out.warnings.push(`${rel}: the app limits color images to 2 MB.`);
      const slug = path.basename(f, path.extname(f));
      colorKeys[type].add(slug);
      out.colors.push({ automotiveType: type, slug, name: slugToName(slug), file: rel, sha256: sha256(path.join(tourDir, rel)) });
    }
  }
  for (const { folder, type } of AUTOMOTIVE_FOLDERS) {
    const typeDir = path.join(tourDir, folder);
    if (!isDir(typeDir)) continue;
    for (const colorSlug of listDir(typeDir).filter((f) => isDir(path.join(typeDir, f)))) {
      const colorDir = path.join(typeDir, colorSlug);
      const files = [];
      for (const f of imageFiles(colorDir)) {
        const rel = `${folder}/${colorSlug}/${f}`;
        const parsed = parseFileName(f);
        if (!parsed) {
          out.skipped.push(`${rel} (no 2d_, 360_ or seq_ prefix)`);
          continue;
        }
        checkMedia(rel, track(rel));
        files.push({ ...parsed, rel });
      }
      noteOthers(colorDir, `${folder}/${colorSlug}`);
      if (!files.length) continue;
      const normalized = colorSlug.toLowerCase().replace(/\s+/g, '-');
      let key = null;
      if (colorKeys[type].has(colorSlug)) key = colorSlug;
      else if (colorKeys[type].has(normalized)) key = normalized;
      if (!key && colorKeys[type].size) {
        out.warnings.push(`${folder}/${colorSlug}/ has no matching image in _colors/${type}/: its scenes get no color and show under every color.`);
      }
      for (const s of groupScenes(files, colorSlug)) out.scenes.push({ ...s, automotiveType: type, colorSlug: key });
    }
  }
  for (const f of listDir(tourDir)) {
    const known = ['_colors', 'external', 'exterior', 'internal', 'interior'];
    if (isDir(path.join(tourDir, f)) && !known.includes(f)) {
      out.skipped.push(`${f}/ (the CLI only reads external/, exterior/, internal/ and interior/)`);
    }
  }
  return out;
}

// What the CLI sends on update: name and description when set, and the config merged over its defaults.
function baseConfig(type) {
  const spaces = type === 'spaces';
  return {
    ui: { fullscreen: true, enableRibbon: true, hideRibbonAtStart: false, splash: { enabled: false }, isHideShareButton: false },
    panorama: { tinyPlanet: false, autoRotate: true, autoRotateSpeed: 1 },
    camera: { lockHorizontalFov: spaces, enableLimits: true, limitDown: spaces ? 90 : 50, limitUp: spaces ? 115 : 180, disableZoomInIframe: true },
    sequence: {
      drag: { enabled: true, swipeable: true, speed: 100, reverse: false },
      autoplay: { enabled: false, speed: 100 },
      zoom: { pointerZoom: false, scale: 1.5 },
      ui: { showBadge: false, showFrameIndicator: true },
    },
  };
}

function flatten(value, prefix, out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

function findPopulatedRefs(value, prefix, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value) && value._id && (value.url || value.filename)) {
    out.push(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(value)) findPopulatedRefs(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function checkConfig(local, out) {
  const cfg = local.config.config;
  if (cfg === undefined) return;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    out.blockers.push('"config" in _config.json must be an object.');
    return;
  }
  if (cfg.theme !== undefined && !THEMES.includes(cfg.theme)) {
    out.blockers.push(`config.theme "${cfg.theme}" is not allowed; the server answers 400. Use one of: ${THEMES.join(', ')}.`);
  }
  for (const field of findPopulatedRefs(cfg, 'config')) {
    out.blockers.push(`${field} holds a whole file object (as \`vt pull\` writes it); the server answers 400 "[object Object]". Replace it with its "_id" string.`);
  }
  const unknown = Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k));
  if (unknown.length) out.warnings.push(`config keys the server drops silently: ${unknown.join(', ')}.`);
  if (cfg.automotiveColors) out.warnings.push('config.automotiveColors in _config.json is ignored: colors come from _colors/.');
}

function settingsDiff(local, remote) {
  const changes = [];
  const c = local.config;
  if (c.virtualTourName && c.virtualTourName !== remote.virtualTourName) changes.push({ field: 'virtualTourName', from: remote.virtualTourName, to: c.virtualTourName });
  if (c.description && c.description !== remote.description) changes.push({ field: 'description', from: remote.description || null, to: c.description });
  if (c.config && typeof c.config === 'object') {
    const sent = { ...baseConfig(local.type), ...c.config };
    delete sent.automotiveColors;
    const now = flatten(remote.config || {}, 'config');
    for (const [field, to] of Object.entries(flatten(sent, 'config'))) {
      const from = now[field] === undefined ? null : now[field];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
    }
  }
  return changes;
}

// ─── Remote reads ─────────────────────────────────────────────────────────────────────────

async function viewTour(client, id) {
  const res = await client.request('GET', `/v2/virtualTour/view/${id}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`GET /v2/virtualTour/view answered ${res.status}`);
  return res.body && res.body._id ? res.body : null;
}

async function findByCode(client, code) {
  const q = new URLSearchParams({ xquery: JSON.stringify({ virtualTourCode: code }), limit: '1', select: '_id virtualTourCode virtualTourName' });
  const body = await call(client, 'GET', `/v2/virtualtour?${q}`);
  return (body.data || [])[0] || null;
}

function colorSlugs(color) {
  const slugs = new Set();
  if (color && color.url) {
    try {
      const base = decodeURIComponent(new URL(color.url).pathname.split('/').pop());
      slugs.add(base.replace(/\.[^.]+$/, ''));
    } catch { /* not a URL */ }
  }
  if (color && color.meta && color.meta.name) slugs.add(nameToSlug(color.meta.name));
  return slugs;
}

function viewerLink(domain, id) {
  return `https://${domain}/ui/spa/virtualTour/view/${id}`;
}

function summarizeScene(s) {
  const lost = [];
  if ((s.spots || []).length) lost.push(`${s.spots.length} hotspot(s)`);
  if (s.camera && typeof s.camera === 'object' && Object.keys(s.camera).length) lost.push('its initial view');
  if (s.thumbnail) lost.push('its own thumbnail');
  if ((s.media || []).some((m) => String(m && m.mimeType).startsWith('video/'))) lost.push('video media (the CLI does not upload videos)');
  if (['details', 'imperfections', 'engine'].includes(s.automotiveType)) lost.push(`the "${s.automotiveType}" group (the CLI only creates external/internal scenes)`);
  return lost;
}

async function sharedScenes(client, tourId, sceneIds) {
  if (!sceneIds.length) return [];
  const q = new URLSearchParams({
    xquery: JSON.stringify({ $and: [{ scenes: { $in: sceneIds } }, { _id: { $ne: tourId } }] }),
    select: '_id virtualTourName virtualTourCode',
    limit: '20',
  });
  const body = await call(client, 'GET', `/v2/virtualtour?${q}`);
  return (body.data || []).filter((t) => t._id !== tourId);
}

// ─── Plan ─────────────────────────────────────────────────────────────────────────────────

function tourDirOf(rootDir, domain, prefix, folder) {
  if (!PREFIX_RE.test(String(prefix || ''))) throw new UsageError('Invalid <prefix>: letters, digits, dot, dash or underscore.');
  if (!FOLDER_RE.test(String(folder || ''))) {
    throw new UsageError('Invalid <folder>: it must start with a letter and use only letters, digits, dot, dash or underscore (the CLI cannot select other names).');
  }
  const dir = path.join(rootDir, 'accounts', domain, 'vt', prefix, 'virtualTours', folder);
  if (!isDir(dir)) throw new UsageError(`Tour folder not found: accounts/${domain}/vt/${prefix}/virtualTours/${folder}`);
  return dir;
}

async function buildPlan(client, domain, prefix, folder, rootDir) {
  const tourDir = tourDirOf(rootDir, domain, prefix, folder);
  const local = readLocal(tourDir);
  const blockers = [...local.blockers];
  const warnings = [...local.warnings];
  const losses = [];
  checkConfig(local, { blockers, warnings });

  const code = local.config.virtualTourCode || folder;
  let remote = null;
  let matchedBy = null;
  if (local.config._id) {
    if (!ID_RE.test(String(local.config._id))) blockers.push('_id in _config.json is not a valid id. Remove it or restore the real one.');
    else remote = await viewTour(client, local.config._id);
    if (remote) matchedBy = '_id';
  }
  if (!remote) {
    const found = await findByCode(client, code);
    if (found) {
      remote = await viewTour(client, found._id);
      matchedBy = 'virtualTourCode';
    }
  }
  if (local.config._id && matchedBy !== '_id') {
    blockers.push(`_config.json points to tour ${local.config._id}, which no longer exists. The CLI would not fix that link. Remove "_id" from _config.json (and check the code) before pushing.`);
  }
  if (matchedBy === 'virtualTourCode' && !local.config._id) {
    blockers.push(`This folder is not linked to a tour (_config.json has no "_id"), but its code "${code}" belongs to the existing tour "${remote.virtualTourName}" (${remote._id}). Pushing would replace that tour's scenes. If it is the same tour, add "_id": "${remote._id}" to _config.json after the user confirms; if it is a new tour, change "virtualTourCode" or the folder name.`);
  }

  const plan = {
    action: remote ? 'update' : 'create',
    folder: `accounts/${domain}/vt/${prefix}/virtualTours/${folder}`,
    type: local.type === 'spaces' ? 'Spaces' : 'Automotive',
    tour: remote
      ? { _id: remote._id, virtualTourCode: remote.virtualTourCode, virtualTourName: remote.virtualTourName, eventType: remote.eventType || null, matchedBy, link: viewerLink(domain, remote._id) }
      : { virtualTourCode: code, virtualTourName: local.config.virtualTourName || slugToName(folder) },
    upload: {
      colors: local.colors.map(({ sha256: _s, ...c }) => c),
      scenes: local.scenes.map((s) => ({ ...s, frames: s.files.length })),
      floorPlans: local.floorPlans,
    },
    remove: { scenes: [], floorPlans: [] },
    settingsChanged: [],
    skipped: local.skipped,
    losses,
    warnings,
    blockers,
  };

  const remoteColors = { external: [], internal: [] };
  if (remote) {
    const remoteType = remote.eventType === 'Spaces' ? 'spaces' : 'automotive';
    if (remote.eventType && remoteType !== local.type) {
      blockers.push(`The tour is ${remote.eventType} but _config.json says ${plan.type}. The CLI reads the folder as ${plan.type} and would rebuild it wrong. Set "eventType" to "${remote.eventType}".`);
    }
    if (remote.virtualTourCode && local.config.virtualTourCode && remote.virtualTourCode !== local.config.virtualTourCode) {
      warnings.push(`The CLI does not change codes: the tour keeps "${remote.virtualTourCode}".`);
    }
    plan.settingsChanged = settingsDiff(local, remote);
    const scenes = remote.scenes || [];
    const colorName = {};
    for (const type of ['external', 'internal']) {
      for (const c of ((remote.config || {}).automotiveColors || {})[type] || []) {
        if (c && c._id) {
          remoteColors[type].push(c);
          colorName[c._id] = (c.meta && c.meta.name) || c._id;
        }
      }
    }
    for (const s of scenes) {
      const lost = summarizeScene(s);
      plan.remove.scenes.push({
        _id: s._id, sceneName: s.sceneName, sceneType: s.sceneType, automotiveType: s.automotiveType,
        color: s.automotiveColor ? colorName[s.automotiveColor] || s.automotiveColor : null, frames: (s.media || []).length,
      });
      if (lost.length) losses.push(`Scene "${s.sceneName}" (${s.automotiveType || 'external'}): ${lost.join(', ')}.`);
    }
    if (local.type === 'spaces') {
      for (const fp of remote.floorPlans || []) {
        plan.remove.floorPlans.push({ _id: fp._id, floorPlanName: fp.floorPlanName });
        if ((fp.spots || []).length) losses.push(`Floor plan "${fp.floorPlanName}": ${fp.spots.length} hotspot(s).`);
      }
    }
    if (scenes.length && !local.scenes.length) {
      blockers.push(`No images to upload in this folder, but the tour has ${scenes.length} scene(s): the CLI would delete them all and upload nothing. Download the tour first (vt download) or add the images.`);
    }
    if (scenes.length && local.scenes.length) {
      const before = scenes.map((s) => s.sceneName);
      const after = local.scenes.map((s) => s.sceneName);
      if (before[0] !== after[0]) warnings.push(`The tour will open on "${after[0]}" instead of "${before[0]}": the CLI orders scenes by folder and file name.`);
      const renamed = before.filter((n) => !after.includes(n));
      if (renamed.length) warnings.push(`Scene names are rebuilt from file names; these names disappear: ${renamed.map((n) => `"${n}"`).join(', ')}.`);
    }
    if (scenes.some((s) => (s.spots || []).length)) {
      warnings.push('Navigation hotspots in other scenes that point to a deleted scene stop working.');
    }
    const shared = await sharedScenes(client, remote._id, scenes.map((s) => s._id));
    if (shared.length) {
      blockers.push(`Some scenes are also used by ${shared.map((t) => `"${t.virtualTourName}" (${t._id})`).join(', ')}. The CLI would delete them for that tour too. Change these tours in the app.`);
    }
    if (local.type === 'automotive') {
      const localSlugs = { external: new Set(), internal: new Set() };
      for (const c of local.colors) localSlugs[c.automotiveType].add(c.slug);
      for (const type of ['external', 'internal']) {
        for (const c of remoteColors[type]) {
          const kept = [...colorSlugs(c)].some((s) => localSlugs[type].has(s));
          if (!kept && local.colors.length) losses.push(`Color "${(c.meta && c.meta.name) || c._id}" (${type}) is not in _colors/${type}/ and leaves the tour.`);
        }
      }
      if (!local.colors.length && (remoteColors.external.length || remoteColors.internal.length)) {
        losses.push('No _colors/ images: the new scenes have no color, so the tour shows no color choice.');
      }
      for (const c of local.colors) {
        const prev = remoteColors[c.automotiveType].find((rc) => colorSlugs(rc).has(c.slug));
        if (prev) {
          c.keeps = prev._id;
          plan.upload.colors.find((u) => u.file === c.file).status = 'existing: the tour keeps its current color';
          const file = await client.request('GET', `/v2/file/${prev._id}`);
          const stored = file.ok && file.body ? file.body.sha256 : null;
          if (stored && stored !== c.sha256) warnings.push(`${c.file} differs from the color already on the tour; the old image stays. Change a color image in the app.`);
        } else {
          plan.upload.colors.find((u) => u.file === c.file).status = 'new (swatch hex #000000; set the real hex in the app)';
        }
      }
    }
  } else if (local.type === 'automotive') {
    for (const c of plan.upload.colors) c.status = 'new (swatch hex #000000; set the real hex in the app)';
  }

  const version = crypto.createHash('sha256').update(JSON.stringify({
    remote: remote ? {
      _id: remote._id, updatedAt: remote.updatedAt, scenes: (remote.scenes || []).map((s) => s._id), floorPlans: (remote.floorPlans || []).map((f) => f._id),
    } : { none: code },
    config: local.configText,
    files: local.files,
    plan: [plan.remove, plan.upload, plan.settingsChanged, losses, blockers],
  })).digest('hex').slice(0, 16);

  return { plan, version, local, remote, remoteColors };
}

// ─── Commands ─────────────────────────────────────────────────────────────────────────────

async function cmdList(client, rest, flags) {
  if (rest.length) throw new UsageError('Usage: list <domain> [--search <text>]');
  const tours = [];
  for (let page = 1; page < 100; page += 1) {
    const q = new URLSearchParams({
      select: 'virtualTourName virtualTourCode eventType scenes floorPlans updatedAt', sort: '-updatedAt', limit: '100', page: String(page),
    });
    const body = await call(client, 'GET', `/v2/virtualtour?${q}`);
    for (const t of body.data || []) {
      tours.push({
        _id: t._id, virtualTourCode: t.virtualTourCode, virtualTourName: t.virtualTourName, eventType: t.eventType || null,
        scenes: (t.scenes || []).length, floorPlans: (t.floorPlans || []).length, updatedAt: t.updatedAt, link: viewerLink(client.domain, t._id),
      });
    }
    const p = body.pagination || {};
    if (!p.lastPage || page >= p.lastPage) break;
  }
  const term = flags.search ? nameToSlug(flags.search) : '';
  const shown = term ? tours.filter((t) => nameToSlug(`${t.virtualTourName} ${t.virtualTourCode}`).includes(term)) : tours;
  return { count: shown.length, total: tours.length, tours: shown };
}

async function cmdShow(client, [ref]) {
  if (!ref) throw new UsageError('Usage: show <domain> <tour id or code>');
  let id = ID_RE.test(ref) ? ref : null;
  if (!id) {
    const found = await findByCode(client, ref);
    if (!found) throw new Blocked(`No tour with code "${ref}".`);
    id = found._id;
  }
  const t = await viewTour(client, id);
  if (!t) throw new Blocked(`No tour ${id}.`);
  const colors = [];
  for (const type of ['external', 'internal']) {
    for (const c of ((t.config || {}).automotiveColors || {})[type] || []) {
      colors.push({ _id: c._id, automotiveType: type, name: c.meta && c.meta.name, hex: c.meta && c.meta.hex, code: c.meta && c.meta.code });
    }
  }
  const colorName = Object.fromEntries(colors.map((c) => [c._id, c.name]));
  return {
    _id: t._id,
    virtualTourCode: t.virtualTourCode,
    virtualTourName: t.virtualTourName,
    description: t.description || null,
    eventType: t.eventType || null,
    theme: (t.config || {}).theme,
    updatedAt: t.updatedAt,
    link: viewerLink(client.domain, t._id),
    colors,
    scenes: (t.scenes || []).map((s) => ({
      _id: s._id, sceneName: s.sceneName, sceneType: s.sceneType, automotiveType: s.automotiveType,
      color: s.automotiveColor ? colorName[s.automotiveColor] || s.automotiveColor : null,
      frames: (s.media || []).length, hotspots: (s.spots || []).length, lostOnPush: summarizeScene(s),
    })),
    floorPlans: (t.floorPlans || []).map((f) => ({ _id: f._id, floorPlanName: f.floorPlanName, hotspots: (f.spots || []).length })),
  };
}

async function cmdPreview(client, rest, flags, ctx) {
  if (rest.length !== 2) throw new UsageError('Usage: preview <domain> <prefix> <folder>');
  const { plan, version } = await buildPlan(client, client.domain, rest[0], rest[1], ctx.rootDir);
  return {
    ...plan,
    version,
    nextStep: plan.blockers.length
      ? 'Blocked: explain each blocker to the user; do not push.'
      : `Tell the user what is created, deleted, uploaded and changed${plan.losses.length ? ', and every loss (they need their own yes)' : ''}. STOP HERE and end your turn; never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message run push with --version ${version}${plan.losses.length ? ' and --accept-losses' : ''}.`,
  };
}

function runCliDefault({ rootDir, domain, prefix, folder }) {
  const res = spawnSync(process.execPath, [path.join(rootDir, 'prolibu'), 'vt', 'push', '--domain', domain, '--prefix', prefix, '--tour', folder], {
    cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}${res.error ? `\n${res.error.message}` : ''}` };
}

// The CLI re-uploads every _colors/ image on each push. An image already uploaded to the same path
// answers 400 (the file exists), the CLI leaves those scenes without color and keeps going. This puts
// back the colors the tour already had and links each new scene to its folder's color.
async function relinkColors(client, tourId, built, after) {
  const { local, remoteColors } = built;
  const done = { tourColors: false, scenes: 0, unusedColorFiles: [] };
  const problems = [];
  if (local.type !== 'automotive' || !local.colors.length) return { done, problems };
  const beforeIds = new Set([...remoteColors.external, ...remoteColors.internal].map((c) => c._id));
  const afterColors = (after.config || {}).automotiveColors || {};
  const wanted = { external: [], internal: [] };
  const idFor = { external: {}, internal: {} };
  for (const c of local.colors) {
    let id = c.keeps;
    if (!id) {
      const fresh = (afterColors[c.automotiveType] || []).find((ac) => ac && !beforeIds.has(ac._id) && colorSlugs(ac).has(c.slug));
      id = fresh && fresh._id;
    }
    if (!id) {
      problems.push(`Color ${c.file} was not uploaded; its scenes have no color.`);
      continue;
    }
    idFor[c.automotiveType][c.slug] = id;
    if (!wanted[c.automotiveType].includes(id)) wanted[c.automotiveType].push(id);
  }
  const current = { external: (afterColors.external || []).map((c) => c._id), internal: (afterColors.internal || []).map((c) => c._id) };
  const keep = new Set([...wanted.external, ...wanted.internal]);
  done.unusedColorFiles = [...current.external, ...current.internal].filter((id) => !keep.has(id) && !beforeIds.has(id));
  if (JSON.stringify(current) !== JSON.stringify(wanted)) {
    await call(client, 'PATCH', `/v2/virtualtour/${tourId}`, { data: { config: { automotiveColors: wanted } }, confirmed: true });
    done.tourColors = true;
  }
  const scenes = after.scenes || [];
  const sameShape = scenes.length === local.scenes.length
    && scenes.every((s, i) => s.sceneName === local.scenes[i].sceneName && s.sceneType === local.scenes[i].sceneType);
  if (!sameShape) {
    problems.push('The uploaded scenes do not match the folder one to one, so their colors were not re-linked. Check the colors in the app.');
    return { done, problems };
  }
  for (let i = 0; i < scenes.length; i += 1) {
    const exp = local.scenes[i];
    const want = exp.colorSlug ? idFor[exp.automotiveType][exp.colorSlug] || null : null;
    if ((scenes[i].automotiveColor || null) !== want) {
      await call(client, 'PATCH', `/v2/scene/${scenes[i]._id}`, { data: { automotiveColor: want }, confirmed: true });
      done.scenes += 1;
    }
  }
  return { done, problems };
}

async function cmdPush(client, rest, flags, ctx) {
  if (rest.length !== 2) throw new UsageError('Usage: push <domain> <prefix> <folder> --version <v> --confirmed [--accept-losses]');
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const [prefix, folder] = rest;
  const built = await buildPlan(client, client.domain, prefix, folder, ctx.rootDir);
  const { plan } = built;
  if (built.version !== flags.version) throw new Blocked('The folder or the tour changed since the preview. Preview again and show the user.');
  if (plan.blockers.length) throw new Blocked(plan.blockers.join(' '));
  if (plan.losses.length && !flags.acceptLosses) {
    throw new Blocked(`This push loses work done in the app: ${plan.losses.join(' ')} Ask the user; only after their yes to these losses add --accept-losses.`);
  }

  const cli = (ctx.runCli || runCliDefault)({ rootDir: ctx.rootDir, domain: client.domain, prefix, folder });
  const output = client.redact(cli.output || '');
  const cliWarnings = output.split('\n').map((l) => l.trim()).filter((l) => /failed|❌|⚠️/i.test(l));
  const problems = [];
  if (cli.status !== 0) problems.push(`The CLI exited with code ${cli.status}.`);

  const configPath = path.join(ctx.rootDir, plan.folder, '_config.json');
  let tourId = plan.tour._id;
  if (!tourId && fs.existsSync(configPath)) {
    try {
      tourId = JSON.parse(fs.readFileSync(configPath, 'utf8'))._id;
    } catch { /* reported below */ }
  }
  if (!tourId) {
    const found = await findByCode(client, plan.tour.virtualTourCode);
    tourId = found && found._id;
  }
  if (!tourId) {
    return { saved: false, action: plan.action, problems: [...problems, 'No tour was found after the push.'], cliWarnings, cliOutputTail: output.split('\n').slice(-15) };
  }

  let after = await viewTour(client, tourId);
  const relink = after ? await relinkColors(client, tourId, built, after) : { done: {}, problems: [] };
  problems.push(...relink.problems);
  if (relink.done.tourColors || relink.done.scenes) after = await viewTour(client, tourId);
  if (!after) problems.push('The tour could not be read back.');
  const scenes = (after && after.scenes) || [];
  const floorPlans = (after && after.floorPlans) || [];
  if (after && scenes.length !== plan.upload.scenes.length) problems.push(`${scenes.length} of ${plan.upload.scenes.length} scenes are on the tour.`);
  if (after && plan.type === 'Spaces' && floorPlans.length !== plan.upload.floorPlans.length) {
    problems.push(`${floorPlans.length} of ${plan.upload.floorPlans.length} floor plans are on the tour.`);
  }
  let linked = null;
  if (after && plan.type === 'Automotive') {
    const ac = (after.config && after.config.automotiveColors) || {};
    const ids = new Set([...(ac.external || []), ...(ac.internal || [])].map((c) => c._id));
    linked = scenes.filter((s) => s.automotiveColor && ids.has(s.automotiveColor)).length;
    const expected = built.local.scenes.filter((s) => s.colorSlug).length;
    if (linked !== expected && !relink.problems.length) problems.push(`${linked} of ${expected} scenes are linked to their color.`);
  }
  return {
    saved: problems.length === 0,
    action: plan.action,
    tour: after ? {
      _id: after._id, virtualTourCode: after.virtualTourCode, virtualTourName: after.virtualTourName, eventType: after.eventType, link: viewerLink(client.domain, after._id),
    } : { _id: tourId },
    scenes: scenes.length,
    floorPlans: floorPlans.length,
    colors: after && after.config && after.config.automotiveColors
      ? (after.config.automotiveColors.external || []).length + (after.config.automotiveColors.internal || []).length : 0,
    scenesWithColor: linked,
    relinked: relink.done,
    cliWarnings,
    problems,
  };
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
    else if (arg === '--accept-losses') flags.acceptLosses = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--search') flags.search = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = { list: cmdList, show: cmdShow, preview: cmdPreview, push: cmdPush };

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError('Usage: vt.js <list|show|preview|push> <domain> …');
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir, runCli: opts.runCli });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'push' && !result.saved) return 1;
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

module.exports = { main, readLocal, settingsDiff, parseFileName, colorSlugs };
