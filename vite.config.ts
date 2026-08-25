import { defineConfig } from 'vite';

// Served from https://<user>.github.io/glforge/ — base must match the repo name.
export default defineConfig({
  base: '/glforge/',
  server: {
    port: 5180,
  },
  build: {
    // three.js is a deliberate lazy chunk; it never blocks first paint.
    chunkSizeWarningLimit: 800,
  },
});
