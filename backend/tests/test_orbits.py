"""Tests for turning orbital elements into positions.

Every element set here is committed. Nothing in this file touches the network,
which matters more than usual: the source these came from was returning HTTP
500 on the day this was written, and a test suite that depended on it would
have been red for reasons that had nothing to do with our code.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from app.orbits import (
    MAX_ELEMENT_AGE_DAYS,
    OrbitError,
    parse_epoch,
    propagate,
    teme_to_geodetic,
    tle_epoch,
)

# The ISS, from SatNOGS on 2026-09-01. A well known orbit: about 420 km up,
# 7.66 km/s, inclined 51.6 degrees, going round every 93 minutes -- so every
# number it produces can be checked against something a reader already knows.
ISS_1 = "1 25544U 98067A   26243.85334329  .00004554  00000-0  90917-4 0  9992"
ISS_2 = "2 25544  51.6329 265.6262 0002466 296.1188  63.9528 15.50139429532104"
ISS_EPOCH = datetime(2026, 8, 31, 20, 28, 48, tzinfo=timezone.utc)

# A geostationary satellite from the official SGP4 verification set. Zero
# inclination, one revolution per sidereal day. Used for the longitude test
# below, which is the reason this file exists in the shape it does.
GEO_1 = "1 25954U 99060A   04039.68057285 -.00000108  00000-0  00000-0 0  6847"
GEO_2 = "2 25954   0.0004 243.8136 0001765  15.5294  22.7134  1.00271289 16053"


def at(days_after_epoch: float, epoch: datetime) -> datetime:
    return epoch + timedelta(days=days_after_epoch)


class TestEpochParsing:
    def test_omm_epoch_is_utc_even_though_it_is_unmarked(self):
        # Neither CelesTrak nor SatNOGS marks the zone. A naive datetime here
        # breaks every staleness comparison downstream, silently.
        parsed = parse_epoch("2026-08-31T20:28:48.859000")
        assert parsed.tzinfo is timezone.utc

    def test_tle_two_digit_year_follows_the_tle_convention_not_the_obvious_one(self):
        # 57-99 mean 19xx. Reading "75" as 2075 turns a fifty-year-old element
        # set into a future one -- stale data made to look fresh, which is the
        # dangerous direction to be wrong in.
        old = tle_epoch("1 00005U 58002B   75179.78495062  .00000023  00000-0  28098-4 0  4753")
        assert old.year == 1975

    def test_a_modern_epoch_reads_as_this_century(self):
        assert tle_epoch(ISS_1).year == 2026

    def test_the_iss_epoch_matches_the_line_it_came_from(self):
        assert abs((tle_epoch(ISS_1) - ISS_EPOCH).total_seconds()) < 2.0


class TestPropagatingTheISS:
    """Numbers a reader can check without consulting anything."""

    def setup_method(self):
        self.pos = propagate(ISS_1, ISS_2, at(0.05, ISS_EPOCH))

    def test_altitude_is_a_low_earth_orbit(self):
        assert 380_000 < self.pos.altitude_m < 460_000

    def test_speed_is_orbital(self):
        assert 7_400 < self.pos.speed_m_s < 7_900

    def test_position_is_on_the_planet(self):
        assert -90 <= self.pos.lat <= 90
        assert -180 <= self.pos.lon <= 180

    def test_inclination_bounds_the_latitude_it_can_reach(self):
        # The ISS is inclined 51.6 degrees, so it physically cannot be over
        # the poles. Sampling a whole orbit catches a latitude/longitude swap,
        # which otherwise produces perfectly plausible-looking coordinates.
        lats = [
            propagate(ISS_1, ISS_2, at(minutes / 1440, ISS_EPOCH)).lat
            for minutes in range(0, 95, 5)
        ]
        assert max(abs(lat) for lat in lats) <= 52.5
        # And it should actually get near that limit within one orbit, or the
        # bound above would pass for a satellite stuck on the equator.
        assert max(abs(lat) for lat in lats) > 45.0

    def test_heading_is_present_and_in_range(self):
        # An object with no heading gets no oriented model (D18, D40, D42).
        assert 0.0 <= self.pos.heading_deg < 360.0


class TestTheEarthRotationAngle:
    """The check that catches the classic error in this conversion.

    Converting SGP4's inertial output to latitude and longitude needs the
    Earth's rotation angle. Leave it out and everything still looks right --
    correct altitude, correct speed, a ground track of the correct shape --
    but the longitude is wrong by up to 180 degrees, and nothing in the numbers
    says so. A geostationary satellite is the one case where the error is
    unmissable: it must hold its longitude, and without the angle it sweeps a
    full 360 degrees a day.
    """

    def test_a_geostationary_satellite_holds_its_longitude_for_a_day(self):
        epoch = tle_epoch(GEO_1)
        samples = [
            propagate(GEO_1, GEO_2, epoch + timedelta(hours=h), epoch=epoch)
            for h in range(0, 25, 3)
        ]

        # Unwrap before measuring, so a pass across the antimeridian is not
        # mistaken for a full rotation.
        lons = [s.lon for s in samples]
        unwrapped = [lons[0]]
        for value in lons[1:]:
            while value - unwrapped[-1] > 180:
                value -= 360
            while value - unwrapped[-1] < -180:
                value += 360
            unwrapped.append(value)

        assert max(unwrapped) - min(unwrapped) < 1.0

    def test_a_geostationary_satellite_stays_over_the_equator(self):
        epoch = tle_epoch(GEO_1)
        lats = [
            propagate(GEO_1, GEO_2, epoch + timedelta(hours=h), epoch=epoch).lat
            for h in range(0, 25, 3)
        ]
        assert max(abs(lat) for lat in lats) < 1.0

    def test_geostationary_altitude_is_the_textbook_figure(self):
        epoch = tle_epoch(GEO_1)
        pos = propagate(GEO_1, GEO_2, epoch, epoch=epoch)
        assert abs(pos.altitude_m - 35_786_000) < 500_000

    def test_the_conversion_actually_uses_the_angle(self):
        # Guards the test above from becoming vacuous: if teme_to_geodetic ever
        # stops rotating, two Julian dates twelve hours apart would return the
        # same longitude for the same inertial vector. They must not.
        vector = (42164.0, 0.0, 0.0)  # geostationary radius, on the x axis
        _, lon_a, _ = teme_to_geodetic(vector, 2453045.0, 0.0)
        _, lon_b, _ = teme_to_geodetic(vector, 2453045.0, 0.5)
        separation = abs((lon_a - lon_b + 180) % 360 - 180)
        assert separation > 170  # half a day of rotation


class TestRefusingWhatCannotBeTrusted:
    """Refusal is the feature. SGP4 answers confidently either way."""

    def test_elements_older_than_the_limit_are_refused(self):
        with pytest.raises(OrbitError, match="days from epoch"):
            propagate(ISS_1, ISS_2, at(MAX_ELEMENT_AGE_DAYS + 1, ISS_EPOCH))

    def test_a_1975_element_set_is_refused_rather_than_answered(self):
        # This is not hypothetical: the SatNOGS feed carried element sets this
        # old on the day the satellite layer was designed (D94).
        with pytest.raises(OrbitError):
            propagate(
                "1 00005U 58002B   75179.78495062  .00000023  00000-0  28098-4 0  4753",
                "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667",
                datetime(2026, 9, 1, tzinfo=timezone.utc),
            )

    def test_elements_from_the_future_are_refused_too(self):
        # A negative age is a corrupt epoch, not a fresh one. Checking only the
        # positive direction would let a mis-parsed two-digit year through.
        with pytest.raises(OrbitError, match="days from epoch"):
            propagate(ISS_1, ISS_2, at(-MAX_ELEMENT_AGE_DAYS - 1, ISS_EPOCH))

    def test_within_the_limit_is_accepted(self):
        assert propagate(ISS_1, ISS_2, at(MAX_ELEMENT_AGE_DAYS - 0.5, ISS_EPOCH))

    def test_element_age_travels_with_the_position(self):
        pos = propagate(ISS_1, ISS_2, at(2.0, ISS_EPOCH))
        assert 1.9 < pos.element_age_days < 2.1

    def test_a_malformed_element_set_raises_rather_than_returning_nonsense(self):
        with pytest.raises(OrbitError):
            propagate("not a tle", "nor is this", datetime.now(timezone.utc))


class TestAccuracyDegradesWithAge:
    def test_the_same_moment_computed_from_older_elements_drifts(self):
        # Not a correctness test -- a claim about *why* the age limit exists.
        # The same instant, propagated from elements 6 days apart in age,
        # should not land in the same place.
        moment = at(6.0, ISS_EPOCH)
        fresh = propagate(ISS_1, ISS_2, at(0.01, ISS_EPOCH))
        stale = propagate(ISS_1, ISS_2, moment)
        assert (fresh.lat, fresh.lon) != (stale.lat, stale.lon)
        assert math.isfinite(stale.altitude_m)
