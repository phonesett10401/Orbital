/**
 * Switch between data layers.
 *
 * Phase 1 has exactly one layer, so this control renders a single option. That
 * is the correct phase 1 artifact, not a placeholder: the component is driven
 * by the `LAYERS` array, and phase 2 adds one entry to that array and nothing
 * else (D19).
 *
 * It is rendered rather than hidden so the mechanism is visible and testable
 * now, instead of being written for the first time under deadline pressure
 * when the second layer arrives.
 */

import { LAYERS, useOrbitalStore } from '../state/store';

export function LayerToggle() {
  const activeLayer = useOrbitalStore((s) => s.activeLayer);
  const setActiveLayer = useOrbitalStore((s) => s.setActiveLayer);

  return (
    <div className="layers" role="group" aria-label="Data layer">
      {LAYERS.map((layer) => (
        <button
          key={layer.id}
          className={`layers__button ${
            layer.id === activeLayer.id ? 'layers__button--active' : ''
          }`}
          aria-pressed={layer.id === activeLayer.id}
          onClick={() => setActiveLayer(layer)}
        >
          {layer.label}
        </button>
      ))}
    </div>
  );
}
