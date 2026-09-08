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
 * - **Drag** slides the scene, one world-unit per pixel, because the camera has
 *   a target to move. This is the thing that could not be done at any damping
 *   while the map owned the camera (D160).
 * - **Wheel** moves in and out by a proportion of the remaining distance.
 * - **Right-drag** turns the system, since owning the camera means there is
 *   something to turn.
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
  zoom,
  type SolarCamera,
} from '../solarCamera';
import { useOrbitalStore } from '../state/store';
import { formatInstant } from '../timeTravel';
import { heliocentricDistance } from '../planets';
import {
  FOCUS_ORDER,
  captionForId,
  easeTarget,
  isCentred,
  nearestMarker,
  stepFocus,
} from '../solarFocus';
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
 * Near enough to centred to stop, in world units.
 *
 * The scene spans about sixty units across Neptune's orbit, so a thousandth of
 * that is well under a pixel at any zoom this page reaches.
 */
const CENTRE_DONE = 0.02;

/** Characters in "you are here", the second line the current body carries. */
const HERE_CHARS = 12;

/**
 * What this page is actually showing, said once (D171).
 *
 * The Moon is named separately because it is drawn separately - as Earth's
 * companion, at an offset that is not its real distance (`COMPANION_OFFSET`),
 * because 0.0026 AU is below anything this compression can show. Saying "and
 * the Moon" is therefore honest about a body being present and says nothing
 * about where; `solarBodies.ts` carries the reasoning.
 */
const SYSTEM_SUBJECT = 'The sun, eight planets and the Moon';

export function SolarSystemPage() {
  const open = useOrbitalStore((s) => s.openPage) === 'system';
  const setPage = useOrbitalStore((s) => s.setOpenPage);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const viewInstant = useOrbitalStore((s) => s.viewInstant);
  const setFlyingTo = useOrbitalStore((s) => s.setFlyingTo);
  const flyingTo = useOrbitalStore((s) => s.flyingTo);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const dragState = useRef({ x: 0, y: 0, startX: 0, startY: 0, button: 0, active: false });
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
  /**
   * The ids currently drawn, for the stepper.
   *
   * A ref because the arrow keys must not re-bind their listener every time a
   * planet moves a pixel, and `markers` is a new array on every commit.
   */
  const drawnIds = useRef<string[]>([]);

  // The Moon rides with the Earth and has no elements of its own, so anything
  // asking `planets.ts` a question must ask it about Earth instead (D140).
  const origin: PlanetId = (activeBody === 'moon' ? 'earth' : activeBody) as PlanetId;

  useEffect(() => {
    if (!open || !canvas.current) return undefined;
    const element = canvas.current;
    const built = createSolarScene(element);
    scene.current = built;
    camera.current = initialCamera();

    let frame = 0;
    let shown: BodyMarker[] = [];
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const width = element.clientWidth;
      const height = element.clientHeight;
      built.resize(width, height, window.devicePixelRatio || 1);
      built.render(
        camera.current,
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
      const next = stepFocus(focused, event.key === 'ArrowRight' ? 1 : -1, drawnIds.current);
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

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
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
        ? orbit(camera.current, -dx * 0.005, -dy * 0.005)
        : pan(camera.current, dx, dy, height);
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const wasActive = drag.active;
    drag.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // A press that went nowhere is a click. The canvas is both the thing you
    // drag and the thing you click, so the two are told apart afterwards.
    if (!wasActive || drag.button !== 0) return;
    const travelled = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (travelled > CLICK_SLOP_PX) return;

    const point = atCanvas(event);
    const hit = nearestMarker(markers, point.x, point.y) as BodyId | null;
    // Empty sky deselects. A page you can enter and not leave is a trap, and
    // the reader's instinct for "never mind" is to click away from the thing.
    choose(hit);
  };

  /** Choose a body, or nothing, and send the camera after it. */
  const choose = (id: BodyId | null) => {
    setFocused(id);
    centreOn.current = id;
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const step = event.deltaY > 0 ? 1 + WHEEL_STEP : 1 - WHEEL_STEP;
    camera.current = zoom(camera.current, step);
  };

  drawnIds.current = markers.map((m) => m.id);

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
    const next = stepFocus(focused, direction, drawnIds.current);
    if (!next) return;
    setFocused(next);
    centreOn.current = next;
  };

  const indexBodies = FOCUS_ORDER.filter((id) => drawnIds.current.includes(id));

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
    <div className="system" role="region" aria-label="The solar system">
      <canvas
        ref={canvas}
        className="system__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
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
          <span>{SYSTEM_SUBJECT}</span>
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
