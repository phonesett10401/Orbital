import { describe, expect, it } from 'vitest';

import { BODIES, EARTH, bodyFor, isLandable, showsEarthLayers } from './bodies';
import {
  EARTH_ONLY_LAYERS,
  IMAGERY_NEAR,
  cartographyLayerIds,
  maxZoomFor,
  surfaceTilesFor,
  visibilityFor,
} from './planet/bodySurface';

const style = {
  layers: [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'openmaptiles' },
    { id: 'road', type: 'line', source: 'openmaptiles' },
    { id: 'place', type: 'symbol', source: 'openmaptiles' },
    { id: 'orbital-imagery-far', type: 'raster', source: 'orbital-imagery-far' },
    { id: 'orbital-imagery-near', type: 'raster', source: 'orbital-imagery-near' },
    { id: 'orbital-aircraft', type: 'symbol', source: 'orbital-aircraft' },
  ],
};

describe('which worlds can be entered', () => {
  it('lands only where there is a Web Mercator mosaic', () => {
    // Probing changed this answer twice. NASA Trek serves Mercury, the Moon
    // and Mars but in equirectangular tiles - `z0` two wide, one tall - which
    // a MapLibre raster source cannot consume. OpenPlanetaryMap serves the
    // same three in Web Mercator (D120).
    const landable = BODIES.filter(isLandable).map((b) => b.id);
    expect(landable.sort()).toEqual(['earth', 'mars', 'mercury', 'moon']);
  });

  it('gives every world without a surface a stated reason', () => {
    // A disabled row with no cause reads as broken. These are answers.
    for (const body of BODIES.filter((b) => !isLandable(b))) {
      expect(body.noSurfaceReason, body.name).toBeTruthy();
    }
  });

  it('distinguishes no data from no ground', () => {
    // Venus has a complete radar map and no Mercator tiles here; Jupiter has
    // nothing to map at all. Collapsing the two would call physics a gap.
    expect(bodyFor('venus').noSurfaceReason).toMatch(/radar|tiles/i);
    expect(bodyFor('jupiter').noSurfaceReason).toMatch(/no solid surface/i);
  });

  it('lists every planet, plus the Sun and the Moon', () => {
    const ids = BODIES.map((b) => b.id);
    for (const planet of [
      'mercury', 'venus', 'earth', 'mars',
      'jupiter', 'saturn', 'uranus', 'neptune',
    ]) {
      expect(ids).toContain(planet);
    }
    expect(ids).toContain('sun');
    expect(ids).toContain('moon');
  });

  it('falls back to Earth for an id it does not know', () => {
    expect(bodyFor('pluto' as never)).toBe(EARTH);
  });

  it('carries real radii, so a later scale decision has something to use', () => {
    expect(bodyFor('earth').radiusKm).toBeCloseTo(6371, 0);
    expect(bodyFor('sun').radiusKm).toBeGreaterThan(bodyFor('jupiter').radiusKm);
    expect(bodyFor('moon').radiusKm).toBeLessThan(bodyFor('mercury').radiusKm);
  });
});

describe('what is drawn when the camera leaves Earth', () => {
  it('switches off everything that is a statement about Earth', () => {
    // Aircraft, satellites, airports, coverage: over Mars these are not stale
    // or empty, they are meaningless. A layer drawn where its subject does not
    // exist is a stronger false claim than one drawn late (D120).
    const plan = visibilityFor(bodyFor('mars'), style);
    for (const id of EARTH_ONLY_LAYERS) expect(plan[id], id).toBe('none');
  });

  it('switches off the vector cartography, which describes only Earth', () => {
    const plan = visibilityFor(bodyFor('mars'), style);
    for (const id of ['water', 'road', 'place']) expect(plan[id], id).toBe('none');
  });

  it('turns all of it back on for Earth', () => {
    const plan = visibilityFor(EARTH, style);
    for (const id of [...EARTH_ONLY_LAYERS, 'water', 'road', 'place']) {
      expect(plan[id], id).toBe('visible');
    }
  });

  it('keeps the near imagery tier for Earth alone', () => {
    // Every other world has one mosaic, so the near tier has nothing to fade
    // into and would only fetch tiles that never draw.
    expect(visibilityFor(EARTH, style)[IMAGERY_NEAR]).toBe('visible');
    expect(visibilityFor(bodyFor('mars'), style)[IMAGERY_NEAR]).toBe('none');
  });

  it('finds cartography by source rather than by a written list', () => {
    // The basemap brings 111 layers and any hand-kept list would be wrong by
    // the next style update.
    expect(cartographyLayerIds(style)).toEqual(['water', 'road', 'place']);
  });

  it('agrees with the layer gate the rest of the app reads', () => {
    expect(showsEarthLayers('earth')).toBe(true);
    expect(showsEarthLayers('mars')).toBe(false);
  });
});

describe('the tiles and how far in the camera may go', () => {
  it('leaves Earth to its own configuration', () => {
    // Earth's two tiers are settings, either overridable by an environment
    // variable. Returning a URL here would silently override that.
    expect(surfaceTilesFor(EARTH)).toBeNull();
  });

  it('hands another world its mosaic', () => {
    expect(surfaceTilesFor(bodyFor('mars'))).toContain('opm-mars');
    expect(surfaceTilesFor(bodyFor('mercury'))).toContain('opm-mercury');
    expect(surfaceTilesFor(bodyFor('moon'))).toContain('opm-moon');
  });

  it('uses the XYZ order these mosaics are served in', () => {
    // The other trap: NASA's GIBS tiles are WMTS row/column - `{z}/{y}/{x}` -
    // and swapping them returns tiles of the wrong place rather than an error.
    // OpenPlanetaryMap is XYZ, so this must not be `{z}/{y}/{x}`.
    for (const id of ['mars', 'mercury', 'moon'] as const) {
      expect(surfaceTilesFor(bodyFor(id))).toContain('/{z}/{x}/{y}');
    }
  });

  it('stops the camera where the mosaic stops', () => {
    // Past its maximum zoom MapLibre overzooms, and a blurred rectangle is
    // presented with exactly the confidence of a sharp one.
    expect(maxZoomFor(bodyFor('mercury'))).toBe(5);
    expect(maxZoomFor(bodyFor('mars'))).toBe(8);
    expect(maxZoomFor(EARTH)).toBeGreaterThan(maxZoomFor(bodyFor('mars')));
  });

  it('credits the mission, not only the tile server', () => {
    // Each mosaic is somebody's spacecraft: MESSENGER, LRO, Viking. Crediting
    // the courier alone would name the wrong party.
    expect(bodyFor('mercury').surface!.attribution).toContain('MESSENGER');
    expect(bodyFor('moon').surface!.attribution).toContain('LRO');
    expect(bodyFor('mars').surface!.attribution).toContain('Viking');
    for (const id of ['mercury', 'moon', 'mars'] as const) {
      expect(bodyFor(id).surface!.attribution).toContain('OpenPlanetaryMap');
    }
  });
});
