/**
 * Tests for marker interpolation.
 *
 * This logic is worth testing carefully because its failure modes are visual
 * and subtle: markers that drift the wrong way, jump on every poll, or stream
 * confidently across the map on data that is ten minutes old. None of those
 * throw an error, and all of them are hard to spot by eye during a demo.
 */

import { describe, expect, it } from 'vitest';

import type { RenderableObject, TrackedObject } from '../types';
import { STALE_AFTER_SECONDS as PLANET_STALE } from '../planet/aircraftLayer';
import {
  EARTH_RADIUS_M,
  EASE_DURATION_MS,
  MAX_EXTRAPOLATION_MS,
  STALE_AFTER_MS,
  STALE_AFTER_SECONDS,
  ageSeconds,
  destinationPoint,
  lerpLongitude,
  positionAt,
  smoothstep,
  toRenderable,
  wrapLongitude,
} from './interpolate';

const NOW = 1_800_000_000_000;

function base(overrides: Partial<TrackedObject> = {}): TrackedObject {
  return {
    id: 'a1',
    lat: 0,
    lon: 0,
    altitude: 10000,
    velocity: 250,
    heading: 90,
    label: 'TEST1',
    lastSeen: new Date(NOW).toISOString(),
    type: 'aircraft',
    ...overrides,
  };
}

function renderable(overrides: Partial<RenderableObject> = {}): RenderableObject {
  return {
    ...base(),
    renderLat: 0,
    renderLon: 0,
    fromLat: 0,
    fromLon: 0,
    updatedAt: NOW,
    lastSeenMs: NOW,
    ...overrides,
  };
}

describe('wrapLongitude', () => {
  it('wraps past the antimeridian', () => {
    expect(wrapLongitude(187.4)).toBeCloseTo(-172.6, 6);
    expect(wrapLongitude(-187.4)).toBeCloseTo(172.6, 6);
  });

  it('leaves in-range values alone', () => {
    expect(wrapLongitude(0)).toBe(0);
    expect(wrapLongitude(-179)).toBeCloseTo(-179, 6);
  });
});

describe('destinationPoint', () => {
  it('is a no-op for zero distance', () => {
    expect(destinationPoint(45, -70, 90, 0)).toEqual({ lat: 45, lon: -70 });
  });

  it('moves north when heading north', () => {
    const { lat } = destinationPoint(0, 0, 0, 111_195);
    expect(lat).toBeCloseTo(1, 2);
  });

  it('moves east when heading east', () => {
    const { lat, lon } = destinationPoint(0, 0, 90, 111_195);
    expect(lon).toBeCloseTo(1, 2);
    expect(lat).toBeCloseTo(0, 6);
  });

  it('produces a valid longitude when crossing the antimeridian', () => {
    // Naively this gives 180.5, which would be off the end of the range.
    const { lon } = destinationPoint(60, 179.5, 90, 200_000);
    expect(lon).toBeGreaterThanOrEqual(-180);
    expect(lon).toBeLessThanOrEqual(180);
    expect(lon).toBeLessThan(0);
  });

  it('does not blow up at the pole', () => {
    const { lat, lon } = destinationPoint(89.9, 0, 0, 50_000);
    expect(Number.isNaN(lat)).toBe(false);
    expect(Number.isNaN(lon)).toBe(false);
    expect(lat).toBeLessThanOrEqual(90);
  });

  it('matches the backend radius so the two implementations agree', () => {
    expect(EARTH_RADIUS_M).toBeCloseTo(6_371_008.8, 1);
  });
});

describe('lerpLongitude', () => {
  it('takes the short way across the antimeridian', () => {
    // The bug this guards: blending 179 to -179 numerically sweeps the marker
    // the long way round the entire planet.
    const mid = lerpLongitude(179, -179, 0.5);
    expect(Math.abs(mid)).toBeGreaterThan(179);
  });

  it('interpolates normally away from the seam', () => {
    expect(lerpLongitude(0, 10, 0.5)).toBeCloseTo(5, 6);
  });

  it('returns the endpoints at t=0 and t=1', () => {
    expect(lerpLongitude(20, 40, 0)).toBeCloseTo(20, 6);
    expect(lerpLongitude(20, 40, 1)).toBeCloseTo(40, 6);
  });
});

