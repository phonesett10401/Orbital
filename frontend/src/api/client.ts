/**
 * The only module that knows the backend speaks HTTP.
 *
 * Everything above this consumes typed values. That is what would let the
 * transport change — to WebSockets, say — without touching the globe or the
 * components.
 *
 * The client never talks to OpenSky. All external calls go through our
 * backend, so rate limiting and caching happen in exactly one place and a
 * hundred open tabs cost the same quota as one (D7).
 */

import { config } from '../config';
import type {
  BoundingBox,
  HealthResponse,
  ObjectListResponse,
  SearchResponse,
  TrackedObjectDetail,
} from '../types';
import type { MoonSnapshot } from '../moonSatellites';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Serialize a box the way the backend parses it: latMin,lonMin,latMax,lonMax. */
export function formatBbox(bbox: BoundingBox): string {
  return [bbox.latMin, bbox.lonMin, bbox.latMax, bbox.lonMax]
    .map((n) => n.toFixed(4))
    .join(',');
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}${path}`, { signal });
  } catch (error) {
    // A network failure here means our own backend is unreachable, which is a
    // different problem from OpenSky being down — the backend absorbs that one
    // and still answers 200 with stale data.
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(`cannot reach the Orbital backend: ${(error as Error).message}`, null);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Non-JSON error body; the status text will do.
    }
    throw new ApiError(detail, response.status);
  }

  return (await response.json()) as T;
}

/**
 * A POST that carries the session cookie (D148).
 *
 * `credentials: 'same-origin'` is fetch's default and is stated anyway, because
 * the whole sign-in depends on it and a default is a thing somebody changes.
 * The dev server proxies `/api`, so the backend is same-origin and the cookie
 * travels; **a deployment that puts the API on another origin needs
 * `include` here and `allow_credentials` plus an explicit origin list on the
 * backend** - a cookie is never sent cross-origin by accident, which is the
 * point of the rule and the thing that will look like a broken login.
 */
async function post<T>(path: string, body?: unknown): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(`cannot reach the Orbital backend: ${(error as Error).message}`, null);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = await response.json();
      if (typeof parsed?.detail === 'string') detail = parsed.detail;
    } catch {
      // Non-JSON error body; the status text will do.
    }
    throw new ApiError(detail, response.status);
  }

  // 204 on sign-out, which has no body to parse.
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

export interface AccountView {
  email: string;
  tier: string;
}

export interface MeResponse {
  account: AccountView | null;
}

/** Who is signed in, if anyone. Answers 200 with a null account when nobody is. */
export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me', signal);
}

export function register(email: string, password: string): Promise<MeResponse | null> {
  return post<MeResponse>('/api/auth/register', { email, password });
}

export function signIn(email: string, password: string): Promise<MeResponse | null> {
  return post<MeResponse>('/api/auth/login', { email, password });
}

/**
 * Move this account between free and premium (D157).
 *
 * A POST rather than a GET because it changes something, and through `post` so
 * it carries the session cookie - the server decides from the session who is
 * asking, and there is deliberately no account id in the call.
 */
export function changeTier(tier: 'free' | 'premium'): Promise<MeResponse | null> {
  return post<MeResponse>('/api/auth/subscription', { tier });
}

export function signOut(): Promise<null> {
  return post<null>('/api/auth/logout') as Promise<null>;
}

export interface FetchObjectsOptions {
  bbox?: BoundingBox | null;
  limit?: number;
  signal?: AbortSignal;
  /**
   * Compute positions for this instant rather than now, as epoch milliseconds.
   *
   * Satellites only: their positions are computed, so any instant within the
   * elements' accuracy window is as cheap as the present one. An aircraft
   * position is observed, so there is nothing to ask for (D119).
   */
  at?: number | null;
}

/**
 * Fetch the objects in a layer.
 *
 * Passing a bbox does two things: it filters the response, and it tells the
 * backend where the user is looking, which is what drives the fast tier 2 poll
 * (D21). So sending the current viewport is not merely an optimization — it is
 * how the region under inspection stays fresh.
 */
export function fetchObjects(
  resource: string,
  { bbox, limit, signal, at }: FetchObjectsOptions = {},
): Promise<ObjectListResponse> {
  const params = new URLSearchParams();
  if (bbox) params.set('bbox', formatBbox(bbox));
  // `toISOString` always ends in `Z`, so there is no `+` to be eaten by the
  // query string - the backend tolerates one anyway, having been bitten.
  if (at != null) params.set('at', new Date(at).toISOString());
  params.set('limit', String(limit ?? config.maxObjects));
  return request<ObjectListResponse>(`/api/${resource}?${params}`, signal);
}

export function fetchObjectDetail(
  resource: string,
  id: string,
  signal?: AbortSignal,
): Promise<TrackedObjectDetail> {
  return request<TrackedObjectDetail>(
    `/api/${resource}/${encodeURIComponent(id)}`,
    signal,
  );
}

/**
 * Search by callsign or identifier.
 *
 * Server-side because the client only holds what is in its viewport, and
 * finding a flight by callsign has to work for one on the other side of the
 * world.
 */
export function searchObjects(
  resource: string,
  query: string,
  signal?: AbortSignal,
): Promise<ObjectListResponse> {
  const params = new URLSearchParams({ q: query, limit: '20' });
  return request<ObjectListResponse>(`/api/${resource}/search?${params}`, signal);
}

/**
 * Search aircraft and airports together.
 *
 * One request rather than two, because this fires on every keystroke and the
 * ranking of each kind belongs on the server, next to the data.
 */
export function search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: '8' });
  return request<SearchResponse>(`/api/search?${params}`, signal);
}

/**
 * The spacecraft in orbit around the Moon.
 *
 * No bounding box and no thinning: there are three of them, and every argument
 * the aircraft endpoint carries exists to survive eleven thousand (D134).
 */
export function fetchMoonSatellites(signal?: AbortSignal): Promise<MoonSnapshot> {
  return request<MoonSnapshot>('/api/moon/satellites', signal);
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', signal);
}
