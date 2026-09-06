/**
 * Showing the sky at an instant other than now.
 *
 * The propagation layer has always accepted an arbitrary instant - it checks
 * `abs(age_days)` against a seven-day bound, so a time *before* an element
 * set's epoch is refused on exactly the same terms as one after it. What was
 * missing was any way to say so: the provider hardcoded "now" and the route
 * took no time parameter, so the capability sat in one function at the bottom
 * of the stack with nothing above it able to reach the argument (D119).
 *
 * ## Why this is satellites only
 *
 * A satellite position is **computed**, so any instant costs the same
 * arithmetic as the present one. An aircraft position is **observed** - it
 * exists because a receiver heard it - so there is no function to evaluate at
 * another time, and the store keeps at most fifty points before an object is
 * evicted five minutes after its last sighting. Offering the control on the
 * aircraft layer would promise something that cannot be delivered.
 *
 * ## Why the bound is seven days
 *
 * Not a policy choice. SGP4 drifts roughly a kilometre a day from epoch, so
 * past a week the answer stops being one. The backend enforces it per element
 * set against that set's own epoch; this module keeps the slider inside the
 * same window so the UI cannot ask for an answer it will not get.
 */

/** How far either way the elements stay worth propagating. */
export const WINDOW_DAYS = 7;
export const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

// The slider's own end stops are **not** here any more. They are what the
// signed-in account is entitled to ask for, which is a commercial bound and
// lives in `entitlements.ts`; this module holds the physical one, which no
// account can buy past (D149).

/**
 * Keep a requested instant inside the window the elements can answer for.
 *
 * Clamped rather than rejected: a slider that stops at the edge tells the
 * reader where the limit is, while one that refuses tells them only that
 * something went wrong.
 */
export function clampInstant(instant: number, now: number): number {
  const earliest = now - WINDOW_MS;
  const latest = now + WINDOW_MS;
  if (instant < earliest) return earliest;
  if (instant > latest) return latest;
  return instant;
}

/** Whether the map is showing the present. */
export function isLive(viewInstant: number | null): boolean {
  return viewInstant === null;
}

/**
 * How far from now, in words, for the chrome that says the map is not live.
 *
 * Rounded to the unit a reader is actually thinking in. "10,080 minutes ago"
 * is accurate and useless; "7 days ago" is the same fact in a form somebody
 * can check against their own memory.
 */
export function describeOffset(viewInstant: number | null, now: number): string {
  if (viewInstant === null) return 'Live';

  const deltaMs = viewInstant - now;
  const ahead = deltaMs > 0;
  const abs = Math.abs(deltaMs);
  const minutes = Math.round(abs / 60000);

  if (minutes < 1) return 'Now';

  let value: number;
  let unit: string;
  if (minutes < 60) {
    value = minutes;
    unit = 'minute';
  } else if (minutes < 60 * 48) {
    value = Math.round(minutes / 60);
    unit = 'hour';
  } else {
    value = Math.round(minutes / (60 * 24));
    unit = 'day';
  }

  const plural = value === 1 ? unit : `${unit}s`;
  return ahead ? `${value} ${plural} ahead` : `${value} ${plural} ago`;
}

/** The instant itself, for the reader who wants the actual time. */
export function formatInstant(instant: number): string {
  return new Date(instant).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
