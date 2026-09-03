/**
 * The picture at the top of a satellite's detail panel.
 *
 * Deliberately **not** the same component as the aircraft photograph, because
 * the two make different claims and the difference matters more than the code
 * they would share (D118).
 *
 * An aircraft photo is of *that airframe* - a spotter photographed G-STBO. A
 * satellite picture comes from SatNOGS's directory and is frequently of the
 * mission, the class, or an engineering model rather than the object now
 * overhead; nobody photographs a cubesat at 500 km. Captioning it the way the
 * aircraft panel does would assert something untrue, so this says *"pictured
 * by SatNOGS"* rather than implying it is a photograph of this object taken in
 * orbit.
 *
 * There is no fetch here. The URL arrives in the record's meta, because the
 * backend already reads the SatNOGS directory to resolve names (D117) and the
 * row carrying a name carries the picture too. Unlike the aircraft photos,
 * whose terms forbid proxying, SatNOGS data is CC BY-SA 4.0 - attribution and
 * share-alike - so the credit below is the licence being honoured, not
 * decoration.
 *
 * Two objects in three have no picture. That is the ordinary case and is drawn
 * as an answer, at the same height, so the panel does not jump.
 */

const SATNOGS_LICENCE = 'https://creativecommons.org/licenses/by-sa/4.0/';

export function SatellitePhoto({ imageUrl }: { imageUrl?: string }) {
  if (!imageUrl) {
    return <div className="panel__photo panel__photo--none">No picture of this satellite</div>;
  }

  return (
    <figure className="panel__photo">
      <img src={imageUrl} alt="" loading="lazy" />
      <figcaption>
        <span className="panel__photo-credit">Pictured by SatNOGS</span>
        <a href={SATNOGS_LICENCE} target="_blank" rel="noopener">
          CC BY-SA
        </a>
      </figcaption>
    </figure>
  );
}
