// vite.config.js
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  plugins: [
    svelte(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'prompt',
      injectRegister: false,

      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],

      // Precache rules (what gets cached for offline boot)
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webp}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },

      // Dev mode: SW active so you can test in `npm run dev`
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },

      manifest: {
        name: 'IEBC Field',
        short_name: 'IEBC Field',
        description: 'KIEMS field reporting',
        theme_color: '#073b2b',
        background_color: '#06271d',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',        // ← Android home-screen icon quality
          },
        ],
      },
    }),
  ],

  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/kiems': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/movement': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/static': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/iebc-proxy': { target: 'http://127.0.0.1:8000', changeOrigin: true },

    },
  },
});