/**
 * Every layer Orbital draws itself, outside the style (D168).
 *
 * MapLibre keeps custom layers out of `map.getStyle()`, so any rule derived
 * from the style cannot see them. `visibilityFor` therefore takes the ids as an
 * argument - and the argument was a list written at the call site, which is the
 * one thing D133 removed for style layers and left standing here.
 *
 * It drifted, exactly as the old list did. `orbital-moon-shell` was added for
 * the lunar spacecraft, given its entry in `LAYER_HOME_BODY`, and never passed
 * in - so the plan had no opinion about it, nothing ever wrote its visibility,
 * and three yellow spacecraft went on orbiting Mars while the status bar said
 * "no live objects here". The exception table had the right rule in it and the
 * rule was unreachable.
 *
 * This is the list, in one place, next to a test that fails if an entry in that
 * table can never be reached. It is still a list - there is no API that will
 * enumerate custom layers for us - but there is now exactly one of it, and
 * something checks it.
 */

import { MODEL_LAYER } from './modelLayer';
import { MOON_SHELL_LAYER } from './moonShellLayer';
import { SHELL_LAYER } from './satelliteShellLayer';
import { TERMINATOR_LAYER } from './terminatorLayer';

/**
 * The custom layers, for the body rule to have an opinion about.
 *
 * The terminator is here even though it is listed in `NOT_ABOUT_EARTH` and so
 * drops straight back out: this list means "every custom layer", and letting
 * the exception table be the only thing that decides is the whole design. A
 * list that quietly omits what it believes to be exempt is a second rule.
 */
export const CUSTOM_LAYER_IDS: readonly string[] = [
  SHELL_LAYER,
  MODEL_LAYER,
  MOON_SHELL_LAYER,
  TERMINATOR_LAYER,
];
