/**
 * How big to draw an aircraft, from what the aircraft actually is.
 *
 * Every aircraft used to be one size, which made an A380 and a Cessna 172
 * identical marks on the map. They differ by a factor of seven in wingspan and
 * by rather more in what they mean: one is four hundred people crossing an
 * ocean, the other is somebody practising circuits.
 *
 * ## Wingspan, not length or weight
 *
 * The silhouette drawn on the map is a plan view, and what a plan view is
 * mostly made of is wing. Wingspan is also the dimension people recognise -
 * "the big one" is the one with long wings - and it is published, stable, and
 * varies enough between types to be worth reading.
 *
 * ## Why a table and not a lookup
 *
 * There is no wingspan in any feed Orbital uses. adsb.lol sends the ICAO type
 * designator (`B789`), OpenSky sends nothing at all, and turning a designator
 * into a dimension needs a table someone wrote. This is that table, kept small
 * on purpose: it holds the types that actually appear over a live map, and
 * falls back by family prefix for everything else, because a designator we
 * have never seen is nearly always a variant of one we have - `B78X` is a 787
 * whether or not it is listed.
 *
 * Measured against a live sample of 2,000 aircraft: **76% carry a type at
 * all.** The rest are OpenSky-only, whose `/states/all` has no type field.
 * Those are drawn at the reference size, which is deliberate - see below.
 */

/**
 * Wingspan in metres, by ICAO type designator.
 *
 * The eight most common types over a live sample were B738, B38M, A320, A20N,
 * A21N, A359, B789 and B788, which is where the detail is concentrated.
 */
const WINGSPAN_M: Record<string, number> = {
  // Very large
  A388: 79.8,
  B748: 68.4, B744: 64.4, B742: 59.6, B743: 59.6,
  // Large twins
  B77W: 64.8, B77L: 64.8, B772: 60.9, B773: 60.9, B77F: 64.8,
  A359: 64.8, A35K: 64.8,
  A343: 63.5, A346: 63.5, A342: 60.3,
  A339: 64.0, A338: 64.0, A333: 60.3, A332: 60.3,
  B789: 60.1, B788: 60.1, B78X: 60.1,
  MD11: 51.7,
  // Medium
  B764: 51.9, B763: 47.6, B762: 47.6,
  B752: 38.1, B753: 38.1,
  // Narrowbodies - the bulk of any live map
  A321: 35.8, A320: 35.8, A319: 35.8, A318: 34.1,
  A21N: 35.8, A20N: 35.8, A19N: 35.8,
  B738: 35.8, B737: 34.3, B739: 35.8, B73H: 35.8, B736: 34.3,
  B38M: 35.9, B39M: 35.9, B37M: 35.9,
  E290: 35.1, E295: 35.1,
  // Regional jets and turboprops
  E190: 28.7, E195: 28.7, E170: 26.0, E175: 26.0, E75L: 26.0, E75S: 26.0,
  CRJ9: 24.9, CRJ7: 23.2, CRJ2: 21.2, CRJX: 24.9,
  AT76: 27.1, AT75: 27.1, AT72: 27.1, AT45: 24.6, AT43: 24.6,
  DH8D: 28.4, DH8C: 25.9, DH8B: 25.9, DH8A: 25.9,
  SF34: 21.4, B462: 26.3, B463: 26.3,
  // Business and general aviation
  GLF6: 28.5, GLF5: 28.5, GLF4: 23.7, CL60: 19.6, CL35: 19.5,
  C56X: 16.3, C25A: 12.4, C25B: 12.4, C25C: 12.4, E55P: 12.5, E50P: 12.5,
  H25B: 14.3, LJ45: 14.6, PC12: 16.3, BE20: 16.6, B350: 17.7,
  C208: 15.9, PA31: 12.4, P180: 14.0,
  C172: 11.0, C182: 11.0, C152: 10.0, PA28: 10.7, SR22: 11.7, SR20: 11.7,
  DA40: 11.9, DA42: 13.4, C42: 9.5,
  // Rotary, by rotor diameter, which is the same thing in plan view
  A139: 13.8, EC45: 11.0, R44: 10.0, S76: 13.4, H60: 16.4,
};

/**
 * Wingspans by family, for a designator not in the table.
 *
 * Longest prefix wins, so `B78` is consulted before `B7`. These are the
 * families, not exact aircraft: a variant we have not listed is far closer to
 * its family than to the reference size.
 */
const FAMILY_M: [string, number][] = [
  ['A38', 79.8], ['B74', 64.4], ['B77', 64.8], ['A35', 64.8],
  ['B78', 60.1], ['A33', 60.3], ['A34', 63.5],
  ['B76', 47.6], ['B75', 38.1],
  ['A32', 35.8], ['A31', 35.8], ['A19', 35.8], ['A20', 35.8], ['A21', 35.8],
  ['B73', 35.8], ['B38', 35.9], ['B39', 35.9], ['B37', 35.9],
  ['E19', 28.7], ['E29', 35.1], ['E17', 26.0], ['E75', 26.0],
  ['CRJ', 23.2], ['AT7', 27.1], ['AT4', 24.6], ['DH8', 27.4],
  ['C17', 11.0], ['C15', 10.0], ['PA2', 10.7],
];

/**
 * The span everything is measured against: an A320 or a 737.
 *
 * Chosen because it is the commonest aircraft in the sky, so the map's
 * overall density of ink barely changes - this makes big things big and small
 * things small rather than making everything bigger.
 */
export const REFERENCE_SPAN_M = 35.8;

/**
 * How far a marker may depart from the reference size.
 *
 * Unclamped, a Cessna would be 0.28x and vanish at low zoom while an A380
 * would be 2.2x and dominate. Neither is useful: the map's job is to show
 * where aircraft are, and a marker too small to see fails at that regardless
 * of how honest its scale is. So the range is compressed - the ordering and
 * the noticeable difference survive, the extremes do not.
 */
export const MIN_SCALE = 0.7;
export const MAX_SCALE = 1.45;

/** The wingspan for a type designator, or null when we cannot say. */
export function wingspanFor(model: string | null | undefined): number | null {
  if (!model) return null;
  const code = model.trim().toUpperCase();
  if (!code) return null;
  if (code in WINGSPAN_M) return WINGSPAN_M[code];

  let best: number | null = null;
  let bestLength = 0;
  for (const [prefix, span] of FAMILY_M) {
    if (code.startsWith(prefix) && prefix.length > bestLength) {
      best = span;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * The icon scale for a type designator. 1 means "the size everything used to
 * be".
 *
 * **An unknown type is drawn at the reference size, not at a special one.**
 * Nearly a quarter of a live map has no type, because OpenSky does not send
 * one, and those aircraft are not unusual - they are ordinary airliners we
 * happen to have heard about from the other feed. Drawing them conspicuously
 * would say something false. Drawing them as the commonest thing in the sky
 * says the one true thing available: we do not know, so here is the default.
 *
 * The scale is the *square root* of the span ratio, not the ratio itself. The
 * icon grows in two dimensions, so its area goes as the square of whatever it
 * is multiplied by; taking the root makes the drawn area proportional to span
 * rather than to span squared, which is what stops an A380 reading as five
 * times an A320 rather than twice it.
 */
export function scaleFor(model: string | null | undefined): number {
  const span = wingspanFor(model);
  if (span === null) return 1;
  const raw = Math.sqrt(span / REFERENCE_SPAN_M);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(raw.toFixed(3))));
}
