import { describe, expect, it } from 'vitest';

import {
  INNER,
  MIN_ALPHA,
  distanceAt,
  drawStreaks,
  intensity,
  makeField,
  streakFor,
} from './warp';

const APEX = 0.6;

describe('the field', () => {
  it('is the same field every time, given the same seed', () => {
    // A field that differs between two runs of the same trip is a field nobody
    // can debug from a screenshot, and one a test can say nothing about.
    expect(makeField(20, 7)).toEqual(makeField(20, 7));
  });

  it('is a different field for a different seed', () => {
    expect(makeField(20, 7)).not.toEqual(makeField(20, 8));
  });

  it('spreads the stars all the way round', () => {
    const angles = makeField(400).map((s) => s.angle);
    expect(Math.min(...angles)).toBeLessThan(0.5);
    expect(Math.max(...angles)).toBeGreaterThan(Math.PI * 2 - 0.5);
  });

  it('makes most of them faint and a few of them bright', () => {
    // A uniform field looks like a screen of identical dots, which is what it
    // would be.
    const brightness = makeField(400).map((s) => s.brightness);
    const mean = brightness.reduce((a, b) => a + b, 0) / brightness.length;
    expect(mean).toBeLessThan(0.6);
    expect(Math.max(...brightness)).toBeGreaterThan(0.9);
  });
});

describe('how hard it is running', () => {
  it('starts and ends at nothing', () => {
    // So the effect begins and finishes on the map rather than snapping on.
    expect(intensity(0, APEX)).toBeCloseTo(0);
    expect(intensity(1, APEX)).toBeCloseTo(0);
  });

  it('is loudest exactly at the apex, not at the midpoint', () => {
    // The apex is where the world is swapped. The brightest instant should be
    // the one with something to cover; anywhere else leaves the swap in a
    // quiet frame.
    expect(intensity(APEX, APEX)).toBeCloseTo(1);
    expect(intensity(0.5, APEX)).toBeLessThan(intensity(APEX, APEX));
  });

  it('rises to the apex and falls away from it', () => {
    expect(intensity(0.3, APEX)).toBeLessThan(intensity(0.5, APEX));
    expect(intensity(0.8, APEX)).toBeLessThan(intensity(0.7, APEX));
  });

  it('never leaves the range whatever it is given', () => {
    for (const p of [-3, -0.1, 0, 0.5, 1, 1.4, 99]) {
      const i = intensity(p, APEX);
      expect(i, String(p)).toBeGreaterThanOrEqual(0);
      expect(i, String(p)).toBeLessThanOrEqual(1);
    }
  });

  it('survives an apex at either extreme', () => {
    // A trip whose plan has a zero-length step would otherwise divide by zero
    // and paint every pixel NaN, which canvas renders as nothing at all.
    for (const apex of [0, 1]) {
      expect(Number.isFinite(intensity(0.5, apex)), String(apex)).toBe(true);
    }
  });
});

describe('a star running outward', () => {
  const star = { angle: 0, seed: 0, brightness: 1 };

  it('accelerates rather than drifting', () => {
    // The difference between speed and falling snow: the last quarter of the
    // field is crossed in far less time than the first.
    const early = distanceAt(star, 0.05) - distanceAt(star, 0);
    const late = distanceAt(star, 0.3) - distanceAt(star, 0.25);
    expect(late).toBeGreaterThan(early);
  });

  it('starts over when it reaches the edge', () => {
    // Otherwise the field empties halfway through the trip and the loudest
    // moment has nothing in it.
    expect(distanceAt(star, 0)).toBeCloseTo(0);
    expect(distanceAt(star, 1)).toBeLessThan(1);
  });
});

