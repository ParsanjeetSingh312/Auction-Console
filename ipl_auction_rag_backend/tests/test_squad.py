"""
test_squad.py
A franchise's squad for its My Squad panel (auction/squad.py).

What must hold: buys are filed under AUCTEAM's four positions; the budget
and limits are the room's own; the playing-XI gaps follow AUCTEAM's bands;
each buy's verdict is the leaderboard's; and the endpoint serves it.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from auction import squad
from auction.rooms import MAIN, registry
from auction.room import AuctionRoom
from config.settings import get_settings

PASSWORD = "squad-test-secret"

POOL = [
    {"id": 1, "player_name": "Star Opener", "role": "Batter", "overseas": 0,
     "base_price": 200, "cap_status": "CAPPED", "rating": 9.5},
    {"id": 2, "player_name": "Overseas Quick", "role": "Bowler", "overseas": 1,
     "base_price": 100, "cap_status": "CAPPED", "rating": 7.0},
    {"id": 3, "player_name": "Young Keeper", "role": "Wicket Keeper", "overseas": 0,
     "base_price": 30, "cap_status": "UNCAPPED", "rating": 4.0},
    {"id": 4, "player_name": "Seam Allrounder", "role": "All-Rounder", "overseas": 0,
     "base_price": 50, "cap_status": "CAPPED", "rating": 6.0},
    {"id": 5, "player_name": "Second Opener", "role": "Batter", "overseas": 0,
     "base_price": 100, "cap_status": "CAPPED", "rating": 8.0},
]


@pytest.fixture(autouse=True)
def _password(monkeypatch):
    monkeypatch.setattr(get_settings(), "AUCTIONEER_PASSWORD", PASSWORD)


async def room_with_buys(code: str = "MAIN") -> AuctionRoom:
    room = AuctionRoom(code=code)
    room.load_players([dict(p) for p in POOL])
    await room.join("host", "auctioneer", None, "Host", PASSWORD)
    await room.set_mode("host", "offline", "manual")
    await room.start_auction("host")
    for pid, team, price in ((1, 1, 1500), (2, 1, 400), (3, 1, 50), (5, 1, 900), (4, 2, 300)):
        await room.put_up("host", pid)
        await room.record_sale("host", team, price)
    return room


def test_buys_are_filed_under_aucteams_positions():
    room = asyncio.run(room_with_buys())
    mine = squad.squad_for(room, 1)
    groups = {g["role"]: [p["name"] for p in g["players"]] for g in mine["groups"]}
    assert [g["role"] for g in mine["groups"]] == ["BAT", "WK", "AR", "BWL"]
    assert groups == {"BAT": ["Star Opener", "Second Opener"], "WK": ["Young Keeper"], "AR": [], "BWL": ["Overseas Quick"]}
    assert mine["groups"][0]["name"] == "Batters" and mine["latest"]["name"] == "Second Opener"


def test_budget_and_limits_are_the_rooms():
    room = asyncio.run(room_with_buys())
    mine = squad.squad_for(room, 1)
    assert mine["budget"]["spent"] == 2850 and mine["budget"]["left"] == room.rules["purse"] - 2850
    assert mine["budget"]["avg_price"] == round(2850 / 4)
    limits = mine["limits"]
    assert (limits["size"], limits["overseas"], limits["uncapped"]) == (4, 1, 1)
    assert mine["needs"]["to_min_squad"] == room.rules["min_squad"] - 4
    assert mine["needs"]["overseas"] == room.rules["min_overseas"] - 1
    assert mine["needs"]["uncapped"] == 0


def test_the_playing_xi_gaps_follow_aucteam():
    room = asyncio.run(room_with_buys())
    xi = {row["role"]: row for row in squad.squad_for(room, 1)["xi"]["positions"]}
    assert xi["BAT"]["short"] == 1  # 2 of at least 3
    assert xi["WK"]["short"] == 0
    assert xi["AR"]["short"] == 1
    assert xi["BWL"]["short"] == 2
    assert squad.squad_for(room, 1)["xi"]["ready"] is False


def test_verdicts_match_the_leaderboard():
    room = asyncio.run(room_with_buys())
    board = next(t for t in room.state_payload()["standings"]["teams"] if t["id"] == 1)
    mine = squad.squad_for(room, 1)
    assert mine["budget"]["value"] == board["value"]
    verdicts = {p["verdict"] for g in mine["groups"] for p in g["players"]}
    assert verdicts <= {"steal", "good bid", "fair price", "paid over", None}


def test_an_empty_squad_and_an_unknown_team():
    room = AuctionRoom()
    room.load_players([dict(p) for p in POOL])
    empty = squad.squad_for(room, 3)
    assert all(not g["players"] for g in empty["groups"]) and empty["latest"] is None
    assert squad.squad_for(room, 999) is None


def test_the_endpoint_serves_a_rooms_squad():
    from api.main import app

    room = asyncio.run(room_with_buys("SQUAD1"))
    registry._rooms["SQUAD1"] = type(registry.get(MAIN))("SQUAD1", "mini", room)
    try:
        with TestClient(app) as client:
            body = client.get("/api/v1/auction/squad", params={"room": "SQUAD1", "team": 1}).json()
            assert body["team"]["id"] == 1 and body["limits"]["size"] == 4
            assert client.get("/api/v1/auction/squad", params={"room": "SQUAD1", "team": 999}).status_code == 404
    finally:
        registry._rooms.pop("SQUAD1", None)
