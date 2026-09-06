/**
 * What premium is, said in one place (D157).
 *
 * The page renders this; nothing here knows about React. That is the same shape
 * `auth.ts` and `entitlements.ts` have, and for the same reason: a claim about
 * what somebody gets for money is exactly the sort of thing that should be
 * checkable rather than typed into a component.
 *
 * ## Every line here has to be true
 *
 * A pricing page is the one screen in an application where the temptation to
 * overstate is structural. So each row names a thing that is actually enforced
 * somewhere, and the tests assert the numbers match the modules that enforce
 * them - `entitlements.ts` for the window, `ads.ts` for the slots. A feature
 * list that drifts from the code is a lie that nobody notices, because nobody
 * re-reads the pricing page.
 *
 * ## There is no payment, and the page says so
 *
 * A processor needs an account, live keys, a domain and a policy review, none of
 * which belong in this repository. What would be wrong is *pretending*: a button
 * labelled "Buy" that takes no money is a lie told in the interface. So the
 * button says what it does, and `NO_PAYMENT_NOTE` is not fine print.
 */

import { describeWindow, FREE_WINDOW_MS, PREMIUM_WINDOW_MS } from './entitlements';

export interface Feature {
  name: string;
  /** What the free tier gets. */
  free: string;
  /** What premium gets. */
  premium: string;
}

/**
 * The comparison, in the order it is read.
 *
 * The window first, because it is the one that cost something to build and the
 * only one that changes what the map can answer.
 */
export function features(): Feature[] {
  return [
    {
      name: 'Time travel',
      free: `${describeWindow(FREE_WINDOW_MS)} either way`,
      premium: `${describeWindow(PREMIUM_WINDOW_MS)} either way`,
    },
    {
      name: 'Advertising',
      free: 'Two slots and a line in the status bar',
      premium: 'None',
    },
    {
      name: 'Live aircraft and satellites',
      free: 'Everything',
      premium: 'Everything',
    },
    {
      name: 'Ten worlds and the solar system',
      free: 'Everything',
      premium: 'Everything',
    },
    {
      name: 'Spacecraft around the Moon',
      free: 'Everything',
      premium: 'Everything',
    },
  ];
}

/**
 * The rows where the tiers actually differ.
 *
 * Used to keep the page honest about how short this list is: two things. The
 * temptation on a pricing page is to pad it until the paid column looks fuller
 * than it is, and separating the rows makes padding visible instead of easy.
 */
export function differences(): Feature[] {
  return features().filter((f) => f.free !== f.premium);
}

/** Said plainly on the page, not in small print. */
export const NO_PAYMENT_NOTE =
  'Orbital has no payment system. Premium is free to switch on while the ' +
  'project is being built, and switching it off again is one click.';

/** What the button does, which is not buying. */
export const UPGRADE_LABEL = 'Switch premium on';
export const DOWNGRADE_LABEL = 'Switch premium off';

/** The heading, and the sentence under it. */
export const TITLE = 'Premium';
export const LEDE =
  'The free tier is the whole map. Premium buys reach on the one layer that ' +
  'can be computed rather than observed, and quiet.';
