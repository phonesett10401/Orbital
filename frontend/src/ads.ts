/**
 * The other side of the free tier (D150).
 *
 * D149 gave premium something to buy. This is what free costs instead: two
 * slots, a strip across the top and a rail down the right, shown to everybody
 * who is not premium and to nobody who is.
 *
 * ## These are house ads, and that is a decision rather than a placeholder
 *
 * There is no third-party network here - no AdSense tag, no prebid, no pixel -
 * and adding one is **not** a small later change:
 *
 * - Every one of them works by shipping something about the viewer to somebody
 *   else. Orbital's account design says the opposite in as many words: an
 *   account is an email, a hash, a tier and a date, and there is deliberately
 *   no record of what anybody looked at (D146). A network tag would undo that
 *   from the outside, on a page that never asked.
 * - It needs a live domain, a policy review and an approved account, none of
 *   which exist yet.
 * - It is a decision about *Phone's* users, not a detail of this component.
 *
 * So the inventory below is Orbital talking about Orbital, which is what a
 * freemium product actually shows before it has advertisers. The seam a network
 * would fill is `inventoryFor` - one function returning a list - and the slot
 * component does not care where the list came from.
 *
 * ## Labelled, always
 *
 * Every card says what it is. An advertisement that is not marked as one is a
 * different thing with a different name.
 */

import { type Account, isPremium } from './auth';

/**
 * Where an ad can go.
 *
 * All three are places the chrome was already empty - the header past the layer
 * toggle, the corner the detail panel uses when one is open, and the run of
 * status bar after the data age. None of them takes a pixel from the map.
 */
export type AdSlot = 'banner' | 'rail' | 'status';

/** Fixed order, so each slot can be given a different starting card. */
const SLOTS: AdSlot[] = ['banner', 'rail', 'status'];

export interface Ad {
  id: string;
  /** Who is speaking. Shown, never implied. */
  sponsor: string;
  headline: string;
  body: string;
  /** What the card offers to do; null for one that only says something. */
  action: string | null;
}

/**
 * Whether this reader sees ads at all.
 *
 * Signed out is treated exactly as free, the same way `travelWindowMs` treats
 * it: the free tier is the product, and somebody who has never made an account
 * is not in a worse state than somebody who has.
 */
export function showsAds(account: Account | null): boolean {
  return !isPremium(account);
}

const PREMIUM_PITCH: Ad = {
  id: 'premium-timetravel',
  sponsor: 'Orbital',
  headline: 'Seven days of sky',
  body:
    'Premium moves the satellite view a full week either way, instead of ' +
    'twenty-four hours. It also turns these off.',
  action: 'See what premium does',
};

const HOUSE: Record<AdSlot, Ad[]> = {
  banner: [
    PREMIUM_PITCH,
    {
      id: 'banner-satellites',
      sponsor: 'Orbital',
      headline: 'Every satellite, computed on the spot',
      body:
        'Positions here are worked out from orbital elements when you ask for ' +
        'them, not replayed from a snapshot.',
      action: null,
    },
    {
      id: 'banner-worlds',
      sponsor: 'Orbital',
      headline: 'Ten worlds under the same camera',
      body: 'The picker under the wordmark travels to any of them without a reload.',
      action: null,
    },
  ],
  status: [
    {
      id: 'status-premium',
      sponsor: 'Orbital',
      headline: 'Premium removes these',
      body: 'And moves the satellite view seven days either way.',
      action: null,
    },
    {
      id: 'status-adsb',
      sponsor: 'Orbital',
      headline: 'Aircraft from volunteer receivers',
      body: 'The coverage gaps are where nobody is listening.',
      action: null,
    },
    {
      id: 'status-elements',
      sponsor: 'Orbital',
      headline: 'Orbits from CelesTrak and SatNOGS',
      body: 'Refreshed on their own schedule, never on the request path.',
      action: null,
    },
  ],
  rail: [
    PREMIUM_PITCH,
    {
      id: 'rail-moon',
      sponsor: 'Orbital',
      headline: 'Three craft around the Moon',
      body:
        'Their positions come from JPL Horizons, published in advance rather ' +
        'than observed.',
      action: null,
    },
    {
      id: 'rail-open',
      sponsor: 'Orbital',
      headline: 'Built on open data',
      body:
        'Aircraft from adsb.lol under ODbL, elements from CelesTrak and ' +
        'SatNOGS, imagery from NASA and OpenFreeMap.',
      action: null,
    },
  ],
};

/**
 * What could be shown in a slot.
 *
 * **The seam.** A real network would replace the body of this function and
 * nothing else: the slot component takes a list and knows nothing about where
 * it came from.
 */
export function inventoryFor(slot: AdSlot): Ad[] {
  return HOUSE[slot];
}

/**
 * Which one to show on a given turn.
 *
 * Deterministic rather than random, so a test can say which card it expects and
 * so two slots on the same screen do not flicker into showing the same thing.
 * The rail is offset by one for exactly that reason.
 */
export function adAt(slot: AdSlot, tick: number): Ad {
  const inventory = inventoryFor(slot);
  // Each slot starts at a different card, so two of them on one screen never
  // show the same thing - which reads as a rendering fault rather than as an
  // advertisement shown twice.
  const offset = SLOTS.indexOf(slot);
  // `%` keeps a negative tick negative in JavaScript, and a tick should never
  // be negative - but a clock read backwards or a counter reset would make one,
  // and an ad slot is not where that should show up as a crash.
  const index = (((tick + offset) % inventory.length) + inventory.length) % inventory.length;
  return inventory[index];
}

/** How long a card stays before the next one, in milliseconds. */
export const ROTATE_MS = 12_000;

/** The label every card carries, so it is never mistaken for the product. */
export const AD_LABEL = 'Sponsored';
