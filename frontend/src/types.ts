/**
 * The normalized data contract, mirrored from the backend.
 *
 * This file must be updated in the same commit as `backend/app/models.py`.
 * The mirror is maintained by hand rather than generated from the OpenAPI
 * schema: the contract is ten fields and changes rarely, and a codegen step
 * is another build stage that can break for a three-person team on a deadline
 * (D18).
 *
 * docs/data-contract.md is the authority on units and meaning.
 */

/**
 * Which layer an object belongs to.
 *
 * A union of two. It was carried as a union of one so the renderer could
 * discriminate if the backend ever served more than one kind of object —
 * retrofitting that into a contract spanning three layers is far worse than
 * carrying it from the start. Satellites arrived later (D93) and it cost one
 * line here. Adding a third member is a scope decision, not a code change.
 */
export type ObjectType = 'aircraft' | 'satellite';

/** One moving object at one instant. Source-agnostic by design (D4). */
export interface TrackedObject {
  /** Stable id, unique within a provider. For aircraft, the ICAO24 address. */
  id: string;
  /** Degrees north, WGS84. */
  lat: number;
  /** Degrees east, WGS84, in [-180, 180). */
  lon: number;
  /** Metres above mean sea level. `null` means unknown, never zero. */
  altitude: number | null;
  /**
   * Speed in metres per second. `null` means unknown. Ground speed for an
   * aircraft; orbital speed for a satellite, which is what every source quotes
   * and what a reader expects to see (D94).
   */
  velocity: number | null;
  /** Degrees clockwise from TRUE north. `null` means unknown. */
  heading: number | null;
  /** Short display name. For aircraft, the callsign; falls back to `id`. */
  label: string;
  /**
   * What the source says this is, in its own words. For aircraft, the ICAO
   * type designator such as `B789`. `null` for about a quarter of a live map,
   * because OpenSky's `/states/all` carries no type at all — and always `null`
   * for a satellite, whose catalogue answer is identical for every row we draw
   * (D94).
   */
  model: string | null;
  /**
   * RFC 3339 UTC. When this position was current.
   *
   * For an aircraft, when the SOURCE observed it — never when we polled. For a
   * satellite there is no observation: the position is computed, so this is the
   * instant it was propagated for. That distinction matters here, because the
   * renderer fades an object as this value ages (D71); putting the orbital
   * element epoch in this field would draw a kilometre-accurate satellite as a
   * ghost. Element age lives in `meta` instead (D94).
   */
  lastSeen: string;
  type: ObjectType;
}

/** One observed position on an object's route. */
export interface TrackPoint {
  lat: number;
  lon: number;
  altitude: number | null;
  timestamp: string;
}

/**
 * One object in full.
 *
 * `track` is the path we have OBSERVED since the object entered our polling
 * window — not a filed flight plan. It starts when we first saw the aircraft,
 * is lost when the backend restarts, and is truncated by a ring buffer. This
 * is a documented product limitation (D6), and the UI says so.
 */
/**
 * An airport the flight appears to have left from.
 *
 * Inferred, not reported: it is the nearest airport to the first point of the
 * aircraft's track, and `distanceKm` is how near. 0.3 km is an aircraft on a
 * runway; 6 km is one that was already climbing when the track began, and the
 * panel words itself accordingly (D78).
 */
export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  country: string | null;
  municipality: string | null;
  iata: string | null;
  /**
   * How far the track's first point was from this airport.
   *
   * `null` for an airport named by a *schedule* rather than inferred from a
   * track: nothing was measured, and a zero would claim otherwise (D88).
   */
  distanceKm: number | null;
}

/**
 * The route a callsign is scheduled to fly.
 *
 * **Scheduled, not observed**, and that is the whole reason it is separate
 * from `origin`. `origin` is where this aircraft's own track began; this is
 * what the callsign is published as flying, which is usually the same and
 * occasionally is not - a diversion, or a stale row in a community database.
 * It is the only place a *destination* can come from: an aircraft does not
 * transmit where it is going (D88).
 */
export interface FlightRoute {
  airline: string | null;
  origin: Airport | null;
  destination: Airport | null;
}

