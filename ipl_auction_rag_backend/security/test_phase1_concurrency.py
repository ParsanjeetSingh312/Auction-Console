"""
test_phase1_concurrency.py
Phase 1 -- race the auction's atomic guard.

The brief wanted "10,000 WebSocket bids breaking SQLite EXCLUSIVE locks". There
are no SQLite locks in the bid path: the auction is entirely in memory, and its
whole defence against two franchises paying for one player is two lines of
`room.py` working together --

    * one `asyncio.Lock` around every mutation, so simultaneous bids are
      *serialised* into an order rather than interleaved into a torn read; and
    * an optimistic `lot.version`, so the loser of that ordering is *refused*
      when the lot moved underneath it, instead of silently overwriting the
      winner at the same price.

So this phase attacks those two lines directly, at the room object, with
`asyncio.gather` firing many bids into the same tick. Driving the room rather
than a socket is deliberate: it removes rate limiting and transport timing from
the picture, so a failure here is a concurrency failure and nothing else. The
invariants asserted are the ones that must never break no matter the scheduling:
no player sold twice, no torn or duplicated price, no bid honoured against a
version the room has already moved past, and no franchise winning beyond its
purse.
"""
from __future__ import annotations

import asyncio

import pytest

from auction.room import RoomError, increment_for
from harness.staging import AUCTIONEER_TEST_PASSWORD

pytestmark = [pytest.mark.concurrency, pytest.mark.asyncio]


async def _seat_and_open(room, *, teams=(1, 2, 3, 4, 5), player_id=1):
    """
    Bring the room to a live lot: seat an auctioneer and `teams`, then put a
    player on the block. Returns the auctioneer's client id and a
    team_id -> client_id map so a test can bid as whichever franchise it means.
    """
    auctioneer = "auctioneer"
    await room.join(auctioneer, "auctioneer", None, "Auc", AUCTIONEER_TEST_PASSWORD)
    await room.start_auction(auctioneer)

    clients = {team_id: f"client-{team_id}" for team_id in teams}
    for team_id, client_id in clients.items():
        await room.join(client_id, "franchise", team_id, f"Team {team_id}")

    await room.put_up(auctioneer, player_id)
    return auctioneer, clients


class TestSimultaneousBids:
    """The core race: many franchises bidding into the same tick."""

    async def test_same_version_bids_admit_exactly_one(self, room):
        """
        Five franchises all bid quoting the version they can see (0). Serialised
        by the lock, the first to acquire it wins and bumps the version to 1; the
        other four then find their quoted 0 stale and are refused.

        A pass here is the whole point of `lot.version`: without it, all five
        would apply in turn and four would overwrite the winner at the opening
        price. Exactly one success, and the lot moved exactly once.
        """
        _, clients = await _seat_and_open(room)

        results = await asyncio.gather(
            *(room.bid(clients[t], None, 0) for t in clients),
            return_exceptions=True,
        )

        wins = [r for r in results if not isinstance(r, Exception)]
        refusals = [r for r in results if isinstance(r, RoomError)]

        assert len(wins) == 1, f"expected one winner, got {wins}"
        assert len(refusals) == len(clients) - 1
        assert all(r.about == "bid" and "moved" in r.message for r in refusals)

        # The lot moved once and only once, and holds the opening price.
        assert room.lot is not None
        assert room.lot.version == 1
        assert room.lot.bid == room.players[1].base == 200
        assert room.lot.bidder_id in clients
        assert len(room.lot.contenders) == 1

    async def test_unversioned_bids_serialise_up_the_ladder(self, room):
        """
        The same five franchises bidding *without* quoting a version. None is
        stale because none was claimed, so every bid is legal -- but the lock
        still forces them into a sequence, each raising the previous by the
        ladder increment. The end price is therefore deterministic regardless of
        who the scheduler ran first, which is exactly what "no torn read" means.
        """
        _, clients = await _seat_and_open(room)

        results = await asyncio.gather(
            *(room.bid(clients[t], None, None) for t in clients),
            return_exceptions=True,
        )

        assert all(not isinstance(r, Exception) for r in results), results

        # base, then +increment four times: 200 -> 220 -> 240 -> 260 -> 280.
        expected = 200
        for _ in range(len(clients) - 1):
            expected += increment_for(expected)
        assert room.lot.bid == expected == 280
        assert room.lot.version == len(clients) == 5
        assert len(room.lot.contenders) == len(clients)
        assert room.lot.bidder_id in clients


