"""
report_card.py
The AUCTONIQ rating, and the reasoning behind it.

This is the analysis half of the per-franchise PDF. It holds no formatting and
no reportlab: given the room and a team, it returns a `TeamCard` of numbers and
sentences, and `report_pdf.py` draws it. Keeping the two apart means the rating
can be checked without rendering a document, which is what the tests do.

**Every figure here is derived, and each one carries its own arithmetic.** That
is the same rule `AuctionIntelligence` sets for the console panel it mirrors:
"an insight you cannot check is a claim; an insight carrying its own arithmetic
is a reading". So each component score below returns a sentence saying what it
was computed from, and those sentences are printed beside the score rather than
kept in the code.

What the dataset does and does not record
-----------------------------------------
The `players` table has rating, base price, cap status, role, nationality and
seventeen batting and bowling statistics. It has **no marquee flag** — the
console says so itself in `bandFor`, which "deliberately stops short of guessing
at the marquee sets ... which are editorial calls the dataset does not record".

The brief asks for marquees to count. Rather than invent a column, a marquee
*tier* is derived from the two things the data does record about standing —
rating and base price — and the PDF labels it as derived. A player in the top
decile of the pool by rating is treated as the marquee tier. That is a reading
of the data, not a claim about the real auction's set list.
"""
from __future__ import annotations

import math
import re
import statistics
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

# ------------------------------------------------------------------ #
# The expected-price model
#
# A "steal" only means anything against an expectation, so the expectation has
# to be stated. It is built from three things the room actually knows: where a
# player's rating sits in the pool, what a franchise's purse is, and what the
# player's base price was.
#
# The shape is deliberately convex. In an auction of 284 players and a 120
# crore purse, spending is not spread evenly across the rating range -- the top
# of the pool takes a large share and the long tail goes at or near base. A
# linear model would price the median player at several crore, which is not
# what happens in the room.
#
# The two constants are editorial and the PDF says so. They are calibrated
# against the worked examples in the brief: a top-of-pool batter is expected
# around 24 crore, so Kohli at 15, Rohit at 16 and Gill at 12 all read as
# steals rather than as fair prices.
# ------------------------------------------------------------------ #

TOP_SHARE = 0.20
"""Fraction of one franchise's purse the very top of the pool is expected to cost."""

CURVE = 5.0
"""Convexity of rating-percentile -> share of purse. Higher pushes the tail to base."""

MIN_SALES_TO_CALIBRATE = 10
"""Below this, the room has not produced a market worth calibrating against."""

CALIBRATION_CLAMP = (0.5, 2.0)
"""However odd one auction gets, the model is not allowed to move more than this."""

# Where a price sits against its expectation, and what to call it.
STEAL_AT = 0.70
GOOD_AT = 0.90
FAIR_AT = 1.15

# The shape of a fieldable eleven. Same quota `Room._pick_xi` selects against,
# repeated here rather than imported because this asks a different question:
# not "who plays" but "is the squad capable of fielding one at all".
XI_QUOTA = {"WK": 1, "BAT": 4, "AR": 2, "BOWL": 3}

ROLE_LABEL = {"WK": "keeper", "BAT": "batter", "AR": "all-rounder", "BOWL": "bowler"}

MARQUEE_PERCENTILE = 0.90
"""Top decile of the pool by rating. Derived, not read from the sheet."""

# How the four components add up. The brief names them in order; the weights
# reflect that a squad you cannot field is a worse outcome than one that paid
# slightly over the odds.
WEIGHTS = {"balance": 0.30, "steals": 0.20, "rating": 0.30, "budget": 0.20}


def _clamp(value: float, low: float = 0.0, high: float = 10.0) -> float:
    return max(low, min(high, value))


@dataclass
class Score:
    """One component of the rating, with the arithmetic that produced it."""

    value: float
    detail: str


