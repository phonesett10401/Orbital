import { describe, expect, it } from 'vitest';

import { SOLAR_FULL_ZOOM, SOLAR_MAX_ZOOM } from './planet/solarSystemLayer';
import {
  PLANET_HOME,
  SYSTEM_HOME,
  isSettled,
  settleMs,
  settleTarget,
} from './viewSettle';

describe('the two places the camera may rest', () => {
  it('leaves the solar system view alone', () => {
    expect(settleTarget(SYSTEM_HOME, 0)).toBeNull();
    expect(settleTarget(-1.8, -1)).toBeNull();
    // The apex of a trip between worlds, which is further out still.
    expect(settleTarget(-2, 1.5)).toBeNull();
  });

  it('leaves the planet view alone', () => {
    expect(settleTarget(PLANET_HOME, -1)).toBeNull();
    expect(settleTarget(2, 3)).toBeNull();
    expect(settleTarget(12, 11)).toBeNull();
  });

  it('rests the system view where the planets are solid, not translucent', () => {
    // Imported rather than restated: a copy that drifted would settle the
    // camera at a zoom where the system is still fading, which is half of the
    // fault this fixes.
    expect(SYSTEM_HOME).toBe(SOLAR_FULL_ZOOM);
  });

  it('rests the planet view above the handover, not on it', () => {
    // At the handover the globe measured 80px on a 1990px screen. Resting
    // there would be resting on the thing being fixed.
    expect(PLANET_HOME).toBeGreaterThan(SOLAR_MAX_ZOOM);
  });
});

describe('coming to rest inside the band', () => {
  it('finishes the journey outward, wherever in the band it stopped', () => {
    // -0.9 is the zoom in the report: the globe 85 pixels wide on a wide
    // screen, with the solar system already switched off. Reached by zooming
    // out, so the view completes the move out.
    expect(settleTarget(-0.9, -0.5)).toBe(SYSTEM_HOME);
    expect(settleTarget(-1.4, -1.2)).toBe(SYSTEM_HOME);
  });

  it('finishes the journey inward, wherever in the band it stopped', () => {
    // **The case the nearer edge got wrong.** From the solar system, one notch
    // in reaches about -1.4, which is nearer the system - so a nearest-edge
    // rule pushes straight back out and the view feels like it refuses to be
    // zoomed.
    expect(settleTarget(-1.4, SYSTEM_HOME)).toBe(PLANET_HOME);
    expect(settleTarget(-0.2, -0.6)).toBe(PLANET_HOME);
  });

  it('sends the whole band somewhere, in both directions', () => {
    // Nothing between the two homes is a resting place, which is the rule.
    for (let z = SYSTEM_HOME + 0.01; z < PLANET_HOME; z += 0.05) {
      expect(settleTarget(z, z + 0.1), `out from ${z.toFixed(2)}`).toBe(SYSTEM_HOME);
      expect(settleTarget(z, z - 0.1), `in from ${z.toFixed(2)}`).toBe(PLANET_HOME);
    }
  });

  it('never sends the camera anywhere that needs settling again', () => {
    // **Why it cannot oscillate.** Both targets are outside the band, so the
    // geometry provides the hysteresis and there is no second constant to keep
    // in step - the sort of number D144 removed.
    for (let z = SYSTEM_HOME + 0.01; z < PLANET_HOME; z += 0.05) {
      for (const from of [z - 0.1, z + 0.1]) {
        const target = settleTarget(z, from)!;
        expect(settleTarget(target, z), `from ${z.toFixed(2)}`).toBeNull();
        expect(isSettled(target)).toBe(true);
      }
    }
  });

  it('falls back to the nearer edge when no zoom happened at all', () => {
    // A pan that ended in the band has no direction to follow.
    const middle = (SYSTEM_HOME + PLANET_HOME) / 2;
    expect(settleTarget(middle - 0.01, middle - 0.01)).toBe(SYSTEM_HOME);
    expect(settleTarget(middle + 0.01, middle + 0.01)).toBe(PLANET_HOME);
  });
});

describe('how long it takes', () => {
  it('reads as the view finishing a movement', () => {
    expect(settleMs(false)).toBeGreaterThan(200);
    expect(settleMs(false)).toBeLessThan(700);
  });

  it('is instant for a reader who asked for less movement', () => {
    // The destination is the point; the travel is decoration.
    expect(settleMs(true)).toBe(0);
  });
});
