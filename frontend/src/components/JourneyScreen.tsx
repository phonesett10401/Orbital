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

import { useOrbitalStore } from '../state/store';
import { bodyFor } from '../bodies';
import { journeyLabel } from '../journey';
import { prefersReducedMotion } from '../motion';

export function JourneyScreen() {
  const journey = useOrbitalStore((s) => s.journey);
  const activeBody = useOrbitalStore((s) => s.activeBody);
  const still = prefersReducedMotion();

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
