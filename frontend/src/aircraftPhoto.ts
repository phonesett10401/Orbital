/**
 * A photograph of the actual airframe, from Planespotters.
 *
 * Orbital's aircraft `id` **is** the ICAO24 hex, which is what this API is
 * keyed on, so there is nothing to look up first. Measured against 60 real
 * aircraft over southern England: **81% have a photograph** of that specific
 * airframe. That is high enough to design the panel around the picture rather
 * than treat it as a bonus - and it makes the other 19% a state worth drawing
 * on purpose (D116).
 *
 * ## The browser calls this directly, and that is not a shortcut
 *
 * D7 says the browser talks to our backend and nothing else. This is a
 * deliberate exception, and unlike the OpenFreeMap tiles it is a permanent
 * one, because the terms of use forbid the alternative in as many words:
 *
 * > Re-exposing the API or its data through your own API, feed, bulk export,
 * > or dataset is prohibited.
 *
 * > All URLs returned by the API - image sources, photo links, and any other
 * > URL fields - must be used unchanged. Proxying, rewriting, or hot-link-
 * > protection bypassing is not permitted.
 *
 * So there is no `/api/aircraft/{id}/photo`, no caching layer in the backend
 * and no image proxy. The browser is the intended client: the API is
 * CORS-enabled and browsers send the `Origin` header it checks for
 * automatically. A server would have to send a descriptive `User-Agent`
 * instead; a browser cannot set one and does not need to.
 *
 * ## What the terms require of the UI, which is why they are here and not
 * only in the component
 *
 * - The photographer is **credited in visible text** beside the image.
 * - The thumbnail is wrapped in a **plain anchor** to the `link` this API
 *   returns, with no `rel="nofollow"`, so a reader can reach the full photo
 *   and its author in one click.
 * - Image URLs are used **unchanged** and never stored, re-hosted or passed on.
 * - Photos may not sit behind a paid, premium or member-only gate.
 * - Nothing here may be used to train or evaluate a machine-learning model.
 *
 * `CACHE_TTL_MS` is 24 hours because that is the longest the terms allow a
 * JSON response to be cached. The cache holds *metadata* only - the image
 * binaries are fetched by the browser from the returned URLs, as required.
 */

/** One photograph, reduced to what the panel needs and the terms require. */
export interface AircraftPhoto {
  /** Image URL, used exactly as returned. */
  src: string;
  width: number;
  height: number;
  /** Page for this photo. The thumbnail must link here. */
  link: string;
  /** Must be shown as text next to the image. */
  photographer: string;
}

/**
 * The four answers, because "no photograph" is not a failure.
 *
 * `absent` is the ordinary case for one aircraft in five and has to be drawn
 * as an answer rather than as a gap. The satellites taught this the expensive
 * way: a missing classification reported as "Unidentified object" turned a
 * fact about our data into a claim about the world (D102).
 */
export type PhotoState =
  | { status: 'loading' }
  | { status: 'ready'; photo: AircraftPhoto }
  | { status: 'absent' }
  | { status: 'error' };

export const PHOTO_API = 'https://api.planespotters.net/pub/photos/hex';

/** The longest the terms permit a JSON response to be cached. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function photoUrlFor(icao24: string): string {
  return `${PHOTO_API}/${encodeURIComponent(icao24.toLowerCase())}`;
}

/**
 * Read the API's response into our own shape, or `null` for "no photograph".
 *
 * Separate from the fetch so it can be tested against recorded payloads. It
 * prefers `thumbnail_large` (about 497x280) over `thumbnail` (200x112),
 * because the panel is wider than 200px and the small one is visibly soft
 * there - but it takes whichever exists rather than assuming both do.
 */
export function parsePhotos(payload: unknown): AircraftPhoto | null {
  const photos = (payload as { photos?: unknown })?.photos;
  if (!Array.isArray(photos) || photos.length === 0) return null;

  const first = photos[0] as Record<string, never> | undefined;
  if (!first) return null;

  const image = (first.thumbnail_large ?? first.thumbnail) as
    | { src?: string; size?: { width?: number; height?: number } }
    | undefined;
  const src = image?.src;
  const link = first.link as string | undefined;
  const photographer = first.photographer as string | undefined;

  // Every one of these is required to render the photo *lawfully*, not merely
  // to render it well: without a link back or a photographer there is no way
  // to satisfy the attribution terms, so a partial record is treated as no
  // record at all rather than shown bare.
  if (!src || !link || !photographer) return null;

  return {
    src,
    width: image?.size?.width ?? 0,
    height: image?.size?.height ?? 0,
    link,
    photographer,
  };
}

/**
 * Whether a failed request is worth trying once more.
 *
 * Measured: one request in sixty came back **HTTP 525**, a Cloudflare origin
 * hiccup, and the same hex returned a photograph a second later. A 4xx means
 * the answer is no and asking again is just noise.
 */
export function isRetryable(status: number): boolean {
  return status >= 500;
}

interface CacheEntry {
  photo: AircraftPhoto | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Exposed for tests; also the honest way to prove the TTL is enforced. */
export function clearPhotoCache(): void {
  cache.clear();
}

export function cachedPhoto(icao24: string, now: number): CacheEntry | undefined {
  const entry = cache.get(icao24.toLowerCase());
  if (!entry) return undefined;
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(icao24.toLowerCase());
    return undefined;
  }
  return entry;
}

/**
 * Fetch one aircraft's photograph, with a single retry on a server error.
 *
 * Returns `null` for "this airframe has no photograph", which is a real
 * answer, and throws only when the request itself failed - the caller draws
 * those two differently.
 */
export async function fetchAircraftPhoto(
  icao24: string,
  options: { signal?: AbortSignal; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<AircraftPhoto | null> {
  const key = icao24.toLowerCase();
  const now = options.now ?? Date.now();
  const hit = cachedPhoto(key, now);
  if (hit) return hit.photo;

  const doFetch = options.fetchImpl ?? fetch;
  let lastStatus = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await doFetch(photoUrlFor(key), { signal: options.signal });
    if (response.ok) {
      const photo = parsePhotos(await response.json());
      cache.set(key, { photo, at: now });
      return photo;
    }
    lastStatus = response.status;
    if (!isRetryable(response.status)) break;
  }

  throw new Error(`photo lookup failed: HTTP ${lastStatus}`);
}
