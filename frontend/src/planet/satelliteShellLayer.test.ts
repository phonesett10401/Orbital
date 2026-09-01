import { describe, expect, it } from 'vitest';

import { shellFor } from '../satelliteShell';
import { SHELL_MAX_ZOOM, shellIsLive, shellPosition } from './satelliteShellLayer';

const KM = 1000;
const ISS = 420 * KM;
const GPS = 20_200 * KM;
const GEO = 35_786 * KM;
const CLUSTER = 105_466 * KM;

const radiusOf = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);

describe('shellPosition', () => {
  it('puts a satellite at the radius its altitude earns', () => {
    // MapLibre's globe frame projects a unit sphere, where altitude is a radial
    // scale from the centre. `shellFor` already returns globe radii above the
    // surface, so the conversion is one addition and nothing else (D105).
    expect(radiusOf(shellPosition(0, 0, ISS))).toBeCloseTo(1 + shellFor(ISS), 6);
    expect(radiusOf(shellPosition(0, 0, GEO))).toBeCloseTo(1 + shellFor(GEO), 6);
  });

  it('always stands clear of the surface', () => {
    // A satellite drawn at radius 1 would be sitting on the ground, which is
    // the one thing this layer exists not to do.
    for (const altitude of [null, 0, ISS, GPS, GEO, CLUSTER]) {
      expect(radiusOf(shellPosition(10, 20, altitude))).toBeGreaterThan(1.04);
    }
  });

  it('orders the shells the way the orbits are ordered', () => {
    const at = (a: number) => radiusOf(shellPosition(45, -30, a));
    expect(at(ISS)).toBeLessThan(at(GPS));
    expect(at(GPS)).toBeLessThan(at(GEO));
    expect(at(GEO)).toBeLessThan(at(CLUSTER));
  });

  it('keeps the whole catalogue inside the camera reach', () => {
    // The globe is radius 1 and the zoom floor is -1.6, so the frame holds a
    // few radii. 16.4 -- true scale for Cluster II -- would not be reachable.
    expect(radiusOf(shellPosition(0, 0, CLUSTER))).toBeLessThan(2.4);
  });

  it('points in the direction the longitude and latitude say', () => {
    // Longitude 0, latitude 0 is the prime meridian on the equator; the poles
    // are on the axis. A latitude/longitude swap would fail all three.
    const equator = shellPosition(0, 0, ISS);
    const north = shellPosition(0, 90, ISS);
    expect(Math.abs(north[1])).toBeGreaterThan(Math.abs(north[0]));
    expect(Math.abs(north[1])).toBeGreaterThan(Math.abs(north[2]));
    expect(Math.abs(equator[1])).toBeLessThan(1e-9);
  });

  it('puts opposite sides of the planet in opposite directions', () => {
    const here = shellPosition(0, 0, ISS);
    const antipode = shellPosition(180, 0, ISS);
    // Their dot product is negative: one is behind the planet from the other.
    const dot = here[0] * antipode[0] + here[1] * antipode[1] + here[2] * antipode[2];
    expect(dot).toBeLessThan(0);
  });

  it('falls back to the low shell rather than the ground for unknown altitude', () => {
    expect(radiusOf(shellPosition(0, 0, null))).toBeCloseTo(1 + shellFor(null), 6);
  });
});

describe('shellIsLive', () => {
  it('draws while the whole planet is in frame', () => {
    expect(shellIsLive(0, 1)).toBe(true);
    expect(shellIsLive(-1.6, 1)).toBe(true);
    expect(shellIsLive(SHELL_MAX_ZOOM, 1)).toBe(true);
  });

  it('hands over to the ground symbols once zoomed in', () => {
    // A shell 1.35 radii off the surface is far outside a viewport showing one
    // country, so what is honest to draw there is the sub-satellite point.
    expect(shellIsLive(SHELL_MAX_ZOOM + 0.1, 1)).toBe(false);
    expect(shellIsLive(9, 1)).toBe(false);
  });

  it('does not draw in the mercator frame, where there is no sphere', () => {
    // The globe positions are directions from a centre. Under mercator that
    // centre does not exist and the matrix means something else entirely.
    expect(shellIsLive(0, 0)).toBe(false);
  });

  it('changes over at a zoom the camera can actually reach', () => {
    expect(SHELL_MAX_ZOOM).toBeGreaterThan(-1.6);
    expect(SHELL_MAX_ZOOM).toBeLessThan(6);
  });
});
