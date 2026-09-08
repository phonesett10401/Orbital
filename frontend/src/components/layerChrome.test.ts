import { describe, expect, it } from 'vitest';

import { REGIME_RGB } from '../satelliteShell';
import { chromeFor, countLabel, sampleReason, sampleScope, satelliteBands } from './layerChrome';
import { LAYERS } from '../state/store';

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

describe('the ships chrome', () => {
  it('never describes ships as aircraft', () => {
    // The same guard the satellite chrome has, and it caught the same thing:
    // "live aircraft" over a harbour is a false statement of the kind a
    // reader believes, because chrome is where they look to find out what is
    // on screen.
    const ship = chromeFor('ship', GRADIENT);
    const words = [
      ship.subtitle,
      ship.searchPlaceholder,
      ship.countNoun.join(' '),
      ship.scaleTitle,
    ]
      .join(' ')
      .toLowerCase();

    expect(words).not.toContain('aircraft');
    expect(words).not.toContain('callsign');
    expect(words).not.toContain('airport');
    expect(words).not.toContain('satellite');
  });

  it('does not claim to show every ship at sea', () => {
    // **This asserted "Baltic" and the assertion went stale in one session.**
    // It was right while Digitraffic was the only source (D165); the global
    // stream added 17,848 vessels and made it false (D166).
    //
    // What replaces it is the claim that actually needs guarding, and it
    // survives another source being added: both feeds are *terrestrial* AIS,
    // listening from the shore, so the Indian Ocean returned 2 vessels and the
    // Gulf returned 0. "live ships" would read as completeness over an empty
    // ocean - the one statement on this layer that would be actively
    // misleading rather than merely thin.
    const subtitle = chromeFor('ship', GRADIENT).subtitle;
    expect(subtitle).toContain('coastal');
    expect(subtitle).not.toMatch(/^live ships$/);
  });

  it('offers a search example somebody could actually type', () => {
    const placeholder = chromeFor('ship', GRADIENT).searchPlaceholder;
    expect(placeholder).toMatch(/MMSI/i);
    expect(placeholder).not.toMatch(/callsign/i);
  });

  it('colours by vessel type rather than by height or speed', () => {
    // Every ship is at sea level and four fifths of them are stopped, so both
    // of the scales the other two layers use would paint the whole fleet one
    // colour and say nothing (D165).
    const scale = chromeFor('ship', GRADIENT).scale;
    expect(scale.kind).toBe('bands');
    expect(chromeFor('ship', GRADIENT).scaleTitle).toBe('Vessel type');
  });

  it('reports an age, because a ship is observed rather than computed', () => {
    // The satellite layer reports none: a computed position has no age (D95).
    // A ship's is a real observation by a real receiver, so it does.
    expect(chromeFor('ship', GRADIENT).freshness).toBe('age');
  });

  it('counts ships, singular and plural', () => {
    expect(countLabel('ship', 1)).toBe('1 ship');
    expect(countLabel('ship', 642)).toBe('642 ships');
  });
});

describe('the key draws the right shape for its layer', () => {
  it('shows a hull for ships, not an aeroplane', () => {
    // The words "bow points the way it is pointing" beside an aircraft
    // silhouette is a false statement about the subject, made in the one place
    // a reader goes to decode the map (D165). It was an aeroplane at first,
    // because the glyph type had only three values and one of them was close
    // enough to reuse.
    const glyphs = chromeFor('ship', GRADIENT).shapes.map((s) => s.glyph);
    expect(glyphs).toContain('ship');
    expect(glyphs).not.toContain('aircraft');
  });

  it('leaves the aircraft key drawing an aircraft', () => {
    const glyphs = chromeFor('aircraft', GRADIENT).shapes.map((s) => s.glyph);
    expect(glyphs).toContain('aircraft');
    expect(glyphs).not.toContain('ship');
  });
});

describe('what the footer says about a thinned result', () => {
  it('says "in view" only for a layer that asked for the view', () => {
    // The sentence that hid D167 for a session. Ships were fetched unscoped
    // and thinned across the planet - 37 drawn of 9,159 over the North Sea -
    // and the footer said "showing a sample of 9,159 in view" throughout,
    // which is what a healthy viewport-scoped layer says. Nothing failed, no
    // test noticed, and the sea simply looked empty.
    expect(sampleScope(true)).toBe('in view');
    expect(sampleScope(false)).toBe('from across the whole planet');
  });

  it('matches every layer against the way it is actually fetched', () => {
    // Read from the registry rather than restated, so a layer whose scoping
    // changes cannot keep the old sentence. Satellites are the unscoped one:
    // 1,427 against a cap of 2,000, correct until the number moves.
    const byId = Object.fromEntries(LAYERS.map((l) => [l.id, l]));
    expect(sampleScope(byId.aircraft.viewportScoped)).toBe('in view');
    expect(sampleScope(byId.ship.viewportScoped)).toBe('in view');
    expect(sampleScope(byId.satellite.viewportScoped)).toBe('from across the whole planet');
  });

  it('explains the unscoped case rather than blaming rendering speed', () => {
    // "thinned to keep rendering fast" is true of a viewport-scoped layer and
    // misleading of an unscoped one, where the reason the map looks empty is
    // that the sample was taken from the whole planet.
    expect(sampleReason(true)).toContain('rendering fast');
    expect(sampleReason(false)).toContain('whole planet');
  });
});
