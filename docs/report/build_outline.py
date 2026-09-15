"""Write a plain-text outline of the report and the deck.

**Read out of the built artefacts, not typed.** Chapter headings come from the
markdown sources, page numbers from the rendered PDF, and slide titles and
speaker notes from the .pptx itself. An outline written by hand is correct on
the day it is written and wrong by the next rebuild; this one is regenerated
with everything else.

    python docs/report/build_outline.py
"""

from __future__ import annotations

import pathlib
import re

HERE = pathlib.Path(__file__).parent
OUT = HERE / "documents" / "Orbital-Outline.txt"
PDF = HERE / "documents" / "Orbital-Report-Chapters-1-5.pdf"
PPTX = HERE / "documents" / "Orbital-Presentation.pptx"

CHAPTERS = [
    "chapter-1-introduction.md",
    "chapter-2-feasibility-and-related-work.md",
    "chapter-3-requirements-analysis.md",
    "chapter-4-project-planning.md",
    "chapter-5-system-design.md",
]

WIDTH = 78


def rule(char: str = "=") -> str:
    return char * WIDTH


def page_index(pdf_path: pathlib.Path) -> dict[str, int]:
    """Heading text -> the page it starts on.

    Searched in the PDF rather than counted from the markdown, because the page
    a section lands on is decided by Word's pagination and nothing else knows
    it. Missing headings are simply left without a number: a wrong page number
    is worse than none.
    """
    try:
        import fitz
    except ImportError:
        return {}
    if not pdf_path.exists():
        return {}

    found: dict[str, int] = {}
    with fitz.open(pdf_path) as doc:
        for number, page in enumerate(doc, start=1):
            for line in page.get_text().splitlines():
                line = line.strip()
                # Headings render as "4.6 Risk Management Plan" etc. The table
                # of contents repeats them, so only the first hit after it is
                # kept - and the TOC pages are skipped by requiring the line to
                # be the whole line rather than a dotted leader entry.
                if re.match(r"^(\d+\.\d+|Chapter \d+:)", line) and line not in found:
                    if not line.endswith(tuple("0123456789")) or ":" in line:
                        found[line] = number
                    elif not re.search(r"\s\d+$", line):
                        found[line] = number
    return found


def report_outline(pages: dict[str, int]) -> list[str]:
    lines: list[str] = []
    for name in CHAPTERS:
        text = (HERE / name).read_text(encoding="utf-8")
        for raw in text.splitlines():
            if raw.startswith("# "):
                title = raw[2:].strip()
                page = pages.get(title)
                lines.append("")
                lines.append(rule("-"))
                lines.append(f"{title}{f'  ...  p{page}' if page else ''}")
                lines.append(rule("-"))
            elif raw.startswith("## "):
                title = raw[3:].strip()
                page = pages.get(title)
                suffix = f"  ...  p{page}" if page else ""
                lines.append(f"  {title}{suffix}")
            elif raw.startswith("### "):
                lines.append(f"      {raw[4:].strip()}")
            elif raw.startswith("!["):
                caption = raw[2:raw.index("](")]
                # "Figure 5.1 — System architecture. Five external feeds, ..."
                # Split on ". " rather than "." — the figure number has a dot
                # in it, and splitting on that leaves "Figure 5".
                short = caption.split(". ")[0]
                lines.append(f"      [FIGURE] {short}")
    return lines


def deck_outline() -> list[str]:
    from pptx import Presentation

    if not PPTX.exists():
        return ["  (presentation not built)"]

    lines: list[str] = []
    prs = Presentation(str(PPTX))
    for number, slide in enumerate(prs.slides, start=1):
        texts = [sh.text_frame.text.strip() for sh in slide.shapes
                 if sh.has_text_frame and sh.text_frame.text.strip()]
        if not texts:
            continue
        # The title is the first text box on every slide in this deck.
        title, *rest = texts
        title = " ".join(title.split())
        lines.append("")
        lines.append(f"  {number:>2}.  {title}")

        for body in rest[:6]:
            body = " ".join(body.split())
            if len(body) > 68:
                body = body[:67] + "…"
            lines.append(f"        · {body}")

        # The notes slide also carries a slide-number placeholder, which is
        # the first text frame on it. Taking the first one printed "1", "2",
        # "3" as the speaker notes for every slide.
        note = ""
        if slide.has_notes_slide:
            for shape in slide.notes_slide.shapes:
                if not shape.has_text_frame:
                    continue
                candidate = " ".join(shape.text_frame.text.split())
                if len(candidate) > 24 and not candidate.isdigit():
                    note = candidate
                    break
        if note:
            lines.append("")
            for index, chunk in enumerate(wrap(note, WIDTH - 16)):
                prefix = "        NOTE: " if index == 0 else "              "
                lines.append(prefix + chunk)
    return lines


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


def main() -> None:
    pages = page_index(PDF)

    body: list[str] = [
        rule(),
        "ORBITAL — CSC480",
        "Outline of the project report and the presentation",
        rule(),
        "",
        "Generated by docs/report/build_outline.py from the built artefacts.",
        "Chapter headings come from the markdown sources, page numbers from the",
        "rendered PDF, slide titles and speaker notes from the .pptx. Rebuild it",
        "after any change rather than editing this file.",
        "",
        "  Report       documents/Orbital-Report-Chapters-1-5.docx / .pdf",
        "  Presentation documents/Orbital-Presentation.pptx",
        "  Figures      figures/*.png, each built by the fig_*.py beside it",
        "",
        "",
        rule(),
        "PART ONE — THE REPORT",
        rule(),
    ]
    body += report_outline(pages)
    body += [
        "",
        "",
        rule(),
        "PART TWO — THE PRESENTATION",
        rule(),
    ]
    body += deck_outline()
    body += [
        "",
        "",
        rule(),
        "NOT YET WRITTEN",
        rule(),
        "",
        "  Chapter 6  System Development   Environment · Modules · Database ·",
        "                                  Screens · Code",
        "  Chapter 7  System Testing       Plan · Cases · Unit · Integration ·",
        "                                  System · UAT · Results",
        "  Chapter 8  Conclusion           Summary · Objectives · Problems ·",
        "                                  Improvements · Lessons",
        "",
        "  Mostly assembly rather than research: docs/decisions.md,",
        "  docs/architecture.md and docs/test-plan.md already hold most of it.",
        "",
        rule(),
        "OPEN QUESTIONS FOR THE TEAM",
        rule(),
        "",
        "  1. The submission date. Chapter 4.3's Gantt assumes twelve weeks from",
        "     25 August 2026, the first commit, because the real date was not to",
        "     hand. START and WEEKS in fig_gantt.py drive every bar.",
        "",
        "  2. Orbital_Team_Roles.pdf documents four members; the report has five.",
        "     Pyae Phyo Maung's roles were confirmed verbally, not from that",
        "     document, and the document has not been updated to match.",
        "",
        "  3. How much of the honest reporting to keep. Section 4.6 records that",
        "     six sessions went to one misdiagnosed defect; the deck does not.",
        "     Section 2.2 records that OpenSky forbids commercial use.",
        "",
        "  4. docs/test-plan.md section 4's frontend figures measure the deleted",
        "     three.js renderer. They need re-measuring against MapLibre before",
        "     Chapter 7 is written from them.",
        "",
    ]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"wrote {OUT}  ({OUT.stat().st_size:,} bytes, {len(body)} lines)")


if __name__ == "__main__":
    main()
