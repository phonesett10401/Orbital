/**
 * The solar system as a page of its own (D163).
 *
 * Its own canvas, its own renderer, its own camera. Everything that made the
 * old handover hard came from sharing MapLibre's - the far plane, the culling,
 * the dead band between two views, the drag that was really a turn - and none
 * of it survives the separation. See `solarScene.ts` for the list.
 *
 * ## What the pointer does here
 *
 * - **Drag** turns the system around the Sun, which stays where it is.
 * - **Wheel**, or **two fingers**, moves in and out by a proportion of the
 *   remaining distance.
 * - **Right-drag** slides the scene, one world-unit per pixel - the thing that
 *   could not be done at any damping while the map owned the camera (D160).
 *
 * Drag and right-drag were the other way round until D183. Panning is the more
 * capable gesture and it was on the button everyone has, which meant the
 * ordinary way to explore the system was to push it off the screen - and on a
 * touch screen, where there is no second button, it was the *only* thing a
 * finger could do. Turning is what the scene is for: it is a set of rings seen
 * from an angle, and the reward for moving is seeing them from another one.
 *
 * ## It renders only while it is open
 *
 * The scene is built on mount and disposed on unmount, so the second WebGL
 * context exists only while this page does. That is the whole answer to D125's
 * objection: it rejected a second renderer for drawing the system *inside* the
 * globe view, where both would run at once.
 */

import { useEffect, useRef, useState } from 'react';

import { bodyFor, isLandable } from '../bodies';
import { stackLabels } from '../labelStack';
import type { PlanetId } from '../planets';
import { createSolarScene, type SolarScene } from '../planet/solarScene';
import type { BodyMarker } from '../planet/solarBodies';
import {
  initialCamera,
  orbit,
  pan,
  pinchFactor,
  zoom,
  type SolarCamera,
} from '../solarCamera';
import { useOrbitalStore } from '../state/store';
import { formatInstant } from '../timeTravel';
import { heliocentricDistance } from '../planets';
import {
  FOCUS_ORDER,
  captionForId,
  driftFrom,
  easeDrift,
  easeTarget,
  isCentred,
  nearestMarker,
  stepFocus,
  subjectOf,
  withDrift,
} from '../solarFocus';
import { prefersReducedMotion } from '../motion';
import type { BodyId } from '../bodies';

/** One wheel notch, as a proportion of the remaining distance. */
const WHEEL_STEP = 0.12;

/**
 * How far the pointer may travel and still count as a click (D171).
 *
 * The canvas is both the thing you drag and the thing you click, so the two
 * have to be told apart after the fact. Four pixels is about the wobble in a
 * deliberate click and well under the shortest useful drag.
 */
const CLICK_SLOP_PX = 4;

/** How much of the remaining offset the camera closes each frame when centring. */
const CENTRE_EASE = 0.14;

/**
 * How far the view leans with the pointer, in radians (D172).
 *
 * About three degrees across the yaw and one and a half across the pitch. Deliberately
 * under the threshold at which it reads as a control: the system should feel
 * like it is standing in a room you are moving your head in, not like
 * something being dragged. Above about four degrees it stops being ambient and
 * starts being a very sloppy drag.
 */
const DRIFT_YAW = 0.055;
const DRIFT_PITCH = 0.026;

/**
 * How far a pixel of drag turns the system.
 *
 * A full sweep of a 375-pixel phone comes to about 107 degrees, so the system
 * can be brought most of the way round in one gesture and all the way round in
 * two - without a careless flick spinning it past the point of knowing which
 * way you are looking.
 */
const ORBIT_RADIANS_PER_PIXEL = 0.005;

/** How much of the way toward the pointer's drift each frame closes. */
const DRIFT_EASE = 0.055;

/**
 * Near enough to centred to stop, in world units.
 *
 * The scene spans about sixty units across Neptune's orbit, so a thousandth of
 * that is well under a pixel at any zoom this page reaches.
 */
