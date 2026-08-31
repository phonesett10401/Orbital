/**
 * One box, two kinds of answer, and the last few you looked at.
 *
 * Queries the backend rather than filtering what is on screen: the client only
 * holds what is in its viewport, and looking up a flight by callsign has to
 * work for one on the other side of the world. Airports come from the same
 * request, because "what is flying at Heathrow" is how people actually think
 * about air traffic, and a box that only understood callsigns could not
 * answer it.
 *
 * **Aircraft and airports are drawn as separate groups**, in that order,
 * because they are not comparable. An aircraft is something being watched
 * right now and can be selected; an airport is a fixed place and can only be
 * flown to. Interleaving them by some invented relevance score would blur a
 * distinction the user needs to make.
 */

import { useEffect, useState } from 'react';

import { AIRPORT_ZOOM } from '../planet/airportLayer';
import { useOrbitalStore } from '../state/store';
import type { Airport, TrackedObject } from '../types';
import {
  aircraftEntry,
  airportEntry,
  loadRecent,
  remember,
  saveRecent,
  type RecentSearch,
} from './recentSearches';

export function SearchBar() {
  const query = useOrbitalStore((s) => s.searchQuery);
  const results = useOrbitalStore((s) => s.searchResults);
  const airports = useOrbitalStore((s) => s.searchAirports);
  const searching = useOrbitalStore((s) => s.searching);
  const setSearchQuery = useOrbitalStore((s) => s.setSearchQuery);
  const select = useOrbitalStore((s) => s.select);
  const requestFlyTo = useOrbitalStore((s) => s.requestFlyTo);
  const focusAirport = useOrbitalStore((s) => s.focusAirport);

  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [focused, setFocused] = useState(false);

  // Read storage once, on mount, rather than on every render: it is
  // synchronous and this component re-renders on every keystroke.
  useEffect(() => setRecent(loadRecent()), []);

  const keep = (entry: RecentSearch) => {
    const next = remember(recent, entry);
    setRecent(next);
    saveRecent(next);
  };

  const chooseAircraft = (object: TrackedObject) => {
    select(object.id);
    // Move the camera as well as selecting: a search hit outside the current
    // view would otherwise select an aircraft the user cannot see.
    requestFlyTo(object.lat, object.lon);
    keep(aircraftEntry(object));
    setSearchQuery('');
  };

  const chooseAirport = (airport: Airport) => {
    // No selection: an airport is not a tracked object, and pretending it were
    // would open a detail panel with nothing honest to put in it. It is marked
    // instead - flying the camera to a coordinate and stopping tells you
    // nothing about which patch of ground you were asking for.
    focusAirport(airport);
    requestFlyTo(airport.lat, airport.lon, AIRPORT_ZOOM);
    keep(airportEntry(airport));
    setSearchQuery('');
  };

  const chooseRecent = (entry: RecentSearch) => {
    // An aircraft is re-selected by id where it is still tracked; its stored
    // position is minutes old by now and only worth using as a fallback.
    if (entry.kind === 'aircraft') select(entry.id);
    if (entry.kind === 'airport') {
      // Rebuilt from what was stored rather than re-fetched: a recent entry
      // holds everything the marker draws, and going back to the network to
      // re-answer a question already answered would make a remembered search
      // slower than a new one.
      focusAirport({
        icao: entry.id,
        name: entry.sublabel,
        municipality: entry.sublabel,
        iata: entry.label === entry.id ? null : entry.label,
        country: null,
        lat: entry.lat,
        lon: entry.lon,
        distanceKm: null,
      });
    }
    requestFlyTo(entry.lat, entry.lon, entry.kind === 'airport' ? AIRPORT_ZOOM : undefined);
    keep(entry);
    setSearchQuery('');
  };

  const trimmed = query.trim();
  const nothingFound = !searching && results.length === 0 && airports.length === 0;
  const showRecent = trimmed.length === 0 && focused && recent.length > 0;

  return (
    <div className="search">
      <input
        className="search__input"
        type="search"
        value={query}
        placeholder="Search callsign or airport, e.g. UAL1234 or LHR"
        aria-label="Search by callsign, aircraft address, or airport"
        onChange={(event) => setSearchQuery(event.target.value)}
        onFocus={() => setFocused(true)}
        // Deferred so a click on a result lands before the list is removed.
        onBlur={() => window.setTimeout(() => setFocused(false), 150)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSearchQuery('');
          // Enter picks the top hit, aircraft first — the backend ranks exact
          // above prefix above substring within each kind.
          if (event.key === 'Enter') {
            if (results.length > 0) chooseAircraft(results[0]);
            else if (airports.length > 0) chooseAirport(airports[0]);
          }
        }}
      />

      {showRecent && (
        <ul className="search__results">
          <li className="search__group">Recent</li>
          {recent.map((entry) => (
            <li key={`${entry.kind}:${entry.id}`}>
              <button className="search__result" onClick={() => chooseRecent(entry)}>
                <span className="search__callsign">{entry.label}</span>
                <span className="search__meta">{entry.sublabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {trimmed.length > 0 && (
        <ul className="search__results">
          {searching && <li className="search__hint">Searching…</li>}
          {nothingFound && (
            <li className="search__hint">
              No match. Aircraft are only findable while the backend is tracking them.
            </li>
          )}

          {results.length > 0 && <li className="search__group">Aircraft</li>}
          {results.map((object) => (
            <li key={object.id}>
              <button className="search__result" onClick={() => chooseAircraft(object)}>
                <span className="search__callsign">{object.label}</span>
                <span className="search__meta">
                  {object.altitude === null
                    ? 'altitude unknown'
                    : `${Math.round(object.altitude).toLocaleString()} m`}
                </span>
              </button>
            </li>
          ))}

          {airports.length > 0 && <li className="search__group">Airports</li>}
          {airports.map((airport) => (
            <li key={airport.icao}>
              <button className="search__result" onClick={() => chooseAirport(airport)}>
                <span className="search__callsign">{airport.iata ?? airport.icao}</span>
                <span className="search__meta">
                  {airport.municipality ?? airport.name}
                  {airport.country ? ` · ${airport.country}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
