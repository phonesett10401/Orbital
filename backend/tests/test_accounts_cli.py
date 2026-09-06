"""Making and promoting accounts from a terminal (D152).

Through `main()` with a real SQLite file in a temporary directory, because the
thing worth testing is the whole command: that it writes where the server reads,
that a password typed twice is the password stored, and that nothing here ever
prints a hash.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.accounts import cli
from app.accounts.store import TIER_ADMIN, TIER_FREE, TIER_PREMIUM, AccountStore

GOOD = "a good long password"


@pytest.fixture()
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the command at a database of its own."""
    path = tmp_path / "accounts.sqlite"

    class Fake:
        accounts_db_path = path

    monkeypatch.setattr(cli, "Settings", Fake)
    return path


def typing(*answers: str):
    """A `getpass` that returns each answer in turn."""
    remaining = list(answers)
    return lambda _prompt="": remaining.pop(0)


class TestCreating:
    def test_makes_an_account_at_the_tier_asked_for(self, db, monkeypatch) -> None:
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        assert cli.main(["create", "you@example.com", "--tier", "admin"]) == 0

        made = AccountStore(db).all()
        assert [(a.email, a.tier) for a in made] == [("you@example.com", TIER_ADMIN)]

    def test_the_password_typed_is_the_password_that_works(self, db, monkeypatch) -> None:
        # The whole point of the command. A create that stores something other
        # than what was typed produces an account nobody can ever sign in to,
        # and no error anywhere.
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])

        accounts = AccountStore(db)
        assert accounts.authenticate("you@example.com", GOOD) is not None
        assert accounts.authenticate("you@example.com", "something else") is None

    def test_free_unless_told_otherwise(self, db, monkeypatch) -> None:
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])
        assert AccountStore(db).all()[0].tier == TIER_FREE

    def test_asks_again_when_the_two_do_not_match(self, db, monkeypatch) -> None:
        # This password cannot be reset by anybody, so a typo in the one that
        # makes the administrator locks them out of their own deployment.
        #
        # **The first attempt differs from the final one on purpose.** Written
        # with the same password throughout, this test passes even with the
        # confirmation check deleted - the mismatched second entry is simply
        # discarded and the right password is stored anyway. Verified by
        # deleting the check: only this spelling failed.
        first_try = "the one with the typo"
        monkeypatch.setattr(
            cli, "getpass", typing(first_try, "mistyped one", GOOD, GOOD)
        )
        assert cli.main(["create", "you@example.com"]) == 0

        accounts = AccountStore(db)
        assert accounts.authenticate("you@example.com", GOOD) is not None
        assert accounts.authenticate("you@example.com", first_try) is None

    def test_asks_again_when_it_is_too_short(self, db, monkeypatch, capsys) -> None:
        monkeypatch.setattr(cli, "getpass", typing("short", GOOD, GOOD))
        assert cli.main(["create", "you@example.com"]) == 0
        assert "at least" in capsys.readouterr().out

    def test_refuses_an_address_that_already_has_one(self, db, monkeypatch) -> None:
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        assert cli.main(["create", "you@example.com"]) == 1

    def test_there_is_no_way_to_pass_a_password_as_an_argument(self) -> None:
        # Deliberately absent. An argument is visible in `ps` to everyone on the
        # machine and lands in shell history, where it outlives the memory of
        # having typed it.
        with pytest.raises(SystemExit):
            cli.build_parser().parse_args(["create", "a@b.com", "--password", GOOD])


class TestPromoting:
    def test_changes_the_tier(self, db, monkeypatch) -> None:
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])
        assert cli.main(["set-tier", "you@example.com", "premium"]) == 0
        assert AccountStore(db).all()[0].tier == TIER_PREMIUM

    def test_finds_the_account_however_the_address_was_capitalised(
        self, db, monkeypatch
    ) -> None:
        # Addresses are stored folded, so the command has to fold before it
        # looks or it reports "no account" for an account plainly there (D146).
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])
        assert cli.main(["set-tier", "You@Example.COM", "admin"]) == 0
        assert AccountStore(db).all()[0].tier == TIER_ADMIN

    def test_says_so_when_there_is_no_such_account(self, db) -> None:
        assert cli.main(["set-tier", "nobody@example.com", "admin"]) == 1

    def test_will_not_invent_a_tier(self) -> None:
        # A typo would otherwise write a tier nothing recognises, and an
        # unknown tier is treated as free - so the account would quietly lose
        # everything it was being given.
        with pytest.raises(SystemExit):
            cli.build_parser().parse_args(["set-tier", "a@b.com", "premiun"])


class TestListing:
    def test_shows_the_accounts(self, db, monkeypatch, capsys) -> None:
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com", "--tier", "admin"])
        cli.main(["list"])
        out = capsys.readouterr().out
        assert "you@example.com" in out
        assert "admin" in out

    def test_prints_no_hash_anywhere(self, db, monkeypatch, capsys) -> None:
        # The struct that leaves the store has no hash in it, and this is
        # exactly the sort of place somebody would add one back (D146).
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])
        capsys.readouterr()
        cli.main(["list"])
        out = capsys.readouterr().out
        assert "scrypt" not in out
        assert GOOD not in out

    def test_says_so_when_there_are_none(self, db, capsys) -> None:
        cli.main(["list"])
        assert "no accounts" in capsys.readouterr().out


class TestWhereItWrites:
    def test_db_can_be_named_outright(self, tmp_path, monkeypatch) -> None:
        # The failure that produced this option: the default path is relative
        # to the working directory, so running the command from `backend/` and
        # the server from the repository root reach two different files. That
        # happened on the first real run.
        elsewhere = tmp_path / "somewhere-else.sqlite"
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        assert cli.main(["--db", str(elsewhere), "create", "you@example.com"]) == 0
        assert elsewhere.exists()
        assert AccountStore(elsewhere).all()[0].email == "you@example.com"

    def test_every_command_says_which_database_it_used(
        self, db, monkeypatch, capsys
    ) -> None:
        # The failure this prevents: creating an admin in one file while the
        # server reads another, and then being unable to sign in with
        # credentials that are provably correct.
        monkeypatch.setattr(cli, "getpass", typing(GOOD, GOOD))
        cli.main(["create", "you@example.com"])
        assert str(db.name) in capsys.readouterr().out
