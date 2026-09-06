import { describe, expect, it } from 'vitest';

import { SOLAR_MAX_ZOOM } from './planet/solarSystemLayer';
import { APPROACH_TEXT, approach, showsApproach } from './solarApproach';
import { PLANET_HOME } from './viewSettle';

describe('the approach cue', () => {
  it('says nothing while the planet view is the whole picture', () => {
    expect(approach(PLANET_HOME)).toBe(0);
    expect(approach(2)).toBe(0);
    expect(showsApproach(3)).toBe(false);
  });

  it('says nothing once the solar system is actually drawing', () => {
    // A caption over a solar system announcing a solar system is worse than no
    // caption: the cue has been overtaken by the thing it announced.
    expect(approach(SOLAR_MAX_ZOOM)).toBe(0);
    expect(approach(-1.5)).toBe(0);
    expect(showsApproach(-2)).toBe(false);
  });

  it('grows as the handover gets closer', () => {
    const a = approach(-0.2);
    const b = approach(-0.6);
    const c = approach(-0.95);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('stays in range across the whole band', () => {
    for (let z = -3; z <= 3; z += 0.05) {
      const v = approach(z);
      expect(v, z.toFixed(2)).toBeGreaterThanOrEqual(0);
      expect(v, z.toFixed(2)).toBeLessThanOrEqual(1);
    }
  });

  it('is shown only once it is worth reading', () => {
    // Faint enough to be missed is not worth drawing, and a caption that
    // flickers on at the very start of a gesture is noise.
    expect(showsApproach(-0.05)).toBe(false);
    expect(showsApproach(-0.8)).toBe(true);
  });

  it('does not claim anything is loading', () => {
    // Nothing is fetched at the handover - the positions are already computed
    // and the layer is already there. "Loading" would be a lie about why the
    // view is changing.
    expect(APPROACH_TEXT.toLowerCase()).not.toContain('load');
  });
});
