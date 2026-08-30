/**
 * What the panel says about a flight's route, decided away from the markup.
 *
 * Three of the panel's choices are judgements rather than layout, and each one
 * can be wrong in a way a reader would not notice:
 *
 * - **whether there is a scheduled route worth a section at all** - a row that
 *   carries an operator and no airports says nothing the Airline field does
 *   not;
 * - **which of two operator names to believe** - the schedule reports one,
 *   and we decode another from three letters of the callsign (D46). They are
 *   not equally good, and the note under the field has to match whichever won;
 * - **whether the two sources disagree about the origin** - the schedule is
 *   about the *callsign* and the track is about *this aircraft*, so when they
 *   differ the observed one is right and the panel has to say so instead of
 *   silently showing one (D88).
 *
 * Pulled out here so they can be tested as data. The panel renders the answer.
 */

import type { Airline } from '../airlines';
import type { Airport, FlightRoute, TrackedObjectDetail } from '../types';

export interface RouteSummary {
  /** The scheduled route, if it names anywhere; null if there is nothing to show. */
  scheduled: FlightRoute | null;
  /** The operator name to display, from whichever source is better. */
  operator: string | null;
  /** True when that name was published rather than decoded from the callsign. */
  operatorIsReported: boolean;
  /** True when the schedule and the aircraft's own track name different origins. */
  originDisagrees: boolean;
}

export function summariseRoute(
  detail: Pick<TrackedObjectDetail, 'route' | 'origin'>,
  decoded: Airline | null,
): RouteSummary {
  const route = detail.route;
  const names = Boolean(route && (route.origin || route.destination));
  return {
    scheduled: names ? route : null,
    // Reported beats derived. Our decode reads the first three letters of a
    // callsign against a table of designators, which is an inference; adsbdb
    // publishes the operator against the callsign itself.
    operator: route?.airline ?? decoded?.name ?? null,
    operatorIsReported: Boolean(route?.airline),
    originDisagrees: Boolean(
      detail.origin && route?.origin && detail.origin.icao !== route.origin.icao,
    ),
  };
}

/**
 * One end of a route, as short as it can be without becoming a code nobody
 * reads: "DXB Dubai" beats either half alone.
 *
 * Falls through what the database actually filled in - its rows are uneven -
 * and has an explicit unknown for the end it does not name, because a route
 * with one end known is still worth showing.
 */
export function legLabel(airport: Airport | null): { code: string; place: string } {
  if (!airport) return { code: '???', place: 'Unknown' };
  return {
    code: airport.iata ?? airport.icao,
    place: airport.municipality ?? airport.name,
  };
}
