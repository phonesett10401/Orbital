/**
 * Where the selected aircraft's 3D model goes, in whichever space MapLibre is
 * currently drawing in.
 *
 * This is the arithmetic half of the model layer, kept apart from three.js and
 * from MapLibre so it can be tested without a GL context — the same split the
 * globe used between `earth.ts` and the layers that positioned things on it.
 *
 * ## Two spaces, not one
 *
 * A custom layer under the globe projection is handed *two* matrices each
 * frame and a number saying which one is live (`projectionTransition`):
 *
 * - **Globe**, `mainMatrix`, which projects a **unit sphere**. A vertex is a
 *   direction from the planet's centre, and altitude is a radial scale of
 *   `1 + metres / 6371008.8` — read straight out of MapLibre's own globe
 *   vertex shader, which is the only authority on this that cannot drift.
 * - **Mercator**, `fallbackMatrix`, which projects **mercator units** where
 *   the whole world is 0..1 and Z is conformal with X and Y.
 *
 * The two are not variants of one convention; a matrix used with the wrong one
 * puts the model in the Atlantic. MapLibre blends between them over a zoom or
 * so around z12, where the globe stops being worth the arithmetic. **We pick
 * the dominant one rather than blending** (see `usesGlobeFrame`): blending a
 * mesh means projecting it twice and interpolating in clip space, and the two
 * projections agree closely near the centre of the screen, which is where a
 * selected aircraft nearly always is. The cost is a possible small jump for a
 * selection sitting at the very edge of the viewport during that one zoom step.
 *
 * ## Everything is built as a frame, not as a point
 *
 * A position alone is not enough — the model has to be *oriented* and *scaled*
 * in a space where neither one metre nor "up" is the same in two places. So
 * each function returns a full model matrix: a local tangent frame (east,
 * north, up) at the aircraft, rotated to its heading and scaled from model
 * units to metres, expressed in the projection's own space.
 */

/**
 * The sphere MapLibre's globe shader uses, in metres.
 *
 * Copied from `_projection_globe.vertex.glsl`'s `GLOBE_RADIUS`, which is also
 * `earthRadius` in `lng_lat.ts`. It is a sphere, not the WGS84 ellipsoid, and
 * that is MapLibre's choice rather than ours — the model must sit in the world
 * MapLibre draws, not in a more accurate one.
 */
export const GLOBE_RADIUS_METRES = 6371008.8;

/** MapLibre's equatorial circumference, `2 * pi * GLOBE_RADIUS_METRES`. */
export const EARTH_CIRCUMFERENCE_METRES = 2 * Math.PI * GLOBE_RADIUS_METRES;

const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];
/** A column-major 4x4, the layout both MapLibre and three.js use. */
export type Mat4 = number[];

/**
 * Above which transition value the globe frame is the one to draw in.
 *
 * `projectionTransition` is 0 in pure mercator and 1 in pure globe. Half is
 * the crossover for the same reason a coin toss is: away from the endpoints
 * both projections are visibly correct near the screen centre, so the only
 * thing that matters is that the choice is stable and symmetric.
 */
