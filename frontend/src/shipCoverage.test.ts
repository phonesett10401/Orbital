import { describe, expect, it } from 'vitest';

import { shipCoverage } from './shipCoverage';

describe('shipCoverage', () => {
  it('says coastal waters while the global stream is running', () => {
    expect(shipCoverage('digitraffic+aisstream')?.where).toBe('ships in coastal waters');
  });

  it('says the northern Baltic when Digitraffic is the whole of it', () => {
    // The deployment setting that produces this is a memory budget, not an
    // outage - so the wording has to describe a smaller map rather than a
    // broken one.
    expect(shipCoverage('digitraffic')?.where).toBe('ships in the northern Baltic');
  });

  it('follows the feed rather than an order of names', () => {
    // The backend joins the sources it used; nothing promises which comes
    // first, and a rule that depended on that would break silently on a day
    // the string was assembled differently.
    expect(shipCoverage('aisstream+digitraffic')?.where).toBe(shipCoverage('digitraffic+aisstream')?.where);
  });

  it('never claims to cover everywhere', () => {
    // Both sources are shore-based. "Global" would be a claim about the open
    // ocean that neither feed can make (D166).
    for (const source of ['digitraffic', 'digitraffic+aisstream']) {
      const answer = shipCoverage(source);
      expect(answer).not.toBeNull();
      expect(answer!.where.toLowerCase()).not.toContain('every');
      expect(answer!.where.toLowerCase()).not.toContain('all ships');
      expect(answer!.note).toMatch(/receiver|listened/);
    }
  });

  it('says nothing at all about a feed it does not recognise', () => {
    // Guessing the scope of an unknown source is how a map ends up making a
    // confident claim about sea it has never heard from.
    for (const source of [null, undefined, '', 'someone-elses-feed']) {
      expect(shipCoverage(source)).toBeNull();
    }
  });
});
