/**
 * Tests for what the planet view says when the map does not appear.
 *
 * The value of these is not that the strings are right — they are prose and
 * prose is checked by reading it. It is that the *classification* is right:
 * four kinds of failure that each ask something different of the reader, and a
 * fallback that never leaves them with nothing. A blank screen was the previous
 * behaviour for every one of them (defect #20).
 */

import { describe, expect, it } from 'vitest';

import {
  STALL_AFTER_MS,
  STALL_DETAIL,
  STALL_TITLE,
  classifyFailure,
} from './status';
import { hitsAt, selectionFromHits } from './aircraftLayer';
import { unrenderableMessage } from './container';

describe('classifyFailure', () => {
  it('names a blocked or missing basemap as such', () => {
    // What `loadPlanetStyle` throws on a bad response, verbatim.
    const failure = classifyFailure(new Error('https://tiles.openfreemap.org/styles/liberty: HTTP 503'));
    expect(failure.kind).toBe('basemap');
    // The aircraft still work, and a reader staring at a black screen has no
    // way to know that.
    expect(failure.detail).toMatch(/aircraft data is unaffected/);
  });

  it('recognises a dead network, which throws something else entirely', () => {
    expect(classifyFailure(new TypeError('Failed to fetch')).kind).toBe('basemap');
    expect(classifyFailure(new Error('NetworkError when attempting to fetch resource')).kind).toBe(
      'basemap',
    );
  });

  it('recognises the container collapse, and does not call it a network problem', () => {
    // The real message, from the helper that produces it - so this test breaks
    // if that wording changes, which is the point: it is the thing being matched.
    const failure = classifyFailure(new Error(unrenderableMessage({ width: 0, height: 0 })));
    expect(failure.kind).toBe('container');
    expect(failure.detail).toMatch(/layout problem/);
  });

  it('tells someone on an old browser what is actually wrong', () => {
    expect(classifyFailure(new Error('Failed to initialize WebGL')).kind).toBe('webgl');
    expect(classifyFailure(new Error('WebGL 2 is not supported')).detail).toMatch(/WebGL 2/);
  });

  it('always produces something readable, whatever it was handed', () => {
    // The fallback matters more than the specific cases: an unclassified
    // failure must still be a sentence, not an empty panel.
    for (const thrown of [undefined, null, 42, {}, 'boom', new Error('')]) {
      const failure = classifyFailure(thrown);
      expect(failure.kind).toBe('unknown');
      expect(failure.title.length).toBeGreaterThan(0);
      expect(failure.detail.length).toBeGreaterThan(0);
    }
  });

  it('keeps the thrown text for the report', () => {
    const failure = classifyFailure(new Error('HTTP 418'));
    expect(failure.cause).toBe('HTTP 418');
  });

  it('does not classify a stall as a failure', () => {
    // Different state, different words: a slow map may still arrive, and
    // replacing it with an error would be a lie a reload cannot fix.
    expect(STALL_AFTER_MS).toBeGreaterThan(10_000);
    expect(STALL_TITLE).not.toMatch(/fail|error/i);
    // The sentence that cost a session to learn (19.19).
    expect(STALL_DETAIL).toMatch(/background/);
  });
});

describe('selectionFromHits', () => {
  const hit = (id: unknown) => ({ properties: { id } });

  it('selects the first aircraft under the click', () => {
    expect(selectionFromHits([hit('abc123'), hit('def456')])).toBe('abc123');
  });

  it('selects nothing when the click missed', () => {
    expect(selectionFromHits([])).toBeNull();
    expect(selectionFromHits(null)).toBeNull();
    expect(selectionFromHits(undefined)).toBeNull();
  });

  it('skips features that carry no usable id', () => {
    // A hit with no id is not a reason to clear a selection the user made.
    expect(selectionFromHits([{ properties: null }, hit('real')])).toBe('real');
    expect(selectionFromHits([hit(''), hit(7), hit('real')])).toBe('real');
    expect(selectionFromHits([hit(undefined)])).toBeNull();
  });

  it('is the whole decision, so a click cannot select and deselect at once', () => {
    // The bug this replaced: one handler selected on a hit, a second deselected
    // on a miss, and the two ran on the same click against separate queries
    // (D69). Selecting is now one answer to one question.
    const answers = [selectionFromHits([hit('x')]), selectionFromHits([])];
    expect(answers).toEqual(['x', null]);
  });
});

describe('hitsAt', () => {
  it('asks for both aircraft layers, so a callsign click counts', () => {
    const asked: string[][] = [];
    const map = {
      queryRenderedFeatures: (_point: unknown, options: { layers: string[] }) => {
        asked.push(options.layers);
        return [{ properties: { id: 'a1' } }];
      },
    };
    expect(hitsAt(map, { x: 1, y: 2 })).toHaveLength(1);
    expect(asked[0]).toContain('orbital-aircraft');
    expect(asked[0]).toContain('orbital-aircraft-label');
  });

  it('answers "nothing" rather than throwing before the layers exist', () => {
    // MapLibre throws when asked about a layer that is not in the style yet,
    // and a click in the window between style load and our layers being added
    // must do nothing rather than take the view down.
    const map = {
      queryRenderedFeatures: () => {
        throw new Error("The layer 'orbital-aircraft' does not exist in the map's style");
      },
    };
    expect(hitsAt(map, { x: 0, y: 0 })).toEqual([]);
    expect(selectionFromHits(hitsAt(map, { x: 0, y: 0 }))).toBeNull();
  });
});