describe('smoothstep', () => {
  it('is clamped and monotonic', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.25)).toBeLessThan(smoothstep(0.75));
  });

  it('starts and ends gently', () => {
    // The point of easing: near the endpoints the rate of change is small.
    expect(smoothstep(0.05)).toBeLessThan(0.05);
    expect(smoothstep(0.95)).toBeGreaterThan(0.95);
  });
});

describe('positionAt', () => {
  it('dead-reckons forward along the heading', () => {
    const object = renderable();
    const after = positionAt(object, NOW + 60_000 + EASE_DURATION_MS);
    // 250 m/s east for 61 s is about 15 km.
    expect(after.lon).toBeGreaterThan(0.12);
    expect(after.lat).toBeCloseTo(0, 3);
  });

  it('extrapolates from when the source saw it, not from when we received it', () => {
    // Otherwise every marker lags by the age of the snapshot.
    const stale = renderable({
      lastSeenMs: NOW - 30_000,
      updatedAt: NOW,
      fromLat: 0,
      fromLon: 0,
    });
    const position = positionAt(stale, NOW + EASE_DURATION_MS);
    // ~31 s of travel already accrued, not ~1 s.
    expect(position.lon).toBeGreaterThan(0.06);
  });

  it('does not move objects with unknown velocity', () => {
    const object = renderable({ velocity: null });
    expect(positionAt(object, NOW + 120_000)).toEqual({ lat: 0, lon: 0 });
  });

  it('does not move objects with unknown heading', () => {
    // Unknown is not zero: treating it as zero would send every stationary
    // aircraft due north.
    const object = renderable({ heading: null });
    expect(positionAt(object, NOW + 120_000)).toEqual({ lat: 0, lon: 0 });
  });

  it('does not move stationary objects', () => {
    const object = renderable({ velocity: 0 });
    expect(positionAt(object, NOW + 120_000)).toEqual({ lat: 0, lon: 0 });
  });

  it('stops extrapolating once the data is too old to trust', () => {
    // An aircraft unheard-of for ten minutes may have turned or landed;
    // continuing to fly it confidently across the map invents data.
    const object = renderable({ lastSeenMs: NOW - MAX_EXTRAPOLATION_MS - 1000 });
    const position = positionAt(object, NOW + EASE_DURATION_MS);
    expect(position).toEqual({ lat: 0, lon: 0 });
  });

  it('eases from the previously drawn position rather than snapping', () => {
    const object = renderable({ fromLat: 10, fromLon: 10, updatedAt: NOW });
    const early = positionAt(object, NOW + 1);
    expect(early.lat).toBeCloseTo(10, 1);
    expect(early.lon).toBeCloseTo(10, 1);
  });

  it('completes the ease within the ease duration', () => {
    const object = renderable({ fromLat: 10, fromLon: 10, updatedAt: NOW });
    const done = positionAt(object, NOW + EASE_DURATION_MS);
    expect(done.lat).toBeCloseTo(0, 3);
  });

  it('moves monotonically during the ease', () => {
    const object = renderable({ fromLat: 10, fromLon: 0, updatedAt: NOW });
    const samples = [0.1, 0.3, 0.5, 0.8, 1].map(
      (t) => positionAt(object, NOW + EASE_DURATION_MS * t).lat,
    );
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });
});

describe('toRenderable', () => {
  it('parses lastSeen into epoch milliseconds', () => {
    const result = toRenderable(base(), undefined, NOW);
    expect(result.lastSeenMs).toBe(NOW);
  });

  it('falls back to now when lastSeen is unparseable', () => {
    // A NaN here would propagate into every position calculation and silently
    // remove the marker.
    const result = toRenderable(base({ lastSeen: 'not a date' }), undefined, NOW);
    expect(result.lastSeenMs).toBe(NOW);
  });

  it('starts a new object at its reported position', () => {
    const result = toRenderable(base({ lat: 5, lon: 6 }), undefined, NOW);
    expect(result.fromLat).toBe(5);
    expect(result.fromLon).toBe(6);
  });

  it('starts an update from where the marker was actually drawn', () => {
    // Not from the previous *reported* position: a marker must never visibly
    // jump backwards to correct itself.
    const previous = renderable({ fromLat: 0, fromLon: 0, updatedAt: NOW - 5000 });
    const drawn = positionAt(previous, NOW);
    const updated = toRenderable(base({ lat: 0, lon: 1 }), previous, NOW);
    expect(updated.fromLon).toBeCloseTo(drawn.lon, 6);
  });

  it('resets the ease clock on each update', () => {
    const previous = renderable({ updatedAt: NOW - 5000 });
    expect(toRenderable(base(), previous, NOW).updatedAt).toBe(NOW);
  });
});

