import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // Emit relative asset URLs (./assets/…). The default ('/') produces absolute paths that
  // resolve against the domain root and 404, because the site is mounted at /site/<siteCode>/.
  base: './',
  plugins: [
    vue({
      // Cobalt's co-* tags are web components loaded at runtime, not Vue components.
      template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('co-') } },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3030,
    host: true,
  },
})
