import { describe, expect, it } from 'vitest';

import { REGIME_RGB } from '../satelliteShell';
import { chromeFor, countLabel, satelliteBands } from './layerChrome';

const GRADIENT = ['rgb(1,1,1) 0%', 'rgb(2,2,2) 100%'];

describe('chromeFor', () => {
  it('never describes satellites as aircraft', () => {
    // The whole point: chrome is where a viewer looks to find out what they
    // are looking at, so chrome describing the wrong subject is a false
    // statement they will believe.
    const satellite = chromeFor('satellite', GRADIENT);
    const words = [
      satellite.subtitle,
      satellite.searchPlaceholder,
      satellite.countNoun.join(' '),
      satellite.scaleTitle,
      ...satellite.shapes.map((s) => s.text),
    ]
      .join(' ')
      .toLowerCase();

    expect(words).not.toContain('aircraft');
    expect(words).not.toContain('callsign');
    expect(words).not.toContain('airport');
    expect(words).not.toContain('heading');
  });

  it('offers a search example somebody could actually type', () => {
    // "UAL1234 or LHR" is useless up here - there are no callsigns and no
    // airports. The name and the catalogue number are what exist.
    const placeholder = chromeFor('satellite', GRADIENT).searchPlaceholder;
    expect(placeholder).toContain('ISS');
    expect(placeholder).toContain('25544');
  });

  it('keeps the aircraft chrome exactly as it was', () => {
    const aircraft = chromeFor('aircraft', GRADIENT);
    expect(aircraft.subtitle).toBe('live aircraft');
    expect(aircraft.searchPlaceholder).toBe('Search callsign or airport, e.g. UAL1234 or LHR');
    expect(aircraft.scaleTitle).toBe('Altitude');
  });
});

describe('the colour key', () => {
  it('uses a gradient for aircraft and bands for satellites', () => {
    // A ramp spanning 12 km saturates three orders of magnitude below orbit,
    // and even a rescaled one is useless: 97% of the catalogue sits in the
    // bottom 6% of the range.
    expect(chromeFor('aircraft', GRADIENT).scale.kind).toBe('gradient');
    expect(chromeFor('satellite', GRADIENT).scale.kind).toBe('bands');
  });

  it('labels the aircraft scale in kilometres it actually reaches', () => {
    const scale = chromeFor('aircraft', GRADIENT).scale;
    expect(scale.kind === 'gradient' && scale.ticks).toEqual(['ground', '6 km', '12 km']);
  });

  it('names an altitude for every satellite band', () => {
    // A band called "GEO" tells a reader nothing. "35,786 km" does.
    for (const band of satelliteBands().slice(0, 4)) {
      expect(band.label).toMatch(/km|beyond/);
    }
  });

  it('draws the same colours the renderers draw', () => {
    // Three places show these colours - the globe, the map and this key. If
    // they disagree, the key is lying about the picture.
    const bands = satelliteBands();
    expect(bands[0].colour).toBe(`rgb(${REGIME_RGB.LEO.join(', ')})`);
    expect(bands[2].colour).toBe(`rgb(${REGIME_RGB.GEO.join(', ')})`);
  });

  it('includes the unknown-altitude swatch, which is a real state', () => {
    expect(satelliteBands().at(-1)?.label).toBe('Altitude unknown');
    expect(satelliteBands()).toHaveLength(5);
  });
});

describe('freshness', () => {
  it('omits the age for satellites rather than printing "never"', () => {
    // A computed position has no age (D95). The status bar was rendering a
    // null age as "data age never", which reads as a fault.
    expect(chromeFor('satellite', GRADIENT).freshness).toBeNull();
    expect(chromeFor('aircraft', GRADIENT).freshness).toBe('age');
  });
});

describe('countLabel', () => {
  it('counts satellites as satellites', () => {
    expect(countLabel('satellite', 364)).toBe('364 satellites');
    expect(countLabel('aircraft', 364)).toBe('364 aircraft');
  });

  it('gets the singular right', () => {
    expect(countLabel('satellite', 1)).toBe('1 satellite');
    // "aircraft" is its own plural, which is why the pair is stored rather
    // than an "s" being appended.
    expect(countLabel('aircraft', 1)).toBe('1 aircraft');
  });

  it('separates thousands, because the catalogue runs to four figures', () => {
    expect(countLabel('satellite', 1432)).toBe('1,432 satellites');
  });
});
