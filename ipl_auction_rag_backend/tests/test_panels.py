"""
test_panels.py
The admin panel, the auctioneer's schedule, and the waiting room's start gate
(auctoniq-panels-plan.md).

What must hold:

- only administrators see the admin overview, and it counts real activity;
- only auctioneers (and admins) schedule, an entry belongs to its owner, and
  the schedule works with Google Calendar not configured at all;
- an auction with invited delegates cannot start until every one of them has
  claimed, taken a seat and acknowledged the rules -- and the last
  acknowledgement, in an open waiting room, starts it;
- an invitee whose pass expired, or who was removed, no longer holds it up.
"""
from __future__ import annotations

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from accounts import activity, invites, passes, store
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
    monkeypatch.setattr(get_settings(), "ADMIN_EMAILS", "boss@example.test")
    monkeypatch.setattr(get_settings(), "GOOGLE_CLIENT_ID", "")
    monkeypatch.setattr(get_settings(), "GOOGLE_CLIENT_SECRET", "")
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


def register(client, role, email=None):
    email = email or f"{role}-{uuid.uuid4().hex}@example.test"
    response = client.post(
        "/api/v1/accounts/register",
        json={"name": f"{role.title()} {email[:6]}", "email": email, "password": "long-enough-pw", "role": role},
    )
    assert response.status_code == 200, response.text
    token = response.cookies.get(COOKIE)
    client.cookies.clear()
    return token


def make_admin(client) -> str:
    """The admin's account is made by the server, never registered: make it directly."""
    from accounts.passwords import hash_password

    account = store.create_account("boss@example.test", "Boss", "auctioneer", hash_password("long-enough-pw"))
    return store.open_session(account.id)


def headers(token):
    return {"cookie": f"{COOKIE}={token}"}


def drain(sock, predicate, limit=40):
    for _ in range(limit):
        msg = sock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message never arrived")


def answer(sock):
    return drain(sock, lambda m: m.get("type") in ("joined", "error"))


# ------------------------------------------------------------- admin --


class TestAdminOverview:
    def test_only_admins(self, client):
        auctioneer = register(client, "auctioneer")
        assert client.get("/api/v1/admin/overview", headers=headers(auctioneer)).status_code == 403
        assert client.get("/api/v1/admin/overview").status_code == 401

    def test_counts_accounts_passes_and_auctions(self, client):
        admin = make_admin(client)
        register(client, "auctioneer")
        register(client, "delegate")
        activity.record("opened", "ROOM01", owner_id=1, teams=12)
        activity.record("started", "ROOM01", owner_id=1)
        activity.record("finished", "ROOM01", owner_id=1)
        activity.record("started", "OLD001", at=time.time() - 40 * 24 * 3600)

        data = client.get("/api/v1/admin/overview?days=7", headers=headers(admin)).json()
        assert data["accounts"]["admin"] == 1
        assert data["accounts"]["auctioneer"] == 1 and data["accounts"]["delegate"] == 1
        assert data["auctions"]["window"] == {"opened": 1, "started": 1, "finished": 1}
        assert data["auctions"]["all_time"]["started"] == 2
        assert len(data["auctions"]["per_day"]) == 7
        assert data["auctions"]["per_day"][-1]["started"] == 1
        # Registration's welcome gifts are passes sent and waiting.
        assert data["passes"]["window"]["sent"]["D"] >= 1


# ----------------------------------------------------------- schedule --


