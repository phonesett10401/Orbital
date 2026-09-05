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

import { TimeControl } from './components/TimeControl';
import { DetailPanel } from './components/DetailPanel';
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
            <span className="app__subtitle">{chromeFor(activeLayer.id, []).subtitle}</span>
          </div>
        </div>
        <SearchBar />
        <LayerToggle />
      </header>

      <TimeControl />
      <DetailPanel />
      <Legend />
      <StatusBar />
    </div>
  );
}
