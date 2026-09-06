/**
 * Which full-screen page is open, and its place in browser history (D153, D157).
 *
 * Orbital has no router, and adding one for two screens would be a large change
 * to justify. What a page actually needs from a router is smaller than a router:
 * **an address while it is open, and a Back button that closes it.** Both are a
 * hash and two calls to `history`.
 *
 * **Why it matters that Back closes it.** A full-screen view that swallows the
 * Back button is the commonest way a single-page app breaks a browser: the
 * reader presses Back expecting to dismiss what is in front of them, and the app
 * leaves the page open while quietly navigating away from something else.
 *
 * This started as one page and one boolean. It is a name now because a second
 * page arrived, and two booleans would have made "both open at once" a state the
 * types allowed - which is exactly the sort of thing that happens once and is
 * then impossible to reproduce.
 */

/** The pages that can be open. `null` is the map. */
export type PageName = 'signin' | 'premium';

const HASHES: Record<PageName, string> = {
  signin: '#signin',
  premium: '#premium',
};

/** The address a page has while it is open. */
export function hashFor(page: PageName): string {
  return HASHES[page];
}

/**
 * The page a location's hash asks for, or null for the map.
 *
 * Compared without the `#` and folded, so a bare `signin` - which is what some
 * clients hand back - and `#SignIn` both reach the same page.
 */
export function pageForHash(hash: string): PageName | null {
  const bare = hash.replace(/^#/, '').toLowerCase();
  const found = (Object.keys(HASHES) as PageName[]).find((name) => name === bare);
  return found ?? null;
}

/**
 * What to do to the history stack when the open page changes.
 *
 * Opening pushes, so there is something for Back to pop. Closing by any route
 * other than Back has to remove that entry again, or the stack grows an entry
 * every time somebody opens and dismisses a page - and Back then appears to do
 * nothing for as many presses as they opened it.
 *
 * Moving straight from one page to another **replaces**: the two are siblings,
 * not a trail, so Back from the premium page reached through sign-in should
 * return to the map rather than walking backwards through every page visited.
 */
export type HistoryMove = 'push' | 'back' | 'replace' | 'none';

export function moveFor(wanted: PageName | null, inHash: PageName | null): HistoryMove {
  if (wanted === inHash) return 'none';
  if (wanted === null) return 'back';
  if (inHash === null) return 'push';
  return 'replace';
}
