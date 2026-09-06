"""Staying signed in (D147).

A session is a random token the browser keeps in a cookie and this table
recognises. Three decisions shape it, and each is a refusal of something more
fashionable.

## Not a JWT

A signed token would let the server verify a session without a lookup, and buys
nothing here: this database is already open for every request that touches an
account, so the lookup is free. What a JWT costs is real - a signing secret to
manage and leak, and **no way to revoke a session before it expires**, because a
valid signature is valid until the clock says otherwise. A row can be deleted.
Signing out should sign you out.

## The token is stored hashed, but not slowly

Only a SHA-256 of the token is kept, so a stolen database cannot be used to
impersonate anybody - the same reason passwords are not stored in the clear.

But it is hashed **fast**, deliberately, where the password is hashed slowly.
The slow hash exists because a password is low-entropy and guessable; a session
token is 32 bytes from `secrets` and cannot be guessed at any speed worth
attempting. Using scrypt here would add tens of milliseconds to every
authenticated request in exchange for nothing. Knowing which of the two needs
the expensive treatment is the whole point.

## Expiry is absolute, not sliding

A session dies thirty days after it was created, not thirty days after it was
last used. A sliding window means a stolen cookie stays alive for as long as the
thief keeps using it, which is exactly the case it should not survive.
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

#: How long a session lasts, from creation.
SESSION_DAYS = 30

#: Bytes of entropy in a token. 32 is 256 bits, which is not guessable.
TOKEN_BYTES = 32

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    account_id INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
"""


@dataclass(frozen=True)
class Session:
    """A live session. The raw token is returned once, at creation, and never
    stored - so it exists in the cookie and nowhere else."""

    account_id: int
    expires_at: datetime


def hash_token(token: str) -> str:
    """The form a token is stored in. Fast on purpose - see the module note."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SessionStore:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path)
        db.row_factory = sqlite3.Row
        return db

    def create(self, account_id: int, now: datetime | None = None) -> tuple[str, Session]:
        """A new session, returning the raw token **once**.

        The caller puts it in a cookie. Nothing keeps a copy, which is what
        makes the stored hash worth anything.
        """
        moment = now or datetime.now(timezone.utc)
        token = secrets.token_urlsafe(TOKEN_BYTES)
        expires = moment + timedelta(days=SESSION_DAYS)
        with self._connect() as db:
            db.execute(
                "INSERT INTO sessions (token_hash, account_id, created_at, expires_at)"
                " VALUES (?, ?, ?, ?)",
                (hash_token(token), account_id, moment.isoformat(), expires.isoformat()),
            )
        return token, Session(account_id=account_id, expires_at=expires)

    def lookup(self, token: str, now: datetime | None = None) -> Session | None:
        """The session this token names, if it is live.

        An expired row is deleted on the way past rather than merely ignored:
        the table would otherwise grow forever with rows that can never be used
        again, and the tidying costs nothing at the moment it is discovered.
        """
        moment = now or datetime.now(timezone.utc)
        with self._connect() as db:
            row = db.execute(
                "SELECT account_id, expires_at FROM sessions WHERE token_hash = ?",
                (hash_token(token),),
            ).fetchone()
            if row is None:
                return None
            expires = datetime.fromisoformat(str(row["expires_at"]))
            if expires <= moment:
                db.execute(
                    "DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),)
                )
                return None
        return Session(account_id=int(row["account_id"]), expires_at=expires)

    def revoke(self, token: str) -> None:
        """Sign out. The row goes, so the cookie is worthless immediately."""
        with self._connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))

    def revoke_all(self, account_id: int) -> int:
        """Sign out everywhere - what a password change should do."""
        with self._connect() as db:
            cursor = db.execute("DELETE FROM sessions WHERE account_id = ?", (account_id,))
        return int(cursor.rowcount or 0)

    def count(self) -> int:
        with self._connect() as db:
            return int(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0])
