import { describe, expect, it } from 'vitest';

import {
  FAMILY_LABEL,
  familyFor,
  type SatelliteFamily,
} from '../satelliteFamily';
import {
  ATLAS_CELLS,
  ATLAS_ORDER,
  FAMILY_ICON,
  ICON_UNIDENTIFIED,
  atlasCellFor,
  iconFor,
} from './satelliteSprite';

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

  it('calls a named satellite a satellite, even when it knows no more', () => {
    // The defect this replaced: 1,008 of 1,432 live objects - 70% - were
    // labelled "Unidentified object" because they were not in the pattern
    // list. CUBEBUG 1 has a name, a catalogue number and a mission; what it
    // lacks is an entry here, which is a fact about this code.
    for (const name of ['CUBEBUG 1', 'NEMO-HD', "ES'HAIL 2", 'ALSAT 1N', 'DIWATA 2B']) {
      expect(familyFor(name)).toBe('satellite');
    }
  });

  it('keeps unidentified for what the catalogue itself cannot name', () => {
    expect(familyFor('OBJECT AN')).toBe('unidentified');
    expect(familyFor('TBA - TO BE ASSIGNED')).toBe('unidentified');
    expect(familyFor('')).toBe('unidentified');
    expect(familyFor(null)).toBe('unidentified');
  });

  it('draws a satellite and an unidentified object differently', () => {
    // They are different claims, so they must not be the same picture.
    expect(iconFor('CUBEBUG 1')).not.toBe(iconFor('OBJECT AN'));
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

describe('the shell atlas', () => {
  it('has a cell for every family, so none falls back to another shape', () => {
    // The map draws one image per family; the shell samples one strip. They
    // come from the same DRAW table, and this is what keeps the two sets the
    // same size (D106).
    expect(ATLAS_ORDER.length).toBe(Object.keys(FAMILY_ICON).length);
    expect(new Set(ATLAS_ORDER).size).toBe(ATLAS_CELLS);
  });

  it('sends each name to the cell its family occupies', () => {
    expect(ATLAS_ORDER[atlasCellFor('ISS (ZARYA)')]).toBe('station');
    expect(ATLAS_ORDER[atlasCellFor('STARLINK-4621')]).toBe('constellation');
    expect(ATLAS_ORDER[atlasCellFor('CLUSTER II-FM8')]).toBe('probe');
  });

  it('keeps the two unknowns in different cells on the shell too', () => {
    // A named satellite we cannot place and an object the catalogue cannot
    // name are different claims, and must not share a picture (D102).
    expect(atlasCellFor('CUBEBUG 1')).not.toBe(atlasCellFor('OBJECT AN'));
    expect(ATLAS_ORDER[atlasCellFor('CUBEBUG 1')]).toBe('satellite');
    expect(ATLAS_ORDER[atlasCellFor('OBJECT AN')]).toBe('unidentified');
  });

  it('never returns a cell outside the atlas', () => {
    for (const name of ['', 'ISS', 'OBJECT W', 'SOMETHING UNLISTED', 'GPS BIIR-2']) {
      const cell = atlasCellFor(name);
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(ATLAS_CELLS);
    }
  });
});
