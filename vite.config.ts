import { defineConfig } from 'vite';

// Served from https://<user>.github.io/sceneforge/ — base must match the repo name.
export default defineConfig({
  base: '/sceneforge/',
  server: {
    port: 5180,
  },
  build: {
    // three.js is a deliberate lazy chunk; it never blocks first paint.
    chunkSizeWarningLimit: 800,
  },
});
