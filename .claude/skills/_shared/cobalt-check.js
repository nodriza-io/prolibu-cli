'use strict';

// Static checks that a page follows Cobalt, Prolibu's design system: it loads the co-*
// components and their tokens, styles with --co-* tokens instead of fixed colors, and uses
// co-* controls instead of plain ones. Shared by the sites and extended-quote skills.
// Findings are warnings: a page without Cobalt still works, it just does not look like Prolibu.

const path = require('path');

// The platform serves Cobalt on every account domain, so a site loads it from there.
const COBALT_PATH = /^\/ui\/static\/cobalt(-form|-form-core)?\/[\w./-]*$/;
const RUNTIME = /\/ui\/static\/cobalt\/cobalt\/cobalt\.esm\.js|@prolibu-suite\/cobalt-(core|vue|react)|cobalt\.esm\.js|customElements\.define\(\s*["']co-/;
const TOKENS = /\/ui\/static\/cobalt\/tokens\/tokens\.css|@prolibu-suite\/cobalt-tokens|--co-semantic-/;
const COLOR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\brgba?\(|\bhsla?\(/g;
const STYLED_EXT = new Set(['.css', '.html', '.htm', '.vue', '.jsx', '.tsx', '.svelte']);
const PAGE_EXT = new Set(['.html', '.htm']);
const MAX_COLORS = 4;

function isCobaltAsset(ref) {
  return COBALT_PATH.test(ref) && !ref.split('/').includes('..');
}

// Colors written by hand, skipping the lines that set --co-* tokens (that is how a brand is applied).
function countColors(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/--co-[\w-]+\s*:/.test(line)) continue;
    const found = line.match(COLOR);
    if (found) count += found.length;
  }
  return count;
}

// Visible form controls outside Cobalt (hidden inputs are data, not controls).
function countPlainControls(html) {
  const buttons = (html.match(/<button\b/gi) || []).length;
  const selects = (html.match(/<select\b/gi) || []).length;
  const inputs = (html.match(/<input\b[^>]*>/gi) || []).filter((tag) => !/type\s*=\s*["']?hidden/i.test(tag)).length;
  return buttons + selects + inputs;
}

function cobaltFindings(files) {
  const texts = files.filter((f) => typeof f.text === 'string');
  const pages = texts.filter((f) => PAGE_EXT.has(path.extname(f.rel).toLowerCase()));
  if (!pages.length) return [];
  const all = texts.map((f) => f.text).join('\n');
  const findings = [];
  if (!RUNTIME.test(all)) {
    findings.push({
      rule: 'noCobalt',
      message: 'The page does not load Cobalt, so it will not look like Prolibu. Load /ui/static/cobalt/tokens/tokens.css and /ui/static/cobalt/cobalt/cobalt.esm.js and build it with co-* components (see _shared/COBALT.md).',
    });
    return findings;
  }
  if (!TOKENS.test(all)) {
    findings.push({
      rule: 'noCobaltTokens',
      message: 'Cobalt is loaded without its tokens: colors, spacing and fonts fall back to the browser defaults. Add <link rel="stylesheet" href="/ui/static/cobalt/tokens/tokens.css">.',
    });
  }
  for (const f of texts) {
    if (!STYLED_EXT.has(path.extname(f.rel).toLowerCase())) continue;
    const count = countColors(f.text);
    if (count > MAX_COLORS) {
      findings.push({
        rule: 'hardcodedColors',
        file: f.rel,
        count,
        message: `${count} colors written by hand. Use the --co-semantic-* tokens (they also follow dark mode); a brand color goes once, as a --co-* override in :root.`,
      });
    }
  }
  for (const f of pages) {
    const count = countPlainControls(f.text);
    if (count) {
      findings.push({
        rule: 'plainControls',
        file: f.rel,
        count,
        message: `${count} plain form controls (button, input, select). Use co-button, co-input, co-select… so they look and behave like the app.`,
      });
    }
  }
  return findings;
}

module.exports = { cobaltFindings, isCobaltAsset, countColors };
