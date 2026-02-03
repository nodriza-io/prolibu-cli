import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// Read plugin name from package.json (must match pluginCode)
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const pluginCode = packageJson.name;

// Plugin to handle publish from the Studio UI
function prolibuPublishPlugin() {
  return {
    name: 'prolibu-publish',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/__prolibu_publish__' && req.method === 'POST') {
          try {
            // Extract domain and plugin from current path
            const cwd = process.cwd();
            const parts = cwd.split(path.sep);
            const accountsIdx = parts.indexOf('accounts');

            if (accountsIdx === -1) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Not in accounts directory' }));
              return;
            }

            const domain = parts[accountsIdx + 1];
            const pluginPrefix = parts[accountsIdx + 2];

            // Find prolibu CLI (go up to the CLI root)
            const cliRoot = parts.slice(0, accountsIdx).join(path.sep);
            const prolibucli = path.join(cliRoot, 'prolibu');

            console.log(`\n[PUBLISH] Building and uploading '${pluginPrefix}' to '${domain}'...`);

            // Run the prod command
            execSync(`node ${prolibucli} plugin prod --domain ${domain} --prefix ${pluginPrefix}`, {
              cwd: cliRoot,
              stdio: 'inherit'
            });

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            console.error('[PUBLISH] Error:', err.message);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'classic'  // Use classic runtime for better compatibility
    }),
    cssInjectedByJsPlugin(),
    prolibuPublishPlugin()
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
      name: pluginCode,  // Must match pluginCode for window[pluginCode].components
      formats: ['umd'],
      fileName: () => `${pluginCode}.js`
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