/**
 * Where a track came from.
 *
 * `observed` begins when *we* started watching, which for an aircraft selected
 * mid-flight is an arbitrary point in the sky. `provider` begins where the
 * flight did. The panel says something different for each, so it has to be
 * able to tell them apart.
 */
export type TrackSource = 'provider' | 'observed';

export interface TrackedObjectDetail extends TrackedObject {
  track: TrackPoint[];
  trackSource: TrackSource;
  origin: Airport | null;
  route: FlightRoute | null;
  /** Source-specific fields the universal shape omits, e.g. `originCountry`. */
  meta: Record<string, string>;
}

/** List responses carry freshness metadata, not a bare array. */
export interface ObjectListResponse {
  objects: TrackedObject[];
  type: ObjectType;
  source: string | null;
  fetchedAt: string | null;
  ageSeconds: number | null;
  /** True once the data is older than the backend's TTL, or never fetched. */
  stale: boolean;
  /** Objects matching the query BEFORE thinning. */
  total: number;
  /** Objects actually present in `objects`. */
  returned: number;
}

export interface JobHealth {
  name: string;
  tier: number;
  intervalSeconds: number;
  healthy: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  successfulPolls: number;
  failedPolls: number;
  skippedPolls: number;
  objectsLastPoll: number | null;
}

export interface QuotaHealth {
  preset: string;
  dailyAllowance: number;
  projectedDailyCredits: number;
  remainingCredits: number | null;
  throttle: 'normal' | 'reduced' | 'minimal' | 'critical' | 'exhausted';
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'starting';
  provider: string;
  polling: boolean;
  objectCount: number;
  stale: boolean;
  ageSeconds: number | null;
  lastSuccessAt: string | null;
  quota: QuotaHealth;
  jobs: JobHealth[];
}

/** A geographic bounding box. `lonMin > lonMax` wraps the antimeridian. */
export interface BoundingBox {
  latMin: number;
  lonMin: number;
  latMax: number;
  lonMax: number;
}

/**
 * A rendered object: the contract plus the client-side position we are
 * currently drawing, which is interpolated between polls (see globe/interpolate).
 *
 * `renderLat`/`renderLon` are never sent anywhere. They exist so the marker
 * layer can move smoothly while `lat`/`lon` remain the last thing the backend
 * actually told us.
 */
export interface RenderableObject extends TrackedObject {
  renderLat: number;
  renderLon: number;
  /** Position this object was drawn at when the latest update arrived. */
  fromLat: number;
  fromLon: number;
  /** Epoch ms when the latest update was applied, for easing. */
  updatedAt: number;
  /** Epoch ms parsed from `lastSeen`, cached to avoid re-parsing every frame. */
  lastSeenMs: number;
}

/** A selectable data layer. */
export interface LayerDescriptor {
  id: ObjectType;
  label: string;
  /** Path segment on the API, e.g. `aircraft`. */
  resource: string;
  /**
   * Whether this layer's requests carry the viewport.
   *
   * For aircraft this is not an optimisation: the bounding box is how the
   * backend learns where to spend its fast tier 2 credits (D21), and the
   * response is filtered to it because a live global fetch is large.
   *
   * For satellites it is neither. There is no credit model to aim - positions
   * are computed rather than fetched (D95) - and the whole catalogue is 350 KB.
   * Sending a viewport would buy nothing and cost a round trip every time the
   * globe turns, which is exactly what it did (D110).
   */
  viewportScoped: boolean;
}

/**
 * What one search box gets back.
 *
 * Two lists, not one ranked list. An aircraft is something being watched right
 * now and an airport is a place that is always there; the backend refuses to
 * invent a ranking between them, and the panel draws them as separate groups.
 */
export interface SearchResponse {
  aircraft: TrackedObject[];
  airports: Airport[];
  /**
   * Satellites whose name or catalogue number matches.
   *
   * A third list rather than merged into `aircraft`, for the reason the first
   * two are separate: any single ranking across different kinds of thing
   * invents a comparison that does not exist (D89, D103).
   */
  satellites: TrackedObject[];
}
