/* global describe, test, expect */
const { cobaltFindings, isCobaltAsset } = require('../.claude/skills/_shared/cobalt-check');

const HEAD = '<link rel="stylesheet" href="/ui/static/cobalt/tokens/tokens.css">'
  + '<script type="module" src="/ui/static/cobalt/cobalt/cobalt.esm.js"></script>';
const rules = (files) => cobaltFindings(files).map((f) => f.rule);

describe('cobalt checks', () => {
  test('a page built with Cobalt and tokens has no findings', () => {
    const html = `<html><head>${HEAD}<style>:root { --co-color-primary-azul: #7c3aed; }
      .grid { gap: var(--co-spacing-lg); color: var(--co-semantic-text-default); }</style></head>
      <body><co-button variant="primary" label="Guardar"></co-button></body></html>`;
    expect(cobaltFindings([{ rel: 'index.html', text: html }])).toEqual([]);
  });

  test('a page without Cobalt is reported once', () => {
    expect(rules([{ rel: 'index.html', text: '<html><body><button>Ok</button></body></html>' }])).toEqual(['noCobalt']);
  });

  test('Cobalt without its tokens is reported', () => {
    const html = '<html><head><script type="module" src="/ui/static/cobalt/cobalt/cobalt.esm.js"></script></head><body></body></html>';
    expect(rules([{ rel: 'index.html', text: html }])).toEqual(['noCobaltTokens']);
  });

  test('hard-coded colors are counted outside the --co-* token overrides', () => {
    const css = ':root { --co-color-primary-azul: #7c3aed; }\n.a { color: #111111; }\n.b { background: #fff; border-color: rgb(1, 2, 3); }\n.c { fill: #abcdef; }\n.d { color: hsl(0 0% 0%); }';
    const found = cobaltFindings([{ rel: 'index.html', text: `<html><head>${HEAD}</head></html>` }, { rel: 'styles.css', text: css }]);
    expect(found).toEqual([expect.objectContaining({ rule: 'hardcodedColors', file: 'styles.css', count: 5 })]);
  });

  test('a few colors are tolerated', () => {
    const css = '.a { color: #111; }\n.b { color: #222; }';
    expect(rules([{ rel: 'index.html', text: `<html><head>${HEAD}</head></html>` }, { rel: 'a.css', text: css }])).toEqual([]);
  });

  test('plain form controls next to Cobalt are reported', () => {
    const html = `<html><head>${HEAD}</head><body><button>a</button><input type="text"><select></select><input type="hidden"></body></html>`;
    expect(cobaltFindings([{ rel: 'index.html', text: html }])).toEqual([expect.objectContaining({ rule: 'plainControls', count: 3 })]);
  });

  test('a framework build that bundles the Cobalt packages counts as Cobalt', () => {
    const files = [
      { rel: 'index.html', text: '<html><head><script type="module" src="./assets/index.js"></script></head></html>' },
      { rel: 'assets/index.js', text: 'import"@prolibu-suite/cobalt-react";const t="--co-semantic-text-default";' },
    ];
    expect(rules(files)).toEqual([]);
  });

  test('only the platform Cobalt path counts as a platform asset', () => {
    expect(isCobaltAsset('/ui/static/cobalt/cobalt/cobalt.esm.js')).toBe(true);
    expect(isCobaltAsset('/ui/static/cobalt/tokens/tokens-dark.css')).toBe(true);
    expect(isCobaltAsset('/ui/static/cobalt-form/cobalt-form/cobalt-form.esm.js')).toBe(true);
    expect(isCobaltAsset('/ui/static/other/app.js')).toBe(false);
    expect(isCobaltAsset('/ui/static/cobalt/../../secret.js')).toBe(false);
  });

  test('files without html are not a page and get no findings', () => {
    expect(cobaltFindings([{ rel: 'data.json', text: '{"color":"#ffffff"}' }])).toEqual([]);
  });
});
