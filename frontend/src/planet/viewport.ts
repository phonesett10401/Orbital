/**
 * The map's bounds, as the bounding box the backend understands.
 *
 * The globe view derives this from the camera and a lot of spherical geometry
 * (`globe/viewport.ts`); a map already knows what it is looking at, so this is
 * a rename rather than a calculation. Everything downstream — the tier 2 poll,
 * the credit band, the thinning cap — is unchanged, because the contract is
 * (D21, D27).
 */

import type { BoundingBox } from '../types';

/** The shape MapLibre's `getBounds()` returns, narrowed to what is used. */
export interface MapBoundsLike {
  getWest(): number;
  getEast(): number;
  getSouth(): number;
  getNorth(): number;
}

/**
 * Convert map bounds to the contract's bounding box.
 *
 * Two things a straight copy would get wrong:
 *
 * - **Longitude runs away.** MapLibre lets the user pan east forever, so west
 *   can be 400 and east 480 after a couple of laps. The backend parses
 *   `[-180, 180)` and would reject or mis-filter those, so both are wrapped —
 *   and wrapping is what naturally produces `lonMin > lonMax` for a box across
 *   the antimeridian, which the contract already defines (D25).
 * - **Latitude past the poles.** A globe view can put the pole in the middle
 *   of the screen, where the bounds come back beyond ±90.
 */
export function boundsToBBox(bounds: MapBoundsLike): BoundingBox {
  return {
    lonMin: wrapLongitude(bounds.getWest()),
    lonMax: wrapLongitude(bounds.getEast()),
    latMin: Math.max(-90, bounds.getSouth()),
    latMax: Math.min(90, bounds.getNorth()),
  };
}

/** Fold a longitude into [-180, 180), the range the contract defines. */
export function wrapLongitude(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  // -180 and +180 are the same meridian; the contract picks -180.
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Whether the whole world is in view.
 *
 * Zoomed out on a globe the bounds cover everything, and asking the backend
 * for a viewport that is the entire planet is worse than asking for no
 * viewport at all: it spends a tier 2 credit on the widest possible box, which
 * is exactly what the cost band exists to prevent (D21, D27).
 */
export function coversWholeWorld(bounds: MapBoundsLike): boolean {
  return bounds.getEast() - bounds.getWest() >= 360;
}
