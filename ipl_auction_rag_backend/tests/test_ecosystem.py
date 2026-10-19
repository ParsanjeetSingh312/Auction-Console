"""
test_ecosystem.py
Auction passes, the notification bell, connections and SCOUT's free allowance
(accounts/passes.py, notifications.py, connections.py, quota.py and
api/routes_ecosystem.py).

What must hold: passes only move down ADMIN > AUCTIONEER > DELEGATE > FREE; a
gift reaches the wallet only when claimed; a room costs its pass once and
gives it back when it never got going; a Free account gets 10 SCOUT requests
in its window and no more.
"""
from __future__ import annotations

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from accounts import passes, quota, store
from api.routes_accounts import COOKIE, _failures
from auction.rooms import MAIN, registry
from config.settings import get_settings

POOL = [
    {"id": i, "player_name": f"Player {i}", "role": "Batter", "overseas": 0,
     "base_price": 50, "cap_status": "CAPPED"}
    for i in range(1, 9)
]
WS = "/api/v1/auction/ws"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("ACCOUNTS_DB_PATH", str(tmp_path / "accounts.db"))
    monkeypatch.setattr(store, "_ready_for", None)
    settings = get_settings()
    monkeypatch.setattr(settings, "PASSES_ENFORCED", True)
    monkeypatch.setattr(settings, "SCOUT_FREE_LIMIT", 10)
    monkeypatch.setattr(settings, "TIER_GATES", True)
    monkeypatch.setattr(settings, "ADMIN_EMAILS", "root@example.test")
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


class Person:
    def __init__(self, client: TestClient, token: str, account_id: int):
        self.client, self.token, self.id = client, token, account_id

    @property
    def headers(self):
        return {"cookie": f"{COOKIE}={self.token}"}

    def get(self, path, **kw):
        return self.client.get(path, headers=self.headers, **kw)

    def post(self, path, json=None):
        return self.client.post(path, json=json or {}, headers=self.headers)

    def balances(self):
        return self.get("/api/v1/passes").json()["balances"]

    def bell(self):
        return self.get("/api/v1/notifications").json()

    def claim_all(self):
        for item in self.bell()["items"]:
            if item["gift"] and item["gift"]["status"] == "pending":
                assert self.post("/api/v1/passes/claim", {"gift_id": item["gift"]["id"]}).status_code == 200


def person(client, role, email=None) -> Person:
    email = email or f"{role}-{uuid.uuid4().hex[:8]}@example.test"
    if email in store.admin_emails():
        # The server makes admin accounts; registration refuses their address.
        found = store.account_with_password(email)  # startup may have made it
        account = found[0] if found else store.create_account(email, "Root", "auctioneer", "x")
        token = store.open_session(account.id)
        return Person(client, token, account.id)
    r = client.post(
        "/api/v1/accounts/register",
        json={"name": f"{role.title()} {email[:6]}", "email": email, "password": "long-enough-pw", "role": role},
    )
    assert r.status_code == 200, r.text
    token = r.cookies.get(COOKIE)
    client.cookies.clear()
    return Person(client, token, r.json()["account"]["id"])


def connect(a: Person, b: Person):
    assert a.post("/api/v1/connections/request", {"account_id": b.id}).json()["status"] == "pending"
    assert b.post("/api/v1/connections/request", {"account_id": a.id}).json()["status"] == "accepted"


def drain(sock, predicate, limit=30):
    for _ in range(limit):
        msg = sock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message never arrived")


def answer(sock):
    return drain(sock, lambda m: m.get("type") in ("joined", "error"))


# ------------------------------------------------------------- welcome --


class TestWelcome:
    def test_auctioneer_finds_a_gold_pass_to_claim(self, client):
        host = person(client, "auctioneer")
        bell = host.bell()
        assert bell["unread"] == 1 and bell["balances"] == {"A": 0, "D": 0}
        gift = bell["items"][0]["gift"]
        assert bell["items"][0]["kind"] == "welcome" and gift["kind"] == "A" and gift["sender"] == "AUCTONIQ"
        host.claim_all()
        assert host.balances() == {"A": 1, "D": 0}
        assert host.bell()["unread"] == 0  # claiming reads it
        again = host.post("/api/v1/passes/claim", {"gift_id": gift["id"]})
        assert again.status_code == 400 and "already claimed" in again.json()["detail"]

    def test_accounts_from_before_passes_are_welcomed_once(self, client):
        # An account made straight in the store, as every account was before
        # passes, has no welcome until the startup backfill runs.
        old = store.create_account("veteran@example.test", "Veteran", "auctioneer", "x")
        assert passes.welcome_missing() == 1
        assert passes.welcome_missing() == 0
        old_person = Person(client, store.open_session(old.id), old.id)
        old_person.claim_all()
        assert old_person.balances() == {"A": 1, "D": 0}

    def test_delegate_gets_blue_free_gets_a_message(self, client):
        delegate, free = person(client, "delegate"), person(client, "member")
        assert delegate.bell()["items"][0]["gift"]["kind"] == "D"
        items = free.bell()["items"]
        assert len(items) == 1 and items[0]["gift"] is None


