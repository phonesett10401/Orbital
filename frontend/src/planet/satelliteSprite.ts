/**
 * Satellite silhouettes, drawn procedurally, one per spacecraft family.
 *
 * A circle says "an object is here" and nothing else. These say **what kind of
 * thing it is** — and the difference is real: a Starlink with its single flat
 * panel, a navigation satellite with a symmetric pair, a station with a truss
 * and four arrays, and a spinning drum with no arrays at all are genuinely
 * different machines, and the shapes are how you tell them apart at a glance.
 *
 * **Shape and colour carry different facts, deliberately.** The silhouette is
 * *what it is*; the colour, applied by `icon-color` from the regime table, is
 * *how high it is* (D99, D100). Two channels, two facts, neither wasted.
 *
 * The family comes from the object's **name**, which is the only thing the
 * catalogue reliably gives us — `model` is null for every satellite by
 * decision (D94), because the catalogue's own type field says `PAY` for
 * everything we draw.
 *
 * ### Why an unrecognised name gets a plain dot
 *
 * The live catalogue is full of entries called `OBJECT AN`, `OBJECT C`,
 * `OBJECT W` — objects that have been tracked but not identified. Drawing one
 * of those as a communications satellite, or as anything with panels and a
 * dish, would be inventing a machine. They keep the neutral marker, which
 * claims only that something is there.
 *
 * This is the same rule the aircraft layers follow when a heading is unknown
 * (D18, D40) and when a satellite is offered to the airframe mesh (D96): a
 * shape that commits to something unknown is worse than one that does not.
 */

import { familyFor, type SatelliteFamily } from '../satelliteFamily';

const CELL = 128;
const C = CELL / 2;

export const ICON_STATION = 'orbital-sat-station';
export const ICON_CONSTELLATION = 'orbital-sat-constellation';
export const ICON_NAVIGATION = 'orbital-sat-navigation';
export const ICON_OBSERVATION = 'orbital-sat-observation';
export const ICON_GEO_COMMS = 'orbital-sat-geocomms';
export const ICON_PROBE = 'orbital-sat-probe';
export const ICON_UNIDENTIFIED = 'orbital-sat-unidentified';

/** Family -> the image id its silhouette is registered under. */
export const FAMILY_ICON: Record<SatelliteFamily, string> = {
  station: ICON_STATION,
  constellation: ICON_CONSTELLATION,
  navigation: ICON_NAVIGATION,
  observation: ICON_OBSERVATION,
  geoComms: ICON_GEO_COMMS,
  probe: ICON_PROBE,
  unidentified: ICON_UNIDENTIFIED,
};

export function iconFor(name: string | null | undefined): string {
  return FAMILY_ICON[familyFor(name)];
}

// ---- drawing ---------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

function blank(): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for the satellite sprites');
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { canvas, ctx };
}

/** A solar array: a bar with a slot down the middle so it reads as a panel. */
function panel(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  if (w > h) {
    ctx.fillRect(x + 2, y + h / 2 - 2, w - 4, 4);
  } else {
    ctx.fillRect(x + w / 2 - 2, y + 2, 4, h - 4);
  }
  ctx.restore();
}

/**
 * Each shape is drawn to read at about 14 px, which is the size these are
 * actually rendered at. That rules out detail: what survives the downscale is
 * the *arrangement* — how many arrays, which side, and whether there is a dish
 * — so each family differs in silhouette rather than in ornament.
 */
const DRAW: Record<SatelliteFamily, (ctx: Ctx) => void> = {
  // A truss with four arrays. The most complex outline, for the largest thing
  // in orbit, and the only family where the panels are paired along an axis.
  station(ctx) {
    ctx.fillRect(C - 46, C - 5, 92, 10); // truss
    ctx.fillRect(C - 10, C - 16, 20, 32); // modules
    panel(ctx, C - 44, C - 30, 26, 20);
    panel(ctx, C - 44, C + 10, 26, 20);
    panel(ctx, C + 18, C - 30, 26, 20);
    panel(ctx, C + 18, C + 10, 26, 20);
  },

  // One flat array off to a side. Starlink's defining feature, and the only
  // asymmetric silhouette in the set.
  constellation(ctx) {
    ctx.fillRect(C - 34, C - 12, 24, 24); // bus
    panel(ctx, C - 6, C - 22, 46, 44);
  },

  // Symmetric pair plus a mast. Navigation satellites are built to point an
  // antenna at the whole hemisphere below them.
  navigation(ctx) {
    ctx.fillRect(C - 13, C - 13, 26, 26);
    panel(ctx, C - 46, C - 15, 30, 30);
    panel(ctx, C + 16, C - 15, 30, 30);
    ctx.fillRect(C - 3, C + 13, 6, 18); // nadir mast
  },

  // Body, one array, and an instrument looking down. Weather and imaging
  // satellites fly nadir-pointing in low orbit.
  observation(ctx) {
    ctx.fillRect(C - 16, C - 20, 30, 40); // bus
    panel(ctx, C + 16, C - 18, 30, 36);
    ctx.beginPath(); // instrument
    ctx.arc(C - 1, C + 27, 9, 0, Math.PI * 2);
    ctx.fill();
  },

  // Two arrays and a dish. The dish is what separates it from navigation, and
  // it is the shape that belongs at geostationary altitude.
  geoComms(ctx) {
    ctx.fillRect(C - 14, C - 8, 28, 30);
    panel(ctx, C - 48, C - 4, 32, 26);
    panel(ctx, C + 16, C - 4, 32, 26);
    ctx.beginPath(); // dish
    ctx.arc(C, C - 20, 15, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(C - 3, C - 20, 6, 14);
  },

  // A spinning drum with no arrays at all. Cluster II and its siblings are
  // spin-stabilised and body-mounted, which is why they look like nothing else.
  probe(ctx) {
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = C + Math.cos(angle) * 24;
      const y = C + Math.sin(angle) * 24;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 6; // booms
    ctx.beginPath();
    ctx.moveTo(C - 44, C);
    ctx.lineTo(C + 44, C);
    ctx.stroke();
  },

  // Claims nothing. A tracked object nobody has identified gets a marker, not
  // a machine.
  unidentified(ctx) {
    ctx.beginPath();
    ctx.arc(C, C, 20, 0, Math.PI * 2);
    ctx.fill();
  },
};

/** Every sprite, as `[imageId, canvas]`, ready for `map.addImage(..., {sdf:true})`. */
export function createSatelliteIconCanvases(): Array<[string, HTMLCanvasElement]> {
  return (Object.keys(DRAW) as SatelliteFamily[]).map((family) => {
    const { canvas, ctx } = blank();
    DRAW[family](ctx);
    return [FAMILY_ICON[family], canvas];
  });
}
