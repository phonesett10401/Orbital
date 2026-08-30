import { describe, expect, it } from 'vitest';

import { generalMetaRows } from './panelFields';

/** A live adsb.lol aircraft's meta, as the by-id endpoint serves it. */
const JAL18 = {
  registration: 'JA866J',
  aircraftType: 'B789',
  category: 'A5',
  originCountry: 'Japan',
};

describe('the generic meta rows', () => {
  it('drops what the panel already shows in a row of its own', () => {
    // The defect: "Registration JA866J" appeared twice, four rows apart,
    // which reads as two different facts about the aircraft.
    const keys = generalMetaRows(JAL18).map(([key]) => key);
    expect(keys).not.toContain('registration');
    expect(keys).not.toContain('aircraftType');
  });

  it('drops the annotations printed beside the value they qualify', () => {
    // "from its track" sits next to the heading (D80). As a row it would say
    // "Heading Source: derived", which is the same claim in worse words.
    const keys = generalMetaRows({ headingSource: 'derived', velocitySource: 'derived' });
    expect(keys).toEqual([]);
  });

  it('keeps everything else, including fields no frontend knows about', () => {
    // The generic renderer exists so a provider can add a field without a
    // frontend change (D4). Hiding an unrecognised key would defeat it.
    const rows = generalMetaRows({ ...JAL18, somethingNew: 'value' });
    expect(rows).toEqual([
      ['category', 'A5'],
      ['originCountry', 'Japan'],
      ['somethingNew', 'value'],
    ]);
  });

  it('handles an aircraft with no meta at all', () => {
    expect(generalMetaRows({})).toEqual([]);
  });
});
