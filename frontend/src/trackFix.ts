/**
 * When an aircraft's own track knows more than its marker does (D138).
 *
 * ## The two clocks
 *
 * A marker's position comes from Orbital's object feed, which is polled on a
 * budget: the global sweep is minutes apart because that is what the OpenSky
 * credit arithmetic allows (D21). A selected aircraft's **track** comes from
 * somewhere else entirely - the provider's own flight history, fetched when the
 * panel opens (D77) - and that source is not on our budget. It is routinely
 * *fresher* than the feed.
 *
 * Most of the time nobody notices, because the marker dead-reckons forward from
 * its last report and lands roughly where the track ends. Then the report ages
 * past `MAX_EXTRAPOLATION_MS` and dead reckoning stops, correctly: two minutes
 * without a report is not something to keep flying a marker through (D71).
 *
 * **And now the aircraft is parked while its own track keeps going.** Measured
 * in the running app: the feed's last report was 128 seconds old and frozen,
 * the newest point on the same aircraft's track was 51 seconds old - 77 seconds
 * and about twenty kilometres further west. The line ran out in front of the
 * aeroplane drawing it.
 *
 * ## Why the answer is to move the marker, not to trim the line
 *
 * Trimming the track back to the marker's age would make the picture agree, and
 * it would do so by **throwing away real observations** - the newest points on
 * that line are reports of where the aircraft actually was. The feed being
 * behind is not a reason to pretend the better data does not exist.
 *
 * So the freshest observation wins. A track point newer than the last report
 * *is* a newer report; the marker moves to it and dead-reckons from there, and
 * the aircraft is back at the head of its own line where it belongs.
 */

import type { RenderableObject, TrackPoint } from './types';

/** One observation of where something was, and when. */
export interface Fix {
  lat: number;
  lon: number;
  lastSeenMs: number;
}

/**
 * Ignore a track that is newer by less than this.
 *
 * The two sources round timestamps differently and a sub-second difference is
 * not new information. Without a floor the marker would be nudged on every
 * detail refresh, which is motion the aircraft did not make.
 */
export const MIN_IMPROVEMENT_MS = 1_000;

/**
 * The newest point on a track, or null if there is not a usable one.
 *
 * A track is ordered oldest to newest by contract, but the last element is
 * still checked against the rest rather than trusted: a provider that returns
 * a track in the other order would otherwise move every marker to where the
 * aircraft *departed from*, which is a spectacular failure that looks like a
 * data problem rather than an ordering assumption.
 */
export function newestPoint(track: readonly TrackPoint[] | undefined): TrackPoint | null {
  if (!track || track.length === 0) return null;
  let newest: TrackPoint | null = null;
  let newestMs = -Infinity;
  for (const point of track) {
    const at = Date.parse(point.timestamp);
    if (Number.isNaN(at)) continue;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    if (at > newestMs) {
      newestMs = at;
      newest = point;
    }
  }
  return newest;
}

/**
 * A better fix than the object already has, or null when there is none.
 *
 * Null is the common answer and the important one: when the feed is keeping up,
 * this must change nothing at all.
 */
export function betterFix(
  object: Pick<RenderableObject, 'lat' | 'lon' | 'lastSeenMs'>,
  track: readonly TrackPoint[] | undefined,
  nowMs: number,
): Fix | null {
  const newest = newestPoint(track);
  if (!newest) return null;
  const at = Date.parse(newest.timestamp);
  if (Number.isNaN(at)) return null;
  if (at - object.lastSeenMs < MIN_IMPROVEMENT_MS) return null;
  // Not newer than now, either. A clock skewed into the future would send the
  // marker somewhere it has not been and freeze it there, because everything
  // downstream measures staleness from this timestamp. `nowMs` is passed in
  // rather than read from the clock, so the rule is a function of its inputs
  // and a test can put "now" wherever it needs it.
  if (at > nowMs + MIN_IMPROVEMENT_MS) return null;
  return { lat: newest.lat, lon: newest.lon, lastSeenMs: at };
}

/**
 * The object as it should now be drawn, given what its track knows.
 *
 * Returns the same object when there is nothing better, so a caller can use
 * identity to decide whether anything changed and skip a re-render.
 *
 * `fromLat`/`fromLon` are left alone deliberately. They are where the marker is
 * currently *drawn*, and easing runs from there to the new truth - so adopting
 * a fix twenty kilometres ahead is a glide rather than a jump, which is the
 * same treatment a normal poll gets (D71).
 */
export function withBestFix(
  object: RenderableObject,
  track: readonly TrackPoint[] | undefined,
  nowMs: number,
): RenderableObject {
  const fix = betterFix(object, track, nowMs);
  if (!fix) return object;
  return {
    ...object,
    lat: fix.lat,
    lon: fix.lon,
    lastSeenMs: fix.lastSeenMs,
    lastSeen: new Date(fix.lastSeenMs).toISOString(),
    // The ease starts now, from wherever the marker is drawn.
    updatedAt: nowMs,
  };
}
