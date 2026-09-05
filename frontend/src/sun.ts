/**
 * Where the sun is, so the day/night terminator on the globe is real.
 *
 * Uses the NOAA low-precision solar position algorithm, which is accurate to
 * well under a degree for dates near our own — far better than needed, since
 * one degree of subsolar longitude is about four minutes of rotation and the
 * terminator is drawn as a soft gradient several degrees wide anyway.
 *
 * Kept as a pure function of a Date so it can be tested against known values
 * without a renderer. The equinox and solstice cases in sun.test.ts are the
 * ones worth checking: they have declinations everyone knows.
 */

const DEG = Math.PI / 180;

/** J2000.0 epoch: 2000-01-01T12:00:00Z. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const MS_PER_DAY = 86_400_000;

export interface SubsolarPoint {
  /** Latitude directly beneath the sun. Equals the solar declination. */
  lat: number;
  /** Longitude directly beneath the sun, in [-180, 180). */
  lon: number;
  /**
   * The sun's right ascension, in degrees.
   *
   * Exposed for `solarFrame.ts`, which needs Earth's rotation angle to orient
   * an inertial solar system inside MapLibre's Earth-fixed globe frame. The
   * sun is the one body whose position is known in *both* frames here - as a
   * right ascension and as a subsolar longitude - so their difference is the
   * rotation angle, and no separate sidereal-time routine is needed (D124).
   */
  rightAscension: number;
  /** Obliquity of the ecliptic at this date, in degrees. */
  obliquity: number;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function wrapLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

/**
 * The point on Earth's surface directly beneath the sun at `date`.
 *
 * The subsolar latitude is the solar declination, swinging between roughly
 * ±23.44° over the year. The subsolar longitude tracks UTC — the sun is over
 * the prime meridian at solar noon UTC — corrected by the equation of time,
 * which accounts for Earth's elliptical orbit and axial tilt and reaches about
 * ±16 minutes.
 */
export function subsolarPoint(date: Date): SubsolarPoint {
  const n = (date.getTime() - J2000_MS) / MS_PER_DAY;

  // Mean longitude and mean anomaly of the sun.
  const meanLongitude = normalizeDegrees(280.46 + 0.9856474 * n);
  const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * n);

  // Ecliptic longitude: mean longitude plus the equation of the centre.
  const eclipticLongitude =
    meanLongitude +
    1.915 * Math.sin(meanAnomaly * DEG) +
    0.02 * Math.sin(2 * meanAnomaly * DEG);

  const obliquity = 23.439 - 0.0000004 * n;

  const declination =
    Math.asin(Math.sin(obliquity * DEG) * Math.sin(eclipticLongitude * DEG)) / DEG;

  // Right ascension, kept in the same quadrant as the ecliptic longitude.
  const rightAscension =
    Math.atan2(
      Math.cos(obliquity * DEG) * Math.sin(eclipticLongitude * DEG),
      Math.cos(eclipticLongitude * DEG),
    ) / DEG;

  // Equation of time in minutes. The wrap keeps the difference in [-180, 180)
  // so it does not jump by 24 hours as right ascension crosses 360.
  const equationOfTime = 4 * wrapLongitude(meanLongitude - rightAscension);

  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;

  // Solar time runs 15 degrees per hour; the sun is over the meridian where
  // apparent solar time is noon.
  const lon = wrapLongitude(-((utcMinutes + equationOfTime) / 4 - 180));

  return { lat: declination, lon, rightAscension, obliquity };
}
