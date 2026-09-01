import { describe, expect, it } from 'vitest';

import type { TrackedObjectDetail } from '../types';
import {
  SATELLITE_META_SHOWN,
  formatAltitude,
  formatElementAge,
  formatInclination,
  formatPeriod,
  formatSpeed,
  regimeName,
  satelliteRows,
} from './satelliteFacts';

const KM = 1000;

function detail(overrides: Partial<TrackedObjectDetail> = {}): TrackedObjectDetail {
  return {
    id: '25544',
    lat: 39.02,
    lon: -58.46,
    altitude: 420 * KM,
    velocity: 7658,
    heading: 45,
    label: 'ISS (ZARYA)',
    model: null,
    lastSeen: '2026-09-01T09:00:00Z',
    type: 'satellite',
    track: [],
    trackSource: 'provider',
    origin: null,
    route: null,
    meta: {
      inclinationDeg: '51.63',
      periodMinutes: '92.97',
      elementAgeDays: '0.42',
      elementSource: 'satnogs',
      elementEpoch: '2026-08-31T20:28:48+00:00',
    },
    ...overrides,
  };
}

const labels = (d: TrackedObjectDetail) => satelliteRows(d).map((r) => r.label);
const valueOf = (d: TrackedObjectDetail, label: string) =>
  satelliteRows(d).find((r) => r.label === label)?.value;

describe('formatting', () => {
  it('gives altitude in kilometres with separators, since it runs to six figures', () => {
    expect(formatAltitude(420 * KM)).toBe('420 km');
    expect(formatAltitude(105_466 * KM)).toBe('105,466 km');
  });

  it('gives speed in km/s, which is how every source quotes it', () => {
    // 7658 m/s is unrecognisable; 7.66 km/s is a number a reader can check.
    expect(formatSpeed(7658)).toBe('7.66 km/s');
  });

  it('says Unknown rather than inventing a zero', () => {
    expect(formatAltitude(null)).toBe('Unknown');
    expect(formatSpeed(null)).toBe('Unknown');
  });

  it('reads a low orbit period in minutes and a high one in hours', () => {
    expect(formatPeriod(92.97)).toBe('93 min');
    expect(formatPeriod(1436)).toBe('23 h 56 min');
  });

  it('omits the period rather than printing a nonsense one', () => {
    expect(formatPeriod(null)).toBeNull();
    expect(formatPeriod(0)).toBeNull();
  });
});

describe('regimeName', () => {
  it('names the orbit in words rather than an abbreviation', () => {
    expect(regimeName(420 * KM)).toBe('Low Earth orbit');
    expect(regimeName(35_786 * KM)).toBe('Geostationary');
  });

  it('is null when the altitude is unknown', () => {
    expect(regimeName(null)).toBeNull();
  });
});

describe('formatInclination', () => {
  it('says what the number means, not just the number', () => {
    // 51.6 degrees alone tells most readers nothing. The latitude band it
    // implies is a fact anybody can use.
    const row = formatInclination(51.63);
    expect(row?.value).toBe('51.6°');
    expect(row?.note).toContain('52');
  });

  it('describes a geostationary orbit as sitting over the equator', () => {
    expect(formatInclination(0.02)?.note).toBe('stays over the equator');
  });

  it('handles a retrograde orbit, where the reach is the supplement', () => {
    // Sun-synchronous imaging satellites sit near 98 degrees. Their latitude
    // reach is 82, not 98 -- reporting 98 would claim they pass over a
    // latitude that does not exist.
    expect(formatInclination(98)?.note).toContain('82');
  });

  it('is null when inclination is missing', () => {
    expect(formatInclination(null)).toBeNull();
  });
});

describe('formatElementAge', () => {
  it('turns element age into what it costs in accuracy', () => {
    // SGP4 degrades about a kilometre a day and does so silently. The point of
    // this row is that the drift is stated rather than left to be discovered.
    expect(formatElementAge(0.42)?.value).toBe('10 hours ago');
    expect(formatElementAge(0.42)?.note).toContain('kilometre');
    expect(formatElementAge(3)?.note).toContain('3 km');
  });

  it('reads minutes for a fresh set', () => {
    expect(formatElementAge(0.002)?.value).toBe('minutes ago');
  });
});

describe('satelliteRows', () => {
  it('leads with the identity, what it is, and where it orbits', () => {
    expect(labels(detail()).slice(0, 4)).toEqual([
      'Catalogue number',
      'Type',
      'Orbit',
      'Altitude',
    ]);
  });

  it('names the kind of spacecraft, matching the silhouette on the map', () => {
    // The panel and the picture read the same classification, so they cannot
    // disagree about what the object is (D101).
    expect(valueOf(detail(), 'Type')).toBe('Crewed station');
    expect(valueOf(detail({ label: 'STARLINK-4621' }), 'Type')).toBe(
      'Communications constellation',
    );
  });

  it('says an unidentified object is unidentified, rather than guessing', () => {
    expect(valueOf(detail({ label: 'OBJECT AN' }), 'Type')).toBe('Unidentified object');
  });

  it('says the altitude shown is the true one, because the view distorts it', () => {
    // Both renderers compress altitude on purpose (D96, D97). A reader
    // comparing this number to the picture has to know which is measured.
    const row = satelliteRows(detail()).find((r) => r.label === 'Altitude');
    expect(row?.value).toBe('420 km');
    expect(row?.note).toContain('compresses');
  });

  it('asks nothing an aircraft would be asked', () => {
    // The panel's aircraft half asks for airline, type, departure and
    // scheduled route. A satellite cannot answer any of them, and blank rows
    // read as missing data rather than as inapplicable questions.
    const shown = labels(detail()).join(' ').toLowerCase();
    for (const word of ['airline', 'aircraft', 'departed', 'route', 'callsign', 'wingspan']) {
      expect(shown).not.toContain(word);
    }
  });

  it('omits rows it cannot fill instead of blanking them', () => {
    const bare = detail({ meta: {} });
    const shown = labels(bare);
    expect(shown).not.toContain('Orbital period');
    expect(shown).not.toContain('Inclination');
    expect(shown).not.toContain('Orbit measured');
    // What survives is what is genuinely known.
    expect(shown).toContain('Catalogue number');
    expect(shown).toContain('Altitude');
  });

  it('still produces rows when the altitude itself is unknown', () => {
    const rows = satelliteRows(detail({ altitude: null }));
    expect(rows.find((r) => r.label === 'Altitude')?.value).toBe('Unknown');
    expect(rows.map((r) => r.label)).not.toContain('Orbit');
  });

  it('reports the real ISS figures from a real element set', () => {
    // Every number here is checkable against common knowledge, which is the
    // point of using the ISS as the fixture.
    const d = detail();
    expect(valueOf(d, 'Orbit')).toBe('Low Earth orbit');
    expect(valueOf(d, 'Altitude')).toBe('420 km');
    expect(valueOf(d, 'Speed')).toBe('7.66 km/s');
    expect(valueOf(d, 'Orbital period')).toBe('93 min');
    expect(valueOf(d, 'Inclination')).toBe('51.6°');
  });

  it('claims every meta key it renders, so nothing is printed twice', () => {
    // Defect #33 was exactly this: a field with its own labelled row that also
    // came back from the generic meta renderer, reading as two separate facts.
    const rendered = satelliteRows(detail());
    for (const key of Object.keys(detail().meta)) {
      expect(SATELLITE_META_SHOWN.has(key)).toBe(true);
    }
    expect(rendered.length).toBeGreaterThan(0);
  });
});
