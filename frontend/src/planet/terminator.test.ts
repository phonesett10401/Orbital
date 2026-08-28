/**
 * Tests for the day/night terminator on the planet view.
 *
 * The thing that can be checked here is **where night is**, and it is checked
 * against the sun rather than against itself: `subsolarPoint` is the same
 * function the globe's shading uses and is already pinned to known equinox and
 * solstice values in `sun.test.ts` (§11.3), so these tests ask whether the
 * layer puts darkness on the half of the world facing away from it.
 *
 * The mesh is checked for the two things that are silently wrong rather than
 * visibly wrong: whether both projections describe the *same* vertices, and
 * whether the texture coordinates put north at the top. A night side rendered
 * upside down still looks like a night side.
 *
 * What is not checked is how it looks. That needs an eye and this machine has
 * none — see D50 and §19.17 for why that sentence keeps appearing.
 */

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { subsolarPoint } from '../globe/sun';
import { mercatorX, mercatorY, sphereVector } from './modelFrame';
import { createTerminatorControl } from './terminatorControl';
import {
  DAY_AT,
  GRID_STEP_DEGREES,
  NIGHT_AT,
  NIGHT_STRENGTH,
  TERMINATOR_LAYER,
  createTerminatorLayer,
  graticule,
  nightAlpha,
  subsolarVector,
  translation,
} from './terminatorLayer';

/** Noon UTC at an equinox: the sun is over the Gulf of Guinea, near 0/0. */
const EQUINOX_NOON = new Date('2026-03-20T12:00:00Z');

describe('graticule', () => {
  const grid = graticule();

  it('covers the world at the step it says', () => {
    const columns = 360 / GRID_STEP_DEGREES + 1;
    const rows = 180 / GRID_STEP_DEGREES + 1;
    expect(grid.normals.length / 3).toBe(columns * rows);
    expect(grid.indices.length).toBe((columns - 1) * (rows - 1) * 6);
  });

  it('describes one set of vertices in two projections', () => {
    // The point of building both here: a separate mesh per projection is two
    // meshes that can drift apart, and the drift would look like the night
    // side jumping as the map crossed the transition zoom.
    const count = grid.normals.length / 3;
    expect(grid.spherePositions.length / 3).toBe(count);
    expect(grid.mercatorPositions.length / 3).toBe(count);
    expect(grid.uvs.length / 2).toBe(count);
  });

  it('puts its first vertex at the north-west corner', () => {
    expect([grid.spherePositions[0], grid.spherePositions[1], grid.spherePositions[2]]).toEqual(
      Array.from(sphereVector(-180, 90)).map((v) => Math.fround(v)),
    );
    expect(grid.mercatorPositions[0]).toBeCloseTo(0, 6);
    expect(grid.uvs[0]).toBeCloseTo(0, 6);
    expect(grid.uvs[1]).toBeCloseTo(0, 6);
  });

  it('maps the texture equirectangularly, north at v = 0', () => {
    // The lights image runs north to south like every equirectangular map. Set
    // the other way round the world is upside down, which is a picture that
    // still looks plausible at a glance.
    const columns = 360 / GRID_STEP_DEGREES + 1;
    const middleRow = (180 / GRID_STEP_DEGREES / 2) * columns;
    expect(grid.uvs[middleRow * 2 + 1]).toBeCloseTo(0.5, 6);
    const lastVertex = grid.normals.length / 3 - 1;
    expect(grid.uvs[lastVertex * 2]).toBeCloseTo(1, 6);
    expect(grid.uvs[lastVertex * 2 + 1]).toBeCloseTo(1, 6);
  });

  it('stops the mercator mesh where mercator stops', () => {
    // Mercator sends the poles to infinity. Left unclamped the first row's Y
    // is not a number and the whole mesh disappears.
    for (let i = 0; i < grid.mercatorPositions.length; i += 3) {
      expect(Number.isFinite(grid.mercatorPositions[i + 1])).toBe(true);
    }
    expect(grid.mercatorPositions[1]).toBeCloseTo(mercatorY(85.051129), 6);
    // Which is the top edge of the mercator square, give or take a rounding.
    expect(grid.mercatorPositions[1]).toBeCloseTo(0, 6);
  });

  it('agrees with the mercator arithmetic used everywhere else', () => {
    const columns = 360 / GRID_STEP_DEGREES + 1;
    // One vertex, ten degrees in and ten degrees down: 170 W, 70 N.
    const index = 10 * columns + 5;
    expect(grid.mercatorPositions[index * 3]).toBeCloseTo(mercatorX(-170), 6);
    expect(grid.mercatorPositions[index * 3 + 1]).toBeCloseTo(mercatorY(70), 6);
  });

  it('winds every triangle the same way', () => {
    // Not for culling - the material is double-sided - but because a flipped
    // index pair is a hole in the mesh, and a hole in a night side is a patch
    // of daylight in the middle of the Pacific at 3am.
    const columns = 360 / GRID_STEP_DEGREES + 1;
    for (let cell = 0; cell < 5; cell += 1) {
      const at = cell * 6;
      const a = grid.indices[at];
      expect(grid.indices[at + 1]).toBe(a + columns);
      expect(grid.indices[at + 2]).toBe(a + 1);
    }
  });
});

