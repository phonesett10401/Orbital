import { describe, expect, it } from 'vitest';

import {
  MIN_PASSWORD_LENGTH,
  canSubmit,
  emailProblem,
  failureMessage,
  isPremium,
  passwordProblem,
  tierLabel,
} from './auth';

describe('the address check', () => {
  it('accepts an ordinary address', () => {
    expect(emailProblem('phone@example.com')).toBeNull();
  });

  it('accepts the unusual ones a stricter grammar would reject', () => {
    // The reason it is this loose: the only real validation is sending a
    // message, which Orbital does not do, so a stricter rule would turn away
    // real people to prove nothing (D147).
    expect(emailProblem('phone+orbital@example.co.uk')).toBeNull();
    expect(emailProblem("o'brien@example.com")).toBeNull();
    expect(emailProblem('really.long.name@sub.domain.example')).toBeNull();
  });

  it('turns away what is plainly not an address', () => {
    for (const bad of ['', '   ', 'nobody', '@example.com', 'phone@', 'a@b@c']) {
      expect(emailProblem(bad), bad).not.toBeNull();
    }
  });

  it('turns away an address with a space in it', () => {
    expect(emailProblem('no body@example.com')).not.toBeNull();
  });
});

describe('the password check', () => {
  it('asks only for length', () => {
    // Composition rules push people towards `Password1!`, which is worse than
    // four more characters.
    expect(passwordProblem('a good long password')).toBeNull();
    expect(passwordProblem('aaaaaaaaaaaaaaa')).toBeNull();
  });

  it('says how many characters are needed rather than "too short"', () => {
    const problem = passwordProblem('short');
    expect(problem).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('rejects exactly one character below the limit', () => {
    // The boundary, because an off-by-one here disagrees with the server and
    // produces a form that submits and is refused.
    expect(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull();
    expect(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });
});

describe('whether the form may be sent', () => {
  it('needs both halves to be right', () => {
    expect(canSubmit('phone@example.com', 'a good long password')).toBe(true);
    expect(canSubmit('nobody', 'a good long password')).toBe(false);
    expect(canSubmit('phone@example.com', 'short')).toBe(false);
  });
});

describe('what the reader is told when it fails', () => {
  it('keeps the server’s own words, which are vague on purpose', () => {
    // A taken address and a wrong password are phrased so as not to confirm
    // whether an account exists. Rewriting them here would undo that on the
    // last step (D147).
    expect(failureMessage(401, 'email or password is wrong')).toBe(
      'email or password is wrong',
    );
    expect(failureMessage(409, 'that address cannot be registered')).toBe(
      'that address cannot be registered',
    );
  });

  it('explains a lockout rather than repeating a refusal', () => {
    expect(failureMessage(429, '')).toMatch(/wait/i);
  });

  it('does not blame the reader for a server fault', () => {
    expect(failureMessage(500, 'Internal Server Error')).toMatch(/Orbital had a problem/);
  });

  it('names the network when the backend cannot be reached', () => {
    expect(failureMessage(null, '')).toMatch(/connection/i);
  });
});

describe('tiers', () => {
  it('writes them the way the chrome does', () => {
    expect(tierLabel('premium')).toBe('Premium');
    expect(tierLabel('free')).toBe('Free');
  });

  it('treats an unknown tier as free rather than showing it raw', () => {
    // A tier added on the server and not yet known here must not appear in the
    // interface as a word nobody chose.
    expect(tierLabel('enterprise-trial')).toBe('Free');
  });

  it('treats being signed out exactly as being free', () => {
    // The free tier is the product, not a degraded state, so a signed-out
    // reader is not an error anywhere.
    expect(isPremium(null)).toBe(false);
    expect(isPremium({ email: 'a@b.com', tier: 'free' })).toBe(false);
    expect(isPremium({ email: 'a@b.com', tier: 'premium' })).toBe(true);
  });
});
