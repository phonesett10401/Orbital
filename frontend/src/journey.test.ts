import { describe, expect, it } from 'vitest';

import {
  JOURNEY_MAX_MS,
  JOURNEY_MIN_MS,
  JOURNEY_MS,
  journeyHoldDone,
  journeyLabel,
  journeyMs,
} from './journey';

describe('what the screen says', () => {
  it('names the solar system on the way out', () => {
    expect(journeyLabel('system', 'Earth')).toBe('Heading to the solar system');
  });

  it('names the world on the way in', () => {
    expect(journeyLabel('planet', 'Mars')).toBe('Heading to Mars');
    expect(journeyLabel('planet', 'Earth')).toBe('Heading to Earth');
  });

  it('never claims anything is loading', () => {
    // Nothing is fetched at either end - the positions are computed and the
    // layer is already there - so a loading screen would be a lie about why the
    // view is changing, told where the reader has nothing else to look at.
    for (const text of [journeyLabel('system', 'Earth'), journeyLabel('planet', 'Mars')]) {
      expect(text.toLowerCase()).not.toMatch(/load|wait|please/);
    }
  });
});

describe('how long it is held', () => {
  it('is long enough to read four words', () => {
    // It used to be asserted against the camera settle it covered. There is no
    // settle any more - the two views are separate pages (D164) - so what is
    // left is the only thing that was ever really being claimed.
    expect(JOURNEY_MS).toBeGreaterThanOrEqual(800);
  });

  it('is short enough never to be a wait', () => {
    expect(JOURNEY_MS).toBeLessThanOrEqual(1_500);
  });

  it('still shows the words when movement is turned down', () => {
    // The screen carries a sentence, which is information rather than
    // decoration - taking it to zero would remove the answer to "what just
    // happened", not just the animation.
    expect(journeyMs(true)).toBeGreaterThan(0);
    expect(journeyMs(true)).toBeLessThan(journeyMs(false));
  });
});

describe('holding the screen until the destination is ready', () => {
  it('will not lift on the outward trip before the floor, however ready', () => {
    // A page ready in 40ms must still not flash four words and vanish.
    expect(journeyHoldDone('system', 200, true, false)).toBe(false);
    expect(journeyHoldDone('system', JOURNEY_MIN_MS, true, false)).toBe(true);
  });

  it('waits past the floor while the destination is still building', () => {
    // The defect. The screen ran a fixed clock while the page opened in the
    // same tick, so on a slow machine the words showed for a tenth of a second
    // and the stall happened in the open.
    expect(journeyHoldDone('system', 3000, false, false)).toBe(false);
    expect(journeyHoldDone('system', 3000, true, false)).toBe(true);
  });

  it('lifts anyway at the ceiling, because a hang is worse than a seam', () => {
    expect(journeyHoldDone('system', JOURNEY_MAX_MS, false, false)).toBe(true);
  });

  it('keeps the fixed clock coming back, which needs no signal', () => {
    // The planet view never unmounted; there is nothing to wait for.
    expect(journeyHoldDone('planet', JOURNEY_MS - 1, false, false)).toBe(false);
    expect(journeyHoldDone('planet', JOURNEY_MS, false, false)).toBe(true);
  });

  it('shortens the return for reduced motion, as it always did', () => {
    expect(journeyHoldDone('planet', 700, false, true)).toBe(true);
    expect(journeyHoldDone('planet', 700, false, false)).toBe(false);
  });
});
