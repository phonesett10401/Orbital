/**
 * The ship silhouette, as a canvas MapLibre can register as an SDF icon.
 *
 * A hull in plan view, bow up - which is what `icon-rotate` expects a heading
 * of zero to mean, and the same convention the aircraft nose follows.
 *
 * ## Why it is fat, and why that is not laziness
 *
 * A real hull is long and thin: a 250 m tanker is about ten times longer than
 * it is wide. Drawn at that ratio, at the 8-16 screen pixels a marker actually
 * occupies, a ship is a **one-pixel line** - and one pixel is below the size
 * at which a rotation can be read, so the heading it is carrying would be
 * invisible. Worse, MapLibre renders these as signed distance fields, where
 * the alpha channel is a distance rather than a coverage: thin detail does not
 * merely shrink, it dissolves, and the halo floods the cell (a lesson this
 * project has already paid for once).
 *
 * So the beam is exaggerated to roughly 1:2.5. It is a symbol for a ship, not
 * a scale drawing of one - the same argument the aircraft icon makes, where a
 * wingspan is a size class rather than a measurement.
 *
 * ## Why the stern is square
 *
 * It is the whole of how a reader tells which end is the front at this size.
 * A shape pointed at both ends reads as a lozenge and its rotation carries no
 * information, which would make a heading we went to some trouble to get right
 * (D165: true heading before course, because a ship at anchor has one and not
 * the other) into something nobody can see.
 */

/** Pixels per cell. Matches the aircraft sprite; drawn at 8-40 screen pixels. */
const CELL = 128;
const CENTRE = CELL / 2;

/**
 * The hull outline, bow up, in cell pixels.
 *
 * Traced right-hand side first from the bow, then back up the left, so it
 * closes into one path. Everything stays within 44 px of centre, comfortably
 * inside the 57.6 px inscribed radius, so rotation never clips the stern
 * corners - the mistake that would show as a hull with the back cut off at
 * exactly 45 degrees and nowhere else.
 */
const HULL: ReadonlyArray<readonly [number, number]> = [
  [64, 22], // bow
  [76, 44], // starboard shoulder
  [80, 74], // starboard quarter
  [78, 104], // starboard, at the transom
  [50, 104], // port, at the transom
  [48, 74], // port quarter
  [52, 44], // port shoulder
];

function traceHull(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  HULL.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

/** The hull silhouette, for a vessel whose heading is known. */
export function createShipIconCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for the ship icon');

  ctx.lineJoin = 'round';
  traceHull(ctx);
  // Stroked before filling, exactly as the aircraft icon is: it thickens the
  // shape so the distance field has something to work with, and it is what
  // keeps a hull legible when it is eight pixels tall.
  ctx.strokeStyle = 'rgba(38, 38, 46, 1)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fill();
  return canvas;
}

/**
 * The directionless disc, for a vessel that transmitted no heading.
 *
 * 230 of 916 vessels in one live sample sent neither a true heading nor a
 * usable course (D165), so this is not an edge case - it is a quarter of the
 * layer. Drawing the hull anyway would point every one of them at true north,
 * which is the same false claim the aircraft layer refuses to make (D18, D40).
 *
 * Smaller than the aircraft disc, because there are more of them in a smaller
 * area and a harbour full of 34 px discs is a solid blob.
 */
export function createShipUnknownIconCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for the ship disc');

  ctx.beginPath();
  ctx.arc(CENTRE, CENTRE, 28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fill();
  return canvas;
}

/** Exported for the tests, which check the outline rather than the pixels. */
export const HULL_OUTLINE = HULL;
export const SPRITE_CELL = CELL;
