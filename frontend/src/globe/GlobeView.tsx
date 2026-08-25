/**
 * The globe: mounting, camera, the animation loop, and picking.
 *
 * This component owns imperative three.js state and deliberately renders an
 * empty `<div>`. React manages the container; everything inside it is driven
 * by the animation loop reading the store directly. Routing two thousand
 * marker positions through the reconciler sixty times a second would be
 * hopeless, so React is kept out of the hot path entirely (D3).
 *
 * The layers it assembles are kept separate on purpose, so rendering cost
 * stays attributable when we profile (D16):
 *
 * - `earth.ts`   the textured, lit planet, plus atmosphere and stars
 * - `markers.ts` one THREE.Points for every tracked object
 * - `route.ts`   the observed track of the selected object
 */

import { useEffect, useRef } from 'react';
import Globe from 'globe.gl';
import * as THREE from 'three';

import { config } from '../config';
import { useOrbitalStore } from '../state/store';
import { createEarthVisuals } from './earth';
import { createMarkerLayer } from './markers';
import { createRouteLayer } from './route';
import { bboxChanged, viewportBBox } from './viewport';

/** How often to recompute the sun. The terminator moves 0.25 degrees a minute. */
const SUN_UPDATE_MS = 60_000;

/** How often to publish the camera's bounding box. */
const VIEWPORT_UPDATE_MS = 500;

export function GlobeView() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const world = new Globe(container)
      .backgroundColor('rgba(0,0,0,0)')
      // Our own fresnel shell replaces globe.gl's built-in halo, which does not
      // follow the terminator.
      .showAtmosphere(false)
      .showGraticules(false)
      .width(container.clientWidth)
      .height(container.clientHeight);

    const globeRadius = world.getGlobeRadius();

    const earth = createEarthVisuals(globeRadius);
    world.globeMaterial(earth.material);

    const scene = world.scene();
    scene.add(earth.atmosphere);
    scene.add(earth.starField);

    const markers = createMarkerLayer(globeRadius);
    const route = createRouteLayer(globeRadius);
    // Added to the scene root, not to a globe group. globe.gl orbits the camera
    // rather than rotating the planet, so everything stays in one fixed frame —
    // verified: every object in the scene has zero rotation, and our
    // latLonToVector3 matches world.getCoords() exactly.
    scene.add(markers.points);
    scene.add(route.line);

    const controls = world.controls();
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = globeRadius * 1.05;
    controls.maxDistance = globeRadius * 8;
    // Slow zoom slightly: the default overshoots badly at globe scale.
    controls.zoomSpeed = 0.6;

    world.pointOfView({ lat: 25, lng: 0, altitude: 2.2 }, 0);

    // ---- picking ---------------------------------------------------------

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownAt = { x: 0, y: 0, time: 0 };

    const onPointerDown = (event: PointerEvent) => {
      pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() };
    };

    const onPointerUp = (event: PointerEvent) => {
      // Distinguish a click from the end of a drag: rotating the globe must not
      // select whatever marker happens to be under the cursor when you let go.
      const moved =
        Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) > 5;
      if (moved) return;

      const rect = container.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, world.camera());

      const hit = markers.pick(raycaster);
      // Clicking empty space clears the selection, which is the only way to
      // dismiss the detail panel without hunting for a close button.
      useOrbitalStore.getState().select(hit);
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointerup', onPointerUp);

    // ---- resize ----------------------------------------------------------

    const resize = () => {
      world.width(container.clientWidth).height(container.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // ---- the loop --------------------------------------------------------

    let frame = 0;
    let lastSunUpdate = 0;
    let lastViewportUpdate = 0;

    const fixedSun = config.fixedSunTime ? new Date(config.fixedSunTime) : null;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const nowMs = Date.now();

      const state = useOrbitalStore.getState();

      // Markers are rebuilt from the store every frame. This is the hot path:
      // it writes into pre-allocated typed arrays and issues no allocations in
      // the steady state.
      markers.update(Array.from(state.objects.values()), nowMs, state.selectedId);

      if (now - lastSunUpdate > SUN_UPDATE_MS || lastSunUpdate === 0) {
        earth.setSunFromDate(fixedSun ?? new Date());
        lastSunUpdate = now;
      }

      if (now - lastViewportUpdate > VIEWPORT_UPDATE_MS) {
        lastViewportUpdate = now;
        const bbox = viewportBBox(world.pointOfView());
        if (bboxChanged(state.viewport, bbox)) state.setViewport(bbox);
      }
    };
    frame = requestAnimationFrame(tick);

    // ---- dev handle ------------------------------------------------------

    // Debugging a globe from the outside is miserable: the interesting state is
    // all inside a closure. This exposes it on the console in development only,
    // so `__orbital.world.pointOfView()` or `__orbital.markers.points` are one
    // line away. Stripped from production builds by the DEV guard.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__orbital = {
        world,
        earth,
        markers,
        route,
        store: useOrbitalStore,
      };
    }

    // ---- reactive bridges ------------------------------------------------

    // The route redraws only when the selected object's detail changes, not
    // every frame: rebuilding a polyline is allocation-heavy and the track only
    // changes once per poll.
    const unsubscribeRoute = useOrbitalStore.subscribe((state, previous) => {
      if (state.selectedDetail !== previous.selectedDetail) {
        route.setTrack(state.selectedDetail?.track ?? null);
      }
      if (state.flyTo !== previous.flyTo && state.flyTo) {
        world.pointOfView(
          { lat: state.flyTo.lat, lng: state.flyTo.lon, altitude: 0.6 },
          1200,
        );
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      unsubscribeRoute();
      observer.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointerup', onPointerUp);
      markers.dispose();
      route.dispose();
      earth.dispose();
      world._destructor?.();
    };
  }, []);

  return <div ref={containerRef} className="globe-view" />;
}
