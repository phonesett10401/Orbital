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
import type { BodyMarker } from '../planet/solarSystemLayer';
import {
  initialCamera,
  orbit,
  pan,
  zoom,
  type SolarCamera,
} from '../solarCamera';
import { useOrbitalStore } from '../state/store';

/** One wheel notch, as a proportion of the remaining distance. */
const WHEEL_STEP = 0.12;

/** Characters in "you are here", the second line the current body carries. */
const HERE_CHARS = 12;

export function SolarSystemPage() {
  const open = useOrbitalStore((s) => s.openPage) === 'system';
  const setPage = useOrbitalStore((s) => s.setOpenPage);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const viewInstant = useOrbitalStore((s) => s.viewInstant);
  const setFlyingTo = useOrbitalStore((s) => s.setFlyingTo);
  const flyingTo = useOrbitalStore((s) => s.flyingTo);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const scene = useRef<SolarScene | null>(null);
  const camera = useRef<SolarCamera>(initialCamera());
  const [markers, setMarkers] = useState<BodyMarker[]>([]);

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

  if (!open) return null;

  const dragFrom = { x: 0, y: 0, button: 0, active: false };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragFrom.x = event.clientX;
    dragFrom.y = event.clientY;
    dragFrom.button = event.button;
    dragFrom.active = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragFrom.active) return;
    const dx = event.clientX - dragFrom.x;
    const dy = event.clientY - dragFrom.y;
    dragFrom.x = event.clientX;
    dragFrom.y = event.clientY;
    const height = event.currentTarget.clientHeight;
    camera.current =
      dragFrom.button === 2
        ? orbit(camera.current, -dx * 0.005, -dy * 0.005)
        : pan(camera.current, dx, dy, height);
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragFrom.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const step = event.deltaY > 0 ? 1 + WHEEL_STEP : 1 - WHEEL_STEP;
    camera.current = zoom(camera.current, step);
  };

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
              className={`solarlabel ${here ? 'is-here' : ''}`}
              style={{ left: `${marker.x}px`, top: `${marker.y}px` }}
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

      <button type="button" className="system__back" onClick={() => setPage(null)}>
        ← Back to {bodyFor(activeBody)?.name ?? 'the surface'}
      </button>
    </div>
  );
}
