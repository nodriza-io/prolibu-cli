#!/usr/bin/env node
'use strict';

// Renders a local site folder in headless Chrome as the account would serve it, at several
// screen widths, measures the layout problems a reviewer would catch (content cut off, cards of
// different heights, misaligned buttons, too many primary buttons or accent colors, tiny text,
// broken images) and saves a screenshot per width to look at. Nothing is published.
//
// The page is served from https://<domain>/site/__ui-review__/ by intercepting the requests, so
// /ui/static/cobalt and the API answer for real. With a profile the page gets that profile's key
// as its session (only inside this temporary browser) and every request that would change data
// is blocked, so a review never writes to the account.
//
//   node .claude/skills/_shared/ui-review.js <domain> <site folder>
//        [--widths 1920,1440,1024,390] [--height 900] [--wait 3000] [--profile <name>] [--no-session] [--out <dir>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadApiKey, validateTarget, UsageError, DEFAULT_ROOT } = require('./prolibu-api');

const REVIEW_PREFIX = '/site/__ui-review__/';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROFILE_RE = /^[a-z0-9-]+$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

function parseArgs(argv) {
  const opts = { widths: [1920, 1440, 1024, 390], height: 900, wait: 3000, session: true, profile: undefined, out: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--widths') {
      opts.widths = value().split(',').map((w) => Number(w.trim()));
      if (!opts.widths.length || opts.widths.some((w) => !Number.isInteger(w) || w < 320 || w > 2560)) {
        throw new UsageError('--widths takes whole numbers between 320 and 2560, separated by commas.');
      }
    } else if (arg === '--height') {
      opts.height = Number(value());
      if (!Number.isInteger(opts.height) || opts.height < 400 || opts.height > 2000) throw new UsageError('--height takes a number between 400 and 2000.');
    } else if (arg === '--wait') {
      opts.wait = Number(value());
      if (!Number.isInteger(opts.wait) || opts.wait < 0 || opts.wait > 30000) throw new UsageError('--wait takes milliseconds between 0 and 30000.');
    } else if (arg === '--profile') {
      opts.profile = value();
      if (!PROFILE_RE.test(opts.profile)) throw new UsageError('Invalid profile name. Use lowercase letters, digits and hyphens.');
    } else if (arg === '--no-session') {
      opts.session = false;
    } else if (arg === '--out') {
      opts.out = value();
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new UsageError('Usage: ui-review.js <domain> <site folder> [--widths 1920,1440,1024,390] [--profile <name>] [--no-session] [--out <dir>]');
  const [domain, folder] = positional;
  validateTarget(domain, '/v2/');
  return { domain, folder, ...opts };
}

function isInside(child, dir) {
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The folder the platform would serve: public/, the build output of a build-tool site, or the folder itself.
function resolveServedDir(folder, rootDir = DEFAULT_ROOT) {
  const abs = fs.realpathSync(path.resolve(folder));
  if (!isInside(abs, fs.realpathSync(rootDir))) throw new UsageError('The site folder must be inside this repository.');
  const candidates = [];
  const pkgPath = path.join(abs, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let outputDir = 'dist';
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(abs, 'settings.json'), 'utf8'));
      if (settings.outputDir) outputDir = String(settings.outputDir);
    } catch {
      // No settings.json: dist, like the CLI.
    }
    if (path.isAbsolute(outputDir) || outputDir.split(/[\\/]/).includes('..')) throw new UsageError('settings.json outputDir must be a folder inside the site.');
    candidates.push(path.join(abs, outputDir));
  }
  candidates.push(path.join(abs, 'public'), abs);
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (!dir) throw new UsageError('No index.html in the folder, its public/ or its build output. Build the site first.');
  return dir;
}

// Maps a request path under the review prefix to a file of the served folder; null when outside it.
function fileForPath(servedDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(REVIEW_PREFIX.length));
  } catch {
    return null;
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(servedDir, rel);
  return isInside(file, servedDir) ? file : null;
}

