"""
setup_options.py
What the Auction Setup form offers beyond the numbers: the marking scheme the
auctioneer grades franchises by, and the flow players come to the block in.

Only names, labels and validation live here, with no imports from the rest of
the auction package, so `rules.py` (the briefing), `flow.py` (the draw) and
`marking.py` (the grades) can all read one catalogue without importing each
other.

**The marking scheme.** Up to MAX_FACTORS factors, in priority order. The
order is the weighting: the first factor counts most (`weights`). Every factor
in the catalogue is one the room can actually compute from its own records, so
a grade always carries its arithmetic; an empty scheme means AUCTONIQ's own
four-part rating (auction/report_card.py), unchanged.

**The flow.** Every player belongs to exactly one tier -- the same Marquee,
Prime and Emerging tiers AUCTEAM puts on its cards (aucteam/tiers.py), so the
two screens never disagree about who a marquee player is. The auctioneer
orders the tiers; the draw follows that order as a priority, not as a queue: a
higher tier is more likely to come up next, but the tiers are mixed, so a room
never sits through every Prime player before it sees a Marquee one.
"""
from __future__ import annotations

MAX_FACTORS = 4

#: key -> (label, what it measures). The label is what the auctioneer and the
#: franchises read; the key is what travels on the wire.
FACTORS: dict[str, tuple[str, str]] = {
    "balance": (
        "Team balance",
        "Every role of an eleven covered, a legal squad size, and spend that is not all in two players.",
    ),
    "rating": (
        "Average rating",
        "The squad's average player rating, measured against the pool that was on offer.",
    ),
    "bidding": (
        "Team bidding",
        "How efficiently the franchise bid: paying over a player's value costs marks, paying under or landing a steal earns them.",
    ),
    "xi": (
        "Playing XI strength",
        "The rating of the best eleven the squad can field.",
    ),
    "purse": (
        "Purse management",
        "The budget put to work: not hoarded, and not exhausted with the squad still short.",
    ),
    "steals": (
        "Steals found",
        "Players bought well under their value, counted for more the better the player.",
    ),
    "stars": (
        "Star power",
        "Marquee players signed.",
    ),
    "depth": (
        "Squad depth",
        "Cover beyond the eleven: bench size, and a back-up for every role.",
    ),
}

#: What the setup form is pre-filled with the first time it opens.
EXAMPLE_SCHEME = ["balance", "rating", "bidding"]

#: key -> (label, who is in it). The wording is AUCTEAM's own.
TIERS: dict[str, tuple[str, str]] = {
    "marquee": ("Marquee", "Veterans: the names a franchise is built around."),
    "prime": ("Prime", "High-impact players at the peak of their output."),
    "emerging": ("Emerging", "Young prospects: short on matches, long on upside."),
}

#: AUCTEAM's two-letter tier codes, as the keys above.
TIER_BY_CODE = {"MQ": "marquee", "PR": "prime", "EM": "emerging"}

DEFAULT_FLOW = ["prime", "marquee", "emerging"]

#: Role groups a lot can be generated for, by the room's four-way role code.
LOT_CATEGORIES: dict[str, str] = {
    "BAT": "Batters",
    "BOWL": "Bowlers",
    "AR": "All-rounders",
    "WK": "Wicket-keepers",
}


class SetupError(ValueError):
    """A marking scheme or a flow the room refuses. The message is shown to the user."""


def validate_scheme(scheme: list[str] | None) -> list[str]:
    """Factor keys in priority order: known, distinct, at most MAX_FACTORS."""
    clean: list[str] = []
    for key in scheme or []:
        key = str(key).strip().lower()
        if key not in FACTORS:
            raise SetupError(f"'{key}' is not a factor a franchise can be marked on.")
        if key in clean:
            raise SetupError(f"{FACTORS[key][0]} is in the marking scheme twice.")
        clean.append(key)
    if len(clean) > MAX_FACTORS:
        raise SetupError(f"A marking scheme has at most {MAX_FACTORS} factors.")
    return clean


def validate_flow(flow: list[str] | None) -> list[str]:
    """
    Tier keys in priority order. Every tier must appear exactly once in the
    result, so no player is ever left without a turn: tiers the auctioneer left
    out are added after the ones named, in the default order.
    """
    clean: list[str] = []
    for key in flow or []:
        key = str(key).strip().lower()
        if key not in TIERS:
            raise SetupError(f"'{key}' is not a tier of the player pool.")
        if key in clean:
            raise SetupError(f"{TIERS[key][0]} is in the auction flow twice.")
        clean.append(key)
    clean.extend(key for key in DEFAULT_FLOW if key not in clean)
    return clean


def weights(count: int) -> list[float]:
    """
    Priority order as weights: with four factors 40 / 30 / 20 / 10, with three
    50 / 33 / 17, with two 67 / 33. They always sum to 1.
    """
    if count <= 0:
        return []
    total = count * (count + 1) / 2
    return [(count - index) / total for index in range(count)]


def scheme_labels(scheme: list[str]) -> list[str]:
    return [FACTORS[key][0] for key in scheme if key in FACTORS]


def flow_labels(flow: list[str]) -> list[str]:
    return [TIERS[key][0] for key in flow if key in TIERS]
