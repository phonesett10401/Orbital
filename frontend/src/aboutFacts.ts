/**
 * What the About page says, as data rather than as markup (D177).
 *
 * A page about the project is the easiest place in the application to write
 * something flattering and untrue, so what it claims is kept where it can be
 * read on its own and checked against the rest of the repository. Every line
 * here is a fact already recorded somewhere else - the sources and their terms
 * from the survey that chose them (D165, D166), the refusals from the decisions
 * that made them.
 *
 * The counts are deliberately **not** here. They move - aircraft and ships by
 * the minute - and the last time a figure was copied into a document it was
 * stale within three sessions and wrong on the day it was written. The page
 * asks the running system instead.
 */

/** One of the three things on the map. */
export interface Layer {
  name: string;
  /** Which API total belongs to it, so the live count cannot be mislabelled. */
  resource: 'aircraft' | 'satellites' | 'ships';
  /** How the position is arrived at. This is the distinction the map is built on. */
  origin: string;
}

/**
 * The three layers, and where each position comes from.
 *
 * The `origin` line is the whole point of the project rather than a caption:
 * two of these are **observed** and one is **computed**, and a map that showed
 * them identically would be claiming the same confidence about both.
 */
export const LAYERS: readonly Layer[] = [
  {
    name: 'Aircraft',
    resource: 'aircraft',
    origin: 'Observed. Broadcast by the aircraft, heard by a receiver on the ground.',
  },
  {
    name: 'Ships',
    resource: 'ships',
    origin: 'Observed. Broadcast over AIS, heard from the shore - which is why coverage is coastal.',
  },
  {
    name: 'Satellites',
    resource: 'satellites',
    origin: 'Computed. Propagated from published orbital elements, not observed at all.',
  },
];

/** One upstream, and the terms it comes on. */
export interface Source {
  name: string;
  provides: string;
  /** The licence, in the words the licence uses. */
  terms: string;
}

/**
 * Where everything on the map comes from.
 *
 * Named with their terms because the terms are the interesting part, and two of
 * them are load-bearing: OpenSky forbids commercial use, which is the finding
 * that constrains what this project could ever become, and aisstream states
 * nothing at all - which is not the same as permitting anything (D165).
 */
export const SOURCES: readonly Source[] = [
  { name: 'adsb.lol', provides: 'Aircraft', terms: 'Open Database Licence' },
  { name: 'OpenSky Network', provides: 'Aircraft', terms: 'Free, non-commercial only' },
  { name: 'Digitraffic', provides: 'Ships, the Baltic', terms: 'CC BY 4.0' },
  { name: 'aisstream.io', provides: 'Ships, worldwide', terms: 'Free, terms unstated' },
  { name: 'CelesTrak · SatNOGS', provides: 'Orbital elements', terms: 'Free' },
  { name: 'NASA GIBS · OpenFreeMap', provides: 'Imagery and map tiles', terms: 'Open' },
];

/** Something the map deliberately does not say, and why. */
export interface Refusal {
  claim: string;
  reason: string;
}

/**
 * The things this map will not tell you.
 *
 * Not modesty and not a disclaimer: each one is a decision with a defect behind
 * it. A tracker's failure mode is drawing something confident where it has
 * nothing, and every line here is a place that was caught doing it.
 */
export const REFUSALS: readonly Refusal[] = [
  {
    claim: 'A marker older than two minutes is still where it says',
    reason: 'It fades instead. The aircraft moved; nobody told us where.',
  },
  {
    claim: 'Everything out there is on this map',
    reason:
      'Only what a receiver heard. Oceans are thin in every terrestrial network, and the footer says how much of the sky it is showing you.',
  },
  {
    claim: 'This object is pointing that way',
    reason:
      'One with no transmitted heading is drawn as a disc rather than an arrow. An arrow with nothing behind it points north and means nothing.',
  },
  {
    claim: 'A satellite position is as fresh as an aircraft position',
    reason:
      'It has no age at all - it is computed for the instant you asked. What it has instead is the age of the elements, which is shown.',
  },
  {
    claim: 'Any of this predicts where something is going',
    reason: 'Orbital reports observations. It does not forecast, and a track is where a thing has been.',
  },
];

/** One row of the build block: a label and the fact beside it. */
export interface Fact {
  label: string;
  value: string;
}

/**
 * How the thing is put together.
 *
 * Only what does not move. Anything that changes as the software runs belongs
 * in the live block, and the difference between the two is why there are two.
 */
export const BUILD: readonly Fact[] = [
  { label: 'Map', value: 'MapLibre GL JS, one globe from orbit to street level' },
  { label: 'In three dimensions', value: 'three.js, inside the map’s own WebGL context' },
  { label: 'Frontend', value: 'React · TypeScript' },
  { label: 'Backend', value: 'FastAPI · Python' },
  { label: 'Orbits', value: 'SGP4, computed per request rather than stored' },
  { label: 'Course', value: 'CSC480' },
];

/**
 * The live counts as text.
 *
 * `null` becomes an em dash rather than a zero. Zero is a claim - it says the
 * sky is empty - and "not known yet" is a different thing the page has no
 * business dressing up as data.
 */
export function countText(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-GB');
}
