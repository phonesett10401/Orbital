"""Turning a password into something safe to store (D146).

This is the one module in Orbital where a mistake is not a wrong pixel. The
rules it follows are old and boring, and that is the point:

1. **The password is never stored**, in any form that can be reversed.
2. **Every password gets its own salt**, so two people who choose the same one
   do not share a hash and a stolen table cannot be attacked in bulk.
3. **Hashing is deliberately slow**, because the whole defence against an
   offline attack on a stolen database is how long each guess costs.
4. **Comparison is constant-time**, so a timing difference cannot leak how much
   of a hash was right.

## Why scrypt, and no new dependency

bcrypt and argon2 are the usual answers and both need a package. `hashlib.scrypt`
is in the standard library, is memory-hard - the property that makes GPU attacks
expensive rather than merely slow - and is what this uses. The project earns its
dependencies one at a time (see `pyproject.toml`, where every entry carries its
reason); this one does not need to be earned.

## The parameters travel with the hash

A stored hash records the cost it was made with, so `N` can be raised later
without invalidating a single existing account: an old hash still verifies under
its own parameters, and can be re-hashed on the next successful sign-in. A
scheme that hard-codes its cost has to choose between staying weak forever and
locking everybody out.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

#: Cost. `N` is the memory/time factor and must be a power of two.
#:
#: 2**15 with r=8 needs about 32 MB and a few tens of milliseconds per guess -
#: enough that an offline attacker pays dearly per attempt, and little enough
#: that a laptop serving this project does not stall on sign-in. OWASP's
#: recommendation is higher (2**17); raising it here is a one-line change that
#: old hashes survive, which is the reason the parameters are stored.
SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1

#: 16 bytes of salt, which is the usual floor, and a 32-byte derived key.
SALT_BYTES = 16
KEY_BYTES = 32

#: How a stored hash is spelled. Self-describing, so the verifier reads the
#: parameters out of the record rather than assuming today's constants.
SCHEME = "scrypt"


class PasswordError(ValueError):
    """A stored hash that cannot be read. Never raised for a wrong password."""


@dataclass(frozen=True)
class Parameters:
    """The cost a particular hash was made with."""

    n: int
    r: int
    p: int


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def hash_password(password: str) -> str:
    """A salted, parameterised hash, safe to store.

    The returned string carries everything `verify_password` needs and nothing
    it does not: scheme, cost, salt, key. No part of the password survives.
    """
    if not password:
        raise ValueError("password must not be empty")
    salt = secrets.token_bytes(SALT_BYTES)
    key = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=KEY_BYTES,
        # scrypt's memory use is roughly 128 * N * r bytes; Python refuses to
        # allocate past `maxmem`, and its default is far below what these
        # parameters need. Stated rather than left to the default, because the
        # failure is an exception at sign-up rather than a weak hash.
        maxmem=256 * 1024 * 1024,
    )
    return f"{SCHEME}${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(key)}"


def parameters_of(stored: str) -> Parameters:
    """The cost a stored hash was made with."""
    try:
        scheme, n, r, p, _salt, _key = stored.split("$")
    except ValueError as exc:  # pragma: no cover - malformed record
        raise PasswordError("stored password hash is not in the expected form") from exc
    if scheme != SCHEME:
        raise PasswordError(f"unknown password scheme {scheme!r}")
    return Parameters(n=int(n), r=int(r), p=int(p))


def verify_password(password: str, stored: str) -> bool:
    """Whether this password produced this stored hash.

    Returns a bool for a wrong password and raises only for a record that
    cannot be read - the two are different problems and only one of them is the
    user's.
    """
    try:
        scheme, n, r, p, salt_b64, key_b64 = stored.split("$")
    except ValueError as exc:
        raise PasswordError("stored password hash is not in the expected form") from exc
    if scheme != SCHEME:
        raise PasswordError(f"unknown password scheme {scheme!r}")

    expected = _unb64(key_b64)
    candidate = hashlib.scrypt(
        password.encode("utf-8"),
        salt=_unb64(salt_b64),
        n=int(n),
        r=int(r),
        p=int(p),
        dklen=len(expected),
        maxmem=256 * 1024 * 1024,
    )
    # Constant time: a plain `==` returns as soon as two bytes differ, and the
    # time it took says how many matched.
    return hmac.compare_digest(candidate, expected)


def needs_rehash(stored: str) -> bool:
    """Whether this hash was made with weaker parameters than today's.

    Checked on a successful sign-in, which is the only moment the password is
    in hand and a stronger hash can be made without asking anybody anything.
    """
    current = parameters_of(stored)
    return (current.n, current.r, current.p) != (SCRYPT_N, SCRYPT_R, SCRYPT_P)
