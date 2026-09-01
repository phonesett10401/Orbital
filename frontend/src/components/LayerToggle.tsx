/**
 * Switch between data layers.
 *
 * There is exactly one layer, so this control renders a single option. It is
 * driven by the `LAYERS` array rather than hardcoded, which costs nothing and
 * keeps the component honest about what it is: a selector over whatever layers
 * exist (D19).
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
