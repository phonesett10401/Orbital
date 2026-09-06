import { describe, expect, it } from 'vitest';

import { AD_LABEL, ROTATE_MS, adAt, inventoryFor, showsAds } from './ads';

const free = { email: 'a@b.com', tier: 'free' };
const premium = { email: 'a@b.com', tier: 'premium' };

describe('who sees them', () => {
  it('shows them to a free reader', () => {
    expect(showsAds(free)).toBe(true);
  });

  it('shows them to somebody who has not signed in', () => {
    // Signed out is the free tier, not a worse one, exactly as the time-travel
    // window treats it (D149).
    expect(showsAds(null)).toBe(true);
  });

  it('shows none at all to premium', () => {
    // Not fewer, not smaller. The whole of what premium buys here is their
    // absence, so a single one surviving would make the purchase a lie.
    expect(showsAds(premium)).toBe(false);
  });

  it('treats an unknown tier as free rather than as paid', () => {
    // The safe direction: a tier this build has not been taught about should
    // see the free experience, not silently get a paid one.
    expect(showsAds({ email: 'a@b.com', tier: 'enterprise-trial' })).toBe(true);
  });
});

const SLOTS = ['banner', 'rail', 'anchor'] as const;

describe('the inventory', () => {
  it('offers something for every slot', () => {
    for (const slot of SLOTS) {
      expect(inventoryFor(slot).length, slot).toBeGreaterThan(0);
    }
  });

  it('names a sponsor on every card', () => {
    // An advertisement that does not say who is speaking is a different thing
    // with a different name.
    for (const slot of SLOTS) {
      for (const ad of inventoryFor(slot)) {
        expect(ad.sponsor, ad.id).toBeTruthy();
      }
    }
  });

  it('gives every card a distinct id within its slot', () => {
    // Ids key the React list and drive the crossfade; a duplicate makes one
    // card fail to animate for reasons nobody would find.
    for (const slot of SLOTS) {
      const ids = inventoryFor(slot).map((ad) => ad.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('sells premium somewhere, because that is what the slot is for', () => {
    const everything = SLOTS.flatMap((slot) => inventoryFor(slot));
    expect(everything.some((ad) => /premium/i.test(ad.body + ad.headline))).toBe(true);
  });
});

describe('rotation', () => {
  it('comes back round', () => {
    const size = inventoryFor('banner').length;
    expect(adAt('banner', size)).toEqual(adAt('banner', 0));
  });

  it('moves on between ticks', () => {
    expect(adAt('banner', 1)).not.toEqual(adAt('banner', 0));
  });

  it('never shows the same card in two slots at once', () => {
    // All three can be on screen together, and two identical cards read as a
    // rendering fault rather than as an advertisement shown twice.
    for (let tick = 0; tick < 12; tick += 1) {
      const shown = SLOTS.map((slot) => adAt(slot, tick).id);
      expect(new Set(shown).size, `tick ${tick}`).toBe(SLOTS.length);
    }
  });

  it('survives a tick that went backwards', () => {
    // `%` keeps a negative negative in JavaScript, so the naive version indexes
    // off the end and hands back undefined. An ad slot is not where a clock
    // read backwards should surface as a crash.
    for (const slot of SLOTS) {
      expect(adAt(slot, -1), slot).toBeDefined();
      expect(adAt(slot, -7), slot).toBeDefined();
    }
  });

  it('rotates slowly enough to be read', () => {
    // The card is three lines of prose. Anything under a few seconds is
    // movement for its own sake in the corner of somebody's eye.
    expect(ROTATE_MS).toBeGreaterThanOrEqual(8000);
  });
});

describe('the label', () => {
  it('exists and says what the thing is', () => {
    expect(AD_LABEL).toMatch(/sponsor/i);
  });
});
