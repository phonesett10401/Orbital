"""What AIS means, separated from who delivered it.

Two sources now carry the same protocol - Digitraffic over HTTP (D165) and
aisstream.io over a WebSocket (D166) - and the things that are true about *AIS*
belong in one place rather than being written twice and drifting.

## What lives here and what does not

Here: the sentinel values, the plausibility ceiling, the navigational-status
table, the ship-type table. All of them are properties of the **protocol**, and
a second copy of any of them is a second thing to get wrong. The vessel-type
vocabulary in particular is a contract with `frontend/src/shipKind.ts`, which
maps each word to a colour and silently greys out anything it does not
recognise - one table, asserted from both ends.

Not here: **field mapping**. Each source names and scales things its own way,
and two differences would be silent corruption if this module tried to
normalise them:

| | Digitraffic | aisstream |
|---|---|---|
| draught | `draught`, **decimetres** (82) | `MaximumStaticDraught`, **metres** (1.9) |
| ETA | one packed 20-bit integer | a struct of four fields |

A shared "convert the draught" helper would have to know which source it was
talking to, which is the same as not being shared. So each provider does its
own mapping and calls in here for the meaning.
"""

from __future__ import annotations

from typing import Any

KNOTS_TO_MS = 0.514444

#: Drop a vessel not re-observed within this window.
#:
#: Measured against Digitraffic's age distribution, which has a cliff at
#: fifteen minutes - 69% of what it returns is newer than that and 28% is over
#: an hour old (D165). Fifteen minutes sits on the cliff and is still five
#: missed reports for a moored Class A vessel, which transmits every three
#: minutes.
#:
#: Shared with the streaming source because it is the same claim about vessels,
#: not about feeds: a position nobody has heard in a quarter of an hour is a
#: guess wherever it arrived from. It matters more there, if anything - a
#: stream accumulates a world in memory and would otherwise keep every vessel
#: it ever saw, for as long as the process ran.
SHIP_TTL_SECONDS = 900.0

#: AIS "not available" encodings, which arrive as ordinary numbers in range.
COG_UNAVAILABLE = 360.0
HEADING_UNAVAILABLE = 511

#: The fastest a vessel is believed, in knots.
#:
#: **The sentinel is not the whole problem, and checking only for it let a
#: 250-metre tanker sail at 102 knots.** Speed over ground is transmitted in
#: tenths of a knot, where 1023 means "not available" and 1022 means "102.2 or
#: higher" - so the first version of this refused anything at or above 102.3,
#: which is precise, correct, and missed three vessels sending 102.2.
#:
#: Reading further down the sorted feed it was worse than an off-by-one:
#:
#: | knots | what it was |
#: |---|---|
#: | 102.2 | NOUNOU, a 250 m tanker, under way |
#: | 102.2 | RATNIK, a tug, **moored** |
#: | 85.0 | MYRA, a 228 m tanker, **at anchor** |
#: | 81.0 | VYATICH, a tug, **moored** |
#:
#: None of those is a sentinel. They are broken transmitters, and no encoding
#: separates them from real readings - only knowing what a ship can do. The
#: fastest vessel ever in service, the HSC Francisco, does about 58 knots;
#: military hydrofoils reach roughly 60.
#:
#: **What it does not fix, stated rather than left to be discovered.** Under
#: the ceiling the fastest survivors were a tug at 49.5 knots, a tanker at 47.5
#: and a cargo ship at 44.3 - implausible for those hulls by a factor of three.
#: They stay because nothing in the message distinguishes them from a real
#: reading: a 45-knot patrol boat is an ordinary thing and the ship type is
#: missing for 13% of the feed, so a per-type limit would be a table of guesses
#: dressed as a rule. Cross-referencing consecutive positions would settle it
#: properly, and the store already holds the track to do it with; that is a
#: different piece of work from decoding a message.
MAX_PLAUSIBLE_KNOTS = 60.0

#: Navigational status, message 1/2/3 field 2.
#:
#: The field that says what a vessel is *doing*, which matters here more than
#: on any other layer: four fifths of a ship map is stationary, and "moored",
#: "at anchor" and "aground" are three very different reasons to be still.
#:
#: **Set by hand on the bridge**, and therefore the one field here nobody
#: should take as gospel - 473 vessels in one sample reported "under way using
#: engine" while transmitting no movement at all.
NAV_STATUS: dict[int, str] = {
    0: "Under way using engine",
    1: "At anchor",
    2: "Not under command",
    3: "Restricted manoeuvrability",
    4: "Constrained by draught",
    5: "Moored",
    6: "Aground",
    7: "Engaged in fishing",
    8: "Under way sailing",
    9: "Reserved (high speed craft)",
    10: "Reserved (wing in ground)",
    11: "Under tow astern",
    12: "Under tow alongside",
    13: "Reserved",
    14: "AIS-SART, MOB or EPIRB",
    15: "Undefined",
}

