/**
 * Tests for the callsign to airline decode.
 *
 * The decode is three lines of regular expression and a map lookup, and the
 * interesting part is entirely in what it refuses. Every failure mode here is
 * the same shape: a confident, plausible, wrong answer that nothing downstream
 * can detect — a private aeroplane labelled with an airline's name, or an
 * ICAO24 address read as a flight number.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AirlineTable,
  airlineCodeFromCallsign,
  airlineFor,
  loadAirlineTable,
  resetAirlineTable,
} from './airlines';

const table: AirlineTable = {
  THA: 'Thai Airways International',
  UAL: 'United Airlines',
  BAW: 'British Airways',
  FDX: 'Federal Express',
  ABC: 'Not A Real Airline',
};

afterEach(() => {
  resetAirlineTable();
  vi.restoreAllMocks();
});

describe('airlineCodeFromCallsign', () => {
  it('reads the designator off a flight callsign', () => {
    expect(airlineCodeFromCallsign('THA932')).toBe('THA');
    expect(airlineCodeFromCallsign('UAL1')).toBe('UAL');
    expect(airlineCodeFromCallsign('BAW22F')).toBe('BAW');
  });

  it('trims the padding OpenSky sends', () => {
    // State vectors pad the callsign to eight characters.
    expect(airlineCodeFromCallsign('THA932  ')).toBe('THA');
    expect(airlineCodeFromCallsign('  UAL1  ')).toBe('UAL');
  });

  it('uppercases', () => {
    expect(airlineCodeFromCallsign('tha932')).toBe('THA');
  });

  it('refuses a registration', () => {
    // The digit in the fourth place is the whole rule: a flight number always
    // starts with one, and a registration's fourth character does not.
    expect(airlineCodeFromCallsign('N466WN')).toBeNull();
    expect(airlineCodeFromCallsign('ZSABC')).toBeNull();
    expect(airlineCodeFromCallsign('VHXYZ')).toBeNull();
    expect(airlineCodeFromCallsign('CGABC')).toBeNull();
  });

  it('refuses a hyphenated registration, however the feed spells it', () => {
    expect(airlineCodeFromCallsign('D-ABCD')).toBeNull();
    expect(airlineCodeFromCallsign('OY-JJU')).toBeNull();
  });

  it('refuses nothing at all', () => {
    expect(airlineCodeFromCallsign('')).toBeNull();
    expect(airlineCodeFromCallsign('   ')).toBeNull();
    expect(airlineCodeFromCallsign(null)).toBeNull();
    expect(airlineCodeFromCallsign(undefined)).toBeNull();
  });

  it('refuses a callsign too short to carry a designator', () => {
    expect(airlineCodeFromCallsign('TH')).toBeNull();
    expect(airlineCodeFromCallsign('THA')).toBeNull();
  });
});

describe('airlineFor', () => {
  it('names the airline behind a callsign', () => {
    expect(airlineFor('THA932', 'a1b2c3', table)).toEqual({
      code: 'THA',
      name: 'Thai Airways International',
    });
  });

  it('says nothing for a designator the table does not carry', () => {
    expect(airlineFor('XYZ123', 'a1b2c3', table)).toBeNull();
  });

  it('refuses to decode a label that is only the id', () => {
    // `label` falls back to the id when upstream sent no callsign, and an
    // ICAO24 address is six hex characters -- so `abc123` matches the decode
    // rule exactly and would name an airline for an aircraft whose callsign we
    // never received. This is why the id is passed in at all.
    expect(airlineFor('abc123', 'abc123', table)).toBeNull();
    expect(airlineFor('ABC123', 'abc123', table)).toBeNull();
    // ...and the same string as a real callsign, on a different aircraft, does
    // decode. The guard is about identity, not about the characters.
    expect(airlineFor('ABC123', 'd00d11', table)?.name).toBe('Not A Real Airline');
  });

  it('says nothing before the table has arrived', () => {
    expect(airlineFor('THA932', 'a1b2c3', null)).toBeNull();
  });

  it('says nothing for an object with no label', () => {
    expect(airlineFor(null, 'a1b2c3', table)).toBeNull();
    expect(airlineFor('', 'a1b2c3', table)).toBeNull();
  });
});

describe('loadAirlineTable', () => {
  it('fetches once and reuses the result', async () => {
    const fetchTable = vi.fn().mockResolvedValue(table);
    const first = await loadAirlineTable(fetchTable);
    const second = await loadAirlineTable(fetchTable);
    expect(first).toBe(table);
    expect(second).toBe(table);
    expect(fetchTable).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    const fetchTable = vi.fn().mockResolvedValue(table);
    const [a, b] = await Promise.all([
      loadAirlineTable(fetchTable),
      loadAirlineTable(fetchTable),
    ]);
    expect(a).toBe(table);
    expect(b).toBe(table);
    expect(fetchTable).toHaveBeenCalledTimes(1);
  });

  it('resolves to null on failure instead of rejecting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchTable = vi.fn().mockRejectedValue(new Error('HTTP 404'));
    await expect(loadAirlineTable(fetchTable)).resolves.toBeNull();
  });

  it('will try again after a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error('cold start'));
    await loadAirlineTable(failing);

    const succeeding = vi.fn().mockResolvedValue(table);
    await expect(loadAirlineTable(succeeding)).resolves.toBe(table);
  });
});

// ---- against the real generated table --------------------------------------

const tablePath = join(process.cwd(), 'public', 'data', 'airlines.json');
const generated = existsSync(tablePath);
const real: AirlineTable = generated
  ? (JSON.parse(readFileSync(tablePath, 'utf8')) as AirlineTable)
  : {};

describe.skipIf(!generated)('the generated airlines.json', () => {
  it('is keyed by three-letter designators', () => {
    for (const code of Object.keys(real)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('has a non-empty name for every designator', () => {
    for (const name of Object.values(real)) {
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toBe('\\N');
    }
  });

  it('decodes the airlines the task asked for by name', () => {
    expect(airlineFor('THA932', 'a1b2c3', real)?.name).toBe('Thai Airways International');
    expect(airlineFor('UAL1', 'a1b2c3', real)?.name).toBe('United Airlines');
  });

  it('keeps carriers OpenFlights marks inactive but which very much fly', () => {
    // The reason the build step does not filter on the active flag: both of
    // these are flagged inactive in the source and both are everywhere in a
    // real feed.
    expect(real.FDX).toBe('Federal Express');
    expect(real.UPS).toBe('United Parcel Service');
  });

  it('carries enough designators to be worth fetching', () => {
    expect(Object.keys(real).length).toBeGreaterThan(5000);
  });
});
