const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
/* global describe, beforeAll, afterAll, it, expect */

const config = require('./config.json');
const domain = config.domain;
const cobDir = path.join(__dirname, '..', 'accounts', domain, 'objects', 'Cob');
const cfDir = path.join(__dirname, '..', 'accounts', domain, 'objects', 'CustomField');

/**
 * Wait for the backend to be ready after a COB create/delete (triggers restart).
 * Polls GET /v2/cob?limit=1 until it gets a 200 response.
 */
async function waitForBackend(maxWaitMs = 60000, intervalMs = 5000) {
  await new Promise((r) => setTimeout(r, 15000));
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await axios.get(`https://${domain}/v2/cob?limit=1`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeout: 5000,
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Backend did not recover within ${maxWaitMs / 1000}s`);
}

/**
 * Execute a CLI command with retries (handles backend restarts mid-request).
 */
function execWithRetry(cmd, maxRetries = 3, delayMs = 15000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const allOutput = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      const isTransient = /ECONNREFUSED|socket hang up|ECONNRESET|ETIMEDOUT/.test(allOutput);
      if (!isTransient || i === maxRetries - 1) throw err;
      console.log(`  ⏳ Retry ${i + 1}/${maxRetries} — waiting ${delayMs / 1000}s for backend...`);
      execSync(`sleep ${delayMs / 1000}`);
    }
  }
}

describe('Prolibu CLI - Object (unified COB + CustomField)', () => {
  // Clean up pulled files and leftover test COBs before tests
  beforeAll(async () => {
    if (fs.existsSync(cobDir)) {
      fs.rmSync(cobDir, { recursive: true, force: true });
    }
    if (fs.existsSync(cfDir)) {
      fs.rmSync(cfDir, { recursive: true, force: true });
    }
    // Delete any leftover TestCli* COBs from previous test runs
    try {
      const res = await axios.get(`https://${domain}/v2/cob?limit=100&select=_id%20modelName`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeout: 10000,
      });
      const cobs = res.data?.data || [];
      for (const cob of cobs) {
        if (cob.modelName && cob.modelName.startsWith('TestCli')) {
          try {
            await axios.delete(`https://${domain}/v2/cob/${cob._id}`, {
              headers: { Authorization: `Bearer ${config.apiKey}` },
              timeout: 10000,
            });
            console.log(`  🧹 Cleaned up leftover COB: ${cob.modelName}`);
            await waitForBackend();
          } catch {}
        }
      }
    } catch {}
  }, 120000);

  // ── Help ────────────────────────────────────────────────────────────

  describe('Help', () => {
    it('should show help when no command is given', () => {
      const output = execSync('./prolibu object', { encoding: 'utf8' });
      expect(output).toContain('Usage:');
      expect(output).toContain('list');
      expect(output).toContain('pull');
      expect(output).toContain('sync');
    });
  });

  // ── List ────────────────────────────────────────────────────────────

  describe('List', () => {
    it('should list custom objects and custom fields from the platform', () => {
      const output = execSync(`./prolibu object list --domain ${domain}`, { encoding: 'utf8' });
      expect(output).toContain('Custom Objects on');
      expect(output).toContain('Custom Fields on');
      expect(output).toContain(domain);
    });
  });

  // ── COB Create + Get + Delete lifecycle ─────────────────────────────

  describe('COB Create + Get + Delete lifecycle', () => {
    const rand = Math.random().toString(36).slice(2, 8);
    const testModelName = `TestCli${rand}`;
    const testFile = path.join(__dirname, `_temp_cob_${testModelName}.json`);
    let createdId;

    afterAll(() => {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    });

    it('should create a COB from a JSON file and wait for backend restart', async () => {
      await waitForBackend();

      const cobDef = {
        modelName: testModelName,
        active: true,
        itemName: {
          type: 'string',
          required: true,
          displayName: true,
          description: 'Test field',
        },
      };
      fs.writeFileSync(testFile, JSON.stringify(cobDef, null, 2));

      try {
        const output = execWithRetry(`./prolibu object create --domain ${domain} -f ${testFile}`);
        expect(output).toContain('created');
        expect(output).toContain('ID:');
        const idMatch = output.match(/ID:\s+([a-f0-9]{24})/);
        expect(idMatch).not.toBeNull();
        createdId = idMatch[1];
      } catch {
        // Create may fail because the POST went through but the response was lost
        // during backend restart. Look up the COB by modelName.
        await waitForBackend();
        const res = await axios.get(`https://${domain}/v2/cob?limit=100&select=_id%20modelName`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        const found = (res.data?.data || []).find((c) => c.modelName === testModelName);
        expect(found).toBeDefined();
        createdId = found._id;
        console.log(`  ℹ️  COB was created but response lost during restart — found ID: ${createdId}`);
      }

      await waitForBackend();
    }, 90000);

    it('should get the COB by ID', () => {
      expect(createdId).toBeDefined();
      const output = execSync(
        `./prolibu object get --domain ${domain} --type cob --id ${createdId}`,
        { encoding: 'utf8' }
      );
      expect(output).toContain(testModelName);
      expect(output).toContain(createdId);
    });

    it('should delete the COB and wait for backend restart', async () => {
      expect(createdId).toBeDefined();
      const output = execSync(
        `echo "y" | ./prolibu object delete --domain ${domain} --type cob --id ${createdId}`,
        { encoding: 'utf8', shell: '/bin/zsh' }
      );
      expect(output).toContain('deleted');
      await waitForBackend();
    }, 90000);
  });

  // ── Pull ────────────────────────────────────────────────────────────

  describe('Pull', () => {
    it('should pull COBs and Custom Fields to objects/ folders', async () => {
      await waitForBackend();
      const output = execSync(`./prolibu object pull --domain ${domain}`, { encoding: 'utf8' });
      expect(output).toContain('pulled');
    }, 60000);

    it('should create Cob JSON files in objects/Cob/', () => {
      // There may be 0 COBs after the delete — just verify directory exists
      expect(fs.existsSync(cobDir)).toBe(true);
    });

    it('should create CustomField JSON files in objects/CustomField/', () => {
      if (!fs.existsSync(cfDir)) return; // skip if no CFs on this account
      const files = fs.readdirSync(cfDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(cfDir, file), 'utf8'));
        expect(data.objectAssigned).toBeDefined();
        expect(data._id).toBeDefined();
        expect(file).toBe(`${data.objectAssigned}.json`);
      }
    });
  });

  // ── CustomField Get (using pulled files) ────────────────────────────

  describe('CustomField Get', () => {
    it('should get a custom field by ID', () => {
      if (!fs.existsSync(cfDir)) return; // skip if no CFs
      const files = fs.readdirSync(cfDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) return;

      const data = JSON.parse(fs.readFileSync(path.join(cfDir, files[0]), 'utf8'));
      const output = execSync(
        `./prolibu object get --domain ${domain} --type cf --id ${data._id}`,
        { encoding: 'utf8' }
      );
      expect(output).toContain(data.objectAssigned);
      expect(output).toContain(data._id);
    });
  });
});
