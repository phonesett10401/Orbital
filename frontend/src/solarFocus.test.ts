/**
 * Choosing a body, and the caption that names it (D171).
 */

import { describe, expect, it } from 'vitest';

import { bodyFor } from './bodies';
import {
  FOCUS_ORDER,
  captionFor,
  easeTarget,
  isCentred,
  nearestMarker,
  stepFocus,
  subjectOf,
  driftFrom,
  withDrift,
  easeDrift,
} from './solarFocus';
import { MAX_PITCH } from './solarCamera';

const ALL = FOCUS_ORDER as readonly string[];

describe('stepping between bodies', () => {
  it('walks outward from the sun', () => {
    expect(stepFocus('sun', 1, ALL)).toBe('mercury');
    expect(stepFocus('mercury', 1, ALL)).toBe('venus');
  });

  it('puts the Moon after Earth rather than at its own distance', () => {
    // It has no distance of its own to sort by: it rides with Earth, 0.0026 AU
    // away, below anything this view can show (D140).
    expect(stepFocus('earth', 1, ALL)).toBe('moon');
    expect(stepFocus('moon', 1, ALL)).toBe('mars');
    expect(stepFocus('mars', -1, ALL)).toBe('moon');
  });

  it('wraps at both ends, because ten bodies are a ring in the head', () => {
    // A right arrow that goes dead at Neptune reads as broken, not finished.
    expect(stepFocus('neptune', 1, ALL)).toBe('sun');
    expect(stepFocus('sun', -1, ALL)).toBe('neptune');
  });

  it('starts somewhere sensible from nothing chosen', () => {
    expect(stepFocus(null, 1, ALL)).toBe('sun');
    expect(stepFocus(null, -1, ALL)).toBe('neptune');
  });

  it('skips a body the scene is not drawing', () => {
    // The Moon is drawn as Earth's companion only while Earth is the world
    // below. Stepping onto a body that is not on screen would move the camera
    // to nothing and say the name of it.
    const withoutMoon = ALL.filter((id) => id !== 'moon');
    expect(stepFocus('earth', 1, withoutMoon)).toBe('mars');
    expect(stepFocus('mars', -1, withoutMoon)).toBe('earth');
  });

  it('recovers when the chosen body leaves the scene', () => {
    expect(stepFocus('moon', 1, ALL.filter((id) => id !== 'moon'))).toBe('sun');
  });

  it('has nothing to step to in an empty scene', () => {
    expect(stepFocus('earth', 1, [])).toBeNull();
  });
});

describe('clicking a body on a canvas that hit-tests nothing', () => {
  const markers = [
    { id: 'sun', x: 400, y: 400, sizePx: 40 },
    { id: 'mercury', x: 460, y: 400, sizePx: 3 },
  ];

  it('finds the body under the pointer', () => {
    expect(nearestMarker(markers, 402, 398)).toBe('sun');
  });

  it('gives a small body a target bigger than itself', () => {
    // Mercury is three pixels wide here. A tolerance of its own radius is not
    // a target, which is defect #5 exactly - a marker that did nothing when
    // clicked.
    expect(nearestMarker(markers, 470, 405)).toBe('mercury');
  });

  it('picks the nearer of two overlapping targets', () => {
    expect(nearestMarker(markers, 455, 400)).toBe('mercury');
    expect(nearestMarker(markers, 415, 400)).toBe('sun');
  });

  it('returns nothing for empty sky, so a click there can mean deselect', () => {
    expect(nearestMarker(markers, 100, 100)).toBeNull();
    expect(nearestMarker([], 400, 400)).toBeNull();
  });
});

describe('what the caption says', () => {
  it('names a planet, its distance and its size', () => {
    const caption = captionFor(bodyFor('mars')!, 1.52);
    expect(caption.name).toBe('Mars');
    expect(caption.eyebrow).toContain('Planet');
    expect(caption.eyebrow).toContain('1.52 AU');
    expect(caption.eyebrow).toContain('3,390 km');
  });

  it('offers a visit only where there is a surface to stand on', () => {
    expect(captionFor(bodyFor('mars')!, 1.52).action).toEqual({
      kind: 'visit',
      label: 'Visit Mars',
    });
  });

  it("gives the body's own reason when there is nothing to go to", () => {
    // The Sun is the only one left with no imagery at all, and it says why in
    // its own words rather than in a sentence written here.
    const sun = captionFor(bodyFor('sun')!, null).action;
    expect(sun.kind).toBe('none');
    if (sun.kind === 'none') {
      expect(sun.reason).toBe(bodyFor('sun')!.noSurfaceReason);
      expect(sun.reason).toMatch(/star/i);
    }

    // Jupiter went the other way (D193): it can be visited now, and the
    // eyebrow rather than the button carries the fact that there is nothing
    // under the cloud. Offering "Visit Jupiter" with no such line would
    // quietly promise ground.
    const jupiter = captionFor(bodyFor('jupiter')!, 5.2);
    expect(jupiter.action.kind).toBe('visit');
    expect(jupiter.eyebrow).toMatch(/cloud tops, no surface/i);
    expect(captionFor(bodyFor('mars')!, 1.5).eyebrow).not.toMatch(/cloud/i);
  });

  it('leaves the distance out when there is not one to give', () => {
    // The Sun is not at a distance from itself, and the Moon's distance from
    // the Sun is Earth's - saying either would be filling the shape rather
    // than reporting something.
    expect(captionFor(bodyFor('sun')!, null).eyebrow).not.toMatch(/AU/);
    expect(captionFor(bodyFor('moon')!, null).eyebrow).toContain("Earth's companion");
    expect(captionFor(bodyFor('moon')!, null).eyebrow).not.toMatch(/AU/);
  });

  it('groups the kilometres, because six unbroken digits is not a number', () => {
    expect(captionFor(bodyFor('jupiter')!, 5.2).eyebrow).toContain('69,911 km');
  });
});

