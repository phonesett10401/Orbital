/**
 * What to say when the map does not appear.
 *
 * Until now the planet view had no failure handling of any kind: no `catch`,
 * no message, no retry. Every way of failing produced the same thing — a black
 * rectangle where the world should be — and the only way to find out which one
 * had happened was to open a console and interrogate the page. A session did
 * exactly that on 2026-08-28 and spent twenty minutes on it (§19.19).
 *
 * That is a bad failure mode here specifically, because **this view depends on
 * three third-party hosts** it does not control (D54, D58, D60), and it will be
 * demonstrated on a network nobody controls either. "It is broken" and "the
 * conference wifi is blocking tiles.openfreemap.org" deserve different
 * sentences on the screen.
 *
 * The classification is deliberately coarse. Four outcomes, each with a
 * different thing for the reader to *do*: fix the network, fix the layout, use
 * a different browser, or tell us. Splitting further would produce messages
 * that differ without changing anyone's next move.
 */

/** How long to wait for the map to finish loading before saying something. */
export const STALL_AFTER_MS = 20_000;

export type PlanetFailureKind = 'basemap' | 'container' | 'webgl' | 'unknown';

export interface PlanetFailure {
  kind: PlanetFailureKind;
  /** One line, in plain words, describing what did not happen. */
  title: string;
  /** What to do about it, or what we know that the title does not say. */
  detail: string;
  /** The technical text, kept for the console and for a bug report. */
  cause: string;
}

/**
 * Turn whatever was thrown into something worth reading.
 *
 * Matching on message text is fragile in general and appropriate here: these
 * are our own thrown errors (`whenRenderable`, `loadPlanetStyle`) plus
 * MapLibre's construction failure, and the fallback is a perfectly usable
 * message rather than a wrong one. A misclassification costs a slightly less
 * specific sentence, not a wrong diagnosis.
 */
export function classifyFailure(error: unknown): PlanetFailure {
  const cause = messageOf(error);

  // `whenRenderable` rejects with `unrenderableMessage`, which names the CSS
  // collision that caused this twice before (D55, D62).
  if (cause.includes('the map container measures')) {
    return {
      kind: 'container',
      title: 'The map had nowhere to draw',
      detail:
        'The area holding the map measured zero. This is a layout problem in the ' +
        'page rather than a problem with the map data, and reloading usually clears it.',
      cause,
    };
  }

  if (/webgl|graphics|gpu/i.test(cause)) {
    return {
      kind: 'webgl',
      title: 'This browser cannot draw the map',
      detail:
        'The map needs WebGL 2, which this browser either does not support or has ' +
        'switched off. A current Chrome, Edge, Firefox or Safari will run it.',
      cause,
    };
  }

  // Anything thrown while fetching or resolving the style. `loadPlanetStyle`
  // throws `${url}: HTTP ${status}`, and fetch itself throws on a dead network.
  if (/HTTP \d{3}|fetch|network|Failed to fetch|NetworkError/i.test(cause)) {
    return {
      kind: 'basemap',
      title: 'The basemap could not be loaded',
      detail:
        'The map style and its tiles come from outside this application, and the ' +
        'request did not get through. A blocked or offline network is the usual ' +
        'reason; the aircraft data is unaffected.',
      cause,
    };
  }

  return {
    kind: 'unknown',
    title: 'The map did not start',
    detail:
      'Something failed while setting the map up. The technical detail below is ' +
      'what was thrown, and reloading is worth trying first.',
    cause,
  };
}

/**
 * What to say when the map was built, did not fail, and has not finished.
 *
 * Its own state rather than a failure, because the map may still arrive: a
 * slow network gets there eventually and this must not replace a map that is
 * about to appear.
 *
 * **The background-tab sentence is in here because it cost a session.** A
 * hidden tab gets no `requestAnimationFrame`, MapLibre's loop never runs, and
 * *no* style ever finishes loading — not even one with a single background
 * layer and no network at all. From the outside that is indistinguishable from
 * a network stall, and it is worth one sentence on screen (§19.19).
 */
export const STALL_TITLE = 'The map is taking longer than usual';

export const STALL_DETAIL =
  'It may still arrive on a slow connection. If this browser tab has been in ' +
  'the background, the map stops loading entirely until the tab is visible ' +
  'again, so bringing the window to the front and reloading is the first thing ' +
  'to try.';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
