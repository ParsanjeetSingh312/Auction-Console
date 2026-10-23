"""
test_hybrid_mode.py
Online and offline rooms (auction/room.py set_mode and record_sale).

What must hold offline: nothing moves unless the auctioneer moves it -- no
clock on a lot, no on-screen bids, no starting itself -- and a logged sale is
checked and recorded exactly as an online sale is, so History, Results and
the stats see no difference. Online must be untouched.
"""
from __future__ import annotations

import asyncio

import pytest

from auction.room import AuctionRoom, RoomError
from config.settings import get_settings

PASSWORD = "hybrid-test-secret"

POOL = [
    {"id": 1, "player_name": "Capped Opener", "role": "Batter", "overseas": 0,
     "base_price": 200, "cap_status": "CAPPED"},
    {"id": 2, "player_name": "Overseas Quick", "role": "Bowler", "overseas": 1,
     "base_price": 150, "cap_status": "CAPPED"},
    {"id": 3, "player_name": "Uncapped Spinner", "role": "Bowler", "overseas": 0,
     "base_price": 30, "cap_status": "UNCAPPED"},
]


@pytest.fixture(autouse=True)
def _password(monkeypatch):
    monkeypatch.setattr(get_settings(), "AUCTIONEER_PASSWORD", PASSWORD)


@pytest.fixture
def draw(monkeypatch):
    """The random draw on, with short gaps so the suite stays fast."""
    settings = get_settings()
    monkeypatch.setattr(settings, "AUTO_DRAW", True)
    monkeypatch.setattr(settings, "DRAW_GAP_SECONDS", 0.05)
    monkeypatch.setattr(settings, "FIRST_DRAW_SECONDS", 0.05)


def run(coro):
    return asyncio.run(coro)


