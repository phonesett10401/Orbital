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
    // Whichever close tier is configured. Naming one provider here is how the
    // readout came to report "sentinel 0" while Esri tiles were streaming in.
    ['close', /maps\.eox\.at|arcgisonline\.com/],
    // Kept for completeness and NOT trusted: MapLibre fetches vector tiles
    // inside a Web Worker, and `performance.getEntriesByType` on the main
    // thread cannot see a worker's requests. This counter could only ever
    // read zero, which is precisely what it did while being believed (D61).
    ['vectorMainThread', /\.pbf(\?|$)/],
    ['glyphs', /\/fonts\//],
    ['sprite', /\/sprites?\//],
  ];
  const counts: Record<string, number> = {};
  for (const [name, pattern] of patterns) {
    counts[name] = names.filter((n) => pattern.test(n)).length;
  }
  return counts;
}

/**
 * The readout's text, as lines. Pure, so it can be tested.
 *
 * `features` is how many cartographic features MapLibre says it is currently
 * drawing. It is the line that separates the two explanations for an empty
 * map, which look identical in a screenshot: no features means the tiles never
 * arrived, while thousands of features with nothing visible means they are
 * being drawn in a colour that does not survive the imagery beneath them
 * (D59).
 */
export function readoutLines(state: {
  styleLoaded: boolean;
  zoom: number;
  layers: number;
  features: number;
  vector: VectorSourceState;
  counts: Record<string, number>;
  errors: string[];
}): string[] {
  const { styleLoaded, zoom, layers, features, vector, counts, errors } = state;
  const lines = [
    `style ${styleLoaded ? 'loaded' : 'LOADING'} · z${zoom.toFixed(1)} · ${layers} layers`,
    `imagery: gibs ${counts.gibs} · close ${counts.close}`,
    `vector src ${vector.present ? 'yes' : 'MISSING'} · loaded ${vector.loaded ? 'yes' : 'no'}` +
      ` · cached tiles ${vector.tiles} · features ${features}`,
  ];

  if (!vector.present) {
    lines.push('NO VECTOR SOURCE — the style has no tiles to draw roads from');
  } else if (vector.tiles === 0) {
    lines.push('SOURCE HAS NO TILES — nothing was ever fetched for this view');
  } else if (features === 0) {
    lines.push('TILES BUT NO FEATURES — fetched and drew nothing');
  }

  for (const error of errors.slice(-ERROR_LIMIT)) lines.push(`! ${error}`);
  return lines;
}

/**
 * What the map's own source cache says about the vector source.
 *
 * Authoritative in a way request counting is not: this is the state MapLibre
 * decides what to draw from, on the main thread, regardless of which thread
 * fetched the bytes.
 */
export interface VectorSourceState {
  present: boolean;
  loaded: boolean;
  tiles: number;
}

/** Read that state, tolerating the internals moving. */
export function vectorSourceState(map: import('maplibre-gl').Map, id: string): VectorSourceState {
  let present = false;
  let loaded = false;
  let tiles = 0;

  try {
    present = Boolean(map.getSource(id));
    loaded = present && map.isSourceLoaded(id) === true;
    const caches = (map as unknown as { style?: { sourceCaches?: Record<string, unknown> } }).style
      ?.sourceCaches;
    const cache = caches?.[id] as { _tiles?: Record<string, unknown> } | undefined;
    tiles = Object.keys(cache?._tiles ?? {}).length;
  } catch {
    // Internals are not API; a readout that throws is worse than one that
    // under-reports.
  }

  return { present, loaded, tiles };
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
        // Everything MapLibre is drawing right now, from the vector source.
        // `queryRenderedFeatures` with no filter answers for the whole map,
        // which is the question being asked.
        let features = 0;
        try {
          features = map.queryRenderedFeatures().length;
        } catch {
          features = 0;
        }

        element.textContent = '';
        for (const line of readoutLines({
          vector: vectorSourceState(map, 'openmaptiles'),
          // `isStyleLoaded` is typed as possibly returning void in this
          // version; the readout wants a definite answer either way.
          styleLoaded: map.isStyleLoaded() === true,
          zoom: map.getZoom(),
          layers,
          features,
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
