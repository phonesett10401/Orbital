/**
 * The callout line from a selected lunar spacecraft (D136).
 *
 * Phone asked for a line leaving the spacecraft toward the north-east at 45
 * degrees. The word that matters is **degrees on the screen**, not degrees on
 * the Moon: a bearing of 45 degrees is a rhumb line that curves under the
 * globe projection and points somewhere different at every latitude, and near
 * the pole - where these spacecraft spend much of their time - it is almost
 * meaningless. What a reader means by a 45 degree callout is the diagonal they
 * can see.
 *
 * So the geometry is done in screen space and turned back into coordinates:
 * project the spacecraft, step up and to the right by equal pixels, unproject.
 * The line is then exactly 45 degrees on screen wherever the craft is and
 * however the map is rotated, and it is recomputed as the camera moves because
 * that is what keeps it that way.
 *
 * This module holds the part that is arithmetic. The projecting is MapLibre's.
 */

/** How far the callout reaches, in screen pixels. */
export const LEADER_PIXELS = 88;

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Where the callout ends, given where the spacecraft is on screen.
 *
 * North-east on a screen is **up and to the right**, and up is a *smaller* y:
 * the one sign that a reader cannot check by reasoning and can only see, which
 * is why it is a function with a test rather than two characters inline.
 */
export function leaderEnd(from: ScreenPoint, pixels = LEADER_PIXELS): ScreenPoint {
  // Equal steps on both axes is what makes it 45 degrees; the diagonal is
  // therefore `pixels * sqrt(2)` long, and `pixels` is the reach on each axis.
  return { x: from.x + pixels, y: from.y - pixels };
}

/**
 * The angle of the callout on screen, in degrees, measured anticlockwise from
 * east - the convention a reader means when they say "45 degrees".
 *
 * Exists to be asserted. A leader that quietly becomes 44 or 46 degrees after
 * someone adjusts an offset is not visibly wrong, and this is the only thing
 * that would notice.
 */
export function leaderAngleDeg(from: ScreenPoint, to: ScreenPoint): number {
  // Screen y grows downward, so it is negated to get the mathematical angle.
  const angle = (Math.atan2(from.y - to.y, to.x - from.x) * 180) / Math.PI;
  return angle;
}

/** How long the diagonal is, for anything that needs to place a label on it. */
export function leaderLength(from: ScreenPoint, to: ScreenPoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export interface LeaderFeature {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: Record<string, never>;
  }>;
}

/** The line as GeoJSON, or an empty collection when nothing is selected. */
export function leaderFeature(
  from: [number, number] | null,
  to: [number, number] | null,
): LeaderFeature {
  if (!from || !to) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [from, to] },
        properties: {},
      },
    ],
  };
}