// Hue family of a CSS rgb()/rgba() color, or null for grays, near-white, near-black and faint colors.
function hueFamily(css) {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(css || '');
  if (!m) return null;
  let alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4] && m[4].endsWith('%')) alpha /= 100;
  if (alpha < 0.5) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.3 || l < 0.15 || l > 0.92) return null;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const families = [[15, 'red'], [45, 'orange'], [70, 'yellow'], [170, 'green'], [200, 'teal'], [255, 'blue'], [290, 'purple'], [345, 'pink'], [360, 'red']];
  return families.find(([limit]) => h < limit)[1];
}

// Runs inside the page. Self-contained: it is serialized with toString().
function auditPage(hueFamilySource) {
  // eslint-disable-next-line no-new-func
  const hueFamilyIn = new Function(`return (${hueFamilySource})`)();
  const vw = document.documentElement.clientWidth;
  const findings = [];
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    else if (el.classList && el.classList.length) s += `.${[...el.classList].slice(0, 2).join('.')}`;
    const text = String(el.getAttribute('label') || el.label || el.getAttribute('heading') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return text ? `${s} "${text}"` : s;
  };
  const everything = [];
  (function walk(root) {
    for (const el of root.querySelectorAll('*')) {
      everything.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }(document));
  const light = [...document.body.querySelectorAll('*')].filter(isVisible);

  // 1) Anything past the right edge of the screen, scrollable or clipped.
  const scrollWidth = document.documentElement.scrollWidth;
  const past = light.filter((el) => el.getBoundingClientRect().right > vw + 1);
  const outermost = past.filter((el) => !past.includes(el.parentElement));
  if (outermost.length || scrollWidth > vw + 1) {
    findings.push({
      rule: 'cutOff',
      message: `Content goes past the right edge (${Math.max(scrollWidth, ...past.map((el) => Math.round(el.getBoundingClientRect().right))) - vw}px): it is cut or scrolls sideways. Grid columns need minmax(0, 1fr), flex children min-width: 0, and rows of chips or buttons must wrap.`,
      elements: outermost.slice(0, 6).map(describe),
    });
  }

  // 2) and 3) Cards in the same row: same height, actions on the same line.
  const visualBox = (el) => {
    const card = el.tagName === 'CO-CARD' ? el : el.querySelector('co-card') || el;
    const inner = card.shadowRoot && [...card.shadowRoot.children].find((c) => !['STYLE', 'SLOT', 'LINK'].includes(c.tagName));
    return (inner || card).getBoundingClientRect();
  };
  const uneven = [];
  const misaligned = [];
  for (const container of light) {
    const cs = getComputedStyle(container);
    const isGrid = cs.display.includes('grid');
    const isWrapFlex = cs.display.includes('flex') && cs.flexWrap === 'wrap' && cs.flexDirection.startsWith('row');
    if (!isGrid && !isWrapFlex) continue;
    const kids = [...container.children].filter(isVisible);
    // A row of cards: every child is a co-card, or a wrapper whose only element is a co-card.
    const isCard = (k) => k.tagName === 'CO-CARD' || (k.children.length === 1 && k.firstElementChild.tagName === 'CO-CARD');
    if (kids.length < 2 || !kids.every(isCard)) continue;
    const rows = new Map();
    for (const kid of kids) {
      const key = Math.round(kid.getBoundingClientRect().top / 8);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(kid);
    }
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      const heights = row.map((k) => Math.round(visualBox(k).height));
      const spread = Math.max(...heights) - Math.min(...heights);
      if (spread > 4) uneven.push({ container: describe(container), heights });
      const bottoms = row.map((k) => {
        const buttons = [...k.querySelectorAll('co-button, button')].filter(isVisible);
        return buttons.length ? Math.round(buttons[buttons.length - 1].getBoundingClientRect().bottom) : null;
      }).filter((v) => v !== null);
      if (bottoms.length > 1 && Math.max(...bottoms) - Math.min(...bottoms) > 4) misaligned.push({ container: describe(container), bottoms });
    }
  }
  if (uneven.length) {
    findings.push({
      rule: 'unevenCards',
      message: 'Cards in the same row have different heights. Give co-card the stretch attribute and let the grid stretch the rows; put the variable content in the middle and push the footer down (margin-top: auto).',
      rows: uneven.slice(0, 4),
    });
  }
  if (misaligned.length) {
    findings.push({
      rule: 'misalignedActions',
      message: 'The buttons of cards in the same row sit at different heights. Pin each card footer to the bottom so prices and actions line up.',
      rows: misaligned.slice(0, 4),
    });
  }

  // 4) One primary action per view.
  const primaries = light.filter((el) => el.tagName === 'CO-BUTTON' && (el.getAttribute('variant') || 'primary') === 'primary');
  if (primaries.length > 1) {
    findings.push({
      rule: 'tooManyPrimaryButtons',
      message: `${primaries.length} primary buttons on screen (co-button is primary when it has no variant). Keep one for the main action; repeated actions (per card, per row) use secondary, soft or ghost.`,
      elements: [...new Set(primaries.map(describe))].slice(0, 6),
    });
  }

  // 5) Accent colors: one brand accent plus status colors where they mean a status.
  const families = new Map();
  for (const el of everything) {
    if (!(el instanceof Element) || !isVisible(el)) continue;
    const cs = getComputedStyle(el);
    const colors = [cs.backgroundColor];
    if (el.childNodes && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) colors.push(cs.color);
    for (const c of colors) {
      const family = hueFamilyIn(c);
      if (!family) continue;
      if (!families.has(family)) families.set(family, { count: 0, example: describe(el.getRootNode().host || el) });
      families.get(family).count += 1;
    }
  }
  if (families.size > 2) {
    findings.push({
      rule: 'tooManyColors',
      message: `${families.size} color families on screen. Use neutrals plus one accent; status colors (warning, error, success) only for a real status, never to tell categories apart.`,
      families: Object.fromEntries(families),
    });
  }

  // 5b) Chips and badges colored by category: status colors only mean a status.
  const tinted = light.filter((el) => /^CO-(CHIP|BADGE)$/.test(el.tagName)
    && !['', 'default', 'primary'].includes(String(el.getAttribute('color') || el.color || '')));
  const tints = [...new Set(tinted.map((el) => String(el.getAttribute('color') || el.color)))];
  if (tints.length > 1) {
    findings.push({
      rule: 'coloredCategories',
      message: `Chips or badges in ${tints.length} status colors (${tints.join(', ')}). Tiers, types and tags are neutral (color default); warning, error, success and info are for a status the user must act on.`,
      elements: tinted.slice(0, 6).map(describe),
    });
  }

  // 5c) Dark blocks on a light page (usually --co-semantic-surface-primary, which is black).
  const luminance = (css) => {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(css || '');
    if (!m || (m[4] !== undefined && parseFloat(m[4]) < 0.5)) return null;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
  };
  const pageLum = luminance(getComputedStyle(document.body).backgroundColor) ?? 1;
  if (pageLum > 0.7) {
    const area = vw * window.innerHeight;
    const dark = light.filter((el) => {
      const r = el.getBoundingClientRect();
      const lum = luminance(getComputedStyle(el).backgroundColor);
      return lum !== null && lum < 0.3 && r.width * r.height > area * 0.04;
    });
    const outer = dark.filter((el) => !dark.some((other) => other !== el && other.contains(el)));
    if (outer.length) {
      findings.push({
        rule: 'darkSurface',
        message: 'Large dark blocks on a light page. --co-semantic-surface-primary is the black fill of primary buttons; panels, headers and cards use surface-page or surface-secondary.',
        elements: outer.slice(0, 6).map(describe),
      });
    }
  }

  // 6) Text too small to read.
  const small = light.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    && parseFloat(getComputedStyle(el).fontSize) < 12);
  if (small.length) {
    findings.push({ rule: 'smallText', message: `${small.length} texts under 12px. Body text is 13–14px; secondary text 12px at least.`, elements: small.slice(0, 6).map(describe) });
  }

  // 6b) A full-height side panel that does not touch the screen edge (a centered max-width
  // around the whole layout leaves a blank strip beside it that reads as a cut).
  const panels = light.filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.height < window.innerHeight * 0.85 || r.width > vw * 0.45 || r.width < 160) return false;
    const cs = getComputedStyle(el);
    const ruled = parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0;
    const gapLeft = r.left;
    const gapRight = vw - r.right;
    return ruled && Math.min(gapLeft, gapRight) > 24 && (parseFloat(cs.borderLeftWidth) > 0 ? gapRight > 24 : gapLeft > 24);
  });
  if (panels.length) {
    findings.push({
      rule: 'floatingSidePanel',
      message: 'A full-height side panel stops short of the screen edge, leaving a blank strip that looks cut. Let the layout span the full width so the panel touches the edge; put the max-width on the main content instead.',
      elements: panels.slice(0, 4).map((el) => `${describe(el)} (${Math.round(vw - el.getBoundingClientRect().right)}px from the right edge)`),
    });
  }

  // 7) Text clipped without an ellipsis, including the label inside a co-button.
  // The label is a text node inside the shadow <button>: compare its measured width with the room inside the padding.
  const clippedLabels = light.filter((el) => {
    const button = el.tagName === 'CO-BUTTON' && el.shadowRoot && el.shadowRoot.querySelector('button');
    if (!button) return false;
    const range = document.createRange();
    range.selectNodeContents(button);
    const cs = getComputedStyle(button);
    const room = button.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return range.getBoundingClientRect().width > room + 1;
  });
  if (clippedLabels.length) {
    findings.push({ rule: 'clippedButtonLabel', message: 'A button label does not fit its button and is cut. Give the button more room (stack the actions, widen the panel) or shorten the label.', elements: clippedLabels.slice(0, 6).map(describe) });
  }
  const clipped = light.filter((el) => {
    const cs = getComputedStyle(el);
    return el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis'
      && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  });
  if (clipped.length) {
    findings.push({ rule: 'clippedText', message: 'Text is cut without an ellipsis. Let it wrap, or add text-overflow: ellipsis with the full text in title.', elements: clipped.slice(0, 6).map(describe) });
  }

  // 8) Touch targets on a phone.
  if (vw < 600) {
    const tiny = light.filter((el) => /^(CO-BUTTON|BUTTON|A|CO-CHIP|CO-INPUT|INPUT|SELECT|CO-SELECT)$/.test(el.tagName)
      && el.getBoundingClientRect().height < 32);
    if (tiny.length) {
      findings.push({ rule: 'smallTouchTargets', message: `${tiny.length} controls under 32px tall on a phone. Use size m (or sm at least) for anything tapped.`, elements: tiny.slice(0, 6).map(describe) });
    }
  }

  // 9) Broken images.
  const broken = light.filter((el) => el.tagName === 'IMG' && el.complete && el.naturalWidth === 0);
  if (broken.length) findings.push({ rule: 'brokenImages', message: `${broken.length} images did not load.`, elements: broken.slice(0, 6).map((el) => el.getAttribute('alt') || describe(el)) });

  return {
    colors: Object.fromEntries([...families].map(([name, info]) => [name, info.count])),
    viewport: { width: vw, height: window.innerHeight },
    page: { width: scrollWidth, height: document.documentElement.scrollHeight },
    customElementsReady: !!window.customElements.get('co-button'),
    findings,
  };
}

