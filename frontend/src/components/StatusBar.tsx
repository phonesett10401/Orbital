/**
 * Feed status: how many objects, how fresh, and whether we are showing a sample.
 *
 * This exists because three different situations look identical on a globe —
 * live data, stale data the backend is still serving through an upstream
 * outage, and our own backend being unreachable — and the user has no way to
 * tell them apart from markers alone.
 *
 * It also reports thinning. The backend sends `total` and `returned`
 * separately, and when they differ the display is a sample rather than
 * everything in view. Saying so is cheap; implying completeness is not.
 */

import { useEffect, useState } from 'react';

import { chromeFor } from './layerChrome';
import { bodyFor } from '../bodies';
import { formatInstant } from '../timeTravel';
import { useOrbitalStore } from '../state/store';

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function StatusBar() {
  const viewInstant = useOrbitalStore((s) => s.viewInstant);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const activeLayer = useOrbitalStore((s) => s.activeLayer);
  const feed = useOrbitalStore((s) => s.feed);
  const count = useOrbitalStore((s) => s.objects.size);

  // Ticks once a second so the age counts up between polls instead of
  // freezing at whatever it was when the last response arrived.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Measured from the backend's own timestamp for its last successful upstream
  // poll, not from when this response arrived. Those two agreed until the list
  // endpoint became conditional; now a 304 hands back a body whose `ageSeconds`
  // was measured on first fetch, and only the absolute instant still tells the
  // truth (D47). The cost is a dependence on the two clocks agreeing, which is
  // wrong by the skew rather than wrong without bound.
  // On another world there is no feed, no count and no data age: those are
  // facts about Earth's receiver networks. Saying "2,000 aircraft" over Mars
  // is the D100 fault again - chrome describing the wrong subject, in the one
  // line a reader checks to find out what they are looking at (D120).
  //
  // After every hook, deliberately: an early return above them would change
  // the hook order between worlds.
  if (activeBody !== 'earth') {
    const body = bodyFor(activeBody);
    return (
      <div className="status">
        <span className="status__count">
          <strong>{body.name}</strong>
        </span>
        <span className="status__item">surface imagery &mdash; no live objects here</span>
      </div>
    );
  }

  const localAge =
    feed.fetchedAtMs !== null ? (Date.now() - feed.fetchedAtMs) / 1000 : null;

  const thinned = feed.total > feed.returned;
  // What this footer is counting, and whether it has an age to report at all.
  const chrome = chromeFor(activeLayer.id, []);

  let severity = 'ok';
  if (feed.error) severity = 'error';
  else if (feed.stale) severity = 'warn';

  return (
    <footer className={`status status--${severity}`} aria-live="polite">
      <span className="status__count">
        <strong>{count.toLocaleString()}</strong> {chrome.countNoun[count === 1 ? 0 : 1]}
      </span>

      {thinned && (
        <span className="status__item" title="The backend thinned the result to keep rendering fast">
          showing a sample of {feed.total.toLocaleString()} in view
        </span>
      )}

      {/* A computed position has no age, and a null one was rendering as
          "data age never" - which reads as a fault rather than as a question
          that does not apply here (D95, D100). The source still shows: which
          element set the satellites came from is worth knowing. */}
      <span className="status__item">
        {chrome.freshness === 'age'
          ? `data age ${formatAge(localAge)}`
          : /*
              "computed now" is false the moment the map is rewound, and this
              is the one line a reader checks to find out how current the
              screen is - so it is the last place that may keep saying it
              (D119). Found by looking at the running app with the scrubber two
              days back and the status bar still claiming the present.
            */
            viewInstant === null
            ? 'positions computed now'
            : `positions computed for ${formatInstant(viewInstant)}`}
        {feed.source ? ` · ${feed.source}` : ''}
      </span>

      {feed.stale && !feed.error && (
        <span className="status__item status__item--warn">
          upstream is not responding — showing last known positions
        </span>
      )}

      {feed.error && (
        <span className="status__item status__item--error">
          cannot reach the Orbital backend ({feed.error})
        </span>
      )}
    </footer>
  );
}
