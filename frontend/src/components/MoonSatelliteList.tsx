/**
 * The lunar spacecraft, listed in the corner the legend uses on Earth (D136).
 *
 * There are three of them and they are frequently round the far side, where a
 * marker on the globe cannot be clicked because it is genuinely not visible.
 * A list is how you reach one anyway - and it also answers the question the map
 * cannot, which is *what else is up there* when only one is in front of you.
 *
 * The altitude is in the row rather than only in the panel, because it is the
 * number that differs between them and the one that keeps changing.
 */

import { useOrbitalStore } from '../state/store';

export function MoonSatelliteList() {
  const craft = useOrbitalStore((s) => s.moonCraft);
  const selected = useOrbitalStore((s) => s.selectedMoonId);
  const select = useOrbitalStore((s) => s.selectMoonCraft);

  // Nothing at all until a window has been fetched. An empty box titled "In
  // orbit" would claim the Moon is empty, which is a stronger statement than
  // saying nothing while the first request is in flight.
  if (craft.length === 0) return null;

  return (
    <aside className="moonlist" aria-label="Spacecraft in orbit around the Moon">
      <h2 className="moonlist__title">In orbit</h2>
      <ul className="moonlist__items">
        {craft.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              className={`moonlist__item ${one.id === selected ? 'is-active' : ''}`}
              aria-pressed={one.id === selected}
              onClick={() => select(one.id)}
            >
              <span className="moonlist__dot" aria-hidden="true" />
              <span className="moonlist__name">{one.name}</span>
              <span className="moonlist__operator">{one.operator}</span>
              <span className="moonlist__altitude mono">
                {Math.round(one.altitudeKm)} km
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
