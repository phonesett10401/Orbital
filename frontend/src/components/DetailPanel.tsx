/**
 * Details of the selected object.
 *
 * Two honesty requirements shape this panel:
 *
 * 1. **It says how old the data is.** The backend keeps last-known positions
 *    rather than deleting them, so a marker on screen may be minutes old. A
 *    panel that showed a position without its age would imply a live fix.
 * 2. **It explains what "route" means.** The track is the path we have
 *    observed since the aircraft entered our polling window, not a filed
 *    flight plan (D6). Saying so is not a caveat to bury — it is the
 *    difference between a limitation and a bug.
 *
 * `meta` is rendered generically as key/value rows, so a provider can add a
 * field without a frontend change (D4).
 */

import { useEffect, useState } from 'react';

import { useOrbitalStore } from '../state/store';

const MS_PER_SECOND = 1000;

function formatAge(seconds: number): string {
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function formatMetaKey(key: string): string {
  // camelCase from the provider's meta map -> readable label.
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** Compass point, because "287°" alone is hard to picture. */
function compass(heading: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(heading / 22.5) % 16];
}

export function DetailPanel() {
  const selectedId = useOrbitalStore((s) => s.selectedId);
  const detail = useOrbitalStore((s) => s.selectedDetail);
  const select = useOrbitalStore((s) => s.select);

  // Ticks once a second so the age counts up while the panel is open, rather
  // than freezing at whatever it was when the fetch landed.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!selectedId) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), MS_PER_SECOND);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  if (!selectedId) return null;

  if (!detail) {
    return (
      <aside className="panel" aria-live="polite">
        <div className="panel__loading">Loading {selectedId}…</div>
      </aside>
    );
  }

  const ageSec = Math.max(0, (Date.now() - Date.parse(detail.lastSeen)) / MS_PER_SECOND);
  const isStale = ageSec > 120;

  return (
    <aside className="panel" aria-label={`Details for ${detail.label}`}>
      <header className="panel__header">
        <h2 className="panel__title">{detail.label}</h2>
        <button className="panel__close" onClick={() => select(null)} aria-label="Close">
          ×
        </button>
      </header>

      <div className={`panel__age ${isStale ? 'panel__age--stale' : ''}`}>
        Last reported {formatAge(ageSec)}
        {isStale && ' — position shown is the last one we received'}
      </div>

      <dl className="panel__fields">
        <div>
          <dt>Identifier</dt>
          <dd className="mono">{detail.id}</dd>
        </div>
        <div>
          <dt>Altitude</dt>
          <dd>
            {detail.altitude === null
              ? 'Unknown'
              : `${Math.round(detail.altitude).toLocaleString()} m`}
          </dd>
        </div>
        <div>
          <dt>Ground speed</dt>
          <dd>
            {detail.velocity === null
              ? 'Unknown'
              : `${Math.round(detail.velocity)} m/s (${Math.round(detail.velocity * 3.6)} km/h)`}
          </dd>
        </div>
        <div>
          <dt>Heading</dt>
          <dd>
            {detail.heading === null
              ? 'Unknown'
              : `${Math.round(detail.heading)}° ${compass(detail.heading)}`}
          </dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd className="mono">
            {detail.lat.toFixed(3)}, {detail.lon.toFixed(3)}
          </dd>
        </div>
        {Object.entries(detail.meta).map(([key, value]) => (
          <div key={key}>
            <dt>{formatMetaKey(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <section className="panel__route">
        <h3 className="panel__subtitle">Route</h3>
        {detail.track.length < 2 ? (
          <p className="panel__note">
            Not enough observations yet to draw a path. The route builds up as we
            keep seeing this aircraft.
          </p>
        ) : (
          <>
            <p className="panel__note">
              {detail.track.length} observed positions, spanning{' '}
              {formatAge(
                (Date.parse(detail.track[detail.track.length - 1].timestamp) -
                  Date.parse(detail.track[0].timestamp)) /
                  MS_PER_SECOND,
              ).replace(' ago', '')}
              .
            </p>
            <p className="panel__caveat">
              This is the path we have watched, not a filed flight plan. It begins
              when the aircraft entered our polling window, not at takeoff.
            </p>
          </>
        )}
      </section>
    </aside>
  );
}
