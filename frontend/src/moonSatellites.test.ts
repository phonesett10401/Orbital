import { describe, expect, it } from 'vitest';

import {
  describeAltitude,
  describeCraft,
  drawable,
  isDrawable,
  toFeatures,
  type MoonSatellite,
} from './moonSatellites';

const LRO: MoonSatellite = {
  id: '-85',
  name: 'LRO',
  operator: 'NASA',
  purpose: 'Mapping the Moon since 2009.',
  lat: 38.378,
  lon: -68.41,
  altitudeKm: 70.9,
};

describe('which spacecraft are drawn', () => {
  it('draws one with a real position', () => {
    expect(isDrawable(LRO)).toBe(true);
  });

  it('refuses a position that is not a number', () => {
    // A malformed row draws at null island, which is a specific and confident
    // lie rather than a gap.
    expect(isDrawable({ ...LRO, lat: Number.NaN })).toBe(false);
    expect(isDrawable({ ...LRO, lon: undefined })).toBe(false);
    expect(isDrawable(null)).toBe(false);
  });

  it('refuses a position off the sphere', () => {
    expect(isDrawable({ ...LRO, lat: 91 })).toBe(false);
    expect(isDrawable({ ...LRO, lon: 181 })).toBe(false);
  });

  it('keeps the antimeridian, which is a real place', () => {
    // The backend normalises to 180 rather than -180; rejecting it would blink
    // a spacecraft out once an orbit.
    expect(isDrawable({ ...LRO, lon: 180 })).toBe(true);
    expect(isDrawable({ ...LRO, lon: -180 })).toBe(true);
  });

  it('keeps the poles, where these spacecraft actually spend their time', () => {
    // All three are in polar or near-polar orbits, so an off-by-one on the
    // latitude bound would drop them at the most interesting moment.
    expect(isDrawable({ ...LRO, lat: 90 })).toBe(true);
    expect(isDrawable({ ...LRO, lat: -90 })).toBe(true);
  });

  it('drops only the bad ones from a mixed list', () => {
    const kept = drawable([LRO, { ...LRO, id: 'x', lat: Number.NaN }]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('-85');
  });
});

describe('what the panel says', () => {
  it('gives altitude in whole kilometres', () => {
    // A one-minute interpolation does not support a tenth of a kilometre, and
    // printing one claims accuracy the number does not have.
    expect(describeAltitude(70.9)).toBe('71 km above the Moon');
    expect(describeAltitude(213.24)).toBe('213 km above the Moon');
  });

  it('names the operator, because three craft means three flags', () => {
    expect(describeCraft(LRO)).toBe('LRO (NASA)');
  });
});

describe('the feature collection', () => {
  it('puts longitude first, as GeoJSON requires', () => {
    // The mistake that draws every spacecraft in a neat wrong line.
    const [lon, lat] = toFeatures([LRO]).features[0].geometry.coordinates;
    expect(lon).toBe(-68.41);
    expect(lat).toBe(38.378);
  });

  it('carries what the marker and the panel both need', () => {
    const props = toFeatures([LRO]).features[0].properties;
    expect(props.label).toBe('LRO');
    expect(props.operator).toBe('NASA');
    expect(props.altitudeKm).toBe(70.9);
  });

  it('leaves out anything undrawable rather than emitting a null point', () => {
    const collection = toFeatures([LRO, { ...LRO, id: 'y', lat: Number.NaN }]);
    expect(collection.features).toHaveLength(1);
  });

  it('is a valid empty collection when nothing is known', () => {
    // The backend returns nothing while a window is being fetched, and an
    // empty collection must still be a collection or the source throws.
    expect(toFeatures([])).toEqual({ type: 'FeatureCollection', features: [] });
  });
});
