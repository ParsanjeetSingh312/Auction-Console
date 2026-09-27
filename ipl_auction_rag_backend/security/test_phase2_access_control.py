"""
test_phase2_access_control.py
Phase 2 -- access control, as it actually works.

The brief wanted "JWT token swapping & RBAC bypass". There is no JWT, no login,
no session, no token anywhere in AUCTIQ -- so there is nothing to swap. Identity
is the WebSocket connection itself: a seat is assigned at join time and held
server-side, keyed by connection, and every client message is attributed to that
seat rather than to anything the frame claims (`auction/schemas.py`,
`auction/room.py`).

So this phase attacks the access model that is really there:

  * **Seat RBAC** -- privileged actions go through `_require_auctioneer` /
    `_require_franchise`, and a franchise, an auctioneer acting out of role, or an
    unseated connection must all be refused. Tested at the room and over a live
    socket, because a gate that holds in the object but not on the wire is not a
    gate.
  * **Identity cannot be forged** -- the client messages carry no actor field,
    and `extra="forbid"` means one cannot be smuggled in.
  * **Franchise isolation** -- one seat per franchise, one auctioneer's chair.
  * **The column mask is presentation, not a boundary** -- `useViewerRole.ts`
    says so itself, and this proves it: the server hands full market data to an
    unauthenticated caller. That is a finding to state, not a control to trust.
  * **CORS + the unauthenticated surface** -- `allow_origins=["*"]` with
    `allow_credentials=True` is a real misconfiguration, and every endpoint is
    reachable with no credentials at all.
"""
from __future__ import annotations

import pytest

from auction.room import RoomError
from harness.staging import AUCTIONEER_TEST_PASSWORD

pytestmark = pytest.mark.access_control


# ---------------------------------------------------------------------------
# Seat RBAC, at the room
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestSeatRBAC:
    """Privileged actions are refused to anyone not holding the right seat."""

    async def test_franchise_is_refused_every_auctioneer_action(self, room):
        await room.join("auc", "auctioneer", None, "Auc", AUCTIONEER_TEST_PASSWORD)
        await room.start_auction("auc")
        await room.join("f1", "franchise", 1, "F1")

        # Every auctioneer-only entry point, called by a franchise. Factories, not
        # coroutines, so an unawaited one never leaks a warning.
        auctioneer_only = {
            "put_up": lambda: room.put_up("f1", 1),
            "sell": lambda: room.sell("f1"),
            "mark_unsold": lambda: room.mark_unsold("f1"),
            "undo": lambda: room.undo("f1"),
            "finish": lambda: room.finish("f1"),
            "reset": lambda: room.reset("f1"),
            "open_waiting_room": lambda: room.open_waiting_room("f1", 60),
            "start_auction": lambda: room.start_auction("f1"),
        }
        for name, make in auctioneer_only.items():
            with pytest.raises(RoomError) as excinfo:
                await make()
            assert "auctioneer" in excinfo.value.message.lower(), name

    async def test_auctioneer_cannot_bid(self, room):
        """RBAC cuts both ways: the chair runs the room, it does not bid in it."""
        await room.join("auc", "auctioneer", None, "Auc", AUCTIONEER_TEST_PASSWORD)
        await room.start_auction("auc")
        await room.put_up("auc", 1)

        with pytest.raises(RoomError) as excinfo:
            await room.bid("auc", None, None)
        assert "franchise" in excinfo.value.message.lower()

    async def test_unseated_connection_can_do_nothing(self, room):
        """A connection that never joined has no seat, so it has no authority."""
        for make in (lambda: room.sell("ghost"), lambda: room.bid("ghost", None, None)):
            with pytest.raises(RoomError) as excinfo:
                await make()
            assert "join" in excinfo.value.message.lower()


# ---------------------------------------------------------------------------
# Franchise isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestFranchiseIsolation:
    """One seat per franchise, one auctioneer, and only real teams."""

    async def test_two_clients_cannot_hold_one_franchise(self, room):
        await room.join("f1a", "franchise", 1, "First")
        with pytest.raises(RoomError) as excinfo:
            await room.join("f1b", "franchise", 1, "Second")
        assert "already being played" in excinfo.value.message.lower()

    async def test_auctioneer_chair_is_single_occupancy(self, room):
        await room.join("a1", "auctioneer", None, "First", AUCTIONEER_TEST_PASSWORD)
        with pytest.raises(RoomError) as excinfo:
            await room.join("a2", "auctioneer", None, "Second", AUCTIONEER_TEST_PASSWORD)
        assert "already taken" in excinfo.value.message.lower()

    async def test_a_nonexistent_team_is_refused(self, room):
        """Team 50 is inside the schema's range but is not a real franchise."""
        with pytest.raises(RoomError) as excinfo:
            await room.join("f", "franchise", 50, "Nobody")
        assert "exists" in excinfo.value.message.lower()


# ---------------------------------------------------------------------------
# Identity cannot be forged
# ---------------------------------------------------------------------------


