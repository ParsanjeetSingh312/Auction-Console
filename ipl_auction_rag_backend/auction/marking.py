"""
marking.py
The auctioneer's marking scheme, applied to one franchise.

Auction Setup asks the auctioneer which factors a franchise is graded on, in
priority order, up to four (auction/setup_options.py). This module turns that
list into marks: one score out of ten per factor, each carrying the arithmetic
that produced it, weighted by its place in the order into one overall mark.
The franchise's auction report (auction/auction_book_pdf.py) prints them.

Four of the eight factors are the report card's own components and are scored
by the report card (auction/report_card.py), so a room that keeps AUCTONIQ's
default scheme and a room that names the same factors cannot disagree. The
other four are scored here, on the same 0-10 scale and from the same `Buy`
records.

An empty scheme is AUCTONIQ's default: the report card's four components at
their own weights, exactly as before this module existed.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Any

from auction import report_card as rc
from auction.setup_options import FACTORS, weights

#: The report card's components, as marks, when no scheme has been set.
DEFAULT_MARKS = (
    ("balance", "Squad balance"),
    ("steals", "Value found"),
    ("rating", "Squad quality"),
    ("budget", "Use of the purse"),
)

XI_SIZE = 11


@dataclass
class Mark:
    """One factor of the marking scheme, scored for one franchise."""

    key: str
    label: str
    weight: float
    value: float
    detail: str


def score_bidding(buys: list[rc.Buy]) -> rc.Score:
    """
    How efficiently the franchise bid.

    Each buy already carries the room's verdict on its price against what the
    value curve expected (`report_card._verdict`). Two readings are combined:
    the money one -- what the squad should have cost against what was paid,
    so one large overbid is not hidden by five small bargains -- and the count
    one, the share of buys that were steals against the share paid over.
    """
    if not buys:
        return rc.Score(0.0, "No players bought, so there is no bidding to mark.")
    spent = sum(buy.price for buy in buys)
    expected = sum(buy.expected for buy in buys)
    efficiency = (expected / spent) if spent else 0.0
    counts = {verdict: sum(1 for buy in buys if buy.verdict == verdict)
              for verdict in ("steal", "good bid", "fair price", "paid over")}
    swing = (counts["steal"] - counts["paid over"]) / len(buys)
    value = rc._clamp(5.0 + (efficiency - 1.0) * 10.0 + swing * 2.0)
    gap = abs(1 - spent / expected) * 100 if expected else 0.0
    detail = (
        f"{counts['steal']} steals, {counts['good bid']} good bids, {counts['fair price']} at a fair price "
        f"and {counts['paid over']} paid over, across {len(buys)} buys. Paid {rc._cr(spent)} for players "
        f"valued at {rc._cr(expected)}: {gap:.0f}% {'under' if spent <= expected else 'over'} their value."
    )
    return rc.Score(round(value, 1), detail)


def score_xi(buys: list[rc.Buy], xi_ids: list[int]) -> rc.Score:
    """The best eleven the squad can field, against the pool it was bought from."""
    eleven = [buy for buy in buys if buy.id in set(xi_ids)]
    if not eleven:
        return rc.Score(0.0, "No players bought, so there is no eleven to field.")
    rated = [buy for buy in eleven if buy.rating is not None]
    # An unrated player counts at the bottom of the pool, not as a blank: an
    # eleven of unknowns is not the equal of an eleven of proven players.
    mean_pct = statistics.fmean(buy.rating_pct for buy in eleven)
    complete = min(1.0, len(eleven) / XI_SIZE)
    value = rc._clamp(10.0 * mean_pct * complete)
    average = statistics.fmean(buy.rating for buy in rated) if rated else None  # type: ignore[misc]
    detail = (
        f"The eleven has {len(rated)} rated players"
        + (f" averaging {average:.2f}" if average is not None else "")
        + f", at the {mean_pct:.0%} mark of the pool"
        + ("." if len(eleven) >= XI_SIZE else f"; only {len(eleven)} of {XI_SIZE} places can be filled.")
    )
    return rc.Score(round(value, 1), detail)


def score_stars(buys: list[rc.Buy], marquee_ids: set[int]) -> rc.Score:
    """Marquee players signed. Two is a strong auction, four an outstanding one."""
    stars = [buy for buy in buys if buy.id in marquee_ids]
    value = rc._clamp(10.0 * (1.0 - math.exp(-len(stars) / 2.0)))
    names = ", ".join(buy.name for buy in stars[:4]) + (" and others" if len(stars) > 4 else "")
    detail = (
        f"{len(stars)} marquee player{'s' if len(stars) != 1 else ''} signed"
        + (f": {names}." if stars else ".")
    )
    return rc.Score(round(value, 1), detail)


def score_depth(buys: list[rc.Buy], xi_ids: list[int], rules: dict[str, Any]) -> rc.Score:
    """Cover beyond the eleven: how big the bench is, and whether each role has a spare."""
    in_xi = set(xi_ids)
    bench = [buy for buy in buys if buy.id not in in_xi]
    wanted = max(1, int(rules.get("min_squad") or 0) - XI_SIZE)
    size = min(1.0, len(bench) / wanted)
    counts = {role: sum(1 for buy in buys if buy.role_short == role) for role in rc.XI_QUOTA}
    spare = [role for role, needed in rc.XI_QUOTA.items() if counts[role] > needed]
    value = rc._clamp(10.0 * (0.6 * size + 0.4 * len(spare) / len(rc.XI_QUOTA)))
    detail = (
        f"{len(bench)} players beyond the eleven (a squad of {int(rules.get('min_squad') or 0)} "
        f"needs {wanted}); a spare for {len(spare)} of the {len(rc.XI_QUOTA)} roles."
    )
    return rc.Score(round(value, 1), detail)


def build_marks(
    scheme: list[str],
    *,
    components: dict[str, rc.Score],
    buys: list[rc.Buy],
    xi_ids: list[int],
    marquee_ids: set[int],
    rules: dict[str, Any],
) -> tuple[list[Mark], float]:
    """
    The marks for one franchise, and the overall mark they add up to.

    `components` is the report card's own four scores, already computed, so a
    factor the two share is never scored twice in two ways.
    """
    chosen = [key for key in scheme if key in FACTORS]
    if not chosen:
        marks = [
            Mark(key, label, rc.WEIGHTS[key], components[key].value, components[key].detail)
            for key, label in DEFAULT_MARKS
        ]
    else:
        scores: dict[str, rc.Score] = {}
        for key in chosen:
            if key == "balance":
                scores[key] = components["balance"]
            elif key == "rating":
                scores[key] = components["rating"]
            elif key == "purse":
                scores[key] = components["budget"]
            elif key == "steals":
                scores[key] = components["steals"]
            elif key == "bidding":
                scores[key] = score_bidding(buys)
            elif key == "xi":
                scores[key] = score_xi(buys, xi_ids)
            elif key == "stars":
                scores[key] = score_stars(buys, marquee_ids)
            elif key == "depth":
                scores[key] = score_depth(buys, xi_ids, rules)
        marks = [
            Mark(key, FACTORS[key][0], weight, scores[key].value, scores[key].detail)
            for key, weight in zip(chosen, weights(len(chosen)))
        ]
    overall = round(sum(mark.value * mark.weight for mark in marks), 1)
    return marks, overall
