/**
 * What the detail panel says about a satellite.
 *
 * The panel's aircraft half asks questions a satellite cannot answer — what
 * airline, what type, where it departed, where it is scheduled to land — and
 * rendering those as blanks would be worse than not asking. So this builds a
 * different set of rows entirely.
 *
 * Pure and returning data rather than JSX, because there is no
 * component-render harness in this project: presentation judgements are
 * extracted and tested as data, which is how the panel's other decisions
 * (`routeSummary`, `panelFields`) are covered too.
 *
 * **This is where the true altitude lives.** Both renderers distort it on
 * purpose — the globe compresses height logarithmically so geostationary fits
 * on screen (D96), the map drops it to a colour because a map has no height at
 * all (D97). Those are drawing decisions. The number here is the real one, and
 * that is the bargain those decisions were made under.
 */

import { FAMILY_LABEL, familyFor } from '../satelliteFamily';
import { regimeFor, type OrbitRegime } from '../satelliteShell';
import type { TrackedObjectDetail } from '../types';

export interface Row {
  label: string;
  value: string;
  /** A qualifier printed under the value, where one is honest to add. */
  note?: string;
}

const REGIME_NAMES: Record<OrbitRegime, string> = {
  LEO: 'Low Earth orbit',
  MEO: 'Medium Earth orbit',
  GEO: 'Geostationary',
  HEO: 'High / elliptical orbit',
};

export function regimeName(altitudeM: number | null): string | null {
  const regime = regimeFor(altitudeM);
  return regime ? REGIME_NAMES[regime] : null;
}

/** Kilometres, with thousands separated — these numbers run to six figures. */
export function formatAltitude(altitudeM: number | null): string {
  if (altitudeM === null || !Number.isFinite(altitudeM)) return 'Unknown';
  return `${Math.round(altitudeM / 1000).toLocaleString('en-GB')} km`;
}

/**
 * Orbital speed in km/s.
 *
 * Every source quotes satellites this way and nobody quotes them in m/s, so
 * converting is what makes the number recognisable — 7.66 km/s is a figure a
 * reader can check against what they know (D94).
 */
export function formatSpeed(velocityMs: number | null): string {
  if (velocityMs === null || !Number.isFinite(velocityMs)) return 'Unknown';
  return `${(velocityMs / 1000).toFixed(2)} km/s`;
}

/** Minutes under two hours, then hours and minutes. */
export function formatPeriod(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 120) return `${minutes.toFixed(0)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return `${hours} h ${rest.toString().padStart(2, '0')} min`;
}

/**
 * Inclination, with what it actually tells you.
 *
 * The number alone means nothing to most readers. What it *means* is the band
 * of latitudes the object can ever be over, which is a fact anyone can use:
 * an inclination of 51.6 is why the ISS passes over most of the inhabited
 * world and never the poles.
 */
export function formatInclination(degrees: number | null): Row | null {
  if (degrees === null || !Number.isFinite(degrees)) return null;
  const reach = Math.min(90, Math.abs(degrees) > 90 ? 180 - Math.abs(degrees) : Math.abs(degrees));
  return {
    label: 'Inclination',
    value: `${degrees.toFixed(1)}°`,
    note:
      reach < 1
        ? 'stays over the equator'
        : `never passes north of ${reach.toFixed(0)}° or south of −${reach.toFixed(0)}°`,
  };
}

/**
 * How old the orbital elements are, and whether that is worth worrying about.
 *
 * The most important row in the panel, and the least obvious. SGP4 degrades by
 * roughly a kilometre a day from epoch and **it degrades silently** — the
 * position stays precisely formatted and confident while becoming wrong. The
 * ingestion layer refuses anything past seven days (D94), so what reaches here
 * is always usable; this says how usable.
 */
export function formatElementAge(days: number | null): Row | null {
  if (days === null || !Number.isFinite(days)) return null;
  const value =
    days < 1 / 24
      ? 'minutes ago'
      : days < 1
        ? `${Math.round(days * 24)} hours ago`
        : `${days.toFixed(1)} days ago`;
  return {
    label: 'Orbit measured',
    value,
    note:
      days < 1
        ? 'position accurate to about a kilometre'
        : `drifts about ${Math.round(days)} km from the true position`,
  };
}

function numberFrom(meta: Record<string, string>, key: string): number | null {
  const raw = meta[key];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every row the panel shows for a satellite, in order.
 *
 * Rows that cannot be filled are **omitted rather than blanked**: a labelled
 * empty value reads as missing data, when the honest statement is that the
 * question does not apply.
 */
export function satelliteRows(detail: TrackedObjectDetail): Row[] {
  const meta = detail.meta ?? {};
  const rows: Row[] = [
    { label: 'Catalogue number', value: `NORAD ${detail.id}` },
  ];

  // What kind of machine it is, from its name - the same classification the
  // silhouette on the map is drawn from, so the panel and the picture agree
  // (D101). "Unidentified object" is a real and common answer.
  const family = familyFor(detail.label);
  rows.push({ label: 'Type', value: FAMILY_LABEL[family] });

  const regime = regimeName(detail.altitude);
  if (regime) rows.push({ label: 'Orbit', value: regime });

  rows.push({
    label: 'Altitude',
    value: formatAltitude(detail.altitude),
    // Said explicitly because both renderers distort it, and a reader
    // comparing this number against the picture deserves to know which one is
    // the measurement.
    note: 'true altitude; the view compresses it to fit',
  });

  rows.push({ label: 'Speed', value: formatSpeed(detail.velocity) });

  const period = formatPeriod(numberFrom(meta, 'periodMinutes'));
  if (period) {
    rows.push({ label: 'Orbital period', value: period, note: 'one lap of the planet' });
  }

  const inclination = formatInclination(numberFrom(meta, 'inclinationDeg'));
  if (inclination) rows.push(inclination);

  const age = formatElementAge(numberFrom(meta, 'elementAgeDays'));
  if (age) rows.push(age);

  const source = meta.elementSource;
  if (source) rows.push({ label: 'Elements from', value: source });

  return rows;
}

/** Meta keys `satelliteRows` already renders, so the generic list skips them. */
export const SATELLITE_META_SHOWN = new Set([
  'inclinationDeg',
  'periodMinutes',
  'elementAgeDays',
  'elementSource',
  'elementEpoch',
]);
