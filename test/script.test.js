const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
/* global describe, beforeAll, it, expect */

const config = require('./config.json');

describe('Prolibu CLI - Scripts', () => {
  let scriptCode;
  let scriptFolder;
  let createError = null;

  beforeAll(() => {
    // Remove profile.json so it is created by the test
    const profilePath = path.join(__dirname, '..', 'accounts', config.domain, 'profile.json');
    if (fs.existsSync(profilePath)) {
      fs.unlinkSync(profilePath);
    }
    // Remove all folders inside the domain that start with 'hook-test-'
    const domainPath = path.join(__dirname, '..', 'accounts', config.domain);
    if (fs.existsSync(domainPath)) {
      fs.readdirSync(domainPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('hook-test-'))
        .forEach(dirent => {
          const folderPath = path.join(domainPath, dirent.name);
          fs.rmSync(folderPath, { recursive: true, force: true });
        });
    }
    const timestamp = Date.now();
    scriptCode = `hook-test-${timestamp}`;
    scriptFolder = path.join(__dirname, '..', 'accounts', config.domain, scriptCode);
    const cmd = `./script create \
      --domain ${config.domain} \
      --prefix ${scriptCode} \
      --repo ${config.repo} \
      --lifecycleHooks "Contact" \
      --apikey ${config.apiKey}`;
    try {
      execSync(cmd, { stdio: 'inherit' });
    } catch (e) {
      createError = e;
    }
  });

  describe('Create Command', () => {
    it('should exit successfully when creating a new script', () => {
      expect(createError).toBeNull();
    });

    it('should create all template files in the new script folder', () => {
      const expectedFiles = [
        'index.js',
        'lib',
        'config.json',
        'settings.json',
        'README.md'
      ];
      expectedFiles.forEach(file => {
        expect(fs.existsSync(path.join(scriptFolder, file))).toBe(true);
      });
    });

    it('should have lifecycleHooks in config.json with ["Contact"]', () => {
      const configPath = path.join(scriptFolder, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(Array.isArray(configData.lifecycleHooks)).toBe(true);
      expect(configData.lifecycleHooks).toEqual(expect.arrayContaining(["Contact"]));
    });

    it('should exists the profile.json with correct apiKey', () => {
      const profilePath = path.join(__dirname, '..', 'accounts', config.domain, 'profile.json');
      expect(fs.existsSync(profilePath)).toBe(true);
      const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      expect(profileData.apiKey).toBe(config.apiKey);
      expect(profileData.domain).toBeUndefined(); // domain should not be saved in profile.json
    });
  });

  describe('Dev Command', () => {
    it('should execute dev command "no --watch" without errors', () => {
      let devError = null;
      const cmd = `./script dev \
        --domain ${config.domain} \
        --prefix ${scriptCode}`;
        
      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (e) {
        devError = e;
      }
      expect(devError).toBeNull();
    });

    it('should check all have been uploaded after dev command', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const scriptName = scriptCode;
      const scriptCodeRemote = `${scriptName}-dev`;
      const baseUrl = `https://${domain}/v2/script/${scriptCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;
        // check for code 200
        expect(response.status).toBe(200);
        
        // Read variables from local config.json
        const configPath = path.join(scriptFolder, 'config.json');
        const localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        // Verify variables were uploaded
        if (localConfig.variables && localConfig.variables.length > 0) {
          expect(remote.variables.length).toBe(localConfig.variables.length);
          expect(remote.variables[0]).toHaveProperty('key', localConfig.variables[0].key);
          expect(remote.variables[0]).toHaveProperty('value', localConfig.variables[0].value);
        }
        
        expect(remote).toHaveProperty('code');
        // Compare remote.code agains dist/bundle.js length
        const distPath = path.join(scriptFolder, 'dist', 'bundle.js');
        expect(fs.existsSync(distPath)).toBe(true);
        const localCode = fs.readFileSync(distPath, 'utf8');
        expect(remote.code.length).toBe(localCode.length);
        
        expect(remote).toHaveProperty('readme');
        const localReadme = fs.readFileSync(path.join(scriptFolder, 'README.md'), 'utf8');
        expect(remote.readme).toBe(localReadme);
        
        expect(remote).toHaveProperty('lifecycleHooks');
        expect(remote.lifecycleHooks).toEqual(expect.arrayContaining(["Contact"]));
        
        expect(remote).toHaveProperty('active', true);

        expect(remote).toHaveProperty('scriptCode', scriptCodeRemote);

        expect(remote.git).toHaveProperty('repositoryUrl', config.repo);
      });
    });

    it('should run the script to check input', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const scriptName = scriptCode;
      const scriptCodeRemote = `${scriptName}-dev`;
      const baseUrl = `https://${domain}/v2/script/run`;
      const headers = { Authorization: `Bearer ${apiKey}` };
      const params = { scriptId: scriptCodeRemote, test: 123 };

      return axios.get(baseUrl, { headers, params }).then(response => {
        const remote = response.data;

        // check for code 200
        expect(response.status).toBe(200);
        expect(remote).toHaveProperty('output');
        expect(remote).toHaveProperty('eventData');
        expect(remote.eventData).toHaveProperty('query');
        expect(remote.eventData.query).toHaveProperty('test', '123');
        expect(remote).toHaveProperty('error', null);
      });
    });

    it('should update index.js with console.log and publish with dev', () => {
      const newCode = `console.log('hola mundo!');output=1980;// comment`;
      fs.writeFileSync(path.join(scriptFolder, 'index.js'), newCode);
      expect(fs.readFileSync(path.join(scriptFolder, 'index.js'), 'utf8')).toBe(newCode);

      let devError = null;
      const cmd = `./script dev --domain ${config.domain} --prefix ${scriptCode}`;
      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (e) {
        devError = e;
      }
      expect(devError).toBeNull();
    });

    it('should check all code has been uploaded after dev command', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const scriptName = scriptCode;
      const scriptCodeRemote = `${scriptName}-dev`;
      const baseUrl = `https://${domain}/v2/script/${scriptCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;
        // check for code 200
        expect(response.status).toBe(200);
        
        expect(remote).toHaveProperty('code');
        // Compare remote.code agains dist/bundle.js length
        const distPath = path.join(scriptFolder, 'dist', 'bundle.js');
        expect(fs.existsSync(distPath)).toBe(true);
        const localCode = fs.readFileSync(distPath, 'utf8');
        expect(remote.code.length).toBe(localCode.length);
        expect(remote.code).toContain('hola mundo!');
      });

    });
  });

  describe('Prod Command', () => {
    it('should execute prod command "no --watch" without errors', () => {
      let prodError = null;
      const cmd = `./script prod \
        --domain ${config.domain} \
        --prefix ${scriptCode}`;
        
      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (e) {
        prodError = e;
      }
      expect(prodError).toBeNull();
    });

    it('should check all code has been uploaded after prod command', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const scriptName = scriptCode;
      const scriptCodeRemote = scriptName; // prod doesn't use -prod suffix anymore
      const baseUrl = `https://${domain}/v2/script/${scriptCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;
        expect(response.status).toBe(200);
        
        expect(remote).toHaveProperty('code');
        expect(remote.code).not.toContain('comment');
      });
    });
  });

  describe('Config.json Unified System', () => {
    it('should have config.json with all required fields', () => {
      const configPath = path.join(scriptFolder, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Verify all MODEL fields exist (no build settings)
      expect(configData).toHaveProperty('variables');
      expect(configData).toHaveProperty('lifecycleHooks');
      expect(configData).toHaveProperty('readme');
      expect(configData).toHaveProperty('git');
      
      // Should NOT have build settings (moved to settings.json)
      expect(configData).not.toHaveProperty('minifyProductionCode');
      expect(configData).not.toHaveProperty('removeComments');
      expect(configData).not.toHaveProperty('port');
      
      // Verify types
      expect(Array.isArray(configData.variables)).toBe(true);
      expect(Array.isArray(configData.lifecycleHooks)).toBe(true);
      expect(typeof configData.readme).toBe('string');
      expect(typeof configData.git).toBe('object');
      expect(configData.git).toHaveProperty('repositoryUrl');
    });

    it('should have settings.json with build configuration', () => {
      const settingsPath = path.join(scriptFolder, 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);
      
      const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      
      // Verify build settings exist
      expect(settingsData).toHaveProperty('minifyProductionCode');
      expect(settingsData).toHaveProperty('removeComments');
      
      // Should NOT have model data
      expect(settingsData).not.toHaveProperty('variables');
      expect(settingsData).not.toHaveProperty('lifecycleHooks');
      expect(settingsData).not.toHaveProperty('git');
    });

    it('should prioritize config.json over legacy files', () => {
      const configPath = path.join(scriptFolder, 'config.json');
      const variablesPath = path.join(scriptFolder, 'variables.json');
      const hooksPath = path.join(scriptFolder, 'lifecycleHooks.json');
      
      // config.json must exist
      expect(fs.existsSync(configPath)).toBe(true);
      
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // config.json should have the unified structure
      expect(configData).toHaveProperty('variables');
      expect(configData).toHaveProperty('lifecycleHooks');
      
      // If legacy files exist from cloned repo, config.json takes precedence
      if (fs.existsSync(variablesPath) && fs.existsSync(hooksPath)) {
        // This is OK - repo may have legacy files, but we use config.json
        expect(configData.variables).toBeDefined();
        expect(configData.lifecycleHooks).toBeDefined();
      }
    });

    it('should sync README.md content to config.json.readme', () => {
      const configPath = path.join(scriptFolder, 'config.json');
      const readmePath = path.join(scriptFolder, 'README.md');
      
      const readmeContent = fs.readFileSync(readmePath, 'utf8');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // README.md should be synced to config.json.readme
      expect(configData.readme).toBe(readmeContent);
    });

    it('should update config.json when modifying variables array', () => {
      const configPath = path.join(scriptFolder, 'config.json');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Add new variable
      configData.variables.push({ key: 'TEST_VAR', value: 'test_value_123' });
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
      
      // Verify it was saved
      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(updatedConfig.variables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'TEST_VAR', value: 'test_value_123' })
        ])
      );
    });

    it('should upload all config fields when running dev command', () => {
      const axios = require('axios');
      const configPath = path.join(scriptFolder, 'config.json');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Modify config with specific test data
      configData.variables = [
        { key: 'CONFIG_TEST', value: 'unified_system' },
        { key: 'TIMESTAMP', value: Date.now().toString() }
      ];
      // Use only Contact hook (we know it's enabled)
      configData.lifecycleHooks = ['Contact'];
      configData.git.repositoryUrl = config.repo;
      
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
      
      // Run dev to upload
      const cmd = `./script dev --domain ${config.domain} --prefix ${scriptCode}`;
      execSync(cmd, { stdio: 'inherit' });
      
      // Verify all fields were uploaded
      const apiKey = config.apiKey;
      const domain = config.domain;
      const scriptCodeRemote = `${scriptCode}-dev`;
      const baseUrl = `https://${domain}/v2/script/${scriptCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;
        
        // Verify variables
        expect(remote.variables.length).toBe(2);
        expect(remote.variables).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: 'CONFIG_TEST', value: 'unified_system' })
          ])
        );
        
        // Verify lifecycleHooks
        expect(remote.lifecycleHooks).toEqual(expect.arrayContaining(['Contact']));
        
        // Verify git
        expect(remote.git.repositoryUrl).toBe(config.repo);
        
        // Verify readme
        const readmeContent = fs.readFileSync(path.join(scriptFolder, 'README.md'), 'utf8');
        expect(remote.readme).toBe(readmeContent);
      });
    });

    it('should have config.json in .gitignore', () => {
      const gitignorePath = path.join(scriptFolder, '.gitignore');
      
      if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
        expect(gitignoreContent).toContain('config.json');
        expect(gitignoreContent).toContain('settings.json');
        expect(gitignoreContent).not.toContain('variables.json');
      }
    });

    it('should merge repo config.json with template config.json on create', () => {
      const configPath = path.join(scriptFolder, 'config.json');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Should have model fields only
      expect(configData).toHaveProperty('variables');
      expect(configData).toHaveProperty('lifecycleHooks');
      expect(configData).toHaveProperty('git');
      
      // Should NOT have build settings (those are in settings.json)
      expect(configData).not.toHaveProperty('minifyProductionCode');
      expect(configData).not.toHaveProperty('removeComments');
      
      // Should have merged lifecycleHooks (template + --lifecycleHooks flag)
      expect(configData.lifecycleHooks).toEqual(expect.arrayContaining(['Contact']));
    });
  });
});
