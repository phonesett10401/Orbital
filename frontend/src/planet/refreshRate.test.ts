import { describe, expect, it } from 'vitest';

import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  metresPerPixel,
  rebuildIntervalMs,
} from './refreshRate';

describe('how big a pixel is', () => {
  it('is about 611 m at the equator at zoom 8', () => {
    // 156543.03 / 2^8. The anchor the whole rule rests on, so it is checked
    // against the number rather than against itself.
    expect(metresPerPixel(8, 0)).toBeCloseTo(611.5, 0);
  });

  it('shrinks by half for every zoom level', () => {
    expect(metresPerPixel(9, 0)).toBeCloseTo(metresPerPixel(8, 0) / 2, 3);
  });

  it('shrinks towards the poles, because the projection stretches', () => {
    // A pixel at 60N covers half the ground a pixel at the equator does, and
    // ignoring that would rebuild twice as often as needed in the Baltic -
    // which is where most of the ships are.
    expect(metresPerPixel(8, 60)).toBeCloseTo(metresPerPixel(8, 0) / 2, 0);
  });

  it('does not blow up at the pole', () => {
    // cos(90°) is zero, and a zero metres-per-pixel divides into an interval
    // of zero - a rebuild every frame, for ever, at the one place nobody is
    // looking.
    expect(metresPerPixel(8, 90)).toBeGreaterThan(0);
    expect(Number.isFinite(metresPerPixel(8, 90))).toBe(true);
  });
});

describe('how often a layer is worth rebuilding', () => {
  it('rebuilds every frame when zoomed right in', () => {
    // At zoom 16 a pixel is a few metres, so an aircraft crosses one in
    // milliseconds and there is nothing to save.
    expect(rebuildIntervalMs('aircraft', 16, 0)).toBe(MIN_INTERVAL_MS);
  });

  it('slows right down when zoomed out', () => {
    // The case that was costing 43 ms at the tail: 2,000 vessels at zoom 7,
    // where a pixel is 750 m and a ship crosses one every two minutes.
    expect(rebuildIntervalMs('ship', 7, 52)).toBe(MAX_INTERVAL_MS);
  });

  it('asks more of a fast layer than a slow one at the same view', () => {
    // The whole reason the speed table exists: an airliner covers ground about
    // nine times faster than a fast ferry, so it earns a redraw sooner.
    const zoom = 11;
    expect(rebuildIntervalMs('aircraft', zoom, 40)).toBeLessThan(
      rebuildIntervalMs('ship', zoom, 40),
    );
  });

  it('never asks for more than the display can show', () => {
    for (const zoom of [14, 16, 18, 22]) {
      expect(rebuildIntervalMs('aircraft', zoom, 0), `zoom ${zoom}`).toBeGreaterThanOrEqual(
        MIN_INTERVAL_MS,
      );
    }
  });

  it('never waits longer than a second, however slow the layer', () => {
    // The half-pixel rule would allow a ship four minutes at zoom 2, which is
    // arithmetically right and wrong in practice.
    for (const zoom of [0, 1, 2, 4]) {
      expect(rebuildIntervalMs('ship', zoom, 0), `zoom ${zoom}`).toBeLessThanOrEqual(
        MAX_INTERVAL_MS,
      );
    }
  });

  it('gets shorter as the view zooms in, at every step', () => {
    // Monotonic, so there is no zoom where pulling back asks for *more* work.
    let previous = Infinity;
    for (let zoom = 2; zoom <= 18; zoom += 1) {
      const interval = rebuildIntervalMs('aircraft', zoom, 30);
      expect(interval, `zoom ${zoom}`).toBeLessThanOrEqual(previous);
      previous = interval;
    }
  });

  it('survives a layer it has no speed for', () => {
    // The table is keyed by ObjectType, so a fourth layer added without an
    // entry would otherwise divide by undefined and return NaN - which
    // compares false against every interval and rebuilds on every frame for
    // ever.
    const interval = rebuildIntervalMs('quasar' as never, 8, 0);
    expect(Number.isFinite(interval)).toBe(true);
    expect(interval).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });

  it('keeps half a pixel of movement as the actual rule', () => {
    // Pinned against the arithmetic rather than against a remembered number,
    // so the constant and the docstring cannot drift apart. At zoom 11 and
    // 40N a pixel is ~58 m; an aircraft at 350 m/s crosses half of it in
    // ~83 ms.
    const pixel = metresPerPixel(11, 40);
    expect(rebuildIntervalMs('aircraft', 11, 40)).toBeCloseTo((pixel / 2 / 350) * 1000, 1);
  });
});
