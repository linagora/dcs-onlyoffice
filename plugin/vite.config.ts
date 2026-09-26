import { defineConfig } from 'vite';

// The plugin is served by the portal under /plugin/, so every URL stays
// relative to index.html.
export default defineConfig({
  base: './',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
