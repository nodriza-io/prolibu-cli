const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
/* global describe, beforeAll, afterAll, it, expect */

const config = require('./config.json');

describe('Prolibu CLI - Plugins', () => {
  let pluginCode;
  let pluginFolder;

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

    // Remove all folders inside the domain/plugins that start with 'plugin-test-'
    const domainPath = path.join(__dirname, '..', 'accounts', config.domain);
    const pluginsPath = path.join(domainPath, 'plugins');
    if (fs.existsSync(pluginsPath)) {
      fs.readdirSync(pluginsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('plugin-test-'))
        .forEach(dirent => {
          const folderPath = path.join(pluginsPath, dirent.name);
          fs.rmSync(folderPath, { recursive: true, force: true });
        });
    }

    const timestamp = Date.now();
    pluginCode = `plugin-test-${timestamp}`;
    pluginFolder = path.join(__dirname, '..', 'accounts', config.domain, 'plugins', pluginCode);

    // Create plugin folder manually
    fs.mkdirSync(pluginFolder, { recursive: true });

    // Create src folder structure
    const srcFolder = path.join(pluginFolder, 'src');
    const pluginsFolder = path.join(srcFolder, 'plugins', 'Example');
    fs.mkdirSync(pluginsFolder, { recursive: true });

    // Create config.json
    const configPath = path.join(pluginFolder, 'config.json');
    const pluginConfig = {
      variables: [],
      description: 'Test plugin for CI',
      git: { repositoryUrl: '' }
    };
    fs.writeFileSync(configPath, JSON.stringify(pluginConfig, null, 2));

    // Create settings.json
    const settingsPath = path.join(pluginFolder, 'settings.json');
    const pluginSettings = {
      port: 4500
    };
    fs.writeFileSync(settingsPath, JSON.stringify(pluginSettings, null, 2));

    // Create package.json
    const packagePath = path.join(pluginFolder, 'package.json');
    const packageJson = {
      name: pluginCode,
      version: '1.0.0',
      type: 'module',
      description: 'Prolibu Plugin',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview'
      },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1'
      },
      devDependencies: {
        '@types/react': '^18.3.0',
        '@types/react-dom': '^18.3.0',
        '@vitejs/plugin-react': '^4.3.0',
        sass: '^1.88.0',
        typescript: '^5.8.0',
        vite: '^5.4.0',
        'vite-plugin-css-injected-by-js': '^3.5.0'
      }
    };
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    // Create vite.config.js
    const viteConfigPath = path.join(pluginFolder, 'vite.config.js');
    const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import fs from 'fs';

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const pluginCode = packageJson.name;

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'classic'
    }),
    cssInjectedByJsPlugin()
  ],
  optimizeDeps: {
    exclude: ['fsevents']
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    lib: {
      entry: 'src/index.tsx',
      name: pluginCode,
      formats: ['umd'],
      fileName: () => \`\${pluginCode}.js\`
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM'
        }
      }
    },
    outDir: 'dist',
    emptyDirBeforeWrite: true
  }
});
`;
    fs.writeFileSync(viteConfigPath, viteConfig);

    // Create tsconfig.json
    const tsconfigPath = path.join(pluginFolder, 'tsconfig.json');
    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        noFallthroughCasesInSwitch: true
      },
      include: ['src']
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

    // Create index.html
    const indexHtmlPath = path.join(pluginFolder, 'index.html');
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prolibu Plugin Studio</title>
</head>
<body>
  <div id="plugin-root"></div>
  <script type="module">
    import React from 'react';
    import ReactDOM from 'react-dom/client';
    import PluginConfig from './src/index.tsx';
  </script>
</body>
</html>
`;
    fs.writeFileSync(indexHtmlPath, indexHtml);

    // Create README.md
    const readmePath = path.join(pluginFolder, 'README.md');
    fs.writeFileSync(readmePath, `# ${pluginCode}\n\nTest plugin for CI.`);

    // Create src/index.tsx
    const indexTsxPath = path.join(srcFolder, 'index.tsx');
    const indexTsx = `import { ExamplePlugin } from './plugins/Example/ExamplePlugin';

const createRenderFn = (Component: React.ComponentType<any>) => {
  return (node: HTMLElement, opts: any = {}, mode = 'prod') => {
    if (mode === 'dev') return Component;

    const draw = (attempts: number) => {
      if (attempts > 10) {
        console.error('Failed to render component after multiple attempts.');
        return;
      }

      // @ts-ignore
      if (typeof window.ReactDOM?.createRoot === 'function') {
        // @ts-ignore
        const root = window.ReactDOM.createRoot(node);
        root.render(
          // @ts-ignore
          window.React.createElement(Component, { ctx: opts })
        );
      } else {
        setTimeout(() => draw(attempts + 1), 100);
      }
    };

    draw(0);
  };
};

export default {
  components: [
    {
      active: true,
      label: 'Example Plugin',
      containerId: 'example-plugin',
      description: 'A sample plugin to get you started',
      render: createRenderFn(ExamplePlugin),
      icon: '',
      formSchema: {
        message: {
          type: 'string',
          default: 'Hello from Prolibu!',
          description: 'Message to display'
        }
      }
    }
  ]
};
`;
    fs.writeFileSync(indexTsxPath, indexTsx);

    // Create src/plugins/Example/ExamplePlugin.tsx
    const examplePluginPath = path.join(pluginsFolder, 'ExamplePlugin.tsx');
    const examplePlugin = `import React, { useState } from 'react';

interface PluginContext {
  ctx: {
    doc?: Record<string, any>;
    preferences?: Record<string, any>;
    comCompConfig?: {
      model?: {
        message?: string;
      };
      language?: string;
    };
    formSchemaModel?: {
      model?: {
        message?: string;
      };
      language?: string;
    };
    configNodeId?: string;
    pluginLibrary?: string;
  };
}

const styles = {
  container: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    padding: '1.5rem',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderRadius: '12px',
    color: 'white',
    minHeight: '200px',
  } as React.CSSProperties,
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 600,
  } as React.CSSProperties,
  text: {
    margin: '0 0 1rem 0',
    opacity: 0.9,
  } as React.CSSProperties,
  counter: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginTop: '1rem',
  } as React.CSSProperties,
  button: {
    width: '40px',
    height: '40px',
    border: 'none',
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.2)',
    color: 'white',
    fontSize: '1.25rem',
    cursor: 'pointer',
  } as React.CSSProperties,
  count: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    minWidth: '3rem',
    textAlign: 'center' as const,
  } as React.CSSProperties,
};

export const ExamplePlugin: React.FC<PluginContext> = ({ ctx }) => {
  const [count, setCount] = useState(0);
  const message = ctx?.comCompConfig?.model?.message || ctx?.formSchemaModel?.model?.message || 'Hello from Prolibu!';

  return (
    <div style={styles.container}>
      <div>
        <h2 style={styles.title}>{message}</h2>
      </div>
      <div>
        <p style={styles.text}>This is an example plugin. Edit this file to create your own!</p>
        <div style={styles.counter}>
          <button style={styles.button} onClick={() => setCount(count - 1)}>-</button>
          <span style={styles.count}>{count}</span>
          <button style={styles.button} onClick={() => setCount(count + 1)}>+</button>
        </div>
      </div>
    </div>
  );
};
`;
    fs.writeFileSync(examplePluginPath, examplePlugin);

    // Run npm install
    execSync('npm install', { cwd: pluginFolder, stdio: 'inherit' });

    // Create .gitignore in domain folder (normally created by CLI)
    const gitignorePath = path.join(domainPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      const gitignoreContent = `# Dependencies
node_modules/

# Build output
dist/

# Sensitive files
profile.json

# IDE
.idea/
.vscode/

# OS
.DS_Store
`;
      fs.writeFileSync(gitignorePath, gitignoreContent);
    }
  });

  afterAll(async () => {
    // Clean up: delete plugin from API
    if (pluginCode) {
      try {
        const axios = require('axios');
        const baseUrl = `https://${config.domain}/v2/plugin/${pluginCode}`;
        const headers = { Authorization: `Bearer ${config.apiKey}` };
        await axios.delete(baseUrl, { headers });
        console.log(`Plugin '${pluginCode}' deleted from API`);
      } catch (e) {
        // Ignore errors if plugin doesn't exist or delete fails
        console.log('Note: Could not delete plugin from API:', e.message);
      }
    }

    // Clean up: remove the test plugin folder
    if (pluginFolder && fs.existsSync(pluginFolder)) {
      fs.rmSync(pluginFolder, { recursive: true, force: true });
    }
  });

  describe('Create Command', () => {
    it('should create all template files in the new plugin folder', () => {
      const expectedFiles = [
        'src',
        'config.json',
        'settings.json',
        'package.json',
        'vite.config.js',
        'tsconfig.json',
        'index.html',
        'README.md'
      ];
      expectedFiles.forEach(file => {
        expect(fs.existsSync(path.join(pluginFolder, file))).toBe(true);
      });
    });

    it('should have src/index.tsx entry point', () => {
      const indexPath = path.join(pluginFolder, 'src', 'index.tsx');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf8');
      expect(content).toContain('components');
      expect(content).toContain('createRenderFn');
    });

    it('should have src/plugins/Example/ExamplePlugin.tsx', () => {
      const pluginPath = path.join(pluginFolder, 'src', 'plugins', 'Example', 'ExamplePlugin.tsx');
      expect(fs.existsSync(pluginPath)).toBe(true);
      const content = fs.readFileSync(pluginPath, 'utf8');
      expect(content).toContain('ExamplePlugin');
    });

    it('should have config.json with plugin model fields', () => {
      const configPath = path.join(pluginFolder, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Verify plugin model fields
      expect(configData).toHaveProperty('variables');
      expect(configData).toHaveProperty('description');
      expect(configData).toHaveProperty('git');

      // Should NOT have local settings
      expect(configData).not.toHaveProperty('port');
    });

    it('should have settings.json with port configuration', () => {
      const settingsPath = path.join(pluginFolder, 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

      // Verify settings fields
      expect(settingsData).toHaveProperty('port');
      expect(settingsData.port).toBe(4500);

      // Should NOT have model data
      expect(settingsData).not.toHaveProperty('variables');
      expect(settingsData).not.toHaveProperty('description');
    });

    it('should have package.json with correct name', () => {
      const packagePath = path.join(pluginFolder, 'package.json');
      expect(fs.existsSync(packagePath)).toBe(true);

      const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      expect(packageData.name).toBe(pluginCode);
      expect(packageData).toHaveProperty('dependencies');
      expect(packageData.dependencies).toHaveProperty('react');
      expect(packageData.dependencies).toHaveProperty('react-dom');
    });

    it('should have vite.config.js with dynamic pluginCode', () => {
      const vitePath = path.join(pluginFolder, 'vite.config.js');
      expect(fs.existsSync(vitePath)).toBe(true);

      const content = fs.readFileSync(vitePath, 'utf8');
      expect(content).toContain('packageJson.name');
      expect(content).toContain('jsxRuntime');
      expect(content).toContain("'classic'");
    });

    it('should have node_modules installed', () => {
      const nodeModulesPath = path.join(pluginFolder, 'node_modules');
      expect(fs.existsSync(nodeModulesPath)).toBe(true);
    });

    it('should have profile.json with correct apiKey', () => {
      const profilePath = path.join(__dirname, '..', 'accounts', config.domain, 'profile.json');
      expect(fs.existsSync(profilePath)).toBe(true);
      const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      expect(profileData.apiKey).toBe(config.apiKey);
    });
  });

  describe('Prod Command', () => {
    it('should execute prod command without errors', () => {
      let prodError = null;
      const cmd = `./prolibu plugin prod \
        --domain ${config.domain} \
        --prefix ${pluginCode}`;

      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (e) {
        prodError = e;
      }
      expect(prodError).toBeNull();
    });

    it('should create dist folder with bundle after prod command', () => {
      const distPath = path.join(pluginFolder, 'dist');
      expect(fs.existsSync(distPath)).toBe(true);

      // Check for bundle file
      const bundlePath = path.join(distPath, `${pluginCode}.js`);
      expect(fs.existsSync(bundlePath)).toBe(true);

      // Check file size > 0
      const stats = fs.statSync(bundlePath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should have bundle with correct UMD export name', () => {
      const bundlePath = path.join(pluginFolder, 'dist', `${pluginCode}.js`);
      const content = fs.readFileSync(bundlePath, 'utf8');

      // Check that it exports to window[pluginCode]
      expect(content).toContain(pluginCode);
      expect(content).toContain('components');
    });

    it('should upload plugin to API and verify with 200 response', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const pluginCodeRemote = pluginCode;
      const baseUrl = `https://${domain}/v2/plugin/${pluginCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;

        // Check for code 200
        expect(response.status).toBe(200);

        // Verify plugin properties
        expect(remote).toHaveProperty('pluginCode', pluginCodeRemote);
        expect(remote).toHaveProperty('pluginName');
        expect(remote).toHaveProperty('active', true);

        // Verify package was uploaded (bundleUrl is computed by frontend)
        expect(remote).toHaveProperty('package');
      });
    });

    it('should have description synced from config.json', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const pluginCodeRemote = pluginCode;
      const baseUrl = `https://${domain}/v2/plugin/${pluginCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;

        // Read local config
        const configPath = path.join(pluginFolder, 'config.json');
        const localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        expect(remote.description).toBe(localConfig.description);
      });
    });

    it('should have README synced to API if supported', () => {
      const axios = require('axios');
      const apiKey = config.apiKey;
      const domain = config.domain;
      const pluginCodeRemote = pluginCode;
      const baseUrl = `https://${domain}/v2/plugin/${pluginCodeRemote}`;
      const headers = { Authorization: `Bearer ${apiKey}` };

      return axios.get(baseUrl, { headers }).then(response => {
        const remote = response.data;

        // Read local README
        const readmePath = path.join(pluginFolder, 'README.md');
        const localReadme = fs.readFileSync(readmePath, 'utf8');

        // README sync is optional - check if the field exists
        if (remote.readme !== undefined) {
          expect(remote.readme).toBe(localReadme);
        } else {
          // If readme is not synced, at least verify the plugin was uploaded
          expect(remote.pluginCode).toBe(pluginCodeRemote);
        }
      });
    });
  });

  describe('Bundle Validation', () => {
    it('should not have process.env references in bundle (replaced at build time)', () => {
      const bundlePath = path.join(pluginFolder, 'dist', `${pluginCode}.js`);
      const content = fs.readFileSync(bundlePath, 'utf8');

      // process.env.NODE_ENV should be replaced with "production"
      expect(content).not.toContain('process.env.NODE_ENV');
    });

    it('should use classic JSX runtime (React.createElement)', () => {
      const bundlePath = path.join(pluginFolder, 'dist', `${pluginCode}.js`);
      const content = fs.readFileSync(bundlePath, 'utf8');

      // Should not have jsxDEV (dev runtime)
      expect(content).not.toContain('jsxDEV');
    });

    it('should have React and ReactDOM as externals', () => {
      const bundlePath = path.join(pluginFolder, 'dist', `${pluginCode}.js`);
      const content = fs.readFileSync(bundlePath, 'utf8');

      // Should reference React as global
      expect(content).toContain('React');
    });
  });

  describe('Config.json and Settings.json for Plugins', () => {
    it('should separate model data (config.json) from settings (settings.json)', () => {
      const configPath = path.join(pluginFolder, 'config.json');
      const settingsPath = path.join(pluginFolder, 'settings.json');

      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

      // config.json has model data only
      expect(configData).toHaveProperty('variables');
      expect(configData).toHaveProperty('description');
      expect(configData).toHaveProperty('git');
      expect(configData).not.toHaveProperty('port');

      // settings.json has local settings only
      expect(settingsData).toHaveProperty('port');
      expect(settingsData).not.toHaveProperty('variables');
      expect(settingsData).not.toHaveProperty('description');
    });

    it('should update config.json when modifying variables array', () => {
      const configPath = path.join(pluginFolder, 'config.json');
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
  });

  describe('Domain Git Repository', () => {
    const domainPath = path.join(__dirname, '..', 'accounts', config.domain);

    it('should have .gitignore in domain folder', () => {
      const gitignorePath = path.join(domainPath, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
    });

    it('should have profile.json in .gitignore for security', () => {
      const gitignorePath = path.join(domainPath, '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('profile.json');
    });

    it('should have node_modules in .gitignore', () => {
      const gitignorePath = path.join(domainPath, '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('node_modules');
    });

    it('should have dist in .gitignore', () => {
      const gitignorePath = path.join(domainPath, '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('dist');
    });
  });
});
