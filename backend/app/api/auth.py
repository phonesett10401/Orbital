"""Register, sign in, sign out, and who am I (D147).

## The token lives in an HttpOnly cookie, not in the page

The alternative is to return it in the body and have the frontend keep it in
`localStorage`, which is common and is worse: anything that manages to run a
script on the page can read `localStorage`, and the whole value of a session
token is that it cannot be read. `HttpOnly` puts it somewhere JavaScript cannot
reach at all - including ours.

The cost is that the browser now sends it automatically, which is what CSRF
exploits, so:

- **`SameSite=Lax`** - the cookie is not sent on cross-site POSTs, which is the
  shape a CSRF attack takes. Lax rather than Strict so that following a link
  into Orbital does not appear to sign you out.
- **`Secure`** whenever the deployment is not plain local development, because
  a cookie sent over http is a cookie anyone on the network has.

## Sign-in is rate limited

Without it, a slow hash is only a speed bump: an attacker who can ask a thousand
times a second still gets a thousand guesses a second. The limit is per address
and in memory, which is honest for one process and is written down as the thing
to replace first if this is ever deployed on more than one.

## `/me` answers 200 with a null account

Rather than 401. It is the question *"is anyone signed in"*, asked on every page
load, and a 401 for the ordinary answer fills the console with errors that mean
nothing and trains everybody to ignore them.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator

from app.accounts.passwords import MIN_PASSWORD_LENGTH
from app.accounts.sessions import SESSION_DAYS, SessionStore
from app.accounts.store import (
    TIER_FREE,
    TIER_PREMIUM,
    Account,
    AccountStore,
    EmailTaken,
)
from app.config import Settings
from app.api.deps import get_settings_dep

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

#: The cookie the browser keeps. Named without a hint of what it unlocks.
SESSION_COOKIE = "orbital_session"

#: Sign-in attempts allowed per address before the door closes for a while.
MAX_ATTEMPTS = 8
ATTEMPT_WINDOW_SECONDS = 300

# `MIN_PASSWORD_LENGTH` is re-exported from `app.accounts.passwords`, where it
# now lives beside the hashing it constrains. Imported rather than restated, so
# the API and the admin command line cannot drift apart.

_attempts: dict[str, list[float]] = defaultdict(list)


def _too_many_attempts(key: str, now: float) -> bool:
    recent = [t for t in _attempts[key] if now - t < ATTEMPT_WINDOW_SECONDS]
    _attempts[key] = recent
    return len(recent) >= MAX_ATTEMPTS


def _record_attempt(key: str, now: float) -> None:
    _attempts[key].append(now)


def reset_attempts() -> None:
    """For tests, which must not inherit a previous test's lockout."""
    _attempts.clear()


class Credentials(BaseModel):
    """An address and a password.

    The address is checked for shape and nothing more, and `EmailStr` - which
    would have added the `email-validator` dependency - is deliberately not
    used. **The only real validation of an address is sending a message to it**,
    which this does not do; a strict grammar in front of that proves nothing and
    reliably rejects valid unusual addresses. So: one `@`, something either
    side, no spaces (D147).
    """

    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)

    @field_validator("email")
    @classmethod
    def _looks_like_an_address(cls, value: str) -> str:
        candidate = value.strip()
        local, _, domain = candidate.partition("@")
        if not local or not domain or " " in candidate or "@" in domain:
            raise ValueError("that does not look like an email address")
        return candidate


class AccountView(BaseModel):
    """What the browser is told about the signed-in account.

    Email and tier. No id: it is a database key, the frontend has no use for
    it, and every field published here is a field that has to keep existing.
    """

    email: str
    tier: str


class MeResponse(BaseModel):
    account: AccountView | None


def get_accounts(request: Request) -> AccountStore:
    return getattr(request.app.state, "accounts", None)  # type: ignore[return-value]


def get_sessions(request: Request) -> SessionStore:
    return getattr(request.app.state, "sessions", None)  # type: ignore[return-value]


def current_account(
    request: Request,
    accounts: AccountStore = Depends(get_accounts),
    sessions: SessionStore = Depends(get_sessions),
) -> Account | None:
    """The signed-in account, or None. The one way to ask."""
    token = request.cookies.get(SESSION_COOKIE)
    # `accounts` and `sessions` are hung off `app.state` in the lifespan, so a
    # test client built without one has neither. Asking "is anyone signed in"
    # must answer "no" there rather than raising: routes that merely *consult*
    # the account, like the satellite window (D149), would otherwise fail for a
    # reason that has nothing to do with what they were asked.
    if not token or accounts is None or sessions is None:
        return None
    session = sessions.lookup(token)
    if session is None:
        return None
    return accounts.by_id(session.account_id)


