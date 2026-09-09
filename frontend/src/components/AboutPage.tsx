/**
 * What this thing is (D177).
 *
 * Phone asked for a page about the site, opening on the mark built in three
 * dimensions, with the content rolling in as you scroll.
 *
 * ## The mark is the subject, not a badge
 *
 * `markScene.ts` builds the logo out of a globe, an orbit and a satellite -
 * which is what the logo is a picture of, and what this application spends the
 * rest of its time drawing from real data. Showing a flat copy of the SVG at
 * the top of a page about the project would have been the one place the app
 * drew a picture of itself instead of the thing.
 *
 * ## Everything it says is data
 *
 * `aboutFacts.ts` holds the claims, with tests against the rest of the
 * repository - the layer list is checked against the store's own registry, the
 * source terms against the findings that chose them. A page about the project
 * is the easiest place in the application to write something flattering and
 * untrue, so none of it is written here.
 *
 * The counts are asked of the running system rather than typed, because they
 * move and because the last figures copied into a document were stale within
 * three sessions (D176's neighbour, and the report's own correction).
 */

import { useEffect, useRef, useState } from 'react';

import { BUILD, LAYERS, REFUSALS, SOURCES, countText } from '../aboutFacts';
import { fetchObjects } from '../api/client';
import { createMarkScene, type MarkScene } from '../planet/markScene';
import { prefersReducedMotion } from '../motion';
import { driftFrom, easeDrift } from '../solarFocus';
import { useOrbitalStore } from '../state/store';

/** How much of the way toward the pointer's lean each frame closes. */
const DRIFT_EASE = 0.06;

export function AboutPage() {
  const open = useOrbitalStore((s) => s.openPage) === 'about';
  const setPage = useOrbitalStore((s) => s.setOpenPage);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const scene = useRef<MarkScene | null>(null);
  const driftTo = useRef({ x: 0, y: 0 });
  const drift = useRef({ x: 0, y: 0 });
  const root = useRef<HTMLDivElement | null>(null);

  const [counts, setCounts] = useState<Record<string, number | null>>({
    aircraft: null,
    satellites: null,
    ships: null,
  });

  // --- the mark -------------------------------------------------------------
  useEffect(() => {
    if (!open || !canvas.current) return undefined;
    const element = canvas.current;
    const built = createMarkScene(element);
    scene.current = built;

    const still = prefersReducedMotion();
    const started = performance.now();
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      built.resize(element.clientWidth, element.clientHeight, window.devicePixelRatio || 1);
      drift.current = easeDrift(
        drift.current,
        still ? { x: 0, y: 0 } : driftTo.current,
        DRIFT_EASE,
      );
      // Reduced motion stops the lean and the turn, not the mark: somebody who
      // asked for less movement has not asked to be shown less.
      built.render(still ? 0 : performance.now() - started, drift.current);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      built.dispose();
      scene.current = null;
    };
  }, [open]);

  // --- what the system is serving right now ---------------------------------
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    for (const layer of LAYERS) {
      // One object each: the envelope's `total` is what is wanted, and asking
      // for two thousand to count them would be absurd.
      void fetchObjects(layer.resource, { limit: 1, signal: controller.signal })
        .then((body) => setCounts((was) => ({ ...was, [layer.resource]: body.total })))
        .catch(() => {
          // Left null, which the page renders as a dash rather than a zero. A
          // layer that is switched off has no count, and saying "0 ships" would
          // be a claim about the sea.
        });
    }
    return () => controller.abort();
  }, [open]);

  // --- rolling in -----------------------------------------------------------
  useEffect(() => {
    if (!open || !root.current) return undefined;
    if (prefersReducedMotion()) {
      root.current.querySelectorAll('.about__reveal').forEach((el) => el.classList.add('is-in'));
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Once in, it stays in. A section that faded out again on the way
          // back up would make scrolling feel like it was undoing something.
          if (entry.isIntersecting) entry.target.classList.add('is-in');
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );
    root.current.querySelectorAll('.about__reveal').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPage(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setPage]);

  if (!open) return null;

  return (
    <div
      className="about"
      ref={root}
      role="region"
      aria-label="About Orbital"
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        driftTo.current = driftFrom(
          event.clientX - box.left,
          event.clientY - box.top,
          box.width,
          box.height,
        );
      }}
      onPointerLeave={() => {
        driftTo.current = { x: 0, y: 0 };
      }}
    >
      {/* Registration marks and grain, as on the system page. Neither draws an
          object; both are there to stop a screen of flat colour looking like
          one. */}
      <div className="about__grid" aria-hidden="true" />
      <div className="about__grain" aria-hidden="true" />

      <section className="about__hero">
        <canvas className="about__mark" ref={canvas} aria-hidden="true" />
        <div className="about__heroText">
          <p className="about__eyebrow">Orbital</p>
          <h1 className="about__title">
            Everything up there,
            <br />
            on one map
          </h1>
          <p className="about__lede">
            Aircraft, ships and satellites are broadcasting their positions right now, in three
            different formats, from three kinds of source. This puts them on one globe and is
            careful about what it does not know.
          </p>
        </div>
        <p className="about__scrollHint" aria-hidden="true">
          Scroll
        </p>
      </section>

      <section className="about__section about__reveal">
        <p className="about__label">What you are looking at</p>
        <ul className="about__layers">
          {LAYERS.map((layer) => (
            <li key={layer.resource}>
              <span className="about__count">{countText(counts[layer.resource])}</span>
              <span className="about__layerName">{layer.name}</span>
              <span className="about__origin">{layer.origin}</span>
            </li>
          ))}
        </ul>
        <p className="about__note">
          Counted from the running system as this page loaded, not written down.
        </p>
      </section>

      <section className="about__section about__reveal">
        <p className="about__label">Where it comes from</p>
        <ul className="about__rows">
          {SOURCES.map((source) => (
            <li key={source.name}>
              <span className="about__rowName">{source.name}</span>
              <span className="about__rowMid">{source.provides}</span>
              <span className="about__rowEnd">{source.terms}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="about__section about__reveal">
        <p className="about__label">What it will not tell you</p>
        <ul className="about__refusals">
          {REFUSALS.map((refusal) => (
            <li key={refusal.claim}>
              <p className="about__claim">{refusal.claim}</p>
              <p className="about__reason">{refusal.reason}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="about__section about__reveal">
        <p className="about__label">How it is built</p>
        <ul className="about__rows">
          {BUILD.map((fact) => (
            <li key={fact.label}>
              <span className="about__rowName">{fact.label}</span>
              <span className="about__rowEnd about__rowEnd--wide">{fact.value}</span>
            </li>
          ))}
        </ul>
      </section>

      <button type="button" className="about__close" onClick={() => setPage(null)}>
        ← Back to the map
      </button>
    </div>
  );
}
