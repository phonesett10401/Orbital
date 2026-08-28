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
  /**
   * `describeModel` is asked, once a second, what the 3D model layer is doing.
   * It is passed in rather than read here because this panel deliberately
   * knows nothing about the aircraft layers - and because "the model is not on
   * screen" has three quite different causes (nothing selected, no heading to
   * point it, or over the horizon) that look identical from outside (D67).
   */
  attach(
    map: import('maplibre-gl').Map,
    describeModel?: () => string,
    describeTerminator?: () => string,
  ): void;
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
  probe?: string | null;
  model?: string;
  terminator?: string;
}): string[] {
  const { styleLoaded, zoom, layers, features, vector, counts, errors, probe, model, terminator } =
    state;
  const lines = [
    `style ${styleLoaded ? 'loaded' : 'LOADING'} · z${zoom.toFixed(1)} · ${layers} layers`,
    `imagery: gibs ${counts.gibs} · close ${counts.close}`,
    `vector src ${vector.present ? 'yes' : 'MISSING'} · loaded ${vector.loaded ? 'yes' : 'no'}` +
      ` · cached tiles ${vector.tiles} · features ${features}`,
  ];

  // Diagnosed from `loaded` and `features`, both public API. The cached-tile
  // count is printed but never judged on: it reads MapLibre's internals, and
  // it reported zero while 120 features were being drawn from a source that
  // said it was loaded — a third false zero from this panel, and the reason
  // the rule is now to diagnose only from what the map itself will answer
  // (D65).
  if (!vector.present) {
    lines.push('NO VECTOR SOURCE — the style has no tiles to draw roads from');
  } else if (!vector.template) {
    lines.push('SOURCE HAS NO TILE TEMPLATE — it was never resolved');
  } else if (!vector.loaded && features === 0) {
    lines.push('SOURCE NOT LOADED — nothing was ever fetched for this view');
  } else if (features === 0) {
    lines.push('LOADED BUT NO FEATURES — fetched and drew nothing');
  }

  // The template the map holds, and what happened when this panel fetched a
  // tile from it directly. That separates "the URL is wrong" from "MapLibre
  // cannot fetch it", which is the last ambiguity left.
  if (model) lines.push(`model ${model}`);
  if (terminator) lines.push(`night ${terminator}`);
  if (vector.template) lines.push(`tmpl ${vector.template.replace(/^https?:\/\//, '')}`);
  if (probe) lines.push(`probe ${probe}`);

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
  /** The template the live style holds, if it has one. */
  template: string | null;
  maxzoom: number;
}

/**
 * The tile URL MapLibre would use for a given view, from the live style.
 *
 * Built from the source's own template so it cannot drift from what the map is
 * actually configured with — the point is to test *that* URL, not one written
 * out again here.
 */
export function tileUrlFor(
  template: string,
  lat: number,
  lon: number,
  zoom: number,
  maxzoom: number,
): string {
  // Vector sources overzoom: past their maximum they keep drawing the deepest
  // tiles they have, so the tile to test is the one at that depth.
  const z = Math.min(Math.floor(zoom), maxzoom);
  const scale = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale,
  );
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/** Read that state, tolerating the internals moving. */
export function vectorSourceState(map: import('maplibre-gl').Map, id: string): VectorSourceState {
  let present = false;
  let loaded = false;
  let tiles = 0;
  let template: string | null = null;
  let maxzoom = 14;

  try {
    present = Boolean(map.getSource(id));
    loaded = present && map.isSourceLoaded(id) === true;
    const caches = (map as unknown as { style?: { sourceCaches?: Record<string, unknown> } }).style
      ?.sourceCaches;
    const cache = caches?.[id] as { _tiles?: Record<string, unknown> } | undefined;
    tiles = Object.keys(cache?._tiles ?? {}).length;

    const spec = map.getStyle()?.sources?.[id] as
      | { tiles?: string[]; maxzoom?: number }
      | undefined;
    template = spec?.tiles?.[0] ?? null;
    maxzoom = spec?.maxzoom ?? 14;
  } catch {
    // Internals are not API; a readout that throws is worse than one that
    // under-reports.
  }

  return { present, loaded, tiles, template, maxzoom };
}

export function createDiagnosticsPanel(): DiagnosticsPanel {
  const element = document.createElement('div');
  element.className = 'planet-diagnostics';

  const errors: string[] = [];
  let timer = 0;
  /** Result of fetching one tile from the live template, ourselves. */
  let probe: string | null = null;
  let probed = false;

  return {
    element,

    attach(map, describeModel, describeTerminator) {
      map.on('error', (event) => {
        const error = event as unknown as { error?: { message?: string } };
        errors.push(String(error.error?.message ?? event).slice(0, 120));
      });

      /**
       * Fetch one tile from the template the map is actually configured with.
       *
       * The last ambiguity: a source that never fetches could have a wrong URL
       * or be unable to fetch a right one. This asks the main thread — which
       * is known to reach these hosts — to try the exact URL MapLibre holds.
       * Once only; it is a diagnosis, not a monitor.
       */
      const probeTile = (state: VectorSourceState) => {
        if (probed || !state.template) return;
        probed = true;
        const url = tileUrlFor(
          state.template,
          map.getCenter().lat,
          map.getCenter().lng,
          map.getZoom(),
          state.maxzoom,
        );
        void fetch(url)
          .then(async (response) => {
            const bytes = (await response.arrayBuffer()).byteLength;
            probe = `${response.status} ${bytes}B from main thread`;
          })
          .catch((error) => {
            probe = `FETCH FAILED: ${String(error).slice(0, 80)}`;
          });
      };

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

        const vector = vectorSourceState(map, 'openmaptiles');
        probeTile(vector);

        element.textContent = '';
        for (const line of readoutLines({
          vector,
          probe,
          // `isStyleLoaded` is typed as possibly returning void in this
          // version; the readout wants a definite answer either way.
          styleLoaded: map.isStyleLoaded() === true,
          zoom: map.getZoom(),
          layers,
          features,
          counts: requestCounts(names),
          errors,
          model: describeModel?.(),
          terminator: describeTerminator?.(),
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
