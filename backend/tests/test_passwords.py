"""The password rules, checked one at a time (D146).

Every test here is a property that has to hold for the storage to be safe, and
each one fails loudly if the corresponding line is removed. There is no test
that a correct password verifies *and nothing else* - that one passes for a
function that returns True unconditionally.
"""

from __future__ import annotations

import pytest

from app.accounts.passwords import (
    SCRYPT_N,
    SCRYPT_P,
    SCRYPT_R,
    PasswordError,
    hash_password,
    needs_rehash,
    parameters_of,
    verify_password,
)

PASSWORD = "correct horse battery staple"


class TestHashing:
    def test_the_password_does_not_survive_in_the_hash(self) -> None:
        # The whole point. A stolen database must not be a list of passwords.
        stored = hash_password(PASSWORD)
        assert PASSWORD not in stored
        for word in PASSWORD.split():
            assert word not in stored

    def test_the_same_password_hashes_differently_every_time(self) -> None:
        # Per-password salt. Without it, identical passwords share a hash, and
        # one cracked entry unlocks everybody who chose the same thing.
        assert hash_password(PASSWORD) != hash_password(PASSWORD)

    def test_the_hash_records_the_cost_it_was_made_with(self) -> None:
        # So `N` can be raised later without locking out a single account.
        params = parameters_of(hash_password(PASSWORD))
        assert (params.n, params.r, params.p) == (SCRYPT_N, SCRYPT_R, SCRYPT_P)

    def test_refuses_an_empty_password(self) -> None:
        with pytest.raises(ValueError):
            hash_password("")


class TestVerifying:
    def test_accepts_the_right_password(self) -> None:
        assert verify_password(PASSWORD, hash_password(PASSWORD)) is True

    def test_rejects_the_wrong_password(self) -> None:
        stored = hash_password(PASSWORD)
        assert verify_password("wrong", stored) is False
        # Nearly right is still wrong.
        assert verify_password(PASSWORD + " ", stored) is False
        assert verify_password(PASSWORD.upper(), stored) is False

    def test_rejects_a_password_against_another_password_hash(self) -> None:
        assert verify_password("alice's password", hash_password("bob's password")) is False

    def test_verifies_a_hash_made_with_older_parameters(self) -> None:
        # The reason the parameters are stored: an account created under a
        # weaker cost must still be able to sign in after the cost is raised.
        weak = hash_password(PASSWORD).split("$")
        # Rebuild the record as though it had been made at a lower cost. The
        # key is recomputed so the record is genuine rather than merely
        # relabelled - a relabelled one would fail for the wrong reason.
        import hashlib, base64

        salt = base64.b64decode(weak[4])
        key = hashlib.scrypt(
            PASSWORD.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32,
            maxmem=256 * 1024 * 1024,
        )
        older = f"scrypt$16384$8$1${weak[4]}${base64.b64encode(key).decode()}"
        assert verify_password(PASSWORD, older) is True
        assert needs_rehash(older) is True

    def test_says_nothing_needs_rehashing_at_the_current_cost(self) -> None:
        assert needs_rehash(hash_password(PASSWORD)) is False


class TestBrokenRecords:
    def test_a_malformed_record_raises_rather_than_returning_false(self) -> None:
        # A corrupt row is an operational problem, not a failed sign-in.
        # Returning False would report it to the user as "wrong password" and
        # hide it from everyone who could fix it.
        for broken in ["", "nonsense", "scrypt$1$2", "scrypt$a$b$c$d$e"]:
            with pytest.raises((PasswordError, ValueError)):
                verify_password(PASSWORD, broken)

    def test_an_unknown_scheme_is_refused_rather_than_guessed(self) -> None:
        with pytest.raises(PasswordError):
            verify_password(PASSWORD, "bcrypt$15$8$1$c2FsdA==$aGFzaA==")
