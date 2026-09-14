"""Figure 5.6 - user interface design, annotated on the running system.

**A screenshot rather than a wireframe, deliberately.** A wireframe of a
finished product is a drawing of something that already exists, and it is
drawn by the same people who would be marked on whether the real thing looks
like it. This is `orbital-liveview.vercel.app` captured headlessly at
1600 x 950 while the deployment was live, so the aircraft count, the data age
and the feed name in the status bar are the real ones at the moment of capture.

The numbers are placed by hand against that capture. **If the screenshot is
retaken at a different size the callouts must be re-checked**, which is why the
capture size is pinned here rather than left to whatever window was open.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyBboxPatch, Rectangle
from figures_style import (
    ACCENT, AIRCRAFT, BACKEND, DPI, FRONTEND, INK, MUTED, OK, SATELLITE, SHIP,
    STORE, apply_base_style, _tint,
)

HERE = pathlib.Path(__file__).parent
SHOT = HERE / "figures" / "_app.png"
if not SHOT.exists():
    raise SystemExit(f"capture missing: {SHOT}\nRun the headless capture first.")

apply_base_style()
image = plt.imread(SHOT)
IH, IW = image.shape[0], image.shape[1]

fig = plt.figure(figsize=(10.8, 8.5))
ax = fig.add_axes([0.02, 0.305, 0.96, 0.675])
ax.imshow(image)
ax.set_xlim(0, IW)
ax.set_ylim(IH, 0)
ax.axis("off")
ax.add_patch(Rectangle((0, 0), IW - 1, IH - 1, fill=False, edgecolor="#94A3B8",
                       linewidth=1.2))

# (number, x, y, w, h, colour) in the capture's own pixels.
REGIONS = [
    (1, 30, 12, 150, 60, FRONTEND),
    # These two sit directly under the brand, so their badges go below the
    # box: on the corner they covered the very label they point at.
    (2, 14, 78, 68, 22, SATELLITE, "below"),
    (3, 112, 78, 118, 22, STORE, "below"),
    (4, 238, 12, 352, 44, FRONTEND),
    (5, 600, 14, 246, 42, AIRCRAFT),
    (6, 852, 6, 736, 96, ACCENT),
    (7, 14, 704, 240, 198, OK),
    (8, 432, 812, 740, 96, ACCENT),
    (9, 8, 920, 480, 26, BACKEND),
    (10, 1520, 916, 68, 32, MUTED),
]

for region in REGIONS:
    number, x, y, w, h, colour = region[:6]
    where = region[6] if len(region) > 6 else "above"
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0,rounding_size=6",
        linewidth=2.0, edgecolor=colour, facecolor="none", zorder=5))
    # The badge sits just outside the top-left corner, so it never covers the
    # thing it is pointing at.
    bx, by = (x + 6, y + h + 15) if where == "below" else (x + 6, y - 2)
    ax.add_patch(Circle((bx, by), 15, facecolor=colour, edgecolor="#FFFFFF",
                        linewidth=1.6, zorder=6))
    ax.text(bx, by, str(number), ha="center", va="center", fontsize=8.0,
            fontweight="bold", color="#FFFFFF", zorder=7)

# ---- the key ------------------------------------------------------------
key = fig.add_axes([0.02, 0.012, 0.96, 0.275])
key.set_xlim(0, 100)
key.set_ylim(0, 100)
key.axis("off")

ENTRIES = [
    (1, "Brand and current world", "Says which body the map is showing. 'LIVE AIRCRAFT' is the imagery label, derived rather than written.", FRONTEND),
    (2, "World chooser", "Opens to the right. Earth, the Moon and the eight planets, each with its own imagery and zoom ceiling.", SATELLITE),
    (3, "Account and about", "Sign-in and the project page. Placed under the brand so the corner is one column, not four floating controls.", STORE),
    (4, "Search", "Callsign, registration or airport code. Answers from the store, so it finds only what is currently tracked.", FRONTEND),
    (5, "Layer switch", "Aircraft, satellites or ships. One layer at a time: three at once is 40,000 markers and no legible map.", AIRCRAFT),
    (6, "Advertisement slot", "Shown to anonymous and free accounts; removed by the premium tier. The revenue model, visible in the product.", ACCENT),
    (7, "Altitude key", "The colour ramp and what the marker shapes mean. Collapsible, because it is reference rather than control.", OK),
    (8, "Upgrade prompt", "States what premium changes in concrete terms — a full week of history instead of twenty-four hours.", ACCENT),
    (9, "Status bar", "Objects drawn, objects in view, data age and which feed answered. The honesty line: it reports sampling and staleness.", BACKEND),
    (10, "Attribution", "Imagery and data credits. Required by the licences, and it changes with the world on screen.", MUTED),
]

COL_X = [1.0, 51.0]
for index, (number, title, body, colour) in enumerate(ENTRIES):
    col, row = index % 2, index // 2
    x = COL_X[col]
    y = 92.0 - row * 18.5
    key.plot([x + 1.6], [y - 1.9], marker="o", markersize=13,
             markerfacecolor=colour, markeredgecolor="none", zorder=3)
    key.text(x + 1.6, y - 1.9, str(number), ha="center", va="center",
             fontsize=6.4, fontweight="bold", color="#FFFFFF", zorder=4)
    key.text(x + 4.6, y - 0.4, title, ha="left", va="top", fontsize=7.8,
             fontweight="bold", color=INK)
    key.text(x + 4.6, y - 5.0, body, ha="left", va="top", fontsize=6.9,
             color=MUTED, linespacing=1.55, wrap=False)

out = HERE / "figures" / "5-6-ui-design.png"
fig.savefig(out, dpi=DPI)
print("wrote", out, out.stat().st_size, "bytes")
