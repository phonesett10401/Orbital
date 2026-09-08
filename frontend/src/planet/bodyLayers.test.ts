/**
 * The body rule and the custom layers, which the style cannot show it (D168).
 *
 * `bodies.test.ts` covers `visibilityFor` against a synthetic style. This file
 * covers the seam that broke instead: the rule is right, and the layer it was
 * right about never reached it.
 */

import { describe, expect, it } from 'vitest';

import { bodyFor } from '../bodies';
import { LAYER_HOME_BODY, visibilityFor } from './bodySurface';
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
