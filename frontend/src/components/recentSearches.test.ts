import { describe, expect, it } from 'vitest';

import {
  RECENT_LIMIT,
  aircraftEntry,
  airportEntry,
  loadRecent,
  remember,
  saveRecent,
  type RecentSearch,
} from './recentSearches';

function entry(id: string, kind: RecentSearch['kind'] = 'aircraft'): RecentSearch {
  return { kind, id, label: id, sublabel: 'x', lat: 1, lon: 2 };
}

/** A localStorage that behaves, and one that does not. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  } as unknown as Storage;
}

describe('remember', () => {
  it('puts the newest first', () => {
    expect(remember([entry('a')], entry('b')).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('moves a repeat to the top instead of duplicating it', () => {
    // Searching the same flight twice should not fill the list with it, and
    // the list means "what you were just looking at".
    const list = remember([entry('a'), entry('b')], entry('b'));
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('tells an aircraft and an airport with the same code apart', () => {
    // Both are keyed by an ICAO string and they are different things.
    const list = remember([entry('EGLL', 'airport')], entry('EGLL', 'aircraft'));
    expect(list).toHaveLength(2);
  });

  it('keeps only the most recent few', () => {
    let list: RecentSearch[] = [];
    for (let i = 0; i < RECENT_LIMIT + 4; i += 1) list = remember(list, entry(`id${i}`));
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].id).toBe(`id${RECENT_LIMIT + 3}`);
  });
});

describe('what gets remembered', () => {
  it('labels an aircraft by its callsign, falling back to its address', () => {
    const base = { lat: 1, lon: 2, altitude: null, velocity: null, heading: null, model: null, lastSeen: '', type: 'aircraft' as const };
    expect(aircraftEntry({ ...base, id: 'abc123', label: 'UAL1' }).label).toBe('UAL1');
    expect(aircraftEntry({ ...base, id: 'abc123', label: '' }).label).toBe('ABC123');
  });

  it('labels an airport by IATA where it has one, because that is what people type', () => {
    const heathrow = {
      icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', municipality: 'London',
      country: 'GB', lat: 51.5, lon: -0.45, distanceKm: null,
    };
    expect(airportEntry(heathrow).label).toBe('LHR');
    expect(airportEntry({ ...heathrow, iata: null }).label).toBe('EGLL');
    expect(airportEntry({ ...heathrow, municipality: null }).sublabel).toBe('London Heathrow');
  });
});

describe('storage', () => {
  it('round-trips', () => {
    const storage = fakeStorage();
    saveRecent([entry('a')], storage);
    expect(loadRecent(storage).map((e) => e.id)).toEqual(['a']);
  });

  it('is empty when there is nothing stored', () => {
    expect(loadRecent(fakeStorage())).toEqual([]);
  });

  it('survives storage that throws', () => {
    // Private mode, disabled storage, a full quota. None is worth a broken
    // search box, and a recent-search list is the definition of losable data.
    expect(loadRecent(throwingStorage())).toEqual([]);
    expect(() => saveRecent([entry('a')], throwingStorage())).not.toThrow();
  });

  it('survives storage with no storage at all', () => {
    expect(loadRecent(undefined)).toEqual([]);
    expect(() => saveRecent([entry('a')], undefined)).not.toThrow();
  });

  it('ignores junk another version of this app might have written', () => {
    // Storage is shared with every past build, so this is untrusted input.
    const storage = fakeStorage({
      'orbital.recentSearches': JSON.stringify([
        entry('good'),
        { kind: 'aircraft', id: 'missing-fields' },
        'not an object',
        null,
      ]),
    });
    expect(loadRecent(storage).map((e) => e.id)).toEqual(['good']);
  });

  it('ignores stored text that is not JSON at all', () => {
    const storage = fakeStorage({ 'orbital.recentSearches': '{oh dear' });
    expect(loadRecent(storage)).toEqual([]);
  });
});
