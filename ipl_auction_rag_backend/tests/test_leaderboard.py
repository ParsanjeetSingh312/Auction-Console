"""
test_leaderboard.py
Live standings (auction/leaderboard.py), as the room sends them.

What must hold: every franchise appears, with figures that add up to the
room's own records; the AUCTONIQ value and verdicts agree with the report
card's scale; buys keep their order; and an undo takes a sale back out.
"""
from __future__ import annotations

import asyncio

import pytest

from auction import report_card
from auction.room import AuctionRoom
from config.settings import get_settings

PASSWORD = "board-test-secret"

POOL = [
    {"id": 1, "player_name": "Star Opener", "role": "Batter", "overseas": 0,
     "base_price": 200, "cap_status": "CAPPED", "rating": 9.5},
    {"id": 2, "player_name": "Steady Seamer", "role": "Bowler", "overseas": 1,
     "base_price": 100, "cap_status": "CAPPED", "rating": 6.0},
    {"id": 3, "player_name": "Young Keeper", "role": "Wicket Keeper", "overseas": 0,
     "base_price": 30, "cap_status": "UNCAPPED", "rating": 4.0},
    {"id": 4, "player_name": "Unrated Allrounder", "role": "All-Rounder", "overseas": 0,
     "base_price": 50, "cap_status": "CAPPED", "rating": None},
]


@pytest.fixture(autouse=True)
def _password(monkeypatch):
    monkeypatch.setattr(get_settings(), "AUCTIONEER_PASSWORD", PASSWORD)


async def room_with_sales() -> AuctionRoom:
    room = AuctionRoom()
    room.load_players([dict(p) for p in POOL])
    await room.join("host", "auctioneer", None, "Host", PASSWORD)
    await room.set_mode("host", "offline", "manual")
    await room.start_auction("host")
    for pid, team, price in ((1, 1, 1500), (3, 1, 60), (2, 2, 400), (4, 2, 80)):
        await room.put_up("host", pid)
        await room.record_sale("host", team, price)
    return room


def team(board, code):
    return next(t for t in board["teams"] if t["code"] == code)


def test_every_franchise_is_ranked_with_figures_that_add_up():
    async def go():
        room = await room_with_sales()
        board = room.state_payload()["standings"]
        assert len(board["teams"]) == len(room.teams)
        first, second = room.teams[0]["code"], room.teams[1]["code"]
        a, b = team(board, first), team(board, second)
        assert (a["spent"], a["size"], a["avg_price"]) == (1560, 2, 780)
        assert a["left"] == room.rules["purse"] - 1560
        assert a["roles"] == {"WK": 1, "BAT": 1, "AR": 0, "BOWL": 0}
        assert a["uncapped"] == 1 and b["overseas"] == 1
        assert a["top_buy"]["player"] == "Star Opener" and a["last_buy"]["player"] == "Young Keeper"
        assert a["curve"] == [1500, 1560]  # in the order bought
        assert board["room"]["sold"] == 4 and board["room"]["spent"] == 1560 + 480
        assert board["room"]["record"]["player"] == "Star Opener"
        assert [s["player"] for s in board["recent"]][:2] == ["Unrated Allrounder", "Steady Seamer"]
    asyncio.run(go())


def test_value_and_verdicts_follow_the_report_card():
    async def go():
        room = await room_with_sales()
        board = room.state_payload()["standings"]
        b = team(board, room.teams[1]["code"])
        # The unrated all-rounder has no AUCTONIQ value, so no verdict.
        unrated = next(s for s in board["recent"] if s["player"] == "Unrated Allrounder")
        assert unrated["verdict"] is None
        for sale in board["recent"]:
            if sale["verdict"]:
                assert sale["verdict"] in ("steal", "good bid", "fair price", "paid over")
        assert isinstance(b["value"], int)
        strongest = max(board["teams"], key=lambda t: t["strength"])
        assert strongest["code"] == room.teams[0]["code"]  # it bought the 9.5
    asyncio.run(go())


def test_undo_takes_a_sale_back_out():
    async def go():
        room = await room_with_sales()
        await room.undo("host")
        board = room.state_payload()["standings"]
        assert board["room"]["sold"] == 3
        assert team(board, room.teams[1]["code"])["size"] == 1
    asyncio.run(go())


def test_an_empty_room_has_a_board_of_zeroes():
    room = AuctionRoom()
    room.load_players([dict(p) for p in POOL])
    board = room.state_payload()["standings"]
    assert all(t["spent"] == 0 and t["strength"] == 0 and t["curve"] == [] for t in board["teams"])
    assert board["room"]["record"] is None and board["recent"] == []
