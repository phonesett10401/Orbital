/**
 * Choosing a body on the solar system page, and what is said about it (D171).
 *
 * Phone pointed at a site whose interaction is worth having: a dark scene with
 * a handful of lights in it, where hovering one brightens it, clicking it flies
 * the camera in, and a caption fades up naming the thing you are now looking
 * at - with arrows to step to the next one and an index for the whole set.
 *
 * That model fits this page unusually well, because **we already have the
 * markers.** They are planets rather than decoration, they are already drawn at
 * computed positions, and the page already knows how to fly somewhere. What it
 * did not have was any notion of a body being *chosen*: the only interaction
 * was hovering a nine-pixel label to reveal a button.
 *
 * The arithmetic lives here rather than in the component for the reason
 * `visibilityFor` does: a rule inside an imperative callback is a rule nothing
 * can check, and this project has shipped that mistake twice (D133, D168).
 */

import { bodyFor, isLandable, type Body, type BodyId } from './bodies';

/**
 * The bodies in the order the stepper walks them: outward from the Sun.
 *
 * The Moon sits after Earth rather than in distance order, because it is not
 * at a distance of its own - it rides with Earth, 0.0026 AU away, below
 * anything this view can show (D140). "After Earth" is the only honest place
 * for it in a list sorted by distance from the Sun.
 */
export const FOCUS_ORDER: readonly BodyId[] = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const;

/**
 * The next body in the stepper, wrapping at both ends.
 *
 * Wrapping rather than stopping: there are ten of them and the list is a ring
 * in the reader's head, so a right arrow that goes dead at Neptune reads as
 * broken rather than as finished. `available` is passed in because the scene
 * draws the Moon only when it is Earth's companion.
 */
export function stepFocus(
  current: BodyId | null,
  direction: 1 | -1,
  available: readonly string[],
): BodyId | null {
  const ring = FOCUS_ORDER.filter((id) => available.includes(id));
  if (ring.length === 0) return null;
  if (current === null) return direction === 1 ? ring[0] : ring[ring.length - 1];
  const at = ring.indexOf(current);
  if (at === -1) return ring[0];
  return ring[(at + direction + ring.length) % ring.length];
}

/**
 * Which marker a click at this point landed on, or null.
 *
 * The canvas is one WebGL surface, so nothing in it is hit-tested for us - the
 * same bargain `satelliteShellLayer.pick` makes. It answers from the markers
 * the **last frame** projected, so what is clickable is what is visible.
 *
 * The tolerance has a floor, because Mercury is three pixels wide at this zoom
 * and a target its own size is not a target. Defect #5 was exactly that.
 */
export function nearestMarker(
  markers: readonly { id: string; x: number; y: number; sizePx: number }[],
  x: number,
  y: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const marker of markers) {
    const tolerance = Math.max(marker.sizePx / 2 + 6, 16);
    const distance = Math.hypot(marker.x - x, marker.y - y);
    if (distance <= tolerance && distance < bestDistance) {
      best = marker.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** What the caption offers to do about this body. */
export type FocusAction =
  | { kind: 'visit'; label: string }
  | { kind: 'none'; reason: string };

export interface BodyCaption {
  /** The small letterspaced line above the name. */
  eyebrow: string;
  name: string;
  action: FocusAction;
}

/** Kilometres, grouped, because six digits unseparated is not a number a reader reads. */
function km(value: number): string {
  return `${Math.round(value).toLocaleString('en-GB')} km`;
}

/**
 * The caption for one body.
 *
 * **Every line is a fact this repository already holds.** The eyebrow is the
 * body's kind and its size, and the distance when there is one to give; the
 * action is a visit when there is a surface to stand on and the body's own
 * recorded reason when there is not. Nothing here is written to fill the shape
 * - a caption that padded itself out would be the thing the whole project
 * refuses, one page along.
 */
export function captionFor(body: Body, distanceAu: number | null): BodyCaption {
  const parts: string[] = [];

  if (body.id === 'sun') parts.push('The star');
  else if (body.kind === 'moon') parts.push("Earth's companion");
  else parts.push('Planet');

  if (distanceAu !== null) {
    parts.push(`${distanceAu.toFixed(2)} AU from the sun`);
  }
  parts.push(`radius ${km(body.radiusKm)}`);

  return {
    eyebrow: parts.join(' · '),
    name: body.name,
    action: isLandable(body)
      ? { kind: 'visit', label: `Visit ${body.name}` }
      : {
          kind: 'none',
          // The body's own sentence, not one invented here. Jupiter has no
          // surface and says so; the Sun has none for a different reason and
          // says that instead.
          reason: body.noSurfaceReason ?? 'No surface to stand on',
        },
  };
}

/** The caption for a body id, or null when nothing is chosen. */
export function captionForId(id: BodyId | null, distanceAu: number | null): BodyCaption | null {
  if (id === null) return null;
  const body = bodyFor(id);
  return body ? captionFor(body, distanceAu) : null;
}

/**
 * Move the camera's target a fraction of the way to a body, in world units.
 *
 * **Not a screen-space correction.** The obvious way to centre something is to
 * pan by how far off centre it looks, and that is what this did first: it flew
 * the camera off into empty sky. Panning by a screen delta is not the inverse
 * of the projection once the camera has any pitch - a vertical screen offset
 * moves the target partly through world *up*, out of the plane the planets are
 * in, so the correction never lands and each frame asks for a bigger one.
 *
 * Interpolating toward the body's own position cannot do that. It is the same
 * space the body is in, the distance shrinks by a fixed proportion every frame,
 * and it converges from anywhere.
 */
export function easeTarget(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  fraction: number,
): [number, number, number] {
  const t = Math.min(1, Math.max(0, fraction));
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

/** Whether the camera is close enough to a body to stop moving toward it. */
export function isCentred(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  epsilon: number,
): boolean {
  return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) < epsilon;
}

/** Spelled out to ten, because a numeral in a line of prose reads as data. */
const WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten',
];

/**
 * What the page is showing, derived from what it drew (D171).
 *
 * **This was a written sentence, and it was wrong half the time.** The masthead
 * said "The sun, eight planets and the Moon" as a constant - true standing on
 * Earth, and false everywhere else, because the Moon is drawn as Earth's
 * *companion* and is simply absent when the camera is anywhere but home. Phone
 * caught it: the page announced a body it was not drawing.
 *
 * Derived from the ids the scene actually rendered, so it cannot say that
 * again. The same inversion D133 made for layer visibility, in a caption: state
 * what is there rather than what is usually there.
 */
export function subjectOf(drawn: readonly string[]): string {
  const has = (id: string) => drawn.includes(id);
  const planets = FOCUS_ORDER.filter(
    (id) => id !== 'sun' && id !== 'moon' && has(id),
  ).length;

  const parts: string[] = [];
  if (has('sun')) parts.push('The sun');
  if (planets > 0) {
    const word = WORDS[planets] ?? String(planets);
    parts.push(`${word} ${planets === 1 ? 'planet' : 'planets'}`);
  }
  if (has('moon')) parts.push('the Moon');

  if (parts.length === 0) return 'Nothing in view';
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  // The sun leads when it is drawn and is capitalised already; without it the
  // line starts on a planet count, and a sentence starting "one planet" reads
  // as a fragment somebody forgot to finish.
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
