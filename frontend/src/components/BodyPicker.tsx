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

import { BODIES, type Body, bodyFor, isLandable } from '../bodies';
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
    if (!isLandable(body)) return;
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
            const landable = isLandable(body);
            return (
              <li key={body.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={body.id === activeBody}
                  disabled={!landable}
                  // The reason is on the row itself, not only in a tooltip: a
                  // disabled control with no stated cause reads as broken.
                  title={landable ? undefined : body.noSurfaceReason}
                  className={`bodies__item ${body.id === activeBody ? 'is-active' : ''} ${
                    landable ? '' : 'is-locked'
                  }`}
                  onClick={() => choose(body)}
                >
                  <span
                    className={`bodies__dot bodies__dot--${body.id}`}
                    aria-hidden="true"
                  />
                  <span className="bodies__name">{body.name}</span>
                  {landable ? (
                    <span className="bodies__radius">
                      {body.radiusKm.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}{' '}
                      km
                    </span>
                  ) : (
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
