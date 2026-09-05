/**
 * The scrubber that moves the sky off the present, and says so.
 *
 * Shown for satellites only. Their positions are computed, so any instant
 * inside the elements' window costs the same arithmetic as now; an aircraft
 * position is observed and there is nothing to evaluate at another time
 * (D119).
 *
 * **The loud part is not the slider, it is the banner.** Everything in this
 * app that shows a position also says how old it is - the aircraft panel, the
 * status bar, the element age on every satellite. A rewound map that still
 * looked live would be the most confident lie in the project, so leaving live
 * changes the chrome before it changes anything else.
 */

import { useOrbitalStore } from '../state/store';
import {
  OFFSET_MAX,
  OFFSET_MIN,
  clampInstant,
  describeOffset,
  formatInstant,
} from '../timeTravel';

export function TimeControl() {
  const layer = useOrbitalStore((s) => s.activeLayer);
  const viewInstant = useOrbitalStore((s) => s.viewInstant);
  const setViewInstant = useOrbitalStore((s) => s.setViewInstant);

  // Aircraft cannot answer for another time, so the control does not exist
  // there rather than existing and refusing.
  if (layer.id !== 'satellite') return null;

  const now = Date.now();
  const offsetMinutes = viewInstant === null ? 0 : Math.round((viewInstant - now) / 60000);

  const onScrub = (minutes: number) => {
    if (minutes === 0) {
      setViewInstant(null);
      return;
    }
    setViewInstant(clampInstant(now + minutes * 60000, now));
  };

  const live = viewInstant === null;

  return (
    <div className={`timectl ${live ? '' : 'timectl--rewound'}`}>
      <div className="timectl__row">
        <span className="timectl__label">
          {live ? 'Live' : describeOffset(viewInstant, now)}
        </span>
        {!live && (
          <button
            className="timectl__live"
            onClick={() => setViewInstant(null)}
            type="button"
          >
            Return to live
          </button>
        )}
      </div>

      <input
        className="timectl__slider"
        type="range"
        min={OFFSET_MIN}
        max={OFFSET_MAX}
        step={5}
        value={offsetMinutes}
        onChange={(e) => onScrub(Number(e.target.value))}
        aria-label="Time to show the sky at"
        aria-valuetext={live ? 'Live' : formatInstant(viewInstant)}
      />

      <div className="timectl__scale">
        <span>7 days ago</span>
        <span>now</span>
        <span>7 days ahead</span>
      </div>

      {!live && (
        <div className="timectl__stamp">
          {formatInstant(viewInstant)}
          {/*
            Not a caveat to bury. Positions here are propagated from the
            elements we hold, which is why the window is seven days wide: SGP4
            drifts about a kilometre a day from epoch.
          */}
          <span className="timectl__note">computed, not recorded</span>
        </div>
      )}
    </div>
  );
}
