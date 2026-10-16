"""
test_accounts.py
Accounts (accounts/, api/routes_accounts.py) and what they allow in a room.

What must hold: a password is never stored as given; a session is a cookie the
page cannot read; and in a room an account created, the account -- not a code
and not a password -- decides who may take the chair and who may bid.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from accounts import store
from accounts.passwords import hash_password, verify_password
from api.routes_accounts import COOKIE, _failures
from auction.rooms import MAIN, registry
from config.settings import get_settings

POOL = [
    {"id": i, "player_name": f"Player {i}", "role": "Batter", "overseas": 0,
     "base_price": 50, "cap_status": "CAPPED"}
    for i in range(1, 9)
]


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("ACCOUNTS_DB_PATH", str(tmp_path / "accounts.db"))
    monkeypatch.setattr(store, "_ready_for", None)
    monkeypatch.setattr(get_settings(), "AUCTIONEER_PASSWORD", "legacy-password")
    _failures.clear()
    registry.set_pool(POOL)
    yield
    for entry in registry.entries():
        if entry.code != MAIN:
            registry._rooms.pop(entry.code, None)


@pytest.fixture
def client():
    from api.main import app

    with TestClient(app) as c:
        yield c


def register(client, role, email=None, password="long-enough-pw"):
    email = email or f"{role}-{uuid.uuid4().hex}@example.test"
    response = client.post(
        "/api/v1/accounts/register",
        json={"name": f"{role.title()} Person", "email": email, "password": password, "role": role},
    )
    assert response.status_code == 200, response.text
    token = response.cookies.get(COOKIE)
    client.cookies.clear()  # each socket below says whose it is explicitly
    return token


def as_account(token):
    return {"cookie": f"{COOKIE}={token}"} if token else {}


def drain(sock, predicate, limit=30):
    for _ in range(limit):
        msg = sock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message never arrived")


def answer(sock):
    return drain(sock, lambda m: m.get("type") in ("joined", "error"))


class TestPasswords:
    def test_hash_is_salted_and_verifies(self):
        a, b = hash_password("same password"), hash_password("same password")
        assert a != b and a.startswith("scrypt$")
        assert verify_password("same password", a)
        assert not verify_password("other password", a)
        assert not verify_password("anything", "garbage")


class TestEndpoints:
    def test_register_logs_in_and_me_answers(self, client):
        response = client.post(
            "/api/v1/accounts/register",
            json={"name": "  Ravi   Shastri ", "email": "Ravi@Example.TEST", "password": "long-enough-pw", "role": "auctioneer"},
        )
        assert response.status_code == 200
        account = response.json()["account"]
        assert account["role"] == "auctioneer" and account["name"] == "Ravi Shastri"
        assert account["email"] == "ravi@example.test"
        assert "password" not in str(response.json())
        set_cookie = response.headers["set-cookie"].lower()
        assert "httponly" in set_cookie and "samesite=lax" in set_cookie
        assert client.get("/api/v1/accounts/me").json()["account"]["email"] == "ravi@example.test"

    def test_password_is_not_stored_as_given(self, client):
        register(client, "member", email="plain@example.test", password="visible-password")
        _, stored = store.account_with_password("plain@example.test")
        assert "visible-password" not in stored

    def test_duplicate_email_is_refused(self, client):
        register(client, "delegate", email="dup@example.test")
        again = client.post(
            "/api/v1/accounts/register",
            json={"name": "X", "email": "DUP@example.test", "password": "long-enough-pw", "role": "member"},
        )
        assert again.status_code == 409

    def test_bad_input_is_refused(self, client):
        for body in (
            {"name": "X", "email": "not-an-email", "password": "long-enough-pw", "role": "member"},
            {"name": "X", "email": "a@b.test", "password": "short", "role": "member"},
            {"name": "X", "email": "a@b.test", "password": "long-enough-pw", "role": "admin"},
        ):
            assert client.post("/api/v1/accounts/register", json=body).status_code == 422

    def test_login_logout(self, client):
        register(client, "delegate", email="dee@example.test", password="right-password")
        wrong = client.post("/api/v1/accounts/login", json={"email": "dee@example.test", "password": "wrong-password"})
        unknown = client.post("/api/v1/accounts/login", json={"email": "nobody@example.test", "password": "x"})
        # The same answer for both: it does not say which emails exist.
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json() == unknown.json()
        ok = client.post("/api/v1/accounts/login", json={"email": "DEE@example.test", "password": "right-password"})
        assert ok.status_code == 200 and ok.json()["account"]["role"] == "delegate"
        assert client.get("/api/v1/accounts/me").status_code == 200
        client.post("/api/v1/accounts/logout")
        assert client.get("/api/v1/accounts/me").status_code == 401

    def test_repeated_failures_are_slowed(self, client):
        register(client, "member", email="slow@example.test")
        codes = [
            client.post("/api/v1/accounts/login", json={"email": "slow@example.test", "password": "nope"}).status_code
            for _ in range(12)
        ]
        assert codes[0] == 401 and codes[-1] == 429


class TestRoomsByAccount:
    def test_only_an_auctioneer_account_creates_a_room(self, client):
        from starlette.websockets import WebSocketDisconnect

        cases = (
            (None, "Log in"),
            (register(client, "delegate"), "delegate rooms only"),
            (register(client, "member"), "Auctioneer account"),
        )
        for token, says in cases:
            with client.websocket_connect("/api/v1/auction/ws?room=NOPE1&open=1", headers=as_account(token)) as sock:
                refusal = sock.receive_json()
                assert refusal["about"] == "room" and says in refusal["message"]
                with pytest.raises(WebSocketDisconnect) as closed:
                    sock.receive_json()
                assert closed.value.code == 4403
        assert registry.get("NOPE1") is None

    def test_the_chair_is_the_creators_alone(self, client):
        owner = register(client, "auctioneer")
        other = register(client, "auctioneer")
        delegate = register(client, "delegate")
        with client.websocket_connect("/api/v1/auction/ws?room=OWNED1&open=1", headers=as_account(owner)) as host:
            drain(host, lambda m: m.get("type") == "state")
            # Another auctioneer account, even holding the old password: refused.
            with client.websocket_connect("/api/v1/auction/ws?room=OWNED1", headers=as_account(other)) as rival:
                rival.send_json({"type": "join", "role": "auctioneer", "password": "legacy-password"})
                assert "created this room" in answer(rival)["message"]
            # A delegate with the code and the password: refused.
            with client.websocket_connect("/api/v1/auction/ws?room=OWNED1", headers=as_account(delegate)) as sneak:
                sneak.send_json({"type": "join", "role": "auctioneer", "password": "legacy-password"})
                assert "Auctioneer account" in answer(sneak)["message"]
            # The creator: no password needed, the account is the credential.
            host.send_json({"type": "join", "role": "auctioneer"})
            assert answer(host)["type"] == "joined"

    def test_only_delegates_bid_one_seat_each(self, client):
        owner = register(client, "auctioneer")
        delegate = register(client, "delegate")
        member = register(client, "member")
        with client.websocket_connect("/api/v1/auction/ws?room=SEATS1&open=1", headers=as_account(owner)) as host:
            drain(host, lambda m: m.get("type") == "state")
            with client.websocket_connect("/api/v1/auction/ws?room=SEATS1", headers=as_account(member)) as free:
                free.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert "Delegate account" in answer(free)["message"]
            with client.websocket_connect("/api/v1/auction/ws?room=SEATS1", headers=as_account(delegate)) as first, \
                 client.websocket_connect("/api/v1/auction/ws?room=SEATS1", headers=as_account(delegate)) as second:
                first.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert answer(first)["type"] == "joined"
                second.send_json({"type": "join", "role": "franchise", "team_id": 2})
                assert "already holds" in answer(second)["message"]

    def test_main_room_keeps_its_password_chair(self, client):
        with client.websocket_connect("/api/v1/auction/ws") as sock:
            drain(sock, lambda m: m.get("type") == "state")
            sock.send_json({"type": "join", "role": "auctioneer", "password": "legacy-password"})
            assert answer(sock)["type"] == "joined"


class TestDemoAccounts:
    def test_demo_accounts_are_made_and_refreshed(self):
        from accounts.demo import DEMO_ACCOUNTS, ensure_demo_accounts

        assert ensure_demo_accounts("first-demo-pw") == len(DEMO_ACCOUNTS)
        roles = {role for _, _, role in DEMO_ACCOUNTS}
        assert roles == {"auctioneer", "delegate", "member"}
        email = DEMO_ACCOUNTS[0][0]
        account, stored = store.account_with_password(email)
        assert verify_password("first-demo-pw", stored)
        # Run again with a new password: same account, new password.
        ensure_demo_accounts("second-demo-pw")
        again, stored = store.account_with_password(email)
        assert again.id == account.id
        assert verify_password("second-demo-pw", stored) and not verify_password("first-demo-pw", stored)


class TestAdministrators:
    def test_admin_is_granted_by_email_and_reserved(self, client, monkeypatch):
        token = register(client, "member", email="boss@example.test")
        monkeypatch.setattr(get_settings(), "ADMIN_EMAILS", "Boss@Example.test, other@example.test")
        me = client.get("/api/v1/accounts/me", headers=as_account(token)).json()["account"]
        assert me["admin"] is True and me["role"] == "member"
        # A listed address cannot be registered by anyone else.
        taken = client.post(
            "/api/v1/accounts/register",
            json={"name": "X", "email": "other@example.test", "password": "long-enough-pw", "role": "auctioneer"},
        )
        assert taken.status_code == 403

    def test_admin_runs_any_room(self, client, monkeypatch):
        owner = register(client, "auctioneer")
        admin = register(client, "member", email="admin@example.test")
        monkeypatch.setattr(get_settings(), "ADMIN_EMAILS", "admin@example.test")
        # An admin creates a room even with a member account...
        with client.websocket_connect("/api/v1/auction/ws?room=ADMIN1&open=1", headers=as_account(admin)) as sock:
            assert drain(sock, lambda m: m.get("type") == "state")["room"] == "ADMIN1"
        # ...and takes the chair of a room another auctioneer created.
        with client.websocket_connect("/api/v1/auction/ws?room=THEIRS1&open=1", headers=as_account(owner)) as host:
            drain(host, lambda m: m.get("type") == "state")
            with client.websocket_connect("/api/v1/auction/ws?room=THEIRS1", headers=as_account(admin)) as boss:
                boss.send_json({"type": "join", "role": "auctioneer"})
                assert answer(boss)["type"] == "joined"

    def test_admin_session_opens_admin_endpoints(self, client, monkeypatch):
        from api.auth import require_admin

        admin = register(client, "member", email="keyless@example.test")
        monkeypatch.setattr(get_settings(), "ADMIN_EMAILS", "keyless@example.test")
        monkeypatch.setattr(get_settings(), "ADMIN_API_KEY", "a-real-key")

        class Req:
            def __init__(self, cookie):
                self.cookies = {COOKIE: cookie} if cookie else {}

        import asyncio
        asyncio.run(require_admin(Req(admin), None))  # no key, admin session: allowed
        with pytest.raises(Exception):
            asyncio.run(require_admin(Req(None), None))  # no key, no session: refused


class TestDelegateRooms:
    def test_a_delegate_runs_a_room_of_its_own(self, client):
        creator = register(client, "delegate")
        bidder = register(client, "delegate")
        auctioneer = register(client, "auctioneer")
        member = register(client, "member")
        ws = "/api/v1/auction/ws"
        with client.websocket_connect(f"{ws}?room=DELE1&open=1&type=delegate", headers=as_account(creator)) as host:
            state = drain(host, lambda m: m.get("type") == "state")
            assert state["room_type"] == "delegate"
            host.send_json({"type": "join", "role": "auctioneer"})
            assert answer(host)["type"] == "joined"
            # The one running it does not also bid in it.
            with client.websocket_connect(f"{ws}?room=DELE1", headers=as_account(creator)) as again:
                again.send_json({"type": "join", "role": "franchise", "team_id": 3})
                assert "running this room" in answer(again)["message"]
            # Other delegates take seats as usual.
            with client.websocket_connect(f"{ws}?room=DELE1", headers=as_account(bidder)) as seat:
                seat.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert answer(seat)["type"] == "joined"
            # An auctioneer account cannot take a delegate room's chair.
            with client.websocket_connect(f"{ws}?room=DELE1", headers=as_account(auctioneer)) as other:
                other.send_json({"type": "join", "role": "auctioneer"})
                assert "Delegate account that created" in answer(other)["message"]
        # A member creates neither kind.
        with client.websocket_connect(f"{ws}?room=DELE2&open=1&type=delegate", headers=as_account(member)) as sock:
            assert "Delegate account" in sock.receive_json()["message"]

    def test_delegates_still_join_auctioneer_rooms(self, client):
        owner = register(client, "auctioneer")
        delegate = register(client, "delegate")
        ws = "/api/v1/auction/ws"
        with client.websocket_connect(f"{ws}?room=OFFICIAL1&open=1", headers=as_account(owner)) as host:
            assert drain(host, lambda m: m.get("type") == "state")["room_type"] == "auctioneer"
            with client.websocket_connect(f"{ws}?room=OFFICIAL1", headers=as_account(delegate)) as seat:
                seat.send_json({"type": "join", "role": "franchise", "team_id": 2})
                assert answer(seat)["type"] == "joined"
