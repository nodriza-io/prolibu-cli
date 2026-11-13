const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
/* global describe, beforeEach, afterEach, it, expect */

// `account push` against a local bare remote: nothing here reaches GitHub.
const CLI = path.join(__dirname, '..', 'prolibu');
const ROOT = path.join(__dirname, '..');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const push = (domain, message) => {
  try {
    return { code: 0, out: execFileSync(CLI, ['account', 'push', '--domain', domain, '-m', message], {
      cwd: ROOT, stdio: 'pipe', timeout: 60000, env: { ...process.env, FORCE_COLOR: '0' },
    }).toString() };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};

describe('account push never publishes API keys (SEG-3)', () => {
  let domain;
  let accountDir;
  let remote;
  let tmp;

  beforeEach(() => {
    domain = `test-push-secrets-${Date.now()}`;
    accountDir = path.join(ROOT, 'accounts', domain);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-secrets-'));
    remote = path.join(tmp, 'remote.git');
    git(tmp, 'init', '-q', '--bare', remote);
    fs.mkdirSync(accountDir, { recursive: true });
    git(accountDir, 'init', '-q', '-b', 'main');
    git(accountDir, 'config', 'user.email', 'test@example.com');
    git(accountDir, 'config', 'user.name', 'Test');
    git(accountDir, 'remote', 'add', 'origin', remote);
    // A cloned account keeps its own .gitignore, which may not mention the profiles at all.
    fs.writeFileSync(path.join(accountDir, '.gitignore'), 'node_modules/\n');
    git(accountDir, 'add', '.gitignore');
    git(accountDir, 'commit', '-q', '-m', 'init');
    git(accountDir, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => {
    fs.rmSync(accountDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const remoteFiles = () => git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');

  it('pushes the changes but neither profile.json nor profile.<name>.json', () => {
    fs.writeFileSync(path.join(accountDir, 'profile.json'), '{"apiKey":"main-key"}');
    fs.writeFileSync(path.join(accountDir, 'profile.seller.json'), '{"apiKey":"seller-key"}');
    fs.mkdirSync(path.join(accountDir, 'scripts', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(accountDir, 'scripts', 'demo', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(accountDir, 'scripts', 'demo', 'profile.old.json'), '{"apiKey":"nested-key"}');

    const res = push(domain, 'add demo');
    expect(res.out).toContain('pushed successfully');
    expect(remoteFiles()).toContain('scripts/demo/index.js');
    expect(remoteFiles().filter((f) => /profile.*\.json$/.test(f))).toEqual([]);
  });

  it('reports clean when only key files changed', () => {
    fs.writeFileSync(path.join(accountDir, 'profile.seller.json'), '{"apiKey":"seller-key"}');
    const res = push(domain, 'nothing');
    expect(res.out).toContain('is clean, nothing to push');
    expect(git(accountDir, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('refuses to push while a key file is already committed', () => {
    fs.writeFileSync(path.join(accountDir, 'profile.seller.json'), '{"apiKey":"seller-key"}');
    git(accountDir, 'add', '-f', 'profile.seller.json');
    git(accountDir, 'commit', '-q', '-m', 'oops');
    fs.writeFileSync(path.join(accountDir, 'notes.txt'), 'x');

    const res = push(domain, 'more');
    expect(res.code).not.toBe(0);
    expect(res.out).toContain('profile.seller.json');
    expect(remoteFiles()).not.toContain('profile.seller.json');
  });

  it('keeps $(…) and backticks in the message as text', () => {
    const marker = path.join(tmp, 'pwned');
    fs.writeFileSync(path.join(accountDir, 'notes.txt'), 'x');
    const message = `msg $(touch ${marker}) \`touch ${marker}\``;

    const res = push(domain, message);
    expect(res.out).toContain('pushed successfully');
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe(message);
  });
});
