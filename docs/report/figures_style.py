"""Shared drawing furniture for the report's figures.

Every figure in Chapters 4 and 5 is drawn here rather than in a diagramming
tool, for the same reason the rest of this report is generated: a figure that
is drawn by hand goes stale silently the moment the thing it describes moves,
and nobody notices until a marker does. These are rebuilt by one command.

**The report was deliberately black and white** - the README says so, and the
reason was that it is meant to be presented in ten to fifteen minutes rather
than read at length. The figures are the exception, on Phone's instruction:
a nine-box architecture diagram in greyscale asks the reader to hold the
legend in their head, and colour is doing real work there rather than
decorating.

One palette across every figure and both deliverables, so a colour means the
same thing on slide 9 as it does on page 31.
"""

from __future__ import annotations

import matplotlib
matplotlib.use("Agg")

import matplotlib.patheffects as pe
from matplotlib import font_manager
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

# The three tracked object types keep the colours the application itself uses,
# so a reader who has seen the map recognises them in the diagram.
AIRCRAFT = "#F59E0B"   # amber, the altitude ramp's mid-point
SATELLITE = "#06B6D4"  # cyan, the LEO shell
SHIP = "#10B981"       # green, the vessel layer

BACKEND = "#6366F1"    # indigo
FRONTEND = "#8B5CF6"   # violet
STORE = "#EC4899"      # pink, anything that persists
EXTERNAL = "#64748B"   # slate, everything outside our boundary
ACCENT = "#F43F5E"     # rose, for the one thing worth looking at
OK = "#22C55E"

INK = "#0F172A"
MUTED = "#475569"
LINE = "#CBD5E1"
PAPER = "#FFFFFF"

# Word renders at 96 dpi; 200 keeps the text crisp when a full-width figure is
# scaled down into a 6.3 inch column, and keeps the files small enough to sit
# in git without argument.
DPI = 200

FAMILY = "DejaVu Sans"
_available = {f.name for f in font_manager.fontManager.ttflist}
for _candidate in ("Aptos", "Segoe UI", "Calibri", "DejaVu Sans"):
    if _candidate in _available:
        FAMILY = _candidate
        break


def apply_base_style() -> None:
    matplotlib.rcParams.update({
        "font.family": FAMILY,
        "font.size": 9,
        "text.color": INK,
        "figure.facecolor": PAPER,
        "savefig.facecolor": PAPER,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.12,
    })


def blank_axes(fig, rect=(0, 0, 1, 1), xlim=(0, 100), ylim=(0, 100)):
    """An axes with no furniture at all, addressed in 0-100 units both ways."""
    ax = fig.add_axes(rect)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.axis("off")
    return ax


def box(ax, x, y, w, h, *, colour, title, lines=(), title_size=9.5,
        body_size=7.8, radius=1.4, fill=None, text_colour=None, alpha=1.0,
        dashed=False, zorder=2):
    """A rounded box with a bold title and optional smaller lines under it.

    `x, y` is the bottom-left corner, in the axes' own 0-100 units.
    """
    face = fill if fill is not None else _tint(colour)
    patch = FancyBboxPatch(
        (x, y), w, h,
        boxstyle=f"round,pad=0,rounding_size={radius}",
        linewidth=1.6, edgecolor=colour, facecolor=face,
        alpha=alpha, zorder=zorder,
        linestyle=(0, (4, 2.5)) if dashed else "solid",
    )
    ax.add_patch(patch)

    ink = text_colour or INK
    if lines:
        # Title sits above the body rather than centred with it, so boxes with
        # different numbers of lines still line their titles up.
        ax.text(x + w / 2, y + h - 1.6, title, ha="center", va="top",
                fontsize=title_size, fontweight="bold", color=ink, zorder=zorder + 1)
        ax.text(x + w / 2, y + h - 1.6 - title_size * 0.34, "\n".join(lines),
                ha="center", va="top", fontsize=body_size, color=MUTED,
                linespacing=1.55, zorder=zorder + 1)
    else:
        ax.text(x + w / 2, y + h / 2, title, ha="center", va="center",
                fontsize=title_size, fontweight="bold", color=ink,
                linespacing=1.4, zorder=zorder + 1)
    return patch


def _tint(hex_colour: str, amount: float = 0.88) -> tuple[float, float, float]:
    """The same hue, most of the way to white - readable behind body text."""
    hex_colour = hex_colour.lstrip("#")
    r, g, b = (int(hex_colour[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return tuple(c + (1.0 - c) * amount for c in (r, g, b))


def arrow(ax, start, end, *, colour=MUTED, label=None, style="-|>", width=1.5,
          rad=0.0, label_offset=(0, 1.4), dashed=False, label_size=7.2,
          zorder=3):
    ax.add_patch(FancyArrowPatch(
        start, end, arrowstyle=style, mutation_scale=13,
        linewidth=width, color=colour, zorder=zorder,
        connectionstyle=f"arc3,rad={rad}",
        linestyle=(0, (4, 2.5)) if dashed else "solid",
        shrinkA=2, shrinkB=2,
    ))
    if label:
        mx = (start[0] + end[0]) / 2 + label_offset[0]
        my = (start[1] + end[1]) / 2 + label_offset[1]
        ax.text(mx, my, label, ha="center", va="center", fontsize=label_size,
                color=colour, zorder=zorder + 1,
                path_effects=[pe.withStroke(linewidth=3.2, foreground=PAPER)])


def caption(ax, text, *, y=-2.0, size=7.4):
    ax.text(50, y, text, ha="center", va="top", fontsize=size, color=MUTED,
            style="italic")


def legend(ax, entries, *, x=0, y=100, size=7.4, gap=13.0):
    """A horizontal key: [(colour, label), ...] laid left to right."""
    for index, (colour, label) in enumerate(entries):
        cx = x + index * gap
        ax.add_patch(FancyBboxPatch(
            (cx, y), 2.4, 1.7,
            boxstyle="round,pad=0,rounding_size=0.5",
            linewidth=1.2, edgecolor=colour, facecolor=_tint(colour, 0.62)))
        ax.text(cx + 3.2, y + 0.85, label, ha="left", va="center",
                fontsize=size, color=MUTED)
