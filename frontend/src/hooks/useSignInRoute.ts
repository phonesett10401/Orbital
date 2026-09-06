/**
 * Keeping the sign-in page and the address bar agreeing (D153).
 *
 * Two directions, and both are needed. The store leads when somebody presses
 * the button, and the hash leads when somebody presses Back or arrives on a
 * link - so this watches each and moves the other, with `moveFor` deciding
 * which so the rule itself can be tested without a browser.
 */

import { useEffect } from 'react';

import { SIGN_IN_HASH, moveFor, opensSignIn } from '../signInRoute';
import { useOrbitalStore } from '../state/store';

export function useSignInRoute() {
  const open = useOrbitalStore((s) => s.signInOpen);
  const setOpen = useOrbitalStore((s) => s.setSignInOpen);

  // The address follows the state.
  useEffect(() => {
    const move = moveFor(open, opensSignIn(window.location.hash));
    if (move === 'push') window.history.pushState(null, '', SIGN_IN_HASH);
    // `back` rather than replacing: closing has to *remove* the entry opening
    // pushed, or the stack grows one every time somebody opens and dismisses
    // the page, and Back then appears to do nothing for as many presses.
    else if (move === 'back') window.history.back();
  }, [open]);

  // The state follows the address, which is what makes Back close the page and
  // a pasted link open it.
  useEffect(() => {
    const sync = () => setOpen(opensSignIn(window.location.hash));
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [setOpen]);
}
