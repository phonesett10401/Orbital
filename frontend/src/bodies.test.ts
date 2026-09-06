import { describe, expect, it } from 'vitest';

import { BODIES, EARTH, bodyFor, isLandable, showsEarthLayers } from './bodies';
import {
  IMAGERY_NEAR,
  globeLayerIds,
  NOT_ABOUT_EARTH,
  cartographyLayerIds,
  maxZoomFor,
  ownLayerIds,
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
    { id: 'orbital-route', type: 'line', source: 'orbital-route' },
    // The four that the old hand-written list forgot, plus the label layer.
    { id: 'orbital-route-casing', type: 'line', source: 'orbital-route' },
    { id: 'orbital-route-gap', type: 'line', source: 'orbital-route' },
    { id: 'orbital-route-leader', type: 'line', source: 'orbital-route' },
    { id: 'orbital-route-leader-casing', type: 'line', source: 'orbital-route' },
    { id: 'orbital-satellites-label', type: 'symbol', source: 'orbital-satellites' },
    { id: 'orbital-origin', type: 'circle', source: 'orbital-route' },
  ],
};

/** The layers MapLibre does not put in `getStyle()`, which the caller supplies. */
const CUSTOM_LAYERS = [
  'orbital-satellite-shell',
  'orbital-aircraft-model',
  'orbital-solar-system',
];

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
    const plan = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYERS);
    for (const id of ownLayerIds(style, CUSTOM_LAYERS)) expect(plan[id], id).toBe('none');
  });

  it('switches off the satellite shell, which is a custom layer', () => {
    // The bug this rule was rewritten for: two thousand Earth satellites were
    // drawn in orbit around Mars. Custom layers are absent from `getStyle()`,
    // so a rule derived from the style alone cannot see them - which is why
    // the caller passes them in and why this test names one (D133).
    const plan = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYERS);
    expect(plan['orbital-satellite-shell']).toBe('none');
    expect(plan['orbital-aircraft-model']).toBe('none');
  });

  it('switches off every part of a route, not just the one named "route"', () => {
    // The old list held `orbital-route` and none of the four layers drawn
    // alongside it, so a selected flight left its casing, its gap and both
    // leader lines over Mars.
    const plan = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYERS);
    for (const id of [
      'orbital-route',
      'orbital-route-casing',
      'orbital-route-gap',
      'orbital-route-leader',
      'orbital-route-leader-casing',
      'orbital-satellites-label',
      'orbital-origin',
    ]) {
      expect(plan[id], id).toBe('none');
    }
  });

  it('hides a layer nobody has written yet, because the rule is derived', () => {
    // The point of the inversion. A layer added tomorrow is off on Mars
    // without anyone remembering to list it; only a body-agnostic one needs a
    // deliberate entry.
    const withNewLayer = {
      layers: [...style.layers, { id: 'orbital-something-new', type: 'circle', source: 'x' }],
    };
    expect(visibilityFor(bodyFor('mars'), withNewLayer)['orbital-something-new']).toBe('none');
  });

  it('draws the lunar spacecraft on the Moon and on no other world', () => {
    // D133 one body along: these are not Earth's and not body-agnostic, so
    // "everything orbital- is Earth's" would have hidden them everywhere,
    // and a plain exception would have drawn them over Mars (D134).
    const withMoon = {
      layers: [
        ...style.layers,
        { id: 'orbital-moon-satellites', type: 'circle', source: 'x' },
        { id: 'orbital-moon-satellites-label', type: 'symbol', source: 'x' },
      ],
    };
    for (const id of ['orbital-moon-satellites', 'orbital-moon-satellites-label']) {
      expect(visibilityFor(bodyFor('moon'), withMoon)[id], `moon ${id}`).toBe('visible');
      expect(visibilityFor(bodyFor('mars'), withMoon)[id], `mars ${id}`).toBe('none');
      expect(visibilityFor(EARTH, withMoon)[id], `earth ${id}`).toBe('none');
    }
  });

  it('still hides Earth layers on the Moon', () => {
    // The Moon getting layers of its own must not make it a second Earth.
    const plan = visibilityFor(bodyFor('moon'), style, CUSTOM_LAYERS);
    expect(plan['orbital-aircraft']).toBe('none');
    expect(plan['orbital-satellite-shell']).toBe('none');
  });

  it('keeps the solar system on, because it is how you see where you went', () => {
    const plan = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYERS);
    expect(plan['orbital-solar-system']).toBeUndefined();
    expect(NOT_ABOUT_EARTH.has('orbital-solar-system')).toBe(true);
  });

  it('switches off the vector cartography, which describes only Earth', () => {
    const plan = visibilityFor(bodyFor('mars'), style);
    for (const id of ['water', 'road', 'place']) expect(plan[id], id).toBe('none');
  });

  it('turns all of it back on for Earth', () => {
    const plan = visibilityFor(EARTH, style, CUSTOM_LAYERS);
    for (const id of [...ownLayerIds(style, CUSTOM_LAYERS), 'water', 'road', 'place']) {
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

describe('handing the view over to the solar system', () => {
  it('hides everything that paints the globe', () => {
    const ids = globeLayerIds(style, CUSTOM_LAYERS);
    for (const id of ['orbital-imagery-far', 'orbital-imagery-near', 'water', 'road']) {
      expect(ids, id).toContain(id);
    }
  });

  it('includes the aircraft, which are what the globe looked like', () => {
    // Two thousand icons at that zoom cluster into a speckled disc the size of
    // the globe. Leaving them on leaves something that reads as a full-size
    // planet however thoroughly the ground beneath it is switched off (D139).
    expect(globeLayerIds(style, CUSTOM_LAYERS)).toContain('orbital-aircraft');
    expect(globeLayerIds(style, CUSTOM_LAYERS)).toContain('orbital-satellite-shell');
  });

  it('hides the background, which belongs to neither category', () => {
    // Found by painting it red at solar zoom and watching the leftover disc
    // turn red. It has no source, so the cartography rule missed it, and no
    // `orbital-` prefix, so Orbital's own rule missed it too (D143).
    expect(globeLayerIds(style, CUSTOM_LAYERS)).toContain('background');
  });

  it('never hides the solar system, which is what the view hands over to', () => {
    expect(globeLayerIds(style, CUSTOM_LAYERS)).not.toContain('orbital-solar-system');
  });
});
