/**
 * Names on the planets, and a way in (D159).
 *
 * The solar system was a picture. This makes it a place: every body drawn
 * carries its name, and the four with a surface under them carry a **Visit**
 * button that starts the trip.
 *
 * ## Positions come from the layer that drew them
 *
 * Not from `map.project` on the body's direction, which is the obvious shortcut
 * and is wrong - the bodies sit at different distances in a 3D scene, and a
 * direction says nothing about where along that ray a sphere was drawn. The
 * layer projects each one with the matrix it just rendered with and publishes
 * the result (`solarMarkerFeed.ts`), so the chrome cannot disagree with the
 * picture.
 *
 * ## Read on a frame, re-rendered only when it shows
 *
 * The camera moves continuously, so the numbers change every frame. Re-rendering
 * ten elements sixty times a second to move them a fraction of a pixel is work
 * nobody sees, so a frame is only committed when something moved a whole pixel
 * or the set of bodies changed. That check is the difference between this being
 * free and this being the most expensive thing on screen.
 *
 * ## Nothing here says where a planet is
 *
 * A label is a name, not a claim about distance or size - both of which are
 * compressed by three orders of magnitude, and `SCALE_NOTE` says so. Naming a
 * body is safe in a way that annotating it with a number would not be.
 */

import { useEffect, useRef, useState } from 'react';

import { bodyFor, isLandable } from '../bodies';
import { currentMarkers } from '../planet/solarMarkerFeed';
import type { BodyMarker } from '../planet/solarSystemLayer';
import { useOrbitalStore } from '../state/store';

/** Moved less than this and the frame is not worth committing. */
const MOVED_ENOUGH_PX = 1;

function changed(a: BodyMarker[], b: BodyMarker[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return true;
    if (Math.abs(a[i].x - b[i].x) >= MOVED_ENOUGH_PX) return true;
    if (Math.abs(a[i].y - b[i].y) >= MOVED_ENOUGH_PX) return true;
    if (Math.abs(a[i].sizePx - b[i].sizePx) >= MOVED_ENOUGH_PX) return true;
  }
  return false;
}

export function SolarLabels() {
  const [markers, setMarkers] = useState<BodyMarker[]>([]);
  const shown = useRef<BodyMarker[]>([]);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const flyingTo = useOrbitalStore((s) => s.flyingTo);
  const setFlyingTo = useOrbitalStore((s) => s.setFlyingTo);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = requestAnimationFrame(read);
      const next = currentMarkers();
      if (!changed(shown.current, next)) return;
      shown.current = next;
      setMarkers(next);
    };
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (markers.length === 0) return null;

  return (
    <div className="solarlabels" aria-label="The solar system">
      {markers.map((marker) => {
        const body = bodyFor(marker.id as Parameters<typeof bodyFor>[0]);
        if (!body) return null;
        // Clear of the body itself, so a label never sits on the thing it
        // names. Saturn's rings are wider than its sphere, which is why this
        // is a measured size rather than a constant.
        const clearance = Math.max(14, marker.sizePx / 2 + 12);
        const here = body.id === activeBody;
        const visitable = isLandable(body) && !here;
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
                style={{ bottom: `${clearance}px` }}
                onClick={() => setFlyingTo(body.id)}
                disabled={Boolean(flyingTo)}
              >
                Visit {body.name}
              </button>
            )}
            <span className="solarlabel__name" style={{ top: `${clearance}px` }}>
              {body.name}
              {here && <span className="solarlabel__here"> · you are here</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
