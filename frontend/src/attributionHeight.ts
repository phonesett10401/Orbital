/**
 * Publish the map credit's height so the chrome above it can get out of the way.
 *
 * **Three times now, a fixed offset has been wrong.** D178 put the status bar
 * 34px up and the credit still showed through; D180 measured 44 and moved it to
 * 56; and on a real phone it overlapped again, because the credit is not a
 * fixed height at all. It wraps - to two lines at 375 wide, to three when the
 * body is one whose imagery carries an extra attribution - and every one of
 * those numbers was measured on one screen showing one world.
 *
 * So nothing guesses any more. The credit is measured where it is drawn and its
 * height is published as a custom property; the bars above it are positioned
 * from that. A wrap moves them the same frame it happens.
 *
 * This matters more than tidiness: the attribution is a licence obligation, and
 * this project treats crediting the wrong source as a licence fault rather than
 * a cosmetic one (D120). Covering the credit with a counter is the same family
 * of mistake (D182).
 */

/** The property the stylesheet reads. */
export const ATTRIBUTION_HEIGHT_PROPERTY = '--attribution-height';

/**
 * What to publish before anything has been measured, and when the credit is
 * absent altogether.
 *
 * Two lines at a phone's width. Erring high is the safe direction: too much
 * clearance is a gap, too little is a covered credit.
 */
export const ATTRIBUTION_HEIGHT_FALLBACK = 44;

export function publishAttributionHeight(target: HTMLElement, height: number): void {
  // Rounded up, because a fractional pixel of clearance rounds the wrong way on
  // a device pixel ratio of 2 and leaves a hairline of credit showing.
  const usable = Number.isFinite(height) && height > 0 ? Math.ceil(height) : ATTRIBUTION_HEIGHT_FALLBACK;
  target.style.setProperty(ATTRIBUTION_HEIGHT_PROPERTY, `${usable}px`);
}

/**
 * Watch the credit inside `container` and keep the property on `target` current.
 *
 * Returns a teardown. Safe to call where there is no credit yet and where the
 * browser has no `ResizeObserver`: in both cases the fallback is published and
 * the caller gets a teardown that does nothing, because a view that cannot
 * measure should still be laid out.
 */
export function trackAttributionHeight(container: HTMLElement, target: HTMLElement): () => void {
  const credit = container.querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
  if (!credit) {
    publishAttributionHeight(target, ATTRIBUTION_HEIGHT_FALLBACK);
    return () => {};
  }

  const sync = () => publishAttributionHeight(target, credit.getBoundingClientRect().height);
  sync();

  if (typeof ResizeObserver !== 'function') return () => {};

  // The credit changes height on two occasions and neither is a resize event:
  // the window narrowing enough to wrap it, and the body changing to one whose
  // imagery carries a different credit.
  const observer = new ResizeObserver(sync);
  observer.observe(credit);
  return () => observer.disconnect();
}