#: Ship type, from the tens digit of the AIS type code.
#:
#: The full table is a hundred entries of which most are "reserved"; the tens
#: digit is the part that carries meaning and the part a reader wants. 70-79 is
#: cargo, 80-89 tanker, 60-69 passenger, and so on.
SHIP_TYPE_BY_TENS: dict[int, str] = {
    2: "Wing in ground",
    3: "Special craft",
    4: "High speed craft",
    5: "Special craft",
    6: "Passenger",
    7: "Cargo",
    8: "Tanker",
    9: "Other",
}

#: The 30s and 50s are not one kind of thing, so they are spelled out.
SPECIAL_CRAFT: dict[int, str] = {
    30: "Fishing",
    31: "Towing",
    32: "Towing (long)",
    33: "Dredger",
    34: "Diving support",
    35: "Military",
    36: "Sailing",
    37: "Pleasure craft",
    50: "Pilot vessel",
    51: "Search and rescue",
    52: "Tug",
    53: "Port tender",
    54: "Anti-pollution",
    55: "Law enforcement",
    58: "Medical transport",
}


def speed_ms(knots: Any) -> float | None:
    """Speed over ground in metres per second, or None.

    Refused above ``MAX_PLAUSIBLE_KNOTS`` rather than converted. See that
    constant: the AIS sentinel is only the loudest of the wrong answers here.
    """
    value = number(knots)
    if value is None or value < 0 or value > MAX_PLAUSIBLE_KNOTS:
        return None
    return value * KNOTS_TO_MS


def heading(true_heading: Any, course: Any) -> float | None:
    """Which way the vessel is pointing, or moving, or None.

    **True heading first, course over ground second**, which is the opposite of
    the aircraft layer's preference and right for the same underlying reason:
    the field should describe the picture. A ship at anchor swings on its cable
    and has a heading but no course, and a ferry crossing a current points
    somewhere other than where it is going. An aircraft's *track* is the honest
    answer there because an aeroplane does not hold station.

    Both sentinels are common rather than exceptional. In one aisstream sample
    of 5,308 position reports, **2,154 sent heading 511** and 942 sent course
    360 - so two vessels in five have no true heading at all.
    """
    value = number(true_heading)
    if value is not None and 0 <= value < HEADING_UNAVAILABLE:
        return value % 360.0
    value = number(course)
    if value is not None and 0 <= value < COG_UNAVAILABLE:
        return value
    return None


def ship_type(code: Any) -> str | None:
    """What the source says this vessel is, in words.

    ``model`` promises "a designator the source chose", and the source chose a
    number from a hundred-entry table. The tens digit is the part that carries
    meaning, except in the 30s and 50s where the ones digit distinguishes a tug
    from a dredger from a warship - which nobody would thank us for flattening
    to "special craft".
    """
    if not isinstance(code, int) or isinstance(code, bool) or code <= 0 or code > 99:
        return None
    named = SPECIAL_CRAFT.get(code)
    if named is not None:
        return named
    return SHIP_TYPE_BY_TENS.get(code // 10)


def nav_status(code: Any) -> str | None:
    """The navigational status in words, or None if it is not a known code."""
    if isinstance(code, bool) or not isinstance(code, int):
        return None
    return NAV_STATUS.get(code)


def is_position(lat: Any, lon: Any) -> bool:
    """Whether these are coordinates rather than AIS's "position unavailable".

    91 and 181 are what a transmitter sends when it has no fix. They are also
    outside the contract's validators, which would raise - taking down a whole
    poll, or a whole stream, over one vessel.
    """
    latitude, longitude = number(lat), number(lon)
    if latitude is None or longitude is None:
        return False
    return -90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0


def eta_text(month: Any, day: Any, hour: Any, minute: Any) -> str | None:
    """Estimated arrival, from the four fields AIS carries it in.

    Takes the fields rather than the encoding, because the two sources carry
    them differently - one packs all four into twenty bits, the other sends a
    struct - and the *meaning* is what is shared.

    Zero month or day means not stated, hour 24 and minute 60 likewise, and a
    vessel that has not set an ETA sends all of them: the guards here are the
    common path rather than the edge.

    No year is transmitted, so none is claimed: the string says a day and a
    time and stops there.
    """
    for part in (month, day, hour, minute):
        if isinstance(part, bool) or not isinstance(part, int):
            return None
    if not (1 <= month <= 12) or not (1 <= day <= 31):
        return None
    if hour > 23 or minute > 59:
        return None
    return f"{day:02d}/{month:02d} {hour:02d}:{minute:02d} UTC"


def number(value: Any) -> float | None:
    """A float, or None for anything that is not one."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def text(value: Any) -> str | None:
    """A non-empty trimmed string, or None.

    AIS pads static text to a fixed width with spaces and '@', so a vessel with
    no destination sends a field full of padding rather than an absent one.
    """
    if not isinstance(value, str):
        return None
    trimmed = value.replace("@", " ").strip()
    return trimmed or None
