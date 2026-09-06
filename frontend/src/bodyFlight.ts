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
 * ## The streaks, and where the line is
 *
 * A light-speed effect plays over the top of all this (D155), and it is worth
 * being exact about why that is not the lie the paragraph above refuses.
 *
 * The lie would be a *fabricated observation*: a sky drawn as though it were
 * measured, with stars flying past that no catalogue puts there. That is not
 * what happens. The real sky is `stars.ts`, it comes from a real catalogue, and
 * it does not move. The streaks are a full-screen rush of light on a canvas
 * above the map, which nobody could mistake for data - the same kind of
 * statement as a fade, and no more a claim about the universe than one.
 *
 * The direction, though, is real: the camera turns toward the destination's
 * actual position while pulling out, so the point the streaks radiate from is
 * the true bearing of the world being travelled to.
 *
 * ## The camera accelerates away and decelerates in
 *
 * Not one easing for the whole trip. Leaving eases *in* - slow, then a rush -
 * so the pull-back arrives with the effect rather than ahead of it; arriving
 * eases *out*, so the new world is settled into rather than stopped at. A
 * single ease-out across both reads as one continuous zoom, which is the thing
 * this was asked to stop being.
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
  /**
   * How the camera's speed is shaped over this step.
   *
   * Named rather than a function so a plan stays comparable data - two plans
   * with closures in them cannot be checked against each other, and this whole
   * module exists to be testable without a map.
   */
  easing: EasingName;
}

/** Slow then fast, fast then slow, or neither. */
export type EasingName = 'accelerate' | 'decelerate';

/**
 * The easing curves, by name.
 *
 * `accelerate` is the departure: nothing much happens, and then the world drops
 * away. `decelerate` is the arrival, which has to settle rather than stop -
 * a linear arrival reads as hitting the surface.
 */
export function easingFor(name: EasingName): (t: number) => number {
  return name === 'accelerate' ? (t) => t * t : (t) => 1 - (1 - t) * (1 - t);
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
    {
      phase: 'leaving',
      zoom: APEX_ZOOM,
      durationMs: OUT_MS,
      aimAtDestination: true,
      easing: 'accelerate',
    },
    // The swap happens with the destination already centred, so the world that
    // appears is under the camera rather than somewhere behind it.
    {
      phase: 'swapping',
      zoom: null,
      durationMs: 0,
      aimAtDestination: false,
      easing: 'decelerate',
    },
    {
      phase: 'arriving',
      zoom: ARRIVE_ZOOM,
      durationMs: IN_MS,
      aimAtDestination: false,
      easing: 'decelerate',
    },
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
