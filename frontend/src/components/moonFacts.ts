/**
 * What the panel says about a lunar spacecraft (D135).
 *
 * Pure and returning data rather than JSX, because there is no component-render
 * harness in this project - the same reason `satelliteFacts`, `routeSummary`
 * and `panelFields` exist. Presentation judgements are extracted so they can be
 * tested; the component stays thin enough to read in one go.
 *
 * ## The judgement worth extracting here is what the panel is *for*
 *
 * Every other position in Orbital is an observation or is derived from one: an
 * aircraft reports where it was, and an Earth satellite's position is computed
 * from elements fitted to real tracking. **A lunar position is read from an
 * ephemeris published in advance** - a prediction by the people flying the
 * spacecraft. Very accurate, and still not a measurement.
 *
 * A reader has no way to tell that from a marker on a map, so the panel says
 * it, and `SOURCE_NOTE` is asserted rather than left to whoever edits the JSX
 * next.
 */

import type { MoonSatellite } from '../moonSatellites';
import { describeAltitude } from '../moonSatellites';

export interface Row {
  label: string;
  value: string;
  /** Rendered in the monospace face, for anything positional. */
  mono?: boolean;
}

/** Degrees with a hemisphere letter, which reads faster than a minus sign. */
export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
}

export function formatLon(lon: number): string {
  return `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/**
 * The two numbers, kept apart on purpose.
 *
 * A reader will otherwise merge them into one idea. The latitude and longitude
 * are the point on the surface the craft is *over* - not somewhere it is - and
 * the altitude is how far above that point it sits. Labelling the pair "Over"
 * rather than "Position" is the whole of that distinction in one word.
 */
export function moonRows(craft: MoonSatellite): Row[] {
  return [
    { label: 'Altitude', value: describeAltitude(craft.altitudeKm) },
    {
      label: 'Over',
      value: `${formatLat(craft.lat)} ${formatLon(craft.lon)}`,
      mono: true,
    },
  ];
}

/** Why these coordinates are not a landing site. */
export const SUB_POINT_NOTE =
  'The marker is the point on the surface directly beneath the spacecraft, ' +
  'not a place on the Moon it has landed. Selenographic coordinates.';

/** Where the position came from, and why that is different from every other. */
export const SOURCE_NOTE =
  'Position from a published ephemeris - JPL Horizons, interpolated between ' +
  'samples a minute apart. Unlike the aircraft and satellites elsewhere in ' +
  'Orbital, this is where the spacecraft is predicted to be by the people ' +
  'flying it, rather than where anything has observed it to be.';

/** What the panel shows when a window runs out with the panel open. */
export const LOST_NOTE =
  'The published ephemeris for this spacecraft no longer covers the current ' +
  'moment. It is not lost - we simply have nothing to draw.';

export type PanelState =
  | { kind: 'closed' }
  | { kind: 'lost' }
  | { kind: 'craft'; craft: MoonSatellite };

/**
 * What to render, from the selection and the craft currently known.
 *
 * Three states rather than two. The third exists because a spacecraft can stop
 * being tracked **while its panel is open**: its ephemeris window runs out on
 * the next poll and it leaves the list. Freezing the last position would look
 * identical to a spacecraft still being followed, and closing the panel would
 * move the reader somewhere they did not ask to go - so it says so instead.
 */
export function panelState(
  selectedId: string | null,
  craft: MoonSatellite[],
): PanelState {
  if (!selectedId) return { kind: 'closed' };
  const found = craft.find((c) => c.id === selectedId);
  return found ? { kind: 'craft', craft: found } : { kind: 'lost' };
}

/** Roughly what the floating panel occupies, for keeping it on screen. */
export const PANEL_WIDTH = 300;
export const PANEL_HEIGHT = 300;

/**
 * Where the floating panel actually goes, given where the line ends.
 *
 * The line ends up and to the right of the spacecraft, and the panel hangs off
 * that end - so its *bottom left* corner sits there, which is what makes the
 * two read as one object rather than a line pointing near a box.
 *
 * Then it is clamped into the window. Without this, selecting a spacecraft in
 * the top right corner of the map puts its panel mostly off screen, and the
 * spacecraft near the top of the globe is exactly where the interesting ones
 * are: these are polar orbiters (D137).
 */
export function panelPosition(
  at: { x: number; y: number },
  window: { width: number; height: number },
  margin = 12,
): { left: number; top: number } {
  const left = at.x;
  const top = at.y - PANEL_HEIGHT;
  return {
    left: Math.max(margin, Math.min(left, window.width - PANEL_WIDTH - margin)),
    top: Math.max(margin, Math.min(top, window.height - PANEL_HEIGHT - margin)),
  };
}
