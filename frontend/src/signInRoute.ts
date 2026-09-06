/**
 * The sign-in page's place in browser history (D153).
 *
 * Orbital has no router, and adding one for a single page would be a large
 * change to justify with one screen. What a page actually needs from a router
 * is smaller than a router: an address while it is open, and a Back button that
 * closes it. Both are a hash and two calls to `history`.
 *
 * **Why it matters that Back closes it.** A full-screen view that swallows the
 * Back button is the most common way a single-page app breaks a browser: the
 * reader presses Back expecting to dismiss what is in front of them, and the
 * app leaves the page open while quietly navigating away from something else.
 */

/** The address the page has while it is open. */
export const SIGN_IN_HASH = '#signin';

/** Whether a location's hash means the sign-in page should be showing. */
export function opensSignIn(hash: string): boolean {
  // Compared without the `#` so a bare `signin`, which is what some clients
  // hand back, reads the same as the canonical form.
  return hash.replace(/^#/, '').toLowerCase() === 'signin';
}

/**
 * What to do to the history stack when the page opens or closes.
 *
 * Opening pushes, so there is something for Back to pop. Closing by any route
 * other than Back has to remove that entry again, or the stack grows an entry
 * every time somebody opens and dismisses the page - and then Back appears to
 * do nothing for as many presses as they opened it.
 */
export type HistoryMove = 'push' | 'back' | 'none';

export function moveFor(
  wantOpen: boolean,
  hashIsOpen: boolean,
): HistoryMove {
  if (wantOpen && !hashIsOpen) return 'push';
  if (!wantOpen && hashIsOpen) return 'back';
  return 'none';
}
