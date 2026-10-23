"""
rules.py
The auction's rulebook: the non-negotiable constants, the host-editable setup,
and the pure functions that decide whether a number is legal.

Nothing in here touches a socket, a lock or the clock. `room.py` owns the state
and calls these; keeping the arithmetic pure is what lets every rule below be
tested in isolation and debugged without a live room.

Money is ₹ lakh throughout (100 lakh = 1 Cr), matching the frontend.

The non-negotiable guidelines, and where each one is enforced
--------------------------------------------------------------
1. Room limit       MAX_TEAMS = 10 in a mega auction, the default room;
                    MINI_TEAMS = 12 in a mini auction (auction/rooms.py). The
                    room's own `max_teams` is the one enforced: `room.join`
                    refuses a seat past it, and the team list never exceeds it.
2. Uniformity       One `rules` dict per room. No team carries its own budget or
                    caps; every limit is read from the room's rules at the moment
                    it is checked, so a host edit lands on all ten at once.
3. Action timer     ACTION_SECONDS = 7, for both the opening window (no bid yet)
                    and the closing window (a bid stands, reset by every bid).
4. Increments       BID_INCREMENT = 25 lakh (0.25 Cr). Jump bids of +5, +10 and
                    +15 Cr are offered as shortcuts; any larger custom jump is
                    legal as long as it lands on the 0.25 Cr grid.
5. Decision buffer  BUFFER_SECONDS = 30, BUFFERS_PER_TEAM = 3. Expiry settles the
                    lot to the last recorded bid (sold if one stands, unsold if
                    none does).
6. Fold / withdraw  Enforced in `room.withdraw`: a folded franchise cannot bid on
                    that lot again, and the lot settles early once every other
                    connected franchise has folded.
7. Briefing         `rules_version` is bumped on every setup change; a franchise
                    must acknowledge the current version before it may bid, fold
                    or buffer. MIN_UNCAPPED = 1 and the minimum overseas figure
                    are the constraints the briefing leads with.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# --------------------------------------------------------------------- #
# Non-negotiable constants. Not editable from the setup panel.
# --------------------------------------------------------------------- #

MAX_TEAMS = 10
# A mini auction seats twelve franchises. Only a room opened as one does; the
# default room, and every mega auction, stays at MAX_TEAMS.
MINI_TEAMS = 12
TEAMS_BY_KIND = {"mega": MAX_TEAMS, "mini": MINI_TEAMS}
ACTION_SECONDS = 7
BUFFER_SECONDS = 30
BUFFERS_PER_TEAM = 3
BID_INCREMENT = 25  # lakh, = 0.25 Cr
JUMP_STEPS = (500, 1000, 1500)  # lakh, = +5 / +10 / +15 Cr
MIN_UNCAPPED = 1

# --------------------------------------------------------------------- #
# Host-editable setup, with its defaults and bounds.
# --------------------------------------------------------------------- #

#: key -> (default, lowest, highest). `max_players` defaults to 0, meaning
#: "the whole pool"; the room replaces it with the pool size when it loads.
SETUP_FIELDS: dict[str, tuple[int, int, int]] = {
    "purse": (12000, 100, 1_000_000),  # Total Budget, lakh
    "max_squad": (25, 1, 100),  # Total Squad: the most players a team may hold
    "min_squad": (18, 1, 100),  # Minimum Players a team must finish with
    "max_players": (0, 0, 10_000),  # Maximum Players to go under the hammer
    "max_overseas": (8, 0, 100),  # Maximum overseas a team may hold
    "min_overseas": (4, 0, 100),  # Minimum overseas a team must finish with
}

#: Players whose arrival on the block plays the marquee reveal in every
#: client: a broken wicket in their franchise colours, highlight stats, a
#: tagline, the jersey number and the name. Matched by pool name. The client's
#: copy (components/Marquee/marqueePlayers.ts) holds the taglines and stats;
#: this one only decides who holds the clock.
MARQUEE_PLAYERS: frozenset[str] = frozenset({
    "Virat Kohli", "Rohit Sharma", "MS Dhoni", "Jasprit Bumrah", "Shubman Gill",
})

#: How long the room holds a marquee lot before bidding opens. A shade longer
#: than the reveal's own 9.2 seconds, so every client has handed back to the
#: bidding screen before the 7-second window starts -- the reveal must never
#: eat into the time a franchise has to bid.
MARQUEE_REVEAL_SECONDS = 9.4

DEFAULT_RULES: dict[str, Any] = {
    **{key: spec[0] for key, spec in SETUP_FIELDS.items()},
    "min_uncapped": MIN_UNCAPPED,
    "increment": BID_INCREMENT,
    "jump_steps": list(JUMP_STEPS),
    "open_seconds": ACTION_SECONDS,
    "close_seconds": ACTION_SECONDS,
    "timeout_seconds": BUFFER_SECONDS,
    "timeouts_per_team": BUFFERS_PER_TEAM,
    "max_teams": MAX_TEAMS,
    # How the room runs (set_mode, before the auction starts):
    #   online   franchises bid on their screens, on the clock
    #   offline  franchises raise placards in the room; no clock and no bids
    #            here -- the auctioneer logs each sale, and nothing moves on
    #            until they do
    "mode": "online",
    # Who holds the chair in an online room: a person, or the AI auctioneer.
    "auctioneer": "manual",
}

MODES = ("online", "offline")
AUCTIONEERS = ("manual", "ai")


def validate_mode(mode: str, auctioneer: str) -> tuple[str, str]:
    """A mode and an auctioneer the room can run, or RuleViolation."""
    if mode not in MODES:
        raise RuleViolation("The mode is online or offline.")
    if auctioneer not in AUCTIONEERS:
        raise RuleViolation("The auctioneer is manual or AI.")
    if mode == "offline" and auctioneer == "ai":
        raise RuleViolation(
            "The AI auctioneer runs online rooms. An offline room is run by the auctioneer in it."
        )
    return mode, auctioneer


def crore(lakh: int) -> str:
    """Always in crore, for figures quoted as rules: "₹0.25 Cr", not "₹25 L"."""
    return f"₹{lakh / 100:g} Cr"


class RuleViolation(ValueError):
    """A setup or a bid the rules refuse. The message is shown to the user."""


def money(lakh: int | float | None) -> str:
    """₹ lakh rendered the way the console renders it."""
    if lakh is None:
        return "—"
    if lakh >= 100:
        return f"₹{lakh / 100:.2f} Cr"
    return f"₹{lakh} L"


# --------------------------------------------------------------------- #
# Setup validation
# --------------------------------------------------------------------- #


@dataclass(frozen=True)
class SquadPosition:
    """What a franchise already holds. All the setup check needs to know."""

    code: str
    size: int
    overseas: int
    spent: int


def validate_setup(proposed: dict[str, int], squads: list[SquadPosition]) -> dict[str, int]:
    """
    Check a host's proposed setup and return the clean values to merge.

    Order matters for debugging: ranges first, then the fields against each
    other, then the rules against squads that already exist. The first failure
    raises, so the host always sees the first broken rule, never a pile.
    """
    clean: dict[str, int] = {}
    for key, (_default, low, high) in SETUP_FIELDS.items():
        if key not in proposed:
            continue
        value = int(proposed[key])
        if not low <= value <= high:
            raise RuleViolation(f"{_label(key)} must be between {low} and {high}.")
        clean[key] = value

    def pick(key: str) -> int:
        return clean.get(key, proposed.get(key, SETUP_FIELDS[key][0]))

    max_squad, min_squad = pick("max_squad"), pick("min_squad")
    max_overseas, min_overseas = pick("max_overseas"), pick("min_overseas")

    if min_squad > max_squad:
        raise RuleViolation(
            f"Minimum Players ({min_squad}) cannot exceed the Total Squad ({max_squad})."
        )
    if max_overseas > max_squad:
        raise RuleViolation(
            f"Maximum overseas ({max_overseas}) cannot exceed the Total Squad ({max_squad})."
        )
    if min_overseas > max_overseas:
        raise RuleViolation(
            f"Minimum overseas ({min_overseas}) cannot exceed the maximum ({max_overseas})."
        )
    if min_overseas + MIN_UNCAPPED > max_squad:
        raise RuleViolation(
            f"A squad of {max_squad} cannot hold {min_overseas} overseas players "
            f"and {MIN_UNCAPPED} uncapped player."
        )

    purse = pick("purse")
    for squad in squads:
        if squad.size > max_squad:
            raise RuleViolation(
                f"{squad.code} already holds {squad.size} players; a Total Squad of "
                f"{max_squad} would make that squad illegal. Reset the auction first."
            )
        if squad.overseas > max_overseas:
            raise RuleViolation(
                f"{squad.code} already holds {squad.overseas} overseas players; a cap "
                f"of {max_overseas} would make that squad illegal. Reset the auction first."
            )
        if squad.spent > purse:
            raise RuleViolation(
                f"{squad.code} has already committed {money(squad.spent)}, more than a "
                f"budget of {money(purse)}. Reset the auction first."
            )
    return clean


def _label(key: str) -> str:
    return {
        "purse": "Total Budget",
        "max_squad": "Total Squad",
        "min_squad": "Minimum Players",
        "max_players": "Maximum Players",
        "max_overseas": "Maximum overseas",
        "min_overseas": "Minimum overseas",
    }.get(key, key)


# --------------------------------------------------------------------- #
# Bid amounts
# --------------------------------------------------------------------- #


def next_ask(base: int, current: int, has_bid: bool, increment: int = BID_INCREMENT) -> int:
    """The standard next bid. The first bid pays the base; every one after adds 0.25 Cr."""
    return current + increment if has_bid else base


def check_bid_amount(
    amount: int | None,
    *,
    base: int,
    current: int,
    has_bid: bool,
    increment: int = BID_INCREMENT,
) -> tuple[int, bool]:
    """
    Resolve a bid request to the price it sets, and whether it is a jump.

    `amount=None` is a standard bid and always resolves to the ask. A named
    amount is a jump bid: it must clear the ask and sit on the 0.25 Cr grid
    measured from where the price stands now (the base, before anyone has bid),
    so no bid can ever produce an off-ladder price.
    """
    ask = next_ask(base, current, has_bid, increment)
    if amount is None:
        return ask, False
    if amount < ask:
        raise RuleViolation(f"A jump bid must be at least the ask of {money(ask)}.")
    anchor = current if has_bid else base
    if (amount - anchor) % increment:
        raise RuleViolation(
            f"Bids move in steps of {crore(increment)}: {money(amount)} is off the ladder."
        )
    return amount, amount > ask


def jump_options(base: int, current: int, has_bid: bool, steps: list[int] | tuple[int, ...] = JUMP_STEPS) -> list[int]:
    """The +5/+10/+15 Cr shortcuts as absolute prices, from where the price stands."""
    anchor = current if has_bid else base
    return [anchor + step for step in steps]


# --------------------------------------------------------------------- #
# Eligibility: the squad places a franchise must keep free
# --------------------------------------------------------------------- #


@dataclass(frozen=True)
class SlotPlan:
    """A franchise's obligations if it signs one more player."""

    slots_free: int  # squad places left after this signing
    overseas_needed: int  # overseas still owed after this signing
    uncapped_needed: int  # uncapped still owed after this signing
    slots_to_fill: int  # signings still required after this one


