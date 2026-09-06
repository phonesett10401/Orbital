"""Where accounts live (D146).

SQLite, through the standard library. Orbital has had no database at all until
now - an in-memory object store and one JSON cache file - and this is the first
thing it holds that must survive a restart and cannot be refetched from
anywhere. A file beside the element cache is the whole of the infrastructure,
which keeps the project runnable with `uvicorn` and nothing else.

## What is stored, and what is deliberately not

An account is an email, a password hash, a tier and a created date. There is no
name, no address, no location history, no record of what anybody looked at. The
freemium discussion turned on selling *computed* things - pass predictions,
alerts, exports - and none of those require knowing who a person is beyond
"this row paid".

That is worth stating rather than leaving implicit: a flight tracker is exactly
the sort of application that could quietly accumulate a movement profile of its
users, and choosing not to collect it is a design decision, not an oversight.

## The email is stored folded, and compared folded

Addresses are case-insensitive in practice, so `Phone@Example.com` and
`phone@example.com` are one account. Folding on the way in makes the uniqueness
constraint do that work, rather than leaving two rows that look identical to a
person and different to the database.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.accounts.passwords import hash_password, needs_rehash, verify_password

#: The tiers the freemium design uses. Kept as plain strings rather than an
#: enum in the schema, because the set will change and a migration to add a
#: tier should be a row, not a column type.
TIER_FREE = "free"
TIER_PREMIUM = "premium"

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    tier          TEXT    NOT NULL DEFAULT 'free',
    created_at    TEXT    NOT NULL
);
"""


class AccountError(RuntimeError):
    """Something the caller asked for cannot be done."""


class EmailTaken(AccountError):
    """That address already has an account."""


@dataclass(frozen=True)
class Account:
    """An account, without its password hash.

    The hash is deliberately absent from the type that leaves this module: a
    struct that carries it will eventually be logged, serialised or returned,
    and the way to stop that is for it not to be there. The one function that
    needs it reads it inside a query and does not hand it back (D146).
    """

    id: int
    email: str
    tier: str
    created_at: datetime

    @property
    def is_premium(self) -> bool:
        return self.tier == TIER_PREMIUM


def fold_email(email: str) -> str:
    """The form an address is stored and compared in."""
    return email.strip().lower()


class AccountStore:
    """Accounts in SQLite.

    The connection is opened per call rather than held: this is a low-traffic
    table on a local file, and a long-lived connection shared across FastAPI's
    threadpool is a source of `SQLITE_MISUSE` that no test would catch.
    """

    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path)
        db.row_factory = sqlite3.Row
        return db

    def create(self, email: str, password: str, tier: str = TIER_FREE) -> Account:
        """Register an account, or refuse because the address is taken."""
        folded = fold_email(email)
        if not folded:
            raise AccountError("an email address is required")
        stored = hash_password(password)
        now = datetime.now(timezone.utc)
        try:
            with self._connect() as db:
                cursor = db.execute(
                    "INSERT INTO accounts (email, password_hash, tier, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    (folded, stored, tier, now.isoformat()),
                )
        except sqlite3.IntegrityError as exc:
            raise EmailTaken(f"{folded} already has an account") from exc
        return Account(id=int(cursor.lastrowid or 0), email=folded, tier=tier, created_at=now)

    def authenticate(self, email: str, password: str) -> Account | None:
        """The account this password belongs to, or None.

        **One answer for both failures.** An unknown address and a wrong
        password return the same thing, because telling them apart tells an
        attacker which addresses are registered - and that is a fact about a
        person, not about this service.
        """
        folded = fold_email(email)
        with self._connect() as db:
            row = db.execute(
                "SELECT id, email, password_hash, tier, created_at FROM accounts"
                " WHERE email = ?",
                (folded,),
            ).fetchone()

        if row is None:
            # Deliberately still spends the time a real verification costs.
            # Returning immediately makes "no such account" measurably faster
            # than "wrong password", which is the same disclosure by a
            # stopwatch instead of a message.
            hash_password(password)
            return None

        if not verify_password(password, row["password_hash"]):
            return None

        if needs_rehash(row["password_hash"]):
            # The one moment the password is in hand and a stronger hash can be
            # made without asking anybody anything.
            with self._connect() as db:
                db.execute(
                    "UPDATE accounts SET password_hash = ? WHERE id = ?",
                    (hash_password(password), row["id"]),
                )

        return self._account(row)

    def by_id(self, account_id: int) -> Account | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT id, email, tier, created_at FROM accounts WHERE id = ?",
                (account_id,),
            ).fetchone()
        return self._account(row) if row else None

    def set_tier(self, account_id: int, tier: str) -> Account | None:
        with self._connect() as db:
            db.execute("UPDATE accounts SET tier = ? WHERE id = ?", (tier, account_id))
        return self.by_id(account_id)

    def count(self) -> int:
        with self._connect() as db:
            return int(db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0])

    @staticmethod
    def _account(row: sqlite3.Row) -> Account:
        return Account(
            id=int(row["id"]),
            email=str(row["email"]),
            tier=str(row["tier"]),
            created_at=datetime.fromisoformat(str(row["created_at"])),
        )
