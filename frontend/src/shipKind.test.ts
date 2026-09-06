import { describe, expect, it } from 'vitest';

import { KIND_BY_WORD_KEYS, KIND_COLOUR, KIND_ORDER, shipColour, shipKind } from './shipKind';

/**
 * The vocabulary `backend/app/providers/digitraffic.py` produces, in full.
 *
 * Written out rather than imported, because it crosses a language boundary and
 * there is nothing to import. It is guarded from the other side too: a backend
 * test asserts the provider emits exactly this set, and names this file. So a
 * new vessel type added to either half fails a test in that half, and the
 * failure says where its twin is.
 */
const BACKEND_VOCABULARY = [
  'Anti-pollution',
  'Cargo',
  'Diving support',
  'Dredger',
  'Fishing',
  'High speed craft',
  'Law enforcement',
  'Medical transport',
  'Military',
  'Other',
  'Passenger',
  'Pilot vessel',
  'Pleasure craft',
  'Port tender',
  'Sailing',
  'Search and rescue',
  'Special craft',
  'Tanker',
  'Towing',
  'Towing (long)',
  'Tug',
  'Wing in ground',
];

describe('the contract with the backend', () => {
  it('knows every word the provider can send, and no others', () => {
    // A word the backend sends and this map lacks is not a crash - it falls
    // through to grey - which is exactly why it needs a test: an entire class
    // of vessel would quietly lose its colour and nothing would report it.
    expect([...KIND_BY_WORD_KEYS].sort()).toEqual(BACKEND_VOCABULARY);
  });

  it('gives every family a colour', () => {
    for (const kind of KIND_ORDER) {
      expect(KIND_COLOUR[kind], kind).toMatch(/^rgb\(/);
    }
  });

  it('lists every family in the key exactly once', () => {
    expect(new Set(KIND_ORDER).size).toBe(KIND_ORDER.length);
    expect(KIND_ORDER.length).toBe(Object.keys(KIND_COLOUR).length);
  });

  it('gives the families distinct colours', () => {
    // Two families sharing a colour makes the key a lie: it would show two
    // swatches a reader cannot tell apart on the map.
    const colours = KIND_ORDER.map((kind) => KIND_COLOUR[kind]);
    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe('reading a vessel type', () => {
  it('reads the common ones', () => {
    expect(shipKind('Cargo')).toBe('cargo');
    expect(shipKind('Tanker')).toBe('tanker');
    expect(shipKind('Passenger')).toBe('passenger');
  });

  it('gathers the harbour trades into one family', () => {
    // A tug, a pilot boat and a port tender are one thing to a reader looking
    // at a harbour, and six swatches for them would crowd out the key.
    for (const word of ['Tug', 'Pilot vessel', 'Port tender', 'Dredger', 'Towing']) {
      expect(shipKind(word), word).toBe('service');
    }
  });

  it('does not guess at a word it does not know', () => {
    // The backend can only send the words above, so an unknown one means the
    // two halves have drifted - and grey is the honest answer, not a nearest
    // match.
    expect(shipKind('Submarine')).toBe('other');
    expect(shipKind('')).toBe('other');
  });

  it('treats a missing type as unreported rather than crashing', () => {
    // 13% of the feed has no metadata row at all, so `model` is null for
    // roughly one vessel in eight (D165).
    expect(shipKind(null)).toBe('other');
    expect(shipKind(undefined)).toBe('other');
    expect(shipColour(null)).toBe(KIND_COLOUR.other);
  });
});
