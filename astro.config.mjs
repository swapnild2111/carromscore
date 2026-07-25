// @ts-check
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import { VitePWA } from 'vite-plugin-pwa';

// https://astro.build/config
export default defineConfig({
  site: 'https://swapnild2111.github.io',
  base: '/carromscore/',
  integrations: [svelte()],
  vite: {
    plugins: [
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        base: '/carromscore/',
        scope: '/carromscore/',
        includeAssets: ['favicon.svg', 'favicon.ico'],
        // NOTE: With Astro's dual-Vite build, vite-plugin-pwa currently emits
        // registerSW.js and the manifest but skips sw.js. As a v1 tradeoff we
        // ship without offline caching — the manifest still lets Chrome offer
        // "Add to Home Screen" for a standalone-display install. Full offline
        // support is a v1.5 followup (switch to injectManifest + src/sw.ts).
        manifest: {
          name: 'Carromscore',
          short_name: 'Carromscore',
          description: 'Live carrom scoring for players and broadcasters',
          theme_color: '#0b0b0b',
          background_color: '#0b0b0b',
          display: 'standalone',
          orientation: 'any',
          start_url: '/carromscore/',
          scope: '/carromscore/',
          icons: [
            { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        },
        workbox: {
          navigateFallback: '/carromscore/',
          globPatterns: ['**/*.{js,css,html,svg,ico,json}'],
        },
      }),
    ],
  },
});
