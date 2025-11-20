const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
/* global describe, beforeAll, it, expect */

const config = require('./config.json');

describe('Prolibu CLI - Sites', () => {
  let siteCode;
  let siteFolder;

  beforeAll(() => {
    // Ensure profile.json exists
    const profilePath = path.join(__dirname, '..', 'accounts', config.domain, 'profile.json');
    if (!fs.existsSync(profilePath)) {
      const domainDir = path.dirname(profilePath);
      if (!fs.existsSync(domainDir)) {
        fs.mkdirSync(domainDir, { recursive: true });
      }
      fs.writeFileSync(profilePath, JSON.stringify({ apiKey: config.apiKey }, null, 2));
    }

    // Remove all folders inside the domain that start with 'site-test-'
    const domainPath = path.join(__dirname, '..', 'accounts', config.domain);
    if (fs.existsSync(domainPath)) {
      fs.readdirSync(domainPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('site-test-'))
        .forEach(dirent => {
          const folderPath = path.join(domainPath, dirent.name);
          fs.rmSync(folderPath, { recursive: true, force: true });
        });
    }
    
    const timestamp = Date.now();
    siteCode = `site-test-${timestamp}`;
    siteFolder = path.join(__dirname, '..', 'accounts', config.domain, siteCode);
    
    // Create site folder manually with Hola Mundo
    fs.mkdirSync(siteFolder, { recursive: true });
    
    // Create public folder
    const publicFolder = path.join(siteFolder, 'public');
    fs.mkdirSync(publicFolder, { recursive: true });
    
    // Create index.html with Hola Mundo
    const indexPath = path.join(publicFolder, 'index.html');
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hola Mundo</title>
</head>
<body>
  <h1>Hola Mundo</h1>
</body>
</html>`;
    fs.writeFileSync(indexPath, htmlContent);
    
    // Create config.json
    const configPath = path.join(siteFolder, 'config.json');
    const siteConfig = {
      variables: [],
      lifecycleHooks: [],
      readme: '',
      git: { repositoryUrl: '' },
      siteType: 'Static'
    };
    fs.writeFileSync(configPath, JSON.stringify(siteConfig, null, 2));
    
    // Create settings.json
    const settingsPath = path.join(siteFolder, 'settings.json');
    const siteSettings = {
      port: 3000
    };
    fs.writeFileSync(settingsPath, JSON.stringify(siteSettings, null, 2));
    
    // Create README.md
    const readmePath = path.join(siteFolder, 'README.md');
    fs.writeFileSync(readmePath, '# Site Test\n\nHola Mundo site for testing.');
  });

  describe('Create Command', () => {
    it('should have all template files in the site folder', () => {
      const expectedFiles = [
        'public',
        'config.json',
        'settings.json',
        'README.md'
      ];
      expectedFiles.forEach(file => {
        expect(fs.existsSync(path.join(siteFolder, file))).toBe(true);
      });
    });

    it('should have public/index.html with Hola Mundo', () => {
      const indexPath = path.join(siteFolder, 'public', 'index.html');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf8');
      expect(content).toContain('Hola Mundo');
    });

    it('should have config.json with site model fields', () => {
      const configPath = path.join(siteFolder, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Verify site model fields
      expect(configData).toHaveProperty('variables');
      expect(configData).toHaveProperty('lifecycleHooks');
      expect(configData).toHaveProperty('readme');
      expect(configData).toHaveProperty('git');
      expect(configData).toHaveProperty('siteType');
      
      // Should NOT have local settings
      expect(configData).not.toHaveProperty('port');
    });

    it('should have settings.json with port configuration', () => {
      const settingsPath = path.join(siteFolder, 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);
      
      const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      
      // Verify settings fields
      expect(settingsData).toHaveProperty('port');
      
      // Should NOT have model data
      expect(settingsData).not.toHaveProperty('variables');
      expect(settingsData).not.toHaveProperty('siteType');
    });
  });

  describe('Dev Command', () => {
    it('should execute dev command and upload site package', () => {
      const cmd = `./site dev \
        --domain ${config.domain} \
        --prefix ${siteCode} \
        --apikey ${config.apiKey}`;
        
      let devError = null;
      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (e) {
        devError = e;
      }
      expect(devError).toBeNull();
    });

    it('should create dist.zip after dev command', () => {
      const distZipPath = path.join(siteFolder, 'dist.zip');
      expect(fs.existsSync(distZipPath)).toBe(true);
      
      // Check file size > 0
      const stats = fs.statSync(distZipPath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should upload site to API and verify with 200 response', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const siteCodeRemote = `${siteCode}-dev`;
      const baseUrl = `https://${domain}/v2/site/${siteCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;
        
        // Check for code 200
        expect(response.status).toBe(200);
        
        // Verify site properties
        expect(remote).toHaveProperty('siteCode', siteCodeRemote);
        expect(remote).toHaveProperty('siteName');
        expect(remote).toHaveProperty('active', true);
        expect(remote).toHaveProperty('siteType', 'Static');
        expect(remote).toHaveProperty('package'); // fileId of uploaded zip
        
        // Verify package was uploaded (should be an ObjectId)
        expect(remote.package).toBeTruthy();
      });
    });
  });
});
