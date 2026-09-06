/**
 * Whether the reader has asked the interface to hold still.
 *
 * One function, so the answer cannot differ between the places that ask - the
 * same shape `isPremium` has for tiers.
 *
 * **`prefers-reduced-motion` is not a preference about taste.** It is set by
 * people for whom movement causes nausea, migraine or a vestibular attack, and
 * by people using screen magnification, where a panel sliding across a
 * four-times-zoomed viewport is genuinely disorienting. Every animation added
 * for enjoyment has to ask this first, or it is enjoyable for everybody except
 * the people who told us in advance that it would not be.
 *
 * Guarded for the absence of `matchMedia` because tests run without a browser,
 * and a missing media-query implementation should mean "no stated preference"
 * rather than a crash on the first render.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
