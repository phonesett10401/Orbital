/**
 * Keeping two labels off each other (D160).
 *
 * The orbits were given room first, and that was the real fix - Venus and Earth
 * are 46 pixels apart on screen now where they used to sit on top of one
 * another. What is left is not the scale but the **type**: a name is sixty
 * pixels wide whatever the planet's orbit does, and the Moon is drawn fifteen
 * pixels from the Earth on purpose, so those two can never be separated by
 * moving the bodies.
 *
 * So a label that would land on one already placed is pushed **down**, never
 * sideways: down keeps it under its own body, where the eye can follow a column
 * back up to what it names, while sideways puts it under a neighbour and says
 * the wrong thing.
 *
 * Nothing is dropped. Phone asked for every planet named, and a de-cluttering
 * that silently hides the crowded ones answers a different question.
 */

export interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much clear air to leave between two rows. */
export const ROW_GAP = 3;

function overlaps(a: Placed, b: Placed): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width &&
    Math.abs(a.y - b.y) * 2 < a.height + b.height + ROW_GAP * 2
  );
}

/**
 * Push labels down until none overlaps another, in the order given.
 *
 * **Order is priority**: the first is never moved, so a caller puts the body
 * being stood on, and then the largest, at the front. Whoever arrives first
 * keeps the place directly under their own planet.
 *
 * Deterministic and bounded - each label is tried at successively lower rows
 * and stops as soon as it is clear, so the worst case is one row per label
 * rather than a search.
 */
export function stackLabels(labels: readonly Placed[]): Placed[] {
  const placed: Placed[] = [];
  for (const label of labels) {
    const next = { ...label };
    let guard = 0;
    while (placed.some((other) => overlaps(next, other)) && guard < labels.length) {
      next.y += next.height + ROW_GAP;
      guard += 1;
    }
    placed.push(next);
  }
  return placed;
}
