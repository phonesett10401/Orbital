import { describe, expect, it } from 'vitest';

import {
  APEX_ZOOM,
  ARRIVE_ZOOM,
  NOT_FLYING,
  flightDurationMs,
  flightPlan,
  swapsWorld,
} from './bodyFlight';
import { MAPLIBRE_MIN_ZOOM } from './solarScale';
import { SOLAR_MAX_ZOOM } from './planet/solarSystemLayer';

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

describe('the apex is where the solar system is', () => {
  it('pulls out far enough for the planets to be drawn', () => {
    // The pull-out is not a loading screen: the destination has to be visible
    // as a real body in a real place, which needs the solar layer live.
    expect(APEX_ZOOM).toBeLessThanOrEqual(SOLAR_MAX_ZOOM);
  });

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
