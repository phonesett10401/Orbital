/**
 * Orientation, which is the thing that is silently wrong.
 *
 * A solar system drawn in the wrong frame still looks like a solar system. It
 * has a sun, it has planets, the orbits are rings - and the whole thing is
 * rotated by an amount nobody can eyeball. So the checks here are against
 * facts that hold outside this code: where the Sun actually is, how far the
 * ecliptic is tilted, and what a day does to the sky.
 */

import { describe, expect, it } from 'vitest';

import { sphereVector } from './planet/modelFrame';
import { PLANET_IDS } from './planets';
import { GLOBE_RADII_AT_NEPTUNE } from './solarScale';
import {
  earthRotationDeg,
  eclipticToGlobe,
  lonLatOf,
  orbitRing,
  scenePlacements,
} from './solarFrame';
import { subsolarPoint } from './sun';

const DATES = [
  new Date('2026-03-20T12:00:00Z'), // near the March equinox
  new Date('2026-06-21T00:00:00Z'), // near the June solstice
  new Date('2026-09-05T18:30:00Z'),
  new Date('2026-12-21T06:00:00Z'), // near the December solstice
];

function angleBetween(a: readonly number[], b: readonly number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  return (Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) * 180) / Math.PI;
}

describe('the Sun lands where the Sun is', () => {
  it('agrees with the subsolar point, which is computed independently', () => {
    // The decisive check. `subsolarPoint` is a different algorithm from
    // `planets.ts` with its own tests against the equinoxes, so the two
    // agreeing on a direction is not this file marking its own work. Any error
    // in obliquity, rotation angle or axis convention breaks it.
    for (const date of DATES) {
      const sun = scenePlacements(date).find((p) => p.id === 'sun')!;
      const sub = subsolarPoint(date);
      const expected = sphereVector(sub.lon, sub.lat);
      expect(angleBetween(sun.at, expected), date.toISOString()).toBeLessThan(1.5);
    }
  });

  it('puts the Sun about one compressed AU away, not at the origin', () => {
    // Earth is the origin because MapLibre is already drawing it there. The
    // Sun is a real distance away in a real direction.
    for (const date of DATES) {
      const sun = scenePlacements(date).find((p) => p.id === 'sun')!;
      expect(Math.hypot(...sun.at)).toBeGreaterThan(2.4);
      expect(sun.distanceAu).toBeGreaterThan(0.98);
      expect(sun.distanceAu).toBeLessThan(1.02);
    }
  });
});

describe('the ecliptic is tilted, because it is', () => {
  it('sets the ecliptic pole 23.4 degrees from the globe pole', () => {
    // If this came out as zero the planets would lie in Earth's equator, which
    // is the mistake that looks most nearly right.
    const north = sphereVector(0, 90);
    for (const date of DATES) {
      const eclipticNorth = eclipticToGlobe({ x: 0, y: 0, z: 1 }, date);
      expect(angleBetween(eclipticNorth, north), date.toISOString()).toBeCloseTo(23.44, 0);
    }
  });

  it('preserves length, so the rotation is a rotation', () => {
    for (const v of [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 3, z: 4 },
      { x: -2, y: 1, z: 0.5 },
    ]) {
      const out = eclipticToGlobe(v, DATES[0]);
      expect(Math.hypot(...out)).toBeCloseTo(Math.hypot(v.x, v.y, v.z), 9);
    }
  });
});

describe('Earth turns and the sky does not', () => {
  it('moves the sky about 360 degrees in a day', () => {
    // The fault this exists to prevent: a frame that ignores Earth's rotation
    // makes the planets orbit the sky daily. Here the sky is fixed and the
    // globe turns beneath it, so a fixed ecliptic direction must sweep a full
    // turn in the Earth-fixed frame over 24 hours.
    const start = new Date('2026-09-05T00:00:00Z');
    const day = new Date(start.getTime() + 86_400_000);
    const swept = Math.abs(earthRotationDeg(day) - earthRotationDeg(start));
    const normalised = ((swept % 360) + 360) % 360;
    expect(Math.min(normalised, 360 - normalised)).toBeLessThan(2);
  });

  it('moves it about 15 degrees in an hour', () => {
    const start = new Date('2026-09-05T00:00:00Z');
    const hour = new Date(start.getTime() + 3_600_000);
    const a = eclipticToGlobe({ x: 1, y: 0, z: 0 }, start);
    const b = eclipticToGlobe({ x: 1, y: 0, z: 0 }, hour);
    expect(angleBetween(a, b)).toBeGreaterThan(13);
    expect(angleBetween(a, b)).toBeLessThan(17);
  });
});