@dataclass
class Buy:
    """A player bought, priced against what the model expected."""

    id: int
    name: str
    role: str
    role_short: str
    country: str | None
    overseas: bool
    base: int
    price: int
    rating: float | None
    rating_pct: float
    marquee: bool
    expected: int
    ratio: float
    verdict: str
    headline: str
    """The one statistic worth printing for this player -- see `_headline`."""
    base_assumed: bool
    """
    True when `base` is the auction floor standing in for a missing figure.

    Two thirds of the dataset has no `base_price`. Any reading of a premium
    *over base* has to drop these rows or it measures a premium over 30 lakh,
    which makes every uncapped signing look like a runaway -- the same
    exclusion `AuctionIntelligence` makes for the same reason.
    """


@dataclass
class TeamCard:
    team: dict[str, Any]
    generated_at: float
    purse: int
    spent: int
    left: int
    squad_size: int
    overseas: int
    rules: dict[str, Any]
    buys: list[Buy]
    best: Buy | None
    steals: list[Buy]
    weak_points: list[str]
    components: dict[str, Score]
    overall: float
    verdict_line: str
    ledger: list[dict[str, Any]]
    ledger_truncated: bool
    calibrated: bool
    pool_size: int
    # The readings the Leaderboard & Stats pane shows on screen, carried into
    # the document so the PDF and the console cannot disagree about a squad.
    #
    # This franchise's own figures only. No rank, no standings and no room-wide
    # market line: the document goes to one franchise and must not hand them a
    # reading of anybody else's auction. The pool percentiles below are a
    # property of the 284-player pool, not of another team's squad, which is
    # why they stay.
    squad_rating: float | None
    xi_rating: float | None
    playing_xi: list[dict[str, Any]]
    max_bid: int
    notes: list[str] = field(default_factory=list)


# ------------------------------------------------------------------ #
# Pool statistics
# ------------------------------------------------------------------ #


def _percentile_map(ratings: list[float]) -> dict[float, float]:
    """
    Rating -> its percentile in the pool, as a fraction in [0, 1].

    Computed over distinct ratings so that a rating shared by forty players
    does not get forty different percentiles depending on sort order.
    """
    if not ratings:
        return {}
    ordered = sorted(set(ratings))
    if len(ordered) == 1:
        return {ordered[0]: 1.0}
    span = len(ordered) - 1
    return {value: index / span for index, value in enumerate(ordered)}


def _headline(row: dict[str, Any], role_short: str) -> str:
    """
    One statistic per player, chosen by role.

    The console shows each player through a single standout figure rather than
    a uniform grid of metrics, and the PDF follows it -- a table of seventeen
    columns, two thirds of them null, is not a report anyone reads.
    """

    def num(key: str) -> float | None:
        """
        A figure worth printing, or nothing.

        Zero is rejected as well as null. The dataset stores 0 for a player who
        has no record in that discipline, and "0 runs" printed as somebody's
        standout figure is worse than falling through to the next candidate --
        it reads as a scouting verdict rather than as an empty column.
        """
        value = row.get(key)
        try:
            number = float(value) if value is not None else None
        except (TypeError, ValueError):
            return None
        return number if number else None

    if role_short == "BOWL":
        economy = num("economy")
        wickets = num("wickets")
        if economy is not None:
            return f"{economy:.2f} economy"
        if wickets is not None:
            return f"{wickets:.0f} wickets"
    else:
        strike = num("bat_sr")
        runs = num("total_runs")
        average = num("bat_avg")
        if strike is not None:
            return f"{strike:.1f} strike rate"
        if runs is not None:
            return f"{runs:.0f} runs"
        if average is not None:
            return f"{average:.1f} average"

    matches = num("matches")
    return f"{matches:.0f} matches" if matches is not None else "no record"


# ------------------------------------------------------------------ #
# Expected price
# ------------------------------------------------------------------ #


def _curve_expected(rating_pct: float, base: int, purse: int) -> float:
    """The model's price for a player at this percentile, before calibration."""
    share = TOP_SHARE * (max(0.0, min(1.0, rating_pct)) ** CURVE)
    return max(float(base), share * purse)


