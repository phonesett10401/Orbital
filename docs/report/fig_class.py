"""Figure 5.3 - class diagram of the ingestion layer.

The ingestion layer is the part of Orbital with real class structure, so it is
the part a class diagram is worth drawing. The API is a set of functions over
a store and the frontend is React components; neither has a hierarchy a UML box
would explain better than the file names already do.

Everything here is read from `backend/app/providers/` and
`backend/app/ingestion/store.py`: the abstract methods are the ones actually
marked `@abstractmethod`, and the concrete providers are the entries in the
registry's `_BUILDERS`.

**The one design point the diagram exists to show** is `UnionProvider`. It
inherits from `Provider` and also *holds* two of them, so a caller cannot tell
a pair of feeds from a single feed - which is why adding a second aircraft
source changed no code above this layer (D83).

Drawn as a trunk-and-bus rather than a fan of diagonals: seven separate lines
converging on one box cross each other and the boxes between them, and the
crossings read as relationships that do not exist.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, EXTERNAL, INK, MUTED, SATELLITE, SHIP,
    STORE, apply_base_style, arrow, blank_axes, _tint,
)

apply_base_style()
fig = plt.figure(figsize=(10.4, 6.6))
ax = blank_axes(fig, ylim=(2, 100))

ROW = 3.1
HEAD = 5.6


def uml(x, top, w, title, *, colour, stereotype=None, attrs=(), ops=(),
        title_italic=False):
    """A UML class box: name, then attributes, then operations."""
    head = HEAD + (2.6 if stereotype else 0)
    body = ROW * (len(attrs) + len(ops)) + (1.6 if attrs and ops else 0) + 2.0
    h = head + body
    ax.add_patch(FancyBboxPatch(
        (x, top - h), w, h, boxstyle="round,pad=0,rounding_size=0.8",
        linewidth=1.7, edgecolor=colour, facecolor="#FFFFFF", zorder=2))
    ax.add_patch(FancyBboxPatch(
        (x + 0.3, top - head), w - 0.6, head - 0.3,
        boxstyle="round,pad=0,rounding_size=0.6",
        linewidth=0, facecolor=_tint(colour, 0.68), zorder=3))

    ty = top - head / 2 - 0.2
    if stereotype:
        ax.text(x + w / 2, top - 2.2, stereotype, ha="center", va="center",
                fontsize=6.3, color=colour, zorder=4, style="italic")
        ty = top - head / 2 - 1.4
    ax.text(x + w / 2, ty, title, ha="center", va="center", fontsize=8.5,
            fontweight="bold", color=INK, zorder=4,
            style="italic" if title_italic else "normal")

    y = top - head - 1.6
    for text in attrs:
        ax.text(x + 2.0, y, text, ha="left", va="center", fontsize=6.6,
                color=MUTED, zorder=4)
        y -= ROW
    if attrs and ops:
        ax.plot([x + 1.2, x + w - 1.2], [y + ROW / 2 - 0.4] * 2,
                color=_tint(colour, 0.45), linewidth=0.9, zorder=4)
        y -= 1.6
    for text in ops:
        ax.text(x + 2.0, y, text, ha="left", va="center", fontsize=6.6,
                color=INK, zorder=4)
        y -= ROW
    return top - h


def leaf(x, top, w, h, name, note, colour, *, emphasis=False):
    """One subclass in the bus row: two-line name over a small italic note."""
    ax.add_patch(FancyBboxPatch(
        (x, top - h), w, h, boxstyle="round,pad=0,rounding_size=0.8",
        linewidth=2.2 if emphasis else 1.6, edgecolor=colour,
        facecolor=_tint(colour, 0.90 if emphasis else 0.955), zorder=2))
    ax.text(x + w / 2, top - h / 2 + 1.5, name, ha="center", va="center",
            fontsize=7.5, fontweight="bold", color=INK, zorder=3,
            linespacing=1.35)
    ax.text(x + w / 2, top - h + 1.9, note, ha="center", va="center",
            fontsize=6.0, color=MUTED, style="italic", zorder=3)


# ---- the abstraction -----------------------------------------------------
base_bottom = uml(31.0, 98.0, 38.0, "Provider", colour=BACKEND,
                  stereotype="«abstract»", title_italic=True,
                  ops=["+ fetch(bbox) → list[TrackedObjectRecord]  {abstract}",
                       "+ fetch_track(object_id) → tuple[TrackPoint] | None",
                       "+ aclose()"])

ax.text(70.5, 90.0,
        "Raises ProviderUnavailable,\nProviderRateLimited or\nProviderBadResponse.\n"
        "It never returns a partial answer,\nso a caller cannot mistake\nfewer aircraft for fewer flights.",
        fontsize=6.6, color=ACCENT, va="center", ha="left", linespacing=1.6,
        style="italic")

# ---- trunk and bus -------------------------------------------------------
BUS_Y = 74.0
LEAF_TOP = 70.0
LEAF_H = 11.0
ax.plot([50, 50], [base_bottom, BUS_Y], color=BACKEND, linewidth=1.6, zorder=3)
ax.plot([7.4, 92.6], [BUS_Y, BUS_Y], color=BACKEND, linewidth=1.6, zorder=3)
ax.text(51.4, (base_bottom + BUS_Y) / 2, "generalisation", fontsize=6.6,
        color=MUTED, style="italic", va="center")

leaves = [
    ("AdsbLol\nProvider", "primary aircraft", AIRCRAFT, False),
    ("AdsbFi\nProvider", "supplement", AIRCRAFT, False),
    ("Union\nProvider", "the default", ACCENT, True),
    ("OpenSky\nProvider", "metered, unused", AIRCRAFT, False),
    ("Satellites\nProvider", "TLE + SGP4", SATELLITE, False),
    ("ShipUnion\nProvider", "two AIS feeds", SHIP, False),
    ("Fixture\nProvider", "offline sample", EXTERNAL, False),
]
W = 13.2
PITCH = 14.2
centres = []
for index, (name, note, colour, emphasis) in enumerate(leaves):
    x = 0.8 + index * PITCH
    centre = x + W / 2
    centres.append(centre)
    leaf(x, LEAF_TOP, W, LEAF_H, name, note, colour, emphasis=emphasis)
    ax.plot([centre, centre], [LEAF_TOP, BUS_Y],
            color=colour, linewidth=1.5, zorder=3)

# ---- the composition, drawn locally so it crosses nothing ----------------
union_x = centres[2]
lol_x, fi_x = centres[0], centres[1]
brace_y = 55.0
leaf_bottom = LEAF_TOP - LEAF_H
ax.plot([lol_x, lol_x], [leaf_bottom, brace_y], color=ACCENT, linewidth=1.3,
        linestyle=(0, (3, 2)), zorder=3)
ax.plot([fi_x, fi_x], [leaf_bottom, brace_y], color=ACCENT, linewidth=1.3,
        linestyle=(0, (3, 2)), zorder=3)
ax.plot([lol_x, fi_x], [brace_y, brace_y], color=ACCENT, linewidth=1.3,
        linestyle=(0, (3, 2)), zorder=3)
arrow(ax, (union_x - 3.0, leaf_bottom + 1.0), ((lol_x + fi_x) / 2, brace_y),
      colour=ACCENT, width=1.3, dashed=True, rad=0.20)
ax.text((lol_x + fi_x) / 2, brace_y - 2.0,
        "holds both:  primary every poll,  supplement every 120 s",
        fontsize=6.8, color=ACCENT, ha="center", va="top", style="italic")

ax.text(58.0, 52.0,
        "UnionProvider is a Provider and holds two Providers. A caller cannot tell\n"
        "a pair of feeds from a single feed, which is why the second aircraft source\n"
        "changed nothing at all above this layer.",
        fontsize=6.9, color=MUTED, va="top", ha="left", linespacing=1.6)

# ---- what consumes it ----------------------------------------------------
poll_bottom = uml(10.0, 46.0, 30.0, "Poller", colour=BACKEND,
                  attrs=["- provider: Provider", "- interval_seconds: float",
                         "- backoff: ExponentialBackoff"],
                  ops=["+ run_forever()", "+ poll_once()"])

store_bottom = uml(52.0, 46.0, 36.0, "ObjectStore", colour=STORE,
                   attrs=["- records: dict[str, TrackedObjectRecord]",
                          "- tracks: dict[str, list[_TrackSample]]"],
                   ops=["+ apply(snapshot)", "+ get(bbox) / get_detail(id)",
                        "+ search(query, limit)", "+ is_stale(now)"])

arrow(ax, (25.0, 46.0), (union_x - 4.0, leaf_bottom - 0.5), colour=BACKEND,
      width=1.4, dashed=True, rad=-0.10)
ax.text(31.0, 53.5, "polls", fontsize=6.8, color=MUTED, style="italic")

arrow(ax, (40.0, 33.0), (52.0, 33.0), colour=BACKEND, width=1.5)
ax.text(46.0, 35.0, "applies", fontsize=6.8, color=MUTED, style="italic",
        ha="center")

ax.text(52.0, store_bottom - 3.0,
        "The API layer reads this store and nothing else. It never holds a Provider,\n"
        "which is the whole reason an upstream failure cannot reach a response:\n"
        "there is no call path from a request to a socket.",
        fontsize=6.9, color=MUTED, va="top", ha="left", linespacing=1.6)

ax.text(1.0, 3.0,
        "Solid line = generalisation (is-a)   ·   dashed = association (holds / uses)",
        fontsize=7.0, color=MUTED, ha="left", va="bottom")

out = pathlib.Path(__file__).parent / "figures" / "5-3-class-diagram.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
