// @ts-check
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

/*
 * Base path for the built site.
 *   - Production (main branch → GitHub Pages root):  /carromscore/
 *   - Beta       (v2.0-dev branch → /beta subpath):   /carromscore/beta/
 *
 * The deploy workflow sets PUBLIC_BASE per branch build. Local dev
 * falls back to /carromscore/ so URLs match production.
 */
const base = process.env.PUBLIC_BASE || '/carromscore/';

// https://astro.build/config
export default defineConfig({
  site: 'https://swapnild2111.github.io',
  base,
  integrations: [svelte()],
  devToolbar: {
    // Hides Astro's floating dev toolbar in the browser. Its HMR
    // socket occasionally refuses to reconnect after a Vite restart,
    // then floods the console with `Cannot read properties of undefined
    // (reading 'send')`. We don't use its features (audit / inspector
    // / settings) in this project, so turning it off is a pure win.
    enabled: false,
  },
});
