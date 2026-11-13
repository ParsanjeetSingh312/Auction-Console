"""
test_auction_setup.py
The Auction Setup upgrade: the marking scheme, the auction flow, the AI and
manual chairs working together, generated lots, and breaks.

What must hold:

  * the marking scheme is validated, weighted by its order, and is what a
    franchise's report is graded on -- while a room with no scheme keeps
    AUCTONIQ's own rating to the decimal;
  * the flow covers every player exactly once and favours its first tiers
    without ever running one tier or one role on;
  * the chair can change hands mid-auction in both directions, and the room
    draws by itself only while the AI holds it;
  * a generated lot brings up only its role, in either chair;
  * a break stops the clock and the bidding, and loses nothing.
"""
from __future__ import annotations

import asyncio
import random

import pytest

from auction import flow, marking, setup_options
from auction.report_card import build_team_card
from auction.room import AuctionRoom, Player, RoomError
from auction.rules import ACTION_SECONDS, rules_list
from config.settings import get_settings

PASSWORD = "setup-test-secret"


def make_pool() -> list[dict]:
    """
    Forty players across the three tiers and the four roles. Tiers are
    AUCTEAM's (aucteam/tiers.py): 150+ IPL matches is marquee, an uncapped
    player under 50 matches is emerging, everyone else here is prime.
    """
    pool, pid = [], 0
    roles = ["Batter", "Bowler", "All-Rounder", "Wicket Keeper"]
    for index in range(8):  # marquee
        pid += 1
        pool.append({"id": pid, "player_name": f"Star {index}", "role": roles[index % 4], "overseas": index % 3 == 0,
                     "base_price": 200, "rating": 9.5 + (0.25 if index < 2 else 0), "cap_status": "CAPPED",
                     "matches": 160 + index})
    for index in range(20):  # prime: half of them rated
        pid += 1
        pool.append({"id": pid, "player_name": f"Prime {index}", "role": roles[index % 4], "overseas": index % 4 == 0,
                     "base_price": 100, "rating": (8.5 + (index % 4) * 0.25) if index < 10 else None,
                     "cap_status": "CAPPED", "matches": 60 + index})
    for index in range(12):  # emerging
        pid += 1
        pool.append({"id": pid, "player_name": f"Young {index}", "role": roles[index % 4], "overseas": 0,
                     "base_price": 30, "cap_status": "UNCAPPED", "matches": index})
    return pool


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    # The AI chair is used here for its draw. Its voice has tests of its own
    # (test_ai_auctioneer.py); left on, it would look for a model on every lot.
    monkeypatch.setattr("auction.room.EVENT_HOOKS", [])
    # No curated tiers: the pool above sets every tier by its own figures.
    monkeypatch.setattr("aucteam.store.load_overrides", lambda: {})
    settings = get_settings()
    monkeypatch.setattr(settings, "AUCTIONEER_PASSWORD", PASSWORD)
    monkeypatch.setattr(settings, "AUTO_DRAW", True)
    monkeypatch.setattr(settings, "DRAW_GAP_SECONDS", 0.05)
    monkeypatch.setattr(settings, "FIRST_DRAW_SECONDS", 0.05)


def run(coro):
    return asyncio.run(coro)


