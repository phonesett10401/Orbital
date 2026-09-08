/**
 * The page turn between the planet view and the solar system (D161).
 *
 * They are two views of wildly different scales, and until now moving between
 * them was a camera glide that never admitted you had gone anywhere. This says
 * so: a screen over everything, naming the destination, held long enough to
 * cover the camera move underneath it.
 *
 * ## It covers the seam rather than decorating it
 *
 * The hold outlasts the settle deliberately. A transition screen that lifts
 * while the view behind it is still moving shows the reader exactly the join it
 * exists to hide - which is worse than no screen, because it draws the eye to
 * the moment first.
 *
 * ## Under reduced motion it is shorter, not absent
 *
 * The sentence is information: it is the answer to "what just happened", and
 * somebody who has asked for less movement has not asked to be told less. Only
 * the streaks and the drift go.
 */

import { useEffect, useRef } from 'react';

import { useOrbitalStore } from '../state/store';
import { bodyFor } from '../bodies';
import { journeyHoldDone, journeyLabel } from '../journey';
import { prefersReducedMotion } from '../motion';

export function JourneyScreen() {
  const journey = useOrbitalStore((s) => s.journey);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const systemReady = useOrbitalStore((s) => s.systemReady);
  const still = prefersReducedMotion();
  const startedAt = useRef(0);

  /*
   * **This screen now owns its own lifetime** (D174).
   *
   * It was ended by a `setTimeout` at each of the two places that started one,
   * which is the two-writer shape this project keeps finding: the outward trip
   * ran a fixed 1,100 ms clock that began at the same instant the solar page
   * mounted, so the clock spent itself on the mount and the reader saw four
   * words flash. Neither writer could have known when the destination was
   * actually ready, because neither was the destination.
   *
   * One owner, one rule, and the rule is in `journey.ts` where it can be
   * checked without a browser.
   */
  useEffect(() => {
    if (!journey) return undefined;
    if (startedAt.current === 0) startedAt.current = performance.now();

    let frame = 0;
    const check = () => {
      const elapsed = performance.now() - startedAt.current;
      if (journeyHoldDone(journey, elapsed, systemReady, still)) {
        useOrbitalStore.getState().setJourney(null);
        return;
      }
      frame = window.setTimeout(check, 80);
    };
    check();

    return () => {
      window.clearTimeout(frame);
    };
  }, [journey, systemReady, still]);

  useEffect(() => {
    if (!journey) startedAt.current = 0;
  }, [journey]);

  if (!journey) return null;

  const body = bodyFor(activeBody);
  return (
    <div className={`journey ${still ? 'journey--still' : ''}`} role="status">
      <div className="journey__inner">
        <span className="journey__mark" aria-hidden="true" />
        <span className="journey__text">{journeyLabel(journey, body?.name ?? 'the surface')}</span>
      </div>
    </div>
  );
}
