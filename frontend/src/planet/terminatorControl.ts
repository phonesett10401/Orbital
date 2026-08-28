/**
 * The button that turns night on and off.
 *
 * A MapLibre `IControl` rather than a element of our own, for one reason that
 * has already cost a session: MapLibre owns this container's layout, and the
 * last thing appended to it by hand collapsed the map to zero height when
 * MapLibre's own stylesheet won the cascade (D55, D62). A control is placed by
 * MapLibre, inherits `.maplibregl-ctrl` styling, and stacks with the
 * attribution and any control added later without anyone arbitrating.
 *
 * The button says what it will do, not what is on: a control whose label is
 * its current state reads as a status line and gets clicked by accident.
 */

import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

export interface TerminatorControl extends IControl {
  /** Reflect state the button did not cause, e.g. the config's start value. */
  setEnabled(enabled: boolean): void;
  /** The button itself, so tests can click it without a live map. */
  readonly button: HTMLButtonElement;
}

export function createTerminatorControl(
  onToggle: (enabled: boolean) => void,
  initial = false,
): TerminatorControl {
  let enabled = initial;

  const container = document.createElement('div');
  container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'orbital-terminator-toggle';
  // A moon, not an icon sheet: one glyph beats a sprite, a fetch and a licence
  // for a single button (the argument the sprite atlas made at length, D30).
  button.textContent = '☾';

  const label = () => {
    button.title = enabled ? 'Hide night' : 'Show night';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('is-on', enabled);
  };
  label();

  button.addEventListener('click', () => {
    enabled = !enabled;
    label();
    onToggle(enabled);
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

    setEnabled(next: boolean) {
      enabled = next;
      label();
    },
  };
}
