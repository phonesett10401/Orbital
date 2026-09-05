/**
 * Details of the selected lunar spacecraft (D135).
 *
 * A separate panel from `DetailPanel` rather than a branch inside it, because
 * almost nothing they show is the same. That panel is built around a fetched
 * detail record, a data age, a decoded airline, an observed track and a
 * scheduled route; a lunar craft has none of those, and has one thing none of
 * them do - a position published in advance rather than observed.
 *
 * Every judgement about *what to say* lives in `moonFacts`, where it can be
 * tested; this decides only where it goes on screen.
 */

import { useOrbitalStore } from '../state/store';
import {
  LOST_NOTE,
  SOURCE_NOTE,
  SUB_POINT_NOTE,
  moonRows,
  panelState,
} from './moonFacts';

export function MoonPanel() {
  const selectedMoonId = useOrbitalStore((s) => s.selectedMoonId);
  const craft = useOrbitalStore((s) => s.moonCraft);
  const select = useOrbitalStore((s) => s.selectMoonCraft);

  const state = panelState(selectedMoonId, craft);
  if (state.kind === 'closed') return null;

  const close = (
    <button className="panel__close" onClick={() => select(null)} aria-label="Close">
      &times;
    </button>
  );

  if (state.kind === 'lost') {
    return (
      <aside className="panel panel--moon" aria-live="polite">
        <div className="panel__header">
          <h2 className="panel__title">No longer tracked</h2>
          {close}
        </div>
        <p className="panel__note">{LOST_NOTE}</p>
      </aside>
    );
  }

  return (
    <aside className="panel panel--moon" aria-live="polite">
      <div className="panel__header">
        <h2 className="panel__title">{state.craft.name}</h2>
        {close}
      </div>

      <p className="panel__subtitle">{state.craft.operator}</p>
      <p className="panel__note">{state.craft.purpose}</p>

      <dl className="panel__fields">
        {moonRows(state.craft).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="panel__note">{SUB_POINT_NOTE}</p>
      <p className="panel__note">{SOURCE_NOTE}</p>
    </aside>
  );
}
