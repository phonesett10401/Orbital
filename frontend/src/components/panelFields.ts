/**
 * Which `meta` entries still need a row of their own.
 *
 * `meta` is rendered generically so a provider can add a field without a
 * frontend change (D4), and that is worth keeping. But some of its keys are
 * *also* shown deliberately: registration and aircraft type get proper labelled
 * rows, and `headingSource` / `velocitySource` are printed as "from its track"
 * beside the number they qualify (D80, D81).
 *
 * Rendered twice, they read as two different facts. The panel was showing
 * "Registration JA866J" and then "Registration JA866J" again four rows later,
 * which looks like a data problem rather than a display one.
 *
 * A key is listed here **only if the panel renders it somewhere else**. Adding
 * one to hide it would be the wrong use of this list: an unrecognised field
 * appearing as a plain row is the generic renderer working as intended.
 */
const SHOWN_ELSEWHERE = new Set([
  // Their own labelled rows, above.
  'registration',
  'aircraftType',
  'aircraftDescription',
  // Annotations on the value they describe, not facts in their own right.
  'headingSource',
  'velocitySource',
]);

export function generalMetaRows(meta: Record<string, string>): [string, string][] {
  return Object.entries(meta).filter(([key]) => !SHOWN_ELSEWHERE.has(key));
}
