"""Figure 5.5 - activity diagram: one poll cycle, including the ways it fails.

An activity diagram of the happy path would be a straight line and would say
nothing. The branches are the content here: three of the four outcomes of a
fetch are failures, and what Orbital does with each of them is the reason the
map does not go blank when a feed does.

Read from `backend/app/ingestion/poller.py` and the exception classes in
`providers/base.py`.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyBboxPatch, Polygon
from figures_style import (
    ACCENT, BACKEND, DPI, INK, MUTED, OK, STORE, apply_base_style, arrow,
    blank_axes, _tint,
)

apply_base_style()
fig = plt.figure(figsize=(8.6, 9.4))
ax = blank_axes(fig, ylim=(0, 100))


def action(x, y, w, h, text, colour, *, size=7.6):
    ax.add_patch(FancyBboxPatch(
        (x - w / 2, y - h / 2), w, h,
        boxstyle="round,pad=0,rounding_size=1.6",
        linewidth=1.7, edgecolor=colour, facecolor=_tint(colour, 0.90),
        zorder=3))
    ax.text(x, y, text, ha="center", va="center", fontsize=size, color=INK,
            zorder=4, linespacing=1.45)


def decision(x, y, w, h, text, colour):
    ax.add_patch(Polygon([(x, y + h / 2), (x + w / 2, y), (x, y - h / 2),
                          (x - w / 2, y)],
                         closed=True, linewidth=1.7, edgecolor=colour,
                         facecolor=_tint(colour, 0.88), zorder=3))
    ax.text(x, y, text, ha="center", va="center", fontsize=7.2, color=INK,
            zorder=4, linespacing=1.4, fontweight="bold")


def terminal(x, y, filled, colour):
    ax.add_patch(Circle((x, y), 1.9, linewidth=1.8, edgecolor=colour,
                        facecolor=colour if filled else "#FFFFFF", zorder=4))
    if not filled:
        ax.add_patch(Circle((x, y), 1.15, linewidth=0, facecolor=colour,
                            zorder=5))


MAIN = 36.0
SUCCESS = 16.0   # the happy-path column, clear of the return line at x = 3

terminal(MAIN, 96.5, True, INK)
arrow(ax, (MAIN, 94.6), (MAIN, 91.0), colour=MUTED, width=1.5)

action(MAIN, 87.0, 34.0, 7.0, "Wait for the poll interval", BACKEND)
arrow(ax, (MAIN, 83.5), (MAIN, 79.5), colour=MUTED, width=1.5)

action(MAIN, 75.5, 34.0, 7.0, "Provider.fetch(bbox)", BACKEND)
arrow(ax, (MAIN, 72.0), (MAIN, 68.5), colour=MUTED, width=1.5)

decision(MAIN, 63.0, 30.0, 11.0, "Outcome?", ACCENT)

# ---- branch 1: rate limited ---------------------------------------------
arrow(ax, (MAIN + 15.0, 63.0), (62.0, 63.0), colour=ACCENT, width=1.4)
ax.text(52.0, 64.4, "ProviderRateLimited", ha="center", va="bottom",
        fontsize=6.9, color=ACCENT, style="italic")
action(78.0, 63.0, 30.0, 10.0,
       "Honour Retry-After;\ndouble the backoff", ACCENT, size=7.2)
arrow(ax, (78.0, 58.0), (78.0, 46.0), colour=ACCENT, width=1.4)

# ---- branch 2: unavailable ----------------------------------------------
arrow(ax, (MAIN, 57.5), (MAIN, 51.0), colour=ACCENT, width=1.4)
ax.text(MAIN + 1.6, 54.2, "ProviderUnavailable  /  ProviderBadResponse",
        ha="left", va="center", fontsize=6.9, color=ACCENT, style="italic")
action(MAIN, 46.0, 40.0, 10.0,
       "Keep the previous snapshot.\nMark the store stale.", STORE, size=7.2)
arrow(ax, (MAIN, 41.0), (MAIN, 36.0), colour=MUTED, width=1.4)

# ---- branch 3: success ---------------------------------------------------
arrow(ax, (MAIN - 15.0, 63.0), (SUCCESS + 11.0, 63.0), colour=OK, width=1.4)
ax.text(30.0, 66.4, "records", ha="center", va="bottom", fontsize=6.9,
        color=OK, style="italic")
action(SUCCESS, 63.0, 22.0, 10.0, "Normalise to the\nshared shape", OK, size=7.2)
arrow(ax, (SUCCESS, 58.0), (SUCCESS, 51.0), colour=OK, width=1.4)
action(SUCCESS, 46.0, 22.0, 10.0, "store.apply()\nreset the backoff", OK, size=7.2)
arrow(ax, (SUCCESS, 41.0), (SUCCESS, 36.0), colour=OK, width=1.4)

# ---- merge ---------------------------------------------------------------
ax.plot([SUCCESS, 78.0], [34.0, 34.0], color=MUTED, linewidth=1.5, zorder=2)
ax.plot([MAIN, MAIN], [36.0, 34.0], color=MUTED, linewidth=1.5, zorder=2)
ax.plot([SUCCESS, SUCCESS], [36.0, 34.0], color=MUTED, linewidth=1.5, zorder=2)
ax.plot([78.0, 78.0], [46.0, 34.0], color=ACCENT, linewidth=1.4, zorder=2)
arrow(ax, (MAIN, 34.0), (MAIN, 29.5), colour=MUTED, width=1.5)

action(MAIN, 25.0, 46.0, 8.0,
       "Evict anything not seen for the retention window", BACKEND, size=7.2)
arrow(ax, (MAIN, 21.0), (MAIN, 17.0), colour=MUTED, width=1.5)

decision(MAIN, 11.5, 30.0, 11.0, "Shutting\ndown?", BACKEND)
arrow(ax, (MAIN - 15.0, 11.5), (12.0, 11.5), colour=MUTED, width=1.4)
ax.text(24.0, 12.9, "no", ha="center", va="bottom", fontsize=6.9, color=MUTED,
        style="italic")
# Back up the left margin to the wait state.
ax.plot([12.0, 3.0], [11.5, 11.5], color=MUTED, linewidth=1.5, zorder=2)
ax.plot([3.0, 3.0], [11.5, 87.0], color=MUTED, linewidth=1.5, zorder=2)
arrow(ax, (3.0, 87.0), (MAIN - 17.0, 87.0), colour=MUTED, width=1.5)

arrow(ax, (MAIN, 6.0), (MAIN, 3.4), colour=MUTED, width=1.4)
ax.text(MAIN + 1.6, 4.9, "yes", ha="left", va="center", fontsize=6.9,
        color=MUTED, style="italic")
terminal(MAIN, 1.6, False, INK)

# ---- the point -----------------------------------------------------------
ax.add_patch(FancyBboxPatch(
    (55.0, 74.0), 44.0, 22.0, boxstyle="round,pad=0,rounding_size=1.4",
    linewidth=1.4, edgecolor=ACCENT, facecolor=_tint(ACCENT, 0.955), zorder=1))
ax.text(57.0, 93.5,
        "Three of the four outcomes are failures,\n"
        "and none of them empties the store.\n\n"
        "A feed that goes dark costs freshness,\n"
        "which is visible and labelled, rather than\n"
        "costing the map, which would not be.\n\n"
        "The retention window is what finally\n"
        "removes an object nobody is reporting.",
        fontsize=6.9, color=MUTED, va="top", ha="left", linespacing=1.55)

out = pathlib.Path(__file__).parent / "figures" / "5-5-activity-diagram.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
