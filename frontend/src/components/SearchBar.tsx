/**
 * Search by callsign or identifier.
 *
 * Queries the backend rather than filtering what is on screen: the client only
 * holds what is in its viewport, and looking up a flight by callsign has to
 * work for one on the other side of the world.
 */

import { useOrbitalStore } from '../state/store';
import type { TrackedObject } from '../types';

export function SearchBar() {
  const query = useOrbitalStore((s) => s.searchQuery);
  const results = useOrbitalStore((s) => s.searchResults);
  const searching = useOrbitalStore((s) => s.searching);
  const setSearchQuery = useOrbitalStore((s) => s.setSearchQuery);
  const select = useOrbitalStore((s) => s.select);
  const requestFlyTo = useOrbitalStore((s) => s.requestFlyTo);

  const choose = (object: TrackedObject) => {
    select(object.id);
    // Move the camera as well as selecting: a search hit outside the current
    // view would otherwise select an aircraft the user cannot see.
    requestFlyTo(object.lat, object.lon);
    setSearchQuery('');
  };

  const trimmed = query.trim();

  return (
    <div className="search">
      <input
        className="search__input"
        type="search"
        value={query}
        placeholder="Search callsign, e.g. UAL1234"
        aria-label="Search by callsign or identifier"
        onChange={(event) => setSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSearchQuery('');
          // Enter picks the top hit, which is the exact match when there is one
          // — the backend ranks exact above prefix above substring.
          if (event.key === 'Enter' && results.length > 0) choose(results[0]);
        }}
      />

      {trimmed.length > 0 && (
        <ul className="search__results">
          {searching && <li className="search__hint">Searching…</li>}
          {!searching && results.length === 0 && (
            <li className="search__hint">
              No match. Only aircraft the backend is currently tracking can be found.
            </li>
          )}
          {results.map((object) => (
            <li key={object.id}>
              <button className="search__result" onClick={() => choose(object)}>
                <span className="search__callsign">{object.label}</span>
                <span className="search__meta">
                  {object.altitude === null
                    ? 'altitude unknown'
                    : `${Math.round(object.altitude).toLocaleString()} m`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
