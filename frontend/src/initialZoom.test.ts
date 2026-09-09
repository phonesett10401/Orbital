import { describe, expect, it } from 'vitest';

import { DEFAULT_ZOOM, GLOBE_FIT, initialZoom } from './initialZoom';

/** The globe's diameter in pixels at a given zoom, from MapLibre's 512px world. */
const diameter = (zoom: number) => (512 * 2 ** zoom) / Math.PI;

describe('initialZoom', () => {
  it('agrees with the zoom chosen by eye on the window it was chosen in', () => {
    // The whole argument for the formula. 2 was picked by looking at a desktop
    // window about 800 tall; if fitting that same window returned something
    // else, the model would be wrong and every other answer here suspect.
    expect(initialZoom(1440, 800)).toBeCloseTo(DEFAULT_ZOOM, 1);
  });

  it('pulls back far enough to fit the planet on a phone', () => {
    const zoom = initialZoom(375, 812);
    expect(diameter(zoom)).toBeLessThanOrEqual(375);
    expect(zoom).toBeLessThan(DEFAULT_ZOOM);
  });

  it('leaves the planet room rather than letting it touch the edges', () => {
    expect(diameter(initialZoom(375, 812))).toBeCloseTo(375 * GLOBE_FIT, 0);
  });

  it('never opens closer than the zoom it replaces', () => {
    for (const [w, h] of [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 900]]) {
      expect(initialZoom(w, h)).toBeLessThanOrEqual(DEFAULT_ZOOM);
    }
  });

  it('fits the shortest side, so landscape on a phone still shows a planet', () => {
    // 812 x 375 is the same phone turned over. Width is no longer the
    // constraint and height is, which a width-only rule would miss.
    expect(initialZoom(812, 375)).toBe(initialZoom(375, 812));
  });

  it('answers with the default when the container has not been laid out', () => {
    // Measured before layout, every dimension is 0 - and log2(0) is -Infinity,
    // which is a camera at the end of the universe rather than a wrong zoom.
    expect(initialZoom(0, 0)).toBe(DEFAULT_ZOOM);
    expect(initialZoom(Number.NaN, 812)).toBe(DEFAULT_ZOOM);
  });
});
