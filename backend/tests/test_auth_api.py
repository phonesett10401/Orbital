"""Register, sign in, sign out (D147).

Through a real `TestClient` with a real cookie jar and a real SQLite file in a
temporary directory. The cookie flags and the session lifecycle are the point,
and a mocked client would be asserting the mock.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.accounts.sessions import SessionStore
from app.accounts.store import TIER_PREMIUM, AccountStore
from app.api.auth import SESSION_COOKIE, MAX_ATTEMPTS, reset_attempts
from app.main import create_app

GOOD = {"email": "phone@example.com", "password": "a good long password"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    reset_attempts()
    app = create_app()
    # A fresh database per test, so one test's account cannot sign the next
    # one in.
    path = tmp_path / "accounts.sqlite"
    with TestClient(app) as c:
        app.state.accounts = AccountStore(path)
        app.state.sessions = SessionStore(path)
        yield c


class TestRegistering:
    def test_creates_an_account_and_signs_it_in(self, client: TestClient) -> None:
        response = client.post("/api/auth/register", json=GOOD)
        assert response.status_code == 201
        assert response.json()["account"] == {"email": "phone@example.com", "tier": "free"}
        assert client.get("/api/auth/me").json()["account"] is not None

    def test_the_session_cookie_is_not_readable_by_scripts(self, client: TestClient) -> None:
        # The whole reason for a cookie rather than a token in the page: if
        # JavaScript can read it, anything injected into the page can steal it.
        response = client.post("/api/auth/register", json=GOOD)
        header = response.headers["set-cookie"].lower()
        assert "httponly" in header
        assert "samesite=lax" in header
        assert "path=/" in header

    def test_the_token_is_never_in_the_response_body(self, client: TestClient) -> None:
        response = client.post("/api/auth/register", json=GOOD)
        token = client.cookies.get(SESSION_COOKIE)
        assert token
        assert token not in response.text

    def test_refuses_a_short_password(self, client: TestClient) -> None:
        response = client.post(
            "/api/auth/register", json={"email": "a@b.com", "password": "short"}
        )
        assert response.status_code == 422

    def test_refuses_something_that_is_not_an_address(self, client: TestClient) -> None:
        for bad in ["nobody", "no body@example.com", "a@b@c", "@example.com", "a@"]:
            response = client.post(
                "/api/auth/register", json={"email": bad, "password": "a good long password"}
            )
            assert response.status_code == 422, bad

    def test_a_taken_address_does_not_confirm_the_address_exists(
        self, client: TestClient
    ) -> None:
        # This endpoint is unauthenticated, so anybody could use it to ask
        # whether a given person has an account here (D147).
        client.post("/api/auth/register", json=GOOD)
        again = client.post("/api/auth/register", json=GOOD)
        assert again.status_code == 409
        assert "already" not in again.text.lower()
        assert GOOD["email"] not in again.text


class TestSigningIn:
    def test_accepts_the_right_password(self, client: TestClient) -> None:
        client.post("/api/auth/register", json=GOOD)
        client.post("/api/auth/logout")
        response = client.post("/api/auth/login", json=GOOD)
        assert response.status_code == 200
        assert client.get("/api/auth/me").json()["account"]["email"] == GOOD["email"]

    def test_rejects_a_wrong_password_without_saying_which_part_was_wrong(
        self, client: TestClient
    ) -> None:
        client.post("/api/auth/register", json=GOOD)
        client.post("/api/auth/logout")
        wrong = client.post(
            "/api/auth/login", json={"email": GOOD["email"], "password": "not it"}
        )
        unknown = client.post(
            "/api/auth/login", json={"email": "nobody@example.com", "password": "not it"}
        )
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json()["detail"] == unknown.json()["detail"]

    def test_locks_the_door_after_repeated_failures(self, client: TestClient) -> None:
        # A slow hash alone is only a speed bump against someone who can ask a
        # thousand times a second.
        client.post("/api/auth/register", json=GOOD)
        client.post("/api/auth/logout")
        for _ in range(MAX_ATTEMPTS):
            client.post("/api/auth/login", json={"email": GOOD["email"], "password": "no"})
        blocked = client.post("/api/auth/login", json=GOOD)
        assert blocked.status_code == 429

    def test_the_lockout_is_per_address(self, client: TestClient) -> None:
        # Otherwise one attacker locks out every user of the service, which
        # turns a defence into a denial of service.
        client.post("/api/auth/register", json=GOOD)
        client.post("/api/auth/logout")
        for _ in range(MAX_ATTEMPTS):
            client.post("/api/auth/login", json={"email": "someone@else.com", "password": "no"})
        assert client.post("/api/auth/login", json=GOOD).status_code == 200


class TestSigningOut:
    def test_forgets_the_session(self, client: TestClient) -> None:
        client.post("/api/auth/register", json=GOOD)
        assert client.post("/api/auth/logout").status_code == 204
        assert client.get("/api/auth/me").json()["account"] is None

    def test_the_old_token_is_dead_even_if_the_cookie_comes_back(
        self, client: TestClient
    ) -> None:
        # The property a JWT could not have given us: revocation before expiry
        # (D147). A copied cookie must stop working the moment you sign out.
        client.post("/api/auth/register", json=GOOD)
        stolen = client.cookies.get(SESSION_COOKIE)
        client.post("/api/auth/logout")
        client.cookies.set(SESSION_COOKIE, stolen)
        assert client.get("/api/auth/me").json()["account"] is None


class TestWhoAmI:
    def test_answers_two_hundred_with_nothing_when_signed_out(
        self, client: TestClient
    ) -> None:
        # Asked on every page load; a 401 for the ordinary answer trains people
        # to ignore console errors.
        response = client.get("/api/auth/me")
        assert response.status_code == 200
        assert response.json() == {"account": None}

    def test_ignores_a_token_that_was_never_issued(self, client: TestClient) -> None:
        client.cookies.set(SESSION_COOKIE, "not-a-real-token")
        assert client.get("/api/auth/me").json()["account"] is None

    def test_reports_the_tier(self, client: TestClient, tmp_path) -> None:
        # What the whole freemium design hangs on.
        client.post("/api/auth/register", json=GOOD)
        accounts: AccountStore = client.app.state.accounts  # type: ignore[attr-defined]
        signed_in = accounts.authenticate(GOOD["email"], GOOD["password"])
        assert signed_in is not None
        accounts.set_tier(signed_in.id, TIER_PREMIUM)
        assert client.get("/api/auth/me").json()["account"]["tier"] == "premium"
