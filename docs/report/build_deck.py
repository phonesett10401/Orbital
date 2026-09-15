"""Extend the Orbital deck with the Chapter 4 and Chapter 5 material.

**The existing six slides are not touched.** They were designed with a
particular look - starfield background, Saira Medium headings, Roboto body,
one orange accent - and rebuilding the deck from scratch would throw that away
to gain nothing. New slides are created on the same layout, so they inherit the
same background, and every colour and size below was read out of the existing
slides rather than chosen:

    accent  FC8337      the one orange, used for rules, borders and icons
    card    030303      the near-black card fill, on a black starfield
    ink     FFFFFF      headings
    body    E5E0DF      body text, slightly warm off-white

Figures come from `figures/`, the same PNGs the report uses, so a colour means
the same thing on a slide as it does on the page.

The new slides are inserted **before** the closing slide, so "What Orbital
Delivers" stays last. A deck that ends on a database diagram ends in the middle
of a sentence.
"""

from __future__ import annotations

import io
import pathlib

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.shapes.autoshape import Shape
from pptx.util import Emu, Inches, Pt

HERE = pathlib.Path(__file__).parent
FIGURES = HERE / "figures"
SOURCE = pathlib.Path.home() / "Downloads" / "Orbital.pptx"
TARGET = HERE / "documents" / "Orbital-Presentation.pptx"

ACCENT = RGBColor(0xFC, 0x83, 0x37)
CARD = RGBColor(0x03, 0x03, 0x03)
INK = RGBColor(0xFF, 0xFF, 0xFF)
BODY = RGBColor(0xE5, 0xE0, 0xDF)

DISPLAY = "Saira Medium"
TEXT = "Roboto"

SLIDE_W, SLIDE_H = Inches(13.3333), Inches(7.5)


def textbox(slide, x, y, w, h, text, *, size, colour, font=TEXT, bold=False,
            align=PP_ALIGN.LEFT, spacing=1.0):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    for index, line in enumerate(text.split("\n")):
        para = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        para.alignment = align
        para.line_spacing = spacing
        run = para.add_run()
        run.text = line
        run.font.name = font
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = colour
    return box


def card(slide, x, y, w, h, *, fill=CARD, line=ACCENT, width_pt=1.0,
         radius=0.03):
    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shape.adjustments[0] = radius
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
    shape.line.color.rgb = line
    shape.line.width = Pt(width_pt)
    shape.shadow.inherit = False
    return shape


def figure(slide, name, x, y, w, h, *, plate=True):
    """Place a report figure inside a box, preserving its aspect ratio.

    The figures have white backgrounds and the deck is black, so each one sits
    on a white plate with the accent border - which is the treatment the
    existing slide 5 already used for its diagram. Without the plate the figure
    reads as a hole punched in the slide.
    """
    from PIL import Image

    path = FIGURES / name
    with Image.open(path) as image:
        aspect = image.width / image.height

    pad = 0.12 if plate else 0.0
    inner_w, inner_h = w - 2 * pad, h - 2 * pad
    if inner_w / inner_h > aspect:      # box is wider than the image
        draw_h = inner_h
        draw_w = inner_h * aspect
    else:
        draw_w = inner_w
        draw_h = inner_w / aspect
    draw_x = x + (w - draw_w) / 2
    draw_y = y + (h - draw_h) / 2

    if plate:
        card(slide, draw_x - pad, draw_y - pad, draw_w + 2 * pad,
             draw_h + 2 * pad, fill=RGBColor(0xFF, 0xFF, 0xFF), line=ACCENT,
             width_pt=1.0, radius=0.02)
    slide.shapes.add_picture(str(path), Inches(draw_x), Inches(draw_y),
                             Inches(draw_w), Inches(draw_h))


def title_block(slide, title, lede=None):
    textbox(slide, 0.72, 0.52, 11.89, 0.7, title, size=33.5, colour=INK,
            font=DISPLAY)
    if lede:
        textbox(slide, 0.72, 1.24, 11.89, 0.62, lede, size=13.0, colour=BODY,
                spacing=1.15)


