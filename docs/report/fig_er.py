"""Figure 5.2 - entity relationship diagram.

Read out of the schema rather than designed on paper: `accounts` is in
`backend/app/accounts/store.py` and `sessions` in `.../sessions.py`, both as
literal `CREATE TABLE` text, and the field lists here are those statements.

**Two zones, because Orbital persists almost nothing.** A conventional ER
diagram of this system would be two boxes, which would be true and would also
hide the entire data model: everything the application actually shows - the
aircraft, the ships, the satellites, their tracks and their routes - lives in
memory for as long as a poll cycle and is then replaced. Those entities have
real structure, real relationships and real cardinality; they simply have no
table. Drawing them dashed says both things at once, and hiding them to make
the diagram look more conventional would be the dishonest choice.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from figures_style import (
    AIRCRAFT, DPI, EXTERNAL, INK, MUTED, SATELLITE, SHIP, STORE,
    apply_base_style, arrow, blank_axes, _tint,
)

apply_base_style()
fig = plt.figure(figsize=(10.4, 7.6))
ax = blank_axes(fig, ylim=(0, 100))

ROW = 3.0      # vertical pitch of one column line
HEAD = 5.4     # the title bar


def height_of(fields) -> float:
    return HEAD + ROW * len(fields)


def entity(x, top, w, title, fields, *, colour, dashed=False, note=None):
    """A table box drawn downward from `top`; returns its bottom edge."""
    h = height_of(fields)
    ax.add_patch(FancyBboxPatch(
        (x, top - h), w, h, boxstyle="round,pad=0,rounding_size=0.9",
        linewidth=1.7, edgecolor=colour, facecolor="#FFFFFF", zorder=2,
        linestyle=(0, (4, 2.5)) if dashed else "solid"))
    ax.add_patch(FancyBboxPatch(
        (x + 0.35, top - HEAD), w - 0.7, HEAD - 0.35,
        boxstyle="round,pad=0,rounding_size=0.7",
        linewidth=0, facecolor=_tint(colour, 0.68), zorder=3))
    ax.text(x + w / 2, top - HEAD / 2 - 0.2, title, ha="center", va="center",
            fontsize=8.8, fontweight="bold", color=INK, zorder=4)

    for index, (name, kind, key) in enumerate(fields):
        fy = top - HEAD - ROW * (index + 0.55)
        if key:
            ax.text(x + 1.3, fy, key, ha="left", va="center", fontsize=5.9,
                    fontweight="bold", color=colour, zorder=4)
        ax.text(x + 5.0, fy, name, ha="left", va="center", fontsize=7.0,
                color=INK, zorder=4,
                fontweight="bold" if key == "PK" else "normal")
        ax.text(x + w - 1.3, fy, kind, ha="right", va="center", fontsize=6.3,
                color=MUTED, style="italic", zorder=4)
    if note:
        ax.text(x + w / 2, top - h - 1.3, note, ha="center", va="top",
                fontsize=6.4, color=MUTED, style="italic", zorder=4)
    return top - h


def relate(x, upper_bottom, lower_top, colour, label, *, left=False,
           one="1", many="N"):
    """A vertical connector between two stacked entities, labelled at each end."""
    arrow(ax, (x, upper_bottom), (x, lower_top), colour=colour, style="-",
          width=1.5)
    mid = (upper_bottom + lower_top) / 2
    ax.text(x + 1.3, upper_bottom - 0.9, one, fontsize=7.0, fontweight="bold",
            color=colour, va="center")
    ax.text(x + 1.3, lower_top + 0.9, many, fontsize=7.0, fontweight="bold",
            color=colour, va="center")
    ax.text(x + (-1.6 if left else 4.6), mid, label,
            fontsize=6.8, color=MUTED, style="italic", va="center",
            ha="right" if left else "left")


# ---- zone 1: what is actually in the database ----------------------------
ax.add_patch(FancyBboxPatch(
    (1.0, 39.0), 45.0, 58.0, boxstyle="round,pad=0,rounding_size=1.4",
    linewidth=1.4, edgecolor=STORE, facecolor=_tint(STORE, 0.965), zorder=1))
ax.text(3.2, 94.3, "PERSISTED  ·  SQLite", fontsize=8.6, fontweight="bold",
        color=STORE, zorder=5)
ax.text(3.2, 91.6, "survives a restart; the only state that does",
        fontsize=6.8, color=MUTED, style="italic", zorder=5)

acc_bottom = entity(4.0, 88.0, 39.0, "accounts", [
    ("id", "INTEGER", "PK"),
    ("email", "TEXT NOT NULL", "U"),
    ("password_hash", "TEXT NOT NULL", ""),
    ("tier", "TEXT DEFAULT 'free'", ""),
    ("created_at", "TEXT NOT NULL", ""),
], colour=STORE)

ses_top = 60.0
entity(4.0, ses_top, 39.0, "sessions", [
    ("token_hash", "TEXT", "PK"),
    ("account_id", "INTEGER NOT NULL", "FK"),
    ("created_at", "TEXT NOT NULL", ""),
    ("expires_at", "TEXT NOT NULL", ""),
], colour=STORE, note="the raw token is returned once and never stored")

relate(23.5, acc_bottom, ses_top, STORE, "holds")

ax.text(1.0, 34.0,
        "Two tables is the whole of the database, and that is the design rather\n"
        "than an omission. Orbital answers from memory: a poll replaces the\n"
        "previous snapshot, and nothing about an aircraft is written down.\n"
        "Only an account is worth surviving a restart, so only an account does.",
        fontsize=7.2, color=MUTED, va="top", ha="left", linespacing=1.6)

# ---- zone 2: the entities with no table ----------------------------------
ax.add_patch(FancyBboxPatch(
    (48.0, 1.0), 51.0, 96.0, boxstyle="round,pad=0,rounding_size=1.4",
    linewidth=1.4, edgecolor=EXTERNAL, facecolor="#F8FAFC", zorder=1,
    linestyle=(0, (5, 3))))
ax.text(50.2, 94.3, "IN MEMORY  ·  no table, replaced every poll",
        fontsize=8.6, fontweight="bold", color=EXTERNAL, zorder=5)
ax.text(50.2, 91.6, "backend/app/models.py — the normalised shape",
        fontsize=6.8, color=MUTED, style="italic", zorder=5)

snap_bottom = entity(51.0, 88.0, 45.0, "Snapshot", [
    ("fetched_at", "datetime", ""),
    ("source", "str  (provider name)", ""),
    ("type", "ObjectType", ""),
], colour=AIRCRAFT, dashed=True)

obj_top = 70.0
obj_bottom = entity(51.0, obj_top, 45.0, "TrackedObject", [
    ("id", "str  (unique per provider)", "PK"),
    ("lat / lon", "Latitude / Longitude", ""),
    ("altitude / velocity", "float | None", ""),
    ("heading", "float | None", ""),
    ("label", "str  (callsign or name)", ""),
    ("type", "aircraft | satellite | ship", ""),
    ("last_seen", "datetime", ""),
], colour=AIRCRAFT, dashed=True)

relate(74.0, snap_bottom, obj_top, AIRCRAFT, "contains")

child_top = 38.0
entity(51.0, child_top, 21.0, "TrackPoint", [
    ("lat / lon", "deg", ""),
    ("altitude", "float?", ""),
    ("timestamp", "datetime", ""),
], colour=SATELLITE, dashed=True)

air_bottom = entity(75.0, child_top, 21.0, "Airport", [
    ("icao", "str", "PK"),
    ("iata / name", "str?", ""),
    ("lat / lon", "deg", ""),
    ("country", "str?", ""),
], colour=SHIP, dashed=True)

relate(61.5, obj_bottom, child_top, SATELLITE, "track", left=True)
relate(85.5, obj_bottom, child_top, SHIP, "origin", many="0..1")

route_top = 16.8
entity(75.0, route_top, 21.0, "FlightRoute", [
    ("airline", "str | None", ""),
    ("origin", "Airport | None", "FK"),
    ("destination", "Airport | None", "FK"),
], colour=SHIP, dashed=True)

arrow(ax, (85.5, air_bottom), (85.5, route_top), colour=SHIP, style="-", width=1.5)
ax.text(83.9, (air_bottom + route_top) / 2, "names two of", fontsize=6.8,
        color=MUTED, style="italic", va="center", ha="right")

ax.text(50.2, 14.0,
        "An aircraft carries a route\nand a track. A satellite and\na ship carry neither: one\n"
        "shape holds all three, and\nthe absent fields are None.",
        fontsize=7.0, color=MUTED, style="italic", va="top", linespacing=1.6,
        zorder=5)

ax.text(1.0, 1.0,
        "PK primary key   ·   FK foreign key   ·   U unique constraint   ·   "
        "dashed outline = exists only between polls",
        fontsize=7.0, color=MUTED, ha="left", va="bottom")

out = pathlib.Path(__file__).parent / "figures" / "5-2-er-diagram.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
