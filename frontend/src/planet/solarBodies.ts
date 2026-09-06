/**
 * The two things the solar system's drawing shares (D164).
 *
 * Both lived in `solarSystemLayer.ts` until that file was deleted with the
 * MapLibre custom layer it existed for. They are here rather than in
 * `solarScene.ts` because the page's chrome needs the marker shape too, and a
 * component importing a renderer to get a type is the sort of dependency that
 * makes a module hard to move later.
 */

import type { ScenePlacement } from '../solarFrame';

/**
 * How far apart the Earth and the Moon are drawn, in globe radii.
 *
 * Far enough to read as two worlds, close enough to read as a pair.
 */
export const COMPANION_OFFSET = 0.55;

/**
 * The world under the camera, and its companion if it has one.
 *
 * Earth and the Moon are **0.0026 AU apart**, which this compression cannot
 * resolve: `radiusFor` maps that separation to less than a thousandth of a
 * globe radius, so drawn truthfully they occupy the same point and the one in
 * front simply hides the other. That is what "the Moon and the Earth overlap"
 * was.
 *
 * They are not one object, so they are not drawn as one. The companion is set
 * beside its partner by a **fixed, admitted offset** - far enough apart to read
 * as two worlds, and no claim at all about where the Moon actually is this week.
 * Everything else in this scene is a real position; this is the one arrangement
 * that is not, and it is said out loud here rather than buried in a renderer
 * (D140).
 */
export function homeBodies(standingOn: string): ScenePlacement[] {
  const pair: Record<string, string> = { earth: 'moon', moon: 'earth' };
  const companion = pair[standingOn];
  const home: ScenePlacement = {
    id: standingOn as ScenePlacement['id'],
    at: [0, 0, 0],
    distanceAu: 0,
  };
  if (!companion) return [home];
  return [
    home,
    { id: companion as ScenePlacement['id'], at: [COMPANION_OFFSET, 0, 0], distanceAu: 0 },
  ];
}

/** Where a body was drawn on screen, in CSS pixels, from the last frame. */
export interface BodyMarker {
  id: string;
  x: number;
  y: number;
  /** How wide the body is on screen, so a label can clear it. */
  sizePx: number;
}

/**
 * What each body is drawn in.
 *
 * Chosen to be told apart at twenty pixels rather than to be photographic - the
 * surfaces that have a real texture get one from `planetSurface.ts`, and this is
 * what the rest fall back to.
 */
export const COLOURS: Record<string, number> = {
  sun: 0xffd166,
  mercury: 0x9c8b7d,
  venus: 0xe6c884,
  mars: 0xd1603d,
  jupiter: 0xd7a06a,
  saturn: 0xe3cfa0,
  uranus: 0x9fd8e0,
  neptune: 0x6b8fd6,
};