class TestNoDoubleSell:
    """A lot settles once, to one team, at one price."""

    async def test_racing_gavels_settle_once(self, room):
        """
        Two `sell` calls fired at a lot with a standing bid. One brings the
        hammer down; the second arrives to an empty block and is refused. The
        player is sold a single time, and the purse reflects a single payment.
        """
        auctioneer, clients = await _seat_and_open(room)
        await room.bid(clients[1], None, None)  # team 1 holds at base 200

        results = await asyncio.gather(
            room.sell(auctioneer), room.sell(auctioneer),
            return_exceptions=True,
        )

        refusals = [r for r in results if isinstance(r, RoomError)]
        assert len(refusals) == 1
        assert refusals[0].about == "sell"

        record = room.records[1]
        assert record.status == "sold"
        assert record.team_id == 1
        assert record.price == 200
        assert room.lot is None
        assert room.counts()["sold"] == 1


class TestStaleVersionGuard:
    """The version check refuses a bid answering a superseded price."""

    async def test_bid_against_old_version_is_refused(self, room):
        auctioneer, clients = await _seat_and_open(room)
        stale_version = room.lot.version  # 0, before anyone bids

        await room.bid(clients[1], None, None)  # moves the lot to version 1
        assert room.lot.version == 1

        with pytest.raises(RoomError) as excinfo:
            await room.bid(clients[2], None, stale_version)
        assert "moved" in excinfo.value.message
        assert excinfo.value.about == "bid"

        # The refused bid changed nothing: still team 1's lot at the opening price.
        assert room.lot.bidder_id == 1
        assert room.lot.bid == 200
        assert room.lot.version == 1


class TestBudgetInvariants:
    """No franchise wins beyond its purse; accounting never goes negative."""

    async def test_jumpbid_over_the_ceiling_is_refused(self, room):
        _, clients = await _seat_and_open(room)
        ceiling = room.summary_for(1)["max_bid"]

        with pytest.raises(RoomError) as excinfo:
            await room.bid(clients[1], ceiling + 1, None)
        assert excinfo.value.about == "bid"
        assert "budget" in excinfo.value.message.lower()

        # Refused before touching the lot: no bidder, still the opening price.
        assert room.lot.bidder_id is None
        assert room.lot.bid == 200

    async def test_settled_lots_keep_purses_consistent(self, room):
        """
        Two lots run to sale, and every rupee is accounted for once: each buyer's
        spend equals the price it paid, its remaining purse is purse minus spend,
        and nothing is negative.
        """
        auctioneer, clients = await _seat_and_open(room, teams=(1, 2))

        await room.bid(clients[1], None, None)  # team 1 buys player 1 at 200
        await room.sell(auctioneer)

        await room.put_up(auctioneer, 2)
        await room.bid(clients[2], None, None)  # team 2 buys player 2 at 150
        await room.sell(auctioneer)

        purse = room.rules["purse"]
        one, two = room.summary_for(1), room.summary_for(2)
        assert one["spent"] == 200 and one["left"] == purse - 200
        assert two["spent"] == 150 and two["left"] == purse - 150
        assert all(room.summary_for(t)["left"] >= 0 for t in (1, 2))
        assert room.counts()["sold"] == 2


class TestClockSettlementRace:
    """
    The subtle one the code specifically defends against with `_clock_token`.

    A countdown task can pass its `sleep` and then queue on the lock behind a bid
    that lands in the same instant. Cancellation cannot help -- the task is
    already past the point where it checks for cancellation. So each task carries
    the token it was armed with and re-checks it after taking the lock; a bid
    re-arms and bumps that token, and the stale task must then decline to settle.

    This test forces exactly that ordering deterministically: it drives a stale
    countdown body by hand after a fresh bid has moved the token on, and asserts
    it settles nothing.
    """

    async def test_stale_countdown_does_not_settle_a_freshly_bid_lot(self, room):
        auctioneer, clients = await _seat_and_open(room)

        await room.bid(clients[1], None, None)  # team 1 holds; arms a countdown
        stale_token = room._clock_token

        await room.bid(clients[2], None, None)  # team 2 outbids; re-arms, new token
        assert room._clock_token != stale_token
        assert room.lot.bidder_id == 2

        # The countdown from team 1's bid wakes late and tries to settle. Its
        # token is stale, so it must return having done nothing.
        await room._run_clock(stale_token, 0)

        assert room.lot is not None, "stale countdown wrongly settled the lot"
        assert room.lot.bidder_id == 2
        assert room.records[1].status == "available"
