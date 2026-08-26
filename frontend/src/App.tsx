/**
 * Application shell.
 *
 * Deliberately thin: it starts the polling hooks and lays out the globe with
 * the UI floating over it. All the interesting behaviour lives in the globe
 * layers, the store, and the hooks.
 */

import { DetailPanel } from './components/DetailPanel';
import { LayerToggle } from './components/LayerToggle';
import { Legend } from './components/Legend';
import { SearchBar } from './components/SearchBar';
import { StatusBar } from './components/StatusBar';
import { GlobeView } from './globe/GlobeView';
import { useObjectPolling, useSearch, useSelectedDetail } from './hooks/usePolling';

export function App() {
  useObjectPolling();
  useSelectedDetail();
  useSearch();

  return (
    <div className="app">
      <GlobeView />

      <header className="app__header">
        <div className="app__brand">
          <span className="app__title">Orbital</span>
          <span className="app__subtitle">live aircraft</span>
        </div>
        <SearchBar />
        <LayerToggle />
      </header>

      <DetailPanel />
      <Legend />
      <StatusBar />
    </div>
  );
}
