/**
 * The button that opens the view options, and the class it toggles.
 *
 * Two controls sat permanently in the top-right corner of the map: the basemap
 * cycle and the night toggle. Both are useful and neither is used often, and on
 * a phone they were two thirds of the chrome down the right-hand edge, over the
 * thing being looked at (D188).
 *
 * So they go behind one button. The same shape as the two it gathers - a
 * MapLibre `IControl`, so MapLibre places it and our stylesheet decides which
 * rule wins (D55, D62) - and it owns exactly one piece of state: whether the
 * others are showing.
 *
 * **It toggles a class rather than moving anything.** The two controls stay
 * where MapLibre put them, in the order MapLibre put them, and the stylesheet
 * decides whether that group is a stack of buttons or a panel. Nothing here
 * knows what those buttons do, which is why adding a third one later needs no
 * change to this file.
 */

import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

/** Set on the map container while the options are showing. */
export const VIEW_OPEN_CLASS = 'is-view-open';

export interface ViewMenuControl extends IControl {
  /** Close the menu without pressing the button - e.g. on leaving a world. */
  close(): void;
}

export function createViewMenuControl(): ViewMenuControl {
  let container: HTMLDivElement | null = null;
  let button: HTMLButtonElement | null = null;
  let mapContainer: HTMLElement | null = null;
  let open = false;

  const render = () => {
    if (!button || !mapContainer) return;
    mapContainer.classList.toggle(VIEW_OPEN_CLASS, open);
    button.setAttribute('aria-expanded', String(open));
    // The label says what pressing it will do, like the two it gathers: a
    // button labelled with its own state reads as a status line.
    button.title = open ? 'Hide view options' : 'View options';
    button.setAttribute('aria-label', button.title);
  };

  return {
    onAdd(map: MapLibreMap) {
      mapContainer = map.getContainer();
      container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group orbital-view-menu';

      button = document.createElement('button');
      button.type = 'button';
      button.className = 'orbital-view-toggle';
      // A pair of sliders: the conventional glyph for "how this is drawn", and
      // distinct from both glyphs it hides.
      button.textContent = '⛭';
      button.addEventListener('click', () => {
        open = !open;
        render();
      });

      container.appendChild(button);
      render();
      return container;
    },

    onRemove() {
      mapContainer?.classList.remove(VIEW_OPEN_CLASS);
      container?.remove();
      container = null;
      button = null;
      mapContainer = null;
    },

    close() {
      if (!open) return;
      open = false;
      render();
    },
  };
}