def require_account(account: Account | None = Depends(current_account)) -> Account:
    """For routes that are only for signed-in people."""
    if account is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to do that")
    return account


def _set_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookies_secure,
        path="/",
    )


@router.post("/register", response_model=MeResponse, status_code=status.HTTP_201_CREATED)
def register(
    body: Credentials,
    response: Response,
    accounts: AccountStore = Depends(get_accounts),
    sessions: SessionStore = Depends(get_sessions),
    settings: Settings = Depends(get_settings_dep),
) -> MeResponse:
    if len(body.password) < MIN_PASSWORD_LENGTH:
        # 422 by number: Starlette has deprecated one spelling of the constant
        # and not every version has the replacement, and a deprecation warning
        # in the suite is noise that trains people to ignore warnings.
        raise HTTPException(
            422, f"password must be at least {MIN_PASSWORD_LENGTH} characters"
        )
    try:
        account = accounts.create(body.email, body.password)
    except EmailTaken:
        # Deliberately the same status and shape a validation failure gets.
        # "That address is already registered" is a fact about a person, and
        # this endpoint is unauthenticated - anybody could ask it about anybody.
        raise HTTPException(
            status.HTTP_409_CONFLICT, "that address cannot be registered"
        ) from None

    token, _ = sessions.create(account.id)
    _set_cookie(response, token, settings)
    logger.info("account registered: id=%s tier=%s", account.id, account.tier)
    return MeResponse(account=AccountView(email=account.email, tier=account.tier))


@router.post("/login", response_model=MeResponse)
def login(
    body: Credentials,
    response: Response,
    accounts: AccountStore = Depends(get_accounts),
    sessions: SessionStore = Depends(get_sessions),
    settings: Settings = Depends(get_settings_dep),
) -> MeResponse:
    now = time.monotonic()
    key = body.email.strip().lower()
    if _too_many_attempts(key, now):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "too many attempts, wait a few minutes"
        )

    account = accounts.authenticate(body.email, body.password)
    if account is None:
        _record_attempt(key, now)
        # One message for a wrong password and an unknown address, as the store
        # gives one answer for both (D146).
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "email or password is wrong")

    token, _ = sessions.create(account.id)
    _set_cookie(response, token, settings)
    return MeResponse(account=AccountView(email=account.email, tier=account.tier))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    sessions: SessionStore = Depends(get_sessions),
) -> Response:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        # The row goes, so the cookie is worthless from here even if a copy of
        # it exists somewhere. This is what a JWT could not do (D147).
        sessions.revoke(token)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


class TierChange(BaseModel):
    """The tier an account is asking to move itself to."""

    tier: str


@router.post("/subscription", response_model=MeResponse)
def change_subscription(
    body: TierChange,
    account: Account = Depends(require_account),
    accounts: AccountStore = Depends(get_accounts),
    settings: Settings = Depends(get_settings_dep),
) -> MeResponse:
    """Move this account between free and premium (D157).

    ## There is no payment here, and that is deliberate rather than unfinished

    A real processor needs an account, live keys, a domain and a policy review,
    and none of that belongs in this repository. What *would* be wrong is
    pretending: a button labelled "Buy" that takes no money is a lie told in the
    interface, so the page that calls this says exactly what it is.

    `self_serve_premium` is the switch. It is on because nobody is being billed;
    it is the first thing to turn off the day anybody is, at which point this
    route is where a processor's webhook goes instead.

    ## It can never make an administrator

    The one line here that is not a placeholder. `admin` is not a purchasable
    tier and never will be, so a request for it is refused whatever the setting
    says - otherwise this endpoint, which any signed-in reader can reach, would
    be a self-service route to running the deployment.
    """
    if not settings.self_serve_premium:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "premium cannot be changed from here"
        )

    wanted = body.tier.strip().lower()
    if wanted not in {TIER_FREE, TIER_PREMIUM}:
        # Deliberately the same answer for `admin` and for nonsense: this
        # endpoint has no opinion about which tiers exist beyond the two it
        # sells, and saying "admin is a real tier you may not have" is a fact
        # about the deployment that a stranger does not need.
        raise HTTPException(422, "that is not a tier you can change to")

    updated = accounts.set_tier(account.id, wanted)
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that account is gone")
    logger.info("tier changed by self-service: id=%s tier=%s", updated.id, updated.tier)
    return MeResponse(account=AccountView(email=updated.email, tier=updated.tier))


@router.get("/me", response_model=MeResponse)
def me(account: Account | None = Depends(current_account)) -> MeResponse:
    if account is None:
        return MeResponse(account=None)
    return MeResponse(account=AccountView(email=account.email, tier=account.tier))
