"""Turning placeholder designators back into satellite names.

Every string below is real, taken from the live catalogue and the live SatNOGS
directory on 2026-09-03.
"""

from __future__ import annotations

import pytest

from app.providers.satellite_names import (
    is_placeholder,
    parse_directory,
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
        assert parse_directory(rows) == {"44885": "FloripaSat-1", "25544": "ISS"}

    def test_drops_placeholders_at_the_door(self):
        # So a caller cannot overwrite one placeholder with another. The live
        # directory really does carry these.
        rows = [
            {"norad_cat_id": 40905, "name": "OBJECT G"},
            {"norad_cat_id": 47937, "name": "Unknown Satellite"},
            {"norad_cat_id": 44885, "name": "FloripaSat-1"},
        ]
        assert parse_directory(rows) == {"44885": "FloripaSat-1"}

    def test_survives_rows_that_are_not_the_shape_we_expect(self):
        rows = [None, 42, {}, {"norad_cat_id": None, "name": "X"},
                {"norad_cat_id": 1, "name": None}, {"name": "no id"},
                {"norad_cat_id": 7, "name": "Real"}]
        assert parse_directory(rows) == {"7": "Real"}

    def test_a_payload_that_is_not_a_list_fails_loudly(self):
        with pytest.raises(ValueError, match="expected a list"):
            parse_directory({"results": []})


class TestResolveNames:
    def test_names_the_objects_the_feed_left_as_letters(self):
        # The measured case: 213 of 266 placeholder-named objects had a real
        # identity in the directory (D117).
        elements = [Element("44885", "OBJECT G"), Element("44881", "OBJECT C")]
        directory = {"44885": "FloripaSat-1", "44881": "CAS-6 (TO-108)"}
        assert resolve_names(elements, directory) == 2
        assert [e.name for e in elements] == ["FloripaSat-1", "CAS-6 (TO-108)"]

    def test_never_overwrites_a_name_the_feed_already_had(self):
        # The element feed is the authority on what an object is called. This
        # only fills a blank - otherwise a stale directory could rename a
        # satellite that was correctly named.
        element = Element("25544", "ISS (ZARYA)")
        resolve_names([element], {"25544": "ISS"})
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
        assert resolve_names([element], {"47937": "Unknown Satellite"}) == 0
        assert element.name == "OBJECT F"

    def test_is_idempotent(self):
        # It runs on every element refresh, so running twice must not differ
        # from running once.
        elements = [Element("44885", "OBJECT G")]
        directory = {"44885": "FloripaSat-1"}
        assert resolve_names(elements, directory) == 1
        assert resolve_names(elements, directory) == 0
        assert elements[0].name == "FloripaSat-1"
