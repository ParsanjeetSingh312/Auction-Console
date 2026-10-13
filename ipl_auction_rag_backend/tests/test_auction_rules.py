"""
The seven non-negotiable guidelines and the Auction Setup, against a real room.

One class per guideline, in the order they are written, so a failure names the
rule that broke. Each test drives `AuctionRoom` directly -- the same object the
WebSocket handler calls -- with short clock durations where a timer is under
test, so the suite stays fast without faking time.
"""
from __future__ import annotations

import asyncio

import pytest

from auction.room import AuctionRoom, RoomError
from config.settings import get_settings

PASSWORD = "rules-test-secret"

POOL = [
    {"id": 1, "player_name": "Capped Opener", "role": "Batter", "overseas": 0,
     "base_price": 200, "cap_status": "CAPPED"},
    {"id": 2, "player_name": "Overseas Quick", "role": "Bowler", "overseas": 1,
     "base_price": 150, "cap_status": "CAPPED"},
    {"id": 3, "player_name": "Uncapped Spinner", "role": "Bowler", "overseas": 0,
     "base_price": 30, "cap_status": "UNCAPPED"},
    {"id": 4, "player_name": "Capped Keeper", "role": "Wicket Keeper", "overseas": 0,
     "base_price": 100, "cap_status": "CAPPED"},
    {"id": 5, "player_name": "Overseas Allrounder", "role": "All-Rounder", "overseas": 1,
     "base_price": 50, "cap_status": "CAPPED"},
]


@pytest.fixture(autouse=True)
def _password(monkeypatch):
    monkeypatch.setattr(get_settings(), "AUCTIONEER_PASSWORD", PASSWORD)


def run(coro):
    return asyncio.run(coro)


async def live_room(teams=(1, 2, 3), *, ack=True, player=1, fast=False) -> AuctionRoom:
    """A live room with an auctioneer, `teams` seated and `player` on the block."""
    room = AuctionRoom()
    room.load_players([dict(p) for p in POOL])
    if fast:
        room.rules.update(open_seconds=0.15, close_seconds=0.15, timeout_seconds=0.3)
    await room.join("host", "auctioneer", None, "Host", PASSWORD)
    for t in teams:
        await room.join(f"c{t}", "franchise", t, f"T{t}")
        if ack:
            await room.acknowledge_rules(f"c{t}", room.rules_version)
    await room.start_auction("host")
    if player:
        await room.put_up("host", player)
    return room


# --------------------------------------------------------------------- #
# 1. Room limit
# --------------------------------------------------------------------- #


class TestRoomLimit:
    def test_ten_franchises_seat_and_the_room_caps_there(self):
        async def go():
            room = AuctionRoom()
            assert room.rules["max_teams"] == 10
            assert len(room.teams) <= 10
            for t in range(1, 11):
                await room.join(f"c{t}", "franchise", t, None)
            assert sum(1 for s in room.seats.values() if s.role == "franchise") == 10
            # There is no eleventh franchise to claim, and lowering the cap
            # proves the seat count -- not the team list -- is what is enforced.
            room.rules["max_teams"] = 9
            with pytest.raises(RoomError, match="room is full"):
                await room.join("late", "franchise", 10, None)
        run(go())


# --------------------------------------------------------------------- #
# 2. Uniformity
# --------------------------------------------------------------------- #


class TestUniformity:
    def test_one_setup_change_reaches_every_franchise(self):
        async def go():
            room = await live_room(player=None)
            await room.set_rules("host", purse=5000, max_squad=20, min_squad=12, max_overseas=6)
            state = room.state_payload()
            assert {t["left"] for t in state["teams"]} == {5000}
            assert state["rules"]["max_squad"] == 20
        run(go())


# --------------------------------------------------------------------- #
# 3. Action timer: 7 seconds
# --------------------------------------------------------------------- #


class TestActionTimer:
    def test_default_windows_are_seven_seconds(self):
        room = AuctionRoom()
        assert room.rules["open_seconds"] == 7 and room.rules["close_seconds"] == 7

    def test_no_bid_in_the_window_goes_unsold(self):
        async def go():
            room = await live_room(fast=True)
            assert room.lot.clock == "opening"
            await asyncio.sleep(0.3)
            assert room.lot is None
            assert room.records[1].status == "unsold"
        run(go())

    def test_a_standing_bid_sells_when_the_window_lapses(self):
        async def go():
            room = await live_room(fast=True)
            await room.bid("c1")
            assert room.lot.clock == "closing"
            await asyncio.sleep(0.3)
            assert room.records[1].status == "sold" and room.records[1].team_id == 1
        run(go())


# --------------------------------------------------------------------- #
# 4. Bidding increments
# --------------------------------------------------------------------- #


