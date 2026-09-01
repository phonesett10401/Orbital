/**
 * Colour by altitude: low is warm, cruising is cool.
 *
 * Aircraft altitude cannot be shown by height — a cruising airliner is 0.2% of
 * Earth's radius up, well under a pixel at any zoom that shows a country. So it
 * is shown by hue instead (D28), and the key says so, because nothing on screen
 * would otherwise tell a viewer that amber means low and cyan means cruising.
 *
 * Unknown altitude gets its own neutral grey rather than falling into the
 * low-altitude band: `null` means unknown and must not read as "on the ground".
 *
 * **Shared, and it has to be.** Three things draw from this ramp — the map's
 * symbols, the selected aircraft's 3D model, and the key — and two copies of a
 * colour scale drift apart, at which point the key is lying about the picture.
 * It lived in the globe renderer until that renderer was deleted (D104); the
 * ramp was never a property of either renderer.
 *
 * Satellites deliberately do **not** use this. Their altitudes are three orders
 * of magnitude past the top of this scale, where it saturates and renders the
 * whole catalogue one shade of cyan — they use orbit-regime bands instead
 * (`satelliteShell.ts`, D99).
 */

/** Where the ramp tops out, in metres. Above this everything is the same cyan. */
export const ALTITUDE_CEILING_M = 12_000;

/** Neutral grey for an unknown altitude. Not a point on the ramp, on purpose. */
export const UNKNOWN_ALTITUDE_COLOR: [number, number, number] = [0.62, 0.62, 0.68];

export function altitudeColor(altitude: number | null): [number, number, number] {
  if (altitude === null) return UNKNOWN_ALTITUDE_COLOR;

  const t = Math.min(1, Math.max(0, altitude / ALTITUDE_CEILING_M));
  // amber (low) -> yellow-green -> cyan (high)
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [1.0, 0.55, 0.2]],
    [0.5, [0.95, 0.9, 0.35]],
    [1.0, [0.35, 0.85, 1.0]],
  ];

  for (let i = 0; i < stops.length - 1; i += 1) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const local = (t - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * local,
        c0[1] + (c1[1] - c0[1]) * local,
        c0[2] + (c1[2] - c0[2]) * local,
      ];
    }
  }
  return stops[stops.length - 1][1];
}
