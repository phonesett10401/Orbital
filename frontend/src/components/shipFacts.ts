/**
 * What the detail panel says about a ship.
 *
 * A third set of rows, for the reason there is a second: the panel's aircraft
 * half asks questions a vessel cannot answer — what airline, what registration,
 * which airport it left, what route it is scheduled to fly — and rendering
 * those as blanks would read as missing data rather than as questions that do
 * not apply (D98).
 *
 * It also asks one that a ship answers *badly*. **Altitude.** A vessel is at
 * sea level, which the backend reports as zero rather than null because it is a
 * fact and not a gap (D165) — so the aircraft panel would print "Altitude 0 m"
 * on every ship, which is true, useless, and occupies the row where the reader
 * is looking for something that varies.
 *
 * Pure and returning data rather than JSX, in the same shape as
 * `satelliteFacts`, because there is no component-render harness here:
 * presentation judgements are extracted and tested as data.
 */

import { KIND_LABEL, shipKind } from '../shipKind';
import type { TrackedObjectDetail } from '../types';

export interface Row {
  label: string;
  value: string;
  /** A qualifier printed under the value, where one is honest to add. */
  note?: string;
}

const MS_TO_KNOTS = 1 / 0.514444;

/**
 * Speed in knots first, metres per second second.
 *
 * The contract carries m/s because that is one unit for every layer (D18), and
 * the aircraft panel prints m/s and km/h because that is how air speed is
 * discussed. At sea it is knots, universally — a mariner reading "6 m/s" has
 * to convert it, and the whole point of this panel is that they should not
 * have to.
 */
export function formatSpeed(velocity: number | null): string {
  if (velocity === null) return 'Not transmitted';
  const knots = velocity * MS_TO_KNOTS;
  // Under a tenth of a knot is a ship that is not moving, and "0.0 knots"
  // invites the reader to wonder whether it is really 0.04. Say the thing.
  if (knots < 0.1) return 'Stopped';
  return `${knots.toFixed(1)} knots (${velocity.toFixed(1)} m/s)`;
}

/**
 * Heading, or the honest absence of one.
 *
 * "Not transmitted" rather than "Unknown", because those are different
 * statements and this one is precise: 230 of 916 vessels sent neither a true
 * heading nor a usable course, and it is a property of the transmitter rather
 * than of our knowledge (D165).
 */
export function formatHeading(heading: number | null): string {
  if (heading === null) return 'Not transmitted';
  return `${Math.round(heading)}°`;
}

/**
 * The rows, in the order a reader wants them.
 *
 * What the vessel *is* and what it is *doing* come first, because on this layer
 * they are the two facts that vary — four fifths of the fleet is stationary, so
 * "Moored" against "Under way" is the difference between two ships that look
 * identical on the map.
 */
export function shipRows(detail: TrackedObjectDetail): Row[] {
  const meta = detail.meta ?? {};
  const rows: Row[] = [];

  rows.push({
    label: 'Vessel type',
    // The family name where the AIS code is unhelpfully specific, falling back
    // to the source's own word. Never "Unknown" where the feed said something.
    value: meta.shipType ?? detail.model ?? KIND_LABEL[shipKind(detail.model)],
  });

  if (meta.navigationStatus) {
    rows.push({
      label: 'Status',
      value: meta.navigationStatus,
      // Said out loud because it is set by hand on the bridge and is the one
      // field here nobody should take as gospel: 473 vessels in one sample
      // reported "under way using engine" while transmitting no movement at
      // all (D165).
      note: 'as set by the crew',
    });
  }

  rows.push({ label: 'Speed over ground', value: formatSpeed(detail.velocity) });
  rows.push({ label: 'Heading', value: formatHeading(detail.heading) });

  if (meta.destination) {
    rows.push({
      label: 'Destination',
      value: meta.destination,
      // Free text typed by the crew, so it is a port name, a UN/LOCODE, a
      // route, or a shrug. Shown because it is genuinely useful and qualified
      // because it is not a controlled vocabulary.
      note: meta.eta ? `ETA ${meta.eta}` : 'as entered on board',
    });
  }

  const size = [meta.length, meta.beam].filter(Boolean).join(' × ');
  if (size) {
    rows.push({
      label: 'Size',
      value: size,
      note: meta.draught ? `drawing ${meta.draught}` : undefined,
    });
  }

  if (meta.imo) rows.push({ label: 'IMO number', value: meta.imo });
  if (meta.callSign) rows.push({ label: 'Call sign', value: meta.callSign });
  rows.push({ label: 'MMSI', value: meta.mmsi ?? detail.id });

  return rows;
}

/**
 * Meta keys `shipRows` already renders, so the generic list below it skips them.
 *
 * `vesselName` is here for a different reason from the rest: it is not shown by
 * a row above, it is shown as the **panel's title**. Left in the generic list
 * it printed the ship's name twice, which reads as a data problem rather than
 * a display one — the same duplication `panelFields` exists to prevent.
 */
export const SHIP_META_SHOWN = new Set([
  'vesselName',
  'shipType',
  'navigationStatus',
  'destination',
  'eta',
  'length',
  'beam',
  'draught',
  'imo',
  'callSign',
  'mmsi',
]);
