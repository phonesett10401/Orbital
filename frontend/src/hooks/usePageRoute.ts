/**
 * Keeping the open page and the address bar agreeing (D153, D157).
 *
 * Two directions, and both are needed. The store leads when somebody presses a
 * button, and the hash leads when somebody presses Back or arrives on a link -
 * so this watches each and moves the other, with `moveFor` deciding which, so
 * the rule itself can be tested without a browser.
 */

import { useEffect, useRef } from 'react';

import { hashFor, moveFor, pageForHash } from '../pageRoute';
import { useOrbitalStore } from '../state/store';

export function usePageRoute() {
  const page = useOrbitalStore((s) => s.openPage);
  const setPage = useOrbitalStore((s) => s.setOpenPage);

  /**
   * Whether the first pass is over.
   *
   * **On the very first render the address leads, not the state**, and without
   * this the two effects race in a way that loses. Arriving on
   * `orbital/#premium`, the state is still `null` while the hash already says
   * `premium`, so this effect reads "a page was closed", calls
   * `history.back()`, and navigates out of the application entirely - then the
   * sync effect reads the now-empty hash and agrees that nothing is open.
   *
   * Effect order does not fix it: both run in the same commit, and the second
   * one's `setPage` is not visible to this one's closure until the next render.
   * So the first run is skipped outright, which is also the honest rule - a page
   * opened by a link was not opened by the state, and there is nothing to push.
   *
   * Found by pasting a link, and intermittent before that: whether the browser
   * had applied `back()` by the time the effect re-ran decided it, so the same
   * code worked once and failed the next time.
   */
  const settled = useRef(false);

  // The address follows the state.
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    const move = moveFor(page, pageForHash(window.location.hash));
    if (move === 'push' && page) window.history.pushState(null, '', hashFor(page));
    else if (move === 'replace' && page) {
      window.history.replaceState(null, '', hashFor(page));
    } else if (move === 'back') {
      // `back` rather than replacing with the bare URL: closing has to *remove*
      // the entry opening pushed, or the stack grows one every time somebody
      // opens and dismisses a page.
      window.history.back();
    }
  }, [page]);

  // The state follows the address, which is what makes Back close a page and a
  // pasted link open one.
  useEffect(() => {
    const sync = () => setPage(pageForHash(window.location.hash));
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [setPage]);
}
