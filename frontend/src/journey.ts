/**
 * Changing view as a journey with a screen of its own (D161).
 *
 * The planet view and the solar system are two different pictures at wildly
 * different scales, and until now moving between them was a camera glide - the
 * globe shrank, the planets faded up, and at no point did the interface admit
 * that you had gone somewhere. Phone asked for two views and a transition that
 * says so, which is also the honest description of what happens: **these are
 * two pages, not two ends of a zoom.**
 *
 * ## What it is allowed to say
 *
 * "Heading to", not "Loading". Nothing is fetched at either end - the planet
 * positions are computed and the layer is already there - so a loading screen
 * would be a lie about why the view is changing, told in the one place the
 * reader has nothing else to look at.
 */

/** Where a journey is going. */
export type Destination = 'system' | 'planet';

/**
 * What the screen says.
 *
 * Named rather than templated at the call site so the wording lives in one
 * place and can be checked: this is the sentence a reader stares at with
 * nothing else on screen, and it is the easiest place in the application to
 * accidentally claim something.
 */
export function journeyLabel(to: Destination, bodyName: string): string {
  return to === 'system' ? 'Heading to the solar system' : `Heading to ${bodyName}`;
}

/**
 * How long the screen is held, in milliseconds.
 *
 * Long enough to read four words and to cover the camera move underneath it,
 * short enough that it never becomes a wait. The camera settle is 420ms, so
 * this outlasts it deliberately: a transition screen that lifts while the view
 * behind it is still moving shows the reader the seam it exists to cover.
 */
export const JOURNEY_MS = 1_100;

/** Zero movement for a reader who asked for that, but the words still show. */
export function journeyMs(reducedMotion: boolean): number {
  return reducedMotion ? 700 : JOURNEY_MS;
}

/**
 * The floor on a journey to the solar system, in milliseconds (D174).
 *
 * The screen used to run on a fixed 1,100 ms clock while the page opened in the
 * same tick, so on a slower machine the reader saw the words for a tenth of a
 * second with a stall around them. The hold is tied to the destination being
 * **ready** now, and this is only the floor: a page ready in 40 ms must still
 * not flash four words and vanish.
 */
export const JOURNEY_MIN_MS = 750;

/**
 * The ceiling, after which the screen lifts whether or not anything said it was
 * ready.
 *
 * A transition that can hang forever is worse than a seam. If the solar page
 * has not drawn a frame in six seconds then something is wrong, and the reader
 * is better off looking at it than at a word and a dot.
 */
export const JOURNEY_MAX_MS = 6_000;

/**
 * Whether the journey screen may lift.
 *
 * The trip *back* to a planet needs no readiness signal - that view is already
 * mounted and never went away - so it keeps the fixed clock it always had.
 * Only the outward trip waits for something.
 */
export function journeyHoldDone(
  to: Destination,
  elapsedMs: number,
  destinationReady: boolean,
  reducedMotion: boolean,
): boolean {
  if (to === 'planet') return elapsedMs >= journeyMs(reducedMotion);
  if (elapsedMs >= JOURNEY_MAX_MS) return true;
  return destinationReady && elapsedMs >= JOURNEY_MIN_MS;
}
