/**
 * What a request carries, and which layer asks for one when the globe turns.
 *
 * There is no component-render harness here, so the hook itself cannot be
 * driven. The judgement it makes is extracted to `bboxFor` and tested as data,
 * which is the same arrangement the presentation modules use.
 */

import { describe, expect, it } from 'vitest';

import { bboxFor, VIEWPORT_REFETCH_DEBOUNCE_MS } from './usePolling';
import { LAYERS } from '../state/store';
import { isLive } from '../timeTravel';
import type { BoundingBox } from '../types';

const VIEWPORT: BoundingBox = { latMin: 10, lonMin: -20, latMax: 50, lonMax: 30 };

describe('what a list request carries', () => {
  it('sends the viewport for aircraft, because it aims the credits', () => {
    // Not an optimisation: the bounding box is how the backend learns where to
    // spend its fast tier 2 poll (D21). Dropping it would quietly stop the
    // region the user is looking at from being the fresh one.
    const aircraft = LAYERS.find((l) => l.resource === 'aircraft')!;
    expect(aircraft.viewportScoped).toBe(true);
    expect(bboxFor(aircraft, VIEWPORT)).toEqual(VIEWPORT);
  });

  it('never sends the viewport for satellites, however the map is pointed', () => {
    // The layer computes positions rather than fetching them, so there is no
    // credit model to aim and the whole catalogue is 350 KB. A viewport here
    // buys nothing and costs a round trip every time the globe turns (D110).
    const satellites = LAYERS.find((l) => l.resource === 'satellites')!;
    expect(satellites.viewportScoped).toBe(false);
    expect(bboxFor(satellites, VIEWPORT)).toBeNull();
  });

  it('sends nothing when there is no viewport, for either layer', () => {
    // A viewport covering the whole planet is published as null on purpose: it
    // would spend a tier 2 credit on the widest box there is (D21, D27).
    for (const layer of LAYERS) expect(bboxFor(layer, null)).toBeNull();
  });
});

describe('how long a move waits before it is worth a request', () => {
  it('settles well inside a second, because a drag that ends should fill in', () => {
    // This sits on top of the view's own publish throttle, so it is half of a
    // sum rather than the whole delay. It was 250 ms against a 500 ms throttle
    // with no unthrottled publish on `moveend` at all, and the total read as
    // lag (D110).
    expect(VIEWPORT_REFETCH_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(VIEWPORT_REFETCH_DEBOUNCE_MS).toBeLessThanOrEqual(150);
  });
});

describe('when the map is rewound', () => {
  it('sends the instant, and only for a layer that can answer', () => {
    // Satellites compute their positions, so any instant costs the same
    // arithmetic as now. Aircraft positions are observed - there is no
    // function to evaluate at another time - so the control is not offered
    // there at all (D119).
    const satellites = LAYERS.find((l) => l.resource === 'satellites')!;
    expect(satellites.viewportScoped).toBe(false);
    expect(bboxFor(satellites, VIEWPORT)).toBeNull();
  });

  it('treats zero as a real instant, not as live', () => {
    // Epoch zero is 1970, which is a time. A truthiness check would call it
    // live and silently resume polling over the top of it.
    expect(isLive(0)).toBe(false);
    expect(isLive(null)).toBe(true);
  });
});
