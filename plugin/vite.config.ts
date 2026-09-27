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
    rolldownOptions: {
      // The panel, and the page of the window it opens at the cursor.
      input: { index: 'index.html', bubble: 'bubble.html' },
    },
  },
});
