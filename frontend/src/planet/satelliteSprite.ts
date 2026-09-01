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
export const ICON_SATELLITE = 'orbital-sat-generic';
export const ICON_UNIDENTIFIED = 'orbital-sat-unidentified';

/** Family -> the image id its silhouette is registered under. */
export const FAMILY_ICON: Record<SatelliteFamily, string> = {
  station: ICON_STATION,
  constellation: ICON_CONSTELLATION,
  navigation: ICON_NAVIGATION,
  observation: ICON_OBSERVATION,
  geoComms: ICON_GEO_COMMS,
  probe: ICON_PROBE,
  satellite: ICON_SATELLITE,
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

/**
 * Shapes are drawn **bold on purpose**, and the first version was not.
 *
 * MapLibre renders these as SDF icons so `icon-color` can tint each one by its
 * orbit regime. An SDF shader treats the alpha channel as a *distance field*,
 * and what it is handed here is a plain mask — which works for a solid
 * silhouette and destroys fine detail. The first attempt had a 10 px truss and
 * 4 px slots inside the solar panels, and at the ~25 px these actually render
 * at, every one of them blurred into an identical grey rectangle.
 *
 * So: no element thinner than about a tenth of the cell, no interior cut-outs,
 * and at least 10 px between parts. What has to survive the downscale is the
 * *arrangement* — how many panels, which side, is there a dish — because that
 * is what tells the families apart.
 */
const DRAW: Record<SatelliteFamily, (ctx: Ctx) => void> = {
  // A long truss with a panel block at each end. The widest silhouette, for
  // the largest thing in orbit.
  station(ctx) {
    ctx.fillRect(C - 50, C - 9, 100, 18);
    ctx.fillRect(C - 52, C - 34, 30, 68);
    ctx.fillRect(C + 22, C - 34, 30, 68);
  },

  // One panel, off to a side. Starlink's defining asymmetry, and the only
  // lopsided shape in the set.
  constellation(ctx) {
    ctx.fillRect(C - 40, C - 15, 30, 30);
    ctx.fillRect(C - 4, C - 30, 44, 60);
  },

  // A body between two equal panels, plus a mast pointing down at the ground
  // it is transmitting to.
  navigation(ctx) {
    ctx.fillRect(C - 17, C - 22, 34, 34);
    ctx.fillRect(C - 52, C - 18, 28, 26);
    ctx.fillRect(C + 24, C - 18, 28, 26);
    ctx.fillRect(C - 8, C + 14, 16, 26);
  },

  // A tall body, one panel, and a wide instrument across the bottom: these fly
  // nadir-pointing and look at the ground.
  observation(ctx) {
    ctx.fillRect(C - 26, C - 34, 34, 52);
    ctx.fillRect(C + 16, C - 26, 30, 36);
    ctx.fillRect(C - 34, C + 22, 50, 18);
  },

  // Two panels and a dish on top. The dish is the whole difference from
  // navigation, so it is drawn large enough to survive being shrunk.
  geoComms(ctx) {
    ctx.fillRect(C - 17, C - 6, 34, 34);
    ctx.fillRect(C - 52, C - 2, 30, 28);
    ctx.fillRect(C + 22, C - 2, 30, 28);
    ctx.beginPath();
    ctx.arc(C, C - 10, 24, Math.PI, Math.PI * 2);
    ctx.fill();
  },

  // A drum with booms and no panels at all - spin-stabilised and
  // body-mounted, which is why it looks like nothing else here.
  probe(ctx) {
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = C + Math.cos(angle) * 30;
      const y = C + Math.sin(angle) * 30;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(C - 54, C - 7, 108, 14);
  },

  // A named satellite whose family we have not recognised - which is most of
  // the catalogue, and a fact about this code rather than about the object. A
  // plain body with two stubs: unmistakably a spacecraft, committing to
  // nothing about which kind.
  satellite(ctx) {
    ctx.fillRect(C - 20, C - 20, 40, 40);
    ctx.fillRect(C - 44, C - 11, 20, 22);
    ctx.fillRect(C + 24, C - 11, 20, 22);
  },

  // Claims nothing at all. The catalogue does not know what this is.
  unidentified(ctx) {
    ctx.beginPath();
    ctx.arc(C, C, 22, 0, Math.PI * 2);
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
