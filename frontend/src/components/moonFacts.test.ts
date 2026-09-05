import { describe, expect, it } from 'vitest';

import {
  LOST_NOTE,
  PANEL_WIDTH,
  panelPosition,
  SOURCE_NOTE,
  SUB_POINT_NOTE,
  formatLat,
  formatLon,
  moonRows,
  panelState,
} from './moonFacts';
import type { MoonSatellite } from '../moonSatellites';

const LRO: MoonSatellite = {
  id: '-85',
  name: 'LRO',
  operator: 'NASA',
  purpose: 'Mapping the Moon since 2009.',
  lat: 38.378,
  lon: -68.41,
  altitudeKm: 70.9,
};

describe('reading a position', () => {
  it('uses hemispheres rather than minus signs', () => {
    expect(formatLat(38.378)).toBe('38.38° N');
    expect(formatLat(-55.25)).toBe('55.25° S');
    expect(formatLon(-68.41)).toBe('68.41° W');
    expect(formatLon(140.95)).toBe('140.95° E');
  });

  it('puts the equator and the prime meridian on the positive side', () => {
    // Zero is neither hemisphere, and either letter is defensible - but it has
    // to pick one and keep it, or the panel flickers as a craft crosses.
    expect(formatLat(0)).toBe('0.00° N');
    expect(formatLon(0)).toBe('0.00° E');
  });

  it('does not round a pole into the wrong hemisphere', () => {
    // These are polar orbiters; they cross this constantly.
    expect(formatLat(89.999)).toBe('90.00° N');
    expect(formatLat(-89.999)).toBe('90.00° S');
  });
});

describe('the rows', () => {
  it('separates how high it is from what it is over', () => {
    // A reader merges these into one idea unless the panel keeps them apart:
    // the coordinates are a point on the surface beneath the craft, not a
    // place the craft is at.
    const rows = moonRows(LRO);
    expect(rows.map((r) => r.label)).toEqual(['Altitude', 'Over']);
    expect(rows[0].value).toBe('71 km above the Moon');
    expect(rows[1].value).toBe('38.38° N 68.41° W');
  });

  it('marks the positional row as monospace and the altitude not', () => {
    const rows = moonRows(LRO);
    expect(rows[1].mono).toBe(true);
    expect(rows[0].mono).toBeUndefined();
  });

  it('says the coordinates are not a landing site', () => {
    expect(SUB_POINT_NOTE).toMatch(/directly beneath/i);
    expect(SUB_POINT_NOTE).toMatch(/selenographic/i);
  });

  it('says the position is predicted rather than observed', () => {
    // The honesty requirement specific to this panel, asserted rather than
    // left to whoever edits the JSX next. Every other position in Orbital is
    // an observation or derived from one; this one is a published prediction,
    // and a marker on a map cannot convey that.
    expect(SOURCE_NOTE).toMatch(/published ephemeris/i);
    expect(SOURCE_NOTE).toMatch(/predicted to be/i);
    expect(SOURCE_NOTE).toMatch(/Horizons/);
  });
});

describe('what the panel shows', () => {
  it('shows nothing when nothing is selected', () => {
    expect(panelState(null, [LRO])).toEqual({ kind: 'closed' });
  });

  it('shows the craft that is selected', () => {
    const state = panelState('-85', [LRO]);
    expect(state.kind).toBe('craft');
    expect(state.kind === 'craft' && state.craft.name).toBe('LRO');
  });

  it('follows the craft as it moves rather than holding a snapshot', () => {
    // The reason the store keeps the craft rather than what was clicked: these
    // go round in about two hours, so a frozen panel is visibly wrong within a
    // minute of being opened.
    const moved = { ...LRO, altitudeKm: 88.2 };
    const state = panelState('-85', [moved]);
    expect(state.kind === 'craft' && state.craft.altitudeKm).toBe(88.2);
  });

  it('says so when the spacecraft stops being tracked mid-panel', () => {
    // A window can run out while the panel is open. Freezing the last position
    // looks identical to a craft still being followed; closing the panel moves
    // the reader somewhere they did not ask to go.
    expect(panelState('-85', [])).toEqual({ kind: 'lost' });
    expect(LOST_NOTE).toMatch(/no longer covers/i);
  });

  it('does not confuse one spacecraft for another', () => {
    const danuri: MoonSatellite = { ...LRO, id: '-155', name: 'Danuri' };
    const state = panelState('-155', [LRO, danuri]);
    expect(state.kind === 'craft' && state.craft.name).toBe('Danuri');
  });
});

describe('where the floating panel goes', () => {
  const WINDOW = { width: 1200, height: 900 };

  it('hangs off the end of the line, above and to the right', () => {
    // The line leaves the spacecraft to the north-east and the panel sits at
    // its far end, so the two read as one object.
    const { left, top } = panelPosition({ x: 500, y: 500 }, WINDOW);
    expect(left).toBe(500);
    expect(top).toBeLessThan(500);
  });

  it('keeps the panel on screen near the right edge', () => {
    // Without clamping, a spacecraft near the right of the map puts its panel
    // mostly outside the window.
    const { left } = panelPosition({ x: 1180, y: 500 }, WINDOW);
    expect(left).toBeLessThanOrEqual(WINDOW.width - PANEL_WIDTH);
  });

  it('keeps the panel on screen near the top, where these craft mostly are', () => {
    // They are polar orbiters; the top of the globe is not an edge case.
    const { top } = panelPosition({ x: 400, y: 40 }, WINDOW);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('never returns a negative corner, however small the window', () => {
    for (const point of [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: -50, y: -50 }]) {
      const { left, top } = panelPosition(point, { width: 400, height: 400 });
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
    }
  });
});
