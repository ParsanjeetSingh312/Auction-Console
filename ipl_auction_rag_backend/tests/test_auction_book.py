"""
Tests for the per-franchise auction report (auction/auction_book.py).

The rule worth guarding is the split between what a franchise's report may say
about itself and what it says about the room. Its own pages must describe its
own squad and nobody else's; the four shared sections -- top bid, moments, the
ten most expensive signings and the awards -- must be identical in every
franchise's copy.
"""
from __future__ import annotations

import time

from auction.auction_book import build_franchise_report, money
from auction.auction_book_pdf import render_franchise_pdf
from auction.room import AuctionRoom, Record

POOL = [
    {"id": i, "player_name": f"Player {i}", "role": role, "overseas": i % 4 == 0,
     "base_price": 30 if i > 6 else 200, "cap_status": "UNCAPPED" if i % 5 == 0 else "CAPPED",
     "rating": 9.5 - i * 0.1}
    for i, role in enumerate(
        ["Batter", "Bowler", "All-Rounder", "Wicket Keeper"] * 5, start=1
    )
]
ROWS = {
    p["id"]: {**p, "matches": 20 + p["id"] * 5, "total_runs": 300 * p["id"],
              "wickets": p["id"] if p["role"] in ("Bowler", "All-Rounder") else None,
              "jersey_number": p["id"] if p["id"] < 4 else None}
    for p in POOL
}


def _room() -> AuctionRoom:
    room = AuctionRoom(code="BOOK1")
    room.load_players([dict(p) for p in POOL])
    room.started_at = t0 = time.time() - 3600
    sales = [  # (player, team, price, minutes in, unsold before)
        (1, 1, 1800, 2, 0), (2, 2, 1500, 5, 0), (3, 1, 900, 9, 0), (4, 3, 200, 20, 0),
        (5, 2, 30, 31, 0), (6, 1, 40, 33, 0), (7, 3, 30, 36, 0), (8, 2, 55, 50, 1),
        (9, 1, 30, 52, 2), (10, 3, 120, 55, 0), (11, 2, 600, 56, 0), (12, 1, 30, 58, 0),
    ]
    for pid, team, price, minute, unsold in sales:
        room.records[pid] = Record(status="sold", team_id=team, price=price,
                                   ts=t0 + minute * 60, unsold_count=unsold)
    room.records[13] = Record(status="unsold", ts=t0 + 59 * 60, unsold_count=1)
    room.finished_at = t0 + 60 * 60
    return room


class TestOwnFiguresStayOwn:
    def test_buys_and_mix_are_this_franchise_only(self):
        room = _room()
        report = build_franchise_report(room, 1, ROWS)
        assert {s.team_id for s in report.buys} == {1}
        assert len(report.buys) == 5
        assert report.spent == 1800 + 900 + 40 + 30 + 30
        assert sum(b.value for b in report.role_mix) == len(report.buys)
        assert all(s.team_id == 1 for s in report.priciest_by_role)
        assert all(s.team_id == 1 for s, _ in report.steals)

    def test_shared_sections_are_the_same_for_every_franchise(self):
        room = _room()
        a = build_franchise_report(room, 1, ROWS)
        b = build_franchise_report(room, 2, ROWS)
        assert [s.player_id for s in a.ten_most_expensive] == [s.player_id for s in b.ten_most_expensive]
        assert [(m.at, m.title) for m in a.moments] == [(m.at, m.title) for m in b.moments]
        assert [(w.title, w.team_name) for w in a.awards] == [(w.title, w.team_name) for w in b.awards]
        assert a.top_bid.player_id == b.top_bid.player_id == 1
        # And the shared list does name other franchises' signings.
        assert {s.team_id for s in a.ten_most_expensive} > {1}


class TestTheDay:
    def test_moments_and_length(self):
        report = build_franchise_report(_room(), 1, ROWS)
        titles = [m.title for m in report.moments]
        assert "Record bid" in titles and "First buy of the day" in titles
        assert "Final hammer" in titles and "The unsold return" in titles
        assert report.auction_minutes == 60

    def test_comeback_kings_and_awards(self):
        report = build_franchise_report(_room(), 1, ROWS)
        assert {s.player_id for s in report.comeback_kings} == {8, 9}
        awards = {w.title: w for w in report.awards}
        assert awards["Biggest single cheque"].team_name == "Mumbai"
        assert "Comeback of the day" in awards

    def test_jersey_numbers_come_from_the_pool_or_stay_blank(self):
        report = build_franchise_report(_room(), 1, ROWS)
        by_id = {s.player_id: s for s in report.ten_most_expensive}
        assert by_id[1].jersey == 1 and by_id[4].jersey is None

    def test_money_reads_like_the_room(self):
        assert money(1775) == "₹17.75 Cr"
        assert money(60.4545) == "₹60.5 L"


def test_pdf_renders_for_a_fictional_franchise():
    import asyncio

    from config.settings import get_settings

    room = _room()
    get_settings().AUCTIONEER_PASSWORD = "book-test"
    asyncio.run(room.join("host", "auctioneer", None, "Host", "book-test"))
    room.phase = "lobby"
    team = asyncio.run(room.add_franchise("host", "Goa Gladiators", "GOA"))
    room.records[14] = Record(status="sold", team_id=team["id"], price=75, ts=room.started_at + 600)
    pdf = render_franchise_pdf(build_franchise_report(room, team["id"], ROWS))
    assert pdf.startswith(b"%PDF") and len(pdf) > 10_000
