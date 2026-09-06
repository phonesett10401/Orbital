/**
 * The cue on the way out to the solar system (D159).
 *
 * Zooming out from a planet used to arrive at the handover with no warning: the
 * globe stopped and something else was there. This announces it, growing as the
 * handover gets closer and gone the moment the planets are actually drawn.
 *
 * Read on a frame from the same feed the labels use, for the same reason: the
 * zoom changes continuously while a gesture is running, and a store write per
 * frame would wake the whole application to report a hundredth of a zoom level.
 */

import { useEffect, useState } from 'react';

import { currentZoom } from '../planet/solarMarkerFeed';
import { APPROACH_TEXT, approach, showsApproach } from '../solarApproach';

/** Rounded before it reaches state, so a frame only commits when it shows. */
const STEPS = 20;

export function SolarApproach() {
  const [strength, setStrength] = useState(0);

  useEffect(() => {
    let frame = 0;
    let last = -1;
    const read = () => {
      frame = requestAnimationFrame(read);
      const zoom = currentZoom();
      const next = showsApproach(zoom) ? Math.round(approach(zoom) * STEPS) / STEPS : 0;
      if (next === last) return;
      last = next;
      setStrength(next);
    };
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (strength <= 0) return null;

  return (
    <div className="approach" aria-hidden="true" style={{ opacity: strength }}>
      <span className="approach__text">{APPROACH_TEXT}</span>
    </div>
  );
}
