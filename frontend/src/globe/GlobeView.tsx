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
 * - `earth.ts`             the textured, lit planet, plus atmosphere and stars
 * - `borders.ts`           one THREE.LineSegments for every country boundary
 * - `labels.ts`            country, city and airport names, as pooled DOM
 * - `markers.ts`           one THREE.Points for every tracked object
 * - `route.ts`             the observed track of the selected object
 * - `selectedAircraft.ts`  a 3D mesh standing in for the selected marker
 *
 * Below `CITY_ENTER_ALTITUDE` it hands the view over to `city/cityMode.ts`,
 * which is a spike rather than a layer: a second renderer with tiles and 3D
 * buildings, for the zoom range this globe cannot reach (D52).
 */

import { useEffect, useRef } from 'react';
import Globe from 'globe.gl';
import * as THREE from 'three';

import { config } from '../config';
import {
  createCityLayer,
  shouldEnterCity,
  shouldExitCity,
} from '../city/cityMode';
import { useOrbitalStore } from '../state/store';
import { createBorderLayer } from './borders';
import { createEarthVisuals } from './earth';
import { createLabelLayer } from './labels';
import { createLightingProbe } from './lightingProbe';
import { MARKER_ALTITUDE, createMarkerLayer } from './markers';
import { attachPointerSelection } from './pointer';
import { createRouteLayer } from './route';
import { createSelectedAircraftLayer } from './selectedAircraft';
import { bboxChanged, viewportBBox } from './viewport';

/** How often to recompute the sun. The terminator moves 0.25 degrees a minute. */
const SUN_UPDATE_MS = 60_000;

/** How often to publish the camera's bounding box. */
const VIEWPORT_UPDATE_MS = 500;

/**
 * Static geography, generated into public/geo/ at build time.
 *
 * Fetched once, cached by the browser like any other asset, and costing no API
 * credit. A failure here is logged and otherwise ignored: the globe without
 * borders is the globe, while a globe that refuses to start because a label
 * file is missing is a broken app (D29).
 */
