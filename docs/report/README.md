# Orbital — Project Report

Draft chapters for the CSC480 report, following the structure in
`OneDrive/Documents/TEMPLATE.pdf`.

## Status

| Chapter | Sections | State |
|---|---|---|
| **1. Introduction** | Background and Problem Statement · Project Objectives · Project Scope · Expected Benefits · Tools and Technologies | **Draft complete** |
| **2. Feasibility Study and Related Work** | Technical · Economic · Operational · Schedule · Related Systems · Relevant Theories | **Draft complete** |
| **3. Requirements Analysis** | Stakeholder Analysis · Functional · Non-Functional · Use Case Diagram · Use Case Descriptions · SRS | **Draft complete** |
| **4. Project Planning** | Charter · WBS · Gantt · Cost · Resources · Risk · Communication | **Draft complete** |
| **5. System Design** | Architecture · ER · UML · UI · Prototype | **Draft complete** |
| 6. System Development | Environment · Modules · Database · Screens · Code | Not started |
| 7. System Testing | Plan · Cases · Unit · Integration · System · UAT · Results | Not started |
| 8. Conclusion | Summary · Objectives · Problems · Improvements · Lessons | Not started |

Chapters 6–8 are largely assembly rather than research: much of their content
already exists in `docs/decisions.md`, `docs/architecture.md`,
`docs/test-plan.md` and `docs/data-contract.md`.

## Built documents

`documents/` holds the two deliverables. It is deliberately not called `build/`,
which `.gitignore` excludes as compiled output — these are files for submission,
not artifacts nobody needs to keep.

| File | |
|---|---|
| `Orbital-Report-Chapters-1-5.docx` | Word, 40 pages, nine colour figures |
| `Orbital-Report-Chapters-1-5.pdf` | The same document, exported by Word itself |

| `Orbital-Presentation.pptx` | 13 slides |
| `Orbital-Outline.txt` | Plain-text outline of both, with page and slide numbers |
| `Orbital-Presentation-Outline.txt` | The 13 slides only — what is on each and the points to cover |

**Rebuild** with `python docs/report/build_report.py` after editing any chapter,
`python docs/report/build_deck.py` for the slides, then
`python docs/report/build_outline.py` and
`python docs/report/build_script_outline.py` last — both read the built PDF
and .pptx, so they have to run after them.

Two outlines, deliberately separate. `Orbital-Outline.txt` covers the report
*and* the deck, for seeing what exists. `Orbital-Presentation-Outline.txt` is
the slides alone, for writing a talk from — no chapters, no page numbers.

`build_script_outline.py` holds its per-slide points in a `GUIDE` table keyed
by slide number, and **checks the title it expects against the deck**. Reorder
the slides and it prints a warning rather than quietly describing the wrong one.
The pipeline is markdown → `.docx` via pandoc, then `.docx` → `.pdf` via Word,
so the PDF is the *same document* rather than a second rendering of the source.

The document is deliberately plain: black headings and text throughout, no
section rules, and no discursive asides — it is written to be presented in ten
to fifteen minutes rather than read at length. Tables keep a header rule and a
closing rule, which aid scanning.

## Figures

Nine figures, all generated. `figures/` holds the PNGs and the `fig_*.py`
beside them are what produced each one, sharing one palette in
`figures_style.py` so a colour means the same thing in every figure and on
every slide.

```bash
python docs/report/fig_architecture.py   # and fig_er, fig_class, fig_sequence,
                                          # fig_activity, fig_ui, fig_wbs,
                                          # fig_gantt, fig_usecase
```

**Graphviz is installed now** (`dot`, 16.1.0, on the user PATH, with the
`graphviz` Python binding). None of the nine figures uses it: every box in them
is positioned by hand because there was no `dot` on this machine when they were
drawn. They are not worth rewriting for its own sake — but a *new* diagram with
real graph structure, and the class and ER diagrams if either is ever reworked,
should let `dot` do the layout rather than repeat that.

`fig_ui.py` is the exception: it annotates `figures/_app.png`, a headless
capture of the live deployment at 1600 x 950, so the counts in its status bar
are real. Recapture with:

```bash
chrome --headless=new --use-gl=swiftshader --window-size=1600,950 --virtual-time-budget=20000 --screenshot=_app.png https://orbital-liveview.vercel.app/
```

**The callouts are placed against that capture's pixels.** Recapturing at a
different window size moves every region, and the numbered boxes will point at
the wrong things without any error being raised.

Four things the build had to correct, because all four fail silently:

- **`\newpage` does nothing for a Word target.** It is a LaTeX command; pandoc
  dropped it without an error and without leaving literal text, so every chapter
  ran on from the bottom of the previous page. Real page breaks are raw
  OpenXML.
- **The use case diagram wrapped inside its own boxes** at pandoc's default
  11 pt code font, destroying the ASCII alignment. The reference document sets
  it to 8 pt; the widest line is 73 characters. It is now Figure 3.1 instead,
  so the problem is gone rather than worked around.
- **Pandoc resolves a relative image path against the working directory**, not
  against the file the path was written in. The chapters say `figures/...` and
  the combined markdown is assembled one level down in `documents/`, so every
  figure resolved to nothing — no image, no error, and a `.docx` whose media
  folder was empty. `--resource-path` fixes it.
- **Pandoc clamps an image in a `.docx` to 5.83 inches** whatever width the
  attribute asks for. An 11-inch-wide figure therefore prints at half size and
  its 6.6 pt labels land at 3.4 pt. The Gantt chart and the WBS were redrawn
  narrower with larger type rather than left to be squinted at; every figure is
  now checked at its printed size, not at the size it was drawn.

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
   Note that the roles document covers **four** members and the report has
   **five**: Pyae Phyo Maung is absent from it, and his roles — Co-Tester,
   Co-QA and Analysis — were confirmed by Phone rather than read from the
   document. Everything else in §4.5 and Figure 4.1 is the document's.
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
4. ~~The use case diagram in §3.4 is ASCII~~ — **done.** It is Figure 3.1,
   redrawn with the same eleven use cases, five actors and relationships.
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

## The Gantt chart is a plan, not a log

Chapter 4.3 is a **forward-looking** schedule, chosen deliberately over one
reconstructed from the commit history. Two consequences worth knowing before
anyone edits it:

- **The window is an assumption.** Twelve weeks from 25 August 2026, the date
  of the first commit, because the module's submission date was not to hand.
  `START` and `WEEKS` in `fig_gantt.py` drive every bar, the axis and the
  milestones, so changing the window is changing two numbers.
- **It is not evidence of what happened.** §2.4 records the phases actually
  delivered. Chapter 8, when it is written, is where the plan and the outcome
  are compared — and that comparison is only worth anything because the plan
  was not quietly redrawn to match.
