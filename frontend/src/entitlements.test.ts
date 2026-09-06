import { describe, expect, it } from 'vitest';

import {
  FREE_WINDOW_MS,
  PREMIUM_WINDOW_MS,
  clampToEntitlement,
  describeWindow,
  scaleLabels,
  travelWindowMs,
  upgradeHint,
} from './entitlements';
import { WINDOW_MS } from './timeTravel';

const free = { email: 'a@b.com', tier: 'free' };
const premium = { email: 'a@b.com', tier: 'premium' };
const NOW = Date.UTC(2026, 8, 6, 12, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('how far a tier reaches', () => {
  it('gives premium more than free', () => {
    expect(travelWindowMs(premium)).toBeGreaterThan(travelWindowMs(free));
  });

  it('treats being signed out exactly as being free', () => {
    // The free tier is the product, so someone who never made an account is
    // not in a degraded state.
    expect(travelWindowMs(null)).toBe(travelWindowMs(free));
    expect(travelWindowMs(null)).toBe(FREE_WINDOW_MS);
  });

  it('treats an unknown tier as free rather than as the largest window', () => {
    expect(travelWindowMs({ email: 'a@b.com', tier: 'enterprise-trial' })).toBe(
      FREE_WINDOW_MS,
    );
  });

  it('lets no tier buy past the accuracy bound', () => {
    // The one property that matters: past seven days SGP4 is not answering
    // the question, so a purchasable window beyond it would sell nonsense.
    for (const account of [null, free, premium]) {
      expect(travelWindowMs(account)).toBeLessThanOrEqual(WINDOW_MS);
    }
  });

  it('makes premium the whole of the reach that exists', () => {
    // Deliberate. There is no tier above premium here because there is
    // nothing left to sell, and this should fail loudly if that changes.
    expect(PREMIUM_WINDOW_MS).toBe(WINDOW_MS);
  });

  it('agrees with the backend on the free window', () => {
    // A disagreement here is invisible: the slider would run to a position
    // the server refuses, so the end stop itself would 403.
    expect(FREE_WINDOW_MS).toBe(24 * HOUR);
    expect(PREMIUM_WINDOW_MS).toBe(7 * DAY);
  });
});

describe('keeping an instant inside the window', () => {
  it('leaves an instant that is already inside alone', () => {
    expect(clampToEntitlement(NOW - 3 * HOUR, NOW, free)).toBe(NOW - 3 * HOUR);
  });

  it('pulls a free reader back to a day', () => {
    expect(clampToEntitlement(NOW - 5 * DAY, NOW, free)).toBe(NOW - FREE_WINDOW_MS);
    expect(clampToEntitlement(NOW + 5 * DAY, NOW, free)).toBe(NOW + FREE_WINDOW_MS);
  });

  it('lets a premium reader keep the same instant a free one loses', () => {
    expect(clampToEntitlement(NOW - 5 * DAY, NOW, premium)).toBe(NOW - 5 * DAY);
  });

  it('does not leave the edge where it put it, once the clock moves', () => {
    // Not a defect in this function - it is the reason the component that
    // calls it cannot re-clamp on every render. Clamping puts the instant at
    // exactly `now - window`; a second later `now` has moved and that same
    // instant is outside again, so an effect that watched `viewInstant` and
    // read `Date.now()` would rewrite it forever. React reaches "Maximum
    // update depth exceeded" in under a second and renders an empty page.
    //
    // Found by signing out of a rewound map, not by testing: every test here
    // passed, because a pure function given a frozen clock cannot show it. The
    // fix is in `TimeControl`, which re-clamps when the entitlement changes
    // rather than when the instant does (D149).
    const edge = clampToEntitlement(NOW - 5 * DAY, NOW, free);
    const aSecondLater = NOW + 1000;
    expect(clampToEntitlement(edge, aSecondLater, free)).not.toBe(edge);
  });

  it('re-clamps a premium instant when the account goes away', () => {
    // The bug this exists to stop: rewind six days as premium, sign out, and
    // the map is left showing an instant the server will now refuse - so the
    // sky freezes and nothing says why.
    const rewound = NOW - 6 * DAY;
    expect(clampToEntitlement(rewound, NOW, null)).toBe(NOW - FREE_WINDOW_MS);
  });
});

describe('what the reader is told', () => {
  it('writes a window in the unit they think in', () => {
    expect(describeWindow(24 * HOUR)).toBe('24 hours');
    expect(describeWindow(7 * DAY)).toBe('7 days');
    expect(describeWindow(HOUR)).toBe('1 hour');
  });

  it('labels the ends of the slider with what they actually are', () => {
    expect(scaleLabels(free)).toEqual(['24 hours ago', '24 hours ahead']);
    expect(scaleLabels(premium)).toEqual(['7 days ago', '7 days ahead']);
  });

  it('tells a free reader what more would reach', () => {
    expect(upgradeHint(null)).toContain('7 days');
    expect(upgradeHint(free)).toContain('7 days');
  });

  it('says nothing at all to a reader who has already bought it', () => {
    // Anything here would be an advertisement for a tier that does not exist.
    expect(upgradeHint(premium)).toBeNull();
  });
});