def test_a_bid_frame_cannot_carry_an_actor_field():
    """
    The schema is the whole defence against "bid as someone else": there is no
    field for whose bid it is, and `extra="forbid"` refuses one that is smuggled
    in. This is exactly the frame `auction/schemas.py` names as the attack it
    stops.
    """
    from pydantic import TypeAdapter, ValidationError

    from auction.schemas import ClientMessage

    adapter = TypeAdapter(ClientMessage)
    for forged in (
        {"type": "bid", "amount": 100, "role": "auctioneer"},
        {"type": "bid", "amount": 100, "team_id": 2},
        {"type": "timeout", "team_id": 3},
    ):
        with pytest.raises(ValidationError):
            adapter.validate_python(forged)


# ---------------------------------------------------------------------------
# Seat RBAC, over the live socket
#
# TestClient is synchronous -- it drives the async app through a portal -- so
# these read as plain functions. The `ws_client` fixture resets the shared
# auction room to a clean lobby first, because that room is a process singleton
# and a previous test's phase would otherwise leak into this one.
# ---------------------------------------------------------------------------


@pytest.fixture
def ws_client(staging_client):
    from auction.room import Record, room

    room.seats.clear()
    room.phase = "lobby"
    room.lot = None
    room.log.clear()
    room.seq = 0
    room.undo_stack.clear()
    room.countdown_ends_at = None
    for pid in list(room.records):
        room.records[pid] = Record()
    room._refill_timeouts()
    return staging_client


class TestSeatRBACOverTheSocket:
    WS = "/api/v1/auction/ws"

    def test_unseated_socket_is_told_to_join(self, ws_client):
        with ws_client.websocket_connect(self.WS) as ws:
            ws.receive_json()  # the initial state pushed on connect
            ws.send_json({"type": "sell"})
            error = ws.receive_json()
        assert error["type"] == "error"
        assert "join" in error["message"].lower()

    def test_franchise_socket_cannot_sell(self, ws_client):
        with ws_client.websocket_connect(self.WS) as ws:
            ws.receive_json()  # initial state
            ws.send_json({"type": "join", "role": "franchise", "team_id": 1})
            assert ws.receive_json()["type"] == "joined"
            ws.receive_json()  # the state broadcast that follows a join
            ws.send_json({"type": "sell"})
            error = ws.receive_json()
        assert error["type"] == "error"
        assert "auctioneer" in error["message"].lower()

    def test_forged_actor_field_is_rejected_on_the_wire(self, ws_client):
        """The schema's `extra="forbid"` refuses a smuggled role, over the socket."""
        with ws_client.websocket_connect(self.WS) as ws:
            ws.receive_json()  # initial state
            ws.send_json({"type": "bid", "amount": 100, "role": "auctioneer"})
            error = ws.receive_json()
        assert error["type"] == "error"
        assert error["about"] == "validation"


# ---------------------------------------------------------------------------
# The column mask is client-side only
# ---------------------------------------------------------------------------


class TestColumnMaskIsClientSideOnly:
    """
    `useViewerRole.ts` masks the STATUS/PRICE columns from a participant, and says
    outright it is "presentation, not security" -- the data is already in the
    client from GET /api/v1/players. This confirms the server side of that claim:
    the market data is served to anyone, with no authentication, so the mask is a
    UI convenience and not an access-control boundary.
    """

    def test_market_data_is_served_without_authentication(self, staging_client):
        response = staging_client.get("/api/v1/players")
        assert response.status_code == 200

        players = response.json()["players"]
        # base_price and rating are the "market data" the participant view hides.
        assert any(p.get("base_price") is not None for p in players)
        assert any(p.get("rating") is not None for p in players)

    def test_live_room_state_is_served_without_authentication(self, staging_client):
        """The socket's read-only twin exposes the same auction state to anyone."""
        assert staging_client.get("/api/v1/auction/state").status_code == 200


# ---------------------------------------------------------------------------
# CORS and the unauthenticated surface
# ---------------------------------------------------------------------------


class TestCorsIsLockedDown:
    """
    CORS is now restricted to the origins in CORS_ORIGINS -- the old
    `allow_origins=[...] + ["*"]` with credentials is gone. These verify the lock
    holds: an arbitrary origin is not reflected, a configured one is. The read
    endpoints stay intentionally open (a spectator's screen needs them), which is
    documented rather than treated as a fault.
    """

    #: Present in the default CORS_ORIGINS the test environment runs under. See
    #: config/settings.py.
    ALLOWED_ORIGIN = "http://localhost:5173"

    def test_arbitrary_origin_is_not_reflected(self, staging_client):
        response = staging_client.get(
            "/api/v1/auction/state",
            headers={"Origin": "https://evil.example"},
        )
        allow_origin = response.headers.get("access-control-allow-origin")
        assert allow_origin != "https://evil.example"
        assert allow_origin != "*"

    def test_preflight_rejects_an_arbitrary_origin(self, staging_client):
        response = staging_client.options(
            "/api/v1/players",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        allow_origin = response.headers.get("access-control-allow-origin")
        assert allow_origin != "https://evil.example"
        assert allow_origin != "*"

    def test_a_configured_origin_is_allowed(self, staging_client):
        response = staging_client.get(
            "/api/v1/auction/state",
            headers={"Origin": self.ALLOWED_ORIGIN},
        )
        assert response.headers.get("access-control-allow-origin") == self.ALLOWED_ORIGIN

    def test_read_endpoints_need_no_authentication(self, staging_client):
        """Every read is intentionally open -- spectator screens need them."""
        for path in ("/api/v1/auction/state", "/api/v1/auction/report"):
            assert staging_client.get(path).status_code == 200
