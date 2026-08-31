/**
 * What shape an aircraft is, as distinct from how big.
 *
 * `wingspan.ts` answers "how large should this be drawn". This answers "and
 * what does it look like" - the proportions the generated airframe is built
 * to, so a widebody reads as a widebody rather than as an enlarged A320.
 *
 * ## Why proportions, not models
 *
 * `airframe.ts` says a glTF loader does not earn its place for one generic
 * airframe, and that is still true. What earns its place is *parameterising*
 * the airframe already generated in code: three numbers turn one shape into a
 * recognisable family of them, with no asset, no loader and no licence.
 *
 * ## The three that matter at this size
 *
 * **Engine count** is the most recognisable feature an aeroplane has from
 * above. Four engines means an A380, a 747 or an A340, and nothing else in
 * civil aviation - drawing them with two is the single most visible way the
 * old model was wrong.
 *
 * **Length against span** varies far more than intuition suggests: a regional
 * jet is 1.39 fuselage lengths per span and an A380 is 0.91. Long and
 * narrow-winged versus short and broad-winged is most of what tells a CRJ from
 * a widebody in plan view.
 *
 * **Fuselage width against span** is the counterintuitive one, and it is why
 * this table holds measurements rather than impressions. A "widebody" has a
 * *relatively thinner* tube than a narrowbody: an A320 is 0.110 fuselage
 * diameters per metre of span, an A380 only 0.089. The A380's tube is nearly
 * twice as wide in metres and its wings are more than twice as long.
 *
 * Dimensions are manufacturer figures in metres.
 */

import { wingspanFor } from './wingspan';

export interface AirframeShape {
  /** Fuselage length as a multiple of wingspan. */
  lengthRatio: number;
  /** Fuselage diameter as a multiple of wingspan. */
  fuselageRatio: number;
  /** 2 or 4. Nothing in this table has one, three, or more than four. */
  engines: number;
  /**
   * 0 for a straight wing, 1 for a fully swept one.
   *
   * A light aircraft's wing is straight and high-aspect; a jet's is swept.
   * Drawn with the same sweep, a Cessna reads as a tiny airliner.
   */
  sweep: number;
}

/** Length and fuselage diameter in metres, by ICAO type designator. */
const DIMENSIONS: Record<string, [length: number, diameter: number, engines: number]> = {
  A388: [72.7, 7.14, 4],
  B748: [76.3, 6.5, 4], B744: [70.7, 6.5, 4],
  B742: [70.7, 6.5, 4], B743: [70.7, 6.5, 4],
  A343: [63.7, 5.64, 4], A346: [75.4, 5.64, 4], A342: [59.4, 5.64, 4],
  B77W: [73.9, 6.2, 2], B77L: [63.7, 6.2, 2], B772: [63.7, 6.2, 2], B773: [73.9, 6.2, 2],
  A359: [66.8, 5.96, 2], A35K: [73.8, 5.96, 2],
  B789: [62.8, 5.77, 2], B788: [56.7, 5.77, 2], B78X: [68.3, 5.77, 2],
  A339: [63.7, 5.64, 2], A338: [58.8, 5.64, 2],
  A333: [63.7, 5.64, 2], A332: [58.8, 5.64, 2],
  MD11: [61.6, 6.02, 2],
  B763: [54.9, 5.03, 2], B762: [48.5, 5.03, 2], B764: [61.4, 5.03, 2],
  B752: [47.3, 3.76, 2], B753: [54.4, 3.76, 2],
  A321: [44.5, 3.95, 2], A320: [37.6, 3.95, 2], A319: [33.8, 3.95, 2], A318: [31.4, 3.95, 2],
  A21N: [44.5, 3.95, 2], A20N: [37.6, 3.95, 2], A19N: [33.8, 3.95, 2],
  B738: [39.5, 3.76, 2], B737: [33.6, 3.76, 2], B739: [42.1, 3.76, 2], B73H: [39.5, 3.76, 2],
  B38M: [39.5, 3.76, 2], B39M: [42.2, 3.76, 2], B37M: [35.6, 3.76, 2],
  E190: [36.2, 3.0, 2], E195: [38.7, 3.0, 2], E170: [29.9, 3.0, 2], E175: [31.7, 3.0, 2],
  E75L: [31.7, 3.0, 2], E290: [36.2, 3.0, 2], E295: [38.7, 3.0, 2],
  CRJ9: [36.4, 2.69, 2], CRJ7: [32.3, 2.69, 2], CRJ2: [26.8, 2.69, 2],
  AT76: [27.2, 2.87, 2], AT75: [27.2, 2.87, 2], AT72: [27.2, 2.87, 2],
  AT45: [22.7, 2.87, 2], AT43: [22.7, 2.87, 2],
  DH8D: [32.8, 2.69, 2], DH8C: [25.7, 2.69, 2], DH8B: [22.3, 2.69, 2], DH8A: [22.3, 2.69, 2],
  C172: [8.28, 1.0, 2], C152: [7.34, 1.0, 2], PA28: [7.25, 1.1, 2],
  SR22: [7.92, 1.24, 2], C208: [11.5, 1.6, 2], PC12: [14.4, 1.7, 2],
  BE20: [13.3, 1.4, 2], C56X: [14.9, 1.7, 2], GLF6: [30.4, 2.6, 2], CL60: [20.9, 2.7, 2],
};

/** Types whose wing is essentially straight rather than swept. */
const STRAIGHT_WING = /^(C1|C2|PA|SR|DA|BE|AT|DH|P1|PC)/;

/** The shape the generic airframe is authored as, and the fallback. */
export const DEFAULT_SHAPE: AirframeShape = {
  lengthRatio: 1.05,
  fuselageRatio: 0.105,
  engines: 2,
  sweep: 1,
};

/**
 * The proportions for a type designator, or the generic airframe.
 *
 * Falls back rather than guessing: a type we have a wingspan for but no
 * dimensions for is drawn in the default proportions, which is honest - we
 * know how big it is and not what shape it is.
 */
export function shapeFor(model: string | null | undefined): AirframeShape {
  if (!model) return DEFAULT_SHAPE;
  const code = model.trim().toUpperCase();
  const dimensions = DIMENSIONS[code];
  const span = wingspanFor(code);
  if (!dimensions || span === null) {
    return code && STRAIGHT_WING.test(code)
      ? { ...DEFAULT_SHAPE, sweep: 0 }
      : DEFAULT_SHAPE;
  }

  const [length, diameter, engines] = dimensions;
  return {
    lengthRatio: Number((length / span).toFixed(3)),
    fuselageRatio: Number((diameter / span).toFixed(4)),
    engines,
    sweep: STRAIGHT_WING.test(code) ? 0 : 1,
  };
}