class TestIncrements:
    def test_standard_bid_adds_a_quarter_crore(self):
        async def go():
            room = await live_room()
            assert await room.bid("c1") == 200  # opening bid pays the base
            assert await room.bid("c2") == 225  # +0.25 Cr
            assert await room.bid("c1") == 250
        run(go())

    def test_jump_shortcuts_and_custom_jumps(self):
        async def go():
            room = await live_room()
            await room.bid("c1")
            assert room.state_payload()["lot"]["jump_options"] == [700, 1200, 1700]
            assert await room.bid("c2", 700) == 700  # +5 Cr
            assert await room.bid("c1", 2700) == 2700  # custom, above +15 Cr
        run(go())

    def test_off_ladder_and_under_ask_jumps_are_refused(self):
        async def go():
            room = await live_room()
            await room.bid("c1")
            with pytest.raises(RoomError, match="off the ladder"):
                await room.bid("c2", 240)
            with pytest.raises(RoomError, match="at least the ask"):
                await room.bid("c2", 200)
        run(go())


# --------------------------------------------------------------------- #
# 5. Decision buffer: 30 seconds
# --------------------------------------------------------------------- #


class TestDecisionBuffer:
    def test_buffer_pauses_the_timer_and_settles_to_the_last_bid(self):
        async def go():
            room = await live_room(fast=True)
            await room.bid("c1")
            await room.call_timeout("c2")
            assert room.lot.clock == "timeout" and room.lot.timeout_by == 2
            await asyncio.sleep(0.2)  # past the 0.15s window, inside the buffer
            assert room.lot is not None, "the standard timer must be paused"
            await asyncio.sleep(0.3)
            assert room.records[1].status == "sold" and room.records[1].team_id == 1
        run(go())

    def test_buffer_before_any_bid_lapses_unsold(self):
        async def go():
            room = await live_room(fast=True)
            await room.call_timeout("c1")
            await asyncio.sleep(0.5)
            assert room.records[1].status == "unsold"
        run(go())

    def test_a_bid_ends_the_buffer_and_restarts_the_window(self):
        async def go():
            room = await live_room()
            await room.bid("c1")
            await room.call_timeout("c2")
            await room.bid("c2")
            assert room.lot.clock == "closing" and room.lot.timeout_by is None
        run(go())

    def test_leader_cannot_buffer_and_buffers_cannot_stack(self):
        async def go():
            room = await live_room()
            await room.bid("c1")
            with pytest.raises(RoomError, match="hold the bid"):
                await room.call_timeout("c1")
            await room.call_timeout("c2")
            with pytest.raises(RoomError, match="already has the room held"):
                await room.call_timeout("c3")
            assert room.timeouts_left(3) == 3, "a refused buffer must not be charged"
        run(go())

    def test_three_buffers_per_franchise(self):
        async def go():
            room = await live_room()
            room.timeouts[2] = 0
            await room.bid("c1")
            with pytest.raises(RoomError, match="No timeouts left"):
                await room.call_timeout("c2")
        run(go())


# --------------------------------------------------------------------- #
# 6. Fold / withdraw
# --------------------------------------------------------------------- #


class TestFold:
    def test_folded_franchise_cannot_bid_again(self):
        async def go():
            room = await live_room()
            await room.withdraw("c2")  # folding without ever bidding is allowed
            with pytest.raises(RoomError, match="withdrew"):
                await room.bid("c2")
            await room.bid("c1")  # the others carry on
            assert room.lot.bidder_id == 1
        run(go())

    def test_last_rival_folding_sells_to_the_leader(self):
        async def go():
            room = await live_room()
            await room.bid("c1")
            await room.withdraw("c2")
            assert room.lot is not None, "c3 has not folded yet"
            await room.withdraw("c3")
            assert room.records[1].status == "sold" and room.records[1].team_id == 1
        run(go())

    def test_everyone_folding_with_no_bid_goes_unsold(self):
        async def go():
            room = await live_room(teams=(1, 2))
            await room.withdraw("c1")
            await room.withdraw("c2")
            assert room.records[1].status == "unsold"
        run(go())

    def test_leader_cannot_fold(self):
        async def go():
            room = await live_room()
            await room.bid("c1")
            with pytest.raises(RoomError, match="hold the bid"):
                await room.withdraw("c1")
        run(go())


# --------------------------------------------------------------------- #
# 7. Mandatory briefing
# --------------------------------------------------------------------- #


class TestBriefing:
    def test_unbriefed_franchise_cannot_act(self):
        async def go():
            room = await live_room(ack=False)
            for action in (room.bid, room.withdraw, room.call_timeout):
                with pytest.raises(RoomError) as exc:
                    await action("c1")
                assert exc.value.about == "briefing"
            await room.acknowledge_rules("c1", room.rules_version)
            assert await room.bid("c1") == 200
        run(go())

    def test_rule_change_requires_a_fresh_acknowledgement(self):
        async def go():
            room = await live_room(player=None)
            old = room.rules_version
            await room.set_rules("host", purse=9000, max_squad=25, min_squad=18, max_overseas=8)
            assert room.rules_version == old + 1
            assert not any(t["acknowledged"] for t in room.state_payload()["teams"])
            with pytest.raises(RoomError, match="rules changed"):
                await room.acknowledge_rules("c1", old)  # stale version refused
            await room.acknowledge_rules("c1", room.rules_version)
            await room.put_up("host", 1)
            assert await room.bid("c1") == 200
        run(go())

    def test_briefing_quotes_the_enforced_numbers(self):
        room = AuctionRoom()
        text = " ".join(item["body"] for item in room.state_payload()["briefing"])
        assert "₹120.00 Cr" in text and "at least 4" in text and "1 uncapped" in text