describe('flying the camera to a body', () => {
  it('closes a fixed proportion of the gap each step', () => {
    const from: [number, number, number] = [0, 0, 0];
    const to: [number, number, number] = [10, 0, 0];
    expect(easeTarget(from, to, 0.25)).toEqual([2.5, 0, 0]);
  });

  it('converges from anywhere, which the screen-space version did not', () => {
    // The first attempt panned by how far off centre the body *looked*, which
    // is not the inverse of the projection once the camera has any pitch: the
    // correction overshot and grew, and the camera flew off into empty sky.
    // Interpolating in the body's own space cannot do that.
    let at: [number, number, number] = [-40, 12, 33];
    const goal: [number, number, number] = [5, 0, -2];
    for (let i = 0; i < 200; i += 1) at = easeTarget(at, goal, 0.14);
    expect(isCentred(at, goal, 0.02)).toBe(true);
  });

  it('never overshoots, whatever fraction it is given', () => {
    expect(easeTarget([0, 0, 0], [10, 0, 0], 3)).toEqual([10, 0, 0]);
    expect(easeTarget([0, 0, 0], [10, 0, 0], -1)).toEqual([0, 0, 0]);
  });

  it('knows when it has arrived', () => {
    expect(isCentred([0, 0, 0], [0.01, 0, 0], 0.02)).toBe(true);
    expect(isCentred([0, 0, 0], [1, 0, 0], 0.02)).toBe(false);
  });
});

describe('what the page says it is showing', () => {
  const EVERYTHING = FOCUS_ORDER as readonly string[];

  it('names the Moon when the Moon is drawn', () => {
    expect(subjectOf(EVERYTHING)).toBe('The sun, eight planets and the Moon');
  });

  it('does not name the Moon when the Moon is absent', () => {
    // The defect Phone caught. The Moon is drawn as Earth's *companion*, so it
    // is simply not there once the camera is anywhere but home - and the
    // masthead announced it anyway, because the sentence was a constant.
    const fromMars = EVERYTHING.filter((id) => id !== 'moon');
    expect(subjectOf(fromMars)).toBe('The sun and eight planets');
    expect(subjectOf(fromMars)).not.toMatch(/moon/i);
  });

  it('counts the planets it actually drew rather than assuming eight', () => {
    expect(subjectOf(['sun', 'earth', 'mars'])).toBe('The sun and two planets');
    expect(subjectOf(['sun', 'earth'])).toBe('The sun and one planet');
  });

  it('spells the number, because a numeral in prose reads as data', () => {
    expect(subjectOf(EVERYTHING)).toContain('eight planets');
    expect(subjectOf(EVERYTHING)).not.toMatch(/\b8\b/);
  });

  it('copes with a scene missing the sun, or missing everything', () => {
    expect(subjectOf(['earth', 'moon'])).toBe('One planet and the Moon');
    expect(subjectOf(['moon'])).toBe('The Moon');
    expect(subjectOf([])).toBe('Nothing in view');
  });
});

describe('the pointer drift that keeps the system alive', () => {
  const camera = { target: [0, 0, 0] as [number, number, number], distance: 20, yaw: 0.4, pitch: 0.5 };

  it('reads the middle of the canvas as no drift at all', () => {
    expect(driftFrom(400, 300, 800, 600)).toEqual({ x: 0, y: 0 });
  });

  it('reads the corners as full drift', () => {
    expect(driftFrom(800, 600, 800, 600)).toEqual({ x: 1, y: 1 });
    expect(driftFrom(0, 0, 800, 600)).toEqual({ x: -1, y: -1 });
  });

  it('clamps a pointer that left the element', () => {
    // Pointer capture during a drag reports positions outside the canvas. An
    // unclamped drift would swing further the further the pointer went, which
    // is a drag by another name.
    expect(driftFrom(3000, -900, 800, 600)).toEqual({ x: 1, y: -1 });
  });

  it('survives a canvas with no size, which is the first frame', () => {
    expect(driftFrom(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('leans the view away from the pointer', () => {
    // Toward would feel like dragging the scene; away reads as looking around
    // something that is standing still.
    const drifted = withDrift(camera, { x: 1, y: 0 }, 0.04, 0.02);
    expect(drifted.yaw).toBeCloseTo(0.36, 6);
  });

  it('never writes the drift into the camera it was given', () => {
    // The whole reason it is applied at render: folded in, every frame would
    // drift from the drifted one and the camera would wander off on its own.
    const before = { ...camera };
    withDrift(camera, { x: 1, y: 1 }, 0.04, 0.02);
    expect(camera).toEqual(before);
  });

  it('cannot tip the camera past straight down', () => {
    const steep = { ...camera, pitch: MAX_PITCH };
    expect(withDrift(steep, { x: 0, y: -1 }, 0.04, 0.5).pitch).toBeLessThanOrEqual(MAX_PITCH);
    expect(withDrift(steep, { x: 0, y: 1 }, 0.04, 0.5).pitch).toBeGreaterThanOrEqual(-MAX_PITCH);
  });

  it('eases toward a new drift rather than snapping to it', () => {
    expect(easeDrift({ x: 0, y: 0 }, { x: 1, y: -1 }, 0.5)).toEqual({ x: 0.5, y: -0.5 });
  });

  it('settles back to nothing when the pointer leaves', () => {
    let at = { x: 1, y: 1 };
    for (let i = 0; i < 200; i += 1) at = easeDrift(at, { x: 0, y: 0 }, 0.08);
    expect(Math.hypot(at.x, at.y)).toBeLessThan(0.001);
  });
});
