/**
 * The button that cycles the three basemaps: photograph, plain, dark.
 *
 * The same shape as the night toggle (D68) and for the same reasons: a
 * MapLibre `IControl` so MapLibre places it and our stylesheet says which rule
 * wins (D55, D62), and a label that says what pressing it will *do* rather
 * than what is currently on — a button labelled with its own state reads as a
 * status line and gets pressed by someone trying to confirm what they see.
 *
 * It is the one control here with an obvious precedent: every map application
 * that offers both puts this switch in a corner, and it always says the name
 * of the thing you are about to get.
 */

import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

import { BASEMAP_MODES, type BasemapMode } from './basemap';

/**
 * What pressing the button gets you, for each mode it is currently in.
 *
 * Keyed by the *current* mode and naming the *next* one, because the label
 * says what the press will do rather than what is on - see the note above. A
 * table rather than a chain of conditionals so that the three glyphs, the
 * three titles and the cycle order cannot drift apart.
 */
export const BASEMAP_NEXT: Record<BasemapMode, { next: BasemapMode; glyph: string; title: string }> =
  {
    imagery: { next: 'flat', glyph: '▦', title: 'Show the plain map' },
    flat: { next: 'dark', glyph: '◐', title: 'Show the dark map' },
    dark: { next: 'imagery', glyph: '◪', title: 'Show satellite imagery' },
  };

export interface BasemapControl extends IControl {
  /** Reflect state the button did not cause, e.g. the config's start value. */
  setMode(mode: BasemapMode): void;
  /** The button itself, so tests can click it without a live map. */
  readonly button: HTMLButtonElement;
}

export function createBasemapControl(
  onToggle: (mode: BasemapMode) => void,
  initialMode: BasemapMode = 'imagery',
): BasemapControl {
  let mode: BasemapMode = BASEMAP_MODES.includes(initialMode) ? initialMode : 'imagery';

  const container = document.createElement('div');
  container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'orbital-basemap-toggle';

  const label = () => {
    // Glyphs rather than words: the control sits next to a moon and has to
    // read at 30 pixels.
    const { glyph, title } = BASEMAP_NEXT[mode];
    button.textContent = glyph;
    button.title = title;
    button.setAttribute('aria-label', title);
    // Three states, so `aria-pressed` no longer describes it - a cycling
    // button is not a toggle, and claiming it is tells a screen reader the
    // wrong thing. The label already says what the press will do.
    button.removeAttribute('aria-pressed');
    button.classList.toggle('is-on', mode !== 'imagery');
  };
  label();

  button.addEventListener('click', () => {
    mode = BASEMAP_NEXT[mode].next;
    label();
    onToggle(mode);
  });

  container.appendChild(button);

  return {
    button,

    onAdd(_map: MapLibreMap) {
      return container;
    },

    onRemove() {
      container.remove();
    },

    setMode(next: BasemapMode) {
      mode = next;
      label();
    },
  };
}
