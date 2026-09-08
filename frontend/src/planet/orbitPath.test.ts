/**
 * The orbit path's geometry (D170).
 *
 * The property that matters is not "the line is in the right place" but **"the
 * line is in the same place as the marker"**, on a shell that is deliberately
 * not to scale. So most of this asks whether the two agree.
 */

import { describe, expect, it } from 'vitest';

import { SHELL_MIN, shellFor } from '../satelliteShell';
import { isDrawablePath, orbitVertices } from './orbitPath';
import { shellPosition } from './satelliteShellLayer';

const ISS_ALTITUDE = 420_000;

function circularOrbit(count: number, altitude = ISS_ALTITUDE) {
  return Array.from({ length: count }, (_, i) => ({
    lat: 0,
    lon: -180 + (360 * i) / count,
    altitude,
  }));
}

describe('the orbit path on the shell', () => {
  it('puts the line exactly where the marker goes', () => {
    // The whole point. The shell is logarithmic, so a path computed at true
    // scale would be a ring floating somewhere near the satellite rather than
    // through it - and the reader would have no way to tell which was wrong.
    const point = { lat: 12.5, lon: -73.25, altitude: ISS_ALTITUDE };
    const line = orbitVertices([point, point, point]);
    const marker = shellPosition(point.lon, point.lat, point.altitude);

    // `Math.fround`, not `toBeCloseTo`. The marker's positions go to the GPU
    // in a Float32Array too, so the two agree *exactly* at the precision they
    // are actually drawn at - and saying so is stronger than allowing a
    // tolerance, which would also pass if they were merely near each other.
    expect([line[0], line[1], line[2]]).toEqual(marker.map(Math.fround));
  });

  it('is one buffer of triples, in order', () => {
    const points = circularOrbit(8);
    const vertices = orbitVertices(points);
    expect(vertices).toBeInstanceOf(Float32Array);
    expect(vertices.length).toBe(points.length * 3);
  });

  it('draws a circular orbit at one radius', () => {
    // Constant altitude means constant distance from the centre, whatever the
    // compression does to the number.
    const vertices = orbitVertices(circularOrbit(24));
    const radii: number[] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      radii.push(Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]));
    }
    const expected = 1 + shellFor(ISS_ALTITUDE);
    for (const r of radii) expect(r).toBeCloseTo(expected, 5);
  });

  it('stands the whole path off the surface', () => {
    // Never inside the globe, which is what an unlifted lat/lon path would be.
    const vertices = orbitVertices(circularOrbit(16));
    for (let i = 0; i < vertices.length; i += 3) {
      const radius = Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]);
      expect(radius).toBeGreaterThan(1 + SHELL_MIN - 1e-9);
    }
  });

  it('compresses a high orbit less than proportionally, and says so by doing it', () => {
    // The honest consequence of a logarithmic shell, asserted rather than only
    // documented: geostationary is 85 times the altitude of the ISS and is
    // drawn at nowhere near 85 times the lift.
    const iss = shellFor(ISS_ALTITUDE);
    const geo = shellFor(35_786_000);
    expect(geo).toBeGreaterThan(iss);
    expect(geo / iss).toBeLessThan(10);
  });

  it('refuses a path too short to be an orbit', () => {
    // Two points is a chord through the planet, and a path that short means
    // something failed upstream rather than that the orbit is small.
    expect(isDrawablePath(undefined)).toBe(false);
    expect(isDrawablePath([])).toBe(false);
    expect(isDrawablePath(circularOrbit(2))).toBe(false);
    expect(isDrawablePath(circularOrbit(3))).toBe(true);
  });

  it('keeps the ends apart, because the Earth turned', () => {
    // The path is open by construction: the backend hands back Earth-fixed
    // positions over one revolution, and the planet moves under them. Nothing
    // here closes it, and this is the test that would fail if somebody did.
    const points = [
      { lat: 0, lon: 0, altitude: ISS_ALTITUDE },
      { lat: 30, lon: 90, altitude: ISS_ALTITUDE },
      { lat: 0, lon: -157.5, altitude: ISS_ALTITUDE },
      { lat: -22.5, lon: -22.5, altitude: ISS_ALTITUDE },
    ];
    const vertices = orbitVertices(points);
    const last = vertices.length - 3;
    const apart = Math.hypot(
      vertices[0] - vertices[last],
      vertices[1] - vertices[last + 1],
      vertices[2] - vertices[last + 2],
    );
    expect(apart).toBeGreaterThan(0.01);
  });
});
