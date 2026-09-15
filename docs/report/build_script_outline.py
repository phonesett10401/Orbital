"""Per-slide speaking outline, for team members writing their own scripts.

`build_outline.py` lists what is in the report and the deck. This is a
different document for a different job: someone has to stand up and talk for
twelve minutes, and five people have to divide that between them without
repeating each other or leaving a gap.

**It is not a script.** It gives each slide one point, three or four beats to
expand into sentences, and a hand-over line. The sentences are the speaker's -
a script written for somebody else is read aloud, and being read aloud to is
worse than being talked to.

Slide titles and speaker notes are read from the .pptx so this cannot drift
away from the deck. The guidance below is keyed by slide number **and checks
the title it expects**, so reordering the deck produces a loud warning rather
than a script that quietly describes the wrong slide.

    python docs/report/build_script_outline.py
"""

from __future__ import annotations

import pathlib

HERE = pathlib.Path(__file__).parent
PPTX = HERE / "documents" / "Orbital-Presentation.pptx"
OUT = HERE / "documents" / "Orbital-Speaking-Outline.txt"

WIDTH = 78
TOTAL_SECONDS = 720          # twelve minutes of speaking, inside a 15-minute slot

#: Suggested split. Grouped so each person gets a run of related slides rather
#: than scattered singles - every hand-over costs a few seconds and a bit of
#: momentum. Roles are the ones in Orbital_Team_Roles.pdf; **the team should
#: change this to suit who is comfortable with what.**
SPEAKERS = {
    1: "Phone",     2: "Han Phyo",  3: "Bhone",     4: "Nyan Lin",
    5: "Han Phyo",  6: "Pyae",      7: "Pyae",      8: "Pyae",
    9: "Bhone",    10: "Bhone",    11: "Bhone",    12: "Nyan Lin",
    13: "Phone",
}

