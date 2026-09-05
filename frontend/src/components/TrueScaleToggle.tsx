/**
 * Show the bodies at their true size relative to each other (D137).
 *
 * The scene compresses body sizes so the small ones are visible at all - from
 * Earth the Sun is drawn 4.5 times Earth's size rather than 109. That is a
 * defensible trade and it is also a claim the reader has to take on trust.
 *
 * This is how they check it. Turning it on swaps the compressed ratio for the
 * real one, so the Sun swells to its actual 109 and the inner planets shrink to
 * the specks they are. It is unusable as a default and that is the point: the
 * discomfort of looking at it is the argument for the compression.
 *
 * **Distances are unaffected in both modes**, and the label says so, because
 * "true scale" would otherwise be read as a claim about the whole picture.
 * There is no setting at which distance can be true here: Neptune's orbit is
 * 706,076 globe radii against a far plane one radius past the centre (D129).
 */

import { useOrbitalStore } from '../state/store';

export function TrueScaleToggle() {
  const trueScale = useOrbitalStore((s) => s.trueScale);
  const setTrueScale = useOrbitalStore((s) => s.setTrueScale);

  return (
    <button
      type="button"
      className={`truescale ${trueScale ? 'is-active' : ''}`}
      aria-pressed={trueScale}
      onClick={() => setTrueScale(!trueScale)}
      title={
        trueScale
          ? 'Bodies are at their true size relative to each other. Distances are still compressed.'
          : 'Body sizes are compressed so the small ones stay visible. Turn on to see the real ratios.'
      }
    >
      True size
    </button>
  );
}
