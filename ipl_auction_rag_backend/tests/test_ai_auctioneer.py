"""
test_ai_auctioneer.py
The AI auctioneer (auction/ai_auctioneer.py, auction/auctioneer_brain.py).

What must hold: in an online room whose chair is AI, every lot is announced,
every result is called with the room's own verdict, and the auction is
summed up at the close -- all in the feed every screen reads; a manual room
hears nothing from it; the human in the chair can pause it, resume it and
take over; and with no model at all it still speaks, from templates. The
model and SCOUT are stubbed: these tests are about the wiring and the
rulings, never about a provider.
"""
from __future__ import annotations

import asyncio

import pytest

from auction import auctioneer_brain as brain
from auction import ai_auctioneer  # noqa: F401 - installs the hook
from auction.room import AuctionRoom, RoomError
from config.settings import get_settings

PASSWORD = "ai-test-secret"

POOL = [
    {"id": 1, "player_name": "Star Opener", "role": "Batter", "overseas": 0,
     "base_price": 200, "cap_status": "CAPPED", "rating": 9.5},
    {"id": 2, "player_name": "Steady Seamer", "role": "Bowler", "overseas": 1,
     "base_price": 100, "cap_status": "CAPPED", "rating": 6.0},
    {"id": 3, "player_name": "Young Spinner", "role": "Bowler", "overseas": 0,
     "base_price": 30, "cap_status": "UNCAPPED", "rating": 4.0},
]


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "AUCTIONEER_PASSWORD", PASSWORD)
    monkeypatch.setattr(settings, "AUTO_DRAW", True)
    monkeypatch.setattr(settings, "DRAW_GAP_SECONDS", 0.05)
    monkeypatch.setattr(settings, "FIRST_DRAW_SECONDS", 0.05)

    async def no_scout(name):
        return []

    monkeypatch.setattr(brain, "scout_notes", no_scout)


@pytest.fixture
def model(monkeypatch):
    """A model that echoes what it was asked to call, so tests can read it."""
    seen: list[dict] = []

    async def speak(facts, fallback):
        seen.append(facts)
        return f"[{facts['call']}] " + fallback, "ai"

    monkeypatch.setattr(brain, "speak", speak)
    return seen


def run(coro):
    return asyncio.run(coro)


