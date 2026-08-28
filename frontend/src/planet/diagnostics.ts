/**
 * A development-only readout of what the map is actually doing.
 *
 * This exists because of a specific, repeated problem: the map is looked at on
 * one machine and debugged on another, and the two cannot see each other. The
 * browser surfaces available here do not composite, so MapLibre never gets the
 * `requestAnimationFrame` it needs to load a style or fetch a tile — every
 * probe reports "not loaded" whether the code is right or wrong. Meanwhile a
 * screenshot shows what is drawn and says nothing about why.
 *
 * So the map reports on itself, on screen, where a screenshot will carry it:
 * whether the style loaded, whether each source has tiles, how many requests
 * of each kind have gone out, and the last few errors MapLibre raised. Stripped
 * from production builds by the `DEV` guard, like the globe's console handle.
 */

export interface DiagnosticsPanel {
  element: HTMLDivElement;
  attach(map: import('maplibre-gl').Map): void;
  dispose(): void;
}

/** How many recent MapLibre errors to keep on screen. */
const ERROR_LIMIT = 3;

/** How often to refresh the readout. */
const REFRESH_MS = 1000;

/**
 * Count network requests by kind, from the browser's own timing entries.
 *
 * `performance.getEntriesByType` sees every request the page made, including
 * the ones MapLibre makes internally, which is what makes this possible
 * without instrumenting the library.
 */
export function requestCounts(names: string[]): Record<string, number> {
  const patterns: Array<[string, RegExp]> = [
    ['style', /styles\//],
    ['gibs', /gibs\.earthdata/],
    ['sentinel', /maps\.eox\.at/],
    ['vector', /\.pbf(\?|$)/],
    ['glyphs', /\/fonts\//],
    ['sprite', /\/sprites?\//],
  ];
  const counts: Record<string, number> = {};
  for (const [name, pattern] of patterns) {
    counts[name] = names.filter((n) => pattern.test(n)).length;
  }
  return counts;
}

/** The readout's text, as lines. Pure, so it can be tested. */
export function readoutLines(state: {
  styleLoaded: boolean;
  zoom: number;
  layers: number;
  counts: Record<string, number>;
  errors: string[];
}): string[] {
  const { styleLoaded, zoom, layers, counts, errors } = state;
  const lines = [
    `style ${styleLoaded ? 'loaded' : 'LOADING'} · z${zoom.toFixed(1)} · ${layers} layers`,
    `tiles: gibs ${counts.gibs} · sentinel ${counts.sentinel} · vector ${counts.vector}`,
    `glyphs ${counts.glyphs} · sprite ${counts.sprite}`,
  ];
  // Zero vector tiles with a loaded style is the interesting failure: every
  // road, label and building comes from that source, so nothing cartographic
  // draws and the imagery underneath looks like the whole map.
  if (styleLoaded && counts.vector === 0) {
    lines.push('NO VECTOR TILES — roads and labels cannot draw');
  }
  for (const error of errors.slice(-ERROR_LIMIT)) lines.push(`! ${error}`);
  return lines;
}

export function createDiagnosticsPanel(): DiagnosticsPanel {
  const element = document.createElement('div');
  element.className = 'planet-diagnostics';

  const errors: string[] = [];
  let timer = 0;

  return {
    element,

    attach(map) {
      map.on('error', (event) => {
        const error = event as unknown as { error?: { message?: string } };
        errors.push(String(error.error?.message ?? event).slice(0, 120));
      });

      const refresh = () => {
        const names = performance.getEntriesByType('resource').map((entry) => entry.name);
        let layers = 0;
        try {
          layers = map.getStyle()?.layers?.length ?? 0;
        } catch {
          // getStyle throws before the style is applied, which is itself the
          // thing being reported.
          layers = 0;
        }
        element.textContent = '';
        for (const line of readoutLines({
          // `isStyleLoaded` is typed as possibly returning void in this
          // version; the readout wants a definite answer either way.
          styleLoaded: map.isStyleLoaded() === true,
          zoom: map.getZoom(),
          layers,
          counts: requestCounts(names),
          errors,
        })) {
          const row = document.createElement('div');
          row.textContent = line;
          element.appendChild(row);
        }
      };

      refresh();
      timer = window.setInterval(refresh, REFRESH_MS);
    },

    dispose() {
      window.clearInterval(timer);
      element.remove();
    },
  };
}
