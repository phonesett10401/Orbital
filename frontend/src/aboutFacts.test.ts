/**
 * What the About page claims (D177).
 *
 * A page about the project is the easiest place in the application to write
 * something flattering and untrue, so what it says is data and this checks it
 * against the rest of the repository.
 */

import { describe, expect, it } from 'vitest';

import { BUILD, LAYERS, REFUSALS, SOURCES, countText } from './aboutFacts';
import { LAYERS as REGISTERED } from './state/store';

describe('the three layers', () => {
  it('names the same three the application actually serves', () => {
    // Read from the store's own registry rather than restated. A page that
    // kept its own list of layers would go stale the way the report's figures
    // did, and this one is describing the thing it is part of.
    expect(LAYERS.map((l) => l.resource).sort()).toEqual(
      REGISTERED.map((l) => l.resource).sort(),
    );
  });

  it('says of every layer whether the position was observed or computed', () => {
    // The distinction the whole map is built on. Two of these are heard from
    // the ground and one is propagated from elements, and showing them
    // identically would claim the same confidence about both.
    for (const layer of LAYERS) {
      expect(layer.origin, layer.name).toMatch(/^(Observed|Computed)\./);
    }
  });

  it('calls the satellites computed and the rest observed', () => {
    const byName = Object.fromEntries(LAYERS.map((l) => [l.resource, l.origin]));
    expect(byName.satellites).toMatch(/^Computed/);
    expect(byName.aircraft).toMatch(/^Observed/);
    expect(byName.ships).toMatch(/^Observed/);
  });

  it('says why the ships are coastal, since that is the layer’s real limit', () => {
    const ships = LAYERS.find((l) => l.resource === 'ships');
    expect(ships?.origin).toMatch(/shore|coastal/i);
  });
});

describe('the sources', () => {
  it('gives every upstream its terms', () => {
    for (const source of SOURCES) {
      expect(source.name.length, source.name).toBeGreaterThan(0);
      expect(source.provides.length, source.name).toBeGreaterThan(0);
      expect(source.terms.length, source.name).toBeGreaterThan(0);
    }
  });

  it('keeps the two findings that actually constrain the project', () => {
    // OpenSky forbids commercial use, which is what stops this ever becoming a
    // product; aisstream states nothing, which is not the same as permitting
    // anything. Both were findings of the source survey (D165), and rounding
    // either to "free" would throw away the interesting part.
    expect(SOURCES.find((s) => s.name === 'OpenSky Network')?.terms).toMatch(/non-commercial/i);
    expect(SOURCES.find((s) => s.name === 'aisstream.io')?.terms).toMatch(/unstated/i);
  });

  it('covers all three layers and the map under them', () => {
    const provides = SOURCES.map((s) => s.provides.toLowerCase()).join(' ');
    for (const subject of ['aircraft', 'ships', 'orbital elements', 'imagery']) {
      expect(provides, subject).toContain(subject);
    }
  });
});

describe('what the map refuses to say', () => {
  it('gives a reason for every refusal', () => {
    // Not a disclaimer list. Each one is a decision with a defect behind it,
    // and a claim without its reason is just hedging.
    expect(REFUSALS.length).toBeGreaterThan(3);
    for (const refusal of REFUSALS) {
      expect(refusal.claim.length, refusal.claim).toBeGreaterThan(0);
      expect(refusal.reason.length, refusal.claim).toBeGreaterThan(20);
    }
  });

  it('covers the four the application actually enforces', () => {
    const all = REFUSALS.map((r) => `${r.claim} ${r.reason}`).join(' ').toLowerCase();
    expect(all).toContain('fades');
    expect(all).toContain('disc');
    expect(all).toContain('receiver');
    expect(all).toMatch(/forecast|predict/);
  });
});

describe('the build block', () => {
  it('holds only facts that do not move', () => {
    // Anything that changes as the software runs belongs in the live block,
    // and the difference between the two is why there are two.
    const text = BUILD.map((f) => f.value).join(' ');
    expect(text).not.toMatch(/\b\d{3,}\b/);
  });

  it('names what the map and the three dimensions are actually drawn with', () => {
    const labels = BUILD.map((f) => `${f.label} ${f.value}`).join(' ');
    expect(labels).toContain('MapLibre');
    expect(labels).toContain('three.js');
  });
});

describe('the live counts', () => {
  it('groups the digits, because five unbroken ones are not a number', () => {
    expect(countText(14804)).toBe('14,804');
  });

  it('says nothing rather than zero when it does not know yet', () => {
    // Zero is a claim - it says the sky is empty. "Not known yet" is a
    // different thing and the page has no business dressing it up as data.
    expect(countText(null)).toBe('—');
    expect(countText(0)).toBe('0');
  });
});
