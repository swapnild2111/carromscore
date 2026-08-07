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
});
