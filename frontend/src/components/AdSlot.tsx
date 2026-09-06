/**
 * One advertising slot (D150).
 *
 * Two of these exist: a strip across the top and a rail down the right. Both
 * are shown to everybody who is not premium, and the whole of what premium buys
 * here is that they are not rendered at all - not smaller, not fewer.
 *
 * ## They take space rather than covering the map
 *
 * Every other panel in Orbital floats over the globe, because the globe is the
 * product. An advertisement is the one thing on this page that is **not** the
 * product, so it is the one thing that does not get to sit on top of it: the
 * slots are grid rows and columns, and the map genuinely gets smaller. An ad
 * obscuring the thing somebody came for is how a free tier turns hostile.
 *
 * ## Rotation is a crossfade, and stops if the reader asked for that
 *
 * `prefers-reduced-motion` is not a preference about taste. Movement in the
 * corner of the eye is exactly what it is set to stop, and an advertisement is
 * exactly the thing that would ignore it.
 */

import { useEffect, useState } from 'react';

import { AD_LABEL, type AdSlot as Slot, ROTATE_MS, adAt, inventoryFor } from '../ads';
import { prefersReducedMotion } from '../motion';

export function AdSlot({ slot }: { slot: Slot }) {
  const [tick, setTick] = useState(0);
  const still = prefersReducedMotion();

  useEffect(() => {
    // One card only if the inventory has one, or if the reader has asked the
    // interface to hold still.
    if (still || inventoryFor(slot).length < 2) return undefined;
    const timer = window.setInterval(() => setTick((t) => t + 1), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [slot, still]);

  const ad = adAt(slot, tick);

  return (
    <aside className={`ad ad--${slot}`} aria-label="Advertisement">
      <span className="ad__label">
        {AD_LABEL} · {ad.sponsor}
      </span>
      {/*
        Keyed by the card, not by the slot. That is what makes React replace the
        node instead of mutating it, which is what lets the entry animation run
        at all - the same mount-once trick the sign-in panel uses.
      */}
      <div className="ad__card" key={ad.id}>
        <p className="ad__headline">{ad.headline}</p>
        <p className="ad__body">{ad.body}</p>
        {ad.action && <span className="ad__action">{ad.action} →</span>}
      </div>
    </aside>
  );
}
