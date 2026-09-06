import { describe, expect, it } from 'vitest';

import { hashFor, moveFor, pageForHash } from './pageRoute';

describe('the address a page has', () => {
  it('recognises each page by its hash', () => {
    for (const page of ['signin', 'premium', 'system'] as const) {
      expect(pageForHash(hashFor(page)), page).toBe(page);
    }
  });

  it('recognises one without the hash character', () => {
    // Some clients hand the hash back bare; both spellings mean the same page.
    expect(pageForHash('signin')).toBe('signin');
  });

  it('ignores case', () => {
    expect(pageForHash('#Premium')).toBe('premium');
  });

  it('is not fooled by something that merely contains a name', () => {
    expect(pageForHash('#signing-off')).toBeNull();
    expect(pageForHash('#premium-plus')).toBeNull();
    expect(pageForHash('#not-signin')).toBeNull();
  });

  it('treats no hash at all as the map', () => {
    expect(pageForHash('')).toBeNull();
    expect(pageForHash('#')).toBeNull();
  });

  it('gives every page a distinct address', () => {
    const hashes = (['signin', 'premium', 'system'] as const).map(hashFor);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('what happens to the history stack', () => {
  it('pushes when a page opens, so Back has something to pop', () => {
    expect(moveFor('signin', null)).toBe('push');
  });

  it('goes back when a page is closed some other way', () => {
    // The bug this prevents: closing with the button while leaving the pushed
    // entry in place. Open and dismiss five times and Back then appears to do
    // nothing five times running.
    expect(moveFor(null, 'signin')).toBe('back');
  });

  it('replaces when moving straight from one page to another', () => {
    // The two are siblings, not a trail. Reaching premium from the sign-in
    // page and pressing Back should return to the map, not walk backwards
    // through every page visited on the way (D157).
    expect(moveFor('premium', 'signin')).toBe('replace');
    expect(moveFor('signin', 'premium')).toBe('replace');
  });

  it('does nothing when the address already agrees', () => {
    // Both directions. Without this, arriving *via* Back would push a new
    // entry for the state Back just reached, which is a loop.
    expect(moveFor('signin', 'signin')).toBe('none');
    expect(moveFor(null, null)).toBe('none');
  });
});