describe('a streak', () => {
  const field = makeField(60);

  it('always points away from the vanishing point', () => {
    // A tail on the wrong end reads as falling into the screen rather than
    // rushing out of it.
    for (const star of field) {
      const s = streakFor(star, 0.5, APEX);
      const near = Math.hypot(s.x1, s.y1);
      const far = Math.hypot(s.x2, s.y2);
      expect(far).toBeGreaterThanOrEqual(near);
    }
  });

  it('lies on the star’s own bearing at both ends', () => {
    const s = streakFor({ angle: Math.PI / 2, seed: 0.4, brightness: 1 }, 0.5, APEX);
    expect(s.x1).toBeCloseTo(0);
    expect(s.x2).toBeCloseTo(0);
    expect(s.y2).toBeGreaterThan(0);
  });

  it('never draws inside the vanishing point', () => {
    // Streaks through the centre look like a crosshair rather than a tunnel.
    for (const star of field) {
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        expect(Math.hypot(streakFor(star, p, APEX).x1, streakFor(star, p, APEX).y1)).
          toBeGreaterThanOrEqual(INNER - 1e-9);
      }
    }
  });

  it('has no tail and no brightness before the trip starts', () => {
    for (const star of field) {
      const s = streakFor(star, 0, APEX);
      expect(s.alpha).toBeCloseTo(0);
      expect(Math.hypot(s.x2 - s.x1, s.y2 - s.y1)).toBeCloseTo(0);
    }
  });

  it('has its longest tails at the apex', () => {
    const star = { angle: 0, seed: 0.8, brightness: 1 };
    const length = (p: number) => {
      const s = streakFor(star, p, APEX);
      return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    };
    expect(length(APEX)).toBeGreaterThan(length(0.15));
    expect(length(APEX)).toBeGreaterThan(length(0.95));
  });

  it('stays inside the disc it is defined in', () => {
    // The caller scales this to the screen; a value past 1 would streak beyond
    // the corner it was sized for.
    for (const star of field) {
      for (const p of [0, 0.33, 0.66, 1]) {
        expect(Math.hypot(streakFor(star, p, APEX).x2, streakFor(star, p, APEX).y2)).
          toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

function recorder() {
  const strokes: { from: [number, number]; to: [number, number]; style: string }[] = [];
  let pending: [number, number] | null = null;
  let style = '';
  return {
    strokes,
    lineCap: '',
    lineWidth: 0,
    set strokeStyle(v: string) {
      style = v;
    },
    get strokeStyle() {
      return style;
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      pending = [x, y];
    },
    lineTo(x: number, y: number) {
      if (pending) strokes.push({ from: pending, to: [x, y], style });
    },
    stroke() {},
  };
}

describe('drawing a frame', () => {
  // A recorder rather than a canvas: the test environment has none, and the
  // preview pane this was built in throttles requestAnimationFrame hard enough
  // that a three-second animation can pass in two frames - so watching it prove
  // nothing either way (D155).
  const field = makeField(200);

  it('draws nothing at all before the trip has started', () => {
    const ctx = recorder();
    expect(drawStreaks(ctx, field, 0, 0.6, 1200, 800)).toBe(0);
    expect(ctx.strokes).toHaveLength(0);
  });

  it('draws a full field at the apex', () => {
    // The assertion that would have caught an effect that runs and shows
    // nothing, which is exactly what could not be seen in the browser.
    const ctx = recorder();
    const drawn = drawStreaks(ctx, field, 0.6, 0.6, 1200, 800);
    expect(drawn).toBeGreaterThan(field.length * 0.8);
    expect(ctx.strokes.length).toBe(drawn);
  });

  it('lays down the most light at the apex', () => {
    // Total ink, not the number of strokes: by a fifth of the way in every
    // star is already above the alpha floor, so counting them saturates and
    // compares nothing. Measured that way first, and it said 200 = 200.
    const ink = (p: number) => {
      const ctx = recorder();
      drawStreaks(ctx, field, p, 0.6, 1200, 800);
      return ctx.strokes.reduce(
        (sum, s) => sum + Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]),
        0,
      );
    };
    expect(ink(0.6)).toBeGreaterThan(ink(0.15));
    expect(ink(0.6)).toBeGreaterThan(ink(0.95));
  });

  it('centres the field on the screen', () => {
    // The vanishing point is the direction of travel, because the camera has
    // been turned to face the destination by then (D136).
    //
    // Four stars on the compass points rather than the random field: the
    // extremes of two hundred random bearings are not symmetric, so the first
    // version of this asserted a midpoint of 600 against an honest 627 and was
    // measuring sampling noise, not the drawing.
    const cross = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((angle) => ({
      angle,
      seed: 0.5,
      brightness: 1,
    }));
    const ctx = recorder();
    drawStreaks(ctx, cross, 0.6, 0.6, 1200, 800);
    const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
    expect(mean(ctx.strokes.map((s) => s.to[0]))).toBeCloseTo(600, 6);
    expect(mean(ctx.strokes.map((s) => s.to[1]))).toBeCloseTo(400, 6);
  });

  it('reaches past the corner rather than stopping inside it', () => {
    // Scaled by the half-diagonal, so a streak at the unit edge leaves the
    // screen. Scaling by the shorter axis would leave a visible ring of
    // untouched pixels in the corners.
    const ctx = recorder();
    drawStreaks(ctx, field, 0.6, 0.6, 1200, 800);
    const furthest = Math.max(...ctx.strokes.map((s) => Math.hypot(s.to[0] - 600, s.to[1] - 400)));
    expect(furthest).toBeGreaterThan(400);
  });

  it('skips the ones too faint to be worth a stroke', () => {
    const ctx = recorder();
    drawStreaks(ctx, field, 0.02, 0.6, 1200, 800);
    for (const s of ctx.strokes) {
      const alpha = Number(s.style.match(/([\d.]+)\)$/)?.[1]);
      expect(alpha).toBeGreaterThanOrEqual(MIN_ALPHA);
    }
  });

  it('never emits a NaN coordinate', () => {
    // Canvas renders a NaN path as nothing at all, silently, which is the
    // hardest possible version of this bug to find.
    for (const p of [0, 0.25, 0.6, 1]) {
      const ctx = recorder();
      drawStreaks(ctx, field, p, 0.6, 1200, 800);
      for (const s of ctx.strokes) {
        expect(Number.isFinite(s.from[0]) && Number.isFinite(s.from[1])).toBe(true);
        expect(Number.isFinite(s.to[0]) && Number.isFinite(s.to[1])).toBe(true);
      }
    }
  });
});
