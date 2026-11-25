# Appendix B: Project Charter, Cost and Resources

## B.1 Project Charter

### Purpose

Orbital exists to put aircraft, ships and satellites on one map, in a browser,
for free, with no account required. The three kinds of object are already
tracked publicly and separately; nothing assembles them into a single view a
person can simply open.

### Objectives

| # | Objective | How it will be judged |
|---|---|---|
| O1 | One map showing all three object types | All three layers render live data from the deployed system |
| O2 | No account and no cost to look | The default view requires no sign-in and no payment |
| O3 | Upstream failure degrades, never breaks | With a feed disabled, the map still draws, labelled stale |
| O4 | A new object type costs one module | Adding a type requires no change to the API or the frontend |
| O5 | Honest reporting of what is shown | Sampling, staleness and source are stated in the interface |

### Scope

**In scope.** Ingestion from free public feeds; normalisation to one shared
shape; a read-only REST API; a browser client rendering the three layers on a
map; object selection and detail; search; accounts with a free and a premium
entitlement window; the Moon, the eight planets and the solar system view.

**Out of scope.** Writing to any upstream; historical archiving beyond the
retention window; native mobile applications; flight booking, ticketing or any
transaction; real-time alerting or push notification; an administrator
interface.

### Deliverables

The deployed application, the source repository with its test suites, this
report, a decision record, a test plan, and a demonstration.

### Constraints

| Constraint | Consequence for the plan |
|---|---|
| Free data sources only | Rate limits, not money, are the budget (Appendix B.2) |
| No commercial licence on one feed | The revenue model cannot use OpenSky (Appendix A.2) |
| One backend worker | Vertical scaling only; a second worker would double upstream cost |
| Five part-time students | Parallel work must be separable, or it serialises |
| One semester | Scope is fixed by phase boundaries rather than by deadline pressure |

### Assumptions

That the public feeds remain available and free; that their terms do not change
mid-project; that free hosting tiers remain sufficient for a demonstration
workload. The first of these did not hold: OpenSky became unreachable from every cloud host partway through, and §4.2 treats it as the realised risk it
turned out to be rather than as an assumption that was merely unlucky.

### Authority

The Project Manager owns scope and phase boundaries and decides what is in the
current phase and what is explicitly out. Every significant decision is written
to the decision record with its alternatives and its reasoning, so that a choice
can be defended, or reversed, on the evidence that produced it.

## B.2 Cost Estimation

### Direct cost

| Category | Cost |
|---|---|
| Data sources | 0 |
| Map imagery and tiles | 0 |
| Libraries and tooling | 0 |
| Hosting, development and demonstration | 0 |
| **Total cash cost** | **0** |

Every input is a free public service or an open-source library, and both hosts
run on free tiers. This is not an accident of a student budget: Appendix A.2 records
that free sources were a requirement, because a tracker that costs money per
viewer cannot be free to look at.

### The real budget is quota, not currency

No money changes hands, so the constraint that behaves like money is the
upstream request allowance. It was budgeted like money:

| Resource | Allowance | Planned use | Headroom |
|---|---|---|---|
| OpenSky daily credits | 4,000 | 3,072 (77%) | 928, for user-triggered lookups |
| adsb.lol request rate | Burst 4, then ~5/min | Within the measured limit | Enforced by a gate, not by convention |
| Celestrak / SatNOGS | Courtesy limits | Refreshed every six hours, cached to disk | Falls back to cache on failure |
| Ships (Digitraffic, aisstream) | No metered limit | Continuous websocket | Not metered |

The startup refuses a configuration projected to exceed 85% of the OpenSky
allowance. A budget that is only written down is a budget nobody keeps; one the
program will not start without is a budget that holds.

### Labour, as a notional replacement cost

The project's only real cost is effort. Stated as what it would cost to buy,
under assumptions that are stated rather than implied:

| Item | Assumption |
|---|---|
| Team | 5 members |
| Duration | 12 weeks |
| Effort per member per week | 8 hours |
| **Total effort** | **480 person-hours** |

At a notional junior developer rate of £25 per hour, that is £12,000 of
labour delivered at zero cash cost. The rate is an assumption for comparison
only; the hours are the figure worth arguing about, and they are an estimate,
not a measurement. The project did not keep timesheets, and inventing precise
ones here would be exactly the kind of invented number this report declines to
produce elsewhere.

## B.3 Resources

### Technology

| Resource | Purpose | Cost |
|---|---|---|
| Python, FastAPI, httpx, SGP4 | Ingestion and API | Free, open source |
| React, TypeScript, MapLibre GL, Vite | Browser client | Free, open source |
| SQLite | Accounts and sessions | Free, bundled |
| Vercel | Frontend and landing page hosting | Free tier |
| Northflank | Backend container hosting | Free tier |
| GitHub | Source control, history, issues | Free |

### Data

Six upstream feeds, all free: OpenSky, adsb.fi and adsb.lol for aircraft,
Celestrak and SatNOGS for orbital elements and satellite identity, Digitraffic
and aisstream for vessels. OpenSky refuses cloud hosts, so its world view and
flight tracks are fetched from a team member's PC and relayed to the server
(§5.1). adsb.lol now limits a query to 250 nautical miles and asks automated
clients to use a key, which has been requested.

### Environment

A member must be able to set the project up from a clean machine. That is the
Technical Engineer's deliverable rather than a shared assumption, and it is the
reason generated assets are fetched by a script rather than committed: a clone
plus one command produces a running system, and a build with no network works
as long as a previous one has run.
