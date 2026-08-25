"""Regenerates the synthetic aircraft fixture.

The output (aircraft_sample.json) is committed; this script exists so the data
is reproducible and reviewable rather than a 157-object blob of unknown origin.
The seed is fixed, so re-running produces an identical file.

    python backend/tests/fixtures/generate_sample.py

This is synthetic data shaped like plausible traffic, not a recording of real
flights. It is not a substitute for testing against a real OpenSky response;
see tests/fixtures/opensky_raw_sample.json (M2) for that.
"""
import json, pathlib, random
from datetime import datetime, timezone

random.seed(480)  # CSC480, and it makes the fixture reproducible.

AIRLINES = [
    ("UAL", "United States"), ("AAL", "United States"), ("DAL", "United States"),
    ("SWA", "United States"), ("ACA", "Canada"), ("BAW", "United Kingdom"),
    ("DLH", "Germany"), ("AFR", "France"), ("KLM", "Netherlands"),
    ("RYR", "Ireland"), ("EZY", "United Kingdom"), ("SAS", "Sweden"),
    ("THY", "Turkey"), ("UAE", "United Arab Emirates"), ("QTR", "Qatar"),
    ("SIA", "Singapore"), ("ANA", "Japan"), ("JAL", "Japan"),
    ("CPA", "China"), ("CCA", "China"), ("QFA", "Australia"),
    ("ANZ", "New Zealand"), ("LAN", "Chile"), ("TAM", "Brazil"),
    ("SAA", "South Africa"), ("ETH", "Ethiopia"), ("AIC", "India"),
]

# (lat, lon, spread_lat, spread_lon, weight) -- traffic is not uniform over the
# globe, and a uniform fixture would make the thinning logic look better than it is.
REGIONS = [
    (39.0, -96.0, 12.0, 22.0, 34),   # CONUS
    (50.0, 8.0, 7.0, 16.0, 30),      # Europe
    (34.0, 122.0, 10.0, 16.0, 22),   # East Asia
    (25.0, 55.0, 8.0, 14.0, 10),     # Gulf
    (20.0, 78.0, 8.0, 12.0, 10),     # India
    (-27.0, 140.0, 10.0, 18.0, 8),   # Australia
    (-12.0, -50.0, 12.0, 16.0, 8),   # South America
    (5.0, 15.0, 12.0, 16.0, 6),      # Africa
    (48.0, -35.0, 9.0, 24.0, 12),    # North Atlantic track
    (36.0, -160.0, 10.0, 22.0, 8),   # Pacific
    (65.0, 175.0, 6.0, 12.0, 4),     # Near the antimeridian, on purpose
]

used_ids, used_calls, out = set(), set(), []

def hex24():
    while True:
        v = "%06x" % random.randrange(0x000001, 0xFFFFFE)
        if v not in used_ids:
            used_ids.add(v); return v

def callsign(prefix):
    while True:
        c = f"{prefix}{random.randrange(1, 9999)}"
        if c not in used_calls:
            used_calls.add(c); return c

now = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)

for clat, clon, dlat, dlon, count in REGIONS:
    for _ in range(count):
        prefix, country = random.choice(AIRLINES)
        lat = max(-85.0, min(85.0, random.gauss(clat, dlat / 2)))
        lon = random.gauss(clon, dlon / 2)
        lon = (lon + 180.0) % 360.0 - 180.0

        phase = random.random()
        if phase < 0.10:        # on the ground / taxiing
            alt, vel = random.uniform(0, 300), random.uniform(0, 60)
        elif phase < 0.22:      # climbing or descending
            alt, vel = random.uniform(1500, 8000), random.uniform(140, 210)
        else:                   # cruise
            alt, vel = random.uniform(9000, 12500), random.uniform(210, 265)

        rec = {
            "id": hex24(),
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "altitude": round(alt, 1),
            "velocity": round(vel, 1),
            "heading": round(random.uniform(0, 360), 1),
            "label": callsign(prefix),
            "lastSeen": now.isoformat().replace("+00:00", "Z"),
            "type": "aircraft",
            "meta": {"originCountry": country},
        }
        out.append(rec)

# A few deliberate edge cases so tests and the frontend meet them early rather
# than in the demo.
edge = [
    # Null velocity/heading: OpenSky reports these for some ground contacts.
    {"id": "e0ge01", "lat": 51.4706, "lon": -0.4619, "altitude": 0.0, "velocity": None,
     "heading": None, "label": "BAW9001", "lastSeen": now.isoformat().replace("+00:00", "Z"),
     "type": "aircraft", "meta": {"originCountry": "United Kingdom"}},
    # Unknown altitude.
    {"id": "e0ge02", "lat": -33.9461, "lon": 151.1772, "altitude": None, "velocity": 68.0,
     "heading": 160.0, "label": "QFA401", "lastSeen": now.isoformat().replace("+00:00", "Z"),
     "type": "aircraft", "meta": {"originCountry": "Australia"}},
    # Sitting right on the antimeridian, heading west across it.
    {"id": "e0ge03", "lat": 62.5, "lon": 179.6, "altitude": 10600.0, "velocity": 240.0,
     "heading": 275.0, "label": "AFL2201", "lastSeen": now.isoformat().replace("+00:00", "Z"),
     "type": "aircraft", "meta": {"originCountry": "Russian Federation"}},
    # High latitude polar route.
    {"id": "e0ge04", "lat": 82.1, "lon": -60.0, "altitude": 11200.0, "velocity": 250.0,
     "heading": 5.0, "label": "SAS944", "lastSeen": now.isoformat().replace("+00:00", "Z"),
     "type": "aircraft", "meta": {"originCountry": "Sweden"}},
    # No callsign from upstream -- label falls back to the id.
    {"id": "e0ge05", "lat": 41.3, "lon": 2.1, "altitude": 3200.0, "velocity": 180.0,
     "heading": 90.0, "label": "e0ge05", "lastSeen": now.isoformat().replace("+00:00", "Z"),
     "type": "aircraft", "meta": {"originCountry": "Spain"}},
]
out.extend(edge)

path = pathlib.Path(__file__).with_name("aircraft_sample.json")
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"wrote {len(out)} aircraft to {path}")
