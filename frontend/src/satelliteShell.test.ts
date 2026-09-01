import { describe, expect, it } from 'vitest';

import {
  SHELL_MAX,
  SHELL_MIN,
  regimeFor,
  shellFor,
} from './satelliteShell';

const KM = 1000;

// Real altitudes, so every expectation below can be checked against something
// a reader already knows rather than against a number this file invented.
const ISS = 420 * KM;
const STARLINK = 550 * KM;
const LEO_TOP = 2_000 * KM;
const GPS = 20_200 * KM;
const GEO = 35_786 * KM;
const CLUSTER_APOGEE = 105_466 * KM; // measured in the live catalogue

describe('shellFor', () => {
  it('puts a satellite above the aircraft shell, never on the ground', () => {
    // MARKER_ALTITUDE is 0.012. Anything at or below it would read as an
    // object on the surface rather than in orbit.
    expect(shellFor(ISS)).toBeGreaterThan(0.012);
    expect(SHELL_MIN).toBeGreaterThan(0.012);
  });

  it('is strictly monotonic, so higher on screen always means higher in orbit', () => {
    // The single claim this drawing makes. Banded shells would break it for
    // any two satellites inside the same band.
    const altitudes = [200, 420, 550, 800, 1_200, 2_000, 8_000, 20_200, 35_786, 60_000];
    const shells = altitudes.map((km) => shellFor(km * KM));
    for (let i = 1; i < shells.length; i += 1) {
      expect(shells[i]).toBeGreaterThan(shells[i - 1]);
    }
  });

  it('separates the crowded low-orbit band instead of flattening it', () => {
    // The failure mode of true scale: most of the catalogue is between 400 and
    // 2,000 km, which at true scale is a 0.25 R film on the surface with the
    // ISS and a 2,000 km orbit essentially on top of each other.
    const spread = shellFor(LEO_TOP) - shellFor(ISS);
    expect(spread).toBeGreaterThan(0.2);
  });

  it('keeps the ISS and Starlink apart, which true scale barely does', () => {
    // 130 km apart in reality: 0.02 Earth radii, a fifth of a pixel at any
    // sane zoom. Here they are visibly distinct.
    expect(shellFor(STARLINK) - shellFor(ISS)).toBeGreaterThan(0.02);
  });

  it('brings geostationary inside the camera range', () => {
    // 5.6 R at true scale against a camera that stops at 8 R: technically
    // reachable, and only with the Earth shrunk to almost nothing.
    expect(shellFor(GEO)).toBeLessThan(1.2);
    expect(shellFor(GEO)).toBeGreaterThan(0.9);
  });

  it('brings the most eccentric orbit in the catalogue inside the view', () => {
    // Cluster II at apogee is 16.5 Earth radii out - beyond the camera's 8 R
    // limit entirely, so at true scale it simply could not be looked at.
    expect(shellFor(CLUSTER_APOGEE)).toBeLessThanOrEqual(SHELL_MAX);
    expect(shellFor(CLUSTER_APOGEE)).toBeGreaterThan(shellFor(GEO));
  });

  it('never exceeds the maximum shell, however absurd the altitude', () => {
    expect(shellFor(1e12)).toBeLessThanOrEqual(SHELL_MAX);
  });

  it('preserves the real ordering of the regimes', () => {
    expect(shellFor(ISS)).toBeLessThan(shellFor(GPS));
    expect(shellFor(GPS)).toBeLessThan(shellFor(GEO));
  });

  it('falls back to the low shell for an unknown altitude, not to the ground', () => {
    // Drawing an unknown satellite on the surface would claim something we
    // cannot know. The floor claims only "in orbit somewhere low".
    expect(shellFor(null)).toBe(SHELL_MIN);
    expect(shellFor(Number.NaN)).toBe(SHELL_MIN);
    expect(shellFor(-1)).toBe(SHELL_MIN);
  });

  it('hits its stated anchor points', () => {
    // The two altitudes the curve was solved against. If either drifts, the
    // constants no longer mean what the module docstring says they mean.
    expect(shellFor(STARLINK)).toBeCloseTo(0.28, 2);
    expect(shellFor(GEO)).toBeCloseTo(1.05, 2);
  });
});

describe('regimeFor', () => {
  it('names the conventional regimes', () => {
    expect(regimeFor(ISS)).toBe('LEO');
    expect(regimeFor(GPS)).toBe('MEO');
    expect(regimeFor(GEO)).toBe('GEO');
    expect(regimeFor(CLUSTER_APOGEE)).toBe('HEO');
  });

  it('puts the low-orbit boundary at 2,000 km', () => {
    expect(regimeFor(1_999 * KM)).toBe('LEO');
    expect(regimeFor(2_001 * KM)).toBe('MEO');
  });

  it('is null when the altitude is unknown rather than guessing LEO', () => {
    expect(regimeFor(null)).toBeNull();
  });
});
