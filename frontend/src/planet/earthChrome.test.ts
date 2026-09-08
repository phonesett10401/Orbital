/**
 * The two controls that only mean something on Earth (D169).
 *
 * Both defects these tests describe were found by pressing the buttons on
 * another world, which is the only way they could have been found: nothing
 * failed, no test noticed, and the map answered the press each time.
 */

import { describe, expect, it } from 'vitest';

import { bodyChromeFor } from './earthChrome';

const reader = { basemap: 'flat', night: true } as const;

describe('what the reader asked for, on the world underneath', () => {
  it('gives the reader exactly what they set, on Earth', () => {
    expect(bodyChromeFor('earth', reader)).toEqual({
      basemap: 'flat',
      night: true,
      controlsAvailable: true,
    });
  });

  it('refuses night on another world, whatever the reader set', () => {
    // The defect. Night is Earth's terminator over a texture of Earth's city
    // lights, and the toggle wrote it with no idea which world was below - so
    // pressing it over Mars drew Earth's night side and the lights of
    // southeast Asia across the Martian surface.
    for (const body of ['moon', 'mars', 'mercury']) {
      expect(bodyChromeFor(body, reader).night, body).toBe(false);
    }
  });

  it('refuses the plain and dark basemaps on another world', () => {
    // Both are Earth's vector cartography, which is switched off when the
    // camera leaves. Choosing one on the Moon left the background layer and
    // nothing else: a blank grey disc where the mosaic had been.
    for (const body of ['moon', 'mars', 'mercury']) {
      expect(bodyChromeFor(body, reader).basemap, body).toBe('imagery');
      expect(bodyChromeFor(body, { basemap: 'dark', night: false }).basemap, body).toBe('imagery');
    }
  });

  it('hides both controls rather than leaving them to do nothing', () => {
    expect(bodyChromeFor('mars', reader).controlsAvailable).toBe(false);
    expect(bodyChromeFor('earth', reader).controlsAvailable).toBe(true);
  });

  it('gives the setting back on returning to Earth', () => {
    // Not a refinement - a second bug in the same lines. The old code restored
    // `config.terminator` when the camera came home, so a reader who turned
    // night on, visited Mars and came back found it off again and no reason
    // given. Nothing is stored here, so there is nothing to restore wrongly.
    const away = bodyChromeFor('mars', reader);
    expect(away.night).toBe(false);
    expect(bodyChromeFor('earth', reader).night).toBe(true);
    expect(bodyChromeFor('earth', reader).basemap).toBe('flat');
  });

  it('treats an unknown body as not-Earth', () => {
    // The safe direction, and the one the D133 inversion chose for layers: a
    // world nobody has written yet gets Earth's chrome switched off rather
    // than switched on.
    expect(bodyChromeFor('planet-nine', reader)).toEqual({
      basemap: 'imagery',
      night: false,
      controlsAvailable: false,
    });
  });
});
