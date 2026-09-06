/**
 * What kind of vessel a ship is, and what colour that makes it.
 *
 * Shared rather than living with the sprites, for the same reason
 * `satelliteFamily.ts` is shared: *which kind this is* is a fact about the
 * object, while *how to draw it* belongs to a renderer.
 *
 * Unlike satellites, nothing has to be inferred here. A satellite's kind is
 * guessed from its name because the catalogue's type field says `PAY` for
 * everything (D94); a ship transmits its own type code and the backend has
 * already read it into a word (D165). So this maps a word to a family, and a
 * word it does not know falls through to `other` rather than being guessed at.
 *
 * ## Why kind and not speed
 *
 * The aircraft layer colours by altitude and the satellite layer by orbit,
 * because on those layers height is the thing that varies and the thing a
 * reader wants. Neither works here. Every ship is at sea level, so altitude is
 * a constant; and **four fifths of them are not moving** (D165), so a speed
 * ramp would paint most of the map one colour and say nothing. What actually
 * varies, and what a reader of a sea chart wants, is what the vessel is.
 */

export type ShipKind =
  | 'cargo'
  | 'tanker'
  | 'passenger'
  | 'service'
  | 'fishing'
  | 'official'
  | 'pleasure'
  | 'other';

/** Human wording for the key and the detail panel. */
export const KIND_LABEL: Record<ShipKind, string> = {
  cargo: 'Cargo',
  tanker: 'Tanker',
  passenger: 'Passenger and ferry',
  service: 'Tug, pilot and port service',
  fishing: 'Fishing',
  official: 'Naval, patrol and rescue',
  pleasure: 'Sailing and pleasure craft',
  other: 'Other or unreported',
};

/**
 * Colours, chosen to survive a dark sea and to be told apart by someone who is
 * not comparing them side by side.
 *
 * Amber for tankers and red for the official vessels because those are the two
 * a reader is most likely to be looking *for*; grey for `other` because it
 * should recede rather than compete, and it is 13% of the feed.
 */
export const KIND_COLOUR: Record<ShipKind, string> = {
  cargo: 'rgb(96, 165, 250)',
  tanker: 'rgb(251, 146, 60)',
  passenger: 'rgb(52, 211, 153)',
  service: 'rgb(250, 204, 21)',
  fishing: 'rgb(45, 212, 191)',
  official: 'rgb(248, 113, 113)',
  pleasure: 'rgb(196, 181, 253)',
  other: 'rgb(148, 163, 184)',
};

/**
 * The backend's word for a vessel type, to a family.
 *
 * The keys are exactly the strings `digitraffic.py` produces, and that
 * coupling is the point: it is a contract between two files that a test
 * asserts, rather than a regular expression hoping to catch whatever arrives.
 */
const KIND_BY_WORD: Record<string, ShipKind> = {
  Cargo: 'cargo',
  Tanker: 'tanker',
  Passenger: 'passenger',
  'High speed craft': 'passenger',
  'Wing in ground': 'passenger',
  Tug: 'service',
  Towing: 'service',
  'Towing (long)': 'service',
  'Pilot vessel': 'service',
  'Port tender': 'service',
  Dredger: 'service',
  'Diving support': 'service',
  'Anti-pollution': 'service',
  Fishing: 'fishing',
  Military: 'official',
  'Law enforcement': 'official',
  'Search and rescue': 'official',
  'Medical transport': 'official',
  Sailing: 'pleasure',
  'Pleasure craft': 'pleasure',
  Other: 'other',
  'Special craft': 'other',
};

/**
 * Every word this map knows, for the test that pins it to the backend's.
 *
 * Exported so the contract can be asserted from one place rather than by
 * restating the map's keys in a test, which would pass by construction.
 */
export const KIND_BY_WORD_KEYS: readonly string[] = Object.keys(KIND_BY_WORD);

/** Which family a vessel belongs to. `null` and anything unknown are `other`. */
export function shipKind(model: string | null | undefined): ShipKind {
  if (!model) return 'other';
  return KIND_BY_WORD[model] ?? 'other';
}

/** The colour to draw a vessel of this type. */
export function shipColour(model: string | null | undefined): string {
  return KIND_COLOUR[shipKind(model)];
}

/**
 * The order the key lists them, commonest first.
 *
 * Measured on the live feed: cargo 247, passenger 136, tanker 107, tug 89,
 * pilot 63, other 60. Listing them in that order means the first three
 * swatches account for most of what is on screen.
 */
export const KIND_ORDER: ShipKind[] = [
  'cargo',
  'passenger',
  'tanker',
  'service',
  'fishing',
  'official',
  'pleasure',
  'other',
];