def _calibration(
    sales: list[tuple[float, int, int]], purse: int
) -> tuple[float, bool]:
    """
    One number that pulls the curve onto this auction's own market.

    `sales` is (rating_pct, base, price). The median sold player's actual price
    divided by the model's price for them: if this room is paying half what the
    curve says, every expectation moves with it. A single parameter rather than
    a refitted curve, because ten sales cannot support a shape and can support
    a level -- and because a number the report has to explain should be one
    number.
    """
    if len(sales) < MIN_SALES_TO_CALIBRATE:
        return 1.0, False

    ratios = [
        price / expected
        for rating_pct, base, price in sales
        if (expected := _curve_expected(rating_pct, base, purse)) > 0
    ]
    if not ratios:
        return 1.0, False

    low, high = CALIBRATION_CLAMP
    return max(low, min(high, statistics.median(ratios))), True


def _verdict(ratio: float) -> str:
    if ratio <= STEAL_AT:
        return "steal"
    if ratio <= GOOD_AT:
        return "good bid"
    if ratio <= FAIR_AT:
        return "fair price"
    return "paid over"


# ------------------------------------------------------------------ #
# The four components
# ------------------------------------------------------------------ #


def _score_balance(
    buys: list[Buy], rules: dict[str, Any]
) -> tuple[Score, list[str]]:
    """
    Can this squad field a legal eleven, and is it lopsided?

    Three readings, because "balance" is three different failures: a role the
    squad simply cannot fill, a squad too small to be legal, and a squad whose
    money all went to two players.
    """
    weak: list[str] = []
    counts = {key: 0 for key in XI_QUOTA}
    for buy in buys:
        if buy.role_short in counts:
            counts[buy.role_short] += 1

    # --- role coverage -----------------------------------------------------
    missing = 0
    for role, needed in XI_QUOTA.items():
        have = counts[role]
        if have < needed:
            missing += needed - have
            weak.append(
                f"{ROLE_LABEL[role].capitalize()}s: {have} bought, an eleven needs "
                f"{needed}. {needed - have} short."
            )
    coverage = 1.0 - (missing / sum(XI_QUOTA.values()))

    # --- squad size --------------------------------------------------------
    min_squad = int(rules.get("min_squad") or 0)
    size_ratio = min(1.0, len(buys) / min_squad) if min_squad else 1.0
    if min_squad and len(buys) < min_squad:
        weak.append(
            f"Squad of {len(buys)} is under the minimum of {min_squad} — "
            f"{min_squad - len(buys)} more players required."
        )

    # --- overseas ----------------------------------------------------------
    max_overseas = int(rules.get("max_overseas") or 0)
    overseas = sum(1 for buy in buys if buy.overseas)
    if max_overseas and overseas > max_overseas:
        weak.append(
            f"{overseas} overseas players against a cap of {max_overseas} — "
            "the eleven cannot use them all."
        )

    # --- concentration -----------------------------------------------------
    spent = sum(buy.price for buy in buys)
    top_two = sum(sorted((buy.price for buy in buys), reverse=True)[:2])
    concentration = (top_two / spent) if spent else 0.0
    spread = 1.0
    if len(buys) >= 5 and concentration > 0.55:
        spread = max(0.0, 1.0 - (concentration - 0.55) / 0.45)
        weak.append(
            f"Two players account for {concentration * 100:.0f}% of the spend — "
            "the rest of the squad was built on what was left."
        )

    value = _clamp(10.0 * (0.55 * coverage + 0.25 * size_ratio + 0.20 * spread))
    detail = (
        f"{counts['BAT']} batters, {counts['BOWL']} bowlers, {counts['AR']} "
        f"all-rounders, {counts['WK']} keepers across {len(buys)} players; "
        f"{missing} slot(s) of an eleven unfilled; top two buys are "
        f"{concentration * 100:.0f}% of the spend."
    )
    return Score(round(value, 1), detail), weak


