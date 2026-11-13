"""
flow.py
The order players come to the block in.

The room used to draw the next player with `random.choice` over everyone still
available. In a pool where most players are squad and uncapped names, that
produces exactly what it sounds like: long runs of players nobody is waiting
for, and the names the room came for arriving late or in a clump. This module
replaces that draw.

**Tiers.** Every player belongs to exactly one of AUCTEAM's three
(aucteam/tiers.py): Marquee, Prime or Emerging. The room works it out once,
when the pool is loaded (`AuctionRoom.load_players`), and keeps it on the
player, so this module only reads it.

**The flow.** The auctioneer orders the tiers in Auction Setup. That order is
a priority, not a queue: each draw first picks a tier at random, weighted so
an earlier tier is twice as likely as the one after it, then a player inside
it. So with Prime > Marquee > Emerging the room sees mostly Prime and Marquee
players early, with the others mixed in, instead of every Prime player before
the first Marquee one.

**Inside a tier, rated players come sooner.** A tier holds proven names and
squad players alike. A player with a rating is RATED_WEIGHT times as likely to
be picked as one without, so the players the room is waiting for arrive while
purses are still full, without the unrated ones being shut out.

**Two guards against a dull run**, both soft (they yield when there is no
alternative):

    MAX_TIER_RUN   no more than this many lots in a row from one tier
    MAX_ROLE_RUN   no more than this many in a row of one role

Pure functions over the room's players. No clock, no lock, no socket: the room
decides *when* to draw (auction/room.py) and asks this module *whom*.
"""
from __future__ import annotations

import random
from typing import Any, Iterable, Sequence

from auction.setup_options import DEFAULT_FLOW, TIERS

MAX_TIER_RUN = 3
MAX_ROLE_RUN = 3

#: How much likelier a rated player is than an unrated one in the same tier.
RATED_WEIGHT = 3.0

#: How many recent lots the room remembers for the two guards above.
HISTORY = 12


def tier_of(player: Any) -> str:
    """
    The one tier `player` belongs to.

    Read from the player, where the room put it at load. A player without one
    (a hand-built `Player` in a test, a pool loaded by an older path) falls
    back to the plainest reading the room's own fields allow.
    """
    tier = getattr(player, "tier", None)
    if tier in TIERS:
        return tier
    return "emerging" if getattr(player, "uncapped", False) else "prime"


def tier_weights(flow: Sequence[str]) -> dict[str, float]:
    """Earlier in the flow is twice as likely as the tier after it."""
    order = list(flow) or list(DEFAULT_FLOW)
    return {key: float(2 ** (len(order) - 1 - index)) for index, key in enumerate(order)}


def _run_of(values: Sequence[str]) -> tuple[str | None, int]:
    """The value the history ends on, and how many times in a row."""
    if not values:
        return None, 0
    last, count = values[-1], 0
    for value in reversed(values):
        if value != last:
            break
        count += 1
    return last, count


def pick(
    candidates: Sequence[Any],
    flow: Sequence[str],
    history: Sequence[tuple[str, str]] = (),
    *,
    rng: random.Random | None = None,
) -> Any | None:
    """
    The next player from `candidates`, following `flow`.

    `history` is the (tier, role) of recent lots, oldest first; it is what the
    two run guards read. Returns None only when there is nobody to pick.
    """
    if not candidates:
        return None
    rng = rng or random

    by_tier: dict[str, list[Any]] = {}
    for player in candidates:
        by_tier.setdefault(tier_of(player), []).append(player)

    weights = tier_weights(flow)
    open_tiers = [key for key in weights if by_tier.get(key)]
    # A tier the flow does not name (a pool with a tier added later) still
    # gets its turn, at the lowest weight.
    open_tiers += [key for key in by_tier if key not in weights]

    tier_run, tier_count = _run_of([tier for tier, _ in history])
    if tier_count >= MAX_TIER_RUN and len(open_tiers) > 1 and tier_run in open_tiers:
        open_tiers = [key for key in open_tiers if key != tier_run]

    tier = rng.choices(open_tiers, weights=[weights.get(key, 1.0) for key in open_tiers])[0]
    pool = by_tier[tier]

    role_run, role_count = _run_of([role for _, role in history])
    if role_count >= MAX_ROLE_RUN:
        others = [p for p in pool if getattr(p, "role_short", None) != role_run]
        if others:
            pool = others
    return rng.choices(
        pool,
        weights=[RATED_WEIGHT if getattr(p, "rating", None) is not None else 1.0 for p in pool],
    )[0]


def build_lot(
    candidates: Sequence[Any],
    flow: Sequence[str],
    size: int,
    *,
    rng: random.Random | None = None,
) -> list[Any]:
    """
    A generated lot: up to `size` of `candidates`, in the order they will come
    up. The order follows the flow the same way a single draw does, so a lot of
    bowlers still leads with the tiers the auctioneer put first.
    """
    left = list(candidates)
    lot: list[Any] = []
    history: list[tuple[str, str]] = []
    while left and len(lot) < size:
        player = pick(left, flow, history, rng=rng)
        if player is None:
            break
        lot.append(player)
        left.remove(player)
        # Only the tier run matters inside a lot: it is usually one role.
        history.append((tier_of(player), ""))
    return lot


def tier_counts(players: Iterable[Any], available: Iterable[Any]) -> list[dict[str, Any]]:
    """Per tier: how many players it holds and how many are still to come."""
    total = {key: 0 for key in TIERS}
    left = {key: 0 for key in TIERS}
    for player in players:
        total[tier_of(player)] += 1
    for player in available:
        left[tier_of(player)] += 1
    return [
        {"key": key, "label": TIERS[key][0], "blurb": TIERS[key][1], "total": total[key], "left": left[key]}
        for key in TIERS
    ]
