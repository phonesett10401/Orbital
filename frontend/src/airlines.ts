/**
 * Which airline a callsign belongs to.
 *
 * An airline is not in the data. OpenSky reports a callsign — the string the
 * crew filed, like `THA932` — and the first three letters of that string are
 * an ICAO airline designator by convention. Decoding it against a published
 * table is a well-defined lookup, but it is still **our inference about the
 * source's data, not the source's data**, and that is why it lives here in the
 * frontend rather than in the contract (D46). Nothing in `types.ts` changes,
 * no byte is added to the list payload, and `meta` keeps its meaning of
 * "fields the provider actually reported".
 *
 * The table is generated at build time by `scripts/build-airlines.mjs` and
 * fetched on first use — click no aircraft and it is never downloaded at all.
 *
 * Two ways this can be wrong, both of which the panel says out loud:
 *
 * - **A designator can be reassigned.** The table is community-maintained and
 *   carries defunct airlines; where a code has been reused, the name shown may
 *   be the old holder.
 * - **Not every callsign is a flight number.** General aviation flies under a
 *   registration, and military and government aircraft use their own schemes.
 *   The decode rule below refuses those rather than guessing at them.
 */

import { useEffect, useState } from 'react';

/** ICAO designator to airline name. */
export type AirlineTable = Record<string, string>;

/** Where the build step writes the table. */
export const AIRLINE_TABLE_URL = '/data/airlines.json';

/**
 * The ICAO designator at the front of a callsign, or null.
 *
 * The rule is three letters followed immediately by a digit, and it is
 * deliberately strict, because the failure it prevents is confident and
 * invisible: a registration decoded as an airline puts a real company's name
 * on somebody's private aeroplane.
 *
 * - `THA932`, `UAL1`, `BAW22F` decode. A flight number always begins with a
 *   digit, so the digit is what separates a designator from three letters that
 *   merely start a registration.
 * - `N466WN`, `ZSABC`, `VHXYZ` do not: no digit in the fourth place.
 * - `D-ABCD`, `OY-JJU` do not: a hyphen is never part of a designator, and
 *   feeds vary in whether they strip it.
 * - An empty or whitespace-only callsign does not. OpenSky pads to eight
 *   characters, so trimming comes first.
 */
export function airlineCodeFromCallsign(callsign: string | null | undefined): string | null {
  if (!callsign) return null;
  const trimmed = callsign.trim().toUpperCase();
  const match = /^([A-Z]{3})[0-9]/.exec(trimmed);
  return match ? match[1] : null;
}

export interface Airline {
  code: string;
  name: string;
}

/**
 * The airline for an object's label, or null when there is nothing to say.
 *
 * `label` falls back to the object's id when upstream has no callsign, and an
 * ICAO24 address is six hex characters — so `abc123` would sail through the
 * decode rule above and could name an airline for an aircraft whose callsign
 * we never received. Passing the id in and refusing when the two are equal is
 * the guard; a hex address that happens to look like a flight number is not a
 * hypothetical, it is a third of the address space.
 */
export function airlineFor(
  label: string | null | undefined,
  id: string,
  table: AirlineTable | null,
): Airline | null {
  if (!table || !label) return null;
  if (label.trim().toLowerCase() === id.trim().toLowerCase()) return null;

  const code = airlineCodeFromCallsign(label);
  if (!code) return null;

  const name = table[code];
  return name ? { code, name } : null;
}

// ---- loading ---------------------------------------------------------------

let pending: Promise<AirlineTable | null> | null = null;
let loaded: AirlineTable | null = null;

/**
 * Fetch the table once, on first use, and remember the result.
 *
 * A failure resolves to null rather than rejecting: an aircraft without its
 * airline name is an aircraft, while a detail panel that throws because a
 * static file is missing is a broken app. Same rule as the geography layers
 * and as the aircraft feed itself (D29).
 */
export function loadAirlineTable(
  fetchTable: () => Promise<AirlineTable> = defaultFetch,
): Promise<AirlineTable | null> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = fetchTable()
      .then((table) => {
        loaded = table;
        return table;
      })
      .catch((error) => {
        console.warn('[airlines] table unavailable', error);
        // Cleared so a later selection can try again -- the file is static, so
        // a failure is far more likely to be a cold start than a real absence.
        pending = null;
        return null;
      });
  }
  return pending;
}

async function defaultFetch(): Promise<AirlineTable> {
  const response = await fetch(AIRLINE_TABLE_URL);
  if (!response.ok) throw new Error(`${AIRLINE_TABLE_URL}: HTTP ${response.status}`);
  return (await response.json()) as AirlineTable;
}

/** Test seam: forget the cached table and any in-flight request. */
export function resetAirlineTable(): void {
  pending = null;
  loaded = null;
}

/**
 * The airline for a selected object, loading the table if this is the first
 * time anyone has asked.
 *
 * Returns null until the table arrives, so the panel renders immediately and
 * gains the row a moment later rather than waiting on a fetch to show an
 * altitude it already has.
 */
export function useAirline(label: string | null | undefined, id: string | null): Airline | null {
  const [table, setTable] = useState<AirlineTable | null>(loaded);

  useEffect(() => {
    if (!id || table) return undefined;
    let active = true;
    void loadAirlineTable().then((next) => {
      if (active && next) setTable(next);
    });
    return () => {
      active = false;
    };
  }, [id, table]);

  if (!id) return null;
  return airlineFor(label, id, table);
}
