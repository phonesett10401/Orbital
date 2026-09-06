"""The account store (D146).

Against a real SQLite file in a temporary directory rather than a fake: the
uniqueness constraint, the folding and the tier default are all behaviours of
the schema, and a stub would be asserting that the stub works.
"""

from __future__ import annotations

import pytest

from app.accounts.store import (
    TIER_FREE,
    TIER_PREMIUM,
    AccountError,
    AccountStore,
    EmailTaken,
    fold_email,
)


@pytest.fixture()
def store(tmp_path) -> AccountStore:
    return AccountStore(tmp_path / "accounts.sqlite")


class TestRegistering:
    def test_creates_an_account_on_the_free_tier(self, store: AccountStore) -> None:
        account = store.create("phone@example.com", "a good long password")
        assert account.id > 0
        assert account.tier == TIER_FREE
        assert account.is_premium is False

    def test_refuses_a_second_account_on_the_same_address(self, store: AccountStore) -> None:
        store.create("phone@example.com", "a good long password")
        with pytest.raises(EmailTaken):
            store.create("phone@example.com", "another password entirely")
        assert store.count() == 1

    def test_treats_addresses_as_case_insensitive(self, store: AccountStore) -> None:
        # Otherwise Phone@Example.com and phone@example.com are two accounts
        # that look identical to a person, and signing in becomes a guess.
        store.create("Phone@Example.COM", "a good long password")
        with pytest.raises(EmailTaken):
            store.create("phone@example.com", "a good long password")

    def test_folds_surrounding_space(self, store: AccountStore) -> None:
        account = store.create("  phone@example.com  ", "a good long password")
        assert account.email == "phone@example.com"

    def test_refuses_an_empty_address(self, store: AccountStore) -> None:
        with pytest.raises(AccountError):
            store.create("   ", "a good long password")

    def test_does_not_carry_the_password_hash_out_of_the_module(
        self, store: AccountStore
    ) -> None:
        # A struct carrying the hash eventually gets logged or serialised. The
        # way to prevent that is for the field not to exist (D146).
        account = store.create("phone@example.com", "a good long password")
        assert not hasattr(account, "password_hash")
        assert "password" not in repr(account).lower()


class TestSigningIn:
    def test_accepts_the_right_password(self, store: AccountStore) -> None:
        created = store.create("phone@example.com", "a good long password")
        signed_in = store.authenticate("phone@example.com", "a good long password")
        assert signed_in is not None
        assert signed_in.id == created.id

    def test_accepts_a_differently_cased_address(self, store: AccountStore) -> None:
        store.create("phone@example.com", "a good long password")
        assert store.authenticate("PHONE@Example.com", "a good long password") is not None

    def test_rejects_the_wrong_password(self, store: AccountStore) -> None:
        store.create("phone@example.com", "a good long password")
        assert store.authenticate("phone@example.com", "not it") is None

    def test_gives_the_same_answer_for_an_unknown_address(self, store: AccountStore) -> None:
        # **One answer for both failures.** Distinguishing them tells an
        # attacker which addresses are registered, which is a fact about a
        # person rather than about this service.
        store.create("phone@example.com", "a good long password")
        assert store.authenticate("nobody@example.com", "a good long password") is None
        assert store.authenticate("phone@example.com", "wrong") is None


class TestTiers:
    def test_starts_free_and_can_be_promoted(self, store: AccountStore) -> None:
        account = store.create("phone@example.com", "a good long password")
        assert account.is_premium is False
        promoted = store.set_tier(account.id, TIER_PREMIUM)
        assert promoted is not None
        assert promoted.is_premium is True

    def test_a_promotion_survives_a_new_connection(self, tmp_path) -> None:
        # The point of having a database at all: this is the first thing in
        # Orbital that must outlive the process.
        path = tmp_path / "accounts.sqlite"
        first = AccountStore(path)
        account = first.create("phone@example.com", "a good long password")
        first.set_tier(account.id, TIER_PREMIUM)

        reopened = AccountStore(path)
        again = reopened.by_id(account.id)
        assert again is not None
        assert again.is_premium is True

    def test_an_unknown_account_is_none_rather_than_an_error(self, store: AccountStore) -> None:
        assert store.by_id(9999) is None


class TestFolding:
    def test_lowercases_and_strips(self) -> None:
        assert fold_email("  Phone@Example.COM ") == "phone@example.com"
