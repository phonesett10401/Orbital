/**
 * The button that switches between the photograph and the flat map.
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

export interface BasemapControl extends IControl {
  /** Reflect state the button did not cause, e.g. the config's start value. */
  setFlat(flat: boolean): void;
  /** The button itself, so tests can click it without a live map. */
  readonly button: HTMLButtonElement;
}

export function createBasemapControl(
  onToggle: (flat: boolean) => void,
  initialFlat = false,
): BasemapControl {
  let flat = initialFlat;

  const container = document.createElement('div');
  container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'orbital-basemap-toggle';

  const label = () => {
    // Showing the flat map, so the button offers the photograph, and vice
    // versa. Two glyphs rather than words: the control sits next to a moon and
    // has to read at 30 pixels.
    button.textContent = flat ? '◪' : '▦';
    button.title = flat ? 'Show satellite imagery' : 'Show the plain map';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(flat));
    button.classList.toggle('is-on', flat);
  };
  label();

  button.addEventListener('click', () => {
    flat = !flat;
    label();
    onToggle(flat);
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

    setFlat(next: boolean) {
      flat = next;
      label();
    },
  };
}