# --------------------------------------------------------------------- #
# Squad requirements: minimum overseas and the uncapped player
# --------------------------------------------------------------------- #


class TestSquadRequirements:
    def test_places_are_kept_for_overseas_and_uncapped_minimums(self):
        async def go():
            room = await live_room(player=None)
            # A squad cap of 5 with 4 overseas and 1 uncapped required leaves no
            # place for a capped local player.
            await room.set_rules("host", purse=12000, max_squad=5, min_squad=5, max_overseas=5, min_overseas=4)
            for t in (1, 2, 3):
                await room.acknowledge_rules(f"c{t}", room.rules_version)
            await room.put_up("host", 1)  # capped, local
            with pytest.raises(RoomError, match="keep squad places"):
                await room.bid("c1")
            await room.mark_unsold("host")
            await room.put_up("host", 2)  # overseas: pays down the obligation
            assert await room.bid("c1") == 150
        run(go())


# --------------------------------------------------------------------- #
# Auction Setup
# --------------------------------------------------------------------- #


class TestSetup:
    def test_all_setup_fields_apply(self):
        async def go():
            room = await live_room(player=None)
            await room.set_rules(
                "host", purse=8000, max_squad=22, min_squad=15,
                max_overseas=7, max_players=3, min_overseas=3,
            )
            r = room.rules
            assert (r["purse"], r["max_squad"], r["min_squad"], r["max_overseas"],
                    r["max_players"], r["min_overseas"]) == (8000, 22, 15, 7, 3, 3)
        run(go())

    def test_inconsistent_setups_are_refused(self):
        async def go():
            room = await live_room(player=None)
            with pytest.raises(RoomError, match="cannot exceed the Total Squad"):
                await room.set_rules("host", purse=9000, max_squad=10, min_squad=12, max_overseas=4)
            with pytest.raises(RoomError, match="Minimum overseas"):
                await room.set_rules("host", purse=9000, max_squad=20, min_squad=12,
                                     max_overseas=3, min_overseas=4)
        run(go())

    def test_rules_cannot_change_while_a_player_is_up(self):
        async def go():
            room = await live_room()
            with pytest.raises(RoomError, match="Settle the player"):
                await room.set_rules("host", purse=9000, max_squad=25, min_squad=18, max_overseas=8)
        run(go())

    def test_franchise_cannot_change_rules(self):
        async def go():
            room = await live_room(player=None)
            with pytest.raises(RoomError, match="Only the auctioneer"):
                await room.set_rules("c1", purse=1, max_squad=25, min_squad=18, max_overseas=8)
        run(go())

    def test_maximum_players_is_the_lot_limit(self):
        async def go():
            room = await live_room(player=None)
            await room.set_rules("host", purse=12000, max_squad=25, min_squad=18,
                                 max_overseas=8, max_players=1)
            await room.put_up("host", 1)
            await room.mark_unsold("host")
            with pytest.raises(RoomError, match="lot limit"):
                await room.put_up("host", 2)
        run(go())


# --------------------------------------------------------------------- #
# Propagation over the real WebSocket
# --------------------------------------------------------------------- #


class TestPropagation:
    def test_host_change_reaches_every_connected_client(self, monkeypatch):
        from fastapi.testclient import TestClient

        from api.main import app
        from auction import ws

        fresh = AuctionRoom()
        fresh.load_players([dict(p) for p in POOL])
        monkeypatch.setattr(ws, "room", fresh)
        fresh.set_broadcaster(ws._broadcast_state)

        def drain_to(sock, predicate):
            for _ in range(20):
                msg = sock.receive_json()
                if msg.get("type") == "state" and predicate(msg):
                    return msg
            raise AssertionError("expected state never arrived")

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/auction/ws") as host, \
                 client.websocket_connect("/api/v1/auction/ws") as mum, \
                 client.websocket_connect("/api/v1/auction/ws") as che:
                host.send_json({"type": "join", "role": "auctioneer", "password": PASSWORD})
                mum.send_json({"type": "join", "role": "franchise", "team_id": 1})
                che.send_json({"type": "join", "role": "franchise", "team_id": 2})
                host.send_json({"type": "set_rules", "purse": 7500, "max_squad": 21,
                                "min_squad": 16, "max_overseas": 6, "min_overseas": 3})
                for sock in (host, mum, che):
                    state = drain_to(sock, lambda m: m["rules"]["purse"] == 7500)
                    assert state["rules"]["min_overseas"] == 3
                    assert state["rules_version"] == fresh.rules_version
                    assert {t["left"] for t in state["teams"]} == {7500}
