/**
 * Where the ships layer is actually looking, read off the feed it is using.
 *
 * The layer has two sources and they cover wildly different amounts of sea.
 * Digitraffic is Finland's, and alone it is the northern Baltic; aisstream adds
 * a global stream that measured **17,848 vessels against Digitraffic's 643**
 * (D165, D166). Whether the second one is running is a deployment setting, so
 * the map can be showing either on any given day.
 *
 * `layerChrome` answers this by not answering: "ships in coastal waters" was
 * chosen because it is the one phrase true of both, and that was the right call
 * for a subtitle that could not know. **This can know.** The backend already
 * names the feeds it combined, so the scope is derived rather than declared -
 * and it corrects itself the day the global stream is switched back on, instead
 * of becoming a claim nobody remembers to update (D191).
 *
 * Neither answer says "everywhere". Both sources are *terrestrial* AIS,
 * listening from the shore, so the holes are the open ocean and every coast
 * without a receiver - the Indian Ocean returned 2 vessels and the Gulf
 * returned 0.
 */

export interface ShipCoverage {
  /** Short enough to sit in a subtitle. */
  where: string;
  /** The reason, for a tooltip - why this is the answer and not "the world". */
  note: string;
}

/** The global stream. Named in the source string when it is running. */
const GLOBAL_FEED = 'aisstream';

/** Finland's own AIS, which is the fallback and always present. */
const BALTIC_FEED = 'digitraffic';

export function shipCoverage(source: string | null | undefined): ShipCoverage | null {
  if (typeof source !== 'string') return null;
  const feeds = source.toLowerCase();

  if (feeds.includes(GLOBAL_FEED)) {
    return {
      where: 'ships in coastal waters',
      note:
        'Terrestrial AIS from a global network of shore receivers. Coastal rather ' +
        'than complete: the open ocean is out of range, and so is every coast ' +
        'without a receiver.',
    };
  }

  if (feeds.includes(BALTIC_FEED)) {
    return {
      where: 'ships in the northern Baltic',
      note:
        "Finland's own AIS network, which is the whole of this feed right now - " +
        'the global stream is switched off. Vessels elsewhere are not missing; ' +
        'they are not being listened for.',
    };
  }

  // A feed name nobody here recognises. Saying nothing beats guessing at the
  // scope of a source we cannot identify.
  return null;
}
