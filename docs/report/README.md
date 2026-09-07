# Orbital — Project Report

Draft chapters for the CSC480 report, following the structure in
`OneDrive/Documents/TEMPLATE.pdf`.

## Status

| Chapter | Sections | State |
|---|---|---|
| **1. Introduction** | Background and Problem Statement · Project Objectives · Project Scope · Expected Benefits · Tools and Technologies | **Draft complete** |
| **2. Feasibility Study and Related Work** | Technical · Economic · Operational · Schedule · Related Systems · Relevant Theories | **Draft complete** |
| **3. Requirements Analysis** | Stakeholder Analysis · Functional · Non-Functional · Use Case Diagram · Use Case Descriptions · SRS | **Draft complete** |
| 4. Project Planning | Charter · WBS · Gantt · Cost · Resources · Risk · Communication | Not started |
| 5. System Design | Architecture · ER · UML · UI · Prototype | Not started |
| 6. System Development | Environment · Modules · Database · Screens · Code | Not started |
| 7. System Testing | Plan · Cases · Unit · Integration · System · UAT · Results | Not started |
| 8. Conclusion | Summary · Objectives · Problems · Improvements · Lessons | Not started |

Chapters 4–8 are largely assembly rather than research: much of their content
already exists in `docs/decisions.md`, `docs/architecture.md`,
`docs/test-plan.md` and `docs/data-contract.md`.

## Where the facts come from

Every figure in these chapters was taken from the repository or measured against
the running system on 7 September 2026, not recalled:

| Claim | Source |
|---|---|
| 1,842 tests (823 backend, 1,019 frontend) | Both suites run |
| 16 HTTP endpoints | The live `openapi.json`, counted |
| ~19,100 backend / ~28,500 frontend lines | `git ls-files | wc -l` |
| 166 recorded decisions | `docs/decisions.md`, counted |
| 13,829 aircraft · 23,297 ships · 1,431 satellites | The live API |
| Team names, IDs and roles | `Orbital_Team_Roles.pdf` |
| Entitlement windows (24 h / 7 d) | `accounts/entitlements.py` |
| Performance figures | `docs/test-plan.md` §4 and the D167 measurements |
| Coverage and licence findings | D165, D166 |

## Before submission — items needing the team's decision

1. **Confirm the team roles table** in §3.1.3 against the current division of
   work. It is taken from `Orbital_Team_Roles.pdf`, which may predate changes.
2. **Decide how much of the honest reporting to keep.** The draft states several
   things a report could omit: that the administrator role has no interface,
   that a decision correct when made became wrong two phases later, that six
   sessions were lost to one misdiagnosed defect, and that aisstream's licence
   question is unanswered. These are included because they are true and because
   a feasibility study that reports only successes is not a feasibility study —
   but they are the team's to keep or cut.
3. **Chapter 2.2.3 constrains the revenue model.** OpenSky forbids commercial
   use, so a paid version could not use it. This is presented as a finding
   rather than a resolved question, and the team may wish to take a position.
4. **The use case diagram** in §3.4 is ASCII. It will need redrawing in a
   diagramming tool for submission.
5. **`docs/test-plan.md` §2 is stale** — its requirements table still refers to
   `globe/`, deleted in D104. Chapter 3 was written from the current system
   instead. That table should be refreshed before Chapter 7 is written from it.

## A note on numbers that move

Three figures in Chapter 1 change continuously: the counts of aircraft, ships
and satellites. They are given as "measured live on 7 September 2026" rather
than as fixed properties. The ship figure in particular climbs for roughly an
hour after a restart, because the global feed is a stream that accumulates
rather than an endpoint that answers.
