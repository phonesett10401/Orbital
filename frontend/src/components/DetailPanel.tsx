/**
 * Details of the selected object.
 *
 * Three honesty requirements shape this panel:
 *
 * 1. **It says how old the data is.** The backend keeps last-known positions
 *    rather than deleting them, so a marker on screen may be minutes old. A
 *    panel that showed a position without its age would imply a live fix.
 * 2. **It explains what "route" means.** The track is the path we have
 *    observed since the aircraft entered our polling window, not a filed
 *    flight plan (D6). Saying so is not a caveat to bury — it is the
 *    difference between a limitation and a bug.
 * 3. **It marks the airline as decoded.** The airline is not reported by
 *    anything; it is read off the first three letters of the callsign (D46).
 *    Shown without that note it would look like a field the aircraft
 *    transmitted, which is precisely what it is not.
 *
 * `meta` is rendered generically as key/value rows, so a provider can add a
 * field without a frontend change (D4).
 */

import { useEffect, useState } from 'react';
import { STALE_AFTER_SECONDS } from '../globe/interpolate';

import { useAirline } from '../airlines';
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

  // Loads the designator table on the first selection of the session, and
  // never at all if nobody clicks an aircraft.
  const airline = useAirline(detail?.label, selectedId);

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
  // The same threshold the marker fades at and stops being dead-reckoned at
  // (D71). This sentence is only true because the extrapolation stops here.
  const isStale = ageSec > STALE_AFTER_SECONDS;

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
        {airline && (
          <div>
            <dt>Airline</dt>
            <dd>
              {airline.name}{' '}
              <span className="panel__derived" title="Decoded from the callsign prefix">
                from {airline.code}
              </span>
            </dd>
          </div>
        )}
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
            {detail.meta.velocitySource === 'derived' && (
              <span className="panel__unit"> from its track</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Heading</dt>
          <dd>
            {detail.heading === null
              ? 'Unknown'
              : `${Math.round(detail.heading)}° ${compass(detail.heading)}`}
            {/*
              Every other number in this panel is the source's own. This one
              sometimes is not: when the reported heading contradicts the
              aircraft's own track by more than a turn could explain, the track
              wins - and says so rather than correcting silently (D80).
            */}
            {detail.meta.headingSource === 'derived' && (
              <span className="panel__unit"> from its track</span>
            )}
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

      {airline && (
        <p className="panel__caveat">
          The airline is decoded from the callsign prefix, not reported by the
          aircraft. Designators are occasionally reassigned, so an unfamiliar
          name may be a previous holder of {airline.code}.
        </p>
      )}

      <section className="panel__route">
        <h3 className="panel__subtitle">Route</h3>
        {detail.track.length < 2 ? (
          <p className="panel__note">
            Not enough observations yet to draw a path. The route builds up as we
            keep seeing this aircraft.
          </p>
        ) : (
          <>
            {detail.origin && (
              // The same `dl` every other field uses. Written as a bare pair of
              // spans first, which rendered as "DepartedDubai International
              // Airport" - the classes did not exist, so nothing separated them
              // (defect #28).
              <dl className="panel__fields">
                <div>
                  <dt>Departed</dt>
                  <dd>
                    {detail.origin.name} <span className="mono">{detail.origin.icao}</span>
                  </dd>
                </div>
              </dl>
            )}
            <p className="panel__note">
              {detail.track.length}{' '}
              {detail.trackSource === 'provider' ? 'positions' : 'observed positions'}, spanning{' '}
              {formatAge(
                (Date.parse(detail.track[detail.track.length - 1].timestamp) -
                  Date.parse(detail.track[0].timestamp)) /
                  MS_PER_SECOND,
              ).replace(' ago', '')}
              .
            </p>
            {/*
              Three different sentences for three different truths, because the
              line means something different in each case and a caption that
              covers all three would be true of none (D78).
            */}
            {detail.trackSource === 'observed' ? (
              <p className="panel__caveat">
                This is the path we have watched, not a filed flight plan. It begins
                when the aircraft entered our polling window, not at takeoff.
              </p>
            ) : detail.origin ? (
              <p className="panel__caveat">
                The path flown since departure, from the network's own flight
                history. The airport is the nearest one to where the track begins,{' '}
                {detail.origin.distanceKm.toFixed(1)} km away — not a filed flight
                plan.
              </p>
            ) : (
              <p className="panel__caveat">
                The path flown so far, from the network's own flight history. It
                begins in flight rather than at an airport, so where this aircraft
                departed from is unknown.
              </p>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
