/**
 * The header control that says who is signed in (D148), and opens the sign-in
 * page when nobody is (D153).
 *
 * It used to hold the form in a dropdown. That moved to `SignInPage`, and what
 * is left is the two things the header is the right place for: saying which
 * account this is, and getting out of it.
 *
 * ## Signing out is still a dropdown, and signing in is not
 *
 * Not an inconsistency. Signing in is a form with two fields, rules, failure
 * messages and a second mode; it earns a screen. Signing out is one button, and
 * putting a full page in front of somebody to press it would be ceremony.
 *
 * ## It says nothing until it knows
 *
 * `accountChecked` gates the whole control. Without it the header renders
 * "Sign in" on every page load and then corrects itself a moment later, which
 * reads as being signed out and then signed back in - alarming for exactly the
 * people who care whether they are signed in.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchMe, signOut } from '../api/client';
import { tierLabel } from '../auth';
import { useOrbitalStore } from '../state/store';

export function AccountMenu() {
  const account = useOrbitalStore((s) => s.account);
  const accountChecked = useOrbitalStore((s) => s.accountChecked);
  const setAccount = useOrbitalStore((s) => s.setAccount);
  const setSignInOpen = useOrbitalStore((s) => s.setSignInOpen);
  const signInOpen = useOrbitalStore((s) => s.signInOpen);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);

  // Asked once, on load. A 200 with a null account is the ordinary answer, so
  // this is not an error path (D147).
  useEffect(() => {
    const controller = new AbortController();
    fetchMe(controller.signal)
      .then((response) => setAccount(response.account))
      .catch(() => setAccount(null));
    return () => controller.abort();
  }, [setAccount]);

  // Focus comes back here when the page closes, so a keyboard reader who
  // dismissed it is where they started rather than at the top of the document
  // (D153).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !signInOpen) button.current?.focus();
    wasOpen.current = signInOpen;
  }, [signInOpen]);

  const leave = async () => {
    setBusy(true);
    try {
      await signOut();
    } catch {
      // Sign-out is not worth an error message. The cookie is cleared by the
      // server, and if the request never arrived the session expires anyway.
    } finally {
      setAccount(null);
      setBusy(false);
      setOpen(false);
    }
  };

  if (!accountChecked) return null;

  const press = () => {
    if (!account) {
      setSignInOpen(true);
      return;
    }
    setOpen(!open);
  };

  return (
    <div className="account">
      <button
        type="button"
        ref={button}
        className={`account__button ${account ? 'is-signed-in' : ''}`}
        aria-expanded={account ? open : undefined}
        onClick={press}
      >
        {account ? tierLabel(account.tier) : 'Sign in'}
      </button>

      {account && open && (
        <div className="account__panel" role="dialog" aria-label="Account">
          <p className="account__email">{account.email}</p>
          <p className="account__tier">{tierLabel(account.tier)} account</p>
          <button type="button" className="account__submit" onClick={leave} disabled={busy}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