# slide -> (expected title, seconds, on screen, the point, beats, hand over)
GUIDE: dict[int, tuple] = {
    1: (
        "Orbital", 20,
        "Title card, the project name and the team.",
        "Say what it is in one sentence and get off the slide.",
        ["Orbital puts aircraft, ships and satellites on one live map, in a "
         "browser, free, with no account.",
         "Name the team and the module. Do not read the subtitle aloud — it is "
         "already on screen."],
        "\"Here is the problem it exists to solve.\"",
    ),
    2: (
        "The Problem: Fragmented & Closed", 60,
        "Four cards: Fragmented, Raw, Metered, Closed.",
        "The data already exists. Nothing assembles it.",
        ["Every one of these three object types is tracked publicly, right now, "
         "by somebody.",
         "But each lives behind its own API, in its own format, with its own "
         "rate limit — and some forbid the use outright.",
         "Nobody has to invent the data. The work is in assembling it and "
         "keeping it free to look at.",
         "Do not read all four cards. Pick two and let the slide carry the "
         "rest."],
        "\"So the shape of the system follows from that.\"",
    ),
    3: (
        "Architecture & Methodology", 60,
        "Three stacked arrows: Ingestion, API, Frontend.",
        "One direction of flow, and each layer knows only the one beneath it.",
        ["Data flows one way. Ingestion talks to the outside world; the API "
         "reads what ingestion left; the frontend reads the API.",
         "The frontend never learns where the data came from, and ingestion "
         "never learns a browser exists.",
         "One shared data shape covers all three object types, which is why a "
         "new type costs one module.",
         "This is the slide the later architecture slides build on — set it up "
         "properly here and slide 9 goes quickly."],
        "\"The question then is whether it is actually feasible.\"",
    ),
    4: (
        "Feasibility & Performance", 70,
        "Bar chart: four backend stages at 2,000, 10,000 and 30,000 objects.",
        "Free data is viable; the constraint is rate limiting, not availability.",
        ["Every source is free and public. Total cash cost is zero — that is in "
         "the report as a table.",
         "The real budget is request quota, and it was budgeted like money: 77% "
         "of the OpenSky allowance planned, and the app refuses to start above "
         "85%.",
         "On the chart: the left-hand group is where the system actually runs. "
         "Every stage under two milliseconds.",
         "The 43.5 ms bar on the right is the cliff the 2,000 cap exists to "
         "avoid — the backend is one event loop, so a slow call delays "
         "everyone."],
        "\"And when a source fails anyway — which one did.\"",
    ),
    5: (
        "Reliability & Use case", 70,
        "Two cards, and the use case diagram: eleven cases, five actors.",
        "Upstream failure is expected, not exceptional.",
        ["Treat a feed going dark as normal operating conditions, not as an "
         "incident.",
         "Stale-but-flagged: the last good data keeps being served, with its "
         "age visible. The map never goes blank.",
         "Aircraft and ships each have two independent feeds, so one failure is "
         "never fatal.",
         "On the diagram, point out that four of the eleven cases have no human "
         "actor — they are the scheduler, and that is where every external "
         "dependency lives."],
        "\"That is the system. Here is how the work was planned.\"",
    ),
    6: (
        "Planning: six packages, five people", 55,
        "Work breakdown: six cards, four deliverables each, owners initialled.",
        "Decomposed to where one person owns one deliverable.",
        ["Seven roles across five people, so most of us hold two.",
         "Decomposed until each item has a name against it — any deeper and a "
         "WBS is a task list that is stale in a week.",
         "Package 3, the backend, is split by delivered phase rather than by "
         "component. That is deliberate: it makes the cost of each new object "
         "type visible instead of hiding it inside 'the ingestion layer'."],
        "\"Laid against twelve weeks, it looks like this.\"",
    ),
    7: (
        "The plan, and the three milestones", 55,
        "Gantt chart, twelve weeks, three milestone markers.",
        "This is the plan, not a chart redrawn afterwards to match.",
        ["Three milestones: requirements signed off at week 3, feature complete "
         "at 8, report and demonstration at 11.",
         "The critical path is the first vertical slice — requirements, data "
         "contract, one provider, the store, the API, one layer on screen.",
         "After that it is parallel. Satellites, ships and accounts each touch "
         "a different provider or route, so none blocks another.",
         "Be straight that this is the plan and section 2.4 records what was "
         "delivered. Comparing them is only worth anything because they are "
         "kept apart."],
        "\"Planning also means saying what could go wrong.\"",
    ),
    8: (
        "Risks, and what they cost", 70,
        "Four risk cards. R1 is marked HAPPENED.",
        "One of these actually happened, and it cost what it was designed to.",
        ["R1 is not hypothetical. OpenSky became unreachable from every cloud "
         "host, mid-project.",
         "It cost one provider module and one registry entry. Nothing above the "
         "ingestion layer changed — that is the architecture being proved by "
         "an accident rather than by an argument.",
         "R4 is worth a number: the client polls every ten seconds but the data "
         "only changes every three hundred, so twenty-nine polls in thirty are "
         "answered by a header comparison that never builds a response.",
         "If asked why these four out of ten: these are the four with a "
         "structural mitigation — something in the architecture exists because "
         "of them."],
        "\"So, the design itself. Three layers.\"",
    ),
    9: (
        "Three layers, one direction", 60,
        "Full architecture diagram: five feeds, three layers.",
        "The browser never talks to a data source.",
        ["Every external call goes through the backend, so rate limiting is "
         "enforced in exactly one place.",
         "A hundred open tabs cost the same upstream quota as one. That is the "
         "single most important property on this slide.",
         "It is also why adding a second aircraft feed was a backend-only "
         "change: the frontend was never told, because there was nothing to "
         "tell it.",
         "Upstream failure is contained at layer one — the API serves the last "
         "good snapshot with a staleness flag."],
        "\"Underneath all of that, the database is two tables.\"",
    ),
    10: (
        "Two tables — and that is the design", 55,
        "ER diagram: two persisted tables, the rest dashed.",
        "A tracker looks like it needs a big database. This one deliberately does not.",
        ["Accounts and sessions. That is the whole persisted schema.",
         "Everything the map shows lives in memory and is replaced every poll. "
         "Nothing about an aircraft is ever written to disk.",
         "So there is no database on the request path, and no schema migration "
         "for the thing that changes most often — the shape of a feed.",
         "Be honest about the cost: Orbital cannot answer a question about last "
         "Tuesday. The entitlement windows are bounded by what is still in "
         "memory."],
        "\"One class explains why the second feed was cheap.\"",
    ),
    11: (
        "Why a second feed cost one file", 55,
        "Class diagram: Provider, seven implementations, UnionProvider highlighted.",
        "UnionProvider is a Provider and holds two Providers.",
        ["One abstract Provider: fetch, given a bounding box, return the "
         "normalised shape.",
         "UnionProvider inherits it and holds two of them — primary every poll, "
         "supplement every 120 seconds.",
         "A caller cannot tell a pair of feeds from a single feed. That is the "
         "whole trick, and it is why losing a primary source changed nothing "
         "above ingestion.",
         "Worth adding: the API never holds a Provider. There is no call path "
         "from a request to a socket, which is why an upstream failure cannot "
         "reach a response."],
        "\"And this is what it all looks like to a user.\"",
    ),
    12: (
        "The interface, and the honesty line", 60,
        "Screenshot of the live deployment, captured with real counts.",
        "The status bar reports what the map is not showing.",
        ["This is the deployed system, not a mock-up. Those counts were real at "
         "the moment of capture.",
         "The map is the product — controls sit in the corners, nothing floats "
         "over the centre.",
         "One layer at a time, because three at once is forty thousand markers "
         "and no legible map.",
         "The status bar is the honesty line: 2,000 of 13,607 drawn, the data "
         "age, and which feed answered. A tracker that showed a sample as "
         "though it were everything would be easier to build and would be "
         "lying."],
        "\"To sum up what that gives you.\"",
    ),
    13: (
        "What Orbital Delivers", 30,
        "Four closing cards: One Map, Resilient, Extensible, Performant.",
        "Close on the four claims and stop. Do not re-explain.",
        ["One map, free, no account: aircraft, ships and satellites together.",
         "It survives upstream failure, because one already happened.",
         "A new object type costs one module.",
         "Then stop talking and take questions. Resist the urge to summarise "
         "the summary."],
        "— end —",
    ),
}


