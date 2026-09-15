"""Plain outline of the presentation, slide by slide.

For team members writing their own scripts. Each slide gets one line saying
what is on it and a short list of points to cover — nothing else. An outline
with five labelled fields per slide is a form to fill in; this is a list to
read.

Slide titles are read from the .pptx, and the points below are keyed by slide
number **with the title they expect**, so reordering the deck prints a warning
rather than describing the wrong slide.

    python docs/report/build_script_outline.py
"""

from __future__ import annotations

import pathlib

HERE = pathlib.Path(__file__).parent
PPTX = HERE / "documents" / "Orbital-Presentation.pptx"
OUT = HERE / "documents" / "Orbital-Presentation-Outline.txt"

WIDTH = 78

# slide -> (expected title, what is on screen, points to cover)
GUIDE: dict[int, tuple[str, str, list[str]]] = {
    1: ("Orbital", "Title card.", [
        "Orbital puts aircraft, ships and satellites on one live map, in a "
        "browser, free, with no account.",
        "The team and the module. Keep it to a sentence and move on.",
    ]),
    2: ("The Problem: Fragmented & Closed",
        "Four cards — Fragmented, Raw, Metered, Closed.", [
        "All three kinds of object are already tracked publicly, right now.",
        "But each lives behind its own API, its own format, its own rate "
        "limit, and some forbid the use outright.",
        "Nobody has to invent the data. The work is assembling it and keeping "
        "it free to look at.",
    ]),
    3: ("Architecture & Methodology",
        "Three stacked arrows — Ingestion, API, Frontend.", [
        "Data flows one way, and each layer knows only the one beneath it.",
        "The frontend never learns where the data came from; ingestion never "
        "learns a browser exists.",
        "One shared data shape covers all three object types, which is why a "
        "new type costs one module.",
    ]),
    4: ("Feasibility & Performance",
        "Bar chart — four backend stages at 2,000, 10,000 and 30,000 objects.", [
        "Every source is free and public. Total cash cost is zero.",
        "The real budget is request quota: 77% of the OpenSky allowance "
        "planned, and the app refuses to start above 85%.",
        "On the chart, the left-hand group is where the system actually runs — "
        "every stage under two milliseconds.",
        "The 43.5 ms bar is the cliff the 2,000 cap exists to avoid. The "
        "backend is one event loop, so a slow call delays everyone.",
    ]),
    5: ("Reliability & Use case",
        "Two cards, and the use case diagram — eleven cases, five actors.", [
        "A feed going dark is normal operating conditions, not an incident.",
        "Stale-but-flagged: the last good data keeps being served with its age "
        "visible. The map never goes blank.",
        "Aircraft and ships each have two independent feeds, so one failure is "
        "never fatal.",
        "On the diagram: four of the eleven cases have no human actor. They "
        "are the scheduler, and that is where every external dependency lives.",
    ]),
    6: ("Planning: six packages, five people",
        "Work breakdown — six cards, four deliverables each, owners initialled.", [
        "Seven roles across five people, so most of us hold two.",
        "Decomposed until each item has a name against it, and no further.",
        "The backend package is split by delivered phase rather than by "
        "component, which makes the cost of each new object type visible.",
    ]),
    7: ("The plan, and the three milestones",
        "Gantt chart — twelve weeks, three milestones.", [
        "Milestones: requirements signed off at week 3, feature complete at 8, "
        "report and demonstration at 11.",
        "The critical path is the first vertical slice — requirements, data "
        "contract, one provider, the store, the API, one layer on screen.",
        "After that it runs in parallel: satellites, ships and accounts each "
        "touch a different provider or route, so none blocks another.",
        "Say plainly that this is the plan rather than a record of what "
        "happened — the two are kept separate on purpose.",
    ]),
    8: ("Risks, and what they cost",
        "Four risk cards. R1 is marked HAPPENED.", [
        "R1 is not hypothetical — OpenSky became unreachable from every cloud "
        "host, mid-project.",
        "It cost one provider module and one registry entry. Nothing above the "
        "ingestion layer changed.",
        "R3 is the object-count limit again. Slide 4 already showed the "
        "measurements, so point back rather than repeating the numbers.",
        "R4: the client polls every ten seconds but the data changes every "
        "three hundred, so twenty-nine polls in thirty are answered by a "
        "header comparison that never builds a response.",
        "If asked why these four out of ten: they are the four with a "
        "structural mitigation — something in the architecture exists because "
        "of them.",
    ]),
    9: ("Three layers, one direction",
        "Full architecture diagram — five feeds, three layers.", [
        "The browser never talks to a data source. Every external call goes "
        "through the backend.",
        "So a hundred open tabs cost the same upstream quota as one.",
        "It is also why adding a second aircraft feed was a backend-only "
        "change — the frontend was never told, because there was nothing to "
        "tell it.",
        "Upstream failure is contained at layer one: the API serves the last "
        "good snapshot with a staleness flag.",
    ]),
    10: ("Two tables — and that is the design",
         "ER diagram — two persisted tables, the rest dashed.", [
        "Accounts and sessions. That is the whole persisted schema.",
        "Everything the map shows lives in memory and is replaced every poll. "
        "Nothing about an aircraft is written to disk.",
        "So there is no database on the request path, and no schema migration "
        "for the thing that changes most — the shape of a feed.",
        "The honest cost: Orbital cannot answer a question about last Tuesday.",
    ]),
    11: ("Why a second feed cost one file",
         "Class diagram — Provider, seven implementations, UnionProvider "
         "highlighted.", [
        "One abstract Provider: fetch, given a bounding box, return the "
        "normalised shape.",
        "UnionProvider inherits it and holds two of them — primary every poll, "
        "supplement every 120 seconds.",
        "A caller cannot tell a pair of feeds from a single feed. That is why "
        "losing a primary source changed nothing above ingestion.",
        "The API never holds a Provider, so there is no call path from a "
        "request to a socket.",
    ]),
    12: ("The interface, and the honesty line",
         "Screenshot of the live deployment, with real counts.", [
        "This is the deployed system, not a mock-up. Those counts were real at "
        "the moment of capture.",
        "The map is the product — controls sit in the corners, nothing floats "
        "over the centre.",
        "One layer at a time, because three at once is forty thousand markers "
        "and no legible map.",
        "The status bar reports what is *not* shown: 2,000 of 13,607 drawn, "
        "the data age, and which feed answered.",
    ]),
    13: ("What Orbital Delivers", "Four closing cards.", [
        "One map, free, no account — aircraft, ships and satellites together.",
        "It survives upstream failure, because one already happened.",
        "A new object type costs one module.",
        "Stop there and take questions.",
    ]),
}


