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
      // The panel, the page of the window it opens at the cursor, and the
      // script of the portal's portion pages. The portal renders those pages
      // itself and cannot know the build's hashes: their script keeps a fixed
      // name.
      input: { index: 'index.html', bubble: 'bubble.html', portion: 'src/portion-page.tsx' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'portion' ? 'portion.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