def slot_plan(
    rules: dict[str, Any],
    *,
    size: int,
    overseas: int,
    uncapped: int,
    signing_overseas: bool = False,
    signing_uncapped: bool = False,
) -> SlotPlan:
    """
    What a franchise would still owe after one more signing.

    Places only, never money. The purse is the whole budget: a franchise may
    bid every rupee of what it has left, and no part of it is held back to
    fill the rest of the squad.

    The overseas and uncapped places are counted as *separate* places (their
    sum), which is the safe reading: it guarantees both minimums can be met
    even if no player in the pool is both overseas and uncapped. The squad
    floor overlaps with them -- any signing counts toward it -- so the places
    still to fill are the larger of the floor and that sum.
    """
    after = size + 1
    overseas_needed = max(0, rules["min_overseas"] - overseas - int(signing_overseas))
    uncapped_needed = max(0, rules["min_uncapped"] - uncapped - int(signing_uncapped))
    floor_needed = max(0, rules["min_squad"] - after)
    slots_to_fill = max(floor_needed, overseas_needed + uncapped_needed)
    return SlotPlan(
        slots_free=max(0, rules["max_squad"] - after),
        overseas_needed=overseas_needed,
        uncapped_needed=uncapped_needed,
        slots_to_fill=slots_to_fill,
    )


