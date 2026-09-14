"""Figure 4.2 - the planned project schedule.

**This is the plan, not the log.** Phone chose a forward-looking schedule over
one reconstructed from the commit history, and the distinction matters enough
to state on the figure itself: these bars are what the team undertook to do,
in the order the dependencies allow. What actually happened is Chapter 2.4's
phase table, and Chapter 8 is where the two get compared.

The six development phases are the ones already recorded in §2.4, so the plan
and the delivered phases use the same names rather than two vocabularies for
one project.

The window is twelve weeks from Monday 25 August 2026, which is the date of
the first commit in the repository. **If the module's submission date differs,
this is the one number to change** - `START` and `WEEKS` below drive every bar,
the axis and the milestones.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from datetime import date, timedelta

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, EXTERNAL, FRONTEND, INK, MUTED, OK,
    SATELLITE, SHIP, STORE, apply_base_style, blank_axes, _tint,
)

apply_base_style()

START = date(2026, 8, 25)
WEEKS = 12

# (task, work package colour, start week, duration in weeks, owner)
TASKS = [
    ("1  Project management", BACKEND, 0, 12, "PSPK", True),
    ("    Charter and phase boundaries", BACKEND, 0, 1, "PSPK", False),
    ("    Decision record, handover", BACKEND, 0, 12, "PSPK", False),

    ("2  Requirements and analysis", SATELLITE, 0, 3, "HPH · BPH", True),
    ("    Requirements capture", SATELLITE, 0, 2, "HPH", False),
    ("    Data contract, API spec", SATELLITE, 1, 2, "BPH", False),

    ("3  Backend development", AIRCRAFT, 2, 6, "PSPK · BPH", True),
    ("    Phase 1  aircraft, end to end", AIRCRAFT, 2, 2, "PSPK", False),
    ("    Phase 2  satellite layer", AIRCRAFT, 4, 1, "BPH", False),
    ("    Phase 4  accounts and tiers", AIRCRAFT, 5, 2, "PSPK", False),
    ("    Phase 5  ship layer", AIRCRAFT, 6, 2, "BPH", False),

    ("4  Frontend development", FRONTEND, 3, 6, "PSPK", True),
    ("    Renderer, object layers", FRONTEND, 3, 3, "PSPK", False),
    ("    Phase 3  moon, solar system", FRONTEND, 6, 2, "PSPK", False),
    ("    Search, detail, worlds", FRONTEND, 7, 2, "PSPK", False),

    ("5  Quality and testing", OK, 2, 9, "HPH · NLH · PPM", True),
    ("    Test plan, defect log", OK, 2, 9, "HPH · PPM", False),
    ("    Unit and integration suites", OK, 3, 6, "NLH", False),
    ("    Phase 6  system test, UAT", OK, 9, 2, "NLH · PPM", False),

    ("6  Environment and delivery", STORE, 0, 12, "NLH · PSPK", True),
    ("    Build, feeds and keys", STORE, 0, 3, "NLH", False),
    ("    Deployment", STORE, 8, 2, "NLH · PSPK", False),
    ("    Report, demonstration", STORE, 9, 3, "HPH · PPM", False),
]

MILESTONES = [
    (3, "Requirements\nsigned off"),
    (8, "Feature\ncomplete"),
    (11, "Report and\ndemonstration"),
]

ROW = 1.0
fig_height = 1.6 + 0.285 * len(TASKS)
fig = plt.figure(figsize=(7.6, fig_height))
ax = fig.add_axes([0.335, 0.105, 0.655, 0.815])

ax.set_xlim(0, WEEKS)
ax.set_ylim(len(TASKS), -1.4)
ax.set_facecolor("#FFFFFF")
for spine in ax.spines.values():
    spine.set_visible(False)

# Week grid, with the month boundaries picked out.
for week in range(WEEKS + 1):
    day = START + timedelta(weeks=week)
    heavy = day.day <= 7
    ax.plot([week, week], [-1.4, len(TASKS)],
            color="#E2E8F0" if not heavy else "#CBD5E1",
            linewidth=1.4 if heavy else 0.8, zorder=0)

for week in range(WEEKS):
    day = START + timedelta(weeks=week)
    ax.text(week + 0.5, -0.95, f"W{week + 1}", ha="center", va="center",
            fontsize=8.4, fontweight="bold", color=MUTED)
    ax.text(week + 0.5, -0.35, day.strftime("%d %b"), ha="center", va="center",
            fontsize=7.6, color=MUTED)

for index, (name, colour, start, weeks, owner, summary) in enumerate(TASKS):
    y = index + 0.5
    ax.text(-0.18, y, name, ha="right", va="center",
            fontsize=8.8 if summary else 8.2,
            fontweight="bold" if summary else "normal",
            color=INK if summary else MUTED,
            transform=ax.get_yaxis_transform(), clip_on=False)

    height = 0.52 if summary else 0.40
    ax.add_patch(FancyBboxPatch(
        (start + 0.06, y - height / 2), weeks - 0.12, height,
        boxstyle="round,pad=0,rounding_size=0.10",
        linewidth=1.4 if summary else 1.1, edgecolor=colour,
        facecolor=_tint(colour, 0.30 if summary else 0.72), zorder=3))
    ax.text(start + weeks + 0.10, y, owner, ha="left", va="center",
            fontsize=7.4, color=colour, fontweight="bold", zorder=4,
            clip_on=False)

for week, label in MILESTONES:
    ax.plot([week], [-1.4], marker="D", markersize=6, color=ACCENT, zorder=5,
            clip_on=False)
    ax.plot([week, week], [-1.4, len(TASKS)], color=ACCENT, linewidth=1.2,
            linestyle=(0, (4, 3)), zorder=2)
    ax.text(week, -2.5, label, ha="center", va="center", fontsize=7.8,
            color=ACCENT, fontweight="bold", linespacing=1.35, clip_on=False)

ax.set_xticks([])
ax.set_yticks([])
ax.set_title(
    f"Planned schedule — {WEEKS} weeks from {START.strftime('%d %B %Y')}."
    "  Bars are the plan; §2.4 records what was delivered.",
    fontsize=8.6, color=MUTED, pad=44, loc="left")

out = pathlib.Path(__file__).parent / "figures" / "4-2-gantt-chart.png"
fig.savefig(out, dpi=DPI, bbox_inches="tight", pad_inches=0.18)
print("wrote", out, out.stat().st_size, "bytes")
