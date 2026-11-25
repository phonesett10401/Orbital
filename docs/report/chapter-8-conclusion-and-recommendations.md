# Chapter 8: Conclusion and Recommendations

## 8.1 Conclusion

Orbital set out to put live aircraft, ships and satellites on one free map in a
browser, without hiding what the data does not know. It does: the deployed
system shows between 5,500 and 9,400 aircraft worldwide, about 14,000 ships
and 1,522 satellites, with the Moon's spacecraft and the solar system beside
them, to anyone who opens the page and without an account.

| Objective | Achieved | Evidence |
|---|---|---|
| O1 Live aircraft on an interactive Earth | Yes | Figures 7.2 to 7.5; aircraft data under two minutes old |
| O2 The browser never calls a data source | Yes | Every request goes to the Orbital API (IR-09) |
| O3 Survive upstream failure | Yes | Two real outages; the map stayed up and said the data was stale (§6.1.5) |
| O4 One shared data shape | Yes | Three object types and seven feeds speak it (§3.2.2) |
| O5 The same architecture for satellites and ships | Yes | Each cost one provider module and one registry entry |
| O6 Accounts and a differentiated tier | Yes | Free and premium time windows and advertising (Figures 7.13, 7.14) |
| O7 Record the reasoning behind decisions | Yes | 216 decisions recorded with their alternatives |

All 2,087 automated tests pass, every functional test case passes on the live
site, and the four defects found in final system testing are fixed (§6.1.5).

The project's main lesson is that the data sources, not the code, set the
limits. The architecture's most valuable property turned out to be the one
designed for failure: when a feed was lost, twice, the fix each time was one
new module at the edge of the system, and nothing above the ingestion layer
changed.

## 8.2 Problems Encountered

| Problem | Effect | How it was handled |
|---|---|---|
| OpenSky refuses every cloud server | The backend could not fetch aircraft worldwide | A second aircraft feed was added; later, a relay on a team member's PC fetches from OpenSky and posts to the server |
| adsb.lol limited queries to 250 nm and closed flown tracks to automated clients | The worldwide view and flown routes were lost in November 2026 | The relay took over both; an adsb.lol key has been requested |
| The relay depends on one PC | When the PC sleeps, unplugs or shuts down, only the area in view is shown | Restarts itself every five minutes and on battery; the map falls back and labels the data stale |
| The first renderer could not draw a map | No street-level zoom or vector basemap | Replaced with MapLibre in phase 2, at the cost of one phase |
| One defect was misdiagnosed five times | Six working sessions lost | Resolved by removing the structural cause; recorded as a realised risk (§4.2) |
| Correct code that was never connected | Eighteen defects invisible to unit tests | Every change is now run and looked at before it is accepted |

## 8.3 Recommendations

1. Move the relay to an always-on device. A small single-board computer
   such as a Raspberry Pi on a home connection would keep the worldwide view
   available around the clock, instead of only while a team member's laptop is
   on.
2. Add the adsb.lol key as soon as it is issued, together with adsb.lol's
   credit on the map. That restores a second worldwide aircraft source that
   does not depend on the relay.
3. Add a shared store before adding servers. The single worker is the
   scaling limit (§4.2, R4). Moving the live objects into a shared store such as
   Redis would let several workers serve visitors while one poller fetches.
4. Store aircraft and ship history. Time travel currently covers satellites
   only, because they can be computed for any moment. Keeping observed
   positions in a database would extend it to aircraft and ships.
5. Widen the testing. Add rendering tests for the main React components
   and test in Safari and Firefox as well as Chrome, so that the gaps listed in
   §6.1.2 shrink.
6. Decide what premium is for. Premium is free to switch on because
   Orbital takes no money and OpenSky's licence is non-commercial. A paid tier
   would need a payment provider and a feed licensed for commercial use.
