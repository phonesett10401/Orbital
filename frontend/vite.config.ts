// defineConfig comes from vitest/config rather than vite so the `test` block
// typechecks; it is the same function with the test options layered on.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // globe.gl pulls in its own copy of three. Without deduping, our material and
  // the globe's renderer come from different module instances -- `instanceof`
  // checks fail, and custom materials and raycasting silently stop working.
  resolve: {
    dedupe: ['three'],
  },
  /**
   * MapLibre spawns a Web Worker to fetch and parse vector tiles. Vite's dev
   * dependency pre-bundling rewrites the module in a way that loses the
   * worker: `getWorkerUrl()` comes back as an empty string, no worker is
   * created, and **no vector tile is ever requested** -- silently, with no
   * error, while raster imagery keeps working because it is loaded on the main
   * thread. That is exactly the failure this cost several rounds to find
   * (D62).
   *
   * Excluding it from pre-bundling makes Vite serve MapLibre's own ESM, whose
   * `new URL('./worker', import.meta.url)` then resolves correctly.
   */
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    // Proxy /api to the backend so the browser sees a single origin in
    // development. This is why VITE_API_BASE is empty by default, and why CORS
    // rarely comes up locally even though the backend does configure it (D20).
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