async def until(predicate, timeout: float = 2.0) -> None:
    """Wait for the room to reach a state, instead of guessing how long it takes."""
    for _ in range(int(timeout / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the room never got there")


async def room_in(mode: str, *, start: bool = True, fast: bool = False) -> AuctionRoom:
    room = AuctionRoom()
    room.load_players([dict(p) for p in POOL])
    if fast:
        room.rules.update(open_seconds=0.1, close_seconds=0.1, timeout_seconds=0.2)
    await room.join("host", "auctioneer", None, "Host", PASSWORD)
    await room.set_mode("host", mode, "manual")
    for t in (1, 2):
        await room.join(f"c{t}", "franchise", t, f"T{t}")
        await room.acknowledge_rules(f"c{t}", room.rules_version)
    if start:
        await room.start_auction("host")
    return room


class TestSettingTheMode:
    def test_online_and_manual_by_default(self):
        room = AuctionRoom()
        assert room.rules["mode"] == "online" and room.rules["auctioneer"] == "manual"
        assert not room.offline

    def test_only_the_auctioneer_sets_it_and_only_before_the_start(self):
        async def go():
            room = await room_in("online", start=False)
            with pytest.raises(RoomError):
                await room.set_mode("c1", "offline", "manual")
            await room.set_mode("host", "offline", "manual")
            assert room.offline
            await room.start_auction("host")
            with pytest.raises(RoomError, match="before the auction starts"):
                await room.set_mode("host", "online", "manual")
        run(go())

    def test_the_ai_runs_online_rooms_only(self):
        async def go():
            room = await room_in("online", start=False)
            with pytest.raises(RoomError, match="AI auctioneer runs online"):
                await room.set_mode("host", "offline", "ai")
            await room.set_mode("host", "online", "ai")
            assert room.rules["auctioneer"] == "ai"
        run(go())

    def test_changing_it_sends_everyone_back_to_the_briefing(self):
        async def go():
            room = await room_in("online", start=False)
            before = room.rules_version
            await room.set_mode("host", "offline", "manual")
            assert room.rules_version == before + 1
            briefing = room.state_payload()["briefing"]
            assert any(item["id"] == "offline" for item in briefing)
            assert not any(item["id"] == "timer" for item in briefing)
        run(go())


class TestOffline:
    def test_no_clock_and_no_bids_on_screen(self):
        async def go():
            room = await room_in("offline", fast=True)
            await room.put_up("host", 1)
            assert room.lot.clock is None and room.state_payload()["lot"]["clock"] is None
            for action, call in (
                ("bid", lambda: room.bid("c1")),
                ("withdraw", lambda: room.withdraw("c1")),
                ("call a timeout", lambda: room.call_timeout("c1")),
            ):
                with pytest.raises(RoomError, match="offline auction"):
                    await call()
            # Well past every online clock: the lot is still on the block.
            await asyncio.sleep(0.5)
            assert room.lot is not None and room.lot.player_id == 1
            assert room.records[1].status == "available"
        run(go())

    def test_the_next_player_waits_for_the_sale(self):
        async def go():
            room = await room_in("offline")
            await room.put_up("host", 1)
            with pytest.raises(RoomError, match="Settle the current lot"):
                await room.put_up("host", 2)
        run(go())

    def test_a_logged_sale_is_an_ordinary_sale(self):
        async def go():
            room = await room_in("offline")
            await room.put_up("host", 1)
            await room.record_sale("host", 2, 650)
            assert room.lot is None
            record = room.records[1]
            assert (record.status, record.team_id, record.price) == ("sold", 2, 650)
            state = room.state_payload()
            sale = state["last_sale"]
            assert sale["player"] == "Capped Opener" and sale["team_id"] == 2 and sale["price"] == 650
            assert state["log"][0]["kind"] == "sold" and state["log"][0]["amount"] == 650
            team = next(t for t in state["teams"] if t["id"] == 2)
            assert team["spent"] == 650
        run(go())

    def test_a_sale_is_checked_like_a_bid(self):
        async def go():
            room = await room_in("offline")
            await room.put_up("host", 1)
            with pytest.raises(RoomError, match="base price"):
                await room.record_sale("host", 1, 100)
            with pytest.raises(RoomError, match="more than a whole purse"):
                await room.record_sale("host", 1, room.rules["purse"] + 1)
            # Spend most of T1's purse, then ask it to pay more than is left.
            await room.record_sale("host", 1, room.rules["purse"] - 100)
            await room.put_up("host", 2)
            with pytest.raises(RoomError, match="over budget"):
                await room.record_sale("host", 1, 150 + 100)
            assert room.lot is not None  # a refused sale leaves the lot on the block
        run(go())

    def test_only_the_auctioneer_logs_a_sale(self):
        async def go():
            room = await room_in("offline")
            await room.put_up("host", 1)
            with pytest.raises(RoomError):
                await room.record_sale("c1", 1, 200)
        run(go())

    def test_undo_takes_the_sale_back_without_a_clock(self):
        async def go():
            room = await room_in("offline")
            await room.put_up("host", 1)
            await room.record_sale("host", 1, 300)
            await room.undo("host")
            assert room.lot is not None and room.lot.player_id == 1
            assert room.records[1].status == "available"
            assert room.state_payload()["last_sale"] is None
            assert room._clock_task is None or room._clock_task.done()
        run(go())

    def test_an_offline_room_never_starts_itself(self):
        async def go():
            room = await room_in("offline", start=False)
            with pytest.raises(RoomError, match="started by its auctioneer"):
                await room.start_auction(None)
            await room.start_auction("host")
            assert room.phase == "live"
        run(go())


class TestOnlineUnchanged:
    def test_logging_a_sale_is_for_offline_rooms(self):
        async def go():
            room = await room_in("online")
            await room.put_up("host", 1)
            with pytest.raises(RoomError, match="Use the gavel"):
                await room.record_sale("host", 1, 300)
        run(go())

    def test_the_clock_still_settles_online_lots(self):
        async def go():
            room = await room_in("online", fast=True)
            await room.put_up("host", 1)
            await room.bid("c1")
            await asyncio.sleep(0.4)
            assert room.records[1].status == "sold" and room.records[1].team_id == 1
            assert room.state_payload()["last_sale"]["team_id"] == 1
        run(go())


class TestRandomDraw:
    def test_online_players_are_drawn_not_put_up(self, draw):
        async def go():
            # Full-length clocks: a fast one could pass the drawn lot over
            # before the assertions look at it.
            room = await room_in("online")
            assert room.state_payload()["draw"] == "random"
            with pytest.raises(RoomError, match="at random"):
                await room.put_up("host", 1)
            await until(lambda: room.lot is not None)  # drawn by the room itself
            assert "drawn at random" in room.log[0]["what"]
        run(go())

    def test_the_next_player_is_drawn_after_a_lot_settles(self, draw):
        async def go():
            room = await room_in("online")
            await until(lambda: room.lot is not None)
            first = room.lot.player_id
            await room.bid("c1")
            await room.sell("host")
            assert room.records[first].status == "sold"
            assert room.state_payload()["next_draw_at"] is not None
            await until(lambda: room.lot is not None)
            assert room.lot.player_id != first
        run(go())

    def test_the_auction_closes_itself_when_every_player_is_drawn(self, draw):
        async def go():
            room = await room_in("online")
            for _ in range(len(POOL)):
                await until(lambda: room.lot is not None)
                await room.mark_unsold("host")
            await until(lambda: room.phase == "finished")
            assert room.lot is None
        run(go())

    def test_offline_rooms_are_never_drawn(self, draw):
        async def go():
            room = await room_in("offline")
            assert room.state_payload()["draw"] == "manual"
            await asyncio.sleep(0.15)
            assert room.lot is None  # waits for the auctioneer
            await room.put_up("host", 3)
            assert room.lot.player_id == 3
        run(go())