function findChrome() {
  const found = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!found) throw new UsageError('Google Chrome was not found. Install it or set CHROME_PATH.');
  return found;
}

function launchChrome(chromePath) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-'));
  const proc = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-extensions', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start in 20 s.')), 20000);
    proc.stderr.on('data', (chunk) => {
      buffer += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}) before it was ready.`));
    });
  });
  return { proc, userDir, ready };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else {
      for (const fn of listeners) fn(msg);
    }
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Could not connect to Chrome.'));
  });
  return {
    opened,
    send(method, params = {}, sessionId) {
      nextId += 1;
      const id = nextId;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(fn) { listeners.push(fn); },
    close() { ws.close(); },
  };
}

function waitFor(client, sessionId, method, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    client.on((msg) => {
      if (msg.sessionId === sessionId && msg.method === method) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function review(opts) {
  const servedDir = resolveServedDir(opts.folder);
  const origin = `https://${opts.domain}`;
  const url = `${origin}${REVIEW_PREFIX}`;
  const key = opts.session ? loadApiKey(opts.domain, DEFAULT_ROOT, opts.profile) : null;
  const outDir = path.resolve(opts.out || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-shots-')));
  fs.mkdirSync(outDir, { recursive: true });

  const chrome = launchChrome(findChrome());
  const blockedWrites = [];
  const httpErrors = new Map();
  const consoleErrors = [];
  const scrub = (text) => (key ? String(text).split(key).join('[key]') : String(text)).slice(0, 300);
  let client;
  try {
    client = connect(await chrome.ready);
    await client.opened;
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => client.send(method, params, sessionId);

    client.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        const reqUrl = new URL(request.url);
        if (reqUrl.pathname.startsWith(REVIEW_PREFIX)) {
          const file = fileForPath(servedDir, reqUrl.pathname);
          const exists = file && fs.existsSync(file) && fs.statSync(file).isFile();
          const fallback = !exists && !path.extname(reqUrl.pathname) ? path.join(servedDir, 'index.html') : null;
          const chosen = exists ? file : fallback;
          if (!chosen) {
            send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {});
            httpErrors.set(reqUrl.pathname, 404);
            return;
          }
          send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: MIME[path.extname(chosen).toLowerCase()] || 'application/octet-stream' }, { name: 'Cache-Control', value: 'no-store' }],
            body: fs.readFileSync(chosen).toString('base64'),
          }).catch(() => {});
        } else if (!SAFE_METHODS.has(request.method)) {
          blockedWrites.push(`${request.method} ${reqUrl.pathname}`);
          send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        } else {
          send('Fetch.continueRequest', { requestId }).catch(() => {});
        }
      } else if (msg.method === 'Network.responseReceived') {
        const { response } = msg.params;
        if (response.status >= 400 && response.url.startsWith(origin)) httpErrors.set(new URL(response.url).pathname, response.status);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(scrub(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(scrub(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')));
      }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] });
    if (key) {
      // The session the platform's sign-in leaves (a JSON string). Lives only in this temporary browser.
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `if (location.origin === ${JSON.stringify(origin)}) { try { localStorage.setItem('apiKey', ${JSON.stringify(JSON.stringify(key))}) } catch (e) {} }`,
      });
    }

    const results = [];
    for (const width of opts.widths) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: opts.height, deviceScaleFactor: 1, mobile: width < 600 });
      const loaded = waitFor(client, sessionId, 'Page.loadEventFired', 20000);
      await send('Page.navigate', { url });
      await loaded;
      await new Promise((r) => setTimeout(r, opts.wait));
      const evaluated = await send('Runtime.evaluate', {
        expression: `(${auditPage.toString()})(${JSON.stringify(hueFamily.toString())})`,
        returnByValue: true,
      });
      if (evaluated.exceptionDetails) throw new Error(`The page audit failed: ${scrub(evaluated.exceptionDetails.text)}`);
      const audit = evaluated.result.value;
      const height = Math.min(Math.max(audit.page.height, opts.height), 6000);
      const shot = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.max(width, audit.page.width), height, scale: 1 },
      });
      const screenshot = path.join(outDir, `ui-review-${width}.png`);
      fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
      results.push({ width, screenshot, ...audit });
    }

    const total = results.reduce((n, r) => n + r.findings.length, 0);
    return {
      domain: opts.domain,
      served: path.relative(DEFAULT_ROOT, servedDir) || '.',
      session: key ? `profile${opts.profile ? `.${opts.profile}` : ''}.json (only inside the review browser)` : 'none',
      widths: results,
      httpErrors: Object.fromEntries(httpErrors),
      consoleErrors: consoleErrors.slice(0, 10),
      blockedWrites,
      nextStep: total
        ? 'Open every screenshot (Read the png) and look at it, fix each finding, and run ui-review again until it is clean. Then go on to the preview.'
        : 'No findings. Still open every screenshot and look at it against _shared/UI-QUALITY.md before the preview: the checks cannot judge hierarchy or copy.',
    };
  } finally {
    if (client) client.close();
    chrome.proc.kill('SIGKILL');
    setTimeout(() => fs.rmSync(chrome.userDir, { recursive: true, force: true }), 300).unref();
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    const result = await review(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { parseArgs, resolveServedDir, fileForPath, hueFamily, auditPage, REVIEW_PREFIX };
