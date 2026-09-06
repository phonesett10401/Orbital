/**
 * How close the camera is to the solar system, for the cue that says so (D159).
 *
 * Zooming out from a planet used to arrive at the handover with no warning: the
 * globe simply stopped and something else was there. A cue on the approach makes
 * it a journey with a destination rather than a switch being thrown, which is
 * what Phone asked for - "incoming solar system, and then show up solar system".
 *
 * It is also honest about a thing the interface otherwise hides: **the two views
 * are different pictures at wildly different scales**, and a moment that says so
 * is better than a seam nobody was warned about.
 */

import { SOLAR_MAX_ZOOM } from './planet/solarSystemLayer';
import { PLANET_HOME } from './viewSettle';

/** What the cue says. Not "loading": nothing is being fetched. */
export const APPROACH_TEXT = 'Solar system ahead';

/**
 * Nought to one across the approach, and nought once the system is drawing.
 *
 * One *at* the handover rather than past it: the moment the planets appear the
 * cue has been overtaken by the thing it was announcing, and a caption over a
 * solar system saying a solar system is ahead is worse than no caption.
 */
export function approach(zoom: number): number {
  if (zoom >= PLANET_HOME) return 0;
  if (zoom <= SOLAR_MAX_ZOOM) return 0;
  const across = (PLANET_HOME - zoom) / (PLANET_HOME - SOLAR_MAX_ZOOM);
  return Math.min(1, Math.max(0, across));
}

/** Faint enough to be missed is not worth drawing. */
export const SHOW_ABOVE = 0.12;

export function showsApproach(zoom: number): boolean {
  return approach(zoom) > SHOW_ABOVE;
}