def rule(char: str = "=") -> str:
    return char * WIDTH


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


def block(label: str, text: str, indent: int = 12) -> list[str]:
    """A labelled paragraph: label in the left column, text wrapped beside it."""
    lines = wrap(text, WIDTH - indent)
    out = [f"{label:<{indent}}{lines[0]}"]
    out += [" " * indent + line for line in lines[1:]]
    return out


def bullets(label: str, items: list[str], indent: int = 12) -> list[str]:
    out: list[str] = []
    for index, item in enumerate(items):
        lines = wrap(item, WIDTH - indent - 2)
        head = label if index == 0 else ""
        out.append(f"{head:<{indent}}· {lines[0]}")
        out += [" " * (indent + 2) + line for line in lines[1:]]
    return out


def deck_titles_and_notes() -> dict[int, tuple[str, str]]:
    from pptx import Presentation

    found: dict[int, tuple[str, str]] = {}
    prs = Presentation(str(PPTX))
    for number, slide in enumerate(prs.slides, start=1):
        texts = [sh.text_frame.text.strip() for sh in slide.shapes
                 if sh.has_text_frame and sh.text_frame.text.strip()]
        title = " ".join(texts[0].split()) if texts else ""
        note = ""
        if slide.has_notes_slide:
            for shape in slide.notes_slide.shapes:
                if not shape.has_text_frame:
                    continue
                candidate = " ".join(shape.text_frame.text.split())
                if len(candidate) > 24 and not candidate.isdigit():
                    note = candidate
                    break
        found[number] = (title, note)
    return found


