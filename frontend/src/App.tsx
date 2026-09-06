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

import { showsAds } from './ads';
import { showsEarthLayers } from './bodies';
import { BodyPicker } from './components/BodyPicker';
import { TimeControl } from './components/TimeControl';
import { DetailPanel } from './components/DetailPanel';
import { MoonPanel } from './components/MoonPanel';
import { TrueScaleToggle } from './components/TrueScaleToggle';
import { AccountMenu } from './components/AccountMenu';
import { AdSlot } from './components/AdSlot';
import { SignInPage } from './components/SignInPage';
import { MoonSatelliteList } from './components/MoonSatelliteList';
import { LayerToggle } from './components/LayerToggle';
import { Legend } from './components/Legend';
import { SearchBar } from './components/SearchBar';
import { StatusBar } from './components/StatusBar';
import { chromeFor } from './components/layerChrome';
import { useOrbitalStore } from './state/store';
import { PlanetView } from './planet/PlanetView';
import { useObjectPolling, useSearch, useSelectedDetail } from './hooks/usePolling';
import { useSignInRoute } from './hooks/useSignInRoute';

export function App() {
  useObjectPolling();
  useSelectedDetail();
  useSearch();
  // Gives the sign-in page an address and makes Back close it (D153).
  useSignInRoute();

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

  // The other side of the free tier (D150). Premium buys their absence, so this
  // is the whole of the switch - not a smaller slot, not fewer cards.
  //
  // **They float, like every other panel here, and the map keeps the whole
  // viewport.** An earlier attempt gave them their own grid rows and genuinely
  // shrank the globe, which is the one thing this interface should not spend on
  // an advertisement. These go where the chrome already has dead space instead:
  // the gap the header leaves to the right of the layer toggle, and the top
  // right corner while nothing is selected.
  const ads = showsAds(useOrbitalStore((s) => s.account));

  // **The rail yields to the product.** Both detail panels open in that corner,
  // and an advertisement must never be the reason somebody cannot read the
  // thing they just clicked on.
  const selectedId = useOrbitalStore((s) => s.selectedId);
  const selectedMoonId = useOrbitalStore((s) => s.selectedMoonId);
  const panelOpen = selectedId !== null || selectedMoonId !== null;

  // **The anchored banner yields to the time control**, which is centred just
  // above the status bar and would sit underneath it. That control only exists
  // on the satellite layer (D119), so on aircraft - the layer this opens on -
  // the bottom of the screen is genuinely free.
  const scrubberShown = onEarth && activeLayer.id === 'satellite';

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
        {/* Into the space the header already leaves to the right of the layer
            toggle, so it costs the map nothing at all. */}
        {ads && <AdSlot slot="banner" />}
      </header>

      {ads && !panelOpen && <AdSlot slot="rail" />}

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

      {ads && !scrubberShown && <AdSlot slot="anchor" />}

      {/* Last, so it is over everything without needing a z-index taller than
          the rest of the chrome put together. */}
      <SignInPage />
    </div>
  );
}
