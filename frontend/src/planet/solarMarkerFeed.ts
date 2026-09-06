/**
 * How the drawn positions of the planets reach the chrome (D159).
 *
 * The layer computes them inside a WebGL render; React needs them to put a name
 * and a Visit button on each body. A store field would be the obvious route and
 * is the wrong one: these change on **every frame** the camera moves, and a
 * store write per frame wakes every subscriber in the application to tell them
 * a planet moved four pixels.
 *
 * So: one mutable reference, written when the layer is built and read by
 * whoever wants a frame's worth. The component polls it on its own animation
 * frame and re-renders only when the numbers have actually changed enough to
 * see, which keeps the cost proportional to what is on screen rather than to
 * how often the camera moves.
 */

import type { BodyMarker } from './solarSystemLayer';

let source: (() => BodyMarker[]) | null = null;
let zoomSource: (() => number) | null = null;

/** Called when the solar layer is created, and again with null when it goes. */
export function publishMarkerSource(fn: (() => BodyMarker[]) | null): void {
  source = fn;
}

/**
 * This frame's markers, or nothing.
 *
 * Empty is the ordinary answer: the layer clears them whenever it declines to
 * draw, so "no solar system on screen" and "no labels" are the same fact rather
 * than two that could disagree.
 */
export function currentMarkers(): BodyMarker[] {
  return source ? source() : [];
}

/**
 * The camera's zoom, for the chrome that has to know how close the handover is.
 *
 * Here rather than in the store for the same reason as the markers: it changes
 * on every frame of every gesture, and a store write per frame wakes the whole
 * application to say the camera moved a hundredth of a zoom level.
 */
export function publishZoomSource(fn: (() => number) | null): void {
  zoomSource = fn;
}

/** The current zoom, or a number far inside the planet view when unknown. */
export function currentZoom(): number {
  return zoomSource ? zoomSource() : 99;
}
