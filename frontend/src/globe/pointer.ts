/**
 * Turning pointer input into a selection.
 *
 * Split out of GlobeView so it can be tested through the real DOM event path.
 * The bug this module exists to prevent was invisible to the original
 * verification: that test computed a marker's projected screen position and
 * called `pick()` directly, which exercises the raycast maths but never
 * touches listener wiring, event bubbling, or coordinate conversion. Every one
 * of those is a place clicking can silently stop working (D34).
 *
 * `pick` is injected rather than imported, so these tests need no WebGL
 * context.
 */

export interface Point2 {
  x: number;
  y: number;
}

/**
 * How far the pointer may travel between press and release and still count as
 * a click.
 *
 * Rotating the globe must not select whatever marker happens to be under the
 * cursor when the drag ends. A few pixels of slop makes clicking forgiving for
 * anyone using a trackpad.
 */
export const DRAG_TOLERANCE_PX = 5;

/**
 * Convert viewport coordinates to normalized device coordinates.
 *
 * Uses the element's bounding rect, never the window: the canvas can be inset
 * by surrounding chrome, and measuring against the window would shift every
 * ray by that offset — producing a picker that is subtly, consistently wrong
 * rather than obviously broken.
 */
export function screenToNdc(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): Point2 {
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

export function isClickNotDrag(
  down: Point2,
  up: Point2,
  tolerance = DRAG_TOLERANCE_PX,
): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= tolerance;
}

export interface PointerSelectionOptions {
  /** Element to listen on. Events from the canvas inside it bubble up here. */
  element: HTMLElement;
  /** Returns the id under these normalized device coordinates, or null. */
  pick(ndc: Point2): string | null;
  /** Called with the picked id, or null when empty space was clicked. */
  onSelect(id: string | null): void;
  dragTolerance?: number;
}

/**
 * Wire pointer events to selection. Returns a detach function.
 *
 * Listens on a container rather than the canvas because globe.gl owns the
 * canvas and re-creates it on resize; the container is stable. Events bubble,
 * so this still receives them.
 */
export function attachPointerSelection({
  element,
  pick,
  onSelect,
  dragTolerance = DRAG_TOLERANCE_PX,
}: PointerSelectionOptions): () => void {
  let down: Point2 | null = null;

  const onPointerDown = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent) => {
    const start = down;
    down = null;
    if (!start) return;

    const up = { x: event.clientX, y: event.clientY };
    if (!isClickNotDrag(start, up, dragTolerance)) return;

    const rect = element.getBoundingClientRect();
    // Clicking empty space clears the selection, which is the only way to
    // dismiss the detail panel without hunting for a close button.
    onSelect(pick(screenToNdc(up.x, up.y, rect)));
  };

  // A pointer that leaves the element mid-gesture must not leave `down` set,
  // or the next release anywhere would be treated as the end of that click.
  const onPointerCancel = () => {
    down = null;
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);

  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerCancel);
  };
}
