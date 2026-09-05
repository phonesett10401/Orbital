/**
 * Going to another world, without pretending to travel there.
 *
 * MapLibre draws **one** globe, at the origin. Choosing Mars does not move a
 * camera across the solar system - it makes Mars the globe. So a literal
 * flight is not available, and building something that looked like one would
 * be the most elaborate lie in the project.
 *
 * What is available is honest and, as it happens, the same thing every space
 * application actually does:
 *
 * 1. **Pull out** until the globe is small and the solar system is drawn
 *    around it, so the destination is visible as a real body in a real place.
 * 2. **Swap at the apex**, where the globe is 20 pixels across and the change
 *    of world is least visible.
 * 3. **Zoom back in** on the new surface.
 *
 * The swap is hidden not to deceive but because it is the one instant with
 * nothing to look at: at zoom -2 the old globe is a dot. Putting it anywhere
 * else means watching Earth's oceans turn into Martian basalt, which is the
 * only part of this that would be a fiction.
 *
 * ## Why the destination is highlighted on the way out
 *
 * The pull-out is not a loading screen. The solar system layer draws real
 * positions from real elements (D121, D124), so the planet growing brighter at
 * the apex is genuinely where that planet is now. That is the honest version
 * of "flying there": showing the reader the actual sky before changing what is
 * under their feet.
 */

import type { BodyId } from './bodies';

/** Where the camera goes at the apex. MapLibre's own floor (D123). */
export const APEX_ZOOM = -2;

/** Where it settles on arrival - close enough to read a surface, not a crater. */
export const ARRIVE_ZOOM = 1.5;

export const OUT_MS = 2_200;
export const IN_MS = 1_500;

export type FlightPhase = 'leaving' | 'swapping' | 'arriving' | 'done';

export interface FlightStep {
  phase: FlightPhase;
  /** Camera target for this step, or null when only the world changes. */
  zoom: number | null;
  durationMs: number;
  /**
   * Whether this step also steers the camera at the destination.
   *
   * The trip used to be a zoom out and a zoom in with the centre never moving,
   * which is exactly what it looked like: the reader was not going anywhere,
   * the picture was just getting smaller and then bigger again. Turning toward
   * the destination while pulling back is what makes it a journey - the planet
   * you are going to drifts to the middle of the screen and grows, and it is
   * the *real* direction, because the position it is drawn at is real (D136).
   */
  aimAtDestination: boolean;
}

/**
 * The steps for a trip, in order.
 *
 * A plan rather than a sequence of timers, so the ordering and the durations
 * can be tested without a map or a clock - the same reason `timeTravel.ts` and
 * `solarScale.ts` are data rather than callbacks.
 */
export function flightPlan(from: BodyId, to: BodyId): FlightStep[] {
  if (from === to) return [];
  return [
    // Out and *across*, together, so the pull-back and the turn are one move.
    { phase: 'leaving', zoom: APEX_ZOOM, durationMs: OUT_MS, aimAtDestination: true },
    // The swap happens with the destination already centred, so the world that
    // appears is under the camera rather than somewhere behind it.
    { phase: 'swapping', zoom: null, durationMs: 0, aimAtDestination: false },
    { phase: 'arriving', zoom: ARRIVE_ZOOM, durationMs: IN_MS, aimAtDestination: false },
  ];
}

/** How long a trip takes, for anything that needs to wait it out. */
export function flightDurationMs(from: BodyId, to: BodyId): number {
  return flightPlan(from, to).reduce((total, step) => total + step.durationMs, 0);
}

/**
 * Whether the world may change on this step.
 *
 * Exactly one step in a plan is allowed to swap, and it is the one at the
 * apex. Asserting this rather than trusting the order is the difference
 * between a hidden swap and a visible one.
 */
export function swapsWorld(step: FlightStep): boolean {
  return step.phase === 'swapping';
}

/**
 * The body the camera is heading for, while a trip is in progress.
 *
 * Held so the solar system layer can brighten it on the way out. `null` when
 * nothing is in flight, which is almost always.
 */
export interface FlightState {
  destination: BodyId | null;
  phase: FlightPhase;
}

export const NOT_FLYING: FlightState = { destination: null, phase: 'done' };
