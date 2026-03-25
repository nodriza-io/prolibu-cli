const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
/* global describe, beforeAll, afterAll, it, expect */

const config = require('./config.json');
const domain = config.domain;
const objectDir = path.join(__dirname, '..', 'accounts', domain, 'objects', 'CustomField');

describe('Prolibu CLI - Custom Fields', () => {
  // Clean up pulled files before tests
  beforeAll(() => {
    if (fs.existsSync(objectDir)) {
      fs.rmSync(objectDir, { recursive: true, force: true });
    }
  });

  describe('Help', () => {
    it('should show help when no command is given', () => {
      const output = execSync('./prolibu customfield', { encoding: 'utf8' });
      expect(output).toContain('Usage:');
      expect(output).toContain('list');
      expect(output).toContain('pull');
      expect(output).toContain('push');
    });

    it('should accept "cf" alias', () => {
      const output = execSync('./prolibu cf', { encoding: 'utf8' });
      expect(output).toContain('Usage:');
    });
  });

  describe('List', () => {
    it('should list custom fields from the platform', () => {
      const output = execSync(`./prolibu customfield list --domain ${domain}`, { encoding: 'utf8' });
      expect(output).toContain('Custom Fields on');
      expect(output).toContain(domain);
    });
  });

  describe('Pull', () => {
    it('should pull custom fields to object/customfield/ folder', () => {
      const output = execSync(`./prolibu customfield pull --domain ${domain}`, { encoding: 'utf8' });
      expect(output).toContain('Pulled');
      expect(output).toContain('objects/CustomField/');
      expect(fs.existsSync(objectDir)).toBe(true);
    });

    it('should create JSON files named by objectAssigned', () => {
      const files = fs.readdirSync(objectDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      // Each file should have valid JSON with objectAssigned
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(objectDir, file), 'utf8'));
        expect(data.objectAssigned).toBeDefined();
        expect(data._id).toBeDefined();
        expect(file).toBe(`${data.objectAssigned}.json`);
      }
    });
  });

  describe('Get', () => {
    it('should get a custom field by ID', () => {
      // Use the first pulled file to get an ID
      const files = fs.readdirSync(objectDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      const data = JSON.parse(fs.readFileSync(path.join(objectDir, files[0]), 'utf8'));
      const output = execSync(`./prolibu customfield get --domain ${domain} --id ${data._id}`, { encoding: 'utf8' });
      expect(output).toContain(data.objectAssigned);
      expect(output).toContain(data._id);
    });
  });

  describe('Push', () => {
    it('should push local custom field files to the platform', () => {
      const output = execSync(`./prolibu customfield push --domain ${domain}`, { encoding: 'utf8' });
      expect(output).toContain('Push complete');
    });
  });
});
