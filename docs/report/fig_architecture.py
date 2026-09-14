"""Figure 5.1 - system architecture.

Drawn from `docs/architecture.md` §2 and the provider registry, not from
memory: the upstreams are the ones `_BUILDERS` can actually construct, and the
default pairing is the one `config.py` defaults to.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, EXTERNAL, FRONTEND, INK, LINE, MUTED,
    SATELLITE, SHIP, STORE, apply_base_style, arrow, blank_axes, box, legend,
)

apply_base_style()
fig = plt.figure(figsize=(9.6, 7.4))
ax = blank_axes(fig, ylim=(-4, 104))

# ---- tier 0: the upstreams, outside our boundary -------------------------
feeds = [
    (1.5, "adsb.lol", ["primary aircraft feed", "free, rate limited"], AIRCRAFT),
    (21.0, "adsb.fi", ["supplement, every 120 s", "fills the primary's gaps"], AIRCRAFT),
    (40.5, "Celestrak", ["TLE orbital elements", "propagated locally"], SATELLITE),
    (60.0, "SatNOGS", ["satellite names", "and families"], SATELLITE),
    (79.5, "digitraffic.fi", ["+ aisstream websocket", "vessel positions"], SHIP),
]
for x, name, lines, colour in feeds:
    box(ax, x, 86.5, 19.0, 11.0, colour=colour, title=name, lines=lines,
        title_size=9.0, body_size=6.9, dashed=True)
    arrow(ax, (x + 9.5, 86.5), (x + 9.5, 79.5), colour=colour, width=1.3)

# A white halo, because this line crosses two of the arrows above it and the
# alternative - moving it clear - costs the vertical space the tiers need.
ax.text(50, 82.9, "HTTPS, once per interval, once per server  —  the browser never talks to a source",
        ha="center", va="center", fontsize=7.4, color=ACCENT, fontweight="bold",
        path_effects=[pe.withStroke(linewidth=5.0, foreground="#FFFFFF")])

# ---- tier 1: ingestion ---------------------------------------------------
box(ax, 1.5, 54.0, 97.0, 25.0, colour=BACKEND, title="", fill="#FFFFFF")
ax.text(4.0, 76.4, "1 · INGESTION", fontsize=9.6, fontweight="bold", color=BACKEND)
ax.text(4.0, 73.3, "backend/app/providers, backend/app/ingestion", fontsize=7.2,
        color=MUTED, style="italic")

inner = [
    (4.0, "Provider", ["speaks HTTP to one", "upstream; returns the", "normalised shape only"]),
    (28.0, "Union", ["two providers as one:", "primary every poll,", "supplement every 120 s"]),
    (52.0, "Poller", ["schedules fetches,", "owns retry and", "exponential backoff"]),
    (76.0, "Store", ["latest snapshot plus", "per-object history,", "entirely in memory"]),
]
for x, title, lines in inner:
    colour = STORE if title == "Store" else BACKEND
    box(ax, x, 56.0, 20.0, 15.0, colour=colour, title=title, lines=lines,
        title_size=8.8, body_size=6.8)
for x in (24.0, 48.0, 72.0):
    arrow(ax, (x, 63.5), (x + 4.0, 63.5), colour=BACKEND, width=1.3)

arrow(ax, (50, 54.0), (50, 46.5), colour=BACKEND, width=1.6,
      label="in-process function calls — never a network hop", label_offset=(0, 2.2))

# ---- tier 2: API ---------------------------------------------------------
box(ax, 1.5, 30.5, 97.0, 16.0, colour=BACKEND, title="", fill="#FFFFFF")
ax.text(4.0, 44.0, "2 · API", fontsize=9.6, fontweight="bold", color=BACKEND)
ax.text(4.0, 40.9, "backend/app/api  ·  FastAPI, one worker", fontsize=7.2,
        color=MUTED, style="italic")

api = [
    (4.0, "Read the store", ["never calls upstream"]),
    (25.5, "Filter by bbox", ["only what is on screen"]),
    (47.0, "Thin", ["cap objects per response"]),
    (68.5, "Accounts", ["SQLite: sign-in,", "sessions, entitlements"]),
]
for x, title, lines in api:
    colour = STORE if title == "Accounts" else BACKEND
    width = 26.5 if title == "Accounts" else 19.5
    box(ax, x, 32.0, width, 8.0, colour=colour, title=title, lines=lines,
        title_size=8.4, body_size=6.8)

arrow(ax, (50, 30.5), (50, 23.0), colour=FRONTEND, width=1.6,
      label="REST over HTTPS, polled by the browser", label_offset=(0, 2.2))

# ---- tier 3: frontend ----------------------------------------------------
box(ax, 1.5, 4.0, 97.0, 19.0, colour=FRONTEND, title="", fill="#FFFFFF")
ax.text(4.0, 20.5, "3 · FRONTEND", fontsize=9.6, fontweight="bold", color=FRONTEND)
ax.text(4.0, 17.4, "frontend/src  ·  React + TypeScript, static build on Vercel",
        fontsize=7.2, color=MUTED, style="italic")

front = [
    (4.0, "MapLibre renderer", ["src/planet — one WebGL", "surface, every layer"]),
    (28.0, "Interpolation", ["dead reckoning between", "polls, so motion is smooth"]),
    (52.0, "Shared tables", ["wingspan, airframe,", "orbit regime, airlines"]),
    (76.0, "UI components", ["search, detail panel,", "solar system, landing"]),
]
for x, title, lines in front:
    box(ax, x, 5.5, 20.0, 10.0, colour=FRONTEND, title=title, lines=lines,
        title_size=8.4, body_size=6.8)

legend(ax, [
    (AIRCRAFT, "Aircraft"), (SATELLITE, "Satellites"), (SHIP, "Ships"),
    (BACKEND, "Backend"), (FRONTEND, "Frontend"), (STORE, "Persistent / stateful"),
], x=1.5, y=99.6, gap=16.2)

out = pathlib.Path(__file__).parent / "figures" / "5-1-system-architecture.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
