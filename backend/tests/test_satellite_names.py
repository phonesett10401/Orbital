"""Turning placeholder designators back into satellite names.

Every string below is real, taken from the live catalogue and the live SatNOGS
directory on 2026-09-03.
"""

from __future__ import annotations

import pytest

from app.providers.satellite_names import (
    DirectoryEntry,
    image_index,
    is_placeholder,
    merge_directories,
    parse_satcat,
    parse_satnogs_directory,
    resolve_names,
)


class Element:
    """The two fields `resolve_names` touches, and nothing else."""

    def __init__(self, catalog_id: str, name: str) -> None:
        self.catalog_id = catalog_id
        self.name = name


class TestIsPlaceholder:
    @pytest.mark.parametrize(
        "name",
        [
            "OBJECT C",           # the catalogue's own placeholder
            "OBJECT BS",          # past Z it doubles up
            "object c",           # case is not meaningful
            "Unknown Satellite",  # SatNOGS's version
            "Unknown Satellite - 19093L",  # ...with the launch appended
            "2019-032G - Unknown Satellite",
            "2019-093C",          # the bare international designator
            "TBA - TO BE ASSIGNED",
            "43790",              # a catalogue number identifies but does not name
            "",
            "   ",
            None,
        ],
    )
    def test_names_that_identify_nothing(self, name):
        assert is_placeholder(name) is True

    @pytest.mark.parametrize(
        "name",
        [
            "FloripaSat-1",
            "CAS-6 (TO-108)",
            "NanoDragon",
            "CBERS-4A",
            "SNIPE A",
            "ISS (ZARYA)",
            "STARLINK-1234",
            "COSMOS 2582",
            "ES'HAIL 2",
        ],
    )
    def test_real_names(self, name):
        assert is_placeholder(name) is False

    @pytest.mark.parametrize("name", ["SATBAND", "OUTBACK-1", "SATBA 2"])
    def test_tba_is_a_word_not_a_substring(self, name):
        # "SATBAND" contains the letters T-B-A. A substring check would refuse
        # a real name and hand it to the directory to be overwritten, which is
        # the opposite of the fault this module exists to fix.
        assert is_placeholder(name) is False

    def test_object_is_a_prefix_not_a_substring(self):
        # A real satellite may legitimately contain the word: refusing every
        # name containing "OBJECT" would un-name it. The placeholder is a
        # prefix, and that is the property being relied on.
        assert is_placeholder("NEAR EARTH OBJECT SURVEYOR") is False


class TestParseDirectory:
    def test_maps_catalogue_number_to_name(self):
        rows = [
            {"norad_cat_id": 44885, "name": "FloripaSat-1"},
            {"norad_cat_id": 25544, "name": "ISS"},
        ]
        assert parse_satnogs_directory(rows) == {
            "44885": DirectoryEntry(name="FloripaSat-1"),
            "25544": DirectoryEntry(name="ISS"),
        }

    def test_drops_placeholders_at_the_door(self):
        # So a caller cannot overwrite one placeholder with another. The live
        # directory really does carry these.
        rows = [
            {"norad_cat_id": 40905, "name": "OBJECT G"},
            {"norad_cat_id": 47937, "name": "Unknown Satellite"},
            {"norad_cat_id": 44885, "name": "FloripaSat-1"},
        ]
        assert parse_satnogs_directory(rows) == {"44885": DirectoryEntry(name="FloripaSat-1")}

    def test_survives_rows_that_are_not_the_shape_we_expect(self):
        rows = [None, 42, {}, {"norad_cat_id": None, "name": "X"},
                {"norad_cat_id": 1, "name": None}, {"name": "no id"},
                {"norad_cat_id": 7, "name": "Real"}]
        assert parse_satnogs_directory(rows) == {"7": DirectoryEntry(name="Real")}

    def test_a_payload_that_is_not_a_list_fails_loudly(self):
        with pytest.raises(ValueError, match="expected a list"):
            parse_satnogs_directory({"results": []})


