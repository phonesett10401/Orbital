"""Figure 3.1 - use case diagram, redrawn.

§3.4 carried this as ASCII art. That was honest for a draft and is not
acceptable in a submitted report: the alignment depends on a monospace font at
a size pandoc keeps changing, the actor inheritance was drawn with underscores
that read as noise, and `«include»` and `«extend»` could not be distinguished
from a plain line at all.

Same eleven use cases, same five actors, same relationships. Nothing here is
new content; it is the same diagram in a form that survives a page break.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import Ellipse, FancyBboxPatch, Polygon
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, EXTERNAL, FRONTEND, INK, MUTED, OK,
    SATELLITE, STORE, apply_base_style, arrow, blank_axes, _tint,
)

apply_base_style()
fig = plt.figure(figsize=(11.0, 7.6))
ax = blank_axes(fig, ylim=(0, 100))


def usecase(x, y, w, h, code, text, colour):
    ax.add_patch(Ellipse((x, y), w, h, linewidth=1.6, edgecolor=colour,
                         facecolor=_tint(colour, 0.90), zorder=3))
    ax.text(x, y + 1.5, code, ha="center", va="center", fontsize=6.6,
            fontweight="bold", color=colour, zorder=4)
    ax.text(x, y - 1.7, text, ha="center", va="center", fontsize=7.0,
            color=INK, zorder=4, linespacing=1.3)


def actor(x, y, name, colour, *, secondary=False):
    """A stick figure. Crude by nature, and instantly recognisable, which is
    the entire reason UML kept it."""
    head_r = 1.5
    ax.add_patch(Ellipse((x, y + 6.2), head_r * 2, head_r * 2.6, linewidth=1.7,
                         edgecolor=colour, facecolor="#FFFFFF", zorder=4))
    ax.plot([x, x], [y + 4.4, y + 0.8], color=colour, linewidth=1.7, zorder=4)
    ax.plot([x - 2.4, x + 2.4], [y + 3.2, y + 3.2], color=colour,
            linewidth=1.7, zorder=4)
    ax.plot([x, x - 2.0], [y + 0.8, y - 2.2], color=colour, linewidth=1.7,
            zorder=4)
    ax.plot([x, x + 2.0], [y + 0.8, y - 2.2], color=colour, linewidth=1.7,
            zorder=4)
    ax.text(x, y - 4.4, name, ha="center", va="center", fontsize=7.2,
            fontweight="bold", color=INK, zorder=4, linespacing=1.35)
    if secondary:
        ax.text(x, y - 8.6, "«secondary»", ha="center", va="center",
                fontsize=6.2, color=MUTED, style="italic", zorder=4)


# ---- the system boundary -------------------------------------------------
ax.add_patch(FancyBboxPatch(
    (22.0, 16.0), 56.0, 79.0, boxstyle="round,pad=0,rounding_size=1.6",
    linewidth=1.8, edgecolor=INK, facecolor="#FCFCFD", zorder=1))
ax.text(50.0, 91.5, "ORBITAL  —  SYSTEM BOUNDARY", ha="center", va="center",
        fontsize=8.6, fontweight="bold", color=INK, zorder=4)

UW, UH = 22.0, 7.6
person_cases = [
    ("UC-01", "View the map", 82.0, FRONTEND),
    ("UC-02", "Switch layer", 71.5, FRONTEND),
    ("UC-03", "Select an object", 61.0, FRONTEND),
    ("UC-04", "Search", 50.5, FRONTEND),
    ("UC-05", "Register / sign in", 40.0, STORE),
    ("UC-06", "View a past instant", 29.5, STORE),
]
for code, text, y, colour in person_cases:
    usecase(36.0, y, UW, UH, code, text, colour)

system_cases = [
    ("UC-07", "Poll a data source", 82.0, AIRCRAFT),
    ("UC-08", "Refresh elements", 71.5, SATELLITE),
    ("UC-09", "Maintain AIS stream", 61.0, OK),
    ("UC-10", "Evict stale objects", 50.5, AIRCRAFT),
    ("UC-11", "Promote to admin", 40.0, ACCENT),
]
for code, text, y, colour in system_cases:
    usecase(65.0, y, UW, UH, code, text, colour)

# ---- relationships between use cases -------------------------------------
# Routed through the channel between the two columns. Drawn straight across,
# each of these would pass through three unrelated use cases, and a line that
# crosses an ellipse reads as touching it.
def channel(y_from, y_to, x_lane, label):
    ax.plot([47.0, x_lane], [y_from, y_from], color=MUTED, linewidth=1.3,
            linestyle=(0, (4, 2.5)), zorder=3)
    ax.plot([x_lane, x_lane], [y_from, y_to], color=MUTED, linewidth=1.3,
            linestyle=(0, (4, 2.5)), zorder=3)
    arrow(ax, (x_lane, y_to), (47.4, y_to), colour=MUTED, width=1.3,
          dashed=True)
    ax.text(x_lane + 0.7, (y_from + y_to) / 2, label, fontsize=6.4,
            color=MUTED, style="italic", va="center", rotation=90)


channel(61.0, 80.6, 49.2, "«include»")
channel(29.5, 83.4, 52.4, "«extend»")

# ---- actors --------------------------------------------------------------
actor(7.0, 74.0, "Anonymous\nViewer", FRONTEND)
actor(7.0, 48.0, "Registered\nUser", STORE)
actor(7.0, 22.0, "Premium\nUser", ACCENT)
actor(92.0, 68.0, "External\nFeeds", EXTERNAL, secondary=True)
actor(92.0, 34.0, "System\nAdmin", BACKEND, secondary=True)

# Generalisation between the three human actors: each is the one above it,
# plus something.
arrow(ax, (7.0, 56.0), (7.0, 67.6), colour=MUTED, width=1.5, style="-|>")
ax.text(8.6, 61.8, "is a", fontsize=6.6, color=MUTED, style="italic",
        va="center")
arrow(ax, (7.0, 30.0), (7.0, 41.6), colour=MUTED, width=1.5, style="-|>")
ax.text(8.6, 35.8, "is a", fontsize=6.6, color=MUTED, style="italic",
        va="center")

# ---- associations --------------------------------------------------------
for y in (82.0, 71.5, 61.0, 50.5):
    arrow(ax, (10.6, 74.0), (25.4, y), colour=_tint(FRONTEND, 0.25), width=1.1,
          style="-")
arrow(ax, (10.6, 48.0), (25.4, 40.0), colour=_tint(STORE, 0.25), width=1.1,
      style="-")
arrow(ax, (10.6, 22.0), (25.4, 29.5), colour=_tint(ACCENT, 0.25), width=1.1,
      style="-")
for y in (82.0, 71.5, 61.0):
    arrow(ax, (88.4, 68.0), (76.0, y), colour=_tint(EXTERNAL, 0.25), width=1.1,
          style="-")
arrow(ax, (88.4, 34.0), (76.0, 40.0), colour=_tint(BACKEND, 0.25), width=1.1,
      style="-")

# ---- the two notes the ASCII version had underneath ----------------------
ax.text(50.0, 12.0,
        "UC-07 to UC-10 are started by a scheduler rather than by a person. They are in the diagram because every "
        "external dependency\nand every failure mode lives there — a use case model that showed only what a user clicks "
        "would omit the entire risk surface.",
        ha="center", va="top", fontsize=7.0, color=MUTED, linespacing=1.7)

ax.text(50.0, 4.0,
        "UC-11 has no interface. The administrator role exists in the data model and is granted at the command line, "
        "which is recorded here\nrather than hidden: an actor with no screen is a scope boundary, not a feature.",
        ha="center", va="top", fontsize=7.0, color=ACCENT, linespacing=1.7)

out = pathlib.Path(__file__).parent / "figures" / "3-1-use-case-diagram.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
