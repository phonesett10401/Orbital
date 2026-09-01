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
  | 'satellite'
  | 'unidentified';

/** Human wording for the key and the detail panel. */
export const FAMILY_LABEL: Record<SatelliteFamily, string> = {
  station: 'Crewed station',
  constellation: 'Communications constellation',
  navigation: 'Navigation',
  observation: 'Earth observation / weather',
  geoComms: 'Geostationary communications',
  probe: 'Science mission',
  satellite: 'Satellite',
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
 * **Two different unknowns, and conflating them was a real defect.** The first
 * version returned `unidentified` for anything that did not match a pattern,
 * which on the live catalogue meant **1,008 of 1,432 objects - 70%** were
 * labelled "Unidentified object". CUBEBUG 1, NEMO-HD, METEOR M2-2, ES'HAIL 2
 * and ALSAT 1N are all perfectly well identified: they have names, catalogue
 * numbers and missions. What they lack is an entry in *our* pattern list,
 * which is a fact about this code and not about the spacecraft.
 *
 * So there are two outcomes for a name we cannot place:
 *
 * - `unidentified` - the **catalogue** does not know what it is. `OBJECT AN`,
 *   `TBA`, `UNKNOWN`. Drawing a machine here would invent one.
 * - `satellite` - it is a named satellite whose family we have not recognised.
 *   A generic spacecraft silhouette is honest: we know it is a satellite, we
 *   just do not know which kind.
 *
 * The pattern list will always be partial - there are tens of thousands of
 * names and no authority publishing a family for them - so `satellite` is the
 * normal case rather than a failure, and it should look like one.
 */
export function familyFor(name: string | null | undefined): SatelliteFamily {
  if (!name) return 'unidentified';
  const upper = name.toUpperCase().trim();
  // The catalogue's own way of saying it does not know. These beat every
  // pattern below: debris from a Starlink launch is catalogued as an OBJECT
  // and is not a Starlink.
  const UNNAMED = ['OBJECT', 'TBA', 'UNKNOWN'];
  if (UNNAMED.some((word) => upper === word || upper.startsWith(word + ' ')))
    return 'unidentified';
  for (const [family, pattern] of PATTERNS) {
    if (pattern.test(upper)) return family;
  }
  return 'satellite';
}
