/**
 * Regression tests for the pointer-to-selection path.
 *
 * These exist because clicking a marker silently did nothing while every other
 * test passed (D34). The original verification computed a marker's projected
 * screen position and called `pick()` directly — which proved the raycast
 * maths and nothing else. The failure was somewhere in the path that test
 * skipped.
 *
 * So these drive **real DOM events**: constructed `PointerEvent`s dispatched on
 * a canvas nested inside the container, relying on real bubbling, real
 * `getBoundingClientRect`, and the real handler wiring. `pick` is injected, so
 * no WebGL context is needed and the coordinates it receives can be asserted
 * exactly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAG_TOLERANCE_PX,
  attachPointerSelection,
  isClickNotDrag,
  screenToNdc,
} from './pointer';

/** The canvas is a grandchild of the container in the real app, as here. */
function buildDom(rect = { left: 0, top: 0, width: 800, height: 600 }) {
  const container = document.createElement('div');
  const wrapper = document.createElement('div');
  const canvas = document.createElement('canvas');
  wrapper.appendChild(canvas);
  container.appendChild(wrapper);
  document.body.appendChild(container);

  // jsdom does no layout, so the rect is stubbed. The point of the test is the
  // event path and the arithmetic, both of which are layout-independent.
  container.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;

  return { container, canvas };
}

function pointer(type: string, x: number, y: number): PointerEvent {
  // PointerEvent is not implemented in jsdom; MouseEvent carries every field
  // this code reads, and dispatches through the same bubbling path.
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }) as unknown as PointerEvent;
}

function click(canvas: HTMLElement, x: number, y: number): void {
  canvas.dispatchEvent(pointer('pointerdown', x, y));
  canvas.dispatchEvent(pointer('pointerup', x, y));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('screenToNdc', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };

  it('maps the centre to the origin', () => {
    expect(screenToNdc(400, 300, rect)).toEqual({ x: 0, y: 0 });
  });

  it('maps the corners to the unit square', () => {
    expect(screenToNdc(0, 0, rect)).toEqual({ x: -1, y: 1 });
    expect(screenToNdc(800, 600, rect)).toEqual({ x: 1, y: -1 });
  });

  it('accounts for an offset element rather than measuring the window', () => {
    // The bug this guards: a canvas inset by surrounding chrome, measured
    // against the window, shifts every ray by that offset — a picker that is
    // consistently, invisibly wrong rather than obviously broken.
    const offset = { left: 100, top: 50, width: 800, height: 600 };
    expect(screenToNdc(500, 350, offset)).toEqual({ x: 0, y: 0 });
  });

  it('inverts the y axis, because screens count down and NDC counts up', () => {
    expect(screenToNdc(400, 150, rect).y).toBeGreaterThan(0);
    expect(screenToNdc(400, 450, rect).y).toBeLessThan(0);
  });
});

describe('isClickNotDrag', () => {
  it('accepts a stationary press', () => {
    expect(isClickNotDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
  });

  it('tolerates a few pixels of tremor', () => {
    expect(isClickNotDrag({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(true);
  });

  it('rejects a drag', () => {
    expect(isClickNotDrag({ x: 10, y: 10 }, { x: 80, y: 40 })).toBe(false);
  });

  it('rejects movement just past the tolerance in either axis', () => {
    expect(isClickNotDrag({ x: 0, y: 0 }, { x: DRAG_TOLERANCE_PX + 1, y: 0 })).toBe(false);
    expect(isClickNotDrag({ x: 0, y: 0 }, { x: 0, y: DRAG_TOLERANCE_PX + 1 })).toBe(false);
  });
});

describe('attachPointerSelection through real DOM events', () => {
  it('fires for an event dispatched on the nested canvas', () => {
    // The listener is on the container; the event happens on the canvas two
    // levels down. If bubbling were ever broken by a stopPropagation somewhere,
    // this is what would catch it.
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    attachPointerSelection({ element: container, pick: () => 'abc123', onSelect });

    click(canvas, 400, 300);

    expect(onSelect).toHaveBeenCalledWith('abc123');
  });

  it('converts coordinates using the container rect', () => {
    const { container, canvas } = buildDom({ left: 100, top: 50, width: 800, height: 600 });
    const pick = vi.fn().mockReturnValue(null);
    attachPointerSelection({ element: container, pick, onSelect: vi.fn() });

    click(canvas, 500, 350); // the centre of an element offset by (100, 50)

    expect(pick).toHaveBeenCalledWith({ x: 0, y: 0 });
  });

  it('passes normalized device coordinates, not pixels', () => {
    const { container, canvas } = buildDom();
    const pick = vi.fn().mockReturnValue(null);
    attachPointerSelection({ element: container, pick, onSelect: vi.fn() });

    click(canvas, 600, 150);

    const [ndc] = pick.mock.calls[0];
    expect(ndc.x).toBeCloseTo(0.5, 6);
    expect(ndc.y).toBeCloseTo(0.5, 6);
  });

  it('reports a miss as null so clicking empty space clears the selection', () => {
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    attachPointerSelection({ element: container, pick: () => null, onSelect });

    click(canvas, 10, 10);

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('does not select at the end of a drag', () => {
    // Rotating the globe must not select whatever is under the cursor on release.
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    attachPointerSelection({ element: container, pick: () => 'abc123', onSelect });

    canvas.dispatchEvent(pointer('pointerdown', 100, 100));
    canvas.dispatchEvent(pointer('pointerup', 400, 260));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores a release with no matching press', () => {
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    attachPointerSelection({ element: container, pick: () => 'abc123', onSelect });

    canvas.dispatchEvent(pointer('pointerup', 400, 300));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a cancelled gesture does not select on the next release', () => {
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    attachPointerSelection({ element: container, pick: () => 'abc123', onSelect });

    canvas.dispatchEvent(pointer('pointerdown', 100, 100));
    canvas.dispatchEvent(pointer('pointercancel', 100, 100));
    canvas.dispatchEvent(pointer('pointerup', 100, 100));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('handles repeated clicks', () => {
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    const ids = ['a', 'b', 'c'];
    let i = 0;
    attachPointerSelection({ element: container, pick: () => ids[i++], onSelect });

    click(canvas, 100, 100);
    click(canvas, 200, 200);
    click(canvas, 300, 300);

    expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });

  it('detaching stops selection', () => {
    const { container, canvas } = buildDom();
    const onSelect = vi.fn();
    const detach = attachPointerSelection({
      element: container,
      pick: () => 'abc123',
      onSelect,
    });

    detach();
    click(canvas, 400, 300);

    expect(onSelect).not.toHaveBeenCalled();
  });
});