# --------------------------------------------------------------- rules --


class TestGenerateAndSend:
    def test_who_generates_what(self, client, monkeypatch):
        host, delegate, root = person(client, "auctioneer"), person(client, "delegate"), person(client, "x", "root@example.test")
        assert host.post("/api/v1/passes/generate", {"kind": "D", "quantity": 3}).json()["balances"]["D"] == 3
        assert "administrator" in host.post("/api/v1/passes/generate", {"kind": "A", "quantity": 1}).json()["detail"]
        assert delegate.post("/api/v1/passes/generate", {"kind": "D", "quantity": 1}).status_code == 400
        assert root.post("/api/v1/passes/generate", {"kind": "A", "quantity": 99}).status_code == 200
        monkeypatch.setattr(get_settings(), "AUCTIONEER_DAILY_GENERATE_CAP", 5)
        capped = host.post("/api/v1/passes/generate", {"kind": "D", "quantity": 3})
        assert capped.status_code == 400 and "2 more" in capped.json()["detail"]

    def test_passes_only_go_down_the_order_to_connections(self, client):
        host, rival = person(client, "auctioneer"), person(client, "auctioneer")
        delegate, free = person(client, "delegate"), person(client, "member")
        host.post("/api/v1/passes/generate", {"kind": "D", "quantity": 10})
        send = lambda who, **kw: host.post("/api/v1/passes/send", {"recipient_ids": [who.id], "kind": "D", **kw})
        assert "Connect with" in send(delegate).json()["detail"]
        connect(host, delegate)
        connect(host, free)
        connect(host, rival)
        assert "Auctioneer" in send(rival).json()["detail"]
        assert host.post("/api/v1/passes/send", {"recipient_ids": [delegate.id], "kind": "A"}).status_code == 400
        # Delegates send nothing, even to their own connections.
        connect(delegate, free)
        assert delegate.post("/api/v1/passes/send", {"recipient_ids": [free.id], "kind": "D"}).status_code == 400

        r = host.post("/api/v1/passes/send", {"recipient_ids": [delegate.id, free.id], "kind": "D", "quantity": 2, "note": "For Friday"})
        assert r.status_code == 200 and r.json()["balances"]["D"] == 6
        gift = free.bell()["items"][0]
        assert gift["kind"] == "gift" and gift["gift"]["quantity"] == 2 and gift["gift"]["note"] == "For Friday"
        free.claim_all()
        assert free.balances()["D"] == 2

    def test_all_or_nothing_and_generate_missing(self, client):
        host, a, b = person(client, "auctioneer"), person(client, "delegate"), person(client, "delegate")
        connect(host, a)
        connect(host, b)
        short = host.post("/api/v1/passes/send", {"recipient_ids": [a.id, b.id], "kind": "D", "quantity": 3})
        assert short.status_code == 400 and "Generate more" in short.json()["detail"]
        assert a.bell()["items"][0]["kind"] == "connection"  # nobody got anything
        ok = host.post("/api/v1/passes/send", {"recipient_ids": [a.id, b.id], "kind": "D", "quantity": 3, "generate_missing": True})
        assert ok.status_code == 200 and ok.json()["balances"]["D"] == 0

    def test_admin_sends_either_kind_to_anyone(self, client):
        root, host = person(client, "x", "root@example.test"), person(client, "auctioneer")
        r = root.post("/api/v1/passes/send", {"recipient_ids": [host.id], "kind": "A", "quantity": 4})
        assert r.status_code == 200
        host.claim_all()
        assert host.balances()["A"] == 5  # 4 + the welcome pass

    def test_unclaimed_gift_returns_to_sender(self, client):
        host, delegate = person(client, "auctioneer"), person(client, "delegate")
        connect(host, delegate)
        host.post("/api/v1/passes/send", {"recipient_ids": [delegate.id], "kind": "D", "quantity": 2, "generate_missing": True})
        assert host.balances()["D"] == 0
        passes.expire_due(now=time.time() + 15 * 86400)
        assert host.balances()["D"] == 2
        assert host.bell()["items"][0]["kind"] == "gift_returned"
        gift_id = delegate.bell()["items"][0]["gift"]["id"]
        late = delegate.post("/api/v1/passes/claim", {"gift_id": gift_id})
        assert late.status_code == 400 and "expired" in late.json()["detail"]

    def test_nobody_claims_anothers_gift(self, client):
        a, b = person(client, "delegate"), person(client, "delegate")
        gift_id = a.bell()["items"][0]["gift"]["id"]
        assert b.post("/api/v1/passes/claim", {"gift_id": gift_id}).status_code == 400