async def until(predicate, timeout: float = 2.0) -> None:
    for _ in range(int(timeout / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the room never got there")


async def live_room(chair: str = "manual", *, fast: bool = False) -> AuctionRoom:
    room = AuctionRoom()
    room.load_players(make_pool())
    if fast:
        room.rules.update(open_seconds=0.1, close_seconds=0.1, timeout_seconds=0.3)
    await room.join("host", "auctioneer", None, "Host", PASSWORD)
    await room.set_mode("host", "online", chair)
    for team in (1, 2):
        await room.join(f"c{team}", "franchise", team, f"T{team}")
        await room.acknowledge_rules(f"c{team}", room.rules_version)
    await room.start_auction("host")
    return room


def save_setup(room: AuctionRoom, **extra):
    rules = room.rules
    return room.set_rules(
        "host", rules["purse"], rules["max_squad"], rules["min_squad"], rules["max_overseas"],
        rules["max_players"], rules["min_overseas"], **extra,
    )


# ------------------------------------------------------------ the clock --


def test_the_bid_timer_is_ten_seconds():
    room = AuctionRoom()
    assert ACTION_SECONDS == 10
    assert room.rules["open_seconds"] == 10 and room.rules["close_seconds"] == 10
    assert any("10-second" in item["title"] for item in rules_list(room.rules))


# ------------------------------------------------------- marking scheme --


def test_scheme_weights_follow_priority_order():
    assert setup_options.weights(4) == pytest.approx([0.4, 0.3, 0.2, 0.1])
    assert sum(setup_options.weights(3)) == pytest.approx(1.0)
    assert setup_options.weights(1) == [1.0]


def test_scheme_is_validated():
    assert setup_options.validate_scheme(["Balance", "rating"]) == ["balance", "rating"]
    with pytest.raises(setup_options.SetupError):
        setup_options.validate_scheme(["balance", "balance"])
    with pytest.raises(setup_options.SetupError):
        setup_options.validate_scheme(["charisma"])
    with pytest.raises(setup_options.SetupError):
        setup_options.validate_scheme(["balance", "rating", "bidding", "xi", "stars"])


def test_saving_setup_records_the_scheme_and_rebriefs_the_room():
    async def scenario():
        room = AuctionRoom()
        room.load_players(make_pool())
        await room.join("host", "auctioneer", None, "Host", PASSWORD)
        assert room.state_payload()["setup_saved"] is False
        before = room.rules_version
        await save_setup(room, marking_scheme=["balance", "rating", "bidding"], flow=["marquee"])
        payload = room.state_payload()
        assert payload["setup_saved"] is True
        assert room.rules["marking_scheme"] == ["balance", "rating", "bidding"]
        # The two tiers left out are added after the one named.
        assert room.rules["flow"] == ["marquee", "prime", "emerging"]
        assert room.rules_version == before + 1
        assert any(item["id"] == "marking" for item in payload["briefing"])
        # Changing only the flow is the auctioneer's own business: no re-briefing.
        version = room.rules_version
        await save_setup(room, flow=["emerging", "marquee", "prime"])
        assert room.rules_version == version
        with pytest.raises(RoomError):
            await save_setup(room, marking_scheme=["nonsense"])

    run(scenario())


async def _sell(room: AuctionRoom, player_id: int, client: str, raises: int = 0) -> None:
    await room.put_up("host", player_id)
    await room.bid(client)
    other = "c2" if client == "c1" else "c1"
    for _ in range(raises):
        await room.bid(other)
        await room.bid(client)
    await room.sell("host")


def test_report_is_graded_on_the_scheme_and_default_is_unchanged():
    async def scenario():
        room = await live_room("manual")
        for pid in (1, 2, 9, 29):
            await _sell(room, pid, "c1")
        await _sell(room, 3, "c2", raises=3)

        default = build_team_card(room, 1, {})
        assert default.custom_scheme is False
        assert [mark.key for mark in default.marks] == ["balance", "steals", "rating", "budget"]
        legacy = round(sum(default.components[k].value * w for k, w in
                           {"balance": 0.30, "steals": 0.20, "rating": 0.30, "budget": 0.20}.items()), 1)
        assert default.overall == legacy

        await save_setup(room, marking_scheme=["bidding", "stars", "balance"])
        card = build_team_card(room, 1, {})
        assert card.custom_scheme is True
        assert [mark.key for mark in card.marks] == ["bidding", "stars", "balance"]
        assert [round(mark.weight, 3) for mark in card.marks] == [0.5, 0.333, 0.167]
        assert card.overall == round(sum(mark.value * mark.weight for mark in card.marks), 1)
        assert all(0 <= mark.value <= 10 and mark.detail for mark in card.marks)
        # Two marquee players signed (ids 1 and 2).
        stars = next(mark for mark in card.marks if mark.key == "stars")
        assert "2 marquee players" in stars.detail

    run(scenario())


def test_overbidding_marks_lower_than_buying_at_value():
    def buy(price: int, expected: int, verdict: str):
        from auction.report_card import Buy

        return Buy(id=1, name="P", role="Batter", role_short="BAT", country=None, overseas=False, base=100,
                   price=price, rating=9.0, rating_pct=0.5, marquee=False, expected=expected,
                   ratio=price / expected, verdict=verdict, headline="", base_assumed=False)

    steal = marking.score_bidding([buy(300, 600, "steal")])
    fair = marking.score_bidding([buy(600, 600, "fair price")])
    over = marking.score_bidding([buy(1200, 600, "paid over")])
    assert steal.value > fair.value > over.value


# ------------------------------------------------------------- the flow --


def _players(room: AuctionRoom) -> list[Player]:
    return list(room.players.values())


def test_every_player_has_exactly_one_tier():
    room = AuctionRoom()
    room.load_players(make_pool())
    counts = {row["key"]: row["total"] for row in room.state_payload()["flow"]}
    assert counts == {"prime": 20, "marquee": 8, "emerging": 12}
    assert sum(counts.values()) == len(room.players)


def test_flow_favours_its_first_tiers_and_never_runs_on():
    room = AuctionRoom()
    room.load_players(make_pool())
    rng = random.Random(7)
    order = ["marquee", "prime", "emerging"]
    left, history, came_up = _players(room), [], []
    while left:
        player = flow.pick(left, order, history, rng=rng)
        left.remove(player)
        came_up.append(player)
        history.append((flow.tier_of(player), player.role_short))
    # Everyone came up exactly once.
    assert len({player.id for player in came_up}) == 40
    first_half = [tier for tier, _ in history[:16]]
    assert sum(1 for tier in first_half if tier == "emerging") <= 5
    # While more than one tier was still open, no tier ran past the limit.
    tiers = [tier for tier, _ in history]
    for start in range(len(tiers) - flow.MAX_TIER_RUN):
        window = tiers[start:start + flow.MAX_TIER_RUN + 1]
        remaining = set(tiers[start + flow.MAX_TIER_RUN:])
        if len(remaining) > 1:
            assert len(set(window)) > 1, f"a run of {window[0]} at {start}"


def test_rated_players_come_up_sooner_inside_a_tier():
    room = AuctionRoom()
    room.load_players(make_pool())
    prime = [p for p in _players(room) if flow.tier_of(p) == "prime"]
    rated_first = 0
    for seed in range(200):
        player = flow.pick(prime, ["prime"], [], rng=random.Random(seed))
        rated_first += player.rating is not None
    # Half the tier is rated; at three to one it should lead about 75% of draws.
    assert 130 <= rated_first <= 170


def test_the_ai_chair_draws_by_the_flow_and_manual_waits():
    async def scenario():
        manual = await live_room("manual")
        await asyncio.sleep(0.2)
        assert manual.lot is None and manual.state_payload()["draw"] == "manual"

        ai = await live_room("ai")
        await until(lambda: ai.lot is not None)
        assert ai.state_payload()["draw"] == "random"
        assert ai.state_payload()["lot"]["tier"] in setup_options.TIERS
        assert ai.log[0]["what"].endswith("(auction flow)")

    run(scenario())


# ------------------------------------------------ AI and manual together --


def test_the_chair_changes_hands_both_ways_mid_auction():
    async def scenario():
        room = await live_room("ai", fast=True)
        await until(lambda: room.lot is not None)

        await room.ai_control("host", "take_over")
        assert room.rules["auctioneer"] == "manual" and not room.auto_draw
        # The lot on the block is untouched; it lapses, and nothing follows it.
        await until(lambda: room.lot is None)
        await asyncio.sleep(0.25)
        assert room.lot is None

        # By hand: a named player, then the next one in the flow.
        target = next(p.id for p in room._drawable() if p.role_short == "BOWL")
        await room.put_up("host", target)
        assert room.lot.player_id == target
        await room.mark_unsold("host")
        await room.draw_next("host")
        assert room.lot is not None
        await room.mark_unsold("host")

        # And back to the AI, which picks the room up from where it stands.
        await room.ai_control("host", "hand_back")
        assert room.rules["auctioneer"] == "ai"
        await until(lambda: room.lot is not None)
        with pytest.raises(RoomError):
            await room.put_up("host", target)
        with pytest.raises(RoomError):
            await room.draw_next("host")

    run(scenario())


# ----------------------------------------------------------------- lots --


def test_a_generated_lot_brings_up_only_its_role_by_hand():
    async def scenario():
        room = await live_room("manual")
        size = await room.generate_lot("host", "BOWL", 4)
        assert size == 4
        plan = room.state_payload()["lot_plan"]
        assert plan == {"category": "BOWL", "label": "Bowlers", "total": 4, "left": 4}
        seen = []
        for _ in range(4):
            await room.draw_next("host")
            seen.append(room.players[room.lot.player_id])
            await room.mark_unsold("host")
        assert all(player.role_short == "BOWL" for player in seen)
        assert len({player.id for player in seen}) == 4
        assert room.state_payload()["lot_plan"] is None
        # The lot is done: the next draw is the ordinary flow again.
        await room.draw_next("host")
        assert room.log[0]["what"].endswith("(auction flow)")

    run(scenario())


def test_the_ai_runs_a_generated_lot_then_returns_to_the_flow():
    async def scenario():
        room = await live_room("ai", fast=True)
        await room.generate_lot("host", "WK", 3)
        roles = []
        seen: set[int] = set()

        def new_lot() -> bool:
            return room.lot is not None and room.lot.player_id not in seen

        # The lot already on the block, if any, was drawn before the queue.
        if room.lot is not None:
            seen.add(room.lot.player_id)
        for _ in range(3):
            await until(new_lot, timeout=4.0)
            seen.add(room.lot.player_id)
            roles.append(room.players[room.lot.player_id].role_short)
        assert roles == ["WK", "WK", "WK"]

    run(scenario())


def test_a_lot_can_be_cleared_and_needs_players_left():
    async def scenario():
        room = await live_room("manual")
        await room.generate_lot("host", "BAT", 6)
        await room.clear_lot("host")
        assert room.lot_queue == [] and room.state_payload()["lot_plan"] is None
        with pytest.raises(RoomError):
            await room.clear_lot("host")
        with pytest.raises(RoomError):
            await room.generate_lot("host", "XYZ", 4)
        with pytest.raises(RoomError):
            await room.generate_lot("c1", "BAT", 4)

    run(scenario())


# --------------------------------------------------------------- breaks --


def test_a_break_stops_the_clock_and_the_bidding_and_loses_nothing():
    async def scenario():
        room = await live_room("manual", fast=True)
        await room.draw_next("host")
        await room.bid("c1")
        player_id, price = room.lot.player_id, room.lot.bid

        with pytest.raises(RoomError):
            await room.take_break("c1")
        await room.take_break("host", "  Back in   ten  ")
        payload = room.state_payload()
        assert payload["break"]["note"] == "Back in ten"
        assert payload["lot"]["clock"] is None

        # Longer than the lot's whole window: it must still be standing.
        await asyncio.sleep(0.3)
        assert room.lot is not None and room.lot.player_id == player_id and room.lot.bid == price
        for action in (room.bid("c2"), room.withdraw("c2"), room.call_timeout("c2"),
                       room.sell("host"), room.mark_unsold("host")):
            with pytest.raises(RoomError):
                await action
        with pytest.raises(RoomError):
            await room.take_break("host")

        await room.end_break("host")
        assert room.state_payload()["break"] is None
        assert room.lot.clock == "closing"
        # The clock is running again and settles the lot as it always would.
        await until(lambda: room.lot is None)
        assert room.records[player_id].status == "sold" and room.records[player_id].team_id == 1

    run(scenario())


def test_a_break_holds_the_ai_draw_until_the_auction_resumes():
    async def scenario():
        room = await live_room("ai", fast=True)
        await until(lambda: room.lot is not None)
        await room.mark_unsold("host")
        await room.take_break("host")
        await asyncio.sleep(0.3)
        assert room.lot is None and room.next_draw_at is None
        await room.end_break("host")
        await until(lambda: room.lot is not None)

    run(scenario())