describe('subsolarVector', () => {
  it('points where the sun is', () => {
    const { lat, lon } = subsolarPoint(EQUINOX_NOON);
    const expected = sphereVector(lon, lat);
    const actual = subsolarVector(EQUINOX_NOON);
    for (let i = 0; i < 3; i += 1) expect(actual[i]).toBeCloseTo(expected[i], 12);
  });

  it('is a unit vector on the equator at an equinox', () => {
    const sun = subsolarVector(EQUINOX_NOON);
    expect(Math.hypot(...sun)).toBeCloseTo(1, 12);
    // Declination is within a degree of zero, so Y - the polar axis - is small.
    expect(Math.abs(sun[1])).toBeLessThan(0.02);
  });

  it('has swept most of the way round the planet twelve hours later', () => {
    const noon = subsolarVector(EQUINOX_NOON);
    const midnight = subsolarVector(new Date('2026-03-20T00:00:00Z'));
    const dot = noon[0] * midnight[0] + noon[1] * midnight[1] + noon[2] * midnight[2];
    expect(dot).toBeLessThan(-0.98);
  });
});

describe('nightAlpha', () => {
  it('is fully dark with the sun well below the horizon', () => {
    expect(nightAlpha(-1)).toBeCloseTo(NIGHT_STRENGTH, 12);
    expect(nightAlpha(NIGHT_AT)).toBeCloseTo(NIGHT_STRENGTH, 12);
  });

  it('is fully transparent in daylight', () => {
    expect(nightAlpha(1)).toBe(0);
    expect(nightAlpha(DAY_AT)).toBe(0);
  });

  it('leaves the imagery showing through at its darkest', () => {
    // 0.85 is the globe's `lit * 0.15`: the same 15% of the ground survives
    // night in both views. A fully opaque night would be a black disc, and the
    // user would think the map had failed rather than that it was night.
    expect(NIGHT_STRENGTH).toBe(0.85);
    expect(1 - nightAlpha(-1)).toBeCloseTo(0.15, 12);
  });

  it('crosses the terminator smoothly, and monotonically', () => {
    let previous = nightAlpha(-1);
    for (let dot = -1; dot <= 1; dot += 0.01) {
      const alpha = nightAlpha(dot);
      expect(alpha).toBeLessThanOrEqual(previous + 1e-12);
      previous = alpha;
    }
    // Half dark halfway across the band, which is what smoothstep means.
    expect(nightAlpha((NIGHT_AT + DAY_AT) / 2)).toBeCloseTo(NIGHT_STRENGTH / 2, 12);
  });

  it('honours a strength that is not the default', () => {
    expect(nightAlpha(-1, 0.4)).toBeCloseTo(0.4, 12);
  });

  it('puts night on the half of the world facing away from the sun', () => {
    // The end-to-end question, asked of the two functions together rather than
    // of the constants: is midnight dark and is noon not?
    const sun = subsolarVector(EQUINOX_NOON);
    const dotAt = (lon: number, lat: number) => {
      const n = sphereVector(lon, lat);
      return n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
    };
    const { lon: sunLon } = subsolarPoint(EQUINOX_NOON);
    expect(nightAlpha(dotAt(sunLon, 0))).toBe(0);
    expect(nightAlpha(dotAt(sunLon + 180, 0))).toBeCloseTo(NIGHT_STRENGTH, 12);
    // And Bangkok, where it is early evening at this instant.
    expect(nightAlpha(dotAt(100.5, 13.75))).toBeGreaterThan(0);
  });
});

describe('translation', () => {
  it('shifts along mercator X and nothing else', () => {
    const matrix = new THREE.Matrix4().fromArray(translation(-1));
    const point = new THREE.Vector3(0.25, 0.4, 0).applyMatrix4(matrix);
    expect(point.x).toBeCloseTo(-0.75, 12);
    expect(point.y).toBeCloseTo(0.4, 12);
    expect(point.z).toBeCloseTo(0, 12);
  });
});

