/**
 * Signing in, and saying who is signed in (D148).
 *
 * One control in the header: a button that opens a small panel, holding either
 * the form or the account. Every judgement it makes lives in `auth.ts`, so this
 * decides only what appears where.
 *
 * ## It says nothing until it knows
 *
 * `accountChecked` gates the whole control. Without it the header renders
 * "Sign in" on every page load and then corrects itself a moment later, which
 * reads as being signed out and then signed back in - alarming for exactly the
 * people who care whether they are signed in.
 */

import { useEffect, useState } from 'react';

import { ApiError, fetchMe, register, signIn, signOut } from '../api/client';
import { canSubmit, emailProblem, failureMessage, passwordProblem, tierLabel } from '../auth';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

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
    if (!canSubmit(email, password) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await (mode === 'register'
        ? register(email, password)
        : signIn(email, password));
      setAccount(response?.account ?? null);
      close();
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      setError(failureMessage(failure?.status ?? null, failure?.message ?? ''));
    } finally {
      // Always: leaving the form disabled after a failure is how a sign-in
      // becomes unrecoverable without a reload.
      setBusy(false);
      setPassword('');
    }
  };

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
        <div className="account__panel" role="dialog" aria-label="Account">
          {account ? (
            <>
              <p className="account__email">{account.email}</p>
              <p className="account__tier">{tierLabel(account.tier)} account</p>
              <button
                type="button"
                className="account__submit"
                onClick={leave}
                disabled={busy}
              >
                Sign out
              </button>
            </>
          ) : (
            <form onSubmit={submit} noValidate>
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

              {error && (
                <p className="account__problem account__problem--server" role="alert">
                  {error}
                </p>
              )}

              <button type="submit" className="account__submit" disabled={busy}>
                {busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
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
