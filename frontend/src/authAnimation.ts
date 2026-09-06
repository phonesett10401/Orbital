/**
 * The shape of signing in, over time (D151).
 *
 * The sign-in itself was built in D146-D148 and is not changed here. What was
 * missing is that it had no *moments*: a form appeared, and then it was gone,
 * and the only way to tell a success from a failure was that the panel was no
 * longer there. This module holds the phases and their durations so they can be
 * tested, and `AccountMenu` stays a component that renders them.
 *
 * ## Why a success is held on screen at all
 *
 * The honest answer is that it is not for the machine - the account is already
 * signed in by then. It is for the person: an interface that closes the instant
 * it succeeds leaves somebody wondering whether it did, and the cheapest way to
 * answer that is to say so for a moment before getting out of the way. Under a
 * second, because it is confirmation, not celebration.
 *
 * ## Every duration collapses to zero for a reader who asked it to
 *
 * Not "smaller" and not "faster" - zero, so the flow is the same flow with no
 * movement in it. `prefers-reduced-motion` is set by people for whom animation
 * causes nausea or a vestibular attack; an interface that keeps a *little* of
 * the motion has misunderstood what was asked. The one thing that must survive
 * is the success message, because that carries meaning rather than delight -
 * so it is held, it simply does not slide.
 */

/** Where the form is in its own story. */
export type AuthPhase = 'idle' | 'working' | 'success' | 'error';

export interface Timings {
  /** The panel opening from the button. */
  panelIn: number;
  /** Crossfading between "sign in" and "create an account". */
  modeSwap: number;
  /** How long "you are in" stays before the panel leaves. */
  successHold: number;
  /** The refusal shake. */
  shake: number;
}

export const MOTION: Timings = {
  panelIn: 260,
  modeSwap: 190,
  successHold: 900,
  shake: 420,
};

/**
 * The same phases with nothing moving.
 *
 * `successHold` survives at a shortened length rather than going to zero: it is
 * the one duration that carries information rather than decoration, and a
 * confirmation nobody can read is not a kindness.
 */
export const STILL: Timings = {
  panelIn: 0,
  modeSwap: 0,
  successHold: 500,
  shake: 0,
};

export function timings(reducedMotion: boolean): Timings {
  return reducedMotion ? STILL : MOTION;
}

/** The modifier the panel wears, so the CSS has one thing to match on. */
export function phaseClass(phase: AuthPhase): string {
  return phase === 'idle' ? '' : `account__panel--${phase}`;
}

/** Whether the form should be taking input in this phase. */
export function acceptsInput(phase: AuthPhase): boolean {
  // Not during a submission, and not once it has succeeded - the panel is on
  // its way out and a second submission would race the close.
  return phase === 'idle' || phase === 'error';
}

/**
 * What the panel says at the moment it works.
 *
 * Two different events wearing one word would be a missed opportunity and, more
 * to the point, slightly wrong: somebody registering has not "come back".
 */
export function successMessage(mode: 'signin' | 'register'): string {
  return mode === 'register' ? 'Welcome to Orbital' : 'Welcome back';
}

/**
 * The label on the submit button for a phase.
 *
 * The working state says what is happening rather than going blank, because a
 * button that empties looks broken and one that says "Working…" looks busy.
 */
export function submitLabel(phase: AuthPhase, mode: 'signin' | 'register'): string {
  if (phase === 'working') return 'Working…';
  if (phase === 'success') return 'Signed in';
  return mode === 'register' ? 'Create account' : 'Sign in';
}