class TestResolveNames:
    def test_names_the_objects_the_feed_left_as_letters(self):
        # The measured case: 213 of 266 placeholder-named objects had a real
        # identity in the directory (D117).
        elements = [Element("44885", "OBJECT G"), Element("44881", "OBJECT C")]
        directory = {
            "44885": DirectoryEntry(name="FloripaSat-1"),
            "44881": DirectoryEntry(name="CAS-6 (TO-108)"),
        }
        assert resolve_names(elements, directory) == 2
        assert [e.name for e in elements] == ["FloripaSat-1", "CAS-6 (TO-108)"]

    def test_never_overwrites_a_name_the_feed_already_had(self):
        # The element feed is the authority on what an object is called. This
        # only fills a blank - otherwise a stale directory could rename a
        # satellite that was correctly named.
        element = Element("25544", "ISS (ZARYA)")
        resolve_names([element], {"25544": DirectoryEntry(name="ISS")})
        assert element.name == "ISS (ZARYA)"

    def test_leaves_an_object_the_directory_cannot_name(self):
        # 53 of 1,429 really are unidentified, and they must stay that way
        # rather than acquire a confident wrong name.
        element = Element("40905", "OBJECT G")
        assert resolve_names([element], {}) == 0
        assert element.name == "OBJECT G"

    def test_refuses_to_swap_one_placeholder_for_another(self):
        # Belt and braces: `parse_directory` already drops these, so this
        # asserts the property rather than the implementation that provides it.
        element = Element("47937", "OBJECT F")
        assert resolve_names([element], {"47937": DirectoryEntry(name=None)}) == 0
        assert element.name == "OBJECT F"

    def test_is_idempotent(self):
        # It runs on every element refresh, so running twice must not differ
        # from running once.
        elements = [Element("44885", "OBJECT G")]
        directory = {"44885": DirectoryEntry(name="FloripaSat-1")}
        assert resolve_names(elements, directory) == 1
        assert resolve_names(elements, directory) == 0
        assert elements[0].name == "FloripaSat-1"


class TestTwoDirectories:
    """Two sources that know different things, merged field by field."""

    def test_satcat_names_what_satnogs_never_curated(self):
        # Real: SATCAT named 21 of the 53 SatNOGS could not, including
        # SHUNTIAN, ETRSS-1 and five DONGPO satellites (D118).
        rows = [
            {"NORAD_CAT_ID": 44880, "OBJECT_NAME": "ETRSS-1", "OBJECT_TYPE": "PAY"},
            {"NORAD_CAT_ID": 44886, "OBJECT_NAME": "SHUNTIAN", "OBJECT_TYPE": "PAY"},
        ]
        assert parse_satcat(rows) == {
            "44880": DirectoryEntry(name="ETRSS-1"),
            "44886": DirectoryEntry(name="SHUNTIAN"),
        }

    def test_satcat_placeholders_are_dropped_like_any_other(self):
        # SATCAT carries plenty of bare designators for uncorrelated objects.
        rows = [{"NORAD_CAT_ID": 51951, "OBJECT_NAME": "2022-023F"}]
        assert parse_satcat(rows) == {}

    def test_a_name_from_one_source_and_a_picture_from_the_other(self):
        # The reason the merge is field by field rather than row by row: only
        # SatNOGS has pictures, only SATCAT has some names, and taking whole
        # rows would mean choosing between two things we can have at once.
        satnogs = {"44880": DirectoryEntry(name=None, image_url="https://x/img.jpg")}
        satcat = {"44880": DirectoryEntry(name="ETRSS-1")}
        merged = merge_directories(satnogs, satcat)
        assert merged["44880"] == DirectoryEntry(
            name="ETRSS-1", image_url="https://x/img.jpg"
        )

    def test_the_earlier_source_wins_a_field_both_fill(self):
        first = {"1": DirectoryEntry(name="Preferred")}
        second = {"1": DirectoryEntry(name="Fallback")}
        assert merge_directories(first, second)["1"].name == "Preferred"

    def test_merging_nothing_is_not_an_error(self):
        assert merge_directories() == {}
        assert merge_directories({}, {}) == {}


class TestPictures:
    def test_the_relative_path_becomes_a_url(self):
        rows = [{"norad_cat_id": 25544, "name": "ISS", "image": "satellites/ISS.jpg"}]
        entry = parse_satnogs_directory(rows)["25544"]
        assert entry.image_url == "https://db.satnogs.org/media/satellites/ISS.jpg"

    def test_a_row_with_only_a_picture_is_still_worth_keeping(self):
        # Name and picture are independent facts. Dropping a placeholder-named
        # row would lose the image to save nothing.
        rows = [{"norad_cat_id": 40905, "name": "OBJECT G", "image": "satellites/x.jpg"}]
        entry = parse_satnogs_directory(rows)["40905"]
        assert entry.name is None
        assert entry.image_url.endswith("satellites/x.jpg")

    def test_a_row_with_neither_is_dropped(self):
        rows = [{"norad_cat_id": 40905, "name": "OBJECT G", "image": ""}]
        assert parse_satnogs_directory(rows) == {}

    def test_the_index_holds_only_entries_that_have_one(self):
        directory = {
            "1": DirectoryEntry(name="A", image_url="https://x/a.jpg"),
            "2": DirectoryEntry(name="B"),
        }
        assert image_index(directory) == {"1": "https://x/a.jpg"}