export function usesGlobeFrame(projectionTransition: number): boolean {
  return projectionTransition > 0.5;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * The unit vector from the planet's centre to a place on its surface.
 *
 * Transcribed from `angularCoordinatesRadiansToVector` in MapLibre's
 * `globe_utils.ts` — Y is the polar axis, Z points at the prime meridian, and
 * X at 90 degrees east. Guessing this convention is how a model ends up
 * plausible and ninety degrees wrong, so it is asserted against the poles and
 * the meridians in the tests.
 */
export function sphereVector(lonDeg: number, latDeg: number): Vec3 {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const ring = Math.cos(lat);
  return [Math.sin(lon) * ring, Math.sin(lat), Math.cos(lon) * ring];
}

/** The tangent frame's axes at a point, in globe space. */
export function globeAxes(lonDeg: number, latDeg: number): { up: Vec3; north: Vec3; east: Vec3 } {
  const up = sphereVector(lonDeg, latDeg);
  // East is the derivative of the surface vector with respect to longitude;
  // north then completes the frame. Both fall out of the sphere convention
  // rather than being posited separately and having to agree with it.
  const lon = lonDeg * DEG;
  const east: Vec3 = [Math.cos(lon), 0, -Math.sin(lon)];
  return { up, north: cross(up, east), east };
}

/**
 * Assemble a model matrix from a tangent frame.
 *
 * `right` is derived as `up x forward` rather than taken as an argument,
 * because that is three.js's own handedness (X = Y cross Z) and deriving it is
 * what keeps the determinant positive in *both* spaces. It matters: mercator's
 * Y axis runs south, so a frame built as (east, north, up) there is mirrored,
 * and a mirrored frame flips triangle winding and inverts every normal — the
 * model would be lit from the inside out. Derived this way the model's +X
 * points west under mercator, which for a symmetric airframe is nothing.
 */
function frameMatrix(up: Vec3, forward: Vec3, scale: number, origin: Vec3): Mat4 {
  const f = normalise(forward);
  const u = normalise(up);
  const right = normalise(cross(u, f));
  // prettier-ignore
  return [
    right[0] * scale, right[1] * scale, right[2] * scale, 0,
    u[0] * scale, u[1] * scale, u[2] * scale, 0,
    f[0] * scale, f[1] * scale, f[2] * scale, 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

/** The compass direction a heading points, in a tangent frame's own axes. */
export function headingVector(north: Vec3, east: Vec3, headingDeg: number): Vec3 {
  const heading = headingDeg * DEG;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return [
    north[0] * c + east[0] * s,
    north[1] * c + east[1] * s,
    north[2] * c + east[2] * s,
  ];
}

/**
 * The model matrix under the globe projection, for `mainMatrix`.
 *
 * `spanMetres` is what one model unit becomes: the geometry is normalised to a
 * wingspan of exactly 1 (`MODEL_SPAN_UNITS`), so this reads as the aircraft's
 * wingspan in metres. `liftMetres` raises it off the surface — see
 * `MODEL_LIFT_SPANS` for why that is a legibility offset and not an altitude.
 */
export function globeModelMatrix(
  lonDeg: number,
  latDeg: number,
  headingDeg: number,
  spanMetres: number,
  liftMetres: number,
): Mat4 {
  const { up, north, east } = globeAxes(lonDeg, latDeg);
  const radius = 1 + liftMetres / GLOBE_RADIUS_METRES;
  return frameMatrix(
    up,
    headingVector(north, east, headingDeg),
    spanMetres / GLOBE_RADIUS_METRES,
    [up[0] * radius, up[1] * radius, up[2] * radius],
  );
}

/** Mercator X, the same 0..1 the whole world occupies. */
export function mercatorX(lonDeg: number): number {
  return (180 + lonDeg) / 360;
}

/** Mercator Y, which runs *south* as it grows. */
export function mercatorY(latDeg: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2))) / 360;
}

/** One metre, in mercator units, at a latitude. */
export function metreInMercatorUnits(latDeg: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_METRES * Math.cos(latDeg * DEG));
}

/**
 * The model matrix under the mercator projection, for `fallbackMatrix`.
 *
 * Isotropic, because MapLibre's custom-layer Z is conformal with X and Y: a
 * box with equal sides in mercator units renders as a cube, so one scale
 * factor serves all three axes and vertical metres need no separate treatment.
 */
export function mercatorModelMatrix(
  lonDeg: number,
  latDeg: number,
  headingDeg: number,
  spanMetres: number,
  liftMetres: number,
): Mat4 {
  const perMetre = metreInMercatorUnits(latDeg);
  const up: Vec3 = [0, 0, 1];
  const east: Vec3 = [1, 0, 0];
  // North is negative Y here: mercator's vertical axis grows southward.
  const north: Vec3 = [0, -1, 0];
  return frameMatrix(up, headingVector(north, east, headingDeg), spanMetres * perMetre, [
    mercatorX(lonDeg),
    mercatorY(latDeg),
    liftMetres * perMetre,
  ]);
}

/**
 * Is a point on the globe's near side?
 *
 * The clipping plane MapLibre hands custom layers is the same one its globe
 * shader uses to discard the far hemisphere, and `globeComputeClippingZ` shows
 * how to read it: the shader writes `z = (1 - (dot + w)) * w_clip`, which is
 * clipped past the far plane exactly when `dot + w` goes negative. Doing the
 * same test here means the model disappears over the horizon on the same pixel
 * the terrain under it does, rather than hanging in space on the far side of
 * the planet, where MapLibre draws nothing to hide it.
 */
export function isOnNearSide(position: Vec3, clippingPlane: readonly number[]): boolean {
  const [a, b, c, d] = clippingPlane;
  return position[0] * a + position[1] * b + position[2] * c + d >= 0;
}

