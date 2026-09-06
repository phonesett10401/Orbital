import { describe, expect, it } from 'vitest';

import { currentVisibility, needsWrite, setVisibility } from './layerSync';

function fakeMap(state: Record<string, unknown>) {
  const writes: [string, unknown][] = [];
  return {
    writes,
    getLayer: (id: string) => (id in state ? { id } : undefined),
    getLayoutProperty: (id: string) => state[id],
    setLayoutProperty: (id: string, _name: string, value: unknown) => {
      state[id] = value;
      writes.push([id, value]);
    },
  };
}

describe('reading what the style actually says', () => {
  it('treats a layer that was never set as visible', () => {
    // MapLibre returns undefined for an unset property and the spec's default
    // is visible. Treating that as "unknown" would write to every such layer
    // once per frame, forever.
    expect(currentVisibility(undefined)).toBe('visible');
    expect(needsWrite(undefined, 'visible')).toBe(false);
    expect(needsWrite(undefined, 'none')).toBe(true);
  });

  it('reads the two words the style uses', () => {
    expect(currentVisibility('none')).toBe('none');
    expect(currentVisibility('visible')).toBe('visible');
  });
});

describe('writing only where it differs', () => {
  it('writes nothing when everything already agrees', () => {
    const map = fakeMap({ a: 'none', b: 'none' });
    expect(setVisibility(map, ['a', 'b'], 'none')).toEqual([]);
    expect(map.writes).toEqual([]);
  });

  it('writes only the layer that disagrees', () => {
    const map = fakeMap({ a: 'none', b: 'visible' });
    expect(setVisibility(map, ['a', 'b'], 'none')).toEqual(['b']);
  });

  it('skips a layer the style does not have', () => {
    // Custom layers and layers from a style that failed to load are both
    // absent, and `setLayoutProperty` on a missing layer throws.
    const map = fakeMap({ a: 'visible' });
    expect(() => setVisibility(map, ['a', 'missing'], 'none')).not.toThrow();
    expect(map.writes).toEqual([['a', 'none']]);
  });

  it('notices a change made by somebody else', () => {
    // **The bug.** A memo of what was last asked for says "no change" after
    // another writer - `applyBody`, returning from the solar system - has put
    // the layer back. Reading the map rather than the memo is what sees it, and
    // this test is the difference between the two (D154).
    const state: Record<string, unknown> = { ground: 'none' };
    const map = fakeMap(state);
    expect(setVisibility(map, ['ground'], 'none')).toEqual([]);

    state.ground = 'visible'; // applyBody, on the way back from the solar view
    expect(setVisibility(map, ['ground'], 'none')).toEqual(['ground']);
  });
});