def _score_steals(buys: list[Buy]) -> tuple[Score, list[Buy]]:
    """
    How much was bought below its expectation, weighted by who it was.

    A cheap player nobody wanted is not a steal. The weight is the player's own
    rating percentile, so value extracted at the top of the pool counts for
    more than value extracted at the bottom -- which is what the brief asks for
    when it names marquees.
    """
    steals = sorted(
        (buy for buy in buys if buy.verdict == "steal"),
        key=lambda b: (b.rating_pct, 1.0 - b.ratio),
        reverse=True,
    )
    if not buys:
        return Score(0.0, "No players bought."), []

    credit = sum(max(0.0, (STEAL_AT - buy.ratio)) * (0.35 + buy.rating_pct) for buy in buys)
    # Three genuine top-tier steals is an excellent auction; that is the anchor.
    value = _clamp(10.0 * (1.0 - math.exp(-credit / 0.45)))

    marquee_steals = sum(1 for buy in steals if buy.marquee)
    detail = (
        f"{len(steals)} of {len(buys)} buys came in at or under "
        f"{STEAL_AT:.0%} of their expected price"
        + (f", {marquee_steals} of them from the top decile of the pool" if marquee_steals else "")
        + "."
    )
    return Score(round(value, 1), detail), steals


def _score_rating(buys: list[Buy], pool_median: float | None) -> Score:
    """
    Squad quality, measured against the pool that was actually available.

    An absolute mean would score every auction in this dataset the same way;
    the percentile is what says whether a franchise bought the better half of
    what was on the table.
    """
    rated = [buy for buy in buys if buy.rating is not None]
    if not rated:
        return Score(0.0, "No rated players in the squad.")

    mean_rating = statistics.fmean(buy.rating for buy in rated)  # type: ignore[misc]
    mean_pct = statistics.fmean(buy.rating_pct for buy in rated)

    value = _clamp(10.0 * mean_pct)
    detail = (
        f"Squad averages {mean_rating:.2f} across {len(rated)} rated players — "
        f"the {mean_pct:.0%} mark of the pool"
        + (f", whose median rating is {pool_median:.2f}." if pool_median is not None else ".")
    )
    return Score(round(value, 1), detail)


def _score_budget(
    buys: list[Buy], spent: int, purse: int, rules: dict[str, Any]
) -> tuple[Score, list[str]]:
    """
    Did the purse buy rating, and was it used at all?

    Two failures, opposite in direction: money left on the table with an
    incomplete squad, and money spent without quality arriving. Efficiency is
    the ratio of what was paid to what the model expected to pay -- under 1.0
    means the franchise paid less than the pool it bought should have cost.
    """
    weak: list[str] = []
    if not buys:
        return (
            Score(0.0, f"Nothing bought; the full {_cr(purse)} purse is unused."),
            ["No players bought at all — there is no squad to rate."],
        )

    expected_total = sum(buy.expected for buy in buys)
    efficiency = (expected_total / spent) if spent else 0.0
    used = spent / purse if purse else 0.0

    min_squad = int(rules.get("min_squad") or 0)
    incomplete = min_squad and len(buys) < min_squad

    if incomplete and used < 0.6:
        weak.append(
            f"{_cr(purse - spent)} of the purse is unspent on a squad that is "
            f"still {min_squad - len(buys)} short — the money bought nothing."
        )
    elif used < 0.7:
        weak.append(
            f"{_cr(purse - spent)} of the purse went unspent ({1 - used:.0%} of "
            "it). The squad is legal, but that money could have bought a better one."
        )
    if used > 0.97 and incomplete:
        weak.append(
            f"{used:.0%} of the purse is committed with the squad incomplete — "
            "the remaining slots can only be filled at the floor."
        )

    # Paying 20% under the model is a strong auction; paying 20% over is poor.
    efficiency_score = _clamp(5.0 + (efficiency - 1.0) * 12.5)
    # Using the purse counts whether or not the squad is legal. An earlier
    # draft only penalised hoarding when the squad was short, which scored a
    # franchise that filled the minimum eleven cheaply and sat on half its
    # purse a flat ten -- and an unspent purse is a squad that was not bought,
    # not a saving. 85% committed is treated as fully used; a mega auction is
    # not expected to spend to the last lakh.
    usage_score = _clamp(10.0 * min(1.0, used / 0.85))

    value = _clamp(0.6 * efficiency_score + 0.4 * usage_score)
    detail = (
        f"{_cr(spent)} of {_cr(purse)} committed ({used:.0%}) for players the "
        f"model priced at {_cr(int(expected_total))} — "
        f"{'under' if efficiency >= 1 else 'over'} the odds by "
        f"{abs(1 - 1 / efficiency) * 100 if efficiency else 0:.0f}%."
    )
    return Score(round(value, 1), detail), weak


