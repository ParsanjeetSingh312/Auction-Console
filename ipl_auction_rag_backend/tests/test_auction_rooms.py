"""
test_auction_rooms.py
Several auctions at once (auction/rooms.py, auction/ws.py).

What must hold: a room code is its own auction -- its own chair, seats, lot and
broadcasts, invisible to every other room; a mini auction seats twelve and a
mega auction ten; no code still means the default room, unchanged; and opening
rooms is bounded, so made-up codes cannot pile up.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auction import rooms as rooms_module
from auction.rooms import MAIN, RoomRegistry, RoomsFull, normalise_code, registry
from auction.room import AuctionRoom
from config.settings import get_settings

PASSWORD = "rooms-test-secret"

POOL = [
    {"id": i, "player_name": f"Player {i}", "role": "Batter", "overseas": 0,
     "base_price": 50, "cap_status": "CAPPED"}
    for i in range(1, 9)
]


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(get_settings(), "AUCTIONEER_PASSWORD", PASSWORD)
    registry.set_pool(POOL)
    yield
    # Close the rooms these tests opened; MAIN stays.
    for entry in registry.entries():
        if entry.code != MAIN:
            registry._rooms.pop(entry.code, None)


def drain(sock, predicate, limit=30):
    for _ in range(limit):
        msg = sock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message never arrived")


def is_state(msg):
    return msg.get("type") == "state"


class TestCodes:
    def test_codes_are_normalised(self):
        assert normalise_code(None) == MAIN
        assert normalise_code("") == MAIN
        assert normalise_code(" k7q4mp ") == "K7Q4MP"
        assert normalise_code("MINI-1") == "MINI-1"

    def test_bad_codes_are_refused(self):
        for bad in ("-lead", "has space", "x" * 25, "semi;colon", "../etc"):
            assert normalise_code(bad) is None


class TestRegistry:
    def test_mini_seats_twelve_and_mega_ten(self):
        reg = RoomRegistry(AuctionRoom())
        reg.set_pool(POOL)
        mini = reg.open("MINI1", "mini").room
        mega = reg.open("MEGA1", "mega").room
        assert len(mini.teams) == 12 and mini.rules["max_teams"] == 12
        assert {t["code"] for t in mini.teams} >= {"KOC", "PUN"}
        assert len(mega.teams) == 10 and mega.rules["max_teams"] == 10
        assert len(mini.players) == len(POOL)

    def test_opening_is_bounded(self, monkeypatch):
        monkeypatch.setattr(rooms_module, "MAX_ROOMS", 3)
        reg = RoomRegistry(AuctionRoom())
        reg.open("A", "mega")
        reg.open("B", "mega")
        with pytest.raises(RoomsFull):
            reg.open("C", "mega")
        # An open room is still reachable at the limit.
        assert reg.open("A", "mini").kind == "mega"

    def test_idle_rooms_are_closed_but_main_never(self):
        reg = RoomRegistry(AuctionRoom())
        entry = reg.open("IDLE", "mega")
        reg.connected(entry)
        reg.disconnected(entry)
        far = entry.last_seen + rooms_module.IDLE_SECONDS + 1
        assert reg.sweep(now=far) == ["IDLE"]
        assert reg.get("IDLE") is None
        assert reg.get(MAIN) is not None

    def test_a_room_no_auctioneer_claimed_closes_sooner(self):
        reg = RoomRegistry(AuctionRoom())
        unclaimed = reg.open("DRIFT", "mega")
        claimed = reg.open("KEPT", "mega")
        claimed.claimed = True
        later = max(unclaimed.last_seen, claimed.last_seen) + rooms_module.UNCLAIMED_IDLE_SECONDS + 1
        assert reg.sweep(now=later) == ["DRIFT"]
        assert reg.get("KEPT") is not None

    def test_a_room_with_someone_in_it_is_never_swept(self):
        reg = RoomRegistry(AuctionRoom())
        entry = reg.open("BUSY", "mega")
        reg.connected(entry)
        assert reg.sweep(now=entry.last_seen + rooms_module.IDLE_SECONDS * 5) == []


class TestOverTheSocket:
    def test_two_rooms_are_two_auctions(self):
        from api.main import app

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws?room=ROOMA&kind=mega") as host_a, \
                 client.websocket_connect("/api/v1/auction/ws?room=ROOMB&kind=mini") as host_b, \
                 client.websocket_connect("/api/v1/auction/ws?room=ROOMA") as mum_a, \
                 client.websocket_connect("/api/v1/auction/ws?room=ROOMB&kind=mini") as mum_b:
                first_a = drain(host_a, is_state)
                first_b = drain(host_b, is_state)
                assert first_a["room"] == "ROOMA" and len(first_a["teams"]) == 10
                assert first_b["room"] == "ROOMB" and len(first_b["teams"]) == 12

                # Both chairs can be taken: they are different rooms.
                host_a.send_json({"type": "join", "role": "auctioneer", "password": PASSWORD})
                host_b.send_json({"type": "join", "role": "auctioneer", "password": PASSWORD})
                assert drain(host_a, lambda m: m.get("type") in ("joined", "error"))["type"] == "joined"
                assert drain(host_b, lambda m: m.get("type") in ("joined", "error"))["type"] == "joined"

                # Mumbai can be played in both rooms at once.
                mum_a.send_json({"type": "join", "role": "franchise", "team_id": 1})
                mum_b.send_json({"type": "join", "role": "franchise", "team_id": 1})
                assert drain(mum_a, lambda m: m.get("type") in ("joined", "error"))["type"] == "joined"
                assert drain(mum_b, lambda m: m.get("type") in ("joined", "error"))["type"] == "joined"

                # A change in room A reaches room A only.
                host_a.send_json({"type": "set_rules", "purse": 7500, "max_squad": 21,
                                  "min_squad": 16, "max_overseas": 6, "min_overseas": 3})
                assert drain(mum_a, lambda m: is_state(m) and m["rules"]["purse"] == 7500)
                host_b.send_json({"type": "ping"})
                assert drain(host_b, lambda m: m.get("type") == "pong")
                assert client.get("/api/v1/auction/state?room=ROOMB").json()["rules"]["purse"] != 7500
                assert client.get("/api/v1/auction/state?room=ROOMA").json()["rules"]["purse"] == 7500

    def test_a_created_room_seats_twelve(self):
        from api.main import app

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws?room=MADE1&open=1") as host,                  client.websocket_connect("/api/v1/auction/ws?room=MADE1") as franchise:
                assert len(drain(host, is_state)["teams"]) == 12
                # Joining by the code alone reaches the same room.
                assert drain(franchise, is_state)["room"] == "MADE1"

    def test_mini_room_seats_a_twelfth_franchise(self):
        from api.main import app

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws?room=MINIX&kind=mini") as pune:
                drain(pune, is_state)
                pune.send_json({"type": "join", "role": "franchise", "team_id": 12})
                joined = drain(pune, lambda m: m.get("type") in ("joined", "error"))
                assert joined["type"] == "joined" and joined["seat"]["team_code"] == "PUN"

    def test_no_code_is_the_default_room(self):
        from api.main import app

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws") as sock:
                state = drain(sock, is_state)
                assert state["room"] == MAIN and len(state["teams"]) == 10

    def test_a_bad_code_is_refused_with_a_reason(self):
        from starlette.websockets import WebSocketDisconnect

        from api.main import app

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws?room=no%20spaces") as sock:
                assert sock.receive_json()["about"] == "room"
                with pytest.raises(WebSocketDisconnect) as closed:
                    sock.receive_json()
                assert closed.value.code == 4400

    def test_joining_a_code_nobody_opened_is_refused(self):
        from starlette.websockets import WebSocketDisconnect

        from api.main import app

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws?room=NOTOPENED") as sock:
                refusal = sock.receive_json()
                assert refusal["about"] == "room" and "No auction room" in refusal["message"]
                # The code is not repeated back: it is never shown on the site.
                assert "NOTOPENED" not in refusal["message"]
                with pytest.raises(WebSocketDisconnect) as closed:
                    sock.receive_json()
                assert closed.value.code == 4404
            assert registry.get("NOTOPENED") is None

    def test_rest_reads_name_their_room(self):
        from api.main import app

        with TestClient(app) as client:
            assert client.get("/api/v1/auction/state?room=NOSUCHROOM").status_code == 404
            assert client.get("/api/v1/auction/report?room=NOSUCHROOM").status_code == 404
            stats = client.get("/api/v1/auction/rooms/stats").json()
            assert stats["rooms_open"] >= 1 and "connections" in stats
