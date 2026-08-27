/**
 * Tests for the geography label layer.
 *
 * Three things here are worth more than the rest, and they are the three that
 * would each produce a plausible-looking globe that is quietly wrong:
 *
 * - **The horizon test.** Without it, every label on the far side of the
 *   planet is drawn over the near side, because projection has no idea the
 *   Earth is in the way. The failure looks like a jumble of names, not like a
 *   missing feature.
 * - **The sign of the projected depth.** A point behind the camera projects to
 *   coordinates that look perfectly reasonable, in the opposite corner.
 * - **Density.** The thresholds are the feature. A layer that shows every
 *   candidate is not a labelled globe, it is an unreadable one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { latLonToVector3 } from './earth';
import {
  LABEL_ALTITUDE,
  MAX_LABELS,
  type LabelCandidate,
  type LabelData,
  candidatesFor,
  createLabelLayer,
  createTextMeasurer,
  facesCamera,
  labelBudget,
  placeLabels,
  projectToScreen,
} from './labels';

const GLOBE_RADIUS = 100;

function cameraOver(lat: number, lon: number, distance: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 10_000);
  camera.position.copy(latLonToVector3(lat, lon, distance));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

const data: LabelData = {
  countries: [
    { name: 'Russia', lat: 65.9, lon: 95.7, rank: 0.417 },
    { name: 'Canada', lat: 58.5, lon: -97.9, rank: 0.246 },
    { name: 'Brazil', lat: -10, lon: -52, rank: 0.21 },
  ],
  cities: [
    { name: 'Shanghai', lat: 31.2, lon: 121.5, rank: 22_315_474 },
    { name: 'London', lat: 51.5, lon: -0.13, rank: 7_556_900 },
    { name: 'Porto', lat: 41.15, lon: -8.61, rank: 1_337_000 },
  ],
  airports: [
    { name: 'London Heathrow Airport', lat: 51.47, lon: -0.46, rank: 7_556_900, iata: 'LHR' },
  ],
};

describe('labelBudget', () => {
  it('shows nothing when the whole planet is small on screen', () => {
    expect(labelBudget(4).countries).toBe(0);
    expect(labelBudget(3).countries).toBe(0);
  });

  it('adds classes as the camera comes in, and never removes one', () => {
    const altitudes = [2.9, 0.9, 0.34, 0.11, 0.02];
    let previousCountries = 0;
    let previousCities = 0;
    for (const altitude of altitudes) {
      const budget = labelBudget(altitude);
      expect(budget.countries).toBeGreaterThanOrEqual(previousCountries);
      const cities = Number.isFinite(budget.cityMinRank) ? 1 / budget.cityMinRank : 0;
      expect(cities).toBeGreaterThanOrEqual(previousCities);
      previousCountries = budget.countries;
      previousCities = cities;
    }
  });

  it('holds airports back until the closest tier', () => {
    expect(labelBudget(0.12).airports).toBe(false);
    expect(labelBudget(0.119).airports).toBe(true);
    // The closest the camera can go is 1.014 radii, an altitude of 0.014.
    expect(labelBudget(0.014).airports).toBe(true);
  });

  it('is defined at the exact thresholds, not only between them', () => {
    expect(labelBudget(1).countries).toBe(12);
    expect(labelBudget(0.35).cityMinRank).toBe(5_000_000);
    expect(labelBudget(0.999).countries).toBe(30);
  });
});

describe('candidatesFor', () => {
  it('offers countries before cities before airports', () => {
    const kinds = candidatesFor(data, labelBudget(0.05), GLOBE_RADIUS).map((c) => c.kind);
    expect(kinds.indexOf('country')).toBeLessThan(kinds.indexOf('city'));
    expect(kinds.indexOf('city')).toBeLessThan(kinds.indexOf('airport'));
  });

  it('takes only as many countries as the budget allows', () => {
    const budget = { countries: 2, cityMinRank: Infinity, airports: false };
    const candidates = candidatesFor(data, budget, GLOBE_RADIUS);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.text)).toEqual(['Russia', 'Canada']);
  });

  it('stops at the city population threshold', () => {
    const cities = candidatesFor(data, labelBudget(0.5), GLOBE_RADIUS).filter(
      (c) => c.kind === 'city',
    );
    expect(cities.map((c) => c.text)).toEqual(['Shanghai', 'London']);
  });

  it('labels an airport with its IATA code, not its name', () => {
    const airports = candidatesFor(data, labelBudget(0.05), GLOBE_RADIUS).filter(
      (c) => c.kind === 'airport',
    );
    expect(airports.map((c) => c.text)).toEqual(['LHR']);
  });

  it('anchors every label on the label shell', () => {
    for (const candidate of candidatesFor(data, labelBudget(0.05), GLOBE_RADIUS)) {
      expect(candidate.position.length()).toBeCloseTo(
        GLOBE_RADIUS * (1 + LABEL_ALTITUDE),
        4,
      );
    }
  });
});

describe('facesCamera', () => {
  const camera = cameraOver(0, 0, 300);

  it('accepts the point under the camera', () => {
    expect(facesCamera(latLonToVector3(0, 0, GLOBE_RADIUS), camera.position, GLOBE_RADIUS)).toBe(
      true,
    );
  });

  it('rejects the antipode', () => {
    expect(
      facesCamera(latLonToVector3(0, 180, GLOBE_RADIUS), camera.position, GLOBE_RADIUS),
    ).toBe(false);
  });

  it('cuts exactly at the tangent, not at 90 degrees', () => {
    // From 300 units out, the horizon is at acos(r/d) = 70.53 degrees of arc,
    // not at 90. A test that only checked the hemisphere would pass with a
    // wrong constant and let a quarter of the far side through.
    const horizon = (Math.acos(GLOBE_RADIUS / 300) * 180) / Math.PI;
    expect(horizon).toBeCloseTo(70.53, 1);
    expect(
      facesCamera(latLonToVector3(0, horizon - 0.1, GLOBE_RADIUS), camera.position, GLOBE_RADIUS),
    ).toBe(true);
    expect(
      facesCamera(latLonToVector3(0, horizon + 0.1, GLOBE_RADIUS), camera.position, GLOBE_RADIUS),
    ).toBe(false);
  });
});

describe('projectToScreen', () => {
  const camera = cameraOver(0, 0, 300);

  it('puts the point under the camera at the centre of the viewport', () => {
    const screen = projectToScreen(
      latLonToVector3(0, 0, GLOBE_RADIUS),
      camera,
      800,
      600,
    );
    expect(screen).not.toBeNull();
    expect(screen!.x).toBeCloseTo(400, 0);
    expect(screen!.y).toBeCloseTo(300, 0);
  });

  it('refuses a point behind the camera', () => {
    // Behind the camera and outside the globe entirely, so only the depth
    // check can reject it. Without that check it lands on screen, mirrored.
    const behind = camera.position.clone().multiplyScalar(2);
    expect(projectToScreen(behind, camera, 800, 600)).toBeNull();
  });

  it('refuses a point outside the frustum', () => {
    const close = cameraOver(0, 0, 101.4);
    expect(projectToScreen(latLonToVector3(0, 40, GLOBE_RADIUS), close, 800, 600)).toBeNull();
  });

  it('maps y downward, as the DOM does', () => {
    const north = projectToScreen(latLonToVector3(20, 0, GLOBE_RADIUS), camera, 800, 600);
    const south = projectToScreen(latLonToVector3(-20, 0, GLOBE_RADIUS), camera, 800, 600);
    expect(north!.y).toBeLessThan(south!.y);
  });
});

describe('placeLabels', () => {
  const at = (x: number, y: number, text = 'x'): LabelCandidate & {
    x: number;
    y: number;
    width: number;
  } => ({
    kind: 'city',
    text,
    rank: 1,
    position: new THREE.Vector3(),
    x,
    y,
    width: 40,
  });

  it('keeps labels that do not overlap', () => {
    expect(placeLabels([at(0, 0), at(200, 200)], 14)).toHaveLength(2);
  });

  it('drops the later of two labels that collide', () => {
    const placed = placeLabels([at(100, 100, 'first'), at(105, 100, 'second')], 14);
    expect(placed.map((p) => p.text)).toEqual(['first']);
  });

  it('honours the order it is given, which is the priority order', () => {
    const country = { ...at(100, 100, 'Country'), kind: 'country' as const };
    const city = at(102, 100, 'City');
    expect(placeLabels([country, city], 14).map((p) => p.text)).toEqual(['Country']);
    expect(placeLabels([city, country], 14).map((p) => p.text)).toEqual(['City']);
  });

  it('never exceeds the cap, however many fit', () => {
    const many = Array.from({ length: 200 }, (_, i) => at((i % 20) * 60, Math.floor(i / 20) * 40));
    expect(placeLabels(many, 14).length).toBeLessThanOrEqual(MAX_LABELS);
  });

  it('separates by height as well as width', () => {
    expect(placeLabels([at(100, 100), at(100, 104)], 14)).toHaveLength(1);
    expect(placeLabels([at(100, 100), at(100, 140)], 14)).toHaveLength(2);
  });
});

describe('createTextMeasurer', () => {
  it('returns a positive width and caches by string', () => {
    const measure = createTextMeasurer();
    const first = measure('Reykjavik');
    expect(first).toBeGreaterThan(0);
    expect(measure('Reykjavik')).toBe(first);
    expect(measure('LHR')).toBeLessThan(measure('Ulaanbaatar'));
  });
});

describe('createLabelLayer', () => {
  it('pools exactly MAX_LABELS elements and starts with none shown', () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    expect(layer.element.children).toHaveLength(MAX_LABELS);
    expect(layer.count).toBe(0);
    layer.dispose();
  });

  it('draws nothing until the data arrives', () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    layer.update(cameraOver(0, 0, 300), 800, 600, 1000);
    expect(layer.count).toBe(0);
    layer.dispose();
  });

  it('draws the near side and not the far side', async () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    await layer.load(async () => data);

    // Over the Atlantic: London is in front, Shanghai is behind the planet.
    layer.update(cameraOver(45, -20, 140), 800, 600, 1000);
    const shown = Array.from(layer.element.children)
      .filter((child) => (child as HTMLElement).style.display !== 'none')
      .map((child) => child.textContent);

    expect(shown).toContain('London');
    expect(shown).not.toContain('Shanghai');
    layer.dispose();
  });

  it('shows nothing at all from far enough away', async () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    await layer.load(async () => data);
    layer.update(cameraOver(0, 0, 500), 800, 600, 1000);
    expect(layer.count).toBe(0);
    layer.dispose();
  });

  it('hides everything when switched off', async () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    await layer.load(async () => data);
    layer.update(cameraOver(45, -20, 140), 800, 600, 1000);
    expect(layer.count).toBeGreaterThan(0);

    layer.setVisible(false);
    expect(layer.count).toBe(0);
    for (const child of Array.from(layer.element.children)) {
      expect((child as HTMLElement).style.display).toBe('none');
    }
    layer.dispose();
  });

  it('reprojects between selections instead of freezing labels in place', async () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    await layer.load(async () => data);

    layer.update(cameraOver(51, 0, 140), 800, 600, 1000);
    const before = (layer.element.children[0] as HTMLElement).style.transform;

    // Ten milliseconds later, far too soon for a new selection, but the camera
    // has moved: the label must move with it.
    layer.update(cameraOver(51, 6, 140), 800, 600, 1010);
    const after = (layer.element.children[0] as HTMLElement).style.transform;

    expect(after).not.toBe(before);
    layer.dispose();
  });

  it('drops a label that crosses the limb between selections', async () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    await layer.load(async () => data);

    layer.update(cameraOver(51, 0, 140), 800, 600, 1000);
    const shownBefore = Array.from(layer.element.children)
      .filter((child) => (child as HTMLElement).style.display !== 'none')
      .map((child) => child.textContent);
    expect(shownBefore).toContain('London');

    // Swing to the far side of the planet without letting the selection run.
    layer.update(cameraOver(0, 170, 140), 800, 600, 1005);
    const shownAfter = Array.from(layer.element.children)
      .filter((child) => (child as HTMLElement).style.display !== 'none')
      .map((child) => child.textContent);
    expect(shownAfter).not.toContain('London');
    layer.dispose();
  });

  it('never draws more than the cap, against the real dataset', () => {
    if (!generated) return;
    const layer = createLabelLayer(GLOBE_RADIUS);
    void layer.load(async () => realLabels);
    for (const distance of [110, 120, 140, 200, 300, 500]) {
      layer.update(cameraOver(48, 8, distance), 1600, 900, distance * 1000);
      expect(layer.count).toBeLessThanOrEqual(MAX_LABELS);
    }
    layer.dispose();
  });
});

// ---- against the real generated data ---------------------------------------

const labelsPath = join(process.cwd(), 'public', 'geo', 'labels.json');
const generated = existsSync(labelsPath);
const realLabels: LabelData = generated
  ? (JSON.parse(readFileSync(labelsPath, 'utf8')) as LabelData)
  : { countries: [], cities: [], airports: [] };

describe.skipIf(!generated)('the generated labels.json', () => {
  it('is sorted by rank within each class, which candidatesFor relies on', () => {
    for (const set of [realLabels.countries, realLabels.cities, realLabels.airports]) {
      for (let i = 1; i < set.length; i += 1) {
        expect(set[i].rank).toBeLessThanOrEqual(set[i - 1].rank);
      }
    }
  });

  it('anchors country names inside plausible bounds', () => {
    for (const country of realLabels.countries) {
      expect(Math.abs(country.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(country.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('puts the United States label on land, not in the Pacific', () => {
    // The centroid of the whole feature lands off Baja California, pulled
    // there by Alaska and Hawaii. This is the case that made the build step
    // use the largest polygon instead.
    const usa = realLabels.countries.find((c) => c.name.includes('United States of America'));
    expect(usa).toBeDefined();
    expect(usa!.lon).toBeLessThan(-90);
    expect(usa!.lon).toBeGreaterThan(-105);
    expect(usa!.lat).toBeGreaterThan(30);
    expect(usa!.lat).toBeLessThan(50);
  });

  it('gives every airport a three-letter code', () => {
    for (const airport of realLabels.airports) {
      expect(airport.iata).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe('the airport cap', () => {
  const airportAt = (x: number, text: string) => ({
    kind: 'airport' as const,
    text,
    rank: 7_556_900,
    position: new THREE.Vector3(),
    x,
    y: 100,
    width: 24,
  });

  it('stops airports from filling the screen', () => {
    // Twenty non-overlapping airports, all equally ranked, which is exactly
    // what a London view offers. Without the cap all twenty are drawn.
    const many = Array.from({ length: 20 }, (_, i) => airportAt(i * 60, `A${i}`));
    expect(placeLabels(many, 14).length).toBe(8);
  });

  it('does not cap the other classes', () => {
    const cities = Array.from({ length: 20 }, (_, i) => ({
      kind: 'city' as const,
      text: `C${i}`,
      rank: 1,
      position: new THREE.Vector3(),
      x: i * 60,
      y: 100,
      width: 24,
    }));
    expect(placeLabels(cities, 14).length).toBe(20);
  });

  it('leaves room for cities offered after the airports', () => {
    const many = Array.from({ length: 20 }, (_, i) => airportAt(i * 60, `A${i}`));
    const city = {
      kind: 'city' as const,
      text: 'London',
      rank: 7_556_900,
      position: new THREE.Vector3(),
      x: 900,
      y: 300,
      width: 40,
    };
    expect(placeLabels([...many, city], 14).map((p) => p.text)).toContain('London');
  });
});

describe('a camera with no viewport', () => {
  it('projects nothing, rather than projecting NaN', () => {
    // A camera constructed while its container reports zero width has an
    // aspect of 0/0. Every comparison against NaN is false, so without an
    // explicit check the bounds tests pass it through and every label is
    // written with a transform of `translate(NaNpx, NaNpx)` -- which browsers
    // reject, leaving the whole set stacked in the top-left corner. Seen in
    // the running app before this test existed.
    const camera = new THREE.PerspectiveCamera(50, 0 / 0, 0.1, 10_000);
    camera.position.copy(latLonToVector3(0, 0, 300));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    expect(Number.isNaN(camera.aspect)).toBe(true);
    expect(projectToScreen(latLonToVector3(0, 0, GLOBE_RADIUS), camera, 800, 600)).toBeNull();
  });

  it('draws no labels at all through such a camera', async () => {
    const layer = createLabelLayer(GLOBE_RADIUS);
    await layer.load(async () => data);

    const camera = new THREE.PerspectiveCamera(50, 0 / 0, 0.1, 10_000);
    camera.position.copy(latLonToVector3(45, -20, 140));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    layer.update(camera, 0, 0, 1000);
    expect(layer.count).toBe(0);
    for (const child of Array.from(layer.element.children)) {
      expect((child as HTMLElement).style.display).toBe('none');
    }
    layer.dispose();
  });
});