def _cr(lakh: int | float) -> str:
    """₹ in crore, the unit the rest of the product prints."""
    return f"₹{lakh / 100:.2f} Cr"


# ------------------------------------------------------------------ #
# Weak points that need the statistics, not just the squad shape
# ------------------------------------------------------------------ #


def _stat_weaknesses(buys: list[Buy], rows: dict[int, dict[str, Any]]) -> list[str]:
    """
    Readings from the batting and bowling columns, where they exist.

    Each one states its own figures and is skipped when the data cannot support
    it -- a squad whose bowlers have no economy recorded gets no economy note
    rather than a note built on nulls.
    """
    out: list[str] = []

    def numbers(keys: Iterable[int], column: str) -> list[float]:
        values = []
        for pid in keys:
            raw = rows.get(pid, {}).get(column)
            try:
                if raw is not None:
                    values.append(float(raw))
            except (TypeError, ValueError):
                continue
        return values

    bowlers = [buy.id for buy in buys if buy.role_short in ("BOWL", "AR")]
    economies = numbers(bowlers, "economy")
    if len(economies) >= 2:
        best = min(economies)
        if best > 8.0:
            out.append(
                f"No bowler goes at under 8 an over — the best economy in the "
                f"attack is {best:.2f} across {len(economies)} bowlers with a record."
            )

    batters = [buy.id for buy in buys if buy.role_short in ("BAT", "WK", "AR")]
    strikes = numbers(batters, "bat_sr")
    if len(strikes) >= 3:
        best = max(strikes)
        if best < 140:
            out.append(
                f"Nobody in the top order strikes at 140 — the quickest scorer "
                f"bought goes at {best:.1f} across {len(strikes)} batters with a record."
            )

    spin = numbers(batters, "sr_vs_spin")
    pace = numbers(batters, "sr_vs_fast")
    if len(spin) >= 3 and len(pace) >= 3:
        spin_mean, pace_mean = statistics.fmean(spin), statistics.fmean(pace)
        if spin_mean < pace_mean - 15:
            out.append(
                f"The batting is {pace_mean - spin_mean:.0f} strike-rate points "
                f"slower against spin ({spin_mean:.0f}) than pace ({pace_mean:.0f})."
            )

    return out


# ------------------------------------------------------------------ #
# The card
# ------------------------------------------------------------------ #


