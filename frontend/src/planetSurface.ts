/**
 * What each planet looks like, from the structure it actually has.
 *
 * These bodies draw between about 8 and 90 pixels across depending on zoom, and
 * a flat disc of one colour is the thing that most makes the scene look like a
 * diagram rather than a solar system. What fixes that is not detail - at 20
 * pixels there is nowhere to put detail - it is **banding**, because banding is
 * the first thing the eye reads on a planet and the last thing it forgets.
 *
 * ## Why this is generated rather than downloaded
 *
 * Photographic maps exist and are mostly free, and they were still the wrong
 * answer here: several megabytes of binary per body, a licence to carry, and a
 * network fetch, in exchange for detail that is invisible at this size. What is
 * *visible* at this size is which latitudes are dark and which are light - and
 * that is a short table of published numbers, which can be measured, tested and
 * generated for nothing (D132).
 *
 * ## The latitudes are real
 *
 * Jupiter's belts and zones carry the standard nomenclature and the standard
 * latitudes: the North Equatorial Belt runs roughly 7 to 17 degrees north, the
 * South Equatorial Belt from 7 to 21 south, and the bright Equatorial Zone sits
 * between them. Mars gets its polar caps. Venus gets almost nothing, because
 * Venus *is* almost nothing to look at - unbroken cloud - and inventing
 * features for it would be the one dishonest thing in the file.
 *
 * Longitude is not attempted. The Great Red Spot is real and is 2 pixels wide
 * here; Syrtis Major would need a map. The bands are what survives the scale.
 */

export interface SurfaceBand {
  /** Southern edge, in degrees of latitude. */
  from: number;
  /** Northern edge, in degrees of latitude. */
  to: number;
  colour: [number, number, number];
}

/**
 * Bands from south to north, covering the whole sphere with no gaps.
 *
 * The no-gaps property is structural rather than decorative: a gap would sample
 * as black and draw as a dark stripe at a latitude nothing is happening at.
 */
export const SURFACES: Record<string, SurfaceBand[]> = {
  // Belts dark, zones light, poles dusky - the standard nomenclature.
  jupiter: [
    { from: -90, to: -48, colour: [160, 139, 120] }, // south polar region
    { from: -48, to: -35, colour: [184, 134, 92] }, // SSTB
    { from: -35, to: -26.5, colour: [169, 119, 72] }, // STB
    { from: -26.5, to: -21, colour: [232, 213, 180] }, // South Tropical Zone
    { from: -21, to: -7, colour: [160, 106, 66] }, // SEB
    { from: -7, to: 7, colour: [239, 224, 192] }, // Equatorial Zone
    { from: 7, to: 17, colour: [150, 96, 58] }, // NEB - the darkest
    { from: 17, to: 24, colour: [232, 213, 180] }, // North Tropical Zone
    { from: 24, to: 31, colour: [171, 122, 78] }, // NTB
    { from: 31, to: 48, colour: [220, 199, 166] },
    { from: 48, to: 90, colour: [160, 139, 120] }, // north polar region
  ],
  // The same structure, far fainter and yellower - which is what Saturn is.
  saturn: [
    { from: -90, to: -55, colour: [194, 171, 128] },
    { from: -55, to: -25, colour: [221, 199, 154] },
    { from: -25, to: -8, colour: [236, 217, 171] },
    { from: -8, to: 8, colour: [240, 224, 184] },
    { from: 8, to: 25, colour: [236, 217, 171] },
    { from: 25, to: 55, colour: [221, 199, 154] },
    { from: 55, to: 90, colour: [194, 171, 128] },
  ],
  // Rust, with the polar caps that are the only thing visible from far away.
  mars: [
    { from: -90, to: -83, colour: [238, 242, 245] }, // south cap
    { from: -83, to: -40, colour: [180, 100, 60] },
    { from: -40, to: -10, colour: [194, 112, 63] },
    { from: -10, to: 20, colour: [205, 122, 69] },
    { from: 20, to: 72, colour: [185, 106, 60] },
    { from: 72, to: 82, colour: [208, 164, 135] }, // the cap's hazy edge
    { from: 82, to: 90, colour: [238, 242, 245] }, // north cap
  ],
  // Ocean, with ice at both ends. Latitude alone cannot draw continents, so it
  // does not try - what it can say truthfully is that Earth is mostly water and
  // white at the poles, which at this size is what Earth looks like (D139).
  earth: [
    { from: -90, to: -72, colour: [232, 238, 242] }, // Antarctica
    { from: -72, to: -55, colour: [124, 156, 176] }, // the Southern Ocean
    { from: -55, to: -12, colour: [46, 106, 152] },
    { from: -12, to: 18, colour: [56, 122, 168] },
    { from: 18, to: 55, colour: [64, 116, 148] },
    { from: 55, to: 72, colour: [124, 156, 176] },
    { from: 72, to: 90, colour: [226, 234, 240] }, // the Arctic ice
  ],
  mercury: [
    { from: -90, to: -45, colour: [139, 129, 119] },
    { from: -45, to: 45, colour: [162, 149, 138] },
    { from: 45, to: 90, colour: [139, 129, 119] },
  ],
  // Unbroken cloud. The faint limb darkening is the only honest variation.
  venus: [
    { from: -90, to: -50, colour: [220, 187, 122] },
    { from: -50, to: 50, colour: [236, 209, 150] },
    { from: 50, to: 90, colour: [220, 187, 122] },
  ],
  uranus: [
    { from: -90, to: -60, colour: [169, 221, 227] },
    { from: -60, to: 60, colour: [159, 216, 224] },
    { from: 60, to: 90, colour: [182, 228, 233] },
  ],
  neptune: [
    { from: -90, to: -45, colour: [95, 131, 204] },
    { from: -45, to: -15, colour: [107, 143, 214] },
    { from: -15, to: 15, colour: [123, 157, 224] },
    { from: 15, to: 45, colour: [107, 143, 214] },
    { from: 45, to: 90, colour: [95, 131, 204] },
  ],
};

/** Used for anything with no table, so an unknown body is plain, not black. */
export const DEFAULT_COLOUR: [number, number, number] = [170, 170, 170];

/** The colour at a latitude, in degrees, as red, green and blue in 0..255. */
export function surfaceColour(id: string, latDeg: number): [number, number, number] {
  const bands = SURFACES[id];
  if (!bands) return DEFAULT_COLOUR;
  for (const band of bands) {
    if (latDeg >= band.from && latDeg <= band.to) return band.colour;
  }
  return DEFAULT_COLOUR;
}

/**
 * The body as an equirectangular strip, one pixel wide.
 *
 * One pixel wide because the profile has no longitude in it, and a 1 by 256
 * texture is 1 kB rather than the megabytes a photographic map would cost. The
 * sphere's own UVs run from the south pole at row zero to the north pole at the
 * last row, which is the order this fills.
 *
 * Built *from* `surfaceColour`, so what reaches the screen is the function the
 * tests cover.
 */
export function surfaceTexture(id: string, height = 256): Uint8Array {
  const data = new Uint8Array(height * 4);
  for (let i = 0; i < height; i += 1) {
    // Row centres rather than edges, so the poles are not half a row out.
    const lat = -90 + (180 * (i + 0.5)) / height;
    const [r, g, b] = surfaceColour(id, lat);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Whether a body has a profile at all, so the layer can skip building one. */
export function hasSurface(id: string): boolean {
  return id in SURFACES;
}