def rules_list(rules: dict[str, Any]) -> list[dict[str, str]]:
    """
    The briefing, as data: one entry per guideline, in the order franchises read
    them. Served to the client so the briefing can never quote a number the
    engine is not enforcing.
    """
    jumps = " / ".join(f"+{step // 100} Cr" for step in rules["jump_steps"])
    if rules.get("mode") == "offline":
        # Placards in the room: no clock, no on-screen bids, no buffers.
        return [
            {"id": "room", "title": "Room limit",
             "body": f"At most {rules['max_teams']} franchises compete in one auction room."},
            {"id": "uniform", "title": "Same rules for everyone",
             "body": "Budget, squad size and overseas limits apply identically to every franchise in the room."},
            {"id": "offline", "title": "Bidding in the room",
             "body": "This is an offline auction. Raise your placard to bid; the auctioneer calls the price, and the highest placard when the hammer falls takes the player."},
            {"id": "pace", "title": "No clock",
             "body": "There is no timer. Each player stays on the block until the auctioneer logs the sale, or passes him unsold."},
            {"id": "increment", "title": "Bid increments",
             "body": f"Bids rise by {crore(rules['increment'])}, or more when the auctioneer accepts a jump."},
            {"id": "briefing", "title": "Squad requirements",
             "body": f"Budget {money(rules['purse'])}. Squad of {rules['min_squad']}–{rules['max_squad']} players, with at least {rules['min_overseas']} and at most {rules['max_overseas']} overseas, and at least {rules['min_uncapped']} uncapped player."},
        ]
    return [
        {"id": "room", "title": "Room limit",
         "body": f"At most {rules['max_teams']} franchises compete in one auction room."},
        {"id": "uniform", "title": "Same rules for everyone",
         "body": "Budget, squad size and overseas limits apply identically to every franchise in the room."},
        {"id": "timer", "title": f"{rules['open_seconds']}-second action timer",
         "body": f"When a player is on screen you have {rules['open_seconds']} seconds to bid. Every bid resets the clock to {rules['close_seconds']} seconds."},
        {"id": "increment", "title": "Bid increments",
         "body": f"Each standard bid adds {crore(rules['increment'])}. Jump bids of {jumps} or any higher amount on the {crore(rules['increment'])} ladder are allowed."},
        {"id": "buffer", "title": f"{rules['timeout_seconds']}-second decision buffer",
         "body": f"Pause the {rules['open_seconds']}-second timer to think for {rules['timeout_seconds']} seconds ({rules['timeouts_per_team']} per franchise). If nobody bids before it ends, the player goes to the last recorded bid."},
        {"id": "fold", "title": "Fold / withdraw",
         "body": "Not interested? Withdraw from the current player. You cannot bid on that player again, and the remaining franchises carry on."},
        {"id": "briefing", "title": "Squad requirements",
         "body": f"Budget {money(rules['purse'])}. Squad of {rules['min_squad']}–{rules['max_squad']} players, with at least {rules['min_overseas']} and at most {rules['max_overseas']} overseas, and at least {rules['min_uncapped']} uncapped player."},
    ]
