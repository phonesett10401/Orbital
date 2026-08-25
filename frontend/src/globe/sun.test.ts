/**
 * Tests for solar position.
 *
 * Checked against facts anyone can verify: the sun is over the equator at the
 * equinoxes, over the tropics at the solstices, and over the prime meridian
 * near noon UTC. A terminator drawn from a wrong sun looks entirely plausible
 * — day and night, just in the wrong places — so it needs real assertions
 * rather than a glance.
 */

import { describe, expect, it } from 'vitest';

import { subsolarPoint } from './sun';

describe('subsolarPoint declination', () => {
  it('is near zero at the March equinox', () => {
    const { lat } = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
    expect(Math.abs(lat)).toBeLessThan(0.6);
  });

  it('is near zero at the September equinox', () => {
    const { lat } = subsolarPoint(new Date('2026-09-22T12:00:00Z'));
    expect(Math.abs(lat)).toBeLessThan(0.7);
  });

  it('is near the Tropic of Cancer at the June solstice', () => {
    const { lat } = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
    expect(lat).toBeGreaterThan(23.0);
    expect(lat).toBeLessThan(23.5);
  });

  it('is near the Tropic of Capricorn at the December solstice', () => {
    const { lat } = subsolarPoint(new Date('2026-12-21T12:00:00Z'));
    expect(lat).toBeLessThan(-23.0);
    expect(lat).toBeGreaterThan(-23.5);
  });

  it('never leaves the tropics', () => {
    // Sampled across a year: the declination is bounded by the axial tilt.
    for (let day = 0; day < 365; day += 7) {
      const date = new Date(Date.UTC(2026, 0, 1 + day, 12));
      const { lat } = subsolarPoint(date);
      expect(Math.abs(lat)).toBeLessThanOrEqual(23.5);
    }
  });
});

describe('subsolarPoint longitude', () => {
  it('is near the prime meridian at noon UTC', () => {
    // Offset by the equation of time, which never exceeds ~16 minutes, or 4
    // degrees of longitude.
    const { lon } = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
    expect(Math.abs(lon)).toBeLessThan(5);
  });

  it('is near the antimeridian at midnight UTC', () => {
    const { lon } = subsolarPoint(new Date('2026-03-20T00:00:00Z'));
    expect(Math.abs(lon)).toBeGreaterThan(175);
  });

  it('is over the Americas in the evening UTC', () => {
    // 18:00 UTC is local noon around 90 degrees west.
    const { lon } = subsolarPoint(new Date('2026-06-21T18:00:00Z'));
    expect(lon).toBeGreaterThan(-95);
    expect(lon).toBeLessThan(-85);
  });

  it('moves west at roughly fifteen degrees an hour', () => {
    const first = subsolarPoint(new Date('2026-06-21T06:00:00Z')).lon;
    const second = subsolarPoint(new Date('2026-06-21T07:00:00Z')).lon;
    expect(first - second).toBeCloseTo(15, 0);
  });

  it('always returns a longitude inside the valid range', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const { lon } = subsolarPoint(new Date(Date.UTC(2026, 5, 21, hour)));
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThan(180);
    }
  });

  it('does not jump discontinuously as right ascension wraps', () => {
    // The equation-of-time calculation subtracts two angles that can straddle
    // 360 degrees. Without wrapping the difference, the terminator lurches by
    // a full day's rotation on certain dates.
    let previous = subsolarPoint(new Date(Date.UTC(2026, 0, 1, 12))).lon;
    for (let day = 1; day < 365; day += 1) {
      const lon = subsolarPoint(new Date(Date.UTC(2026, 0, 1 + day, 12))).lon;
      expect(Math.abs(lon - previous)).toBeLessThan(2);
      previous = lon;
    }
  });
});
