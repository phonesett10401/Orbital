import { describe, expect, it } from 'vitest';

import {
  FAMILY_LABEL,
  familyFor,
  type SatelliteFamily,
} from '../satelliteFamily';
import { FAMILY_ICON, ICON_UNIDENTIFIED, iconFor } from './satelliteSprite';

// Names taken verbatim from the live catalogue on 2026-09-01, including the
// unidentified ones, so this is tested against what actually arrives.
const LIVE = [
  'IRIDIUM 113',
  'STARLINK-4621',
  'ISS (ZARYA)',
  'CLUSTER II-FM8',
  'NOAA 19',
  'FENGYUN 3F',
  'CBERS-4',
  'GAOFEN DUOMO (GFDM)',
  'SINOD-D 1',
  'OBJECT AN',
  'OBJECT AQ',
  'OBJECT C',
  'OBJECT W',
];

describe('familyFor', () => {
  it('recognises the families in a real screenful', () => {
    expect(familyFor('ISS (ZARYA)')).toBe('station');
    expect(familyFor('STARLINK-4621')).toBe('constellation');
    expect(familyFor('IRIDIUM 113')).toBe('constellation');
    expect(familyFor('NOAA 19')).toBe('observation');
    expect(familyFor('FENGYUN 3F')).toBe('observation');
    expect(familyFor('CBERS-4')).toBe('observation');
    expect(familyFor('CLUSTER II-FM8')).toBe('probe');
  });

  it('recognises navigation and geostationary comms', () => {
    expect(familyFor('GPS BIIR-2 (PRN 13)')).toBe('navigation');
    expect(familyFor('GALILEO 25')).toBe('navigation');
    expect(familyFor('INMARSAT 4-F1')).toBe('geoComms');
    expect(familyFor('RADUGA 1M-2')).toBe('geoComms');
  });

  it('refuses to invent a machine for an unidentified object', () => {
    // The catalogue is full of these. Drawing one with panels and a dish would
    // be claiming a spacecraft that nobody has identified - the same rule as
    // the no-heading disc and the airframe guard (D18, D96, D101).
    for (const name of ['OBJECT AN', 'OBJECT AQ', 'OBJECT C', 'OBJECT W']) {
      expect(familyFor(name)).toBe('unidentified');
      expect(iconFor(name)).toBe(ICON_UNIDENTIFIED);
    }
  });

  it('treats a name it does not know as unidentified rather than guessing', () => {
    expect(familyFor('SOME UNLISTED THING 7')).toBe('unidentified');
    expect(familyFor('')).toBe('unidentified');
    expect(familyFor(null)).toBe('unidentified');
  });

  it('OBJECT wins even when the string contains a family word', () => {
    // Debris from a Starlink launch is catalogued as an OBJECT, and it is not
    // a Starlink. The explicit marker has to beat the substring.
    expect(familyFor('OBJECT STARLINK DEB')).toBe('unidentified');
  });

  it('is case insensitive, because catalogues are inconsistent', () => {
    expect(familyFor('starlink-4621')).toBe('constellation');
    expect(familyFor('Noaa 19')).toBe('observation');
  });

  it('assigns something to every name in a real screenful', () => {
    for (const name of LIVE) {
      expect(Object.keys(FAMILY_ICON)).toContain(familyFor(name));
    }
  });

  it('does not put everything in one bucket', () => {
    // Guards against a regex that matches too much, which would make the
    // shapes decorative rather than informative.
    const families = new Set(LIVE.map(familyFor));
    expect(families.size).toBeGreaterThanOrEqual(4);
  });
});

describe('the icon set', () => {
  it('gives every family its own image, or two families would be one shape', () => {
    const ids = Object.values(FAMILY_ICON);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('labels every family in words for the key and the panel', () => {
    for (const family of Object.keys(FAMILY_ICON) as SatelliteFamily[]) {
      expect(FAMILY_LABEL[family]).toBeTruthy();
    }
  });

  it('names the unidentified family honestly', () => {
    // Not "Other" or "Misc" - the catalogue genuinely does not know what these
    // are, and the key should say so.
    expect(FAMILY_LABEL.unidentified).toBe('Unidentified object');
  });
});
