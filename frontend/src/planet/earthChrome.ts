/**
 * Which of the reader's settings still mean something on this world (D169).
 *
 * Two of the map's controls are Earth's and were offered everywhere:
 *
 * - **The basemap cycle.** Two of its three modes *are* Earth's vector
 *   cartography, which describes nowhere else and is switched off the moment
 *   the camera leaves. Pressing the button on the Moon replaced the lunar
 *   mosaic with a blank grey disc - the basemap's `background` layer, and
 *   nothing else - and pressing it again got a darker blank disc.
 * - **The night toggle.** Night here is Earth's terminator drawn over a texture
 *   of Earth's *city lights*. Pressing it over Mars put the lights of southeast
 *   Asia and the Australian coast across the Martian surface, which is D120's
 *   fault exactly: a layer drawn where its subject does not exist.
 *
 * Both had the same cause. Each setting was one variable doing double duty as
 * the reader's preference and as the state of the screen, so the only way to
 * override it for a world was to overwrite what the reader had asked for. The
 * night toggle did not even try; the basemap was overwritten by accident, by
 * `applyBody` making the far imagery visible whatever mode was chosen.
 *
 * Here the two are separate: the reader's settings go in, and what the screen
 * should show comes out. Nothing is stored, so returning to Earth restores
 * exactly what was set - which is itself a fix, because the old code restored
 * `config.terminator` and a reader who turned night on, went to Mars and came
 * back found it off again.
 *
 * A function rather than four lines inside the frame loop's callback for the
 * reason `visibilityFor` is one: **a rule that exists only inside an imperative
 * callback is a rule nothing can check**, and this project has now twice
 * shipped a body rule that was right and unreachable (D133, D168).
 */

import { BASEMAP_IMAGERY, type BasemapMode } from './basemap';

/** What the reader has asked for, which is not always what can be shown. */
export interface ReaderChrome {
  basemap: BasemapMode;
  night: boolean;
}

/** What the screen should show, given that and the world underneath. */
export interface BodyChrome {
  basemap: BasemapMode;
  night: boolean;
  /**
   * Whether the two controls are offered at all.
   *
   * Hidden rather than disabled off Earth. A control that is present and does
   * nothing is a claim that something should have happened, and the reader is
   * left to work out whether they missed the change or the button is broken.
   */
  controlsAvailable: boolean;
}

export function bodyChromeFor(bodyId: string, reader: ReaderChrome): BodyChrome {
  const onEarth = bodyId === 'earth';
  return {
    // Off Earth the mosaic is the only basemap there is. Not "the default" -
    // the only one: the other two modes are the cartography, and it is gone.
    basemap: onEarth ? reader.basemap : BASEMAP_IMAGERY,
    night: onEarth && reader.night,
    controlsAvailable: onEarth,
  };
}
