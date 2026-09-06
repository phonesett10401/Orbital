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
import { stackLabels } from '../labelStack';
import { currentMarkers } from '../planet/solarMarkerFeed';
import type { BodyMarker } from '../planet/solarSystemLayer';
import { useOrbitalStore } from '../state/store';

/** Moved less than this and the frame is not worth committing. */
const MOVED_ENOUGH_PX = 1;

/** Characters in "you are here", the second line the current body carries. */
const HERE_CHARS = 12;

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

  // Names go where they will not land on each other. The orbits were given room
  // first and that was the real fix; this handles what the scale cannot - a name
  // is the same width whatever the orbit does, and the Moon is drawn fifteen
  // pixels from the Earth on purpose (D160).
  //
  // Priority order: the body underfoot, then the largest. Whoever comes first
  // keeps the place directly beneath their own planet.
  const ordered = [...markers].sort((a, b) => {
    if (a.id === activeBody) return -1;
    if (b.id === activeBody) return 1;
    return b.sizePx - a.sizePx;
  });
  const clearanceOf = (m: (typeof markers)[number]) => Math.max(14, m.sizePx / 2 + 12);
  const stacked = new Map(
    stackLabels(
      ordered.map((m) => ({
        id: m.id,
        x: m.x,
        // Estimated from the name rather than measured: measuring would mean a
        // layout pass per frame, and being a few pixels out only ever costs a
        // little extra clearance.
        y: m.y + clearanceOf(m),
        // A box is as wide as its widest line, and the body underfoot carries a
        // second one - "you are here" is wider than every planet's name except
        // Neptune's. Estimating from the name alone left the Moon tucked under
        // it: the stack was right and it was being handed the wrong box.
        width:
          Math.max(
            bodyFor(m.id as Parameters<typeof bodyFor>[0])?.name.length ?? 6,
            m.id === activeBody ? HERE_CHARS : 0,
          ) *
            7 +
          8,
        // Two lines at this line-height measure about 34px, not the 26 the font
        // sizes suggest. Measuring the real box would mean a layout pass per
        // committed frame; being generous by a few pixels costs a little extra
        // clearance and nothing else.
        height: m.id === activeBody ? 34 : 13,
      })),
    ).map((l) => [l.id, l.y] as const),
  );

  return (
    <div className="solarlabels" aria-label="The solar system">
      {markers.map((marker) => {
        const body = bodyFor(marker.id as Parameters<typeof bodyFor>[0]);
        if (!body) return null;
        // Clear of the body itself, so a label never sits on the thing it
        // names. Saturn's rings are wider than its sphere, which is why this
        // is a measured size rather than a constant.
        const clearance = Math.max(14, marker.sizePx / 2 + 12);
        const nameTop = (stacked.get(marker.id) ?? marker.y + clearance) - marker.y;
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
            <span className="solarlabel__name" style={{ top: `${nameTop}px` }}>
              {body.name}
              {/* On its own line, not appended. Inline it made the Earth's
                  label three times the width of every other one, which is what
                  was still colliding with Venus after the orbits themselves had
                  been given room (D160). */}
              {here && <span className="solarlabel__here">you are here</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