async function fetchGeography<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

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

    const borders = createBorderLayer(globeRadius);
    const labels = createLabelLayer(globeRadius);
    container.appendChild(labels.element);

    // City mode: the spike that answers "what if you could keep zooming".
    // Handing back is the map's decision -- it is the thing being scrolled --
    // so it calls in with where the user ended up and the globe resumes there.
    const city = createCityLayer({
      onExit: (view) => {
        world.pointOfView({ lat: view.lat, lng: view.lon, altitude: view.altitude }, 0);
      },
    });
    container.appendChild(city.element);

    const markers = createMarkerLayer(globeRadius);
    const route = createRouteLayer(globeRadius);
    const selectedAircraft = createSelectedAircraftLayer(globeRadius);
    // Added to the scene root, not to a globe group. globe.gl orbits the camera
    // rather than rotating the planet, so everything stays in one fixed frame —
    // verified: every object in the scene has zero rotation, and our
    // latLonToVector3 matches world.getCoords() exactly.
    scene.add(borders.line);
    scene.add(markers.points);
    scene.add(route.line);
    scene.add(selectedAircraft.mesh);

    // Both files are static and are fetched once. Neither is awaited: the
    // globe is interactive immediately and the geography appears when it
    // arrives, which on a warm cache is the same frame.
    void borders
      .load(() => fetchGeography('/geo/borders.json'))
      .catch((error) => console.warn('[geography] borders unavailable', error));
    void labels
      .load(() => fetchGeography('/geo/labels.json'))
      .catch((error) => console.warn('[geography] labels unavailable', error));

    const controls = world.controls();
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // Two constraints meet here, and 1.005 satisfied only one of them.
    //
    // Lower bound: at 1.05 the closest reachable view still spans ~1260 square
    // degrees, above the threshold at which the backend spends credits on a
    // fast viewport poll, so tier 2 could never engage at any reachable zoom
    // (D36). That is why this is not a cautious number.
    //
    // Upper bound: markers and the selected model sit on a shell at
    // 1 + MARKER_ALTITUDE = 1.012 radii. At 1.005 the camera goes *inside* that
    // shell, and every marker beneath it falls behind the near plane and
    // vanishes at exactly the moment the user has zoomed all the way in (D43).
    //
    // 1.014 clears the shell while still giving a ~9.5 degree cap, about 363
    // square degrees, comfortably under the 400 tier 2 needs.
    controls.minDistance = globeRadius * (1 + MARKER_ALTITUDE) * 1.002;
    controls.maxDistance = globeRadius * 8;
    // Slow zoom slightly: the default overshoots badly at globe scale.
    controls.zoomSpeed = 0.6;

    world.pointOfView({ lat: 25, lng: 0, altitude: 2.2 }, 0);

    // ---- picking ---------------------------------------------------------

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const detachPointer = attachPointerSelection({
      element: container,
      pick: (ndc) => {
        pointer.set(ndc.x, ndc.y);
        const camera = world.camera() as THREE.PerspectiveCamera;
        raycaster.setFromCamera(pointer, camera);
        // The pick tolerance is in screen pixels, so it needs the viewport
        // height to convert into the world units the raycaster expects.
        return markers.pick(raycaster, camera, container.clientHeight);
      },
      onSelect: (id) => useOrbitalStore.getState().select(id),
    });

    // ---- resize ----------------------------------------------------------

    const resize = () => {
      world.width(container.clientWidth).height(container.clientHeight);
      // Sprite size is derived from the viewport and field of view, so the
      // marker layer has to be told when either changes -- otherwise markers
      // keep the size they had for the previous window shape.
      markers.setViewport(
        container.clientWidth,
        container.clientHeight,
        (world.camera() as THREE.PerspectiveCamera).fov,
        world.renderer().getPixelRatio(),
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // ---- the loop --------------------------------------------------------

    let frame = 0;
    let lastSunUpdate = 0;
    let lastLayerId: string | null = null;
    let lastViewportUpdate = 0;
    let lastCityVersion = -1;

    const fixedSun = config.fixedSunTime ? new Date(config.fixedSunTime) : null;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const nowMs = Date.now();

      const state = useOrbitalStore.getState();

      // The selected object gets a real mesh instead of a sprite. This runs
      // BEFORE markers.update, because it decides which sprite the marker
      // layer must leave out — and returns that id rather than the two layers
      // each deciding for themselves, which is how an object ends up drawn
      // twice or not at all.
      //
      // Null selection, an object that has left the feed, and an object with
      // no heading all come back as null, and the sprite stands as it was.
      const selected = state.selectedId
        ? state.objects.get(state.selectedId) ?? null
        : null;
      // **The 3D mesh is an airframe.** Handing it a satellite would draw an
      // airliner in orbit, complete with wings and a tailplane, which is worse
      // than drawing nothing: it is a confident claim about the shape of
      // something we have no shape for. Satellites keep the disc (D96).
      const selectedObject = selected?.type === 'satellite' ? null : selected;
      markers.setHidden(
        selectedAircraft.update(
          selectedObject,
          nowMs,
          world.camera() as THREE.PerspectiveCamera,
          container.clientHeight,
        ),
      );

      // Markers are rebuilt from the store every frame. This is the hot path:
      // it writes into pre-allocated typed arrays and issues no allocations in
      // the steady state.
      markers.update(
        Array.from(state.objects.values()),
        nowMs,
        state.selectedId,
        state.objectsVersion,
      );

      // The hand-off to city mode, and only the hand-off: once the map is up
      // it owns the interaction, and it is what decides when to give the view
      // back. Altitude here is in globe radii, the same unit the label tiers
      // and the camera limits use.
      const altitude =
        ((world.camera() as THREE.PerspectiveCamera).position.length() - globeRadius) /
        globeRadius;
      // City mode draws the same aircraft the globe does. Only while it is up,
      // and only when the store has actually changed -- rebuilding a GeoJSON
      // collection every frame would be the one expensive thing in a layer
      // that is otherwise idle.
      if (city.isActive() && state.objectsVersion !== lastCityVersion) {
        lastCityVersion = state.objectsVersion;
        city.setAircraft(
          Array.from(state.objects.values()).map((object) => ({
            id: object.id,
            lat: object.renderLat,
            lon: object.renderLon,
            heading: object.heading,
            label: object.label,
          })),
        );
      }

      if (config.cityMode && shouldEnterCity(altitude, city.isActive())) {
        const pov = world.pointOfView();
        void city.enter(
          { lat: pov.lat, lon: pov.lng, altitude },
          (world.camera() as THREE.PerspectiveCamera).fov,
        );
      } else if (shouldExitCity(altitude, city.isActive())) {
        city.exit();
      }

      // Satellite mode is a different subject, not the same globe with extra
      // dots on it. Airport codes are aircraft furniture: a globe covered in
      // runway names while the user is looking at orbits mixes two things that
      // have nothing to do with each other (D96). Countries and cities stay -
      // "what is it passing over" is the question this view is asking.
      if (state.activeLayer.id !== lastLayerId) {
        lastLayerId = state.activeLayer.id;
        labels.setSuppressedKinds(
          state.activeLayer.id === 'satellite' ? ['airport'] : [],
        );
      }

      // Labels reproject every frame so they track the globe while dragging;
      // which labels to show is recomputed far less often, inside the layer.
      labels.update(
        world.camera() as THREE.PerspectiveCamera,
        container.clientWidth,
        container.clientHeight,
        now,
      );

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
        // three.js itself, so a console session can construct a camera or a
        // render target without importing anything.
        THREE,
        earth,
        borders,
        labels,
        city,
        markers,
        route,
        selectedAircraft,
        store: useOrbitalStore,
        // Renders the real scene to an offscreen target and measures the
        // light, which is the only way to check the terminator end to end --
        // there is no GL context under vitest (D41). Built on demand so the
        // render target is not allocated in ordinary use.
        probeLighting: (when?: Date) => {
          const probe = createLightingProbe({
            renderer: world.renderer(),
            scene,
            camera: world.camera() as THREE.PerspectiveCamera,
            material: earth.material,
            globeRadius,
            // Hidden while measuring: the atmosphere alone would turn every
            // reading into a measurement of the halo instead of the planet.
            otherLayers: [
              earth.atmosphere,
              earth.starField,
              borders.line,
              markers.points,
              route.line,
              selectedAircraft.mesh,
            ],
            setSunFromDate: earth.setSunFromDate,
          });
          try {
            return probe.run(when ?? fixedSun ?? new Date());
          } finally {
            probe.dispose();
          }
        },
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
      detachPointer();
      borders.dispose();
      labels.dispose();
      city.dispose();
      markers.dispose();
      route.dispose();
      selectedAircraft.dispose();
      earth.dispose();
      world._destructor?.();
    };
  }, []);

  return <div ref={containerRef} className="globe-view" />;
}
