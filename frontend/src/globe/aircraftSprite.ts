/**
 * The marker sprite atlas, drawn procedurally onto a canvas.
 *
 * Two cells side by side in one texture, so the whole marker layer stays a
 * single draw call (D15) while still having two distinct appearances:
 *
 * | cell | index | meaning |
 * |---|---|---|
 * | plan-view airliner silhouette | 0 | heading known — sprite is rotated to it |
 * | solid disc | 1 | **heading unknown** |
 *
 * Generated rather than shipped as a PNG for the same reason the Earth
 * textures are copied rather than committed (D30): no binaries in git, nothing
 * to fetch, and the shape is readable and adjustable in source rather than
 * being an opaque asset.
 *
 * Both shapes are drawn to fit **inside the inscribed circle** of their cell.
 * The fragment shader rotates the texture lookup, and a shape extending into
 * the corners would be clipped as it turned.
 */

import * as THREE from 'three';

/** Pixels per cell. 128 is ample: the sprite is drawn at 5-48 screen pixels. */
const CELL = 128;
const CELLS = 2;
const CENTRE = CELL / 2;

/** Cell index for each appearance. Mirrored by SPRITE_* in markers.ts. */
export const SPRITE_AIRCRAFT = 0;
export const SPRITE_UNKNOWN = 1;

/**
 * Right-hand outline of a plan-view airliner, nose up, in cell pixels.
 *
 * Mirrored across the vertical centreline to produce the full silhouette.
 * Every point stays within ~56 px of centre, inside the 57.6 px inscribed
 * radius, so rotation never clips a wingtip.
 */
const AIRFRAME_RIGHT: ReadonlyArray<readonly [number, number]> = [
  [64, 18], // nose
  [68, 34], // forward fuselage
  [69, 60], // wing leading edge, root
  [112, 82], // wing tip, leading edge
  [111, 89], // wing tip, trailing edge
  [70, 80], // wing trailing edge, root
  [69, 98], // aft fuselage
  [89, 108], // tailplane tip, leading edge
  [88, 114], // tailplane tip, trailing edge
  [67, 106], // tailplane trailing edge, root
  [64, 110], // tail centre
];

function traceAirframe(ctx: CanvasRenderingContext2D, originX: number): void {
  ctx.beginPath();
  AIRFRAME_RIGHT.forEach(([x, y], i) => {
    const px = originX + x;
    if (i === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  });
  // Mirror back up the left-hand side, skipping the shared tail and nose points.
  for (let i = AIRFRAME_RIGHT.length - 2; i >= 1; i -= 1) {
    const [x, y] = AIRFRAME_RIGHT[i];
    ctx.lineTo(originX + (CELL - x), y);
  }
  ctx.closePath();
}

/**
 * Draw the atlas.
 *
 * Shapes are drawn **white**, because the fragment shader multiplies the
 * sampled colour by the altitude colour (D28's mapping is preserved). The dark
 * outline is drawn at a low RGB value rather than in a fixed colour, so it
 * becomes a shaded edge of whatever hue the aircraft ends up — legible against
 * both bright ocean and dark night side without fighting the palette.
 */
function draw(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for the marker atlas');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = 'round';

  // --- cell 0: airliner silhouette ---
  const aircraftX = SPRITE_AIRCRAFT * CELL;
  ctx.save();
  traceAirframe(ctx, aircraftX);
  ctx.strokeStyle = 'rgba(38, 38, 46, 1)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fill();
  ctx.restore();

  // --- cell 1: solid disc, heading unknown ---
  const unknownX = SPRITE_UNKNOWN * CELL;
  ctx.save();
  ctx.beginPath();
  ctx.arc(unknownX + CENTRE, CENTRE, 34, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(38, 38, 46, 1)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fill();
  ctx.restore();
}

/**
 * The airliner silhouette on its own, as a canvas.
 *
 * City mode draws aircraft through MapLibre rather than through the marker
 * layer, and a second hand-drawn aeroplane would be a second thing to keep in
 * agreement with this one. Same outline, same orientation -- nose up, which is
 * what MapLibre's `icon-rotate` expects to mean a heading of zero.
 */
export function createAircraftIconCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for the aircraft icon');

  ctx.lineJoin = 'round';
  traceAirframe(ctx, 0);
  ctx.strokeStyle = 'rgba(38, 38, 46, 1)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fill();
  return canvas;
}

/**
 * Build the sprite atlas texture.
 *
 * Mipmaps are generated because markers are drawn as small as five pixels;
 * without them a 128 px silhouette minified that far shimmers badly as the
 * aircraft moves.
 */
export function createMarkerAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * CELLS;
  canvas.height = CELL;
  draw(canvas);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  // Clamping matters: the shader discards outside the cell, but a wrapped
  // sample at a cell boundary would still bleed the neighbouring shape in.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // three flips textures vertically on upload by default, which is right for
  // image files loaded bottom-up but wrong here: it would put v=0 at the canvas
  // *bottom*, mirroring the atlas and pointing every aircraft backwards. The
  // shader reasons in canvas coordinates, so the flip is turned off (D40).
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/** Number of cells in the atlas, for the shader's UV arithmetic. */
export const ATLAS_CELLS = CELLS;
