import { describe, expect, it } from 'vitest';

import {
  APEX_ZOOM,
  ARRIVE_ZOOM,
  NOT_FLYING,
  easingFor,
  flightDurationMs,
  flightPlan,
  swapsWorld,
} from './bodyFlight';
import { MAPLIBRE_MIN_ZOOM } from './solarScale';

describe('the shape of a trip', () => {
  it('goes out, swaps, comes back', () => {
    const plan = flightPlan('earth', 'mars');
    expect(plan.map((s) => s.phase)).toEqual(['leaving', 'swapping', 'arriving']);
  });

  it('swaps exactly once, and at the apex', () => {
    // The swap is hidden at the apex because that is the one instant with
    // nothing to look at - at zoom -2 the globe is twenty pixels across.
    // Anywhere else means watching Earth's oceans turn into Martian basalt,
    // which is the only part of this that would be a fiction (D126).
    const plan = flightPlan('earth', 'moon');
    const swaps = plan.filter(swapsWorld);
    expect(swaps).toHaveLength(1);
    expect(plan.indexOf(swaps[0])).toBe(1);
    expect(plan[0].zoom).toBe(APEX_ZOOM);
  });

  it('does not move for a trip to where you already are', () => {
    // The picker calls this on every choice, including the current body.
    expect(flightPlan('mars', 'mars')).toEqual([]);
    expect(flightDurationMs('mars', 'mars')).toBe(0);
  });

  it('takes long enough to read and not long enough to annoy', () => {
    const ms = flightDurationMs('earth', 'mercury');
    expect(ms).toBeGreaterThan(1_500);
    expect(ms).toBeLessThan(4_000);
  });
});

describe('the apex', () => {
  it('does not ask for a zoom MapLibre refuses', () => {
    // setMinZoom throws below -2; asking easeTo for less would silently clamp
    // and leave the swap happening at a zoom nobody chose.
    expect(APEX_ZOOM).toBeGreaterThanOrEqual(MAPLIBRE_MIN_ZOOM);
  });

  it('arrives close enough to see a surface', () => {
    expect(ARRIVE_ZOOM).toBeGreaterThan(0);
    expect(ARRIVE_ZOOM).toBeGreaterThan(APEX_ZOOM);
  });
});

describe('not flying', () => {
  it('is the resting state and names no destination', () => {
    expect(NOT_FLYING.destination).toBeNull();
    expect(NOT_FLYING.phase).toBe('done');
  });
});

describe('the trip is a journey, not a zoom', () => {
  it('turns toward the destination on the way out', () => {
    // Without this the centre never moves and the trip reads as the picture
    // shrinking and growing again rather than the reader going anywhere.
    const leaving = flightPlan('earth', 'mars')[0];
    expect(leaving.phase).toBe('leaving');
    expect(leaving.aimAtDestination).toBe(true);
  });

  it('has the destination already centred when the world swaps', () => {
    // Swapping first and turning afterwards would put the new world somewhere
    // behind the camera and then whip round to it.
    const plan = flightPlan('earth', 'mars');
    const swapIndex = plan.findIndex((step) => step.phase === 'swapping');
    expect(plan[swapIndex - 1].aimAtDestination).toBe(true);
    expect(plan[swapIndex].aimAtDestination).toBe(false);
  });

  it('does not steer again while arriving', () => {
    // The camera is already pointed at it; a second aim would be a visible
    // correction at the moment the surface appears.
    const arriving = flightPlan('earth', 'mars').find((s) => s.phase === 'arriving');
    expect(arriving?.aimAtDestination).toBe(false);
  });

  it('gives the outward leg longer than the arrival', () => {
    // The crossing is the part worth watching; the descent is not.
    const plan = flightPlan('earth', 'jupiter');
    const out = plan.find((s) => s.phase === 'leaving');
    const arrive = plan.find((s) => s.phase === 'arriving');
    expect(out!.durationMs).toBeGreaterThan(arrive!.durationMs);
  });
});

describe('how the camera is paced', () => {
  it('accelerates away and decelerates in', () => {
    // A single ease-out across both halves reads as one continuous zoom, which
    // is the thing the trip was asked to stop being (D155).
    const plan = flightPlan('earth', 'mars');
    expect(plan.find((s) => s.phase === 'leaving')?.easing).toBe('accelerate');
    expect(plan.find((s) => s.phase === 'arriving')?.easing).toBe('decelerate');
  });

  it('gives curves that start at nought and end at one', () => {
    // An easing that does not reach 1 leaves the camera short of the zoom it
    // was told to go to, and nothing reports it.
    for (const name of ['accelerate', 'decelerate'] as const) {
      expect(easingFor(name)(0), name).toBeCloseTo(0);
      expect(easingFor(name)(1), name).toBeCloseTo(1);
    }
  });

  it('makes accelerate slow at the start and decelerate fast at the start', () => {
    expect(easingFor('accelerate')(0.25)).toBeLessThan(0.25);
    expect(easingFor('decelerate')(0.25)).toBeGreaterThan(0.25);
  });

  it('never goes backwards', () => {
    // A camera that retreats mid-step reads as a stutter, and MapLibre will
    // happily animate one.
    for (const name of ['accelerate', 'decelerate'] as const) {
      const curve = easingFor(name);
      for (let t = 0.05; t <= 1; t += 0.05) {
        expect(curve(t), `${name} at ${t.toFixed(2)}`).toBeGreaterThanOrEqual(
          curve(t - 0.05),
        );
      }
    }
  });
});
