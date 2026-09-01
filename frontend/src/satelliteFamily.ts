/**
 * What kind of spacecraft a satellite is, from its name.
 *
 * Shared rather than living with the sprites, for the same reason `wingspan.ts`
 * is shared and `airframe.ts` is not: *which family this is* is a fact about
 * the object, while *how to draw it* belongs to a renderer. A component that
 * needs the former should not have to import from `src/planet`.
 *
 * The name is the only thing to go on. `model` is null for every satellite by
 * decision (D94) - the catalogue's own type field reads `PAY` for everything
 * we draw, so it carries no information.
 */

export type SatelliteFamily =
  | 'station'
  | 'constellation'
  | 'navigation'
  | 'observation'
  | 'geoComms'
  | 'probe'
  | 'unidentified';

/** Human wording for the key and the detail panel. */
export const FAMILY_LABEL: Record<SatelliteFamily, string> = {
  station: 'Crewed station',
  constellation: 'Communications constellation',
  navigation: 'Navigation',
  observation: 'Earth observation / weather',
  geoComms: 'Geostationary communications',
  probe: 'Science mission',
  unidentified: 'Unidentified object',
};

/**
 * Name patterns, most specific first.
 *
 * Matched on the name because that is what the catalogue gives. Deliberately
 * conservative: a name that is not clearly one of these falls through to
 * `unidentified` rather than being guessed at.
 */
const PATTERNS: Array<[SatelliteFamily, RegExp]> = [
  ['station', /\b(ISS|ZARYA|TIANGONG|CSS \(|MIR)\b/],
  [
    'constellation',
    /\b(STARLINK|IRIDIUM|ONEWEB|KUIPER|GLOBALSTAR|ORBCOMM|SPIRE|PLANET|FLOCK|LEMUR)\b/,
  ],
  ['navigation', /\b(GPS|NAVSTAR|GALILEO|GLONASS|BEIDOU|COMPASS|QZS|IRNSS|NAVIC)\b/],
  [
    'observation',
    /\b(NOAA|METOP|FENGYUN|CBERS|GAOFEN|LANDSAT|SENTINEL|TERRA|AQUA|SUOMI|JPSS|SPOT|WORLDVIEW|RESOURCESAT|CARTOSAT|SINOD|PROBA|ICEYE)\b/,
  ],
  [
    'geoComms',
    /\b(INMARSAT|INTELSAT|EUTELSAT|RADUGA|ASTRA|ANIK|GOES|SES|THURAYA|ECHOSTAR|GALAXY|TDRS|MEASAT|THAICOM|APSTAR|CHINASAT)\b/,
  ],
  ['probe', /\b(CLUSTER|THEMIS|SWARM|MMS|GEOTAIL|WIND|ACE|SOHO|IBEX)\b/],
];

/**
 * Which family a satellite name belongs to.
 *
 * `OBJECT xx` and anything unmatched are `unidentified` — see the note at the
 * top of this file about why that matters.
 */
export function familyFor(name: string | null | undefined): SatelliteFamily {
  if (!name) return 'unidentified';
  const upper = name.toUpperCase();
  // Explicitly unidentified in the catalogue, whatever else the string
  // happens to contain.
  if (/^\s*OBJECT\b/.test(upper)) return 'unidentified';
  for (const [family, pattern] of PATTERNS) {
    if (pattern.test(upper)) return family;
  }
  return 'unidentified';
}
