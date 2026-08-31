/**
 * Tests for the selected aircraft's 3D model on the planet view.
 *
 * Two things here cannot be checked by looking at the screen, and both are the
 * kind that produce a plausible picture that is wrong:
 *
 * - **The coordinate conventions.** A model placed with mercator arithmetic in
 *   the globe frame lands in the Atlantic, and one built with the wrong sphere
 *   convention lands ninety degrees away. Where MapLibre already knows the
 *   answer we ask MapLibre — `MercatorCoordinate` is imported here and used as
 *   the authority, so our arithmetic and the library cannot agree on a shared
 *   mistake (the technique D32 and the label layer already used).
 * - **Which matrix is used, and when nothing is drawn at all.** Those decide
 *   whether the model appears in the right place or hangs in space behind the
 *   planet, and the render path can be exercised without a GL context through
 *   the renderer seam.
 *
 * What is deliberately *not* asserted is what it looks like. D50 is the reason
 * that sentence is here: fifty passing tests once described an airframe whose
 * nose flared open at the tip, because every one of them asked which way it
 * pointed and none asked what it was shaped like. The shape is asserted in
 * `selectedAircraft.test.ts` against the shared geometry, and the rest is
 * Phone's eye.
 */

import { MercatorCoordinate } from 'maplibre-gl';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { RenderableObject } from '../types';
import {
  EARTH_CIRCUMFERENCE_METRES,
  GLOBE_RADIUS_METRES,
  MODEL_MIN_PX,
  REAL_SPAN_METRES,
  globeAxes,
  globeModelMatrix,
  isOnNearSide,
  mercatorModelMatrix,
  mercatorX,
  mercatorY,
  metreInMercatorUnits,
  metresPerPixel,
  modelSpanMetres,
  multiplyMat4,
  sphereVector,
  sunInModelSpace,
  usesGlobeFrame,
} from './modelFrame';
import { MODEL_LAYER, createModelLayer, modelTarget } from './modelLayer';

const BANGKOK = { lon: 100.5, lat: 13.75 };

function object(overrides: Partial<RenderableObject> = {}): RenderableObject {
  return {
    id: 'a1',
    type: 'aircraft',
    label: 'TEST123',
    lat: 13.75,
    lon: 100.5,
    renderLat: 13.8,
    renderLon: 100.6,
    altitude: 10_000,
    velocity: 220,
    heading: 90,
    lastSeenMs: Date.now(),
    meta: {},
    ...overrides,
  } as RenderableObject;
}

describe('sphereVector', () => {
  it('puts the prime meridian on +Z and 90 east on +X', () => {
    // MapLibre's convention, transcribed from globe_utils.ts. Every other
    // assertion in this file is downstream of it being right.
    const [x0, y0, z0] = sphereVector(0, 0);
    expect([x0, y0, z0].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1]);
    const [x90, y90, z90] = sphereVector(90, 0);
    expect(x90).toBeCloseTo(1, 6);
    expect(y90).toBeCloseTo(0, 6);
    expect(z90).toBeCloseTo(0, 6);
  });

  it('puts the poles on the Y axis', () => {
    expect(sphereVector(37, 90)[1]).toBeCloseTo(1, 6);
    expect(sphereVector(-118, -90)[1]).toBeCloseTo(-1, 6);
  });

  it('is always a unit vector', () => {
    for (const [lon, lat] of [
      [0, 0],
      [100.5, 13.75],
      [-73.8, 40.6],
      [179.9, -60],
    ]) {
      const v = sphereVector(lon, lat);
      expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    }
  });
});

describe('globeAxes', () => {
  it('gives an orthonormal east/north/up', () => {
    const { up, north, east } = globeAxes(BANGKOK.lon, BANGKOK.lat);
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const v of [up, north, east]) expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    expect(dot(up, north)).toBeCloseTo(0, 12);
    expect(dot(up, east)).toBeCloseTo(0, 12);
    expect(dot(north, east)).toBeCloseTo(0, 12);
  });

  it('points north at the north pole and east along the equator', () => {
    // North from anywhere is toward +Y; east at the prime meridian is +X.
    expect(globeAxes(0, 0).north[1]).toBeCloseTo(1, 12);
    expect(globeAxes(0, 0).east[0]).toBeCloseTo(1, 12);
    expect(globeAxes(90, 0).east[2]).toBeCloseTo(-1, 12);
  });
});

