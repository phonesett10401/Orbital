"""Figure 4.1 - work breakdown structure.

Six work packages, decomposed to the level where one person owns one
deliverable. Deeper than that and a WBS becomes a task list that goes stale
weekly; shallower and it does not say who is accountable for anything.

The owner tags are the roles recorded in `Orbital_Team_Roles.pdf`, not an
invention of this diagram. Where a package needs two people it says so, because
the role document assigns primary and support separately and that distinction
is the whole reason the table exists.

**Three columns rather than six.** Pandoc clamps an image in a .docx to 5.83
inches regardless of the width asked for, so a six-column diagram prints each
column under an inch wide and nobody reads it. Laid out three across and two
down, a package card prints at about 1.8 inches and the task text is legible at
the size it will actually be read. The hierarchy is carried by the numbering -
1, then 1.1 to 1.4 - which is how a WBS is numbered anyway.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, EXTERNAL, FRONTEND, INK, MUTED, OK,
    SATELLITE, STORE, apply_base_style, blank_axes, _tint,
)

apply_base_style()
fig = plt.figure(figsize=(7.8, 7.4))
ax = blank_axes(fig, ylim=(0, 100))

PACKAGES = [
    ("1", "Project Management", BACKEND, [
        ("1.1  Scope and phase boundaries", "PSPK"),
        ("1.2  Decision record", "PSPK"),
        ("1.3  Milestone tracking", "PSPK"),
        ("1.4  Session handover", "PSPK"),
    ]),
    ("2", "Requirements and Analysis", SATELLITE, [
        ("2.1  Stakeholder analysis", "HPH"),
        ("2.2  Functional requirements", "HPH"),
        ("2.3  Data contract", "BPH"),
        ("2.4  API specification", "BPH"),
    ]),
    ("3", "Backend Development", AIRCRAFT, [
        ("3.1  Provider per upstream", "BPH · PSPK"),
        ("3.2  Poller and store", "PSPK"),
        ("3.3  REST API and thinning", "PSPK"),
        ("3.4  Accounts and sessions", "PSPK"),
    ]),
    ("4", "Frontend Development", FRONTEND, [
        ("4.1  Map renderer", "PSPK"),
        ("4.2  Object layers", "PSPK"),
        ("4.3  Search and detail panel", "PSPK"),
        ("4.4  Solar system and worlds", "PSPK"),
    ]),
    ("5", "Quality and Testing", OK, [
        ("5.1  Test plan", "HPH"),
        ("5.2  Unit and integration tests", "NLH · PPM"),
        ("5.3  System test and UAT", "NLH · PPM"),
        ("5.4  Defect log", "HPH · PPM"),
    ]),
    ("6", "Environment and Delivery", STORE, [
        ("6.1  Build and dependencies", "NLH"),
        ("6.2  Feeds, keys and budgets", "NLH"),
        ("6.3  Deployment", "NLH · PSPK"),
        ("6.4  Report and demonstration", "HPH · PPM"),
    ]),
]

# ---- root ----------------------------------------------------------------
ax.add_patch(FancyBboxPatch(
    (1.0, 91.0), 98.0, 8.0, boxstyle="round,pad=0,rounding_size=1.0",
    linewidth=2.0, edgecolor=ACCENT, facecolor=_tint(ACCENT, 0.86), zorder=3))
ax.text(50.0, 95.0, "ORBITAL  ·  CSC480  —  WORK BREAKDOWN", ha="center",
        va="center", fontsize=11.0, fontweight="bold", color=INK, zorder=4)

# ---- six package cards, three across -------------------------------------
CARD_W, CARD_H = 31.0, 36.6
X0, GAP_X = 1.0, 2.5
ROW_TOPS = (88.0, 49.5)
TASK_H = 6.3

for index, (number, name, colour, tasks) in enumerate(PACKAGES):
    col, row = index % 3, index // 3
    x = X0 + col * (CARD_W + GAP_X)
    top = ROW_TOPS[row]

    ax.add_patch(FancyBboxPatch(
        (x, top - CARD_H), CARD_W, CARD_H,
        boxstyle="round,pad=0,rounding_size=1.0",
        linewidth=1.8, edgecolor=colour, facecolor="#FFFFFF", zorder=2))
    ax.add_patch(FancyBboxPatch(
        (x + 0.4, top - 7.2), CARD_W - 0.8, 6.8,
        boxstyle="round,pad=0,rounding_size=0.8",
        linewidth=0, facecolor=_tint(colour, 0.80), zorder=3))
    ax.text(x + 2.4, top - 3.8, number, ha="left", va="center", fontsize=10.5,
            fontweight="bold", color=colour, zorder=4)
    ax.text(x + CARD_W / 2 + 1.6, top - 3.8, name, ha="center", va="center",
            fontsize=8.8, fontweight="bold", color=INK, zorder=4)

    task_top = top - 8.8
    for label, owner in tasks:
        ax.add_patch(FancyBboxPatch(
            (x + 1.4, task_top - TASK_H), CARD_W - 2.8, TASK_H,
            boxstyle="round,pad=0,rounding_size=0.6",
            linewidth=1.1, edgecolor=_tint(colour, 0.40),
            facecolor=_tint(colour, 0.975), zorder=3))
        ax.text(x + 2.8, task_top - 2.4, label, ha="left", va="center",
                fontsize=7.6, color=INK, zorder=4)
        ax.text(x + CARD_W - 2.8, task_top - 4.7, owner, ha="right",
                va="center", fontsize=7.0, fontweight="bold", color=colour,
                zorder=4)
        task_top -= TASK_H + 0.5

# ---- who the initials are ------------------------------------------------
ax.add_patch(FancyBboxPatch(
    (1.0, 0.8), 98.0, 10.6, boxstyle="round,pad=0,rounding_size=1.0",
    linewidth=1.3, edgecolor=EXTERNAL, facecolor="#F8FAFC", zorder=1))

people = [
    ("PSPK", "Phone Sett Paing Kyaw", "Project Manager\nDeveloper"),
    ("BPH", "Bhone Pyae Hein", "System Analysis\nCo-Developer"),
    ("HPH", "Han Phyo Htet", "Quality Assurance\nBusiness Analysis"),
    ("NLH", "Nyan Lin Htet", "Tester\nTechnical Engineer"),
    ("PPM", "Pyae Phyo Maung", "Co-Tester\nCo-QA and Analysis"),
]
for index, (initials, name, role) in enumerate(people):
    x = 3.0 + index * 19.4
    ax.text(x, 9.0, initials, fontsize=8.0, fontweight="bold", color=ACCENT)
    ax.text(x, 6.4, name, fontsize=7.4, color=INK)
    ax.text(x, 3.6, role, fontsize=6.6, color=MUTED, style="italic",
            linespacing=1.5, va="center")

out = pathlib.Path(__file__).parent / "figures" / "4-1-work-breakdown.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
