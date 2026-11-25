"""Chapter 6 screenshots, captured from the live deployment.

Drives the real site with Playwright in a visible Chrome window (GPU on, so the
map draws as it does for a visitor) and writes figures/6-*.png. The objects
searched for are live, so pass fresh ones when these have landed or sailed:

    python docs/report/capture_screens.py --aircraft THA923 --ship "TORM HERDIS"

Run one step with --only <name>. Needs `pip install playwright` and Chrome.
"""

import argparse
import pathlib

from playwright.sync_api import Page, sync_playwright

SITE = "https://orbital-liveview.vercel.app/"
FIGURES = pathlib.Path(__file__).parent / "figures"


def settle(pg: Page, ms: int = 5000) -> None:
    pg.wait_for_timeout(ms)


def zoom(pg: Page, ticks: int, x: int = 800, y: int = 470) -> None:
    """Negative ticks zoom in, positive zoom out."""
    pg.mouse.move(x, y)
    for _ in range(abs(ticks)):
        pg.mouse.wheel(0, 400 if ticks > 0 else -400)
        pg.wait_for_timeout(350)


def search(pg: Page, text: str) -> None:
    box = pg.locator("input").first
    box.click()
    box.fill("")
    box.type(text, delay=60)
    settle(pg, 2500)
    pg.keyboard.press("Enter")
    settle(pg, 2000)
    box.blur()


def layer(pg: Page, name: str) -> None:
    pg.get_by_role("button", name=name, exact=True).click()
    settle(pg, 6000)


def shot(pg: Page, name: str) -> None:
    out = FIGURES / f"{name}.png"
    pg.screenshot(path=out)
    print("wrote", out.name)


def world(pg, a):
    settle(pg, 8000)
    shot(pg, "6-01-world-aircraft")


def region(pg, a):
    zoom(pg, -6)
    settle(pg, 6000)
    shot(pg, "6-02-regional-aircraft")


def aircraft_search(pg, a):
    box = pg.locator("input").first
    box.click()
    box.type(a.aircraft[:3], delay=80)
    settle(pg, 2500)
    shot(pg, "6-03-search")


def aircraft_detail(pg, a):
    search(pg, a.aircraft)
    zoom(pg, 3, 600, 470)
    settle(pg, 7000)
    shot(pg, "6-04-aircraft-detail")


def satellites(pg, a):
    layer(pg, "Satellites")
    settle(pg, 4000)
    shot(pg, "6-05-satellites")


def satellite_detail(pg, a):
    layer(pg, "Satellites")
    search(pg, "ISS")
    zoom(pg, 3, 600, 470)
    settle(pg, 6000)
    shot(pg, "6-06-satellite-detail")


def time_travel(pg, a):
    layer(pg, "Satellites")
    slider = pg.get_by_label("Time to show the sky at")
    slider.focus()
    for _ in range(12):
        pg.keyboard.press("ArrowLeft")
        pg.wait_for_timeout(120)
    settle(pg, 5000)
    shot(pg, "6-07-time-control")


def ships(pg, a):
    # Coverage is coastal and densest around Finland, so go there via the
    # searched ship, then step back from it.
    layer(pg, "Ships")
    search(pg, a.ship)
    settle(pg, 4000)
    pg.get_by_role("button", name="Close").first.click()
    zoom(pg, 3)
    settle(pg, 5000)
    shot(pg, "6-08-ships")


def ship_detail(pg, a):
    layer(pg, "Ships")
    search(pg, a.ship)
    settle(pg, 6000)
    shot(pg, "6-09-ship-detail")


def moon(pg, a):
    pg.locator("button[aria-haspopup=listbox]").first.click()
    settle(pg, 1000)
    # The option, not the text: a sponsored card also mentions the Moon.
    pg.get_by_role("option", name="Moon").first.click()
    settle(pg, 9000)
    shot(pg, "6-10-moon")


def solar(pg, a):
    pg.goto(SITE + "#system", wait_until="networkidle")
    settle(pg, 8000)
    shot(pg, "6-11-solar-system")


def sign_in(pg, a):
    pg.get_by_role("button", name="SIGN IN").click()
    settle(pg, 3000)
    shot(pg, "6-12-sign-in")


def premium(pg, a):
    pg.get_by_role("button", name="See what premium does →").first.click()
    settle(pg, 3000)
    shot(pg, "6-13-premium")


STEPS = {f.__name__: f for f in (
    world, region, aircraft_search, aircraft_detail, satellites, satellite_detail,
    time_travel, ships, ship_detail, moon, solar, sign_in, premium,
)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aircraft", default="THA923")
    ap.add_argument("--ship", default="SILJA SERENADE")
    ap.add_argument("--only", nargs="*", choices=list(STEPS))
    ap.add_argument("--site", default=SITE, help="e.g. a local dev server")
    a = ap.parse_args()
    globals()["SITE"] = a.site
    with sync_playwright() as p:
        # A visible window: the aircraft photo archive refuses headless browsers,
        # and an honest browser is better than one that pretends not to be headless.
        browser = p.chromium.launch(channel="chrome", headless=False,
                                    args=["--ignore-gpu-blocklist"])
        for name in a.only or STEPS:
            # A fresh page per screen, so one step's state never leaks into the next.
            pg = browser.new_page(viewport={"width": 1600, "height": 950})
            pg.goto(SITE, wait_until="networkidle")
            settle(pg, 3000)
            try:
                STEPS[name](pg, a)
            except Exception as exc:  # noqa: BLE001 - report and carry on to the next screen
                print("FAILED", name, type(exc).__name__, str(exc)[:200])
            pg.close()
        browser.close()


if __name__ == "__main__":
    main()
