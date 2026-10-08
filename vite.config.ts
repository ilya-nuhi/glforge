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
  // The compress worker loads its encoders lazily, which needs ES module
  // output: an IIFE worker cannot be split into chunks.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Only reached from inside the worker, which the dev server's startup scan
    // does not follow; listed so the first compress does not force a reload.
    include: [
      '@gltf-transform/core',
      '@gltf-transform/extensions',
      '@gltf-transform/functions',
      'meshoptimizer/encoder',
      'meshoptimizer/decoder',
      'draco3dgltf/draco_encoder_gltf_nodejs.js',
      'draco3dgltf/draco_decoder_gltf_nodejs.js',
    ],
    // These find their .wasm (and the loaders their decoder scripts) relative
    // to their own file, which pre-bundling would move. Moved, the dev server
    // answers those requests with index.html, and the preview's Draco/KTX2
    // worker dies on it without a word: "Loading preview…" never ends.
    exclude: [
      'ktx2-encoder',
      'three/addons/loaders/DRACOLoader.js',
      'three/addons/loaders/KTX2Loader.js',
    ],
  },
});
