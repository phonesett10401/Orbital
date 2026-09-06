/**
 * Signing in, as a page rather than a dropdown (D153).
 *
 * The form and every judgement in it are unchanged - `auth.ts` for the rules,
 * `authAnimation.ts` for the phases (D148, D151). What changed is where it
 * happens: a panel hanging off a header button became a screen of its own,
 * which is what signing in looks like nearly everywhere else and gives the
 * fields room to be read.
 *
 * ## It behaves like a page even though there is no router
 *
 * Orbital has no routing, and adding a router for one screen would be a large
 * change to justify. What a page actually needs is smaller than a router: an
 * address while it is open and a Back button that closes it, which is a hash
 * and two calls to `history` (`signInRoute.ts`).
 *
 * ## The things a full-screen overlay owes the reader
 *
 * - **Escape closes it**, and focus goes back to the control that opened it,
 *   so a keyboard reader is not dropped at the top of the document.
 * - **Tab stays inside.** The map behind is still focusable to the browser, and
 *   tabbing into a form you cannot see is worse than no keyboard support.
 * - **The email field is focused on arrival**, because a page whose entire
 *   purpose is one form should not need a click first.
 */

import { useEffect, useRef } from 'react';
import { useState } from 'react';

import { ApiError, register, signIn } from '../api/client';
import { canSubmit, emailProblem, failureMessage, passwordProblem } from '../auth';
import {
  type AuthPhase,
  acceptsInput,
  submitLabel,
  successMessage,
  timings,
} from '../authAnimation';
import { prefersReducedMotion } from '../motion';
import { useOrbitalStore } from '../state/store';

type Mode = 'signin' | 'register';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SignInPage() {
  const open = useOrbitalStore((s) => s.openPage) === 'signin';
  const setPage = useOrbitalStore((s) => s.setOpenPage);
  const setAccount = useOrbitalStore((s) => s.setAccount);

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<AuthPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const motion = timings(prefersReducedMotion());
  const busy = phase === 'working' || phase === 'success';

  const surface = useRef<HTMLDivElement | null>(null);
  const firstField = useRef<HTMLInputElement | null>(null);
  const timers = useRef<number[]>([]);
  const later = (run: () => void, ms: number) => {
    timers.current.push(window.setTimeout(run, ms));
  };
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  // Fresh every time it opens. Reopening onto a half-filled form from a
  // previous attempt is the same class of fault as the panel that reopened in
  // register mode (D148): state kept across a close that should not have been.
  useEffect(() => {
    if (!open) return;
    setMode('signin');
    setEmail('');
    setPassword('');
    setPhase('idle');
    setError(null);
    setTouched(false);
    firstField.current?.focus();
  }, [open]);

  // Escape, and Tab kept inside. Both belong to the whole surface rather than
  // to any field, so they are one handler on the container.
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
      const here = document.activeElement;
      // Wrapping by hand rather than trusting the DOM order to stop at the
      // edges: the map behind is still in the tab order as far as the browser
      // is concerned, and tabbing into a form nobody can see is worse than no
      // keyboard support at all.
      if (!event.shiftKey && here === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && here === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setPage]);

  if (!open) return null;

  const emailError = touched ? emailProblem(email) : null;
  const passwordError = touched ? passwordProblem(password) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit(email, password) || !acceptsInput(phase)) return;
    setPhase('working');
    setError(null);
    try {
      const response = await (mode === 'register'
        ? register(email, password)
        : signIn(email, password));
      setPassword('');
      // Held, then the page leaves. The account is signed in by this line; the
      // pause is entirely so the person finds out (D151).
      setPhase('success');
      later(() => {
        setAccount(response?.account ?? null);
        setPage(null);
      }, motion.successHold);
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      setError(failureMessage(failure?.status ?? null, failure?.message ?? ''));
      setPassword('');
      setPhase('error');
      later(() => setPhase('idle'), motion.shake || 1);
    }
  };

  return (
    <div
      className="signin"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to Orbital"
      style={
        {
          '--panel-in': `${motion.panelIn}ms`,
          '--shake': `${motion.shake}ms`,
          '--swap': `${motion.modeSwap}ms`,
        } as React.CSSProperties
      }
    >
      <div className="signin__surface" ref={surface}>
        <div className="signin__brand">
          <img className="signin__mark" src="/logo.svg" alt="" aria-hidden="true" />
          <span className="signin__wordmark">Orbital</span>
        </div>

        {phase === 'success' ? (
          <p className="signin__welcome" role="status">
            <span className="account__tick" aria-hidden="true" />
            {successMessage(mode)}
          </p>
        ) : (
          <>
            <h1 className="signin__title">
              {mode === 'register' ? 'Create an account' : 'Sign in'}
            </h1>
            <p className="signin__lede">
              {mode === 'register'
                ? 'The free tier is the whole map. An account is for the parts that are not.'
                : 'Welcome back. The map works signed out too.'}
            </p>

            <form
              className={`signin__form ${phase === 'error' ? 'signin__form--error' : ''}`}
              onSubmit={submit}
              noValidate
            >
              {/* Keyed by mode, so React replaces the fieldset rather than
                  mutating it - which is what lets the swap animate (D151). */}
              <div className="account__fields" key={mode}>
                <label className="account__label" htmlFor="signin-email">
                  Email
                </label>
                <input
                  id="signin-email"
                  ref={firstField}
                  className="account__input"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {emailError && <p className="account__problem">{emailError}</p>}

                <label className="account__label" htmlFor="signin-password">
                  Password
                </label>
                <input
                  id="signin-password"
                  className="account__input"
                  type="password"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {passwordError && <p className="account__problem">{passwordError}</p>}
              </div>

              {error && (
                <p className="account__problem account__problem--server" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className={`account__submit ${phase === 'working' ? 'is-working' : ''}`}
                disabled={busy}
              >
                {submitLabel(phase, mode)}
              </button>

              <button
                type="button"
                className="account__switch"
                onClick={() => {
                  setMode(mode === 'signin' ? 'register' : 'signin');
                  setError(null);
                  setTouched(false);
                }}
              >
                {mode === 'signin' ? 'Create an account' : 'I already have an account'}
              </button>

              {/* The one question this page invites and could not answer:
                  what an account is actually *for* (D157). */}
              <button
                type="button"
                className="signin__aside"
                onClick={() => setPage('premium')}
              >
                What premium does →
              </button>
            </form>
          </>
        )}

        <button type="button" className="signin__back" onClick={() => setPage(null)}>
          ← Back to the map
        </button>
      </div>
    </div>
  );
}
