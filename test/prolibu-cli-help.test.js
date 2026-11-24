/* global describe, test, expect */
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'prolibu');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', timeout: 10000 });

describe('./prolibu help', () => {
  test.each(['--help', '-h', 'help'])('%s prints the general help and exits 0', (flag) => {
    const r = run(flag);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: ./prolibu <object> <command> [options]');
    expect(r.stderr).not.toContain('Unknown');
  });

  test('<object> --help prints that object\'s usage', () => {
    const r = run('account', '--help');
    expect(r.stdout).toContain('Usage: ./prolibu account <command>');
    expect(r.stderr + r.stdout).not.toContain('Unknown command');
  });

  test('an unknown object still fails with exit 1', () => {
    const r = run('nope');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown object type: nope');
  });
});