describe('the mercator arithmetic, against MapLibre', () => {
  // Not a restatement of the formula: MapLibre's own MercatorCoordinate is the
  // authority, and a shared misunderstanding is exactly what this rules out.
  const places = [
    [100.5, 13.75],
    [-0.1, 51.5],
    [-118.2, 34.05],
    [151.2, -33.9],
    [0, 0],
  ];

  it('agrees on x and y', () => {
    for (const [lon, lat] of places) {
      const truth = MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
      expect(mercatorX(lon)).toBeCloseTo(truth.x, 12);
      expect(mercatorY(lat)).toBeCloseTo(truth.y, 12);
    }
  });

  it('agrees on what a metre is worth', () => {
    for (const [lon, lat] of places) {
      const truth = MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
      expect(metreInMercatorUnits(lat)).toBeCloseTo(truth.meterInMercatorCoordinateUnits(), 15);
    }
  });

  it('uses the sphere MapLibre draws, not a more accurate one', () => {
    // 6371008.8 m is what the globe shader draws; the WGS84 equatorial radius
    // would be 6378137, and being right about the wrong planet is still wrong.
    expect(GLOBE_RADIUS_METRES).toBe(6371008.8);
    expect(EARTH_CIRCUMFERENCE_METRES).toBeCloseTo(40030228.88, 2);
  });
});

describe('globeModelMatrix', () => {
  const column = (m: number[], i: number) => m.slice(i * 4, i * 4 + 3);
  const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  it('sits on the sphere at the aircraft, lifted by the lift', () => {
    const m = globeModelMatrix(BANGKOK.lon, BANGKOK.lat, 0, 50, 30);
    const origin = column(m, 3);
    expect(norm(origin)).toBeCloseTo(1 + 30 / GLOBE_RADIUS_METRES, 12);
    const surface = sphereVector(BANGKOK.lon, BANGKOK.lat);
    // Same direction from the centre: lifted, not moved.
    expect(dot(origin, surface) / norm(origin)).toBeCloseTo(1, 12);
  });

  it('scales one model unit to the span, in sphere units', () => {
    const m = globeModelMatrix(BANGKOK.lon, BANGKOK.lat, 45, 8000, 0);
    for (const i of [0, 1, 2]) {
      expect(norm(column(m, i))).toBeCloseTo(8000 / GLOBE_RADIUS_METRES, 15);
    }
  });

  it('points the nose along the heading', () => {
    const { north, east } = globeAxes(BANGKOK.lon, BANGKOK.lat);
    const forward = (heading: number) => {
      const f = column(globeModelMatrix(BANGKOK.lon, BANGKOK.lat, heading, 1, 0), 2);
      const length = norm(f);
      return [f[0] / length, f[1] / length, f[2] / length];
    };
    expect(dot(forward(0), north)).toBeCloseTo(1, 9);
    expect(dot(forward(90), east)).toBeCloseTo(1, 9);
    expect(dot(forward(180), north)).toBeCloseTo(-1, 9);
    expect(dot(forward(270), east)).toBeCloseTo(-1, 9);
  });

  it('is a rotation, not a reflection', () => {
    // A negative determinant would flip every triangle's winding and invert
    // every normal: the model would be lit from the inside out and culled the
    // wrong way round. Cheap to assert, invisible until it is not.
    const m = globeModelMatrix(-73.8, 40.6, 210, 1, 0);
    const [a, b, c] = [column(m, 0), column(m, 1), column(m, 2)];
    const determinant =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    expect(determinant).toBeGreaterThan(0);
  });
});

