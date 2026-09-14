import { describe, expect, it } from 'vitest';

import {
  BODIES,
  EARTH,
  bodyFor,
  canEnter,
  imageryLabel,
  showsEarthLayers,
  standsOnGround,
} from './bodies';
import {
  IMAGERY_NEAR,
  NOT_ABOUT_EARTH,
  cartographyLayerIds,
  homeBodyOf,
  maxZoomFor,
  ownLayerIds,
  surfaceTilesFor,
  visibilityFor,
} from './planet/bodySurface';
import { CUSTOM_LAYER_IDS } from './planet/customLayers';

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
/**
 * The real list, not a copy of it (D169).
 *
 * This was two ids written out by hand - the same two `applyBody` used to pass,
 * and the same two that were still there when the moon shell arrived and was
 * drawn over Mars (D168). A test standing on its own copy of the list under
 * test cannot notice that list going stale.
 */
const CUSTOM_LAYERS = CUSTOM_LAYER_IDS;

describe('which worlds can be entered', () => {
  it('lands where there is a mosaic, reprojecting the ones that need it', () => {
    // Probing changed this answer three times. Trek serves plate carrée -
    // `z0` two tiles wide, one tall - which a MapLibre raster source cannot
    // consume, so for a long time the answer was whatever OpenPlanetaryMap
    // happened to publish in Mercator: Mercury, the Moon and Mars (D120).
    // Venus joins them through `plateCarree.ts`, which turns Trek's grid into
    // Mercator tiles in the browser (D181).
    const enterable = BODIES.filter(canEnter).map((b) => b.id);
    expect(enterable.sort()).toEqual([
      'earth', 'jupiter', 'mars', 'mercury', 'moon', 'neptune', 'saturn',
      'uranus', 'venus',
    ]);
    // Only the Sun is left out, and for the one reason no imagery can fix.
    expect(BODIES.filter((b) => !canEnter(b)).map((b) => b.id)).toEqual(['sun']);
  });

  it('separates going somewhere from standing on it', () => {
    // The whole of D193 in one assertion. A gas giant can be entered and
    // turned, and there is nothing under the cloud: calling that "landable"
    // was the false claim, and the fix was to stop asking one question for
    // two different answers.
    for (const id of ['jupiter', 'saturn', 'uranus', 'neptune'] as const) {
      expect(canEnter(bodyFor(id)), id).toBe(true);
      expect(standsOnGround(bodyFor(id)), id).toBe(false);
      expect(imageryLabel(bodyFor(id)), id).toBe('Cloud tops');
      // And the sentence survives, because it is the thing worth saying.
      expect(bodyFor(id).noSurfaceReason, id).toMatch(/no solid surface/i);
    }
    for (const id of ['mercury', 'venus', 'earth', 'moon', 'mars'] as const) {
      expect(standsOnGround(bodyFor(id)), id).toBe(true);
      expect(imageryLabel(bodyFor(id)), id).toBe('Surface imagery');
    }
    expect(imageryLabel(bodyFor('sun'))).toBe('No imagery');
  });

  it('dates the imagery that is weather rather than terrain', () => {
    // Viking's Mars is the same Mars. Cassini's Jupiter is not the same
    // Jupiter, so the plate has to say it is a moment.
    expect(bodyFor('jupiter').surface?.shows).toBe('cloud');
    expect(bodyFor('jupiter').surface?.epoch).toBeTruthy();
    expect(bodyFor('mars').surface?.shows).toBeUndefined();
  });

  it('lists the planets, the Sun and the Moon, and stops there', () => {
    // Trek's reprojection reaches Ceres, Vesta, Io, Europa, Ganymede, Titan,
    // Enceladus and Phobos too, and they were wired up and taken back out:
    // this is a list of the solar system's planets, not of every world with a
    // mosaic (D192). The assertion is the *count*, because the failure mode is
    // a body creeping back in rather than one going missing.
    expect(BODIES).toHaveLength(10);
  });

  it('reprojects rather than reaching for a Mercator source that does not exist', () => {
    // The distinction is load-bearing: a `pc://` url means the tiles are built
    // in the browser from a grid MapLibre cannot read, and pointing a raster
    // source straight at Trek would silently serve a stretched world.
    expect(bodyFor('venus').surface?.tiles).toMatch(/^pc:\/\//);
    expect(bodyFor('mars').surface?.tiles).toMatch(/^https:\/\//);
  });

  it('gives every world without a surface a stated reason', () => {
    // A disabled row with no cause reads as broken. These are answers.
    for (const body of BODIES.filter((b) => !canEnter(b))) {
      expect(body.noSurfaceReason, body.name).toBeTruthy();
    }
  });

  it('distinguishes a missing mosaic from a missing surface', () => {
    // Venus used to be refused for want of tiles in a projection we could
    // read, which was a gap on our side; Jupiter has no ground at all. Only
    // the first was ever fixable, and both are now fixed as far as they can
    // be: Venus has a surface, Jupiter has cloud and says so.
    expect(canEnter(bodyFor('venus'))).toBe(true);
    expect(bodyFor('venus').noSurfaceReason).toBeUndefined();
    expect(standsOnGround(bodyFor('venus'))).toBe(true);
    expect(bodyFor('jupiter').noSurfaceReason).toMatch(/no solid surface/i);
  });

  it('says the thing a reader would otherwise get wrong', () => {
    // Venus's surface has never been photographed - the cloud is opaque in
    // visible light - and a golden globe with nothing said about it invites
    // exactly that mistake.
    expect(bodyFor('venus').surface?.caveat).toMatch(/radar/i);
    // And imagery with nothing to explain claims nothing.
    expect(bodyFor('mars').surface?.caveat).toBeUndefined();
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

  it('leaves the terminator to the control that knows about the body', () => {
    // The one exemption left, and it is not "this layer is body-agnostic" - it
    // is "somebody else owns this decision". `applyBodyChrome` settles night
    // from the reader's setting *and* the world underneath; a `none` written
    // here would fight it. Night over Mars was a real defect (D169), and the
    // fix belongs there rather than in a second rule.
    const plan = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYERS);
    expect(plan['orbital-terminator']).toBeUndefined();
    expect(NOT_ABOUT_EARTH.has('orbital-terminator')).toBe(true);
  });

  it('switches off the vector cartography, which describes only Earth', () => {
    const plan = visibilityFor(bodyFor('mars'), style);
    for (const id of ['water', 'road', 'place']) expect(plan[id], id).toBe('none');
  });

  it("turns all of it back on for Earth - all of Earth's, that is", () => {
    // Written as "everything with the prefix" until D169, which was true while
    // every such layer was Earth's. The lunar ones are not, and the moment the
    // real custom-layer list was used here instead of a copy of it the moon
    // shell arrived and this said `visible` about a layer that belongs to the
    // Moon. `homeBodyOf` is the rule; the test asks it rather than assuming.
    const plan = visibilityFor(EARTH, style, CUSTOM_LAYERS);
    const earths = ownLayerIds(style, CUSTOM_LAYERS).filter((id) => homeBodyOf(id) === 'earth');
    for (const id of [...earths, 'water', 'road', 'place']) {
      expect(plan[id], id).toBe('visible');
    }
    // And the ones that are not Earth's stay off, so the filter above is not
    // quietly excusing a layer that should have been on.
    for (const id of ownLayerIds(style, CUSTOM_LAYERS).filter((id) => homeBodyOf(id) !== 'earth')) {
      expect(plan[id], id).toBe('none');
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

/*
 * **The handover's tests went with the handover** (D169).
 *
 * Four tests lived here exercising `globeLayerIds`, which gathered everything
 * painting the globe so the solar-system handover could hide it. D164 deleted
 * the handover and the function stayed, called by nothing - so these four went
 * on passing, and the block read as coverage of a rule the app applies. It
 * does not apply it. Both are gone; what the tests knew is written into
 * `bodySurface.ts` where the next rule over a style will be written.
 */
