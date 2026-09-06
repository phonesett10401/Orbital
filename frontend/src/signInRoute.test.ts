import { describe, expect, it } from 'vitest';

import { SIGN_IN_HASH, moveFor, opensSignIn } from './signInRoute';

describe('the address the page has', () => {
  it('recognises its own hash', () => {
    expect(opensSignIn(SIGN_IN_HASH)).toBe(true);
  });

  it('recognises it without the hash character', () => {
    // Some clients hand the hash back bare; both spellings mean the same page.
    expect(opensSignIn('signin')).toBe(true);
  });

  it('ignores case', () => {
    expect(opensSignIn('#SignIn')).toBe(true);
  });

  it('is not fooled by something that merely contains it', () => {
    expect(opensSignIn('#signing-off')).toBe(false);
    expect(opensSignIn('#not-signin')).toBe(false);
  });

  it('treats no hash at all as the map', () => {
    expect(opensSignIn('')).toBe(false);
    expect(opensSignIn('#')).toBe(false);
  });
});

describe('what happens to the history stack', () => {
  it('pushes when the page opens, so Back has something to pop', () => {
    expect(moveFor(true, false)).toBe('push');
  });

  it('goes back when the page is closed some other way', () => {
    // The bug this prevents: closing with the button while leaving the pushed
    // entry in place. Open and dismiss five times and Back then appears to do
    // nothing five times running.
    expect(moveFor(false, true)).toBe('back');
  });

  it('does nothing when the address already agrees', () => {
    // Both directions. Without this, arriving *via* Back would push a new
    // entry for the state Back just reached, which is a loop.
    expect(moveFor(true, true)).toBe('none');
    expect(moveFor(false, false)).toBe('none');
  });
});
