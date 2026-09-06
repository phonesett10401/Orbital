import { describe, expect, it } from 'vitest';

import type { TrackedObjectDetail } from '../types';
import { SHIP_META_SHOWN, formatHeading, formatSpeed, shipRows } from './shipFacts';

/** A real vessel off the live feed: a 250 m tanker bound for Vysotsk. */
function ship(overrides: Partial<TrackedObjectDetail> = {}): TrackedObjectDetail {
  return {
    id: '256371000',
    lat: 60.1,
    lon: 24.9,
    altitude: 0,
    velocity: 6.4,
    heading: 61,
    label: 'NOUNOU',
    model: 'Tanker',
    lastSeen: '2026-09-06T22:45:00Z',
    type: 'ship',
    meta: {
      mmsi: '256371000',
      vesselName: 'NOUNOU',
      callSign: '9HA5814',
      imo: '9960980',
      shipType: 'Tanker',
      navigationStatus: 'Under way using engine',
      destination: 'RUVYS',
      draught: '8.2 m',
      length: '250 m',
      beam: '44 m',
      eta: '07/09 02:00 UTC',
    },
    ...overrides,
  } as TrackedObjectDetail;
}

const labels = (detail: TrackedObjectDetail) => shipRows(detail).map((r) => r.label);
const valueOf = (detail: TrackedObjectDetail, label: string) =>
  shipRows(detail).find((r) => r.label === label);

describe('what the panel asks about a ship', () => {
  it('never asks for an altitude', () => {
    // The reason this module exists. A vessel is at sea level, reported as
    // zero rather than null because that is a fact and not a gap (D165), so
    // the aircraft panel would print "Altitude 0 m" on every ship - true,
    // useless, and in the row the reader is scanning for something that
    // varies.
    expect(labels(ship())).not.toContain('Altitude');
  });

  it('never asks an aircraft question', () => {
    const asked = labels(ship()).join(' ').toLowerCase();
    for (const word of ['airline', 'registration', 'airport', 'route', 'flight']) {
      expect(asked, word).not.toContain(word);
    }
  });

  it('leads with what the vessel is and what it is doing', () => {
    // The two facts that vary on this layer. Four fifths of the fleet is
    // stationary, so "Moored" against "Under way" is the whole difference
    // between two ships that look identical on the map (D165).
    expect(labels(ship()).slice(0, 2)).toEqual(['Vessel type', 'Status']);
  });
});

describe('speed, in the unit a mariner uses', () => {
  it('leads with knots and keeps the contract unit beside it', () => {
    // 6.4 m/s is 12.4 knots. The contract carries m/s because that is one unit
    // for every layer (D18); at sea the number people think in is knots, and a
    // panel that made them convert would be missing its own point.
    expect(formatSpeed(6.4)).toContain('12.4 knots');
    expect(formatSpeed(6.4)).toContain('6.4 m/s');
  });

  it('says a stopped ship is stopped', () => {
    // "0.0 knots" invites the reader to wonder whether it is really 0.04. And
    // this is the common case, not the rare one.
    expect(formatSpeed(0)).toBe('Stopped');
    expect(formatSpeed(0.02)).toBe('Stopped');
  });

  it('distinguishes not transmitted from not moving', () => {
    // The AIS sentinels mean the transmitter said nothing, which is a
    // different fact from a speed of zero - and 11 vessels in one sample were
    // sending one (D165).
    expect(formatSpeed(null)).toBe('Not transmitted');
    expect(formatSpeed(null)).not.toMatch(/stopped/i);
  });
});

describe('heading', () => {
  it('is a bearing in degrees', () => {
    expect(formatHeading(61)).toBe('61°');
  });

  it('says not transmitted rather than unknown', () => {
    // A precise statement about the transmitter rather than a vague one about
    // our knowledge. 230 of 916 vessels sent neither heading nor course.
    expect(formatHeading(null)).toBe('Not transmitted');
  });
});

describe('the voyage', () => {
  it('shows the destination with its ETA', () => {
    const row = valueOf(ship(), 'Destination');
    expect(row?.value).toBe('RUVYS');
    expect(row?.note).toContain('07/09 02:00 UTC');
  });

  it('qualifies a destination with no ETA rather than dropping the caveat', () => {
    // It is free text typed on the bridge - a port name, a UN/LOCODE, a route,
    // or a shrug - so it is shown and qualified rather than presented as a
    // controlled value.
    const detail = ship();
    delete (detail.meta as Record<string, string>).eta;
    expect(valueOf(detail, 'Destination')?.note).toBe('as entered on board');
  });

  it('says nothing about a destination that was never entered', () => {
    const detail = ship({ meta: { mmsi: '1' } as Record<string, string> });
    expect(labels(detail)).not.toContain('Destination');
  });

  it('warns that navigational status is set by hand', () => {
    // 473 vessels in one sample reported "under way using engine" while
    // transmitting no movement at all. It is the one field here that should
    // not be taken as gospel (D165).
    expect(valueOf(ship(), 'Status')?.note).toBe('as set by the crew');
  });
});

describe('the hull', () => {
  it('gives length by beam, with the draught alongside', () => {
    const row = valueOf(ship(), 'Size');
    expect(row?.value).toBe('250 m × 44 m');
    expect(row?.note).toBe('drawing 8.2 m');
  });

  it('omits the size entirely when the feed carried no dimensions', () => {
    // Rather than "undefined × undefined", which is what a naive join gives.
    const detail = ship({ meta: { mmsi: '1' } as Record<string, string> });
    expect(labels(detail)).not.toContain('Size');
  });
});

describe('identity', () => {
  it('always shows the MMSI, because it is the one identifier every vessel has', () => {
    // 13% have no metadata row at all, so IMO and call sign are frequently
    // absent - and then this is the only thing that names the object.
    const detail = ship({ meta: {} as Record<string, string>, model: null });
    expect(valueOf(detail, 'MMSI')?.value).toBe('256371000');
  });

  it('does not print the vessel name twice', () => {
    // The name is the panel's title. Left in the generic meta list it appeared
    // again four rows down, which reads as a data problem rather than a
    // display one - the duplication panelFields exists to prevent.
    expect(SHIP_META_SHOWN.has('vesselName')).toBe(true);
  });

  it('lists every key its own rows render, so none is shown twice', () => {
    // The generic list below the rows prints whatever this set does not
    // claim. A row added above without a matching entry here appears twice.
    const rendered = new Set([
      'shipType',
      'navigationStatus',
      'destination',
      'eta',
      'length',
      'beam',
      'draught',
      'imo',
      'callSign',
      'mmsi',
    ]);
    for (const key of rendered) {
      expect(SHIP_META_SHOWN.has(key), key).toBe(true);
    }
  });
});
