/* global describe, test, expect */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, resolveServedDir, fileForPath, hueFamily, REVIEW_PREFIX } = require('../.claude/skills/_shared/ui-review');

const ROOT = path.resolve(__dirname, '..');

describe('ui-review arguments', () => {
  test('defaults to four widths with the session on', () => {
    const opts = parseArgs(['dev12.prolibu.com', 'accounts/x/sites/y']);
    expect(opts).toMatchObject({ domain: 'dev12.prolibu.com', folder: 'accounts/x/sites/y', widths: [1920, 1440, 1024, 390], session: true });
  });

  test('takes widths, a profile and no session', () => {
    const opts = parseArgs(['dev12.prolibu.com', 'f', '--widths', '1280,375', '--profile', 'seller', '--no-session']);
    expect(opts).toMatchObject({ widths: [1280, 375], profile: 'seller', session: false });
  });

  test('rejects bad widths, profiles, options and domains', () => {
    expect(() => parseArgs(['dev12.prolibu.com', 'f', '--widths', '100'])).toThrow(/widths/);
    expect(() => parseArgs(['dev12.prolibu.com', 'f', '--profile', '../x'])).toThrow(/profile/);
    expect(() => parseArgs(['dev12.prolibu.com', 'f', '--force'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['dev12.prolibu.com'])).toThrow(/Usage/);
    expect(() => parseArgs(['evil.example.com/x', 'f'])).toThrow();
  });
});

describe('ui-review serving', () => {
  const dir = path.join(ROOT, 'test');

  test('maps the review prefix to files inside the folder only', () => {
    expect(fileForPath(dir, REVIEW_PREFIX)).toBe(path.join(dir, 'index.html'));
    expect(fileForPath(dir, `${REVIEW_PREFIX}assets/app.js`)).toBe(path.join(dir, 'assets/app.js'));
    expect(fileForPath(dir, `${REVIEW_PREFIX}../package.json`)).toBeNull();
    expect(fileForPath(dir, `${REVIEW_PREFIX}%2e%2e/package.json`)).toBeNull();
    expect(fileForPath(dir, `${REVIEW_PREFIX}%E0%A4%A`)).toBeNull();
  });

  test('serves public/ of a site folder and refuses folders outside the repository', () => {
    const site = fs.mkdtempSync(path.join(ROOT, 'test', 'tmp-ui-review-'));
    try {
      fs.mkdirSync(path.join(site, 'public'));
      fs.writeFileSync(path.join(site, 'public', 'index.html'), '<html></html>');
      expect(resolveServedDir(site)).toBe(fs.realpathSync(path.join(site, 'public')));
    } finally {
      fs.rmSync(site, { recursive: true, force: true });
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'index.html'), '<html></html>');
      expect(() => resolveServedDir(outside)).toThrow(/inside this repository/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('ui-review colors', () => {
  test('groups saturated colors by family and ignores neutrals', () => {
    expect(hueFamily('rgb(37, 99, 235)')).toBe('blue');
    expect(hueFamily('rgb(226, 149, 0)')).toBe('orange');
    expect(hueFamily('rgb(2, 162, 112)')).toBe('green');
    expect(hueFamily('rgb(170, 46, 27)')).toBe('red');
    expect(hueFamily('rgb(136, 136, 136)')).toBeNull();
    expect(hueFamily('rgb(255, 255, 255)')).toBeNull();
    expect(hueFamily('rgba(37, 99, 235, 0.1)')).toBeNull();
    expect(hueFamily('transparent')).toBeNull();
  });
});