def wrap(text: str, width: int) -> list[str]:
    words, out, current = text.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > width:
            out.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        out.append(current)
    return out


def deck_titles() -> dict[int, str]:
    from pptx import Presentation

    found: dict[int, str] = {}
    prs = Presentation(str(PPTX))
    for number, slide in enumerate(prs.slides, start=1):
        texts = [sh.text_frame.text.strip() for sh in slide.shapes
                 if sh.has_text_frame and sh.text_frame.text.strip()]
        found[number] = " ".join(texts[0].split()) if texts else ""
    return found


def main() -> None:
    if not PPTX.exists():
        raise SystemExit(f"deck not built: {PPTX}")

    deck = deck_titles()
    body = [
        "=" * WIDTH,
        "ORBITAL — CSC480",
        f"Presentation outline — {len(deck)} slides",
        "=" * WIDTH,
        "",
    ]
    body += wrap("What is on each slide, and the points to cover. Write your "
                 "own sentences from the points — they are notes, not a "
                 "script.", WIDTH)
    body += [
        "",
        "Twelve minutes of speaking fits a fifteen-minute slot. Divide the "
        "slides",
        "between you however suits; agree it before anyone writes.",
        "",
    ]

    drift: list[str] = []
    for number in sorted(GUIDE):
        expected, screen, points = GUIDE[number]
        actual = deck.get(number, "")
        if actual and not actual.startswith(expected[:18]):
            drift.append(f"  slide {number}: outline expects {expected!r}, "
                         f"deck has {actual!r}")

        body += ["", "-" * WIDTH]
        body.append(f"{number:>2}.  {(actual or expected).upper()}")
        body.append("-" * WIDTH)
        body += [f"    {line}" for line in wrap(screen, WIDTH - 4)]
        body.append("")
        for point in points:
            lines = wrap(point, WIDTH - 8)
            body.append(f"    ·  {lines[0]}")
            body += [f"       {line}" for line in lines[1:]]

    body.append("")
    if drift:
        body += [
            "",
            "=" * WIDTH,
            "WARNING — THE DECK HAS MOVED UNDER THIS OUTLINE",
            "=" * WIDTH,
            "",
        ] + drift + [
            "",
            "  Update GUIDE in docs/report/build_script_outline.py.",
            "",
        ]

    OUT.write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"wrote {OUT}  ({OUT.stat().st_size:,} bytes)")
    for line in drift:
        print("WARNING:" + line)


if __name__ == "__main__":
    main()
