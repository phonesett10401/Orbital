/**
 * Key to the marker encoding.
 *
 * Altitude is shown by hue, because at globe scale it cannot be shown by
 * height — a cruising airliner is 0.2% of Earth's radius up, well under a
 * pixel. That mapping is invisible without a key: nothing on screen says that
 * amber means low and cyan means cruising, and a viewer will read the colours
 * as decoration rather than data.
 *
 * The legend also declares the two marker shapes, including what a disc means.
 * "Direction unknown" is a real state in the data — roughly one aircraft in a
 * thousand reports no heading — and a viewer who cannot tell it apart from a
 * rendering glitch will assume the latter.
 *
 * Gradient stops mirror `altitudeColor` in globe/markers.ts. They are written
 * out rather than derived so the legend stays a plain, cheap component; a test
 * asserts the two agree.
 */

import { useState } from 'react';

import { altitudeColor } from '../globe/markers';

/** Altitudes marked on the scale, in metres. */
const TICKS = [0, 6000, 12000];

function css(altitude: number | null): string {
  const [r, g, b] = altitudeColor(altitude);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** The gradient, sampled from the same function the shader colours are built from. */
const GRADIENT = [0, 0.25, 0.5, 0.75, 1]
  .map((t) => `${css(t * 12000)} ${t * 100}%`)
  .join(', ');

export function Legend() {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button className="legend legend--collapsed" onClick={() => setOpen(true)}>
        Key
      </button>
    );
  }

  return (
    <aside className="legend" aria-label="Marker key">
      <header className="legend__header">
        <span className="legend__title">Key</span>
        <button
          className="legend__close"
          onClick={() => setOpen(false)}
          aria-label="Hide key"
        >
          −
        </button>
      </header>

      <div className="legend__scale" style={{ background: `linear-gradient(90deg, ${GRADIENT})` }} />
      <div className="legend__ticks">
        {TICKS.map((metres) => (
          <span key={metres}>{metres === 0 ? 'ground' : `${metres / 1000} km`}</span>
        ))}
      </div>

      <ul className="legend__shapes">
        <li>
          <svg viewBox="0 0 24 24" className="legend__glyph" aria-hidden="true">
            {/* The same silhouette the sprite atlas draws, nose up. */}
            <path
              d="M12 3 L13 6 L13.2 11 L21 15 L20.8 16.4 L13.4 15 L13.2 18.4 L16.8 20.2 L16.6 21.4 L12 20.2 L7.4 21.4 L7.2 20.2 L10.8 18.4 L10.6 15 L3.2 16.4 L3 15 L10.8 11 L11 6 Z"
              fill="currentColor"
            />
          </svg>
          <span>Heading known — nose points along the track</span>
        </li>
        <li>
          <svg viewBox="0 0 24 24" className="legend__glyph" aria-hidden="true">
            <circle cx="12" cy="12" r="6" fill="currentColor" />
          </svg>
          <span>Heading unknown</span>
        </li>
        <li>
          <svg viewBox="0 0 24 24" className="legend__glyph legend__glyph--dim" aria-hidden="true">
            <circle cx="12" cy="12" r="6" fill="currentColor" />
          </svg>
          <span>Faded — last reported over 2 minutes ago</span>
        </li>
      </ul>
    </aside>
  );
}
