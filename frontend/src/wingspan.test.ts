import { describe, expect, it } from 'vitest';

import { MAX_SCALE, MIN_SCALE, REFERENCE_SPAN_M, scaleFor, wingspanFor } from './wingspan';

describe('wingspanFor', () => {
  it('knows the types that actually fill a live map', () => {
    // The eight commonest over a 2,000-aircraft sample.
    for (const code of ['B738', 'B38M', 'A320', 'A20N', 'A21N', 'A359', 'B789', 'B788']) {
      expect(wingspanFor(code)).toBeGreaterThan(0);
    }
  });

  it('falls back to the family for a variant it has never seen', () => {
    // A designator we do not list is nearly always a variant of one we do.
    expect(wingspanFor('B78Z')).toBe(wingspanFor('B789'));
    expect(wingspanFor('A32Q')).toBe(wingspanFor('A320'));
  });

  it('prefers the longest matching family', () => {
    // 'B78' must win over any shorter Boeing prefix, or every Boeing would be
    // the same size.
    expect(wingspanFor('B78Q')).toBe(60.1);
    expect(wingspanFor('B73Q')).toBe(35.8);
  });

  it('is case and whitespace insensitive, because feeds are not tidy', () => {
    expect(wingspanFor(' b738 ')).toBe(wingspanFor('B738'));
  });

  it('says nothing rather than guessing when there is no type', () => {
    // A quarter of a live map: OpenSky sends no type at all.
    expect(wingspanFor(null)).toBeNull();
    expect(wingspanFor(undefined)).toBeNull();
    expect(wingspanFor('')).toBeNull();
    expect(wingspanFor('   ')).toBeNull();
    expect(wingspanFor('ZZZZ')).toBeNull();
  });
});

describe('scaleFor', () => {
  it('draws an unknown type at the size everything used to be', () => {
    // Not a special size: these are ordinary airliners we happen to have heard
    // about from the feed without a type field. Marking them out would say
    // something false.
    expect(scaleFor(null)).toBe(1);
    expect(scaleFor('ZZZZ')).toBe(1);
  });

  it('draws the reference aircraft at exactly 1', () => {
    expect(scaleFor('A320')).toBe(1);
    expect(scaleFor('B738')).toBe(1);
  });

  it('orders aircraft by size', () => {
    const order = ['C172', 'CRJ7', 'E190', 'A320', 'B763', 'B789', 'B77W', 'A388'];
    const scales = order.map(scaleFor);
    for (let i = 1; i < scales.length; i += 1) {
      expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1]);
    }
    expect(scales[scales.length - 1]).toBeGreaterThan(scales[0]);
  });

  it('never lets a marker vanish or dominate', () => {
    // An honest linear scale would draw a Cessna at 0.31x, too small to see,
    // and the map's job is to show where aircraft are.
    expect(scaleFor('C152')).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(scaleFor('A388')).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('compresses the range so an A380 is not five times an A320', () => {
    // The icon grows in two dimensions, so the scale is the square root of the
    // span ratio: drawn area then tracks span rather than span squared.
    const a380 = scaleFor('A388');
    expect(a380).toBeGreaterThan(1.2);
    expect(a380).toBeLessThan(1.6);
  });

  it('puts the reference span where the commonest aircraft is', () => {
    // Chosen so the map's overall density of ink barely changes.
    expect(wingspanFor('A320')).toBe(REFERENCE_SPAN_M);
  });
});