describe('ageSeconds', () => {
  it('measures from the source observation time', () => {
    expect(ageSeconds(renderable({ lastSeenMs: NOW - 90_000 }), NOW)).toBeCloseTo(90, 3);
  });

  it('never reports a negative age for a clock skewed into the future', () => {
    expect(ageSeconds(renderable({ lastSeenMs: NOW + 5000 }), NOW)).toBe(0);
  });
});

describe('the marker never outruns what the app admits it knows (D71)', () => {
  // Reported by Phone from a running app: the aircraft and the end of its own
  // track drifted apart as the map zoomed in, "like different brothers" - and
  // at z12 they were kilometres apart. The track is drawn from reported
  // positions; the marker was being dead-reckoned for up to ten minutes while
  // the detail panel said "position shown is the last one we received" from two
  // minutes on. Three parts of one screen, disagreeing (defect #21).

  it('extrapolates exactly as long as it claims the position is current', () => {
    // The coupling that was missing. These are not three numbers that happen to
    // match; the other two are derived from this one, and this test fails if
    // anybody re-introduces a second definition.
    expect(MAX_EXTRAPOLATION_MS).toBe(STALE_AFTER_MS);
    expect(STALE_AFTER_SECONDS).toBe(STALE_AFTER_MS / 1000);
    expect(PLANET_STALE).toBe(STALE_AFTER_SECONDS);
  });

  it('holds the last reported position once the data is called stale', () => {
    // Phone's aircraft, with its own numbers: ANA5686, 37 m/s, heading 180,
    // last reported 2m 18s before the screenshot.
    const object = renderable({
      lat: 28.408,
      lon: 115.329,
      velocity: 37,
      heading: 180,
      lastSeenMs: NOW - 138_000,
      updatedAt: NOW - 138_000,
    });
    const drawn = positionAt(object, NOW);
    expect(drawn.lat).toBe(28.408);
    expect(drawn.lon).toBe(115.329);
  });

  it('was drawing it five kilometres away before the fix', () => {
    // The size of the lie, so the fix is not mistaken for a tidy-up: at 37 m/s,
    // 2m 18s of dead reckoning is 5.1 km, and it grew for another eight minutes.
    const flown = destinationPoint(28.408, 115.329, 180, 37 * 138);
    const metres =
      Math.hypot(flown.lat - 28.408, (flown.lon - 115.329) * Math.cos((28.408 * Math.PI) / 180)) *
      (Math.PI / 180) *
      EARTH_RADIUS_M;
    expect(metres).toBeGreaterThan(5_000);
    // And at the old ten-minute cap, the marker could lead the truth by this
    // much before it stopped.
    expect((37 * 600) / 1000).toBeGreaterThan(22);
  });

  it('still moves while the position is fresh', () => {
    // The failure mode of over-correcting: an aircraft frozen between polls
    // looks broken, and interpolation exists precisely to avoid that (D14).
    const object = renderable({
      velocity: 250,
      heading: 90,
      lastSeenMs: NOW - (STALE_AFTER_MS - 1000),
      updatedAt: NOW - (STALE_AFTER_MS - 1000),
    });
    expect(positionAt(object, NOW).lon).toBeGreaterThan(0);
  });

  it('holds position at the threshold itself, not one tick past it', () => {
    const atThreshold = renderable({
      velocity: 250,
      heading: 90,
      lastSeenMs: NOW - STALE_AFTER_MS,
      updatedAt: NOW - STALE_AFTER_MS,
    });
    expect(positionAt(atThreshold, NOW).lon).toBe(0);
  });
});
