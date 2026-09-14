/**
 * The worlds, under the wordmark.
 *
 * Opens on hover and on focus - hover alone would put the whole feature out of
 * reach of a keyboard, and this is the only way to leave Earth.
 *
 * **Every body is listed, including the six that cannot be entered**, each
 * with the reason it cannot. The alternative - showing only the four that
 * work - would answer "can I go to Jupiter" with silence, and a reader would
 * reasonably conclude the feature was unfinished rather than that Jupiter has
 * no ground (D120).
 */

import { useEffect, useRef, useState } from 'react';

import { BODIES, type Body, bodyFor, canEnter, standsOnGround } from '../bodies';
import { useOrbitalStore } from '../state/store';

export function BodyPicker() {
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const setFlyingTo = useOrbitalStore((s) => s.setFlyingTo);
  const [open, setOpen] = useState(false);

  /**
   * Closing is delayed; opening is not.
   *
   * The menu sits a few pixels below its button, and that gap is not part of
   * any hover region - so moving the mouse toward a planet crossed dead space
   * and `mouseleave` shut the list before it could be clicked. A CSS bridge
   * covers the gap itself, and this covers the rest: a diagonal move toward a
   * lower item clips the corner of the panel, which is a miss no bridge can
   * fix (D127).
   */
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 220);
  };
  useEffect(() => cancelClose, []);

  const current = bodyFor(activeBody);

  const choose = (body: Body) => {
    if (!canEnter(body)) return;
    if (body.id === activeBody) {
      setOpen(false);
      return;
    }
    // The picker only names a destination. The camera work belongs to the map,
    // which is the only thing that can do it, and the swap happens at the apex
    // (D126).
    setFlyingTo(body.id);
    setOpen(false);
  };

  return (
    <div
      className="bodies"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={closeSoon}
    >
      <button
        className="bodies__current"
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((was) => !was)}
        onFocus={() => setOpen(true)}
      >
        <span className={`bodies__dot bodies__dot--${current.id}`} aria-hidden="true" />
        {current.name}
        <span className="bodies__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <ul className="bodies__list" role="listbox" aria-label="World to show">
          {BODIES.map((body) => {
            const enterable = canEnter(body);
            // A world can be enterable and still not be a place. Jupiter is
            // both: you can go and turn it, and there is nothing under the
            // cloud to stand on, so the row carries that sentence instead of
            // its radius (D193).
            const ground = standsOnGround(body);
            return (
              <li key={body.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={body.id === activeBody}
                  disabled={!enterable}
                  // The reason is on the row itself, not only in a tooltip: a
                  // disabled control with no stated cause reads as broken. A
                  // world that *can* be entered says what its mosaic is
                  // missing, for the same reason one way along: an empty pole
                  // with nothing said about it reads as a fault in Orbital
                  // rather than as the edge of what a spacecraft managed.
                  // The reason rides the row for a world you can enter that
                  // still has no ground, and in the tooltip for one whose
                  // imagery is merely incomplete.
                  title={ground ? body.surface?.caveat : body.noSurfaceReason}
                  className={`bodies__item ${body.id === activeBody ? 'is-active' : ''} ${
                    enterable ? '' : 'is-locked'
                  }`}
                  onClick={() => choose(body)}
                >
                  <span
                    className={`bodies__dot bodies__dot--${body.id}`}
                    aria-hidden="true"
                  />
                  <span className="bodies__name">{body.name}</span>
                  {ground ? (
                    // **Labelled, because the bare number reads as a distance.**
                    // `6,371 km` beside "Earth" is exactly the shape of "how far
                    // away is it", and that was the first question it got asked.
                    // The word is the whole fix.
                    <span className="bodies__radius">
                      radius{' '}
                      {body.radiusKm.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}{' '}
                      km
                    </span>
                  ) : (
                    // The gas giants keep this line now that they are
                    // enterable, because it is the thing most worth saying
                    // about them and the only place left to say it.
                    <span className="bodies__why">{body.noSurfaceReason}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
