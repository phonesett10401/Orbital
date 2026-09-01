import { describe, expect, it } from 'vitest';

import { ALTITUDE_CEILING_M, UNKNOWN_ALTITUDE_COLOR, altitudeColor } from './altitudeColor';

/**
 * These moved here with the function when `src/globe` was deleted (D104).
 * They were written against the globe's shader and are just as true of the
 * map's symbols — the ramp was never a property of either renderer, which is
 * why it survived the deletion and they had to come with it.
 */
describe('altitudeColor', () => {
  it('runs warm at the bottom and cool at the top', () => {
    // The key hardcodes its gradient for cheapness; this is what keeps the two
    // from drifting apart, at which point the key would be lying.
    expect(altitudeColor(0)).toEqual([1.0, 0.55, 0.2]);
    expect(altitudeColor(ALTITUDE_CEILING_M)).toEqual([0.35, 0.85, 1.0]);
  });

  it('makes unknown altitude visibly distinct from both ends', () => {
    // `null` means unknown and must not read as "on the ground", so it is a
    // neutral grey rather than a point on the ramp.
    const unknown = altitudeColor(null);
    expect(unknown).toEqual(UNKNOWN_ALTITUDE_COLOR);
    expect(unknown).not.toEqual(altitudeColor(0));
    expect(unknown).not.toEqual(altitudeColor(ALTITUDE_CEILING_M));
  });

  it('rises monotonically, so a higher aircraft never reads as lower', () => {
    const blue = (metres: number) => altitudeColor(metres)[2];
    const samples = [0, 2000, 4000, 6000, 9000, 12000].map(blue);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
  });

  it('clamps rather than extrapolating past the ceiling', () => {
    // A satellite at 420 km would otherwise run off the end of the ramp. It
    // does not use this function at all (D99), but the clamp is what stops a
    // stray value producing a colour outside the scale the key describes.
    expect(altitudeColor(50_000)).toEqual(altitudeColor(ALTITUDE_CEILING_M));
    expect(altitudeColor(-500)).toEqual(altitudeColor(0));
  });

  it('stays inside the 0..1 range every consumer assumes', () => {
    // The shader multiplies by these directly and MapLibre converts them to a
    // CSS colour; a channel outside the range is a silent artefact in one and
    // a malformed string in the other.
    for (const metres of [null, 0, 3000, 6000, 12000, 99_000]) {
      for (const channel of altitudeColor(metres as number | null)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});
