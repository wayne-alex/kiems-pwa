import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      devOptions: {
        enabled: true,       // ← REQUIRED: run the plugin in dev mode
        type: 'module',
      },
      manifest: {
        name: 'IEBC Field',
        short_name: 'IEBC',
        description: 'KIEMS field reporting',
        theme_color: '#F7F7F5',
        background_color: '#F7F7F5',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/kiems':    { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/api':      { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/movement': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/static':   { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/media':    { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});