/**
 * Ground metres per screen pixel.
 *
 * Zoom is defined so that the scale at the map's centre matches mercator's
 * scale at the centre's latitude — `getGlobeRadiusPixels` scales the globe by
 * `1 / cos(centre latitude)` for precisely that reason. So one formula serves
 * both spaces, with a different latitude in it: **the aircraft's own latitude
 * under mercator**, where scale varies with latitude across the screen, and
 * **the map centre's under globe**, where the sphere has one scale everywhere
 * and the centre is what sets it.
 */
export function metresPerPixel(zoom: number, latDeg: number): number {
  const worldSizePixels = 512 * 2 ** zoom;
  return (EARTH_CIRCUMFERENCE_METRES * Math.cos(latDeg * DEG)) / worldSizePixels;
}

/**
 * An airliner's wingspan, in metres. A 737 is 35.8 m and an A350 is 64.8; this
 * is one generic airframe (D42), so it is one generic number.
 */
export const REAL_SPAN_METRES = 50;

/**
 * The smallest the model may be drawn, in CSS pixels of wingspan.
 *
 * The globe's model had a floor for the same reason, and this is why it is
 * re-derived rather than inherited: at true scale a 50 m aircraft is *half a
 * pixel* at z9 and invisible at z4, so without a floor the selected aircraft
 * would simply vanish at every zoom traffic is actually watched from. The
 * floor holds it at a readable size until true scale overtakes it, which
 * happens around z16 — from there in, the model is the size the aircraft is.
 */
export const MODEL_MIN_PX = 30;

/** What one model unit is worth in metres, at this zoom and latitude. */
export function modelSpanMetres(zoom: number, latDeg: number): number {
  return Math.max(REAL_SPAN_METRES, MODEL_MIN_PX * metresPerPixel(zoom, latDeg));
}

/**
 * How far above the ground to draw the model, in wingspans.
 *
 * **This is not the aircraft's altitude, and deliberately not it.** Drawing at
 * a literal 10 km puts the model 33,000 pixels above its own ground position
 * at z19 and off the screen entirely, and it would part company with the
 * symbol it replaces, the callsign label and the track — all of which are
 * ground-projected. Altitude is carried by colour here exactly as on the globe
 * (D28, D42). The lift is only enough to keep the airframe clear of the
 * extruded buildings it would otherwise sit inside.
 */
export const MODEL_LIFT_SPANS = 0.6;

/**
 * The sun, expressed in the *model's* own axes.
 *
 * Two things force this rather than a light in world space. First, the model
 * matrix is folded into the projection matrix before it reaches the GPU (see
 * `multiplyMat4`), so the shader's normals are model-space normals and a light
 * has to meet them there. Second, the view matrix is folded in too, so there
 * is no cheap way to name a direction relative to the camera even if we wanted
 * a headlight - and a fixed overhead sun is the better answer anyway. It turns
 * shading into information, since the wings catch it differently as the
 * aircraft turns, where a headlight renders every heading identically. The
 * globe used a headlight because a selection over the night side had to stay
 * visible against real lighting (D42); nothing here is unlit.
 *
 * `mirrored` is the mercator frame. Its Y axis runs south, which makes
 * (east, north, up) left-handed there and right-handed on the globe, so the
 * model's own +X axis ends up pointing the opposite way round the compass in
 * the two spaces. Without the flip the aircraft would be lit on the port side
 * under one projection and the starboard side under the other, and would
 * appear to swap over as the map crossed the transition zoom.
 */
export function sunInModelSpace(headingDeg: number, mirrored: boolean): Vec3 {
  const heading = headingDeg * DEG;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // Up, and over the aircraft's right shoulder: the components are east 0.45,
  // north 0.35, up 0.82 in the tangent frame, resolved onto the model's
  // (right, up, forward) axes.
  const east = 0.45;
  const north = 0.35;
  const up = 0.82;
  const right = mirrored ? east * c - north * s : north * s - east * c;
  return normalise([right, up, east * s + north * c]);
}

/**
 * Multiply two column-major 4x4 matrices, `a * b`, in double precision.
 *
 * **This exists for precision, not for convenience.** three.js uploads
 * matrices to the GPU as float32. In globe space the aircraft sits at
 * magnitude 1 from the planet's centre while its wingtip is 3.9e-6 from its
 * own centre, and one float32 step at magnitude 1 is **0.36 m** - so a mesh
 * transformed by a float32 model matrix lands on a lattice a hundred and forty
 * times coarser than the aircraft is long, and crawls between lattice points
 * as it moves. MapLibre hands custom layers full-precision float64 matrices
 * for exactly this reason and says so. Composing here, in doubles, and
 * uploading one product moves the small quantity into clip space, where it is
 * no longer small next to what it is added to. Measured in `model.test.ts`.
 */
export function multiplyMat4(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}
