/**
 * What premium is, and the switch that turns it on (D157).
 *
 * The same page shape as `SignInPage`: a full screen over a blurred map, an
 * address in the hash, Escape and Back to close, focus returned to whatever
 * opened it. What it holds is different, and every claim on it comes from
 * `premium.ts`, which is tested against the modules that actually enforce them.
 *
 * ## The button does not say Buy
 *
 * There is no payment system, and a button labelled "Buy" that takes no money
 * is a lie told in the interface - the one kind of dishonesty an application
 * can commit without anybody noticing, because nobody re-reads a pricing page.
 * So it says what it does, and the note saying there is no payment is set as
 * plainly as everything else rather than as fine print.
 *
 * ## It is reachable from the places that mention premium
 *
 * The sign-in page, the account menu, and the ads that pitch it. An
 * advertisement whose call to action goes nowhere is the other version of the
 * same problem.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError, changeTier } from '../api/client';
import { isPremium, tierLabel } from '../auth';
import { failureMessage } from '../auth';
import { prefersReducedMotion } from '../motion';
import {
  DOWNGRADE_LABEL,
  LEDE,
  NO_PAYMENT_NOTE,
  TITLE,
  UPGRADE_LABEL,
  features,
} from '../premium';
import { useOrbitalStore } from '../state/store';
import { timings } from '../authAnimation';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PremiumPage() {
  const open = useOrbitalStore((s) => s.openPage) === 'premium';
  const setPage = useOrbitalStore((s) => s.setOpenPage);
  const account = useOrbitalStore((s) => s.account);
  const setAccount = useOrbitalStore((s) => s.setAccount);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const motion = timings(prefersReducedMotion());

  const paid = isPremium(account);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
  }, [open]);

  // Escape, and Tab kept inside - the same two obligations a full-screen
  // overlay has anywhere (D153).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPage(null);
        return;
      }
      if (event.key !== 'Tab' || !surface.current) return;
      const stops = [...surface.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setPage]);

  if (!open) return null;

  const flip = async () => {
    // Signing in first, because the tier belongs to an account and there is
    // nothing to change without one. Sent to the sign-in page rather than
    // refused, so the answer to "I want this" is a way to get it.
    if (!account) {
      setPage('signin');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await changeTier(paid ? 'free' : 'premium');
      setAccount(response?.account ?? null);
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      setError(failureMessage(failure?.status ?? null, failure?.message ?? ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="premium"
      role="dialog"
      aria-modal="true"
      aria-label="About premium"
      style={{ '--panel-in': `${motion.panelIn}ms` } as React.CSSProperties}
    >
      <div className="premium__surface" ref={surface}>
        <div className="signin__brand">
          <img className="signin__mark" src="/logo.svg" alt="" aria-hidden="true" />
          <span className="signin__wordmark">Orbital</span>
        </div>

        <h1 className="signin__title">{TITLE}</h1>
        <p className="signin__lede">{LEDE}</p>

        <table className="premium__table">
          <thead>
            <tr>
              <th scope="col">
                <span className="premium__srOnly">Feature</span>
              </th>
              <th scope="col">Free</th>
              <th scope="col" className="premium__paidHead">
                Premium
              </th>
            </tr>
          </thead>
          <tbody>
            {features().map((feature) => (
              <tr
                key={feature.name}
                className={feature.free === feature.premium ? 'is-same' : ''}
              >
                <th scope="row">{feature.name}</th>
                <td>{feature.free}</td>
                <td className="premium__paid">{feature.premium}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Plainly, not as fine print. */}
        <p className="premium__note">{NO_PAYMENT_NOTE}</p>

        {account && (
          <p className="premium__current">
            Signed in as {account.email} — {tierLabel(account.tier)}
          </p>
        )}

        {error && (
          <p className="account__problem account__problem--server" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className={`account__submit ${busy ? 'is-working' : ''}`}
          onClick={flip}
          disabled={busy}
        >
          {!account ? 'Sign in first' : busy ? 'Working…' : paid ? DOWNGRADE_LABEL : UPGRADE_LABEL}
        </button>

        <button type="button" className="signin__back" onClick={() => setPage(null)}>
          ← Back to the map
        </button>
      </div>
    </div>
  );
}
