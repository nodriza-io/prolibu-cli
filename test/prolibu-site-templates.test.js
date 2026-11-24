/* global describe, test, expect */
// The templates `./prolibu site create --template vanilla|react|vue` copies must publish and work
// at https://<domain>/site/<siteCode>/ (same origin as the app): relative paths, the app's session
// instead of a login form, light API reads, and the same checks `site.js check` runs.
const fs = require('fs');
const path = require('path');
const { checkFiles, absoluteRefs } = require('../.claude/skills/prolibu-sites/scripts/site');
const { heavyReadFindings } = require('../.claude/skills/_shared/heavy-read-check');

const ROOT = path.join(__dirname, '..');
const SESSION_ASSET = path.join(ROOT, '.claude/skills/prolibu-sites/assets/prolibu-session.js');
const LIMITS = { maxFileSizeMB: 20, blockExtensions: [], scanMaliciousContent: false, known: true };

const TEMPLATES = {
  vanilla: { dir: 'templates/site', build: false },
  react: { dir: 'templates/site-react', build: true },
  vue: { dir: 'templates/site-vue', build: true },
};

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : listFiles(abs, base);
    return [{ abs, rel: path.relative(base, abs).split(path.sep).join('/') }];
  });
}

const toFile = ({ abs, rel }) => {
  const buffer = fs.readFileSync(abs);
  return { rel, abs, size: buffer.length, buffer, text: buffer.toString('utf8') };
};

// What a publish would see. Plain site: public/ as is. Build-tool site: what Vite emits, i.e.
// the root index.html, public/ copied to the root, and the sources the page loads (src/…).
function publishedView(name) {
  const t = TEMPLATES[name];
  const dir = path.join(ROOT, t.dir);
  if (!t.build) return listFiles(path.join(dir, 'public')).map(toFile);
  return [
    toFile({ abs: path.join(dir, 'index.html'), rel: 'index.html' }),
    ...listFiles(path.join(dir, 'public')).map(toFile),
    ...listFiles(path.join(dir, 'src')).map((f) => toFile({ abs: f.abs, rel: `src/${f.rel}` })),
  ];
}

// Every text file of the template (code, config, docs), for the rules that apply anywhere.
const allFiles = (name) => listFiles(path.join(ROOT, TEMPLATES[name].dir)).map(toFile);
const isCode = (f) => /\.(html|js|ts|tsx|vue|css)$/.test(f.rel);

describe.each(Object.keys(TEMPLATES))('%s template', (name) => {
  const published = publishedView(name);
  const code = allFiles(name).filter(isCode);

  test('passes the checks site.js runs before a publish, with no blocker or warning', () => {
    const { blockers, warnings } = checkFiles({ files: published, limits: LIMITS, keys: [] });
    expect(blockers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('has no heavy reads (sort on unindexed fields, parallel calls)', () => {
    expect(heavyReadFindings(published)).toEqual([]);
    for (const f of code) expect(`${f.rel}: ${/Promise\.(all|allSettled)\(/.test(f.text)}`).toBe(`${f.rel}: false`);
  });

  test('loads nothing from the domain root except Cobalt and /v2', () => {
    for (const f of code) expect(absoluteRefs(f.rel, f.text)).toEqual([]);
  });

  test('never asks for a password, never touches the session keys, never calls /v2/auth/login', () => {
    for (const f of code) {
      expect(`${f.rel}: ${/type\s*=\s*["']password["']/i.test(f.text)}`).toBe(`${f.rel}: false`);
      expect(`${f.rel}: ${/localStorage\.(removeItem|clear|setItem)\(/.test(f.text)}`).toBe(`${f.rel}: false`);
      expect(`${f.rel}: ${/\/v2\/auth\/login\b|['"`]\/auth\/login\b/.test(f.text)}`).toBe(`${f.rel}: false`);
      expect(`${f.rel}: ${/_prolibu_config/.test(f.text)}`).toBe(`${f.rel}: false`);
    }
  });

  test('index.html keeps the page out of search engines and referrers, and loads the session helper', () => {
    const index = published.find((f) => f.rel === 'index.html').text;
    expect(index).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(index).toMatch(/<meta name="referrer" content="no-referrer"/);
    expect(index).toMatch(/<script src="(\.\/)?prolibu-session\.js"/);
  });

  test('ships the same session helper as the prolibu-sites skill', () => {
    const helper = published.find((f) => f.rel === 'prolibu-session.js');
    expect(helper).toBeDefined();
    expect(helper.text).toBe(fs.readFileSync(SESSION_ASSET, 'utf8'));
  });
});

describe.each(['react', 'vue'])('%s build layout', (name) => {
  const dir = path.join(ROOT, TEMPLATES[name].dir);

  test('has index.html, package.json with build and dev scripts, settings.json outputDir', () => {
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.dev).toBeTruthy();
    for (const [dep, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(`${dep}@${range}`).toMatch(/@[~^]?\d+\.\d+\.\d+$/);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).outputDir).toBe('dist');
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  });

  test('vite config builds with relative asset paths', () => {
    const config = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/base:\s*['"]\.\/['"]/);
  });

  test('has no login page or login route', () => {
    const files = listFiles(path.join(dir, 'src'));
    expect(files.map((f) => f.rel).filter((r) => /login/i.test(r))).toEqual([]);
    for (const f of files) expect(`${f.rel}: ${/['"]\/login['"]/.test(fs.readFileSync(f.abs, 'utf8'))}`).toBe(`${f.rel}: false`);
  });
});

test('vue template routes from the mount point and treats co-* as custom elements', () => {
  const dir = path.join(ROOT, TEMPLATES.vue.dir);
  expect(fs.readFileSync(path.join(dir, 'src/router.ts'), 'utf8')).toMatch(/new URL\(document\.baseURI\)\.pathname/);
  expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toMatch(/isCustomElement:[^\n]*co-/);
});

test('every template site create offers has files to copy', () => {
  const create = fs.readFileSync(path.join(ROOT, 'cli/commands/site/create.js'), 'utf8');
  const offered = JSON.parse(create.match(/const TEMPLATES = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const t of offered) {
    const dir = path.join(ROOT, t === 'vanilla' ? 'templates/site' : `templates/site-${t}`);
    expect(`${t}: ${fs.existsSync(path.join(dir, t === 'vanilla' ? 'public/index.html' : 'index.html'))}`).toBe(`${t}: true`);
  }
});
