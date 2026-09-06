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
