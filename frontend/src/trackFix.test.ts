import { describe, expect, it } from 'vitest';

import { MIN_IMPROVEMENT_MS, betterFix, newestPoint, withBestFix } from './trackFix';
import type { RenderableObject, TrackPoint } from './types';

const NOW = Date.parse('2026-09-05T14:00:00Z');

function point(secondsAgo: number, lat: number, lon: number): TrackPoint {
  return {
    lat,
    lon,
    altitude: 11_000,
    timestamp: new Date(NOW - secondsAgo * 1000).toISOString(),
  };
}

function aircraft(secondsAgo: number, lat = 22, lon = 84.82): RenderableObject {
  const lastSeenMs = NOW - secondsAgo * 1000;
  return {
    id: '888188',
    lat,
    lon,
    altitude: 11_887,
    velocity: 268,
    heading: 284,
    label: 'HVN973',
    model: null,
    lastSeen: new Date(lastSeenMs).toISOString(),
    type: 'aircraft',
    renderLat: lat,
    renderLon: lon,
    fromLat: lat,
    fromLon: lon,
    updatedAt: NOW - 500,
    lastSeenMs,
  } as RenderableObject;
}

describe('finding the newest point', () => {
  it('takes the last point of an ordered track', () => {
    const track = [point(180, 21.9, 85.2), point(120, 21.94, 85.0), point(51, 21.96, 84.62)];
    expect(newestPoint(track)?.lon).toBe(84.62);
  });

  it('does not trust the ordering', () => {
    // A provider returning a track reversed would otherwise move every marker
    // back to where the aircraft departed from - a spectacular failure that
    // looks like bad data rather than an assumption.
    const track = [point(51, 21.96, 84.62), point(180, 21.9, 85.2)];
    expect(newestPoint(track)?.lon).toBe(84.62);
  });

  it('skips points it cannot read rather than failing the whole track', () => {
    const track = [
      { lat: 1, lon: 2, altitude: null, timestamp: 'not a date' },
      point(51, 21.96, 84.62),
      { lat: Number.NaN, lon: 3, altitude: null, timestamp: new Date(NOW).toISOString() },
    ];
    expect(newestPoint(track)?.lon).toBe(84.62);
  });

  it('has nothing to say about an empty or missing track', () => {
    expect(newestPoint([])).toBeNull();
    expect(newestPoint(undefined)).toBeNull();
  });
});

describe('whether the track knows better', () => {
  it('offers the fix that reproduces the measured bug', () => {
    // The case from the running app: the feed 128 seconds old and frozen, the
    // track 51 seconds old and twenty kilometres further on.
    const fix = betterFix(aircraft(128), [point(128, 22, 84.82), point(51, 21.9619, 84.6228)], NOW);
    expect(fix).not.toBeNull();
    expect(fix!.lon).toBe(84.6228);
    expect(NOW - fix!.lastSeenMs).toBe(51_000);
  });

  it('says nothing when the feed is keeping up', () => {
    // The common case, and the important one: when both agree this must change
    // nothing at all, or every marker acquires a wobble.
    expect(betterFix(aircraft(10), [point(30, 22, 84.9), point(12, 22, 84.85)], NOW)).toBeNull();
  });

  it('ignores an improvement too small to be new information', () => {
    // The two sources round timestamps differently. Without a floor the marker
    // is nudged on every refresh - motion the aircraft did not make.
    expect(betterFix(aircraft(60), [point(60 - MIN_IMPROVEMENT_MS / 2000, 22, 84.8)], NOW)).toBeNull();
  });

  it('refuses a track point from the future', () => {
    // A skewed clock would move the marker somewhere it has not been and then
    // freeze it there, because staleness is measured from this timestamp.
    expect(betterFix(aircraft(60), [point(-3600, 22, 80)], NOW)).toBeNull();
  });

  it('has nothing to offer without a track', () => {
    expect(betterFix(aircraft(300), undefined, NOW)).toBeNull();
    expect(betterFix(aircraft(300), [], NOW)).toBeNull();
  });
});

describe('adopting the better fix', () => {
  it('moves the aircraft to the head of its own line', () => {
    const before = aircraft(128);
    const after = withBestFix(before, [point(51, 21.9619, 84.6228)], NOW);
    expect(after.lon).toBe(84.6228);
    expect(after.lastSeenMs).toBe(NOW - 51_000);
    // And the age the rest of the app reports comes down with it, which is
    // what lets dead reckoning start again.
    expect(Date.parse(after.lastSeen)).toBe(NOW - 51_000);
  });

  it('glides rather than jumping', () => {
    // `fromLat`/`fromLon` are where the marker is drawn now. Easing runs from
    // there, so adopting a fix twenty kilometres ahead is a glide - the same
    // treatment an ordinary poll gets (D71).
    const before = aircraft(128);
    const after = withBestFix(before, [point(51, 21.9619, 84.6228)], NOW);
    expect(after.fromLat).toBe(before.fromLat);
    expect(after.fromLon).toBe(before.fromLon);
    expect(after.updatedAt).toBe(NOW);
  });

  it('returns the very same object when there is nothing better', () => {
    // Identity, so a caller can skip a re-render. A fresh copy every time would
    // bump the store version on every detail poll and redraw the world.
    const before = aircraft(10);
    expect(withBestFix(before, [point(30, 22, 84.9)], NOW)).toBe(before);
    expect(withBestFix(before, undefined, NOW)).toBe(before);
  });

  it('leaves everything else about the aircraft alone', () => {
    const before = aircraft(128);
    const after = withBestFix(before, [point(51, 21.9619, 84.6228)], NOW);
    expect(after.id).toBe(before.id);
    expect(after.velocity).toBe(before.velocity);
    expect(after.heading).toBe(before.heading);
    expect(after.altitude).toBe(before.altitude);
  });

  it('is idempotent, so a repeated detail poll does not creep', () => {
    // The same track arriving again must be a no-op, or the marker walks
    // forward once per refresh for as long as the panel is open.
    const track = [point(51, 21.9619, 84.6228)];
    const once = withBestFix(aircraft(128), track, NOW);
    expect(withBestFix(once, track, NOW + 5_000)).toBe(once);
  });
});
