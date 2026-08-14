import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // Emit relative asset URLs (./assets/…). The default ('/') produces absolute paths that
  // resolve against the domain root and 404, because the site is mounted at /site/<siteCode>/.
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
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
