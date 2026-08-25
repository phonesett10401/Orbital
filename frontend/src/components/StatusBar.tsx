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

import { useOrbitalStore } from '../state/store';

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function StatusBar() {
  const feed = useOrbitalStore((s) => s.feed);
  const count = useOrbitalStore((s) => s.objects.size);

  // Age is reported by the backend at fetch time; ticking locally keeps it
  // honest between polls instead of showing a number frozen ten seconds ago.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const localAge =
    feed.ageSeconds !== null && feed.lastUpdatedMs !== null
      ? feed.ageSeconds + (Date.now() - feed.lastUpdatedMs) / 1000
      : null;

  const thinned = feed.total > feed.returned;

  let severity = 'ok';
  if (feed.error) severity = 'error';
  else if (feed.stale) severity = 'warn';

  return (
    <footer className={`status status--${severity}`} aria-live="polite">
      <span className="status__count">
        <strong>{count.toLocaleString()}</strong> aircraft
      </span>

      {thinned && (
        <span className="status__item" title="The backend thinned the result to keep rendering fast">
          showing a sample of {feed.total.toLocaleString()} in view
        </span>
      )}

      <span className="status__item">
        data age {formatAge(localAge)}
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
