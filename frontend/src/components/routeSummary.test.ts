import { describe, expect, it } from 'vitest';

import { legLabel, summariseRoute } from './routeSummary';
import type { Airport, FlightRoute, TrackedObjectDetail } from '../types';

function airport(overrides: Partial<Airport> = {}): Airport {
  return {
    icao: 'OMDB',
    name: 'Dubai International Airport',
    lat: 25.2528,
    lon: 55.3644,
    country: 'AE',
    municipality: 'Dubai',
    iata: 'DXB',
    distanceKm: null,
    ...overrides,
  };
}

const HANOI = airport({
  icao: 'VVNB',
  name: 'Noi Bai International Airport',
  municipality: 'Hanoi',
  iata: 'HAN',
});

function detail(
  route: FlightRoute | null,
  origin: Airport | null = null,
): Pick<TrackedObjectDetail, 'route' | 'origin'> {
  return { route, origin };
}

const EMIRATES = { code: 'UAE', name: 'Emirates' };

describe('whether there is a route to show', () => {
  it('shows one that names an airport', () => {
    const summary = summariseRoute(
      detail({ airline: 'Emirates', origin: airport(), destination: HANOI }),
      null,
    );
    expect(summary.scheduled?.destination?.icao).toBe('VVNB');
  });

  it('shows one that names only where the flight is going', () => {
    // adsbdb's rows are uneven, and half a route is still worth drawing.
    const summary = summariseRoute(
      detail({ airline: null, origin: null, destination: HANOI }),
      null,
    );
    expect(summary.scheduled).not.toBeNull();
  });

  it('shows nothing for a route that names nowhere', () => {
    // An operator with no airports duplicates the Airline field above it.
    const summary = summariseRoute(
      detail({ airline: 'Emirates', origin: null, destination: null }),
      null,
    );
    expect(summary.scheduled).toBeNull();
    expect(summary.operator).toBe('Emirates');
  });

  it('shows nothing when the callsign has no published route at all', () => {
    expect(summariseRoute(detail(null), null).scheduled).toBeNull();
  });
});

describe('which operator name wins', () => {
  it('prefers the published name over the one decoded from the callsign', () => {
    const summary = summariseRoute(detail({ airline: 'Emirates', origin: null, destination: null }), {
      code: 'UAE',
      name: 'United Arab Emirates Air Force',
    });
    expect(summary.operator).toBe('Emirates');
    expect(summary.operatorIsReported).toBe(true);
  });

  it('falls back to the decoded name when nothing is published', () => {
    const summary = summariseRoute(detail(null), EMIRATES);
    expect(summary.operator).toBe('Emirates');
    // The distinction drives the caveat: a decoded name needs the warning
    // about reassigned designators, a published one does not (D46).
    expect(summary.operatorIsReported).toBe(false);
  });

  it('has no name when neither source has one', () => {
    expect(summariseRoute(detail(null), null).operator).toBeNull();
  });
});

describe('when the schedule and the track disagree', () => {
  it('notices a different departure airport', () => {
    const summary = summariseRoute(
      detail({ airline: null, origin: airport(), destination: HANOI }, airport({ icao: 'VTBS' })),
      null,
    );
    expect(summary.originDisagrees).toBe(true);
  });

  it('says nothing when they agree', () => {
    const summary = summariseRoute(
      detail({ airline: null, origin: airport(), destination: HANOI }, airport()),
      null,
    );
    expect(summary.originDisagrees).toBe(false);
  });

  it('is not a disagreement when only one source has an origin', () => {
    // The common case by far: most flights have a schedule and no track back
    // to the runway, or the reverse. Neither is a contradiction.
    expect(
      summariseRoute(detail({ airline: null, origin: airport(), destination: null }), null)
        .originDisagrees,
    ).toBe(false);
    expect(summariseRoute(detail(null, airport()), null).originDisagrees).toBe(false);
  });
});

describe('naming one end of the route', () => {
  it('uses the code passengers see and the city, not the full airport name', () => {
    expect(legLabel(airport())).toEqual({ code: 'DXB', place: 'Dubai' });
  });

  it('falls back to what the database filled in', () => {
    expect(legLabel(airport({ iata: null, municipality: null }))).toEqual({
      code: 'OMDB',
      place: 'Dubai International Airport',
    });
  });

  it('says an unnamed end is unknown rather than rendering a blank', () => {
    expect(legLabel(null)).toEqual({ code: '???', place: 'Unknown' });
  });
});
