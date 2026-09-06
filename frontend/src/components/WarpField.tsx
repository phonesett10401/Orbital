/**
 * The light-speed transition between worlds (D155).
 *
 * A canvas over the map, drawing only while a trip is in progress. The geometry
 * is in `warp.ts`, which knows nothing about pixels; this knows nothing about
 * how a streak is shaped.
 *
 * ## It is over the map, not in it
 *
 * A plain 2D canvas rather than a MapLibre custom layer, and that is the whole
 * reason it is safe. A custom layer shares the map's WebGL context and its
 * depth buffer, and the last four sessions of this project are largely about
 * what happens when something is drawn in a frame it does not own. This one
 * cannot disturb a single pixel of the globe: when the trip ends the element is
 * gone, and if it fails it fails alone.
 *
 * It is also why it makes no claim about the sky. `stars.ts` draws the real
 * catalogue and does not move; this is an effect on top, the same kind of
 * statement as a fade.
 *
 * ## Nothing at all under reduced motion
 *
 * Not slower and not fainter. This is a full-screen rush of accelerating light,
 * which is close to the definition of what that preference is set to avoid. The
 * trip still happens, at the same length, with the same camera moves - the
 * reader simply watches it on the map.
 */

import { useEffect, useRef } from 'react';

import { IN_MS, OUT_MS } from '../bodyFlight';
import { journeyMs } from '../journey';
import { prefersReducedMotion } from '../motion';
import { useOrbitalStore } from '../state/store';
import { drawStreaks, makeField } from '../warp';

/** Enough for a field with depth; few enough to cost nothing on a laptop. */
const STAR_COUNT = 260;

export function WarpField() {
  const flyingTo = useOrbitalStore((s) => s.flyingTo);
  // A change of view is a journey too, and gets the same streaks (D161).
  const journey = useOrbitalStore((s) => s.journey);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const still = prefersReducedMotion();

  useEffect(() => {
    if ((!flyingTo && !journey) || still) return undefined;
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return undefined;

    const field = makeField(STAR_COUNT);
    // A trip between worlds and a change of view are different lengths, and
    // running the shorter one on the longer one's clock would leave the streaks
    // barely started when it ends (D161).
    const total = flyingTo ? OUT_MS + IN_MS : journeyMs(false);
    // Where the thing being covered actually happens, as a fraction of the run.
    // Read from the constants each is built from rather than restated, so the
    // loudest frame cannot drift away from the one with something to hide: the
    // apex for a trip, and the middle for a view change, whose camera move runs
    // from the start.
    const apex = flyingTo ? OUT_MS / total : 0.45;
    const started = performance.now();
    let frame = 0;

    const draw = () => {
      const now = performance.now();
      const progress = Math.min(1, (now - started) / total);

      // Sized here rather than on mount: a window resized mid-trip would
      // otherwise stretch the field, and this costs two property writes.
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (element.width !== width * ratio || element.height !== height * ratio) {
        element.width = width * ratio;
        element.height = height * ratio;
      }

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      drawStreaks(context, field, progress, apex, width, height);

      if (progress < 1) frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [flyingTo, journey, still]);

  // Absent rather than transparent when nothing is happening: an empty canvas
  // the size of the window is a compositing layer the browser keeps for no
  // reason.
  if ((!flyingTo && !journey) || still) return null;

  return <canvas ref={canvas} className="warp" aria-hidden="true" />;
}
