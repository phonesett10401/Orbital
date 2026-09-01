/**
 * The last few things someone searched for, kept between visits.
 *
 * **Why this is a module and not a few lines in the component.** Everything
 * here is a decision - what counts as the same entry, what order they come
 * back in, how many are kept, what happens when storage is unavailable - and
 * decisions are what this project tests. There is no component-render harness,
 * so the judgement is extracted and tested as data (D77).
 *
 * Stored per browser, never sent anywhere. A search history is a record of
 * what someone was curious about, which is not ours to collect.
 */

import type { Airport, TrackedObject } from '../types';

/** How many are kept. Enough to be useful, few enough to scan at a glance. */
export const RECENT_LIMIT = 6;

const STORAGE_KEY = 'orbital.recentSearches';

/**
 * One remembered search.
 *
 * Position is stored because that is what makes it useful: choosing a recent
 * entry flies the camera there. An aircraft's stored position will be stale by
 * the time it is reused, which is why an aircraft entry is re-selected by id
 * and only falls back to the remembered position.
 */
export interface RecentSearch {
  kind: 'aircraft' | 'airport' | 'satellite';
  /** ICAO24 address for an aircraft, ICAO code for an airport. */
  id: string;
  label: string;
  sublabel: string;
  lat: number;
  lon: number;
}

export function satelliteEntry(object: TrackedObject): RecentSearch {
  return {
    kind: 'satellite',
    id: object.id,
    label: object.label,
    sublabel: `NORAD ${object.id}`,
    lat: object.lat,
    lon: object.lon,
  };
}

/**
 * The remembered entries that belong to one layer.
 *
 * Aircraft and airports are aircraft-layer furniture; satellites are not.
 * Showing yesterday's airport searches under a satellite search box offers
 * answers the box cannot give - choosing one would switch the user out of the
 * layer they are in (D103).
 */
export function recentForLayer(
  entries: readonly RecentSearch[],
  layer: 'aircraft' | 'satellite',
): RecentSearch[] {
  return entries.filter((entry) =>
    layer === 'satellite' ? entry.kind === 'satellite' : entry.kind !== 'satellite',
  );
}

export function aircraftEntry(object: TrackedObject): RecentSearch {
  return {
    kind: 'aircraft',
    id: object.id,
    label: object.label || object.id.toUpperCase(),
    sublabel: 'aircraft',
    lat: object.lat,
    lon: object.lon,
  };
}

export function airportEntry(airport: Airport): RecentSearch {
  return {
    kind: 'airport',
    id: airport.icao,
    label: airport.iata ?? airport.icao,
    sublabel: airport.municipality ?? airport.name,
    lat: airport.lat,
    lon: airport.lon,
  };
}

/**
 * `entry` first, then the rest, with any earlier copy of it removed.
 *
 * Searching for the same flight twice should not fill the list with it, and
 * the second search should move it to the top rather than leave it where it
 * was - the list is "what you were just looking at", not "what you looked at
 * first".
 */
export function remember(
  existing: readonly RecentSearch[],
  entry: RecentSearch,
  limit: number = RECENT_LIMIT,
): RecentSearch[] {
  const others = existing.filter(
    (candidate) => !(candidate.kind === entry.kind && candidate.id === entry.id),
  );
  return [entry, ...others].slice(0, limit);
}

/**
 * What is in storage, or nothing.
 *
 * Every failure is the same answer: an empty list. Storage can be absent
 * (private mode), full, disabled, or hold something another version of this
 * code wrote. None of those is worth a broken search box, and a recent-search
 * list is the definition of data you can afford to lose.
 */
export function loadRecent(storage: Storage | undefined = safeStorage()): RecentSearch[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveRecent(
  entries: readonly RecentSearch[],
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, RECENT_LIMIT)));
  } catch {
    // A full or disabled storage is not an error worth surfacing.
  }
}

/**
 * Reject anything that is not a complete entry.
 *
 * Storage is shared with every other version of this app the browser has ever
 * loaded, so what comes back is untrusted input, not our own data structure.
 */
function isRecent(value: unknown): value is RecentSearch {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === 'aircraft' ||
      candidate.kind === 'airport' ||
      candidate.kind === 'satellite') &&
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.sublabel === 'string' &&
    typeof candidate.lat === 'number' &&
    typeof candidate.lon === 'number'
  );
}

/** `localStorage`, or undefined where touching it throws. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
