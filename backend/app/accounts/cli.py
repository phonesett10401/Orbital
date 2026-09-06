"""Making and promoting accounts from a terminal (D152).

Until now the only way to get anything other than a free account was to open the
SQLite file and write an `UPDATE`, which was recorded as an honest gap and is
now closed. This is the supported way.

    python -m app.accounts.cli create you@example.com --tier admin
    python -m app.accounts.cli set-tier you@example.com premium
    python -m app.accounts.cli list

## The password is typed, never passed

There is deliberately no `--password` flag. An argument is visible in `ps` to
every other user on the machine, and it lands in shell history, where it stays
long after the person has forgotten typing it. `getpass` reads it from the
terminal without echoing, asks twice, and the value never leaves this process
except as a scrypt hash.

That is also why this is a command rather than an HTTP endpoint. An endpoint
that makes administrators is an endpoint somebody can reach; a command requires
the file and the machine, which is the level of access an administrator already
implies.

## It refuses to be run against nothing

The database path comes from the same `Settings` the server uses, so the account
this makes is the account that server will accept. Printing the path before
doing anything is not decoration: the failure this prevents is creating an
admin in `./.cache/` while the server reads one somewhere else, and then not
being able to sign in with credentials that are provably correct.
"""

from __future__ import annotations

import argparse
import sys
from getpass import getpass
from pathlib import Path

from app.accounts.passwords import MIN_PASSWORD_LENGTH
from app.accounts.store import (
    TIER_ADMIN,
    TIER_FREE,
    TIER_PREMIUM,
    AccountStore,
    EmailTaken,
    fold_email,
)
from app.config import Settings

TIERS = (TIER_FREE, TIER_PREMIUM, TIER_ADMIN)


def _store(args: argparse.Namespace) -> tuple[AccountStore, str]:
    """The database the server would use, or the one named on the command line.

    **The default is relative to the working directory**, because that is what
    `Settings` says, so running this from `backend/` and running the server from
    the repository root reach two different files. That is not hypothetical - it
    happened the first time this command was run. Hence `--db`, and hence every
    command printing the path it resolved before it does anything.
    """
    path = Path(args.db) if args.db else Settings().accounts_db_path
    return AccountStore(path), str(path.resolve())


def _ask_for_a_password() -> str:
    """Twice, without echoing, and checked before it is used.

    Asking twice is not ceremony: this password cannot be reset by anybody, and
    a typo in the one that creates the administrator locks the administrator
    out of their own deployment.
    """
    while True:
        first = getpass("Password (not shown): ")
        if len(first) < MIN_PASSWORD_LENGTH:
            print(f"  too short - use at least {MIN_PASSWORD_LENGTH} characters")
            continue
        if first != getpass("Again: "):
            print("  those did not match")
            continue
        return first


def create(args: argparse.Namespace) -> int:
    accounts, path = _store(args)
    print(f"database: {path}")
    password = _ask_for_a_password()
    try:
        account = accounts.create(args.email, password, tier=args.tier)
    except EmailTaken:
        print(f"{fold_email(args.email)} already has an account", file=sys.stderr)
        print("use `set-tier` to change what it can do", file=sys.stderr)
        return 1
    print(f"created {account.email} as {account.tier}")
    return 0


def set_tier(args: argparse.Namespace) -> int:
    accounts, path = _store(args)
    print(f"database: {path}")
    folded = fold_email(args.email)
    found = next((a for a in accounts.all() if a.email == folded), None)
    if found is None:
        print(f"no account for {folded}", file=sys.stderr)
        return 1
    updated = accounts.set_tier(found.id, args.tier)
    print(f"{folded} is now {updated.tier if updated else args.tier}")
    return 0


def listing(args: argparse.Namespace) -> int:
    accounts, path = _store(args)
    print(f"database: {path}")
    rows = accounts.all()
    if not rows:
        print("no accounts yet")
        return 0
    width = max(len(a.email) for a in rows)
    for account in rows:
        # No hash, not even a truncated one. The struct that leaves the store
        # does not carry it, and this is the sort of place somebody would
        # otherwise go looking for one to print (D146).
        print(f"{account.email:<{width}}  {account.tier:<8}  {account.created_at:%Y-%m-%d}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.accounts.cli",
        description="Make and promote Orbital accounts.",
    )
    parser.add_argument(
        "--db",
        default=None,
        metavar="PATH",
        help=(
            "the accounts database to use. Defaults to the one Settings names, "
            "which is relative to the working directory - so run this from the "
            "same place you run the server, or pass this."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    made = sub.add_parser("create", help="make an account, asking for the password")
    made.add_argument("email")
    made.add_argument("--tier", choices=TIERS, default=TIER_FREE)
    made.set_defaults(run=create)

    moved = sub.add_parser("set-tier", help="change what an existing account can do")
    moved.add_argument("email")
    moved.add_argument("tier", choices=TIERS)
    moved.set_defaults(run=set_tier)

    shown = sub.add_parser("list", help="every account, without any hashes")
    shown.set_defaults(run=listing)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.run(args))


if __name__ == "__main__":
    raise SystemExit(main())
