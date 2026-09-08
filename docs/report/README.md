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

## Built documents

`documents/` holds the two deliverables. It is deliberately not called `build/`,
which `.gitignore` excludes as compiled output — these are files for submission,
not artifacts nobody needs to keep.

| File | |
|---|---|
| `Orbital-Report-Chapters-1-3.docx` | Word, 20 pages, black and white |
| `Orbital-Report-Chapters-1-3.pdf` | The same document, exported by Word itself |

**Rebuild** with `python docs/report/build_report.py` after editing any chapter.
The pipeline is markdown → `.docx` via pandoc, then `.docx` → `.pdf` via Word,
so the PDF is the *same document* rather than a second rendering of the source.

The document is deliberately plain: black headings and text throughout, no
section rules, and no discursive asides — it is written to be presented in ten
to fifteen minutes rather than read at length. Tables keep a header rule and a
closing rule, which aid scanning.

Two things the build had to correct, because both fail silently:

- **`\newpage` does nothing for a Word target.** It is a LaTeX command; pandoc
  dropped it without an error and without leaving literal text, so every chapter
  ran on from the bottom of the previous page. Real page breaks are raw
  OpenXML.
- **The use case diagram wrapped inside its own boxes** at pandoc's default
  11 pt code font, destroying the ASCII alignment. The reference document sets
  it to 8 pt; the widest line is 73 characters.

## Where the facts come from

Every figure in these chapters was taken from the repository or measured against
the running system, not recalled. **Re-measured on 8 September 2026** after
D168-D170 moved several of them:

| Claim | Source |
|---|---|
| 1,868 tests (832 backend, 1,036 frontend) | Both suites run |
| 17 HTTP endpoints | The live `openapi.json`, counted |
| ~19,400 backend / ~31,900 frontend lines | `git ls-files`, then `wc -l` over the tracked sources |
| 169 recorded decisions | `docs/decisions.md`, counted |
| 14,804 aircraft · 26,262 ships · 1,427 satellites | The live API |
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

## One figure was wrong when it was written

The frontend line count said **~28,500 lines in 159 files**. Measured against
the tree at `fb3f202`, the commit that added these chapters, it was **31,087
lines in 161 files** - understated by about 2,600 lines. The backend figure
beside it was correct to the rounding.

Recorded rather than quietly corrected, because the two failures are different
and only one of them is anybody's fault. Everything else in this table went
stale, which is what happens to a number copied out of a moving system.

## A note on numbers that move

Three figures in Chapter 1 change continuously: the counts of aircraft, ships
and satellites. They are given as "measured live on 7 September 2026" rather
than as fixed properties. The ship figure in particular climbs for roughly an
hour after a restart, because the global feed is a stream that accumulates
rather than an endpoint that answers.