class TestSchedule:
    def test_auctioneers_schedule_delegates_do_not(self, client):
        delegate = register(client, "delegate")
        r = client.post("/api/v1/schedule", headers=headers(delegate),
                        json={"title": "Mine", "starts_at": time.time() + 3600})
        assert r.status_code == 403

    def test_create_list_update_delete_without_google(self, client):
        owner = register(client, "auctioneer")
        start = time.time() + 2 * 24 * 3600
        made = client.post("/api/v1/schedule", headers=headers(owner),
                           json={"title": "  Mega   auction ", "starts_at": start, "duration_min": 90}).json()
        assert made["entry"]["title"] == "Mega auction"
        assert made["sync"]["state"] == "off"  # Google not configured: saved here only

        listing = client.get("/api/v1/schedule", headers=headers(owner)).json()
        assert [e["title"] for e in listing["entries"]] == ["Mega auction"]
        assert listing["google"] == {"configured": False, "connected": False, "email": None, "linked_at": None}

        entry_id = made["entry"]["id"]
        changed = client.patch(f"/api/v1/schedule/{entry_id}", headers=headers(owner), json={"title": "Mini auction"}).json()
        assert changed["entry"]["title"] == "Mini auction" and changed["entry"]["duration_min"] == 90

        assert client.delete(f"/api/v1/schedule/{entry_id}", headers=headers(owner)).json()["ok"] is True
        assert client.get("/api/v1/schedule", headers=headers(owner)).json()["entries"] == []

    def test_entries_belong_to_their_owner(self, client):
        owner = register(client, "auctioneer")
        other = register(client, "auctioneer")
        entry = client.post("/api/v1/schedule", headers=headers(owner),
                            json={"title": "Mine", "starts_at": time.time() + 3600}).json()["entry"]
        r = client.patch(f"/api/v1/schedule/{entry['id']}", headers=headers(other), json={"title": "Stolen"})
        assert r.status_code == 400 and "not on your schedule" in r.json()["detail"]

    def test_past_times_are_refused(self, client):
        owner = register(client, "auctioneer")
        r = client.post("/api/v1/schedule", headers=headers(owner),
                        json={"title": "Yesterday", "starts_at": time.time() - 24 * 3600})
        assert r.status_code == 400 and "passed" in r.json()["detail"]

    def test_connect_explains_when_google_is_not_set_up(self, client):
        owner = register(client, "auctioneer")
        r = client.get("/api/v1/schedule/google/connect", headers=headers(owner), follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"].startswith("/account?google=error")

    def test_auctioneer_overview_counts_delegate_passes(self, client):
        owner_token = register(client, "auctioneer")
        owner = store.account_for_session(owner_token)
        delegate = store.account_for_session(register(client, "delegate"))
        with store._connect() as conn:  # connect them, so a pass may be sent
            low, high = sorted((owner.id, delegate.id))
            conn.execute(
                "INSERT INTO connections (requester_id, addressee_id, low_id, high_id, status, created_at) "
                "VALUES (?, ?, ?, ?, 'accepted', ?)", (owner.id, delegate.id, low, high, time.time()))
        passes.send(owner, [delegate.id], "D", 2, generate_missing=True)
        data = client.get("/api/v1/auctioneer/overview", headers=headers(owner_token)).json()
        assert data["given"]["all_time"]["sent"]["D"] == 2
        assert data["given"]["all_time"]["pending"]["D"] == 2
        assert data["recipients"][0]["name"] == delegate.name


# ------------------------------------------------------- waiting room --


class TestStartGate:
    def test_invitees_must_sit_and_acknowledge_before_the_start(self, client):
        owner_token = register(client, "auctioneer")
        owner = store.account_for_session(owner_token)
        delegate_token = register(client, "delegate")
        delegate = store.account_for_session(delegate_token)

        with client.websocket_connect("/api/v1/auction/ws?room=GATE01&open=1", headers=headers(owner_token)) as host:
            drain(host, lambda m: m.get("type") == "state")
            host.send_json({"type": "join", "role": "auctioneer"})
            assert answer(host)["type"] == "joined"
            room = registry.get("GATE01").room

            # Invite the delegate to this room.
            gift = passes.grant(delegate.id, "D", 1, "A seat", "For GATE01")
            invites.record(room.code, room.instance, owner.id, [(delegate.id, gift)])
            assert invites.status(room)[0]["state"] == "sent"

            # Not yet: the delegate has not even claimed.
            host.send_json({"type": "start_auction"})
            refusal = drain(host, lambda m: m.get("type") == "error")
            assert "Waiting for your delegates" in refusal["message"]

            # Open the waiting room, then the delegate claims, sits, acknowledges.
            host.send_json({"type": "open_waiting_room", "countdown_seconds": 600})
            drain(host, lambda m: m.get("type") == "state" and m.get("phase") == "waiting")
            passes.claim(delegate, gift)
            assert invites.status(room)[0]["state"] == "claimed"

            with client.websocket_connect("/api/v1/auction/ws?room=GATE01", headers=headers(delegate_token)) as seat:
                drain(seat, lambda m: m.get("type") == "state")
                seat.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert answer(seat)["type"] == "joined"
                assert invites.status(room)[0]["state"] == "seated"
                assert room.phase == "waiting"

                # The last acknowledgement starts the auction for everyone.
                seat.send_json({"type": "acknowledge_rules", "rules_version": room.rules_version})
                drain(seat, lambda m: m.get("type") == "state" and m.get("phase") == "live")
                assert room.phase == "live"
                assert invites.blockers(room) == []

    def test_removed_and_expired_invitees_do_not_hold_up_the_start(self, client):
        owner_token = register(client, "auctioneer")
        owner = store.account_for_session(owner_token)
        a = store.account_for_session(register(client, "delegate"))
        b = store.account_for_session(register(client, "delegate"))
        with client.websocket_connect("/api/v1/auction/ws?room=GATE02&open=1", headers=headers(owner_token)) as host:
            drain(host, lambda m: m.get("type") == "state")
            host.send_json({"type": "join", "role": "auctioneer"})
            answer(host)
            room = registry.get("GATE02").room
            gift_a = passes.grant(a.id, "D", 1, "A seat", "")
            gift_b = passes.grant(b.id, "D", 1, "A seat", "")
            invites.record(room.code, room.instance, owner.id, [(a.id, gift_a), (b.id, gift_b)])
            assert len(invites.blockers(room)) == 2

            # One is taken off the list, the other's pass expires unclaimed.
            assert invites.remove(room, a.id)
            with store._connect() as conn:
                conn.execute("UPDATE pass_gifts SET expires_at = 0 WHERE id = ?", (gift_b,))
            passes.expire_due()
            assert invites.blockers(room) == []

            host.send_json({"type": "start_auction"})
            drain(host, lambda m: m.get("type") == "state" and m.get("phase") == "live")

    def test_waiting_room_endpoint_is_the_owners(self, client):
        owner_token = register(client, "auctioneer")
        other = register(client, "auctioneer")
        with client.websocket_connect("/api/v1/auction/ws?room=GATE03&open=1", headers=headers(owner_token)) as host:
            drain(host, lambda m: m.get("type") == "state")
            ok = client.get("/api/v1/rooms/GATE03/waiting", headers=headers(owner_token))
            assert ok.status_code == 200 and ok.json()["ready"] is True
            assert client.get("/api/v1/rooms/GATE03/waiting", headers=headers(other)).status_code == 403
