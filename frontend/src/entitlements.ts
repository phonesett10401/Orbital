/**
 * How far a tier may move the sky (D149).
 *
 * The mirror of `app/accounts/entitlements.py`, and the same warning applies as
 * to `auth.ts`: **this is a courtesy, not a control.** The server enforces the
 * window, and removing everything here would change only how pleasant the
 * refusal is - the slider would run further and the request would come back
 * 403. What it buys is that the limit is *visible*: an end stop a reader can
 * see and a label that says why, rather than a control that moves freely and
 * then fails.
 *
 * ## Two bounds of different kinds
 *
 * `WINDOW_MS` in `timeTravel.ts` is physics - SGP4 drifts about a kilometre a
 * day from epoch, so seven days is where the answer stops being one. The tier
 * windows here are policy. They are kept in separate modules on purpose: the
 * moment a physical limit and a purchasable one are spelled the same way,
 * somebody raises the paid one because the constant was right there.
 *
 * The premium window *is* the physical bound, which is the honest shape for
 * this feature: premium buys all the reach that exists, and there is no tier
 * above it because there is nothing left to sell.
 */

import { type Account, isPremium } from './auth';
import { WINDOW_MS } from './timeTravel';

const HOUR_MS = 60 * 60 * 1000;

/** A free reader keeps a full day either way - enough for tonight's passes. */
export const FREE_WINDOW_MS = 24 * HOUR_MS;
export const PREMIUM_WINDOW_MS = WINDOW_MS;

/**
 * How far either way this account may move the sky.
 *
 * Signed out is the free window, not zero and not an error: the free tier is
 * the product. Passed through `min` against the physical bound for the reason
 * in the module note.
 */
export function travelWindowMs(account: Account | null): number {
  const window = isPremium(account) ? PREMIUM_WINDOW_MS : FREE_WINDOW_MS;
  return Math.min(window, WINDOW_MS);
}

/** Keep an instant inside what this account may ask for. */
export function clampToEntitlement(
  instant: number,
  now: number,
  account: Account | null,
): number {
  const window = travelWindowMs(account);
  if (instant < now - window) return now - window;
  if (instant > now + window) return now + window;
  return instant;
}

/** A window in the unit a reader thinks in: `24 hours`, `7 days`. */
export function describeWindow(windowMs: number): string {
  const hours = windowMs / HOUR_MS;
  if (hours < 48) {
    const value = Math.round(hours);
    return `${value} ${value === 1 ? 'hour' : 'hours'}`;
  }
  const value = Math.round(hours / 24);
  return `${value} ${value === 1 ? 'day' : 'days'}`;
}

/** What the ends of the slider are labelled. */
export function scaleLabels(account: Account | null): [string, string] {
  const written = describeWindow(travelWindowMs(account));
  return [`${written} ago`, `${written} ahead`];
}

/**
 * The line under the slider telling a free reader what more would reach, or
 * null when there is nothing to say.
 *
 * Null for premium, deliberately. A paid reader has bought the whole window,
 * so anything in this slot would be an advertisement for something that does
 * not exist.
 */
export function upgradeHint(account: Account | null): string | null {
  if (isPremium(account)) return null;
  return `Premium reaches ${describeWindow(PREMIUM_WINDOW_MS)} either way.`;
}
