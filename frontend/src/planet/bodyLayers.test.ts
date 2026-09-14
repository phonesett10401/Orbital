/**
 * The body rule and the custom layers, which the style cannot show it (D168).
 *
 * `bodies.test.ts` covers `visibilityFor` against a synthetic style. This file
 * covers the seam that broke instead: the rule is right, and the layer it was
 * right about never reached it.
 */

import { describe, expect, it } from 'vitest';

import { BODIES, bodyFor, canEnter } from '../bodies';
import {
  IMAGERY_FAR,
  IMAGERY_NEAR,
  LAYER_HOME_BODY,
  imageryVisibility,
  sameImagery,
  surfaceTilesFor,
  visibilityFor,
} from './bodySurface';
import { CUSTOM_LAYER_IDS } from './customLayers';
import { moonLeaderLayer, moonSatelliteLayers } from './moonLayer';
import { MOON_SHELL_LAYER } from './moonShellLayer';

/**
 * The style as the app actually builds it, from the real layer factories.
 *
 * Written out by hand in `bodies.test.ts`, which is fine for testing the rule
 * and useless for testing coverage of it: a hand-written style contains what
 * the author remembered, which is the same failure mode as the hand-written
 * list of custom layers.
 */
const style = {
  layers: [
    { id: 'water', type: 'fill', source: 'openmaptiles' },
    ...moonSatelliteLayers().map((l) => ({ id: l.id, type: l.type })),
    { id: moonLeaderLayer().id, type: moonLeaderLayer().type },
  ],
};

describe('the layers that belong to another world', () => {
  it('reaches every layer the exception table names', () => {
    // The defect. An entry in `LAYER_HOME_BODY` that the plan never mentions is
    // not a rule, it is a comment: nothing writes the layer's visibility, so it
    // keeps whatever it had. `orbital-moon-shell` was such an entry, and three
    // lunar spacecraft were drawn in orbit around Mars because of it.
    const plan = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYER_IDS);
    for (const id of Object.keys(LAYER_HOME_BODY)) {
      expect(plan[id], `${id} is named in LAYER_HOME_BODY but never planned`).toBeDefined();
    }
  });

  it('takes the lunar spacecraft off every other world', () => {
    // The symptom, stated directly. The flat markers were always hidden here -
    // they are in the style - so the fault showed as the tethers and the craft
    // themselves, with their labels gone: yellow dots over Mars, unexplained.
    const onMars = visibilityFor(bodyFor('mars'), style, CUSTOM_LAYER_IDS);
    const onEarth = visibilityFor(bodyFor('earth'), style, CUSTOM_LAYER_IDS);
    expect(onMars[MOON_SHELL_LAYER]).toBe('none');
    expect(onEarth[MOON_SHELL_LAYER]).toBe('none');
    expect(visibilityFor(bodyFor('moon'), style, CUSTOM_LAYER_IDS)[MOON_SHELL_LAYER]).toBe(
      'visible',
    );
  });

  it('keeps the Moon whole: the shell goes with its markers, not apart', () => {
    // The three MapLibre layers and the 3D shell draw one thing between them -
    // a sub-point, a name, a tether and the craft. Any body where some are on
    // and some are off is drawing a spacecraft in pieces, which is how this
    // shipped: the shell alone, on the wrong planet.
    for (const body of ['earth', 'moon', 'mars'] as const) {
      const plan = visibilityFor(bodyFor(body), style, CUSTOM_LAYER_IDS);
      const lunar = Object.keys(LAYER_HOME_BODY).map((id) => plan[id]);
      expect(new Set(lunar).size, `${body} draws the lunar craft in pieces`).toBe(1);
    }
  });
});

describe('the two imagery tiers', () => {
  it('keeps the near tier off every world but Earth', () => {
    // It is pointed at Earth's Esri tiles and always will be, so leaving it on
    // does not waste a layer, it draws Brazil over Mars.
    expect(imageryVisibility('earth', true)[IMAGERY_NEAR]).toBe('visible');
    for (const id of ['mars', 'venus', 'mercury', 'moon']) {
      expect(imageryVisibility(id, true)[IMAGERY_NEAR], id).toBe('none');
      expect(imageryVisibility(id, true)[IMAGERY_FAR], id).toBe('visible');
    }
  });

  it('takes both tiers down when the reader has not chosen imagery', () => {
    // MapLibre fetches a layer's tiles whether or not its paint draws them, so
    // this is bandwidth as well as correctness.
    expect(imageryVisibility('earth', false)).toEqual({
      [IMAGERY_FAR]: 'none',
      [IMAGERY_NEAR]: 'none',
    });
  });

  it('agrees with the body plan, which is the disagreement that caused D182', () => {
    // The bug was two rules for one question. This asserts there is one: the
    // plan a body swap applies and the plan the basemap toggle applies have to
    // say the same thing about the same two layers.
    const style = { layers: [] };
    for (const id of ['earth', 'mars', 'venus'] as const) {
      const plan = visibilityFor(bodyFor(id), style, CUSTOM_LAYER_IDS);
      const toggle = imageryVisibility(id, true);
      expect(plan[IMAGERY_FAR], id).toBe(toggle[IMAGERY_FAR]);
      expect(plan[IMAGERY_NEAR], id).toBe(toggle[IMAGERY_NEAR]);
    }
  });
});

describe('one world, one source', () => {
  it('gives every enterable world its own tiles', () => {
    // Neptune was drawn with Uranus's plate because the swap compared the
    // credit, both are Voyager 2, and the strings matched (D193). This asserts
    // the thing the swap now compares: no two worlds share a tile url.
    const seen = new Map<string, string>();
    for (const body of BODIES.filter(canEnter)) {
      const tiles = surfaceTilesFor(body);
      if (tiles === null) continue; // Earth, whose tiles are configuration.
      expect(seen.has(tiles), `${body.id} shares tiles with ${seen.get(tiles)}`).toBe(false);
      seen.set(tiles, body.id);
    }
  });

  it('knows two worlds apart even when they credit the same mission', () => {
    // The exact pair that broke it.
    expect(bodyFor('uranus').surface?.attribution).toBe(bodyFor('neptune').surface?.attribution);
    expect(sameImagery(bodyFor('uranus'), bodyFor('neptune'))).toBe(false);
    expect(sameImagery(bodyFor('uranus'), bodyFor('uranus'))).toBe(true);
  });
});
