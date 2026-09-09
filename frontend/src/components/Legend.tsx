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

import { altitudeColor } from '../altitudeColor';
import { useOrbitalStore } from '../state/store';
import { chromeFor } from './layerChrome';

function css(altitude: number | null): string {
  const [r, g, b] = altitudeColor(altitude);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** The gradient, sampled from the same function the shader colours are built from. */
const GRADIENT = [0, 0.25, 0.5, 0.75, 1]
  .map((t) => `${css(t * 12000)} ${t * 100}%`)
  .join(', ');

/**
 * Whether this is a screen the key should stay out of the way on.
 *
 * The key is 232 x 191, which on a phone is a quarter of the map covered by
 * something that is read once and then known. It stays open on a pointer -
 * where it costs a corner of a large window and nothing else - and starts as a
 * pill on a touch screen, one tap from the whole thing (D180).
 *
 * `matchMedia` is guarded because jsdom does not implement it, and a legend
 * that throws in a test is worse than a legend that guesses (D30).
 */
function opensCollapsed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse), (max-width: 560px)').matches;
}

export function Legend() {
  // Read once, on the first render. Re-deciding on every resize would fold a
  // key the reader had deliberately opened.
  const [open, setOpen] = useState(() => !opensCollapsed());
  // The key describes the encoding, and the encoding changes with the layer:
  // an altitude ramp reaching 12 km says nothing about objects 35,786 km up.
  const activeLayer = useOrbitalStore((s) => s.activeLayer);
  const chrome = chromeFor(activeLayer.id, []);

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
        <span className="legend__subject">{chrome.scaleTitle}</span>
        <button
          className="legend__close"
          onClick={() => setOpen(false)}
          aria-label="Hide key"
        >
          −
        </button>
      </header>

      {chrome.scale.kind === 'gradient' ? (
        <>
          <div
            className="legend__scale"
            style={{ background: `linear-gradient(90deg, ${GRADIENT})` }}
          />
          <div className="legend__ticks">
            {chrome.scale.ticks.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
        </>
      ) : (
        // Discrete bands rather than a ramp. A continuous scale would put 97%
        // of the catalogue on one colour, and the aircraft ramp saturates
        // three orders of magnitude below orbit (D99).
        <ul className="legend__bands">
          {chrome.scale.bands.map((band) => (
            <li key={band.label}>
              <span className="legend__swatch" style={{ background: band.colour }} />
              <span>{band.label}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="legend__shapes">
        {chrome.shapes.map((shape) => (
          <li key={shape.text}>
            <svg
              viewBox="0 0 24 24"
              className={`legend__glyph ${shape.glyph === 'dot' ? 'legend__glyph--dim' : ''}`}
              aria-hidden="true"
            >
              {shape.glyph === 'aircraft' ? (
                /* The same silhouette the sprite atlas draws, nose up. */
                <path
                  d="M12 3 L13 6 L13.2 11 L21 15 L20.8 16.4 L13.4 15 L13.2 18.4 L16.8 20.2 L16.6 21.4 L12 20.2 L7.4 21.4 L7.2 20.2 L10.8 18.4 L10.6 15 L3.2 16.4 L3 15 L10.8 11 L11 6 Z"
                  fill="currentColor"
                />
              ) : shape.glyph === 'ship' ? (
                /* The same hull `shipSprite` draws, bow up: pointed forward,
                   square at the transom, because the square end is the whole
                   of how a reader tells which way it is facing (D165). */
                <path
                  d="M12 3 L14.4 8 L15.2 14 L14.8 20 L9.2 20 L8.8 14 L9.6 8 Z"
                  fill="currentColor"
                />
              ) : (
                <circle cx="12" cy="12" r={shape.glyph === 'disc' ? 6 : 4} fill="currentColor" />
              )}
            </svg>
            <span>{shape.text}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