def main() -> None:
    if not PPTX.exists():
        raise SystemExit(f"deck not built: {PPTX}")

    deck = deck_titles_and_notes()
    budget = sum(entry[1] for entry in GUIDE.values())

    body = [
        rule(),
        "ORBITAL — CSC480",
        "Speaking outline, for writing your own script from",
        rule(),
        "",
    ]
    body += wrap(
        "One point and a few beats per slide. Expand the beats into your own "
        "sentences — a script written by somebody else gets read aloud, and "
        "being read aloud to is worse than being talked to.", WIDTH)
    body += [
        "",
        f"  Slides          {len(deck)}",
        f"  Speaking time   {budget // 60}:{budget % 60:02d} of a 15-minute slot,",
        "                  leaving roughly three minutes for questions",
        "  Deck            documents/Orbital-Presentation.pptx",
        "",
    ]
    body += wrap(
        "The speaker against each slide is a suggestion, grouped so nobody "
        "hops in and out. Change it to suit who is comfortable with what — "
        "but agree it before anyone writes a word, because the hand-over lines "
        "depend on who is standing up next.", WIDTH)
    body += ["", ""]

    per_speaker: dict[str, list[int]] = {}
    for number in sorted(GUIDE):
        per_speaker.setdefault(SPEAKERS.get(number, "unassigned"), []).append(number)
    body += [rule("-"), "WHO TAKES WHAT", rule("-"), ""]
    for speaker, slides in sorted(per_speaker.items(),
                                  key=lambda kv: min(kv[1])):
        seconds = sum(GUIDE[n][1] for n in slides)
        listed = ", ".join(str(n) for n in slides)
        body.append(f"  {speaker:<12} slides {listed:<22} "
                    f"{seconds // 60}:{seconds % 60:02d}")
    body += ["", ""]

    drift: list[str] = []
    for number in sorted(GUIDE):
        expected, seconds, screen, point, beats, handover = GUIDE[number]
        actual, note = deck.get(number, ("", ""))
        if actual and not actual.startswith(expected[:18]):
            drift.append(f"  slide {number}: guide says {expected!r}, "
                         f"deck says {actual!r}")

        body += [
            rule(),
            f"SLIDE {number} of {len(deck)}   ·   {seconds // 60}:{seconds % 60:02d}"
            f"   ·   {SPEAKERS.get(number, 'unassigned')}",
            actual or expected,
            rule("-"),
        ]
        body += block("ON SCREEN", screen)
        body += block("THE POINT", point)
        body.append("")
        body += bullets("SAY", beats)
        if note:
            body.append("")
            body += block("NOTE", note)
        body.append("")
        body += block("HAND OVER", handover)
        body.append("")

    if drift:
        body += [
            rule(),
            "WARNING — THE DECK HAS MOVED UNDER THIS OUTLINE",
            rule(),
            "",
        ]
        body += drift
        body += [
            "",
            "  Update GUIDE in docs/report/build_script_outline.py. The titles",
            "  above come from the .pptx, so they are right; the beats under",
            "  them may now describe a different slide.",
            "",
        ]

    body += [
        rule(),
        "BEFORE THE RUN-THROUGH",
        rule(),
        "",
        "  · Agree the split above, then time yourselves individually. Most",
        "    people run 20% long on the first attempt.",
        "  · Slides 4 and 8 both touch the object-count limit. Whoever speaks",
        "    second should point back rather than repeat the numbers.",
        "  · Decide who takes questions on what, so nobody answers over anyone.",
        "    The obvious ones: why free sources, why one worker, what happens",
        "    when a feed dies, and could it be commercial.",
        "  · Have the live site open in a tab. If the demonstration is asked",
        "    for, orbital-liveview.vercel.app — and the landing page is at",
        "    /landing.",
        "",
    ]

    OUT.write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"wrote {OUT}  ({OUT.stat().st_size:,} bytes)")
    if drift:
        print("WARNING: guide and deck disagree —")
        for line in drift:
            print(line)


if __name__ == "__main__":
    main()
