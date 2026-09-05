/**
 * The three spacecraft in orbit around the Moon (D134).
 *
 * Not satellites in the sense the rest of this app means it. Earth's are
 * propagated locally from orbital elements by SGP4; these cannot be, because
 * SGP4 and the TLE format are Earth-orbit only and a TLE has nowhere to put a
 * different central body. Their positions come from JPL Horizons through
 * Orbital's own backend - Horizons sends no CORS header, so the browser cannot
 * ask it directly even if it should.
 *
 * What arrives is already selenographic: latitude, longitude and an altitude
 * above the Moon's surface, in the frame the lunar basemap is drawn in. The
 * backend does the asking; this does the drawing.
 *
 * ## Three is the whole layer
 *
 * There is no thinning, no bounding box and no viewport scoping, because there
 * are three of them. Every mechanism the aircraft layer needs exists to survive
 * eleven thousand objects arriving ten times a minute; none of it earns its
 * place here, and adding it because the other layers have it would be
 * cargo-culting the shape of a problem this layer does not have.
 */

export interface MoonSatellite {
  id: string;
  name: string;
  operator: string;
  purpose: string;
  lat: number;
  lon: number;
  altitudeKm: number;
}

export interface MoonSnapshot {
  objects: MoonSatellite[];
  generatedAt: string;
  source: string;
}

/**
 * A spacecraft is only drawn if it has a real position.
 *
 * The backend leaves out anything whose ephemeris window has run out, so a
 * missing spacecraft means "not known right now" rather than "gone". This
 * guards the wire shape rather than the meaning: a malformed row would
 * otherwise draw at null island, which is a specific and confident lie.
 */
export function isDrawable(craft: Partial<MoonSatellite> | null | undefined): boolean {
  if (!craft) return false;
  if (typeof craft.lat !== 'number' || typeof craft.lon !== 'number') return false;
  if (!Number.isFinite(craft.lat) || !Number.isFinite(craft.lon)) return false;
  if (Math.abs(craft.lat) > 90 || Math.abs(craft.lon) > 180) return false;
  return typeof craft.id === 'string' && craft.id.length > 0;
}

export function drawable(objects: MoonSatellite[]): MoonSatellite[] {
  return objects.filter(isDrawable);
}

/**
 * The altitude, said the way the panel says everything else.
 *
 * Kilometres with no decimal: these orbit between about 60 and 250 km, where a
 * tenth of a kilometre is far below the accuracy of a one-minute interpolation
 * and reads as precision the number does not have.
 */
export function describeAltitude(km: number): string {
  return `${Math.round(km)} km above the Moon`;
}

/** What the marker says. The operator matters here - three craft, three flags. */
export function describeCraft(craft: MoonSatellite): string {
  return `${craft.name} (${craft.operator})`;
}

export interface MoonFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      label: string;
      operator: string;
      purpose: string;
      altitudeKm: number;
    };
  }>;
}

export function toFeatures(objects: MoonSatellite[]): MoonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: drawable(objects).map((craft) => ({
      type: 'Feature',
      id: craft.id,
      geometry: { type: 'Point', coordinates: [craft.lon, craft.lat] },
      properties: {
        id: craft.id,
        label: craft.name,
        operator: craft.operator,
        purpose: craft.purpose,
        altitudeKm: craft.altitudeKm,
      },
    })),
  };
}
