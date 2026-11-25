# Chapter 6: Program Screenshots

These are the key screens of Orbital, captured from the live site
(orbital-liveview.vercel.app) on 25 November 2026. The aircraft, ships and
satellites in them are real and were in those positions when captured. Each
screenshot is followed by what the screen is for and how it works. The
"Sponsored" cards are the free tier's advertising; premium removes them.

## 6.1 Live Aircraft

![Figure 6.1 — The worldwide aircraft view.](figures/6-01-world-aircraft.png){width=6.5in}

**Purpose.** The opening screen. It shows every aircraft the system currently
knows about, worldwide, on a 3D globe, so a visitor sees air traffic at a
glance without signing in.

**How it works.** The browser asks the Orbital API for the aircraft inside the
part of the globe on screen. The API reads them from the server's in-memory
store, which the OpenSky relay refreshes every two minutes and adsb.lol and
adsb.fi supplement. When more than 2,000 are in view, the API returns a sample,
and the status bar at the bottom says so ("showing a sample of 5,842 in view")
along with the data's age and source. Colour is altitude, explained in the key.

![Figure 6.2 — Aircraft over mainland Southeast Asia, zoomed in.](figures/6-02-regional-aircraft.png){width=6.5in}

**Purpose.** Following traffic in one region with callsigns readable.

**How it works.** Scrolling zooms the map from the globe to street level in one
continuous view. As the visible area shrinks, the browser asks again for just
that area, so every aircraft in it is drawn instead of a sample. Each icon
points along its heading, is labelled with its callsign, and moves smoothly
between updates by dead reckoning along its last known heading and speed.

## 6.2 Search

![Figure 6.3 — Search suggestions while typing a callsign.](figures/6-03-search.png){width=6.5in}

**Purpose.** Finding a particular flight, airport, satellite or ship without
looking for it on the map.

**How it works.** As the visitor types, the browser sends the text to the
search endpoint, which matches it against the objects held in memory and
returns up to eight suggestions with their altitude. Choosing one, or pressing
Enter, selects that object, flies the camera to it and opens its detail panel.
The search box searches whichever layer is active, and its placeholder text
changes to say what it accepts.

## 6.3 Aircraft Details and Flown Route

![Figure 6.4 — The detail panel of Thai Airways flight THA923, with the route it has flown.](figures/6-04-aircraft-detail.png){width=6.5in}

**Purpose.** Everything known about one aircraft: its photo, airline, aircraft
type, registration, altitude, speed and heading, its scheduled route, and the
path it has actually flown.

**How it works.** Selecting an aircraft asks the API for its details. The
server looks up the airline and aircraft type from shared tables and the
scheduled route from a community route database. It asks the home relay for
the aircraft's flown track from OpenSky, which arrives within a few seconds
and is drawn as the white line. The photo comes from Planespotters and is
credited to its photographer. The panel labels the scheduled route as
published rather than reported, because aircraft do not transmit their
destination.

## 6.4 Satellites

![Figure 6.5 — The satellite layer: about 1,500 satellites, coloured by orbit.](figures/6-05-satellites.png){width=6.5in}

**Purpose.** Showing where active satellites are right now, and what kind of
orbit each is on.

**How it works.** Satellite positions are not downloaded; they are computed.
The server holds the published orbital elements for each satellite, refreshed
every six hours, and calculates each position with the SGP4 model when the
browser asks. Colour shows the orbit class (low, medium, geostationary or
elliptical), and the icon's shape shows what kind of spacecraft it is, as the
key explains.

![Figure 6.6 — The International Space Station selected, with its orbit drawn.](figures/6-06-satellite-detail.png){width=6.5in}

**Purpose.** Details of one satellite: its catalogue number, type, altitude,
speed, orbital period and inclination, and the orbit it follows.

**How it works.** Selecting a satellite computes its path for one full orbit
and draws it as a line around the globe. The panel says the position is
"computed for now", not observed, and how old the orbital elements are,
because accuracy falls as they age. Plain-language notes explain each value,
for example that an inclination of 51.6° means the station never passes north
of 52° or south of −52°.

## 6.5 Time Control

![Figure 6.7 — The sky as it was one hour ago.](figures/6-07-time-control.png){width=6.5in}

**Purpose.** Seeing where the satellites were, or will be, at another moment.

**How it works.** Because satellite positions are computed, they can be
computed for any time. Dragging the slider, or using the arrow keys, sends the
chosen time with each request, and every satellite is recalculated for that
moment. The panel turns amber, shows the exact time in UTC, and offers "Return
to live". Free users can move 24 hours either way and premium users 7 days.

## 6.6 Ships

![Figure 6.8 — Ships in the Gulf of Finland, coloured by vessel type.](figures/6-08-ships.png){width=6.5in}

**Purpose.** Showing vessels near the coast, by type: cargo, passenger, tanker,
tug, fishing and others.

**How it works.** Ship positions come from AIS, merged from two sources: the
Finnish Digitraffic service and the global aisstream.io feed, which pushes
updates to the server over a WebSocket. Both are received by stations on the
shore, which is why the layer is labelled "ships in coastal waters" and is
densest around Finland.

![Figure 6.9 — The detail panel of the passenger ship Silja Serenade.](figures/6-09-ship-detail.png){width=6.5in}

**Purpose.** Details of one vessel: its type, navigational status, speed,
heading, destination and arrival time, size, and identifying numbers.

**How it works.** Name, type, size and destination are broadcast separately
from position, and less often, so the server keeps adding them to a vessel's
record as they arrive. Values a transmitter marks as "not available" are never
shown as numbers, and the status is labelled "as set by the crew" because it
is entered by hand on board.

## 6.7 The Moon

![Figure 6.10 — The Moon, with the three spacecraft in lunar orbit.](figures/6-10-moon.png){width=6.5in}

**Purpose.** Visiting other worlds under the same camera, and following the
spacecraft that orbit the Moon.

**How it works.** The world picker under the logo lists the Sun, the planets
and the Moon. Choosing one flies the camera out and back in, and swaps the
surface imagery. On the Moon, the "In orbit" panel lists LRO, Danuri and
Chandrayaan-2, whose positions come from NASA JPL's Horizons service and are
drawn over the surface.

## 6.8 The Solar System

![Figure 6.11 — The solar system page, with the planets where they are today.](figures/6-11-solar-system.png){width=6.5in}

**Purpose.** An overview of the Sun, the eight planets and the Moon, as a way
to choose a world and to see where Earth is.

**How it works.** The planets' positions are computed for the current date
from their orbits and drawn on their orbital paths. Earth is marked "you are
here". The arrows and the index move between bodies, and "Back to Earth"
returns to the map.

## 6.9 Accounts and Premium

![Figure 6.12 — The sign-in page.](figures/6-12-sign-in.png){width=6.5in}

**Purpose.** Signing in to an existing account or creating a new one. The map
works without an account; an account is needed only for premium.

**How it works.** The email and password are sent to the API over HTTPS. The
server checks the password against a scrypt hash stored in its SQLite
database, and on success sets a session cookie that scripts on the page cannot
read. Passwords are never stored, logged or returned.

![Figure 6.13 — The premium page, comparing the free and premium tiers.](figures/6-13-premium.png){width=6.5in}

**Purpose.** Explaining what premium adds: time travel 7 days either way
instead of 24 hours, and no advertising. Everything else is free.

**How it works.** The page reads the visitor's tier from their session. Orbital
has no payment system, so a signed-in user switches premium on or off with one
click, and the server records the tier on their account. The time control and
the advertising read that tier and change at once.