describe('mercatorModelMatrix', () => {
  const column = (m: number[], i: number) => m.slice(i * 4, i * 4 + 3);
  const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);

  it('sits at the aircraft, in mercator units', () => {
    const m = mercatorModelMatrix(BANGKOK.lon, BANGKOK.lat, 0, 50, 0);
    const truth = MercatorCoordinate.fromLngLat({ lng: BANGKOK.lon, lat: BANGKOK.lat }, 0);
    expect(m[12]).toBeCloseTo(truth.x, 12);
    expect(m[13]).toBeCloseTo(truth.y, 12);
    expect(m[14]).toBeCloseTo(0, 12);
  });

  it('lifts along +Z, which is up in mercator', () => {
    const m = mercatorModelMatrix(BANGKOK.lon, BANGKOK.lat, 0, 50, 300);
    expect(m[14]).toBeCloseTo(300 * metreInMercatorUnits(BANGKOK.lat), 15);
  });

  it('points north along -Y, because mercator Y grows southward', () => {
    // Getting this backwards is a whole hemisphere of wrong that still looks
    // like an aeroplane.
    const forward = column(mercatorModelMatrix(BANGKOK.lon, BANGKOK.lat, 0, 1, 0), 2);
    expect(forward[1] / norm(forward)).toBeCloseTo(-1, 9);
    const east = column(mercatorModelMatrix(BANGKOK.lon, BANGKOK.lat, 90, 1, 0), 2);
    expect(east[0] / norm(east)).toBeCloseTo(1, 9);
  });

  it('is a rotation there too', () => {
    const m = mercatorModelMatrix(BANGKOK.lon, BANGKOK.lat, 33, 1, 0);
    const [a, b, c] = [column(m, 0), column(m, 1), column(m, 2)];
    const determinant =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    expect(determinant).toBeGreaterThan(0);
  });
});