# --------------------------------------------------------------- rooms --


class TestRooms:
    def test_creating_a_room_costs_one_gold_pass(self, client):
        host = person(client, "auctioneer")
        with client.websocket_connect(f"{WS}?room=NOPASS&open=1", headers=host.headers) as sock:
            refusal = sock.receive_json()
            assert refusal["type"] == "error" and "out of Auctioneer passes" in refusal["message"]
        host.claim_all()
        with client.websocket_connect(f"{WS}?room=PAID1&open=1", headers=host.headers) as sock:
            drain(sock, lambda m: m.get("type") == "state")
            sock.send_json({"type": "join", "role": "auctioneer"})
            assert answer(sock)["type"] == "joined"
        assert host.balances()["A"] == 0
        # Coming back to the same room is free.
        with client.websocket_connect(f"{WS}?room=PAID1", headers=host.headers) as sock:
            drain(sock, lambda m: m.get("type") == "state")

    def test_delegate_room_costs_a_blue_pass(self, client):
        delegate = person(client, "delegate")
        delegate.claim_all()
        with client.websocket_connect(f"{WS}?room=DROOM1&open=1&type=delegate", headers=delegate.headers) as sock:
            assert drain(sock, lambda m: m.get("type") == "state")["room"] == "DROOM1"
        assert delegate.balances()["D"] == 0

    def test_a_seat_costs_one_blue_pass_once(self, client):
        host, free = person(client, "auctioneer"), person(client, "member")
        host.claim_all()
        with client.websocket_connect(f"{WS}?room=SEATS9&open=1", headers=host.headers) as h:
            drain(h, lambda m: m.get("type") == "state")
            with client.websocket_connect(f"{WS}?room=SEATS9", headers=free.headers) as s:
                s.send_json({"type": "join", "role": "franchise", "team_id": 1})
                msg = answer(s)
                assert msg["type"] == "error" and "Ask your Auctioneer" in msg["message"]
            connect(host, free)
            host.post("/api/v1/passes/send", {"recipient_ids": [free.id], "kind": "D", "generate_missing": True})
            free.claim_all()
            with client.websocket_connect(f"{WS}?room=SEATS9", headers=free.headers) as s:
                s.send_json({"type": "join", "role": "franchise", "team_id": 1})
                joined = answer(s)
                assert joined["type"] == "joined" and joined["pass_spent"] is True
            assert free.balances()["D"] == 0
            # Reconnecting, even to another franchise, costs nothing more.
            with client.websocket_connect(f"{WS}?room=SEATS9", headers=free.headers) as s:
                s.send_json({"type": "join", "role": "franchise", "team_id": 2})
                again = answer(s)
                assert again["type"] == "joined" and again["pass_spent"] is False

    def test_a_refused_seat_gives_the_pass_back(self, client):
        host, a, b = person(client, "auctioneer"), person(client, "delegate"), person(client, "delegate")
        host.claim_all(); a.claim_all(); b.claim_all()
        with client.websocket_connect(f"{WS}?room=TAKEN1&open=1", headers=host.headers) as h:
            drain(h, lambda m: m.get("type") == "state")
            with client.websocket_connect(f"{WS}?room=TAKEN1", headers=a.headers) as sa, \
                 client.websocket_connect(f"{WS}?room=TAKEN1", headers=b.headers) as sb:
                sa.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert answer(sa)["type"] == "joined"
                sb.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert "already being played" in answer(sb)["message"]
                assert b.balances()["D"] == 1
                sb.send_json({"type": "join", "role": "franchise", "team_id": 2})
                assert answer(sb)["type"] == "joined"
                assert b.balances()["D"] == 0

    def test_a_room_that_never_started_is_refunded(self, client):
        host = person(client, "auctioneer")
        host.claim_all()
        with client.websocket_connect(f"{WS}?room=GHOST1&open=1", headers=host.headers) as sock:
            drain(sock, lambda m: m.get("type") == "state")  # never takes the chair
        assert host.balances()["A"] == 0
        registry.sweep(now=time.monotonic() + 3600)
        assert host.balances()["A"] == 1
        assert host.bell()["items"][0]["title"] == "Room pass refunded"

    def test_admin_rooms_are_free(self, client):
        root = person(client, "x", "root@example.test")
        with client.websocket_connect(f"{WS}?room=ROOT1&open=1", headers=root.headers) as sock:
            assert drain(sock, lambda m: m.get("type") == "state")["room"] == "ROOT1"


