/**
 * Signing in, and saying who is signed in (D148), with the moments it was
 * missing (D151).
 *
 * One control in the header: a button that opens a small panel, holding either
 * the form or the account. Every judgement it makes lives in `auth.ts` and
 * `authAnimation.ts`, so this decides only what appears where.
 *
 * ## It says nothing until it knows
 *
 * `accountChecked` gates the whole control. Without it the header renders
 * "Sign in" on every page load and then corrects itself a moment later, which
 * reads as being signed out and then signed back in - alarming for exactly the
 * people who care whether they are signed in.
 *
 * ## The animation is a phase machine, not a pile of booleans
 *
 * `busy` used to be the only thing this component knew about time, and it could
 * not tell a success from a failure: both ended with the form enabled again. A
 * phase can, which is what lets the panel hold a welcome for a moment before it
 * leaves, and shake when it is refused (D151).
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError, fetchMe, register, signIn, signOut } from '../api/client';
import { canSubmit, emailProblem, failureMessage, passwordProblem, tierLabel } from '../auth';
import {
  type AuthPhase,
  acceptsInput,
  phaseClass,
  submitLabel,
  successMessage,
  timings,
} from '../authAnimation';
import { prefersReducedMotion } from '../motion';
import { useOrbitalStore } from '../state/store';

type Mode = 'signin' | 'register';

export function AccountMenu() {
  const account = useOrbitalStore((s) => s.account);
  const accountChecked = useOrbitalStore((s) => s.accountChecked);
  const setAccount = useOrbitalStore((s) => s.setAccount);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<AuthPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const motion = timings(prefersReducedMotion());
  const busy = phase === 'working' || phase === 'success';

  // Every timer this component starts, cleared on unmount, so a panel that
  // closed mid-flight cannot wake up later and set state on a component that is
  // no longer there.
  const timers = useRef<number[]>([]);
  const later = (run: () => void, ms: number) => {
    timers.current.push(window.setTimeout(run, ms));
  };
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  // Asked once, on load. A 200 with a null account is the ordinary answer, so
  // this is not an error path (D147).
  useEffect(() => {
    const controller = new AbortController();
    fetchMe(controller.signal)
      .then((response) => setAccount(response.account))
      .catch(() => setAccount(null));
    return () => controller.abort();
  }, [setAccount]);

  const close = () => {
    setOpen(false);
    setError(null);
    setPassword('');
    setTouched(false);
    setPhase('idle');
    // **And back to signing in.** Found by using it: register once, sign out,
    // and the panel reopened still in register mode - so the correct password
    // was sent to `/register` and refused with "that address cannot be
    // registered", which is both baffling and, being deliberately vague, no
    // help at all. Signing in is the common case every time after the first
    // (D148).
    setMode('signin');
  };

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
      // **Held, then closed.** The account is signed in by this line already;
      // the pause is entirely so the person finds out. A panel that vanishes
      // the instant it works leaves somebody wondering whether it did (D151).
      setPhase('success');
      later(() => {
        setAccount(response?.account ?? null);
        close();
      }, motion.successHold);
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      setError(failureMessage(failure?.status ?? null, failure?.message ?? ''));
      setPassword('');
      setPhase('error');
      // Back to idle when the shake is over, so the panel is not left wearing a
      // refusal it has finished expressing. The message stays; only the
      // movement ends. Leaving the form disabled after a failure is how a
      // sign-in becomes unrecoverable without a reload (D148).
      later(() => setPhase('idle'), motion.shake || 1);
    }
  };

  const leave = async () => {
    setPhase('working');
    try {
      await signOut();
    } catch {
      // Sign-out is not worth an error message. The cookie is cleared by the
      // server, and if the request never arrived the session expires anyway.
    } finally {
      setAccount(null);
      close();
    }
  };

  if (!accountChecked) return null;

  const emailError = touched ? emailProblem(email) : null;
  const passwordError = touched ? passwordProblem(password) : null;

  return (
    <div className="account">
      <button
        type="button"
        className={`account__button ${account ? 'is-signed-in' : ''}`}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {account ? tierLabel(account.tier) : 'Sign in'}
      </button>

      {open && (
        <div
          className={`account__panel ${phaseClass(phase)}`}
          role="dialog"
          aria-label="Account"
          style={
            {
              '--panel-in': `${motion.panelIn}ms`,
              '--shake': `${motion.shake}ms`,
              '--swap': `${motion.modeSwap}ms`,
            } as React.CSSProperties
          }
        >
          {account ? (
            <>
              <p className="account__email">{account.email}</p>
              <p className="account__tier">{tierLabel(account.tier)} account</p>
              <button type="button" className="account__submit" onClick={leave} disabled={busy}>
                Sign out
              </button>
            </>
          ) : phase === 'success' ? (
            /*
              The welcome replaces the form rather than sitting above it.
              Leaving a filled-in form visible behind a "you are in" message
              asks the reader to work out which of the two is true.
            */
            <p className="account__welcome" role="status">
              <span className="account__tick" aria-hidden="true" />
              {successMessage(mode)}
            </p>
          ) : (
            <form onSubmit={submit} noValidate>
              {/* Keyed by the mode, so React replaces the fieldset rather than
                  mutating it - which is what lets the swap animation run at all
                  when somebody switches to registering. */}
              <div className="account__fields" key={mode}>
                <label className="account__label" htmlFor="account-email">
                  Email
                </label>
                <input
                  id="account-email"
                  className="account__input"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {emailError && <p className="account__problem">{emailError}</p>}

                <label className="account__label" htmlFor="account-password">
                  Password
                </label>
                <input
                  id="account-password"
                  className="account__input"
                  type="password"
                  // The browser's password manager is the reason people use long
                  // passwords at all; telling it which action this is lets it
                  // offer to store one.
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

              <button type="submit" className="account__submit" disabled={busy}>
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
            </form>
          )}
        </div>
      )}
    </div>
  );
}
