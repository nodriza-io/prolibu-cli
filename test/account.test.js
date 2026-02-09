const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
/* global describe, beforeAll, afterAll, it, expect */

const TEST_DOMAIN = 'test-account-' + Date.now();
const TEST_REPO = 'https://github.com/nodriza-io/account-faranda.git';
const ACCOUNTS_DIR = path.join(__dirname, '..', 'accounts');
const ACCOUNT_DIR = path.join(ACCOUNTS_DIR, TEST_DOMAIN);
const CLI = path.join(__dirname, '..', 'prolibu');

const run = (cmd, opts = {}) => {
  return execSync(cmd, {
    stdio: 'pipe',
    timeout: 60000,
    env: { ...process.env, FORCE_COLOR: '0' },
    ...opts
  }).toString();
};

describe('Prolibu CLI - Account Commands', () => {

  afterAll(() => {
    // Cleanup test account folder
    if (fs.existsSync(ACCOUNT_DIR)) {
      fs.rmSync(ACCOUNT_DIR, { recursive: true, force: true });
    }
  });

  describe('account help', () => {
    it('should show help when no command is provided', () => {
      const output = run(`${CLI} account`);
      expect(output).toContain('import');
      expect(output).toContain('pull');
      expect(output).toContain('push');
      expect(output).toContain('list');
    });
  });

  describe('account import', () => {
    it('should import an account from a git repository', () => {
      const output = run(`${CLI} account import --domain ${TEST_DOMAIN} --repo ${TEST_REPO}`);
      expect(output).toContain('imported successfully');
    }, 60000);

    it('should create the account folder', () => {
      expect(fs.existsSync(ACCOUNT_DIR)).toBe(true);
    });

    it('should have a .git directory (cloned repo)', () => {
      expect(fs.existsSync(path.join(ACCOUNT_DIR, '.git'))).toBe(true);
    });

    it('should have a .gitignore file', () => {
      expect(fs.existsSync(path.join(ACCOUNT_DIR, '.gitignore'))).toBe(true);
    });

    it('should contain scripts/folders from the repo', () => {
      const entries = fs.readdirSync(ACCOUNT_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'));
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should have git remote pointing to the correct repo', () => {
      const remote = run('git remote get-url origin', { cwd: ACCOUNT_DIR }).trim();
      expect(remote).toBe(TEST_REPO);
    });

    it('should fail when re-importing an existing account (interactive prompt required)', () => {
      // Re-importing an existing git account triggers an interactive prompt,
      // which can't be handled in non-interactive mode, so it should throw
      expect(() => {
        run(`${CLI} account import --domain ${TEST_DOMAIN} --repo ${TEST_REPO}`);
      }).toThrow();
    }, 60000);
  });

  describe('account list', () => {
    it('should list accounts without errors', () => {
      const output = run(`${CLI} account list`);
      expect(output).toContain(TEST_DOMAIN);
    });

    it('should show the test account as a git repo', () => {
      const output = run(`${CLI} account list`);
      // Should show git remote URL or the domain name
      expect(output).toContain(TEST_DOMAIN);
      expect(output).toContain(TEST_REPO);
    });
  });

  describe('account pull', () => {
    it('should pull latest changes without errors', () => {
      const output = run(`${CLI} account pull --domain ${TEST_DOMAIN}`);
      expect(output).toContain('updated successfully');
    }, 30000);

    it('should fail for non-existent account', () => {
      expect(() => {
        run(`${CLI} account pull --domain non-existent-account-12345`);
      }).toThrow();
    });
  });

  describe('account push', () => {
    it('should report clean when nothing to push', () => {
      const output = run(`${CLI} account push --domain ${TEST_DOMAIN} -m "test"`);
      expect(output).toContain('clean');
    });

    it('should commit and push when there are changes', () => {
      // Create a test file to have something to commit
      const testFile = path.join(ACCOUNT_DIR, 'test-push-file.txt');
      fs.writeFileSync(testFile, `Test push at ${new Date().toISOString()}`);

      const output = run(`${CLI} account push --domain ${TEST_DOMAIN} -m "test: push command"`);
      expect(output).toContain('pushed successfully');

      // Verify the file was committed (git status should be clean)
      const status = run('git status --porcelain', { cwd: ACCOUNT_DIR }).trim();
      expect(status).toBe('');

      // Cleanup: remove the test file and push
      fs.unlinkSync(testFile);
      try {
        run(`${CLI} account push --domain ${TEST_DOMAIN} -m "test: cleanup push test file"`);
      } catch {
        // ignore cleanup errors
      }
    }, 30000);
  });

  describe('account import (edge cases)', () => {
    it('should fail for non-existent repo', () => {
      const badDomain = 'test-bad-repo-' + Date.now();
      expect(() => {
        run(`${CLI} account import --domain ${badDomain} --repo https://github.com/nonexistent/repo-12345.git`);
      }).toThrow();

      // Cleanup
      const badDir = path.join(ACCOUNTS_DIR, badDomain);
      if (fs.existsSync(badDir)) {
        fs.rmSync(badDir, { recursive: true, force: true });
      }
    }, 30000);
  });
});
