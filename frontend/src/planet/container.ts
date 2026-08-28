/**
 * A guard against handing MapLibre a container with no size.
 *
 * This exists because of a failure that produced no error anywhere: MapLibre
 * adds `maplibregl-map` to the container it is given, and its stylesheet sets
 * `position: relative` on that class. Loaded as a dynamic import, that
 * stylesheet arrives *after* the application's own, and at equal specificity
 * the later rule wins — so a container styled `position: absolute; inset: 0`
 * silently became relative, collapsed to zero height, and the map rendered
 * into nothing. No exception, no console error, no failed request. A blank
 * screen and a canvas quietly sized 400x300, which is MapLibre's fallback when
 * it is given a box with no dimensions (D55).
 *
 * The CSS is fixed by specificity. This is the check that would have made the
 * failure legible in one line rather than in a session of bisecting, and it
 * costs one measurement at startup.
 */

export interface ContainerSize {
  width: number;
  height: number;
}

/** MapLibre's fallback canvas size when the container measures zero. */
export const MAPLIBRE_FALLBACK = { width: 400, height: 300 } as const;

/**
 * Whether a container is big enough to render into.
 *
 * Deliberately not "greater than zero": a box of a few pixels is a layout
 * mistake with the same cause and the same symptom, and calling it usable
 * would let the interesting case through.
 */
export function isRenderable({ width, height }: ContainerSize): boolean {
  return width >= 32 && height >= 32;
}

/**
 * The message to print when it is not.
 *
 * Names the likely cause, because "container has no size" sends the reader
 * looking at their own layout, and the cause has historically been someone
 * else's stylesheet winning the cascade.
 */
export function unrenderableMessage({ width, height }: ContainerSize): string {
  return (
    `[planet] the map container measures ${width}x${height}, so nothing will be drawn. ` +
    'Most likely a CSS collision: MapLibre sets `position: relative` on ' +
    '`.maplibregl-map` from a stylesheet that loads after the application\'s, ' +
    'which overrides an equally specific `position: absolute` and collapses the box.'
  );
}