async def until(predicate, timeout: float = 2.0) -> None:
    for _ in range(int(timeout / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the room never got there")


async def ai_room(chair: str = "ai") -> AuctionRoom:
    room = AuctionRoom()
    room.load_players([dict(p) for p in POOL])
    await room.join("host", "auctioneer", None, "Host", PASSWORD)
    await room.set_mode("host", "online", chair)
    for t in (1, 2):
        await room.join(f"c{t}", "franchise", t, f"T{t}")
        await room.acknowledge_rules(f"c{t}", room.rules_version)
    await room.start_auction("host")
    return room


def feed(room, kind=None):
    return [e for e in room.auctioneer_feed if kind is None or e["kind"] == kind]


class TestCalls:
    def test_every_lot_is_announced(self, model):
        async def go():
            room = await ai_room()
            await until(lambda: room.lot is not None)
            await until(lambda: feed(room, "announce"))
            call = feed(room, "announce")[0]
            assert call["player_id"] == room.lot.player_id and call["source"] == "ai"
            assert "Player data" in call["sources"] and "AUCTONIQ value" in call["sources"]
            assert room.state_payload()["auctioneer_feed"][-1]["id"] == call["id"]
            assert room.state_payload()["ai"]["active"] is True
        run(go())

    def test_a_sale_is_called_with_the_rooms_verdict(self, model):
        async def go():
            room = await ai_room()
            await until(lambda: room.lot is not None)
            pid = room.lot.player_id
            await room.bid("c1")
            await room.sell("host")
            await until(lambda: feed(room, "sold"))
            call = feed(room, "sold")[0]
            expected = brain.valuation(room, pid)["expected"]
            assert call["verdict"] == brain.verdict(room.records[pid].price, expected)
            asked = next(f for f in model if f["call"].startswith("announce the sale"))
            assert asked["verdict"] == call["verdict"]  # the model is told the ruling, not asked for it
        run(go())

    def test_unsold_and_the_closing_summary(self, model):
        async def go():
            room = await ai_room()
            await until(lambda: room.lot is not None)
            await room.bid("c1")
            await room.sell("host")
            for _ in range(len(POOL) - 1):
                await until(lambda: room.lot is not None)
                await room.mark_unsold("host")
            await until(lambda: feed(room, "summary"))
            assert feed(room, "unsold")
            summary = next(f for f in model if f["call"].startswith("close the auction"))
            assert summary["players_sold"] == 1
        run(go())

    def test_a_manual_room_hears_nothing_from_it(self, model):
        async def go():
            room = await ai_room("manual")
            await until(lambda: room.lot is not None)
            await asyncio.sleep(0.1)
            assert room.auctioneer_feed == [] and model == []
            assert room.state_payload()["ai"]["active"] is False
        run(go())


class TestTheHumanInTheChair:
    def test_pause_resume_and_take_over(self, model):
        async def go():
            room = await ai_room()
            await room.ai_control("host", "pause")
            await until(lambda: room.lot is not None)
            await asyncio.sleep(0.1)
            assert feed(room) == []  # paused: the lot opened in silence
            await room.ai_control("host", "resume")
            await room.mark_unsold("host")
            await until(lambda: feed(room, "unsold"))
            await room.ai_control("host", "take_over")
            assert room.rules["auctioneer"] == "manual" and not room.ai_active
            count = len(feed(room))
            await until(lambda: room.lot is not None)
            await room.mark_unsold("host")
            await asyncio.sleep(0.1)
            assert len(feed(room)) == count  # taken over: it speaks no more
            with pytest.raises(RoomError, match="not run by the AI"):
                await room.ai_control("host", "resume")
        run(go())

    def test_only_the_chair_steers_it(self, model):
        async def go():
            room = await ai_room()
            with pytest.raises(RoomError):
                await room.ai_control("c1", "pause")
        run(go())


class TestWithoutAModel:
    def test_templates_keep_the_room_talking(self, monkeypatch):
        from rag import llm_provider

        monkeypatch.setattr(llm_provider, "available", lambda: False)

        async def go():
            room = await ai_room()
            await until(lambda: room.lot is not None)
            name = room.players[room.lot.player_id].name
            await room.bid("c2")
            await room.sell("host")
            await until(lambda: feed(room, "sold") and feed(room, "announce"))
            announce, sold = feed(room, "announce")[0], feed(room, "sold")[0]
            assert announce["source"] == "template" and name in announce["text"]
            team = room.team_by_id(2)["name"]
            assert sold["source"] == "template" and sold["text"].startswith(f"Sold to {team} for")
        run(go())


class TestTheRulings:
    def test_the_verdict_scale_is_the_report_cards(self):
        room = AuctionRoom()
        room.load_players([dict(p) for p in POOL])
        value = brain.valuation(room, 1)
        assert value["expected"] and value["percentile"] == 100
        assert brain.verdict(int(value["expected"] * 0.4), value["expected"]) == "steal"
        assert brain.verdict(int(value["expected"] * 3), value["expected"]) == "paid over"
        assert brain.valuation(room, 3)["expected"] >= POOL[2]["base_price"]

    def test_a_player_without_a_rating_gets_no_verdict(self):
        room = AuctionRoom()
        room.load_players([{**dict(p), "rating": None} for p in POOL])
        assert brain.valuation(room, 1)["expected"] is None
        assert brain.verdict(500, None) is None


class TestCleaningTheLine:
    """Real replies from the configured models, echoing the prompt's labels."""

    @pytest.mark.parametrize(
        "reply, line",
        [
            ("AUCTONIQ: On the block: Madhav Kaushik, right-hand batter.", "On the block: Madhav Kaushik, right-hand batter."),
            ("AUCTONIQ Announcing: On the block: Vishnu Vinod, keeper.", "On the block: Vishnu Vinod, keeper."),
            ('Calling a sale (verdict "fair price"): Sold to Chennai for Rs 2.00 Cr.', "Sold to Chennai for Rs 2.00 Cr."),
            ("AUCTONIQ values him at Rs 9 Cr.", "AUCTONIQ values him at Rs 9 Cr."),
            ('{"line": "On the block: X."}', "On the block: X."),
            ('"Sold to Mumbai for Rs 18.50 Cr."', "Sold to Mumbai for Rs 18.50 Cr."),
            ("", None),
        ],
    )
    def test_labels_and_quotes_are_stripped(self, reply, line):
        assert brain.clean_line(reply) == line
