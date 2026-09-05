import { describe, expect, it } from 'vitest';

import {
  OFFSET_MAX,
  OFFSET_MIN,
  WINDOW_MS,
  clampInstant,
  describeOffset,
  formatInstant,
  isLive,
} from './timeTravel';

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the window the elements can answer for', () => {
  it('reaches the same distance either way', () => {
    // SGP4 is the same arithmetic in both directions and the backend checks
    // `abs(age_days)`, so the slider is symmetric because the maths is (D119).
    expect(OFFSET_MIN).toBe(-OFFSET_MAX);
    expect(WINDOW_MS).toBe(7 * DAY);
  });

  it('clamps rather than refuses, so the edge is visible', () => {
    // A slider that stops tells the reader where the limit is; one that
    // refuses tells them only that something went wrong.
    expect(clampInstant(NOW - 30 * DAY, NOW)).toBe(NOW - WINDOW_MS);
    expect(clampInstant(NOW + 30 * DAY, NOW)).toBe(NOW + WINDOW_MS);
  });

  it('leaves an instant inside the window alone', () => {
    for (const offset of [-6 * DAY, -HOUR, 0, HOUR, 6 * DAY]) {
      expect(clampInstant(NOW + offset, NOW)).toBe(NOW + offset);
    }
  });

  it('treats the boundary itself as inside', () => {
    expect(clampInstant(NOW - WINDOW_MS, NOW)).toBe(NOW - WINDOW_MS);
    expect(clampInstant(NOW + WINDOW_MS, NOW)).toBe(NOW + WINDOW_MS);
  });
});

describe('saying that the map is not live', () => {
  it('null is live, and only null', () => {
    expect(isLive(null)).toBe(true);
    expect(isLive(NOW)).toBe(false);
    // Zero is a real instant - 1970 - not an absence. A truthiness check here
    // would call it live.
    expect(isLive(0)).toBe(false);
  });

  it('rounds to the unit the reader is thinking in', () => {
    // "10,080 minutes ago" is accurate and useless.
    expect(describeOffset(NOW - 20 * MINUTE, NOW)).toBe('20 minutes ago');
    expect(describeOffset(NOW - 3 * HOUR, NOW)).toBe('3 hours ago');
    expect(describeOffset(NOW - 5 * DAY, NOW)).toBe('5 days ago');
  });

  it('says which way, because ahead and behind are different claims', () => {
    expect(describeOffset(NOW + 3 * HOUR, NOW)).toContain('ahead');
    expect(describeOffset(NOW - 3 * HOUR, NOW)).toContain('ago');
  });

  it('gets the singular right', () => {
    expect(describeOffset(NOW - 1 * MINUTE, NOW)).toBe('1 minute ago');
    expect(describeOffset(NOW - 1 * HOUR, NOW)).toBe('1 hour ago');
    expect(describeOffset(NOW - 1 * DAY - HOUR, NOW)).toBe('25 hours ago');
    expect(describeOffset(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });

  it('does not claim a duration for a sub-minute difference', () => {
    expect(describeOffset(NOW + 20_000, NOW)).toBe('Now');
    expect(describeOffset(NOW, NOW)).toBe('Now');
  });

  it('says Live when there is no instant at all', () => {
    expect(describeOffset(null, NOW)).toBe('Live');
  });
});

describe('the instant itself', () => {
  it('is shown in UTC, because an orbit has no local time', () => {
    expect(formatInstant(NOW)).toBe('2026-09-04 12:00 UTC');
  });
});