describe('the scene fits where it can be drawn', () => {
  it('holds every body inside the measured reach', () => {
    for (const date of DATES) {
      for (const placement of scenePlacements(date)) {
        const r = Math.hypot(...placement.at);
        // Earth is the origin, so everything is offset by up to one compressed
        // AU - Neptune on the far side is the worst case.
        expect(r, `${placement.id} ${date.toISOString()}`).toBeLessThan(
          GLOBE_RADII_AT_NEPTUNE * 2,
        );
      }
    }
  });

  it('leaves Earth out, because Earth is the origin', () => {
    const ids = scenePlacements(DATES[0]).map((p) => p.id);
    expect(ids).not.toContain('earth');
    expect(ids).toContain('sun');
    expect(ids.length).toBe(PLANET_IDS.length); // seven planets plus the Sun
  });

  it('reports true distances even though it draws compressed ones', () => {
    // The panel has to be able to say 30 AU while the picture says 18 radii.
    const placements = scenePlacements(DATES[0]);
    const neptune = placements.find((p) => p.id === 'neptune')!;
    expect(neptune.distanceAu).toBeGreaterThan(29);
    expect(neptune.distanceAu).toBeLessThan(31);
  });
});

describe('the origin is the world you are standing on', () => {
  it('leaves out whichever body is the centre, not always Earth', () => {
    // The first version hard-coded Earth, so standing on Mars drew the Sun an
    // astronomical unit from where Earth would have been - correct rings
    // around a Sun in the wrong place, which reads as a rendering glitch
    // rather than a wrong assumption (D126).
    const fromMars = scenePlacements(DATES[0], 'mars').map((p) => p.id);
    expect(fromMars).not.toContain('mars');
    expect(fromMars).toContain('earth');
    expect(fromMars).toContain('sun');
  });

  it('puts the Sun at Mars s real distance when standing on Mars', () => {
    const sun = scenePlacements(DATES[0], 'mars').find((p) => p.id === 'sun')!;
    // Mars is 1.38 to 1.67 AU out, so the Sun is that far away - not one AU.
    expect(sun.distanceAu).toBeGreaterThan(1.35);
    expect(sun.distanceAu).toBeLessThan(1.70);
  });

  it('draws orbit rings about the same centre the bodies use', () => {
    // A ring built around Earth while the bodies sit around Mars would put
    // every planet off its own path.
    const ring = orbitRing('jupiter', DATES[0], 32, 'mars');
    const jupiter = scenePlacements(DATES[0], 'mars').find((p) => p.id === 'jupiter')!;
    const nearest = Math.min(
      ...ring.map((p) =>
        Math.hypot(p[0] - jupiter.at[0], p[1] - jupiter.at[1], p[2] - jupiter.at[2]),
      ),
    );
    expect(nearest).toBeLessThan(0.6);
  });
});

describe('orbit paths', () => {
  it('closes the ring, because an orbit is closed', () => {
    for (const planet of ['mercury', 'mars', 'saturn'] as const) {
      const ring = orbitRing(planet, DATES[0], 64);
      const first = ring[0];
      const last = ring[ring.length - 1];
      expect(angleBetween(first, last)).toBeLessThan(6);
    }
  });

  it('draws the path the planet will really take, not a circle', () => {
    // Sampled from the planet's own motion, so an eccentric orbit comes out
    // eccentric. Mercury's 0.206 is the clearest case: its furthest point must
    // be meaningfully further than its nearest.
    const ring = orbitRing('mercury', DATES[0], 96);
    const radii = ring.map((p) => Math.hypot(...p));
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.1);
  });
});

describe('aiming the camera at a direction', () => {
  it('is the exact inverse of the sphere convention', () => {
    // If these two ever disagree, a trip to another planet flies somewhere
    // that is not the planet - and it still looks like a trip (D136).
    for (const [lon, lat] of [[0, 0], [45, 30], [-120, -60], [179, 89], [-179, -89]]) {
      const round = lonLatOf(sphereVector(lon, lat));
      expect(round.lon, `lon ${lon},${lat}`).toBeCloseTo(lon, 6);
      expect(round.lat, `lat ${lon},${lat}`).toBeCloseTo(lat, 6);
    }
  });

  it('ignores how far away the direction is', () => {
    // A planet's compressed distance is not a place the camera can go; only
    // the direction is meaningful.
    const near = lonLatOf([1, 0, 0]);
    const far = lonLatOf([50, 0, 0]);
    expect(near).toEqual(far);
  });

  it('puts the poles on the axis without a longitude blowing up', () => {
    expect(lonLatOf([0, 1, 0]).lat).toBeCloseTo(90, 9);
    expect(lonLatOf([0, -1, 0]).lat).toBeCloseTo(-90, 9);
    expect(Number.isFinite(lonLatOf([0, 1, 0]).lon)).toBe(true);
  });

  it('answers something usable for a zero vector rather than NaN', () => {
    expect(lonLatOf([0, 0, 0])).toEqual({ lon: 0, lat: 0 });
  });
});
