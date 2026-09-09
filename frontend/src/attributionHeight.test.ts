import { beforeEach, describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_HEIGHT_FALLBACK,
  ATTRIBUTION_HEIGHT_PROPERTY,
  publishAttributionHeight,
  trackAttributionHeight,
} from './attributionHeight';

function withCredit(height: number | null): HTMLElement {
  const container = document.createElement('div');
  if (height !== null) {
    const credit = document.createElement('div');
    credit.className = 'maplibregl-ctrl-attrib';
    credit.getBoundingClientRect = () => ({ height }) as DOMRect;
    container.appendChild(credit);
  }
  return container;
}

describe('publishAttributionHeight', () => {
  let target: HTMLElement;
  beforeEach(() => {
    target = document.createElement('div');
  });

  it('publishes the measured height', () => {
    publishAttributionHeight(target, 62);
    expect(target.style.getPropertyValue(ATTRIBUTION_HEIGHT_PROPERTY)).toBe('62px');
  });

  it('rounds up, because half a pixel of clearance leaves a hairline of credit', () => {
    publishAttributionHeight(target, 43.2);
    expect(target.style.getPropertyValue(ATTRIBUTION_HEIGHT_PROPERTY)).toBe('44px');
  });

  it('falls back rather than publishing a height that would cover the credit', () => {
    // A zero measurement is what an element that has not been laid out reports,
    // and publishing it would sit the status bar directly on the attribution -
    // the exact fault this exists to prevent.
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      publishAttributionHeight(target, bad);
      expect(target.style.getPropertyValue(ATTRIBUTION_HEIGHT_PROPERTY)).toBe(
        `${ATTRIBUTION_HEIGHT_FALLBACK}px`,
      );
    }
  });
});

describe('trackAttributionHeight', () => {
  it('measures the credit it finds', () => {
    const target = document.createElement('div');
    trackAttributionHeight(withCredit(58), target);
    expect(target.style.getPropertyValue(ATTRIBUTION_HEIGHT_PROPERTY)).toBe('58px');
  });

  it('still lays the view out when there is no credit at all', () => {
    // A body whose style carries no attribution, or a map that failed to load.
    // Publishing nothing would leave the bars reading an undefined property.
    const target = document.createElement('div');
    const stop = trackAttributionHeight(withCredit(null), target);
    expect(target.style.getPropertyValue(ATTRIBUTION_HEIGHT_PROPERTY)).toBe(
      `${ATTRIBUTION_HEIGHT_FALLBACK}px`,
    );
    expect(() => stop()).not.toThrow();
  });

  it('hands back a teardown that can always be called', () => {
    const target = document.createElement('div');
    expect(() => trackAttributionHeight(withCredit(44), target)()).not.toThrow();
  });
});
