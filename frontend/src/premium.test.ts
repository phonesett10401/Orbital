import { describe, expect, it } from 'vitest';

import { showsAds } from './ads';
import { FREE_WINDOW_MS, PREMIUM_WINDOW_MS, travelWindowMs } from './entitlements';
import {
  DOWNGRADE_LABEL,
  LEDE,
  NO_PAYMENT_NOTE,
  TITLE,
  UPGRADE_LABEL,
  differences,
  features,
} from './premium';

const premiumAccount = { email: 'a@b.com', tier: 'premium' };

describe('the claims match what is enforced', () => {
  // The whole reason this file exists. A pricing page is the one screen where
  // the temptation to overstate is structural, and a feature list that drifts
  // from the code is a lie nobody notices, because nobody re-reads it.

  it('quotes the window the entitlement actually gives', () => {
    const row = features().find((f) => f.name === 'Time travel');
    expect(row).toBeDefined();
    expect(row!.free).toContain('24 hours');
    expect(row!.premium).toContain('7 days');
    expect(travelWindowMs(null)).toBe(FREE_WINDOW_MS);
    expect(travelWindowMs(premiumAccount)).toBe(PREMIUM_WINDOW_MS);
  });

  it('promises no ads only because premium really has none', () => {
    const row = features().find((f) => f.name === 'Advertising');
    expect(row!.premium).toMatch(/none/i);
    expect(showsAds(premiumAccount)).toBe(false);
    expect(showsAds(null)).toBe(true);
  });

  it('does not claim the free tier is missing anything it has', () => {
    // Aircraft, satellites, the worlds and the lunar craft are all free, and a
    // pricing page that implied otherwise would be selling what it gives away.
    for (const name of [
      'Live aircraft and satellites',
      'Ten worlds and the solar system',
      'Spacecraft around the Moon',
    ]) {
      const row = features().find((f) => f.name === name);
      expect(row, name).toBeDefined();
      expect(row!.free, name).toBe(row!.premium);
    }
  });
});

describe('how much premium actually is', () => {
  it('differs in exactly the two ways it differs', () => {
    // Kept as its own function so padding the list is visible rather than
    // easy: the day this returns three, something was added or something was
    // taken away from free.
    expect(differences().map((f) => f.name)).toEqual(['Time travel', 'Advertising']);
  });

  it('lists more shared rows than paid ones', () => {
    // The honest shape of this product: nearly all of it is free.
    expect(features().length - differences().length).toBeGreaterThan(
      differences().length,
    );
  });
});

describe('the words on the button and the page', () => {
  it('never says buy, because nothing is bought', () => {
    // A button labelled "Buy" that takes no money is a lie told in the
    // interface, and this is the assertion that stops one being written later.
    for (const text of [UPGRADE_LABEL, DOWNGRADE_LABEL, TITLE, LEDE]) {
      expect(text.toLowerCase(), text).not.toMatch(/\b(buy|purchase|pay|checkout)\b/);
    }
  });

  it('says there is no payment, in the open', () => {
    expect(NO_PAYMENT_NOTE).toMatch(/no payment/i);
    expect(NO_PAYMENT_NOTE).toMatch(/free/i);
  });

  it('says the switch goes both ways', () => {
    // Somebody who turns premium on and cannot turn it off has no way back to
    // the free experience, including whoever is marking this project.
    expect(NO_PAYMENT_NOTE).toMatch(/off/i);
    expect(DOWNGRADE_LABEL).toMatch(/off/i);
  });
});
