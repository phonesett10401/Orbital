/**
 * The streaks that play while the camera changes worlds (D155).
 *
 * ## What this is, and what it is careful not to claim
 *
 * `bodyFlight.ts` says, correctly, that Orbital cannot fly you to Mars:
 * MapLibre draws one globe at the origin, and choosing another world makes that
 * world the globe. Nothing here changes that, and nothing here is drawn from
 * ephemerides.
 *
 * **These streaks are an effect over the top, not a sky.** That distinction is
 * the whole of the honesty question. A star field claiming to be the real one
 * while stars flew past would be a fabricated observation - the thing this
 * project refuses everywhere else. A full-screen rush of light that nobody
 * could mistake for a catalogue is a transition, the same kind of statement as
 * a fade. The real sky is `stars.ts`, it is drawn from a real catalogue, and it
 * does not move while this plays.
 *
 * The one thing here that *is* tied to reality is the direction. The camera
 * turns toward the destination's actual position on the way out (D136), so by
 * the apex the vanishing point these streaks radiate from is the real bearing
 * of the world being travelled to.
 *
 * ## The shape of it
 *
 * Each star runs outward from the vanishing point on a fixed bearing, and it
 * **accelerates** - distance grows with the square of its phase - because that
 * is what sells the effect. A field of dots moving outward at a constant rate
 * reads as falling snow; the same field accelerating reads as speed.
 *
 * Intensity peaks at the apex rather than at the midpoint, because the apex is
 * where the world actually changes. The brightest instant is the one with
 * something to hide.
 */

/** One streak's fixed properties. Position comes from the phase. */
export interface WarpStar {
  /** Bearing from the vanishing point, radians. */
  angle: number;
  /** Where in its run this star starts, 0-1, so they do not move as a block. */
  seed: number;
  /** 0-1, so the field has depth rather than being one flat brightness. */
  brightness: number;
}

/** A streak in the frame the caller draws in: a unit disc about the origin. */
export interface Streak {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  alpha: number;
}

/** How many times a star crosses the field over the whole trip. */
export const RUNS_PER_TRIP = 2.6;

/** Tail length as a fraction of the distance travelled from the centre. */
export const TAIL = 0.55;

/** Nothing is drawn nearer the vanishing point than this. */
export const INNER = 0.04;

/**
 * A deterministic field.
 *
 * Deterministic because a test cannot assert anything about a random one, and
 * because a field that differs between two runs of the same trip is a field
 * nobody can debug from a screenshot. The generator is a plain LCG rather than
 * `Math.random` for the same reason.
 */
export function makeField(count: number, seed = 1): WarpStar[] {
  let state = seed >>> 0 || 1;
  const next = () => {
    // Numerical Recipes' LCG. Not for cryptography and not pretending to be.
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const stars: WarpStar[] = [];
  for (let i = 0; i < count; i += 1) {
    stars.push({
      angle: next() * Math.PI * 2,
      seed: next(),
      // Squared, so most stars are faint and a few are bright - a uniform
      // field looks like a screen of identical dots, which is what it is.
      brightness: 0.25 + 0.75 * next() * next(),
    });
  }
  return stars;
}

/**
 * How hard the effect is running, 0 to 1.
 *
 * Zero at both ends, so it begins and finishes on the map rather than snapping
 * on. The peak sits at `apex` - the instant the world is swapped - rather than
 * at the midpoint: the loudest moment should be the one with something to
 * cover, and putting it anywhere else leaves the swap visible in a quiet frame.
 */
export function intensity(progress: number, apex: number): number {
  const t = Math.min(1, Math.max(0, progress));
  const a = Math.min(0.99, Math.max(0.01, apex));
  // Two half-cosines meeting at the apex, so both ends reach exactly zero and
  // the join is smooth whatever the apex is.
  const half = t <= a ? t / a : (1 - t) / (1 - a);
  return (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, half)))) / 2;
}

/**
 * Where a star is along its run, 0 at the centre and 1 at the edge.
 *
 * Squared, which is the acceleration: a star covers the last quarter of the
 * field in far less time than the first. That is the difference between speed
 * and snowfall.
 */
export function distanceAt(star: WarpStar, progress: number): number {
  const phase = (star.seed + progress * RUNS_PER_TRIP) % 1;
  return phase * phase;
}

/**
 * One streak, in a unit disc about the vanishing point.
 *
 * The caller scales it to the screen, which keeps this function free of pixels
 * and therefore testable.
 */
export function streakFor(star: WarpStar, progress: number, apex: number): Streak {
  const power = intensity(progress, apex);
  const far = INNER + distanceAt(star, progress) * (1 - INNER);
  const near = Math.max(INNER, far - TAIL * far * power);
  const cos = Math.cos(star.angle);
  const sin = Math.sin(star.angle);
  return {
    x1: cos * near,
    y1: sin * near,
    x2: cos * far,
    y2: sin * far,
    alpha: star.brightness * power,
  };
}

/**
 * The subset of a 2D context this draws with.
 *
 * Narrow on purpose: it makes the draw testable with a recorder in a test
 * environment that has no canvas at all, which is the only way to check the
 * effect actually emits anything. The alternative was watching it, and the
 * preview pane this was built in throttles `requestAnimationFrame` hard enough
 * that a three-second animation can pass in two frames - so watching proves
 * nothing either way.
 */
export interface StrokeContext {
  lineCap: string;
  lineWidth: number;
  // As wide as the real context's, so a `CanvasRenderingContext2D` satisfies
  // this without a cast. Narrowing it to `string` would be more honest about
  // what is assigned and would make the one caller need an `as`, which is a
  // worse trade: a cast at the boundary is where a type stops being checked.
  strokeStyle: string | CanvasGradient | CanvasPattern;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** Faint enough that drawing it would cost more than it shows. */
export const MIN_ALPHA = 0.01;

/** The colour of the streaks, as the `r, g, b` of an `rgba()`. */
export const STREAK_RGB = '150, 200, 255';

/**
 * Draw one frame of the field into a context sized `width` x `height`.
 *
 * The vanishing point is the centre, because the camera has been turned to face
 * the destination by the time this matters (D136) - so the centre of the screen
 * *is* the direction of travel.
 */
export function drawStreaks(
  context: StrokeContext,
  field: readonly WarpStar[],
  progress: number,
  apex: number,
  width: number,
  height: number,
): number {
  const cx = width / 2;
  const cy = height / 2;
  // The corner rather than the shorter half-axis, so a streak at the unit edge
  // leaves the screen instead of stopping short of it on a wide window.
  const reach = Math.hypot(cx, cy);
  let drawn = 0;

  context.lineCap = 'round';
  for (const star of field) {
    const s = streakFor(star, progress, apex);
    if (s.alpha < MIN_ALPHA) continue;
    context.strokeStyle = `rgba(${STREAK_RGB}, ${s.alpha.toFixed(3)})`;
    // Thicker further out, which is what gives a flat field depth.
    context.lineWidth = 0.6 + 1.9 * Math.hypot(s.x2, s.y2);
    context.beginPath();
    context.moveTo(cx + s.x1 * reach, cy + s.y1 * reach);
    context.lineTo(cx + s.x2 * reach, cy + s.y2 * reach);
    context.stroke();
    drawn += 1;
  }
  return drawn;
}
