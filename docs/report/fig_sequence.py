"""Figure 5.4 - sequence diagram: a poll, and a request that does not wait for it.

Two interactions on one page, deliberately. Drawn separately they look like an
ordinary background job and an ordinary request; drawn together the actual
design is visible, which is that **they never touch**. The browser's request
does not trigger a fetch, does not wait for one, and cannot fail because one
failed - it reads whatever the store last had. That single property is why an
upstream outage degrades Orbital rather than breaking it, and why a hundred
open tabs cost the same upstream quota as one.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, EXTERNAL, FRONTEND, INK, MUTED, OK, STORE,
    apply_base_style, arrow, blank_axes, _tint,
)

apply_base_style()
fig = plt.figure(figsize=(10.4, 7.4))
ax = blank_axes(fig, ylim=(0, 100))

LIFELINES = [
    ("Browser", FRONTEND, 8.0),
    ("Frontend\n(React + MapLibre)", FRONTEND, 25.0),
    ("API router\n(FastAPI)", BACKEND, 44.0),
    ("ObjectStore\n(in memory)", STORE, 62.0),
    ("Poller", BACKEND, 78.0),
    ("Upstream feed\n(adsb.lol)", EXTERNAL, 91.0),
]
TOP = 90.0
BOTTOM = 8.0

for name, colour, x in LIFELINES:
    ax.add_patch(FancyBboxPatch(
        (x - 7.6, TOP), 15.2, 7.0,
        boxstyle="round,pad=0,rounding_size=0.9",
        linewidth=1.6, edgecolor=colour, facecolor=_tint(colour, 0.86),
        zorder=4))
    ax.text(x, TOP + 3.5, name, ha="center", va="center", fontsize=7.4,
            fontweight="bold", color=INK, zorder=5, linespacing=1.35)
    ax.plot([x, x], [BOTTOM, TOP], color=_tint(colour, 0.45), linewidth=1.2,
            linestyle=(0, (3, 3)), zorder=1)


def active(x, top, bottom, colour):
    """An activation bar: this participant is doing something."""
    ax.add_patch(Rectangle((x - 1.1, bottom), 2.2, top - bottom,
                           linewidth=1.1, edgecolor=colour,
                           facecolor=_tint(colour, 0.55), zorder=3))


def msg(y, x1, x2, label, colour, *, dashed=False, number=None):
    arrow(ax, (x1, y), (x2, y), colour=colour, width=1.4, dashed=dashed,
          style="-|>" if not dashed else "->")
    text = f"{number}.  {label}" if number else label
    ax.text((x1 + x2) / 2, y + 1.3, text, ha="center", va="bottom",
            fontsize=6.8, color=INK if not dashed else MUTED, zorder=5,
            style="italic" if dashed else "normal")


def self_msg(y, x, label, colour):
    ax.plot([x + 1.1, x + 6.0, x + 6.0, x + 1.1],
            [y + 1.6, y + 1.6, y - 1.6, y - 1.6],
            color=colour, linewidth=1.3, zorder=3)
    ax.text(x + 7.0, y, label, ha="left", va="center", fontsize=6.8,
            color=INK, zorder=5)


# ================= phase A: the poll loop, always running =================
ax.add_patch(FancyBboxPatch(
    (1.0, 57.0), 98.0, 29.0, boxstyle="round,pad=0,rounding_size=1.2",
    linewidth=1.3, edgecolor=BACKEND, facecolor="#F5F5FF", zorder=0,
    linestyle=(0, (5, 3))))
ax.text(2.6, 84.4, "A · loop  [every interval, forever]", fontsize=7.6,
        fontweight="bold", color=BACKEND, zorder=5)

active(78.0, 82.0, 60.0, BACKEND)
active(91.0, 79.0, 71.0, EXTERNAL)
active(62.0, 67.0, 60.0, STORE)

msg(79.0, 79.1, 89.9, "fetch(bbox = None)", BACKEND, number="1")
msg(72.0, 89.9, 79.1, "raw aircraft records", EXTERNAL, dashed=True, number="2")
self_msg(68.5, 78.0, "normalise to TrackedObjectRecord", BACKEND)
msg(64.0, 76.9, 63.1, "apply(snapshot)", BACKEND, number="3")
ax.text(62.0, 60.2, "records replaced,\ntrack points appended",
        ha="center", va="top", fontsize=6.6, color=MUTED, style="italic",
        zorder=6, bbox=dict(facecolor="#FFFFFF", edgecolor="none", pad=1.6))

ax.text(2.6, 64.0,
        "On ProviderUnavailable or\nProviderRateLimited the Poller\n"
        "backs off and the store keeps\nits previous snapshot, now\nflagged stale.",
        fontsize=6.7, color=ACCENT, va="top", linespacing=1.6, style="italic",
        zorder=6, bbox=dict(facecolor="#FFFFFF", edgecolor="none", pad=2.0))

# ================= phase B: a request, at any moment =====================
ax.add_patch(FancyBboxPatch(
    (1.0, 10.0), 98.0, 43.0, boxstyle="round,pad=0,rounding_size=1.2",
    linewidth=1.3, edgecolor=FRONTEND, facecolor="#FAF5FF", zorder=0,
    linestyle=(0, (5, 3))))
ax.text(2.6, 51.4, "B · on demand  [whenever the browser asks]", fontsize=7.6,
        fontweight="bold", color=FRONTEND, zorder=5)

active(8.0, 48.0, 14.0, FRONTEND)
active(25.0, 46.0, 17.0, FRONTEND)
active(44.0, 43.0, 22.0, BACKEND)
active(62.0, 40.0, 33.0, STORE)

msg(46.5, 9.1, 23.9, "pan / zoom the map", FRONTEND, number="4")
msg(43.0, 26.1, 42.9, "GET /api/aircraft?bbox=…", FRONTEND, number="5")
msg(39.0, 45.1, 60.9, "get(bbox)", BACKEND, number="6")
msg(35.0, 60.9, 45.1, "matching records", STORE, dashed=True, number="7")
self_msg(30.5, 44.0, "thin to the response cap; add stale flag", BACKEND)
msg(26.0, 42.9, 26.1, "200 JSON + ETag", BACKEND, dashed=True, number="8")
self_msg(21.5, 25.0, "interpolate positions, draw the layer", FRONTEND)
msg(17.5, 23.9, 9.1, "aircraft on screen", FRONTEND, dashed=True, number="9")

ax.text(50.0, 6.0,
        "The API never calls a Provider. There is no path from a request to a socket, so a request "
        "cannot be slow because\nan upstream is slow, cannot fail because an upstream failed, and "
        "costs nothing against the upstream's rate limit.",
        ha="center", va="top", fontsize=7.2, color=ACCENT, linespacing=1.7,
        fontweight="bold")

out = pathlib.Path(__file__).parent / "figures" / "5-4-sequence-diagram.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