def build_team_card(room: Any, team_id: int, rows: dict[int, dict[str, Any]]) -> TeamCard:
    """
    Everything one franchise's PDF prints.

    `rows` is the full `players` table keyed by id -- the room's own `Player`
    keeps only eight fields and the report needs the statistics, so the caller
    reads them from SQLite and hands them in. Passing them rather than reading
    them here keeps this module free of the database.
    """
    team = room.team_by_id(team_id)
    if team is None:
        raise ValueError(f"No team with id {team_id}")

    rules = dict(room.rules)
    purse = int(rules.get("purse") or 0)

    ratings = [
        float(player.rating)
        for player in room.players.values()
        if player.rating is not None
    ]
    percentiles = _percentile_map(ratings)
    pool_median = statistics.median(ratings) if ratings else None

    def pct_of(rating: float | None) -> float:
        if rating is None:
            return 0.0
        return percentiles.get(float(rating), 0.0)

    # Calibrate on every sale in the room, not just this team's -- the market
    # is the room's, and a franchise that bought three players has not made one.
    sales: list[tuple[float, int, int]] = []
    for pid, record in room.records.items():
        if record.status != "sold" or record.price is None:
            continue
        player = room.players.get(pid)
        if player is None:
            continue
        sales.append((pct_of(player.rating), player.base, int(record.price)))

    factor, calibrated = _calibration(sales, purse)

    marquee_floor = MARQUEE_PERCENTILE
    buys: list[Buy] = []
    for pid, record in sorted(
        room.records.items(), key=lambda kv: -(kv[1].price or 0)
    ):
        if record.status != "sold" or record.team_id != team_id:
            continue
        player = room.players.get(pid)
        if player is None:
            continue

        price = int(record.price or 0)
        rating_pct = pct_of(player.rating)
        expected = max(1.0, _curve_expected(rating_pct, player.base, purse) * factor)
        ratio = price / expected if expected else 1.0

        buys.append(
            Buy(
                id=pid,
                name=player.name,
                role=player.role,
                role_short=player.role_short,
                country=player.country,
                overseas=player.overseas,
                base=player.base,
                price=price,
                rating=player.rating,
                rating_pct=rating_pct,
                marquee=rating_pct >= marquee_floor,
                expected=int(round(expected)),
                ratio=ratio,
                verdict=_verdict(ratio),
                headline=_headline(rows.get(pid, {}), player.role_short),
                base_assumed=rows.get(pid, {}).get("base_price") in (None, "", 0),
            )
        )

    summary = room.summary_for(team_id)
    spent = int(summary["spent"])

    # The closing report already picks a Playing XI and ranks the franchises.
    # Reusing it rather than re-deriving means the PDF's XI is the same eleven
    # the report screen shows, down to the overseas swap heuristic.
    closing = room.report()
    mine = next(
        (row for row in closing.get("franchises", []) if row["team"]["id"] == team_id),
        None,
    )

    balance, balance_weak = _score_balance(buys, rules)
    steals_score, steals = _score_steals(buys)
    rating_score = _score_rating(buys, pool_median)
    budget, budget_weak = _score_budget(buys, spent, purse, rules)

    components = {
        "balance": balance,
        "steals": steals_score,
        "rating": rating_score,
        "budget": budget,
    }
    overall = round(sum(components[key].value * WEIGHTS[key] for key in WEIGHTS), 1)

    # The best bid is the most value taken, not the biggest cheque: the lowest
    # price against expectation, with the player's standing breaking ties.
    best = min(buys, key=lambda b: (b.ratio, -b.rating_pct)) if buys else None

    weak_points = balance_weak + budget_weak + _stat_weaknesses(buys, rows)
    if not weak_points:
        weak_points.append(
            "Nothing stands out as a weakness: every role of an eleven is "
            "covered, the squad is legal, and the spend is spread."
        )

    return TeamCard(
        team={key: team[key] for key in ("id", "name", "code", "color")},
        generated_at=time.time(),
        purse=purse,
        spent=spent,
        left=int(summary["left"]),
        squad_size=int(summary["size"]),
        overseas=int(summary["overseas"]),
        rules=rules,
        buys=buys,
        best=best,
        steals=steals,
        weak_points=weak_points,
        components=components,
        overall=overall,
        verdict_line=_overall_line(overall),
        ledger=_team_ledger(room.log, team["code"]),
        ledger_truncated=len(room.log) >= 400,
        calibrated=calibrated,
        pool_size=len(room.players),
        squad_rating=(mine or {}).get("squad_rating"),
        xi_rating=(mine or {}).get("xi_rating"),
        playing_xi=(mine or {}).get("playing_xi", []),
        max_bid=int(summary["max_bid"]),
    )


def _overall_line(overall: float) -> str:
    if overall >= 8.5:
        return "An outstanding auction."
    if overall >= 7.0:
        return "A strong auction with a fieldable, well-priced squad."
    if overall >= 5.5:
        return "A sound auction with clear gaps to address."
    if overall >= 4.0:
        return "A mixed auction — the squad works, but it cost more than it should have."
    return "A poor auction: the squad is short, lopsided, or overpriced."


def _team_ledger(log: list[dict[str, Any]], code: str) -> list[dict[str, Any]]:
    """
    The room's ledger, filtered to lines that name this franchise.

    Matched on the code as a whole word. The room writes "MUM bids", "Kohli →
    MUM" and "MUM withdraws", so the code is the only join available -- entries
    carry no team id. A substring match would give CHE every line mentioning
    "CHENNAI"; the word boundary keeps it to the code itself.
    """
    pattern = re.compile(rf"(?<![A-Z]){re.escape(code)}(?![A-Z])")
    return [entry for entry in log if pattern.search(str(entry.get("what", "")))]
