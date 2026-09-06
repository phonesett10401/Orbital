import { describe, expect, it } from 'vitest';

import { JOURNEY_MS, journeyLabel, journeyMs } from './journey';
import { settleMs } from './viewSettle';

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
  it('outlasts the camera move it covers', () => {
    // A transition screen that lifts while the view behind it is still moving
    // shows the reader the seam it exists to cover.
    expect(JOURNEY_MS).toBeGreaterThan(settleMs(false));
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
