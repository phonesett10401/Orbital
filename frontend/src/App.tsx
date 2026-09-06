/**
 * Application shell.
 *
 * Deliberately thin: it starts the polling hooks and lays out the world view
 * with the UI floating over it. All the interesting behaviour lives in the
 * render layers, the store, and the hooks.
 *
 * Which renderer draws the world is a configuration choice while the MapLibre
 * view is brought to parity (D54). Everything around it — search, the detail
 * panel, the legend, the status bar, all three polling hooks — is shared, and
 * that is the point: none of it was ever about how the planet is drawn.
 */

import { showsEarthLayers } from './bodies';
import { BodyPicker } from './components/BodyPicker';
import { TimeControl } from './components/TimeControl';
import { DetailPanel } from './components/DetailPanel';
import { MoonPanel } from './components/MoonPanel';
import { TrueScaleToggle } from './components/TrueScaleToggle';
import { AccountMenu } from './components/AccountMenu';
import { MoonSatelliteList } from './components/MoonSatelliteList';
import { LayerToggle } from './components/LayerToggle';
import { Legend } from './components/Legend';
import { SearchBar } from './components/SearchBar';
import { StatusBar } from './components/StatusBar';
import { chromeFor } from './components/layerChrome';
import { useOrbitalStore } from './state/store';
import { PlanetView } from './planet/PlanetView';
import { useObjectPolling, useSearch, useSelectedDetail } from './hooks/usePolling';

export function App() {
  useObjectPolling();
  useSelectedDetail();
  useSearch();

  // The wordmark's subtitle names what is on screen, so it has to follow the
  // layer rather than being written once for aircraft (D100).
  const activeLayer = useOrbitalStore((s) => s.activeLayer);

  // Aircraft and satellites are statements about Earth. On another world the
  // search box, the layer toggle, the altitude key and the object count are
  // not empty - they are about nothing (D120). Chrome describing the wrong
  // subject is the fault D100 already caught once, in the place a reader is
  // most likely to believe it.
  const onEarth = showsEarthLayers(useOrbitalStore((s) => s.activeBody));
  const onMoon = useOrbitalStore((s) => s.activeBody) === 'moon';

  return (
    <div className="app">
      <PlanetView />

      <header className="app__header">
        <div className="app__brand">
          {/*
            Decorative, so it is hidden from assistive technology: the name is
            already right beside it as text, and announcing both would read the
            brand twice.
          */}
          <img className="app__mark" src="/logo.svg" alt="" aria-hidden="true" />
          <div className="app__brandText">
            <span className="app__title">Orbital</span>
            <span className="app__subtitle">
              {onEarth ? chromeFor(activeLayer.id, []).subtitle : 'surface imagery'}
            </span>
            <BodyPicker />
            <TrueScaleToggle />
            {/* Signing in is available on every world, unlike the layers
                around it: an account is about the reader, not the body under
                the camera (D148). */}
            <AccountMenu />
          </div>
        </div>
        {onEarth && <SearchBar />}
        {onEarth && <LayerToggle />}
      </header>

      {onEarth && <TimeControl />}
      {onEarth && <DetailPanel />}
      {/* Its own panel rather than a branch in that one: a lunar craft shares
          almost no fields with an aircraft, and has one none of them do - a
          position published in advance rather than observed (D135). */}
      <MoonPanel />
      {/* The corner the legend uses on Earth. Three spacecraft, often round
          the far side where a marker cannot be clicked at all (D136). */}
      {onMoon && <MoonSatelliteList />}
      {onEarth && <Legend />}
      <StatusBar />
    </div>
  );
}
