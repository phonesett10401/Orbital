/**
 * What the sign-in form decides, apart from how it looks (D148).
 *
 * There is no component-render harness in this project, so the judgements live
 * here where they can be tested and the component stays thin - the same shape
 * `moonFacts`, `satelliteFacts` and `routeSummary` already have.
 *
 * ## The client checks nothing the server does not
 *
 * Every rule here is also enforced in `app/api/auth.py`, and that is the only
 * reason it is safe to have them: a check in the browser is a **courtesy**, not
 * a control. It exists to say "that password is too short" without a round
 * trip, and anybody who removes it still cannot register a short password.
 *
 * Stating that matters because the opposite mistake is common and invisible:
 * validation that exists only in the client looks identical to validation until
 * somebody posts to the endpoint directly.
 */

/** Matches the backend's `MIN_PASSWORD_LENGTH`. */
export const MIN_PASSWORD_LENGTH = 10;

export interface Account {
  email: string;
  tier: string;
}

/**
 * Why this address will not do, or null if it is fine.
 *
 * The same shape check the backend makes, and for the same reason it is not
 * stricter: **the only real validation of an address is sending a message to
 * it**, which Orbital does not do, so a stricter grammar would reject valid
 * unusual addresses and prove nothing (D147).
 */
export function emailProblem(email: string): string | null {
  const candidate = email.trim();
  if (!candidate) return 'An email address is required.';
  const [local, ...rest] = candidate.split('@');
  if (rest.length !== 1 || !local || !rest[0]) {
    return 'That does not look like an email address.';
  }
  if (/\s/.test(candidate)) return 'An address cannot contain spaces.';
  return null;
}

/**
 * Why this password will not do, or null.
 *
 * Length only. Composition rules - a number, a capital, a symbol - push people
 * towards `Password1!` and are worth less than four more characters, which is
 * why the backend does not impose them either.
 */
export function passwordProblem(password: string): string | null {
  if (!password) return 'A password is required.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** Whether the form may be submitted at all. */
export function canSubmit(email: string, password: string): boolean {
  return emailProblem(email) === null && passwordProblem(password) === null;
}

/**
 * What to show the reader when the server refuses.
 *
 * The server's own words are used wherever it gave them, because they are
 * deliberately vague in the places that matter - a taken address and a wrong
 * password are both phrased so as not to confirm whether an account exists
 * (D147). Rewriting them here would undo that on the last step.
 */
export function failureMessage(status: number | null, detail: string): string {
  if (status === null) return 'Cannot reach Orbital. Check your connection.';
  if (status === 429) return detail || 'Too many attempts. Wait a few minutes.';
  if (status >= 500) return 'Orbital had a problem. Try again in a moment.';
  return detail || 'That did not work.';
}

/**
 * Tiers that get everything a paid account gets.
 *
 * **Admin is in here rather than being special-cased at each gate.** A check
 * written `tier === 'premium'` gives an administrator *less* than a paying
 * customer and does it silently: the account works, it is simply short of what
 * it should have, and nothing reports a fault. The backend keeps the same set
 * for the same reason (D152).
 */
const PAID = new Set(['premium', 'admin']);

/** How a tier is written in the chrome. */
export function tierLabel(tier: string): string {
  if (tier === 'admin') return 'Admin';
  return tier === 'premium' ? 'Premium' : 'Free';
}

/**
 * Whether an account may use a premium feature.
 *
 * One function, so the answer cannot differ between the places that ask. A
 * signed-out reader is treated exactly as a free one rather than as an error:
 * the free tier is the product, not a degraded state.
 */
export function isPremium(account: Account | null): boolean {
  return account !== null && PAID.has(account.tier);
}
