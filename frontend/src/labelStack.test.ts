import { describe, expect, it } from 'vitest';

import { ROW_GAP, stackLabels } from './labelStack';

const box = (id: string, x: number, y: number) => ({ id, x, y, width: 60, height: 12 });

describe('keeping labels off each other', () => {
  it('leaves labels that already clear alone', () => {
    const given = [box('a', 0, 0), box('b', 200, 0)];
    expect(stackLabels(given)).toEqual(given);
  });

  it('never moves the first one', () => {
    // Order is priority: whoever arrives first keeps the place directly under
    // their own planet.
    const out = stackLabels([box('a', 0, 0), box('b', 5, 0)]);
    expect(out[0]).toEqual(box('a', 0, 0));
  });

  it('pushes a colliding label down, not sideways', () => {
    // Sideways would put a name under a neighbouring planet, which says the
    // wrong thing rather than merely looking untidy.
    const out = stackLabels([box('a', 0, 0), box('b', 5, 0)]);
    expect(out[1].x).toBe(5);
    expect(out[1].y).toBeGreaterThan(0);
  });

  it('separates them by a readable gap', () => {
    const out = stackLabels([box('a', 0, 0), box('b', 5, 0)]);
    expect(out[1].y - out[0].y).toBeGreaterThanOrEqual(12 + ROW_GAP);
  });

  it('stacks a whole crowd without any pair overlapping', () => {
    // Earth, its Moon fifteen pixels away by design, and Venus beside them -
    // the cluster that could not be fixed by moving the bodies.
    const out = stackLabels([box('earth', 100, 50), box('moon', 115, 50), box('venus', 70, 50)]);
    for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i];
        const b = out[j];
        const apart =
          Math.abs(a.x - b.x) * 2 >= a.width + b.width ||
          Math.abs(a.y - b.y) * 2 >= a.height + b.height;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
  });

  it('keeps every label it was given', () => {
    // Nothing is dropped: every planet was asked to be named, and hiding the
    // crowded ones answers a different question.
    const given = [box('a', 0, 0), box('b', 2, 0), box('c', 4, 0), box('d', 6, 0)];
    expect(stackLabels(given).map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('terminates even when everything is on one point', () => {
    const given = Array.from({ length: 8 }, (_, i) => box(String(i), 0, 0));
    const out = stackLabels(given);
    expect(out).toHaveLength(8);
    for (const l of out) expect(Number.isFinite(l.y)).toBe(true);
  });
});