const CENTRE_DONE = 0.02;

/** Characters in "you are here", the second line the current body carries. */
const HERE_CHARS = 12;

/*
 * The subject line used to be a constant here and it was **wrong half the
 * time** - see `subjectOf` in `solarFocus.ts`. The Moon is drawn as Earth's
 * companion, so it is absent whenever the camera is anywhere but home, and a
 * fixed sentence announced it regardless (D171).
 */

export function SolarSystemPage() {
  const open = useOrbitalStore((s) => s.openPage) === 'system';
  /*
   * Held back until the journey screen lifts (D174).
   *
   * The page mounts and renders *underneath* the screen so that it is ready the
   * moment the screen goes - but a half-built scene appearing through it would
   * be exactly the seam the screen exists to cover, and Phone asked for Earth
   * to fade rather than for the system to arrive early.
   */
  const arriving = useOrbitalStore((s) => s.journey) === 'system';
  const setPage = useOrbitalStore((s) => s.setOpenPage);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const viewInstant = useOrbitalStore((s) => s.viewInstant);
  const setFlyingTo = useOrbitalStore((s) => s.setFlyingTo);
  const flyingTo = useOrbitalStore((s) => s.flyingTo);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const dragState = useRef({ x: 0, y: 0, startX: 0, startY: 0, button: 0, active: false });

  /**
   * Every pointer currently down, and the finger gap a pinch started from.
   *
   * Touch has no wheel and no second button, so without this the only thing a
   * phone could do to this scene was turn it - and a system eighteen globe
   * radii across is not much use at one fixed distance (D183).
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchGap = useRef(0);
  const scene = useRef<SolarScene | null>(null);
  const camera = useRef<SolarCamera>(initialCamera());
  const [markers, setMarkers] = useState<BodyMarker[]>([]);
  /** Which body the page is about right now, or null for the whole system. */
  const [focused, setFocused] = useState<BodyId | null>(null);
  /** Which one the pointer is over, so it can answer before it is clicked. */
  const [hovered, setHovered] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  /**
   * A body the camera is still travelling to.
   *
   * A ref rather than state: the draw loop closes the remaining offset a little
   * each frame, and routing that through React would re-render the page sixty
   * times to move a camera that is not React's.
   */
  const centreOn = useRef<BodyId | null>(null);
  /** Whether this mount has told the store it has drawn a frame. */
  const announced = useRef(false);
  /** Where the pointer wants the view to lean, and where it currently leans. */
  const driftTo = useRef({ x: 0, y: 0 });
  const drift = useRef({ x: 0, y: 0 });
  /**
   * Whether the camera has been put on the Sun yet.
   *
   * The scene is built around the world you are standing on, so it opens with
   * *Earth* in the middle and the Sun off to one side. The Sun is the thing
   * everything here goes round, so that is where the view starts and where it
   * returns when nothing is chosen (D172).
   */
  const homed = useRef(false);
  /**
   * Every body **in the system**, which is not the same as every body on screen.
   *
   * `markers` is filtered to the viewport, and using it here made the arrow
   * keys skip everything the reader had zoomed away from - and the masthead
   * announce "the sun and one planet" while looking closely at Mercury (D173).
   * The scene answers the other question separately.
   *
   * State as well as a ref: state so the caption re-renders when the set
   * changes, ref so the key handler can read it without re-binding on every
   * frame.
   */
  const [present, setPresent] = useState<string[]>([]);
  const presentRef = useRef<string[]>([]);

  // The Moon rides with the Earth and has no elements of its own, so anything
  // asking `planets.ts` a question must ask it about Earth instead (D140).
  const origin: PlanetId = (activeBody === 'moon' ? 'earth' : activeBody) as PlanetId;

  useEffect(() => {
    if (!open || !canvas.current) return undefined;
    const element = canvas.current;
    const built = createSolarScene(element);
    scene.current = built;
    camera.current = initialCamera();
    announced.current = false;
    homed.current = false;
    drift.current = { x: 0, y: 0 };
    driftTo.current = { x: 0, y: 0 };

    let frame = 0;
    let shown: BodyMarker[] = [];
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const width = element.clientWidth;
      const height = element.clientHeight;
      built.resize(width, height, window.devicePixelRatio || 1);
      // The Sun is the base. The scene places bodies around whichever world
      // you are standing on, so without this the page opens looking at Earth
      // with the Sun off to the side (D172). Snapped rather than eased: an
      // opening animation from a framing nobody asked for is not an entrance.
      if (!homed.current) {
        const sun = built.positionOf('sun');
        if (sun) {
          camera.current = { ...camera.current, target: sun };
          homed.current = true;
        }
      }

      drift.current = easeDrift(
        drift.current,
        // Reduced motion means no ambient movement at all - the drift is
        // decoration, and it is the kind that moves the whole screen.
        prefersReducedMotion() ? { x: 0, y: 0 } : driftTo.current,
        DRIFT_EASE,
      );

      built.render(
        // The reader's camera, leaned by the pointer. `withDrift` returns a
        // copy on purpose: folded into `camera.current` the lean would
        // accumulate, and flying to a body would fly to wherever the mouse had
        // quietly pushed it.
        withDrift(camera.current, drift.current, DRIFT_YAW, DRIFT_PITCH),
        viewInstant ? new Date(viewInstant) : new Date(),
        origin,
        activeBody,
      );
      // Fly to the chosen body by moving the camera's target toward it in
      // world space, a fraction each frame (D171). Screen-space correction was
      // tried first and flies off - see `easeTarget`.
      if (centreOn.current) {
        const goal = built.positionOf(centreOn.current);
        if (!goal) {
          centreOn.current = null;
        } else if (isCentred(camera.current.target, goal, CENTRE_DONE)) {
          camera.current = { ...camera.current, target: goal };
          centreOn.current = null;
        } else {
          camera.current = {
            ...camera.current,
            target: easeTarget(camera.current.target, goal, CENTRE_EASE),
          };
        }
      }

      // Cheap, and it changes only when the body underfoot does - the Moon
      // comes and goes with Earth, nothing else moves in or out of the system.
      const placed = built.placedIds();
      if (placed.join() !== presentRef.current.join()) {
        presentRef.current = placed;
        setPresent(placed);
      }

      // **The page says when it can be looked at** (D174). The journey screen
      // waits on this rather than on a clock, so the words stay up for as long
      // as the scene actually takes to build - which is a different number on
      // every machine, and was the whole of the flash Phone reported.
      //
      // After the first render rather than on mount: a mounted canvas that has
      // not drawn is not something to reveal.
      if (!announced.current) {
        announced.current = true;
        useOrbitalStore.getState().setSystemReady(true);
      }

      const next = built.markers();
      // Committed only when something moved a whole pixel, so the camera moving
      // continuously does not mean React re-rendering continuously (D159).
      const moved =
        next.length !== shown.length ||
        next.some((m, i) => Math.abs(m.x - shown[i].x) >= 1 || Math.abs(m.y - shown[i].y) >= 1);
      if (moved) {
        shown = next;
        setMarkers(next);
      }
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      built.dispose();
      scene.current = null;
    };
  }, [open, origin, activeBody, viewInstant]);

  // Escape returns to the world underfoot, the same obligation every
  // full-screen view here has (D153).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPage(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setPage]);

  // Left and right step between bodies, which is the keyboard half of the two
  // arrows in the corner. Bound once per chosen body rather than per frame -
  // see `drawnIds` (D171).
  useEffect(() => {
    if (!open) return undefined;
    const onArrow = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = stepFocus(focused, event.key === 'ArrowRight' ? 1 : -1, presentRef.current);
      if (!next) return;
      event.preventDefault();
      setFocused(next);
      centreOn.current = next;
    };
    document.addEventListener('keydown', onArrow);
    return () => document.removeEventListener('keydown', onArrow);
  }, [open, focused]);

  if (!open) return null;

  // **A ref, not a local.** Declared in the render body it is rebuilt on every
  // render, and this component re-renders whenever a body moves a pixel - so a
  // drag would lose its own starting point somewhere between pointerdown and
  // the next pointermove, and the scene would jump or stop following.
  const drag = dragState.current;

  /**
   * The distance between the two fingers down, or 0 when there are not two.
   *
   * **The last two, not the first two.** A pointer is removed when its `up` or
   * `cancel` arrives, and one that never arrives - a lost capture, a gesture
   * interrupted by the system - would otherwise sit at the front of the map
   * forever, holding a gap that never changes and a zoom that never moves.
   * Reading from the end means the pair being measured is always the pair that
   * arrived most recently.
   */
  const fingerGap = () => {
    const all = [...pointers.current.values()];
    const [a, b] = all.slice(-2);
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // `>= 2` rather than `=== 2`: a third finger, or a stale one left behind by
    // a cancelled gesture, should still leave a pinch working.
    if (pointers.current.size >= 2) {
      // A second finger ends the drag rather than fighting it: the first finger
      // is still moving, and a pinch read as a turn spins the scene while the
      // reader is only trying to zoom.
      drag.active = false;
      pinchGap.current = fingerGap();
      return;
    }

    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.button = event.button;
    drag.active = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Pointer position in canvas pixels, which is what the markers are in. */
  const atCanvas = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // A pinch outranks everything: no hover, no drag, no drift. Two fingers on
    // the glass is never a request to look at what is under one of them.
    if (pointers.current.size >= 2) {
      const gap = fingerGap();
      if (gap > 0 && pinchGap.current > 0) {
        camera.current = zoom(camera.current, pinchFactor(pinchGap.current, gap));
      }
      pinchGap.current = gap;
      return;
    }

    const box = event.currentTarget.getBoundingClientRect();
    driftTo.current = driftFrom(
      event.clientX - box.left,
      event.clientY - box.top,
      box.width,
      box.height,
    );

    if (!drag.active) {
      // Not dragging, so this is the pointer looking around. Answering before
      // the click is most of what makes the scene feel alive rather than
      // diagrammatic.
      const point = atCanvas(event);
      const under = nearestMarker(markers, point.x, point.y);
      if (under !== hovered) setHovered(under);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const height = event.currentTarget.clientHeight;
    camera.current =
      drag.button === 2
        ? pan(camera.current, dx, dy, height)
        : orbit(camera.current, -dx * ORBIT_RADIANS_PER_PIXEL, -dy * ORBIT_RADIANS_PER_PIXEL);
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const wasPinching = pointers.current.size >= 2;
    pointers.current.delete(event.pointerId);
    // Lifting one finger of a pinch leaves the other one down. Starting a fresh
    // gap here would make the next move a wild zoom; it is measured again when
    // a second finger arrives.
    pinchGap.current = 0;

    const wasActive = drag.active;
    drag.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // A press that went nowhere is a click. The canvas is both the thing you
    // drag and the thing you click, so the two are told apart afterwards.
    // A pinch is not a click, however little either finger travelled - and the
    // one that lifts first has usually barely moved at all.
    if (wasPinching || !wasActive || drag.button !== 0) return;
    const travelled = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (travelled > CLICK_SLOP_PX) return;

    const point = atCanvas(event);
    const hit = nearestMarker(markers, point.x, point.y) as BodyId | null;
    // Empty sky deselects. A page you can enter and not leave is a trap, and
    // the reader's instinct for "never mind" is to click away from the thing.
    choose(hit);
  };

  /**
   * Choose a body, or nothing, and send the camera after it.
   *
   * Choosing nothing goes back to the Sun rather than staying wherever the last
   * body left the view. It is the one fixed thing on this page - everything
   * else is in orbit around it - so it is what "no particular body" looks like.
   */
  const choose = (id: BodyId | null) => {
    setFocused(id);
    centreOn.current = id ?? 'sun';
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const step = event.deltaY > 0 ? 1 + WHEEL_STEP : 1 - WHEEL_STEP;
    camera.current = zoom(camera.current, step);
  };



  /*
   * The chosen body's distance from the Sun, when there is one to give.
   *
   * Not for the Sun, which is not at a distance from itself, and not for the
   * Moon, whose heliocentric distance is Earth's - reporting either would be
   * filling the caption rather than saying something (D171).
   */
  const focusDistance =
    focused && focused !== 'sun' && focused !== 'moon'
      ? heliocentricDistance(focused as PlanetId, viewInstant ? new Date(viewInstant) : new Date())
      : null;
  const caption = captionForId(focused, focusDistance);
  const focusBody = focused ? bodyFor(focused) : null;

  const step = (direction: 1 | -1) => {
    const next = stepFocus(focused, direction, presentRef.current);
    if (!next) return;
    setFocused(next);
    centreOn.current = next;
  };

  const indexBodies = FOCUS_ORDER.filter((id) => present.includes(id));

  // Names go where they will not land on each other (D160).
  const ordered = [...markers].sort((a, b) => {
    if (a.id === activeBody) return -1;
    if (b.id === activeBody) return 1;
    return b.sizePx - a.sizePx;
  });
  const clearanceOf = (m: BodyMarker) => Math.max(14, m.sizePx / 2 + 12);
  const stacked = new Map(
    stackLabels(
      ordered.map((m) => ({
        id: m.id,
        x: m.x,
        y: m.y + clearanceOf(m),
        width:
          Math.max(
            bodyFor(m.id as Parameters<typeof bodyFor>[0])?.name.length ?? 6,
            m.id === activeBody ? HERE_CHARS : 0,
          ) *
            7 +
          8,
        height: m.id === activeBody ? 34 : 13,
      })),
    ).map((l) => [l.id, l.y] as const),
  );

  return (
    <div
      className={`system ${arriving ? 'is-arriving' : ''}`}
      role="region"
      aria-label="The solar system"
    >
      <canvas
        ref={canvas}
        className="system__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onPointerLeave={() => {
          driftTo.current = { x: 0, y: 0 };
          setHovered(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/*
        Atmosphere and grain, in that order, between the scene and everything
        written over it (D171). Both are `pointer-events: none` and neither
        draws an object: the haze lifts the black ground toward the blue it
        reads as, and the grain takes the flatness off a field of pure
        gradients. Nothing here adds a point of light, which on this page would
        be indistinguishable from a star.
      */}
      <div className="system__depth" aria-hidden="true" />
      <div className="system__grain" aria-hidden="true" />

      <header className="system__masthead">
        <h1 className="system__title">The solar system</h1>
        <p className="system__standfirst">
          {/*
            Two lines, broken deliberately rather than left to wrap. They are
            two different facts - what is drawn, and for when - and a wrap puts
            the break wherever the width happens to fall, which last time left
            the word "now" alone on a line of its own.
          */}
          <span>{subjectOf(present)}</span>
          <span>{viewInstant === null ? 'Computed for now' : formatInstant(viewInstant)}</span>
        </p>
      </header>

      <div className="solarlabels" aria-hidden="false">
        {markers.map((marker) => {
          const body = bodyFor(marker.id as Parameters<typeof bodyFor>[0]);
          if (!body) return null;
          const here = body.id === activeBody;
          const visitable = isLandable(body) && !here;
          const nameTop = (stacked.get(marker.id) ?? marker.y + clearanceOf(marker)) - marker.y;
          return (
            <div
              key={marker.id}
              className={
                `solarlabel ${here ? 'is-here' : ''} ` +
                `${focused === marker.id ? 'is-focused' : ''} ` +
                `${hovered === marker.id ? 'is-hovered' : ''}`
              }
              style={
                {
                  left: `${marker.x}px`,
                  top: `${marker.y}px`,
                  // The ring is sized from the body it belongs to, so a sun
                  // and a Mercury are not marked with the same circle.
                  ['--size' as string]: `${marker.sizePx}px`,
                } as React.CSSProperties
              }
            >
              {visitable && (
                <button
                  type="button"
                  className="solarlabel__visit"
                  style={{ bottom: `${clearanceOf(marker)}px` }}
                  onClick={() => {
                    setFlyingTo(body.id);
                    setPage(null);
                  }}
                  disabled={Boolean(flyingTo)}
                >
                  Visit {body.name}
                </button>
              )}
              <span className="solarlabel__name" style={{ top: `${nameTop}px` }}>
                {body.name}
                {here && <span className="solarlabel__here">you are here</span>}
              </span>
            </div>
          );
        })}
      </div>

      {/*
        The caption for the chosen body: a small line of facts, its name at
        size, and either a way to go there or the reason there is not one. It
        is `aria-live` because choosing a body with the arrow keys changes it
        without moving focus, and a screen reader would otherwise be told
        nothing at all (D171).
      */}
      {caption && (
        <div className="focus" aria-live="polite">
          <p className="focus__eyebrow">{caption.eyebrow}</p>
          <h2 className="focus__name">{caption.name}</h2>
          {caption.action.kind === 'visit' ? (
            <button
              type="button"
              className="focus__action"
              disabled={Boolean(flyingTo) || focused === activeBody}
              onClick={() => {
                if (!focusBody) return;
                setFlyingTo(focusBody.id);
                setPage(null);
              }}
            >
              {focused === activeBody ? 'You are here' : caption.action.label}
            </button>
          ) : (
            <p className="focus__refusal">{caption.action.reason}</p>
          )}
        </div>
      )}

      {/* Step outward and back, wrapping. The keyboard does the same thing. */}
      <div className="stepper">
        <button
          type="button"
          className="stepper__arrow"
          aria-label="Previous body, sunward"
          onClick={() => step(-1)}
        >
          ←
        </button>
        <button
          type="button"
          className="stepper__arrow"
          aria-label="Next body, outward"
          onClick={() => step(1)}
        >
          →
        </button>
      </div>

      {/*
        The index. Ten bodies is few enough to list, and a list answers the
        question the scene cannot: what is here, in order, and how far.
      */}
      {indexOpen && (
        <div className="sysindex" role="dialog" aria-label="Every body in the system">
          <ul className="sysindex__list">
            {indexBodies.map((id) => {
              const body = bodyFor(id);
              if (!body) return null;
              const au =
                id !== 'sun' && id !== 'moon'
                  ? heliocentricDistance(
                      id as PlanetId,
                      viewInstant ? new Date(viewInstant) : new Date(),
                    )
                  : null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`sysindex__row ${focused === id ? 'is-focused' : ''}`}
                    onClick={() => {
                      setFocused(id);
                      centreOn.current = id;
                      setIndexOpen(false);
                    }}
                  >
                    <span className="sysindex__name">{body.name}</span>
                    <span className="sysindex__au">{au === null ? '—' : `${au.toFixed(2)} AU`}</span>
                    <span className="sysindex__note">
                      {isLandable(body) ? 'Surface imagery' : 'No surface'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="system__corner">
        <button type="button" className="system__back" onClick={() => setPage(null)}>
          ← Back to {bodyFor(activeBody)?.name ?? 'the surface'}
        </button>
        <button
          type="button"
          className="system__index-toggle"
          aria-expanded={indexOpen}
          onClick={() => setIndexOpen((v) => !v)}
        >
          {indexOpen ? 'Close index' : 'Index'}
        </button>
      </div>
    </div>
  );
}