describe('multiplyMat4', () => {
  it('matches three.js, which does the same multiplication', () => {
    const a = globeModelMatrix(10, 20, 30, 100, 5);
    const b = globeModelMatrix(-40, 55, 200, 3, 1);
    const expected = new THREE.Matrix4()
      .fromArray(a)
      .multiply(new THREE.Matrix4().fromArray(b))
      .toArray();
    const actual = multiplyMat4(a, b);
    for (let i = 0; i < 16; i += 1) expect(actual[i]).toBeCloseTo(expected[i], 9);
  });

  it('is the reason the model matrix is not sent to the GPU on its own', () => {
    // Measured rather than asserted from theory. In globe space the aircraft
    // sits at magnitude 1 from the planet's centre and its wingtip is 3.9e-6
    // away from that: one float32 step at that magnitude is 0.36 m, so a
    // vertex buffer transformed by a float32 model matrix lands on a lattice
    // about a hundred and forty times coarser than the aircraft is long, and
    // the airframe crawls between lattice points as it moves. Composing in
    // double precision and uploading the single product puts the small
    // quantity into clip space, where it is no longer small against its
    // neighbour.
    const model = globeModelMatrix(BANGKOK.lon, BANGKOK.lat, 90, REAL_SPAN_METRES, 0);
    const centre = [model[12], model[13], model[14]];
    const wingtip = centre.map((v, i) => v + model[i] * 0.5);
    const metres = (a: number[], b: number[]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * GLOBE_RADIUS_METRES;

    // The wingtip really is half a wingspan out, in doubles.
    expect(metres(wingtip, centre)).toBeCloseTo(REAL_SPAN_METRES / 2, 6);

    // Rounded to float32, it moves by tens of centimetres - on an airframe
    // whose engines are two metres across.
    const rounded = metres(wingtip.map(Math.fround), centre.map(Math.fround));
    expect(Math.abs(rounded - REAL_SPAN_METRES / 2)).toBeGreaterThan(0.05);
  });
});

describe('isOnNearSide', () => {
  it('keeps the near side and drops the far side', () => {
    // A plane through the centre, facing +Z: the prime meridian on the equator
    // is in front of it and the antimeridian is behind.
    const plane = [0, 0, 1, 0];
    expect(isOnNearSide(sphereVector(0, 0), plane)).toBe(true);
    expect(isOnNearSide(sphereVector(180, 0), plane)).toBe(false);
  });

  it('reads the plane offset, not just its direction', () => {
    // MapLibre pushes the plane out toward the viewer as the camera closes in,
    // which is what hides geometry just over the horizon rather than exactly
    // at ninety degrees.
    expect(isOnNearSide(sphereVector(0, 0), [0, 0, 1, -0.5])).toBe(true);
    // 60 degrees is exactly on the plane; 61 is the first degree behind it.
    expect(isOnNearSide(sphereVector(61, 0), [0, 0, 1, -0.5])).toBe(false);
  });
});

describe('sizing', () => {
  it('matches the standard web mercator scale at the equator', () => {
    // 156543 m/px at z0 is the number every tiling scheme quotes; MapLibre's
    // slightly smaller sphere makes it 156368, which is the one that matters
    // here because it is the sphere being drawn.
    expect(metresPerPixel(0, 0)).toBeCloseTo(EARTH_CIRCUMFERENCE_METRES / 512, 6);
    expect(metresPerPixel(10, 0)).toBeCloseTo(metresPerPixel(0, 0) / 1024, 9);
  });

  it('shrinks with latitude, as mercator does', () => {
    expect(metresPerPixel(10, 60)).toBeCloseTo(metresPerPixel(10, 0) * Math.cos(Math.PI / 3), 6);
  });

  it('holds the model at a readable size when it would be sub-pixel', () => {
    // At z9 a real 50 m aircraft is under a pixel across. Without the floor
    // the selected aircraft would be invisible at every zoom traffic is
    // actually watched from, which is most of them.
    expect(REAL_SPAN_METRES / metresPerPixel(9, 13.75)).toBeLessThan(1);
    const span = modelSpanMetres(9, 13.75);
    expect(span / metresPerPixel(9, 13.75)).toBeCloseTo(MODEL_MIN_PX, 6);
  });

  it('becomes the true size of the aircraft once close enough', () => {
    // Around z16 the floor stops binding and the model is 50 m because the
    // aircraft is 50 m.
    expect(modelSpanMetres(18, 13.75)).toBe(REAL_SPAN_METRES);
    expect(modelSpanMetres(2, 13.75)).toBeGreaterThan(REAL_SPAN_METRES);
  });
});

describe('sunInModelSpace', () => {
  it('is a unit vector with the light above', () => {
    for (const heading of [0, 45, 90, 180, 275]) {
      for (const mirrored of [false, true]) {
        const sun = sunInModelSpace(heading, mirrored);
        expect(Math.hypot(...sun)).toBeCloseTo(1, 12);
        expect(sun[1]).toBeGreaterThan(0.5);
      }
    }
  });

  it('lights the same side of the aircraft in both frames', () => {
    // The mercator frame is mirrored relative to the globe frame, so the sign
    // has to flip with it. Without this the aircraft would appear to be lit
    // from the other side the moment the map crossed the transition zoom.
    for (const heading of [0, 37, 210]) {
      const globe = sunInModelSpace(heading, false);
      const mercator = sunInModelSpace(heading, true);
      expect(mercator[0]).toBeCloseTo(-globe[0], 12);
      expect(mercator[1]).toBeCloseTo(globe[1], 12);
      expect(mercator[2]).toBeCloseTo(globe[2], 12);
    }
  });
});

describe('usesGlobeFrame', () => {
  it('picks one frame or the other, never neither', () => {
    expect(usesGlobeFrame(1)).toBe(true);
    expect(usesGlobeFrame(0)).toBe(false);
    expect(usesGlobeFrame(0.51)).toBe(true);
    expect(usesGlobeFrame(0.49)).toBe(false);
  });
});

describe('modelTarget', () => {
  it('refuses an aircraft with no heading', () => {
    // The same rule as the sprite atlas and the globe's model (D18, D40, D42):
    // a mesh commits to a direction and there is none to commit to.
    expect(modelTarget(object({ heading: null }))).toBeNull();
    expect(modelTarget(null)).toBeNull();
    expect(modelTarget(undefined)).toBeNull();
  });

  it('takes the interpolated position, not the reported one', () => {
    // The symbol layer draws renderLat/renderLon; taking lat/lon here would
    // leave the model a poll behind the marker it is replacing.
    const target = modelTarget(object());
    expect(target).toEqual({ lon: 100.6, lat: 13.8, heading: 90, altitude: 10_000 });
  });
});

describe('the layer', () => {
  function harness(target: ReturnType<typeof modelTarget>, zoom = 3, centreLat = 0) {
    const renderer = { autoClear: true, resetState: vi.fn(), render: vi.fn() };
    const layer = createModelLayer(
      () => target,
      () => renderer,
    );
    const map = {
      getCanvas: () => document.createElement('canvas'),
      getZoom: () => zoom,
      getCenter: () => ({ lat: centreLat, lng: 0 }),
    } as unknown as import('maplibre-gl').Map;
    layer.onAdd?.(map, {} as WebGL2RenderingContext);
    return { layer, renderer };
  }

  function args(overrides: Record<string, unknown> = {}) {
    return {
      defaultProjectionData: {
        mainMatrix: new THREE.Matrix4().makeScale(2, 2, 2).toArray(),
        fallbackMatrix: new THREE.Matrix4().makeScale(3, 3, 3).toArray(),
        clippingPlane: [0, 0, 1, 0],
        projectionTransition: 1,
        tileMercatorCoords: [0, 0, 1, 1],
        clipAntimeridian: false,
        ...overrides,
      },
    } as unknown as import('maplibre-gl').CustomRenderMethodInput;
  }

  it('announces itself as a 3D custom layer', () => {
    // '2d' would mean no depth buffer, and the model would be painted over the
    // buildings it is flying above instead of behind them.
    const { layer } = harness(null);
    expect(layer.id).toBe(MODEL_LAYER);
    expect(layer.type).toBe('custom');
    expect(layer.renderingMode).toBe('3d');
  });

  it('draws nothing when nothing is selected', () => {
    const { layer, renderer } = harness(null);
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.render).not.toHaveBeenCalled();
    expect(layer.drewLastFrame()).toBe(false);
  });

  it('draws the selection through the globe matrix', () => {
    const target = { lon: 0, lat: 0, heading: 90, altitude: 3000, model: null };
    const { layer, renderer } = harness(target);
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(layer.drewLastFrame()).toBe(true);

    // The composed matrix must be main x model, in that order. Building it the
    // other way round is a mistake that still draws something.
    const span = modelSpanMetres(3, 0);
    const expected = multiplyMat4(
      new THREE.Matrix4().makeScale(2, 2, 2).toArray(),
      globeModelMatrix(0, 0, 90, span, span * 0.6),
    );
    const actual = layer.camera.projectionMatrix.toArray();
    for (let i = 0; i < 16; i += 1) expect(actual[i]).toBeCloseTo(expected[i], 12);
  });

  it('switches to the fallback matrix once the map is mercator', () => {
    const target = { lon: 0, lat: 0, heading: 0, altitude: null, model: null };
    const { layer, renderer } = harness(target, 14);
    layer.render({} as WebGL2RenderingContext, args({ projectionTransition: 0 }));
    expect(renderer.render).toHaveBeenCalledTimes(1);

    const span = modelSpanMetres(14, 0);
    const expected = multiplyMat4(
      new THREE.Matrix4().makeScale(3, 3, 3).toArray(),
      mercatorModelMatrix(0, 0, 0, span, span * 0.6),
    );
    const actual = layer.camera.projectionMatrix.toArray();
    for (let i = 0; i < 16; i += 1) expect(actual[i]).toBeCloseTo(expected[i], 12);
  });

  it('draws nothing for an aircraft over the horizon', () => {
    // On the far side of the planet MapLibre draws no terrain to hide it, so
    // an unclipped model would be visible *through* the Earth.
    const { layer, renderer } = harness({ lon: 180, lat: 0, heading: 0, altitude: null, model: null });
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.render).not.toHaveBeenCalled();
    expect(layer.drewLastFrame()).toBe(false);
  });

  it('does not clip against the horizon under mercator', () => {
    // The clipping plane is globe-only; applying it in mercator would blank
    // the model for half the world.
    const { layer, renderer } = harness({ lon: 180, lat: 0, heading: 0, altitude: null, model: null }, 14);
    layer.render({} as WebGL2RenderingContext, args({ projectionTransition: 0 }));
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('says why it drew nothing, in four distinguishable ways', () => {
    // The whole value of the line is that these do not collapse into one
    // "not drawn": each has a different fix, and this view is debugged by
    // reading a screenshot of the panel (D57).
    const idle = harness(null).layer;
    idle.render({} as WebGL2RenderingContext, args());
    expect(idle.describe()).toMatch(/nothing selected/);

    const horizon = harness({ lon: 180, lat: 0, heading: 0, altitude: null, model: null }).layer;
    horizon.render({} as WebGL2RenderingContext, args());
    expect(horizon.describe()).toMatch(/over the horizon/);

    const drawing = harness({ lon: 0, lat: 0, heading: 0, altitude: null, model: null }).layer;
    drawing.render({} as WebGL2RenderingContext, args());
    expect(drawing.describe()).toMatch(/drawing .* globe frame/);
    drawing.render({} as WebGL2RenderingContext, args({ projectionTransition: 0 }));
    expect(drawing.describe()).toMatch(/drawing .* mercator frame/);

    const unadded = createModelLayer(() => null);
    expect(unadded.describe()).toBe('never rendered');
  });

  it('leaves three.js clearing to MapLibre', () => {
    // Autoclearing would wipe the map that has already been drawn into this
    // very framebuffer.
    const { renderer } = harness(null);
    expect(renderer.autoClear).toBe(false);
  });

  it('resets the GL state before drawing, every frame', () => {
    // MapLibre and three.js both cache what they think the context is set to,
    // and only one of them can be right.
    const { layer, renderer } = harness({ lon: 0, lat: 0, heading: 0, altitude: null, model: null });
    layer.render({} as WebGL2RenderingContext, args());
    layer.render({} as WebGL2RenderingContext, args());
    expect(renderer.resetState).toHaveBeenCalledTimes(2);
  });
});

describe('the model is the size the aircraft is', () => {
  // The map symbols learned to differ by airframe and the 3D model did not, so
  // selecting a Cessna and selecting an A380 drew the same aeroplane. The
  // model's span was one generic 50 m for every aircraft in the sky.

  const Z = 8;
  const LAT = 40;

  it('draws a widebody larger than a narrowbody', () => {
    const a350 = modelSpanMetres(Z, LAT, 64.8, 1.345);
    const a320 = modelSpanMetres(Z, LAT, 35.8, 1);
    expect(a350).toBeGreaterThan(a320);
  });

  it('draws a light aircraft smaller than an airliner', () => {
    expect(modelSpanMetres(Z, LAT, 11, 0.7)).toBeLessThan(modelSpanMetres(Z, LAT, 35.8, 1));
  });

  it('still differs by type below z16, where the pixel floor rules', () => {
    // The floor is what is actually in force at every zoom traffic is watched
    // from. Left flat, every selected aircraft would be identical there and
    // the whole change would be invisible in practice.
    const zoomedOut = 5;
    const big = modelSpanMetres(zoomedOut, LAT, 79.8, 1.45);
    const small = modelSpanMetres(zoomedOut, LAT, 11, 0.7);
    expect(big).toBeGreaterThan(small);
  });

  it('falls back to a generic airliner when the type is unknown', () => {
    // A quarter of a live map has no type. Drawing it at the sprite reference
    // of 35.8 would imply we measured it and found it small.
    expect(modelSpanMetres(Z, LAT)).toBe(modelSpanMetres(Z, LAT, REAL_SPAN_METRES, 1));
  });

  it('never lets the model shrink below the readable floor', () => {
    // True scale at low zoom is half a pixel; the floor is why the selected
    // aircraft does not vanish.
    const farOut = modelSpanMetres(3, LAT, 11, 0.7);
    expect(farOut).toBeGreaterThan(11);
  });

  it('is true to scale once zoom overtakes the floor', () => {
    // From about z16 in, the model is the aircraft's actual wingspan.
    expect(modelSpanMetres(18, LAT, 64.8, 1.345)).toBe(64.8);
    expect(modelSpanMetres(18, LAT, 11, 0.7)).toBe(11);
  });
});