def notes(slide, text):
    """Speaker notes, with a fallback.

    This deck's notes master has no body placeholder, so `notes_text_frame` is
    None and assigning to it raises. Adding a plain textbox to the notes slide
    puts the text where PowerPoint's notes pane shows it either way.
    """
    notes_slide = slide.notes_slide
    frame = notes_slide.notes_text_frame
    if frame is None:
        # `NotesSlideShapes` has no add_textbox, but the underlying element
        # tree does - it is the same CT_GroupShape a slide uses.
        tree = notes_slide.shapes._spTree
        element = tree.add_textbox(
            len(tree.findall(qn("p:sp"))) + 2, "Speaker notes",
            Inches(0.6), Inches(0.6), Inches(6.0), Inches(3.2))
        frame = Shape(element, None).text_frame
        frame.word_wrap = True
    frame.text = text


def main() -> None:
    prs = Presentation(str(SOURCE))
    layout = next(l for l in prs.slide_master.slide_layouts
                  if l.name == "Slide master 1")

    # The small wordmark sits bottom-right on every existing content slide.
    #
    # **Deep-copying the element does not work.** A picture element carries an
    # `r:embed` pointing at a relationship id, and relationships are per-slide:
    # copied onto a new slide the id resolves to nothing and PowerPoint renders
    # the box as "The picture can't be displayed". The image *bytes* have to be
    # added to each slide so each gets its own relationship.
    stamp = next(sh for sh in prs.slides[1].shapes
                 if sh.shape_type == 13 and sh.width < Inches(2))
    stamp_blob = stamp.image.blob
    stamp_box = (stamp.left, stamp.top, stamp.width, stamp.height)

    # ---- two pictures on the original slides are replaced in place ---------
    #
    # These are the only edits to the six slides that already existed. Both are
    # swaps of one image for a better one, not redesigns: the surrounding card,
    # text and position are untouched.
    def swap_picture(slide, match, name, *, box=None):
        """Replace a picture with a figure, fitted inside the same footprint.

        python-pptx cannot repoint a picture at new bytes, so the old shape is
        removed and a new one added. `box` overrides the footprint when the old
        picture did not fill the space available to it.
        """
        from PIL import Image

        old = next(sh for sh in slide.shapes
                   if sh.shape_type == 13 and match(sh))
        x, y, w, h = box or (old.left, old.top, old.width, old.height)
        old._element.getparent().remove(old._element)

        path = FIGURES / name
        with Image.open(path) as image:
            aspect = image.width / image.height
        draw_w, draw_h = (w, int(w / aspect)) if (w / h) < aspect else \
                         (int(h * aspect), h)
        slide.shapes.add_picture(str(path), x + (w - draw_w) // 2,
                                 y + (h - draw_h) // 2, draw_w, draw_h)

    # Feasibility: same measurements, redrawn in the palette the other nine
    # figures share. The numbers were already right - they are test-plan §4.
    swap_picture(prs.slides[3], lambda sh: sh.width > Inches(5),
                 "2-1-backend-cost-per-stage.png")

    # Reliability: the old diagram showed five use cases and one actor; §3.4
    # has eleven and five, so the slide and the report disagreed about what the
    # system does. Fitted to the white card rather than to the old picture,
    # which did not fill it.
    swap_picture(prs.slides[4], lambda sh: sh.width > Inches(4),
                 "3-1-use-case-diagram-slide.png",
                 box=(Inches(7.02), Inches(2.17), Inches(5.86), Inches(3.69)))

    made = []

    def new_slide():
        slide = prs.slides.add_slide(layout)
        slide.shapes.add_picture(io.BytesIO(stamp_blob), *stamp_box)
        made.append(slide)
        return slide

    # ---- 1. planning: the work and who owns it ---------------------------
    s = new_slide()
    title_block(s, "Planning: six packages, five people",
                "Seven roles across five members, so most hold two. Work is "
                "decomposed to the level where one person owns one deliverable "
                "— any deeper and a WBS is a task list that is stale in a week.")
    figure(s, "4-1-work-breakdown.png", 4.35, 1.95, 8.6, 5.15)
    for index, (head, body) in enumerate([
        ("Phase, not component", "Package 3 is split by delivered phase.\nA component split would describe the\narchitecture, not the work."),
        ("One owner each", "Every 1.x deliverable has a name\nagainst it, not a team."),
    ]):
        y = 2.25 + index * 1.95
        textbox(s, 0.72, y, 3.4, 0.35, head, size=17.0, colour=INK, font=DISPLAY)
        textbox(s, 0.72, y + 0.45, 3.4, 1.3, body, size=12.0, colour=BODY,
                spacing=1.25)
    notes(s, "Six work packages. Note that backend is broken down by delivered "
             "phase rather than by component — that is what makes the cost of "
             "each new object type visible.")

    # ---- 2. the schedule -------------------------------------------------
    s = new_slide()
    title_block(s, "The plan, and the three milestones",
                "Twelve weeks. This is the plan the team worked to, not a chart "
                "redrawn afterwards to match what happened — keeping those apart "
                "is the only reason comparing them is worth anything.")
    figure(s, "4-2-gantt-chart.png", 4.35, 1.95, 8.6, 5.15)
    for index, (head, body) in enumerate([
        ("The critical path", "Requirements → data contract →\nfirst provider → poller and store\n→ API → first layer on screen."),
        ("Then it goes parallel", "Satellites, ships and accounts each\ntouch a different provider or route.\nNone blocks another — by design."),
    ]):
        y = 2.25 + index * 1.95
        textbox(s, 0.72, y, 3.4, 0.35, head, size=17.0, colour=INK, font=DISPLAY)
        textbox(s, 0.72, y + 0.45, 3.4, 1.3, body, size=12.0, colour=BODY,
                spacing=1.25)
    notes(s, "Milestones at weeks 3, 8 and 11. The critical path is the first "
             "vertical slice; everything after it runs in parallel because the "
             "shared data shape was fixed before any provider was written.")

    # ---- 3. risk ---------------------------------------------------------
    s = new_slide()
    # Phone's call: one realised risk on the slide, not two. The six-session
    # misdiagnosis is honest and it belongs in §4.6 where a reader has the
    # context for it; on a slide with fifteen seconds of attention it reads as
    # an apology rather than as evidence the register was kept honestly. R7
    # stays on the slide as a risk, without the confession.
    title_block(s, "Risks, and what they cost",
                "Graded by likelihood and impact, each with the mitigation that "
                "was actually built. One of them happened.")
    # R1 to R4 of §4.6, in the register's own order. An earlier version showed
    # R1, R2, R4 and R7, which reads as an arbitrary four picked out of nine -
    # so the register itself is ordered so that its first four are the four
    # worth presenting, and the numbers here are the report's numbers.
    #
    # The ordering rule is "how much did this shape the system", not
    # probability times impact: these four each have a structural mitigation,
    # something in the architecture that exists because of them. That is also
    # why they are the interesting ones to show.
    #
    # R3 overlaps the Feasibility slide, which argues the same thing with
    # measurements. Phone's call, and it is defensible: the two slides make the
    # claim in different registers - one shows the milliseconds, the other says
    # what the risk was and what was built because of it. When presenting, the
    # second mention should point back rather than repeat the numbers.
    risks = [
        ("R1  Upstream feed disappears", "HAPPENED",
         "OpenSky became unreachable from every cloud host, mid-project.",
         "Cost: one provider module and one registry entry. Nothing above the "
         "ingestion layer changed."),
        ("R2  Rate limited or banned", "HELD",
         "One backend for all viewers; limits measured, not assumed.",
         "Four requests a minute against a measured cap of five."),
        ("R3  Browser cannot draw the count", "HELD",
         "40,000 objects is not a legible map at any frame rate.",
         "Responses thinned to 2,000; one layer at a time; positions "
         "interpolated between polls."),
        ("R4  Traffic outgrows one backend", "HELD",
         "One worker serves every viewer, on a free tier, single-threaded.",
         "Viewer count costs no upstream quota. Twenty-nine polls in thirty "
         "answer 304 without building a response."),
    ]
    for index, (head, state, what, response) in enumerate(risks):
        col, row = index % 2, index // 2
        x = 0.72 + col * 6.08
        y = 2.15 + row * 2.42
        realised = state == "HAPPENED"
        card(s, x, y, 5.72, 2.12, line=ACCENT,
             width_pt=1.75 if realised else 0.75)
        textbox(s, x + 0.28, y + 0.24, 4.0, 0.3, head, size=15.5, colour=INK,
                font=DISPLAY)
        textbox(s, x + 4.35, y + 0.28, 1.1, 0.24, state, size=9.0,
                colour=ACCENT if realised else BODY, font=DISPLAY,
                align=PP_ALIGN.RIGHT)
        textbox(s, x + 0.28, y + 0.70, 5.16, 0.5, what, size=11.5, colour=BODY,
                spacing=1.2)
        textbox(s, x + 0.28, y + 1.32, 5.16, 0.66, response, size=11.5,
                colour=ACCENT if realised else BODY, spacing=1.2)
    notes(s, "R1 is the one that actually happened: the architecture was "
             "designed so that losing a feed costs one module, and when OpenSky "
             "went it cost exactly that. R4 is the one with a ceiling, and be "
             "ready for the follow-up - scaling is vertical only, because a "
             "second worker would open a second AIS socket and the two stores "
             "would disagree. Past a bigger box the design has to change, and "
             "4.6 says so. The full register of ten is section 4.6.")

    # ---- 4. architecture -------------------------------------------------
    s = new_slide()
    title_block(s, "Three layers, one direction",
                "Each layer knows only the layer beneath it. The browser never "
                "talks to a data source, so rate limiting is enforced in exactly "
                "one place — a hundred tabs cost the same quota as one.")
    figure(s, "5-1-system-architecture.png", 1.55, 1.95, 10.2, 5.2)
    notes(s, "Five external feeds, three internal layers. The single most "
             "important property: upstream failure is contained at layer 1.")

    # ---- 5. database -----------------------------------------------------
    s = new_slide()
    title_block(s, "Two tables — and that is the design",
                "A tracker looks like a system that needs a large database. "
                "Orbital deliberately has almost none.")
    figure(s, "5-2-er-diagram.png", 4.35, 1.95, 8.6, 5.15)
    for index, (head, body) in enumerate([
        ("Accounts and sessions", "The only state worth surviving a\nrestart. The raw session token is\nreturned once and never stored."),
        ("Everything else is memory", "A poll replaces the snapshot.\nNo schema migration for the thing\nthat changes most: a feed's shape."),
    ]):
        y = 2.25 + index * 1.95
        textbox(s, 0.72, y, 3.4, 0.35, head, size=17.0, colour=INK, font=DISPLAY)
        textbox(s, 0.72, y + 0.45, 3.4, 1.3, body, size=12.0, colour=BODY,
                spacing=1.25)
    notes(s, "The honest cost: Orbital cannot answer a question about last "
             "Tuesday. Entitlement windows are bounded by what is still in "
             "memory, not by a query.")

    # ---- 6. the class diagram and the union ------------------------------
    s = new_slide()
    title_block(s, "Why a second feed cost one file",
                "UnionProvider inherits Provider and holds two of them. A caller "
                "cannot tell a pair of feeds from a single feed — which is why "
                "losing a primary source changed nothing above ingestion.")
    figure(s, "5-3-class-diagram.png", 1.55, 1.95, 10.2, 5.2)
    notes(s, "Seven concrete providers, one abstraction. The API never holds a "
             "Provider, so there is no call path from a request to a socket.")

    # ---- 7. the interface ------------------------------------------------
    s = new_slide()
    title_block(s, "The interface, and the honesty line",
                "Captured from the live deployment. The counts in the status bar "
                "are the real ones at the moment of capture.")
    # The raw capture rather than Figure 5.6: the annotated version carries a
    # ten-entry key that is unreadable at slide size, and a slide that needs to
    # be zoomed is a slide nobody reads.
    figure(s, "_app.png", 4.15, 1.95, 8.8, 5.2)
    for index, (head, body) in enumerate([
        ("The map is the product", "Controls sit in the corners.\nNothing floats over the centre."),
        ("One layer at a time", "Three at once is 40,000 markers\nand no legible map."),
        ("It reports its own limits", "2,000 of 13,607 drawn, the data age,\nand which feed answered."),
    ]):
        y = 2.15 + index * 1.62
        textbox(s, 0.72, y, 3.2, 0.32, head, size=15.5, colour=INK, font=DISPLAY)
        textbox(s, 0.72, y + 0.42, 3.2, 1.0, body, size=11.5, colour=BODY,
                spacing=1.25)
    notes(s, "The status bar states that 2,000 of 13,607 objects in view are "
             "drawn, how old the data is, and which feed answered. A tracker "
             "that showed a sample as though it were everything would be easier "
             "to build and would be lying.")

    # ---- move the closing slide back to the end --------------------------
    # add_slide appends, so the six originals now sit before the eight new ones
    # and "What Orbital Delivers" is stranded in the middle.
    sld_id_lst = prs.slides._sldIdLst
    ids = list(sld_id_lst)
    closing = ids[5]
    sld_id_lst.remove(closing)
    sld_id_lst.append(closing)

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(TARGET))
    print(f"wrote {TARGET}  ({TARGET.stat().st_size:,} bytes, "
          f"{len(prs.slides.__iter__.__self__._sldIdLst)} slides)")


if __name__ == "__main__":
    main()
