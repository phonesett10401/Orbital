/**
 * Setting a layer's visibility without trusting a memo (D154).
 *
 * ## The bug this exists to stop, which has now happened twice
 *
 * The frame loop wants two sets of layers hidden or shown depending on the mode
 * and the zoom, and `setLayoutProperty` on every frame is wasteful, so it
 * remembered what it had last set and only wrote on a change. That is correct
 * exactly as long as **nothing else writes to those layers.**
 *
 * Something else does. `applyBody` decides visibility from the body alone, and
 * turns every Earth layer back on when the camera returns to Earth - so leaving
 * for the solar system and coming back put the satellite ground symbols back up
 * underneath a shell that was still drawing, and the memo said "no change"
 * because the *intent* had not changed. Two thousand satellites on the surface
 * and the same two thousand in orbit, at once.
 *
 * This is D141 one layer along. There the fix was to read the zoom rather than
 * track a flag, so the two could not disagree; here it is to read the map.
 * **A cache of what you asked for is not a record of what is true**, and the
 * moment a second writer exists it stops being either.
 *
 * ## Why this is not just `setLayoutProperty` every frame
 *
 * Because that is a style mutation, and MapLibre does real work for one whether
 * or not the value changed. Reading first keeps the write on transitions only,
 * while making the *read* the source of truth - so a write by anybody else is
 * noticed on the next frame instead of never.
 */

export type Visibility = 'visible' | 'none';

/**
 * A layer's visibility, in the two words the style uses.
 *
 * MapLibre returns `undefined` for a layer that has never had the property set,
 * and the spec's default is `visible` - so an unset layer is a visible one, and
 * treating `undefined` as "unknown" would write to every such layer once per
 * frame forever.
 */
export function currentVisibility(raw: unknown): Visibility {
  return raw === 'none' ? 'none' : 'visible';
}

/** Whether a write is needed at all. */
export function needsWrite(raw: unknown, want: Visibility): boolean {
  return currentVisibility(raw) !== want;
}

export interface VisibilityTarget {
  getLayer(id: string): unknown;
  getLayoutProperty(id: string, name: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): void;
}

/**
 * Put these layers into this visibility, writing only where it differs.
 *
 * Returns the ids it actually wrote, which is what makes it testable and what
 * lets a caller log a change nobody expected.
 */
export function setVisibility(
  map: VisibilityTarget,
  layerIds: readonly string[],
  want: Visibility,
): string[] {
  const written: string[] = [];
  for (const id of layerIds) {
    if (!map.getLayer(id)) continue;
    if (!needsWrite(map.getLayoutProperty(id, 'visibility'), want)) continue;
    map.setLayoutProperty(id, 'visibility', want);
    written.push(id);
  }
  return written;
}
