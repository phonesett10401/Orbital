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
import { SATELLITE_ZOOM } from '../planet/satelliteLayer';
import { chromeFor } from './layerChrome';
import { useOrbitalStore } from '../state/store';
import type { Airport, TrackedObject } from '../types';
import {
  aircraftEntry,
  airportEntry,
  loadRecent,
  recentForLayer,
  remember,
  satelliteEntry,
  shipEntry,
  saveRecent,
  type RecentSearch,
} from './recentSearches';

export function SearchBar() {
  // The example in the placeholder has to be something the active layer
  // could actually match: there are no callsigns or airports in orbit.
  const activeLayer = useOrbitalStore((s) => s.activeLayer);
  const query = useOrbitalStore((s) => s.searchQuery);
  const results = useOrbitalStore((s) => s.searchResults);
  const airports = useOrbitalStore((s) => s.searchAirports);
  const satellites = useOrbitalStore((s) => s.searchSatellites);
  const ships = useOrbitalStore((s) => s.searchShips);
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

  // Only the remembered searches this layer can act on. Offering an airport
  // under a satellite search box would be offering an answer the box cannot
  // give, and choosing it would throw the user out of the layer (D103).
  const visibleRecent = recentForLayer(recent, activeLayer.id);

  const chooseSatellite = (object: TrackedObject) => {
    // Selected as well as flown to, unlike an airport: a satellite *is* a
    // tracked object, so the panel has something honest to say and the
    // selection ring marks which dot was asked for (D103).
    select(object.id);
    requestFlyTo(object.lat, object.lon, SATELLITE_ZOOM);
    keep(satelliteEntry(object));
    setSearchQuery('');
  };

  const chooseShip = (object: TrackedObject) => {
    // Selected as well as flown to, like a satellite and unlike an airport: a
    // ship *is* a tracked object, so the panel has something honest to say
    // (D103). No special zoom - a vessel is on the surface, so the default
    // arrival is already the right distance for one.
    select(object.id);
    requestFlyTo(object.lat, object.lon);
    keep(shipEntry(object));
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
  // In satellite mode the box answers with satellites and nothing else. The
  // backend still returns all three lists - "ISS" matches WISCASSET airport,
  // and offering that here would answer a question the user did not ask
  // (D103).
  // **Which lists this layer may answer with.** This was three ternaries on a
  // `satelliteMode` boolean, which is the same negation-over-two that
  // `recentForLayer` carried: "not satellites" silently meant "aircraft", and
  // a ship search would have answered with aeroplanes and airports (D165).
  const layerId = activeLayer.id;
  const shownAircraft = layerId === 'aircraft' ? results : [];
  const shownAirports = layerId === 'aircraft' ? airports : [];
  const shownSatellites = layerId === 'satellite' ? satellites : [];
  const shownShips = layerId === 'ship' ? ships : [];
  const nothingFound =
    !searching &&
    shownAircraft.length === 0 &&
    shownAirports.length === 0 &&
    shownSatellites.length === 0 &&
    shownShips.length === 0;
  const showRecent = trimmed.length === 0 && focused && recent.length > 0;

  return (
    <div className="search">
      <input
        className="search__input"
        type="search"
        value={query}
        placeholder={chromeFor(activeLayer.id, []).searchPlaceholder}
        // The placeholder has been layer-aware since D103; this was not, so a
        // screen reader was told "callsign, aircraft address, or airport" on
        // every layer, including one where none of the three exists. The
        // chrome module already holds the right words for each (D165).
        aria-label={chromeFor(activeLayer.id, []).searchPlaceholder}
        onChange={(event) => setSearchQuery(event.target.value)}
        onFocus={() => setFocused(true)}
        // Deferred so a click on a result lands before the list is removed.
        onBlur={() => window.setTimeout(() => setFocused(false), 150)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSearchQuery('');
          // Enter picks the top hit, aircraft first — the backend ranks exact
          // above prefix above substring within each kind.
          if (event.key === 'Enter') {
            // Whichever group the active layer can actually act on comes
            // first, so Enter never jumps the user out of the layer they are
            // looking at (D103).
            if (shownSatellites.length > 0) chooseSatellite(shownSatellites[0]);
            else if (shownShips.length > 0) chooseShip(shownShips[0]);
            else if (shownAircraft.length > 0) chooseAircraft(shownAircraft[0]);
            else if (shownAirports.length > 0) chooseAirport(shownAirports[0]);
          }
        }}
      />

      {showRecent && visibleRecent.length > 0 && (
        <ul className="search__results">
          <li className="search__group">Recent</li>
          {visibleRecent.map((entry) => (
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
              {layerId === 'satellite' &&
                'No match. Try a satellite name or its catalogue number.'}
              {layerId === 'ship' &&
                'No match. Ships are only findable while the backend is tracking them, and AIS is received from the shore — the open ocean is not covered.'}
              {layerId === 'aircraft' &&
                'No match. Aircraft are only findable while the backend is tracking them.'}
            </li>
          )}

          {shownSatellites.length > 0 && <li className="search__group">Satellites</li>}
          {shownSatellites.map((object) => (
            <li key={`sat-${object.id}`}>
              <button className="search__result" onClick={() => chooseSatellite(object)}>
                <span className="search__callsign">{object.label}</span>
                <span className="search__meta">
                  {object.altitude === null
                    ? 'altitude unknown'
                    : `${Math.round(object.altitude / 1000).toLocaleString()} km`}
                </span>
              </button>
            </li>
          ))}

          {shownShips.length > 0 && <li className="search__group">Ships</li>}
          {shownShips.map((object) => (
            <li key={`ship-${object.id}`}>
              <button className="search__result" onClick={() => chooseShip(object)}>
                <span className="search__callsign">{object.label}</span>
                {/* The vessel type, not an altitude: every ship is at sea
                    level, so the field the other two groups use here would
                    read "0 m" on every row (D165). */}
                <span className="search__meta">{object.model ?? 'type unreported'}</span>
              </button>
            </li>
          ))}

          {shownAircraft.length > 0 && <li className="search__group">Aircraft</li>}
          {shownAircraft.map((object) => (
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

          {shownAirports.length > 0 && <li className="search__group">Airports</li>}
          {shownAirports.map((airport) => (
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
