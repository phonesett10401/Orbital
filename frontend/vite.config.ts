// defineConfig comes from vitest/config rather than vite so the `test` block
// typechecks; it is the same function with the test options layered on.
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Put MapLibre's worker next to MapLibre's chunk in the build output.
 *
 * **This is the production half of the bug D63 fixed for the dev server**, and
 * it went unnoticed for as long as it did because the two halves look
 * identical from the outside and only one of them was ever exercised.
 *
 * MapLibre spawns its tile worker as `new Worker(new URL(e, import.meta.url))`
 * where `e` is a *variable* — it chooses between the dev and production worker
 * at runtime. Vite can only follow that pattern when the path is a string
 * literal, so it emits nothing and leaves the URL to resolve against the
 * chunk's own folder at runtime: `/assets/maplibre-gl-worker.mjs`, where
 * nothing exists.
 *
 * The failure is the same silent one D63 describes, and worse than it looks.
 * Raster imagery paints perfectly, because raster tiles are loaded on the main
 * thread — so the globe appears. But the worker 404s, tile processing never
 * completes, `load` never fires, and **every layer this application adds
 * inside that handler is never created**: aircraft, satellites and ships all
 * absent while the status bar cheerfully counts them, because the counts come
 * from the store and not from the map.
 *
 * Measured on the deployment: 404 on the worker, zero markers drawn, and
 * `/api/aircraft` answering 200 with 2,000 objects at the same moment.
 *
 * Both files are needed and both keep their exact names. The worker resolves
 * its sibling by the literal specifier `./maplibre-gl-shared.mjs`, so a hashed
 * copy would 404 in precisely the same way one level down.
 */
function maplibreWorker(): Plugin {
  const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];
  let destination = '';

  return {
    name: 'orbital:maplibre-worker',
    // Build only. The dev server resolves the worker itself, which is what
    // `optimizeDeps.exclude` below is for.
    apply: 'build',
    configResolved(config) {
      destination = path.resolve(config.root, config.build.outDir, config.build.assetsDir);
    },
    async closeBundle() {
      const source = path.dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'));
      for (const file of FILES) {
        await copyFile(path.join(source, file), path.join(destination, file));
        // Assert rather than trust. The whole reason this defect survived is
        // that a missing worker says nothing at all, so a build that fails to
        // produce one must fail loudly here instead of at a user's browser.
        const written = await stat(path.join(destination, file));
        if (written.size === 0) {
          throw new Error(`maplibre worker asset is empty after copy: ${file}`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), maplibreWorker()],
  // globe.gl pulls in its own copy of three. Without deduping, our material and
  // the globe's renderer come from different module instances -- `instanceof`
  // checks fail, and custom materials and raycasting silently stop working.
  resolve: {
    dedupe: ['three'],
  },
  /**
   * MapLibre fetches and parses vector tiles in a Web Worker. Vite's dev
   * dependency pre-bundling rewrites the module in a way that breaks that
   * worker, and the failure is completely silent: no error, no request, and a
   * map that renders raster imagery perfectly — because raster tiles are
   * loaded on the main thread — while never drawing a single road or label.
   *
   * Measured both ways on the running app: with this exclusion, 1,418 vector
   * features render at zoom 14 over Bangkok; without it, the source never
   * loads and there are none (D63).
   *
   * Excluding it makes Vite serve MapLibre's own ESM, whose worker URL then
   * resolves correctly.
   *
   * **This covers the dev server only.** `optimizeDeps` has no effect on
   * `vite build`; the built output needs `maplibreWorker()` above (D179).
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
