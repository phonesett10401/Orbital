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

import { useEffect } from 'react';

import {
  clampToEntitlement,
  scaleLabels,
  travelWindowMs,
  upgradeHint,
} from '../entitlements';
import { useOrbitalStore } from '../state/store';
import { clampInstant, describeOffset, formatInstant } from '../timeTravel';

export function TimeControl() {
  const layer = useOrbitalStore((s) => s.activeLayer);
  const viewInstant = useOrbitalStore((s) => s.viewInstant);
  const setViewInstant = useOrbitalStore((s) => s.setViewInstant);
  const account = useOrbitalStore((s) => s.account);

  // **Signing out has to take the reach back with it.** Rewind six days on a
  // premium account, sign out, and without this the map is left showing an
  // instant the server now refuses - so the sky quietly stops updating and
  // nothing on screen says why. Pulling the instant back to the free window is
  // visible: the label changes and the slider moves (D149).
  //
  // **The dependency list is the whole of the correctness here, and the
  // obvious version of it hangs the browser.** Written with `viewInstant` as a
  // dependency and `Date.now()` in the body, this loops forever: it pulls the
  // instant to exactly `now - window`, that is a new value so the effect runs
  // again, and by then `now` has moved on so the edge it just wrote is already
  // outside. React gets to "Maximum update depth exceeded" in under a second
  // and the page renders nothing at all. Found by signing out, not by testing:
  // every unit test of `clampToEntitlement` passed, because a pure function
  // given a frozen clock cannot exhibit it.
  //
  // So it runs when the *entitlement* changes and reads the instant through
  // the store rather than through a dependency. Drift afterwards is not a
  // problem to solve: polling stops entirely while the map is rewound
  // (`usePolling`), so the one request that matters is made immediately, well
  // inside the grace the backend allows for flight time.
  useEffect(() => {
    const { viewInstant: current, setViewInstant: set } = useOrbitalStore.getState();
    if (current === null) return;
    const now = Date.now();
    if (Math.abs(current - now) <= travelWindowMs(account)) return;
    set(clampToEntitlement(current, now, account));
  }, [account]);

  // Aircraft cannot answer for another time, so the control does not exist
  // there rather than existing and refusing.
  if (layer.id !== 'satellite') return null;

  const now = Date.now();
  const offsetMinutes = viewInstant === null ? 0 : Math.round((viewInstant - now) / 60000);

  // The end stops are what this account may ask for, not what the elements
  // could answer. A slider that ran the full week and then handed back a 403
  // at one end would look like a fault rather than a price.
  const reachMinutes = Math.round(travelWindowMs(account) / 60000);
  const [backLabel, aheadLabel] = scaleLabels(account);
  const hint = upgradeHint(account);

  const onScrub = (minutes: number) => {
    if (minutes === 0) {
      setViewInstant(null);
      return;
    }
    // Both clamps, in this order: the entitlement is the tighter of the two
    // and the accuracy bound is the one that must hold regardless.
    const asked = clampToEntitlement(now + minutes * 60000, now, account);
    setViewInstant(clampInstant(asked, now));
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
        min={-reachMinutes}
        max={reachMinutes}
        step={5}
        value={offsetMinutes}
        onChange={(e) => onScrub(Number(e.target.value))}
        aria-label="Time to show the sky at"
        aria-valuetext={live ? 'Live' : formatInstant(viewInstant)}
      />

      <div className="timectl__scale">
        <span>{backLabel}</span>
        <span>now</span>
        <span>{aheadLabel}</span>
      </div>

      {hint && (
        // Said once, quietly, under the control it applies to - not a banner
        // and not a modal. It names what more would reach rather than what is
        // being withheld, because the free window is a real day either way and
        // not a teaser.
        <p className="timectl__hint">{hint}</p>
      )}

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