# --------------------------------------------------------- connections --


class TestConnections:
    def test_request_accept_and_search_hides_email(self, client):
        a, b = person(client, "auctioneer", "alpha@example.test"), person(client, "delegate", "bravo@example.test")
        found = a.get("/api/v1/connections/search", params={"q": "bravo@example.test"}).json()["results"]
        assert found and found[0]["id"] == b.id and "email" not in found[0] and found[0]["link"] == "none"
        a.post("/api/v1/connections/request", {"account_id": b.id})
        incoming = b.get("/api/v1/connections").json()["incoming"]
        assert incoming[0]["id"] == a.id
        assert b.bell()["items"][0]["kind"] == "connection"
        b.post(f"/api/v1/connections/{incoming[0]['connection_id']}/respond", {"accept": True})
        assert [f["id"] for f in a.get("/api/v1/connections").json()["friends"]] == [b.id]
        assert a.client.delete(f"/api/v1/connections/{b.id}", headers=a.headers).status_code == 200
        assert a.get("/api/v1/connections").json()["friends"] == []

    def test_broadcast_is_admin_only(self, client):
        root, host, delegate = person(client, "x", "root@example.test"), person(client, "auctioneer"), person(client, "delegate")
        assert host.post("/api/v1/notifications/broadcast", {"title": "Hi"}).status_code == 403
        r = root.post("/api/v1/notifications/broadcast", {"title": "Mega auction Friday", "roles": ["delegate"]})
        assert r.json()["sent"] >= 1
        assert delegate.bell()["items"][0]["title"] == "Mega auction Friday"
        assert host.bell()["items"][0]["kind"] == "welcome"


# ----------------------------------------------------------- SCOUT quota --


class TestScoutQuota:
    def test_free_gets_ten_in_the_window(self, client):
        free = person(client, "member")
        key = f"account:{free.id}"
        start = time.time()
        for i in range(10):
            assert quota.take(key, now=start + i)["allowed"]
        status = free.get("/api/v1/scout/quota").json()
        assert status["limited"] and status["remaining"] == 0 and status["resets_at"] == pytest.approx(start + 7200)
        refused = client.post("/api/v1/scout/advise", json={"question": "Who should I bid on?"}, headers=free.headers)
        assert refused.status_code == 429 and "10 SCOUT requests" in refused.json()["detail"]
        # The oldest frees up one window after it was made.
        assert quota.take(key, now=start + 7200.5)["allowed"]

    def test_paid_tiers_are_unlimited(self, client):
        delegate = person(client, "delegate")
        assert delegate.get("/api/v1/scout/quota").json()["limited"] is False


# -------------------------------------------------------------- AUCTEAM --


class TestAucteamGate:
    def test_only_delegates_and_admins_get_the_report(self, client):
        body = {"team_name": "XI", "player_ids": [1]}
        assert client.post("/api/v1/aucteam/report", json=body).status_code == 401
        for role in ("auctioneer", "member"):
            refused = person(client, role).post("/api/v1/aucteam/report", body)
            assert refused.status_code == 403 and "Delegate account" in refused.json()["detail"]
        # Past the gate, a one-player XI is refused by the rules instead.
        assert person(client, "delegate").post("/api/v1/aucteam/report", body).status_code == 422
        assert person(client, "x", "root@example.test").post("/api/v1/aucteam/report", body).status_code == 422