describe('the layer', () => {
  function harness(enabled: boolean) {
    const renderer = { autoClear: true, resetState: vi.fn(), render: vi.fn() };
    const texture = new THREE.Texture();
    const loadTexture = vi.fn(() => texture);
    const layer = createTerminatorLayer({
      enabled,
      lightsUrl: '/textures/earth-night.jpg',
      loadTexture,
      now: () => EQUINOX_NOON,
      createRenderer: () => renderer,
    });
    const map = {
      getCanvas: () => document.createElement('canvas'),
    } as unknown as import('maplibre-gl').Map;
    layer.onAdd?.(map, {} as WebGL2RenderingContext);
    return { layer, renderer, loadTexture, texture };
  }

  function args(projectionTransition = 1) {
    return {
      defaultProjectionData: {
        mainMatrix: new THREE.Matrix4().makeScale(2, 2, 2).toArray(),
        fallbackMatrix: new THREE.Matrix4().makeScale(3, 3, 3).toArray(),
        clippingPlane: [0, 0, 1, 0],
        projectionTransition,
        tileMercatorCoords: [0, 0, 1, 1],
        clipAntimeridian: false,
      },
    } as unknown as import('maplibre-gl').CustomRenderMethodInput;
  }

  it('takes no part in the depth buffer', () => {
    // '3d' would put a full-world mesh into MapLibre's depth buffer and hide
    // whatever it decides is behind it.
    const { layer } = harness(true);
    expect(layer.id).toBe(TERMINATOR_LAYER);
    expect(layer.renderingMode).toBe('2d');
  });

  it('draws nothing at all while it is off', () => {
    const { layer, renderer } = harness(false);
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.render).not.toHaveBeenCalled();
    expect(layer.drawsLastFrame()).toBe(0);
    expect(layer.describe()).toBe('off');
  });

  it('does not fetch the lights until it is switched on', () => {
    // The same argument city mode's lazy load made: a user who never turns
    // this on should never pay for the texture.
    const { layer, loadTexture } = harness(false);
    expect(loadTexture).not.toHaveBeenCalled();
    layer.setEnabled(true);
    expect(loadTexture).toHaveBeenCalledTimes(1);
    layer.setEnabled(false);
    layer.setEnabled(true);
    expect(loadTexture).toHaveBeenCalledTimes(1);
  });

  it('does not let three.js flip the lights upside down', () => {
    // three.js flips images by default because GL texture space runs bottom
    // up; the texture coordinates here are built top down to match the image.
    const { layer, texture } = harness(false);
    layer.setEnabled(true);
    expect(texture.flipY).toBe(false);
  });

  it('draws the globe once', () => {
    const { layer, renderer } = harness(true);
    layer.render({} as WebGL2RenderingContext, args(1));
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(layer.drawsLastFrame()).toBe(1);
    expect(layer.describe()).toMatch(/globe frame/);
    const expected = new THREE.Matrix4().makeScale(2, 2, 2).toArray();
    expect(layer.camera.projectionMatrix.toArray()).toEqual(expected);
  });

  it('draws mercator three times, so panning does not run off the edge', () => {
    // The mercator mesh spans one copy of the world. MapLibre repeats the
    // world east and west, and a single copy would end at a hard edge in the
    // middle of the ocean.
    const { layer, renderer } = harness(true);
    layer.render({} as WebGL2RenderingContext, args(0));
    expect(renderer.render).toHaveBeenCalledTimes(3);
    expect(layer.drawsLastFrame()).toBe(3);
    expect(layer.describe()).toMatch(/mercator frame · 3 draws/);
    // The last of the three is the eastern copy, one world width across.
    const shifted = new THREE.Matrix4()
      .makeScale(3, 3, 3)
      .multiply(new THREE.Matrix4().fromArray(translation(1)))
      .toArray();
    const actual = layer.camera.projectionMatrix.toArray();
    for (let i = 0; i < 16; i += 1) expect(actual[i]).toBeCloseTo(shifted[i], 12);
  });

  it('switches on and off without being re-added', () => {
    const { layer, renderer } = harness(false);
    expect(layer.isEnabled()).toBe(false);
    layer.setEnabled(true);
    expect(layer.isEnabled()).toBe(true);
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.render).toHaveBeenCalledTimes(1);
    layer.setEnabled(false);
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('says what it is doing, for the readout', () => {
    const { layer } = harness(true);
    expect(layer.describe()).toBe('never rendered');
    layer.render({} as WebGL2RenderingContext, args());
    expect(layer.describe()).toMatch(/^on · globe frame · 1 draw$/);
  });
});

describe('the toggle', () => {
  it('starts in the state it is given, and says what it will do', () => {
    // A button labelled with its current state reads as a status line, and
    // gets pressed by someone trying to confirm what they are looking at.
    const off = createTerminatorControl(() => {}, false);
    expect(off.button.title).toBe('Show night');
    expect(off.button.getAttribute('aria-pressed')).toBe('false');

    const on = createTerminatorControl(() => {}, true);
    expect(on.button.title).toBe('Hide night');
    expect(on.button.classList.contains('is-on')).toBe(true);
  });

  it('reports each change once', () => {
    const changes: boolean[] = [];
    const control = createTerminatorControl((enabled) => changes.push(enabled), false);
    control.button.click();
    control.button.click();
    control.button.click();
    expect(changes).toEqual([true, false, true]);
    expect(control.button.getAttribute('aria-pressed')).toBe('true');
  });

  it('can be told about a change it did not cause', () => {
    const control = createTerminatorControl(() => {}, false);
    control.setEnabled(true);
    expect(control.button.title).toBe('Hide night');
    expect(control.button.classList.contains('is-on')).toBe(true);
  });

  it('hands MapLibre a control group it can place', () => {
    // Appended by MapLibre rather than by us: the last thing this view put in
    // the map container by hand collapsed it to zero height (D55, D62).
    const control = createTerminatorControl(() => {}, false);
    const element = control.onAdd({} as import('maplibre-gl').Map);
    expect(element.className).toContain('maplibregl-ctrl-group');
    expect(element.contains(control.button)).toBe(true);
  });
});
