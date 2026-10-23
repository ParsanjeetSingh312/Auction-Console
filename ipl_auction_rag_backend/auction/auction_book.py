"""
auction_book.py
One franchise's auction report: the analysis, with no drawing in it.

`auction_book_pdf.py` draws what this returns. Keeping the two apart means every
figure here can be checked by a test without rendering a page -- the same split
`report_card.py` / `report_pdf.py` already make.

**Every franchise gets its own document.** Most pages describe that franchise
alone: its day in numbers, its price bands, what each role cost it, its role
mix, its value for money and its career record. Four sections are deliberately
the same in every franchise's PDF, because they are the auction's public story
rather than anybody's scouting:

  * top bids -- the record bid on the cover, and
  * the ten most expensive signings,
  * the moments of the day,
  * the awards nobody asked for (with the comeback kings).

**Adapted to what AUCTONIQ records.** The reference book was built from
registration forms that carried ages and home localities; this product's pool
does not. So "youngest / most experienced squad" is read from career matches,
"debutant" becomes "uncapped", and the locality awards are left out rather than
invented.
"""
from __future__ import annotations

import statistics
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from auction.report_card import TeamCard, _headline

#: Auction times are printed in Indian Standard Time: the product, its rooms and
#: its users are Indian, and a server in UTC would otherwise stamp a 7 pm
#: auction as 13:30.
IST = timezone(timedelta(hours=5, minutes=30), "IST")

QUARTER_HOUR = 15 * 60

ROLE_ORDER = ["BAT", "WK", "AR", "BOWL"]
ROLE_NAME = {"BAT": "Batter", "WK": "Wicket-keeper", "AR": "All-rounder", "BOWL": "Bowler"}

#: Impact = career runs + 25 x career wickets, so a wicket counts like 25 runs
#: (the reference book's own weighting).
WICKET_WEIGHT = 25

#: Below this many IPL matches a career is too short to price impact against.
MIN_MATCHES_FOR_VALUE = 10


def clock(ts: float | None) -> str:
    return datetime.fromtimestamp(ts, IST).strftime("%H:%M") if ts else "--:--"


def money(lakh: float | int | None) -> str:
    """₹ in crore from 1 Cr up, lakh below -- how the room itself prints prices."""
    if lakh is None:
        return "-"
    if lakh >= 100:
        return f"₹{lakh / 100:.2f} Cr"
    return f"₹{round(lakh, 1):g} L"


@dataclass
class Sale:
    """One settled sale, joined to the player and the franchise."""

    player_id: int
    name: str
    role_short: str
    overseas: bool
    uncapped: bool
    base: int
    price: int
    team_id: int
    team_name: str
    team_code: str
    team_color: str
    ts: float | None
    unsold_before: int
    matches: int | None
    runs: int | None
    wickets: int | None
    headline: str
    jersey: int | None = None
    """Shirt number from the pool. None means unverified, never zero."""

    @property
    def impact(self) -> int:
        return int(self.runs or 0) + WICKET_WEIGHT * int(self.wickets or 0)

    @property
    def at_base(self) -> bool:
        return self.price <= self.base


@dataclass
class Moment:
    at: str
    title: str
    detail: str


@dataclass
class Award:
    title: str
    team_name: str
    team_color: str
    detail: str


@dataclass
class Bar:
    label: str
    value: float
    text: str
    color: str | None = None


@dataclass
class FranchiseReport:
    # --- identity -------------------------------------------------------
    room_code: str
    generated_at: float
    team: dict[str, Any]
    teams: list[dict[str, Any]]
    """Every franchise in the room: names and colours only, for the cover."""
    season_through: int | None

    # --- shared: the auction's public story -----------------------------
    top_bid: Sale | None
    total_sold: int
    ten_most_expensive: list[Sale]
    moments: list[Moment]
    awards: list[Award]
    comeback_kings: list[Sale]
    auction_minutes: int | None
    started_at: float | None
    ended_at: float | None

    # --- this franchise's own figures -----------------------------------
    purse: int
    spent: int
    left: int
    buys: list[Sale]
    numbers: list[tuple[str, str, str]]
    """(value, label, sub-label) tiles for the day in numbers."""
    price_bands: list[Bar]
    role_cost: list[Bar]
    concentration: list[tuple[str, str, str]]
    """(label, amount, share) rows: how concentrated this franchise's spend was."""
    priciest_by_role: list[Sale]
    role_mix: list[Bar]
    mix_detail: list[tuple[str, str]]
    value_points: list[Sale]
    steals: list[tuple[Sale, float]]
    paid_for_potential: list[tuple[Sale, float]]
    run_leaders: list[Sale]
    wicket_leaders: list[Sale]
    experience_bands: list[Bar]
    combined_impact: int
    batting_depth: list[Bar]
    bowling_depth: list[Bar]
    total_runs: int
    total_wickets: int
    card: TeamCard | None = None
    notes: list[str] = field(default_factory=list)


# ------------------------------------------------------------------ #
# Building blocks
# ------------------------------------------------------------------ #


def _int(row: dict[str, Any], key: str) -> int | None:
    value = row.get(key)
    try:
        return int(float(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def _sales(room: Any, rows: dict[int, dict[str, Any]]) -> list[Sale]:
    teams = {t["id"]: t for t in room.teams}
    out: list[Sale] = []
    for pid, record in room.records.items():
        if record.status != "sold" or record.price is None or record.team_id not in teams:
            continue
        player = room.players.get(pid)
        if player is None:
            continue
        row = rows.get(pid, {})
        team = teams[record.team_id]
        out.append(Sale(
            player_id=pid,
            name=player.name,
            role_short=player.role_short,
            overseas=bool(player.overseas),
            uncapped=bool(getattr(player, "uncapped", False)),
            base=int(player.base),
            price=int(record.price),
            team_id=team["id"],
            team_name=team["name"],
            team_code=team["code"],
            team_color=team.get("color") or "#888888",
            ts=getattr(record, "ts", None),
            unsold_before=int(getattr(record, "unsold_count", 0) or 0),
            matches=_int(row, "matches"),
            runs=_int(row, "total_runs"),
            wickets=_int(row, "wickets"),
            headline=_headline(row, player.role_short) if row else "",
            jersey=_int(row, "jersey_number"),
        ))
    return out


def _by_time(sales: list[Sale]) -> list[Sale]:
    """Sales in the order the hammer fell. Untimed sales (older rooms) last."""
    return sorted(sales, key=lambda s: (s.ts is None, s.ts or 0, s.player_id))


def _squad_milestone(
    sales: list[Sale], target: int
) -> tuple[str, int, float] | None:
    """(team code, how many buys, when) for the first franchise to reach `target`."""
    if target <= 0:
        return None
    counts: dict[str, int] = {}
    for sale in _by_time(sales):
        counts[sale.team_code] = counts.get(sale.team_code, 0) + 1
        if counts[sale.team_code] == target and sale.ts:
            return sale.team_code, target, sale.ts
    return None


def _moments(room: Any, sales: list[Sale]) -> list[Moment]:
    timed = [s for s in _by_time(sales) if s.ts]
    if not timed:
        return []
    out: list[Moment] = []
    first, last = timed[0], timed[-1]
    out.append(Moment(clock(first.ts), "First buy of the day",
                      f"{first.name} to {first.team_name} for {money(first.price)}"))

    record = max(timed, key=lambda s: (s.price, -(s.ts or 0)))
    out.append(Moment(clock(record.ts), "Record bid",
                      f"{record.name} goes to {record.team_name} for {money(record.price)}"))

    origin = room.started_at or first.ts
    buckets: dict[int, list[Sale]] = {}
    for sale in timed:
        buckets.setdefault(int((sale.ts - origin) // QUARTER_HOUR), []).append(sale)
    if len(buckets) > 1:
        busiest = max(buckets.items(), key=lambda kv: (len(kv[1]), -kv[0]))
        richest = max(buckets.items(), key=lambda kv: (sum(s.price for s in kv[1]), -kv[0]))
        start = origin + busiest[0] * QUARTER_HOUR
        out.append(Moment(
            f"{clock(start)}–{clock(start + QUARTER_HOUR)}", "Frenzy quarter-hour",
            f"{len(busiest[1])} sales, {money(sum(s.price for s in busiest[1]))} in 15 minutes",
        ))
        start = origin + richest[0] * QUARTER_HOUR
        out.append(Moment(
            clock(start), "Richest quarter-hour",
            f"{money(sum(s.price for s in richest[1]))} across {len(richest[1])} sales",
        ))

    if len(timed) > 1:
        gaps = [(b.ts - a.ts, a, b) for a, b in zip(timed, timed[1:])]
        gap, before, after = max(gaps, key=lambda g: g[0])
        if gap >= 60:
            out.append(Moment(clock(before.ts), "Longest silence",
                              f"{gap / 60:.0f} minutes between {before.name} and {after.name}"))

    comeback = next((s for s in timed if s.unsold_before), None)
    if comeback:
        out.append(Moment(clock(comeback.ts), "The unsold return",
                          f"{comeback.name}, unsold earlier, goes to {comeback.team_name} "
                          f"for {money(comeback.price)}"))

    rules = getattr(room, "rules", {}) or {}
    full = _squad_milestone(sales, int(rules.get("max_squad") or 0))
    label = "First full squad"
    if full is None:
        full = _squad_milestone(sales, int(rules.get("min_squad") or 0))
        label = "First legal squad"
    if full:
        team = next((s.team_name for s in sales if s.team_code == full[0]), full[0])
        out.append(Moment(clock(full[2]), label, f"{team}, with its {full[1]}th buy"))

    out.append(Moment(clock(last.ts), "Final hammer",
                      f"{last.name} completes {last.team_name}'s auction"))
    return sorted(out, key=lambda m: m.at)


def _awards(room: Any, sales: list[Sale]) -> list[Award]:
    """The awards nobody asked for. Shared by every franchise's report."""
    teams = [t for t in room.teams]
    by_team: dict[int, list[Sale]] = {t["id"]: [] for t in teams}
    for sale in sales:
        by_team.setdefault(sale.team_id, []).append(sale)
    color = {t["id"]: t.get("color") or "#888888" for t in teams}
    name = {t["id"]: t["name"] for t in teams}
    purse = int((getattr(room, "rules", {}) or {}).get("purse") or 0)
    awards: list[Award] = []

    def give(title: str, team_id: int, detail: str) -> None:
        awards.append(Award(title, name[team_id], color[team_id], detail))

    rules = getattr(room, "rules", {}) or {}
    for target, title in ((int(rules.get("max_squad") or 0), "Fastest to a full squad"),
                          (int(rules.get("min_squad") or 0), "Fastest to a legal squad")):
        hit = _squad_milestone(sales, target)
        if hit:
            team_id = next(s.team_id for s in sales if s.team_code == hit[0])
            give(title, team_id, f"{hit[1]}th buy at {clock(hit[2])}")
            break

    active = [t["id"] for t in teams if by_team.get(t["id"])]
    if not active:
        return awards

    spent = {tid: sum(s.price for s in by_team[tid]) for tid in active}
    stingy = max(active, key=lambda tid: purse - spent[tid])
    give("Cash left on the table", stingy, f"{money(purse - spent[stingy])} unspent")

    biggest = max(sales, key=lambda s: s.price)
    give("Biggest single cheque", biggest.team_id, f"{biggest.name} · {money(biggest.price)}")

    def most(title: str, predicate, phrase: str) -> None:
        counts = {tid: sum(1 for s in by_team[tid] if predicate(s)) for tid in active}
        winner = max(active, key=lambda tid: counts[tid])
        if counts[winner]:
            give(title, winner, f"{counts[winner]} {phrase}")

    most("Bargain hunter", lambda s: s.at_base, "players at base price")
    most("Uncapped den", lambda s: s.uncapped, "uncapped players")

    experienced = {
        tid: statistics.fmean(s.matches for s in by_team[tid] if s.matches is not None)
        for tid in active
        if sum(1 for s in by_team[tid] if s.matches is not None) >= 3
    }
    if len(experienced) >= 2:
        old = max(experienced, key=experienced.get)
        fresh = min(experienced, key=experienced.get)
        give("Most experienced squad", old, f"average {experienced[old]:.0f} IPL matches")
        give("Fresh legs", fresh, f"average {experienced[fresh]:.0f} IPL matches")

    most("Round-two raider", lambda s: s.unsold_before > 0, "players picked from the unsold pile")

    uncapped = [s for s in sales if s.uncapped]
    if uncapped:
        gamble = max(uncapped, key=lambda s: s.price)
        give("Biggest gamble on an uncapped player", gamble.team_id,
             f"{gamble.name} · {money(gamble.price)}")

    returned = [s for s in sales if s.unsold_before]
    if returned:
        best = max(returned, key=lambda s: s.price)
        give("Comeback of the day", best.team_id,
             f"{best.name} — unsold, then {money(best.price)}")
    return awards


def _bars(values: list[tuple[str, float, str]], color: str | None = None) -> list[Bar]:
    return [Bar(label, value, text, color) for label, value, text in values]


def _price_bands(buys: list[Sale]) -> list[Bar]:
    bands = [
        ("Base price", lambda s: s.at_base),
        ("Under ₹1 Cr", lambda s: not s.at_base and s.price < 100),
        ("₹1–5 Cr", lambda s: not s.at_base and 100 <= s.price < 500),
        ("₹5–10 Cr", lambda s: not s.at_base and 500 <= s.price < 1000),
        ("₹10–20 Cr", lambda s: not s.at_base and 1000 <= s.price < 2000),
        ("₹20 Cr +", lambda s: not s.at_base and s.price >= 2000),
    ]
    out = []
    for label, test in bands:
        count = sum(1 for s in buys if test(s))
        out.append(Bar(label, count, f"{count} player{'s' if count != 1 else ''}"))
    return out


# ------------------------------------------------------------------ #
# The report
# ------------------------------------------------------------------ #


def build_franchise_report(
    room: Any,
    team_id: int,
    rows: dict[int, dict[str, Any]],
    *,
    card: TeamCard | None = None,
    season_through: int | None = None,
) -> FranchiseReport:
    team = room.team_by_id(team_id)
    if team is None:
        raise ValueError(f"No team with id {team_id}")

    rules = dict(getattr(room, "rules", {}) or {})
    purse = int(rules.get("purse") or 0)
    sales = _sales(room, rows)
    buys = sorted((s for s in sales if s.team_id == team_id), key=lambda s: -s.price)
    spent = sum(s.price for s in buys)

    timed = [s.ts for s in sales if s.ts]
    started = getattr(room, "started_at", None) or (min(timed) if timed else None)
    unsold_ts = [r.ts for r in room.records.values() if r.status == "unsold" and getattr(r, "ts", None)]
    ended = getattr(room, "finished_at", None) or (max(timed + unsold_ts) if timed else None)
    minutes = int(round((ended - started) / 60)) if started and ended and ended > started else None

    # --- the day in numbers (own) ---------------------------------------
    prices = [s.price for s in buys]
    numbers = [
        (str(len(buys)), "Players bought", f"{len(sales)} sold in the room"),
        (money(spent), "Purse spent", f"of {money(purse)}"),
        (f"{(spent / purse * 100) if purse else 0:.1f}%", "Of the purse used",
         f"{money(purse - spent)} left"),
        (f"{minutes} min" if minutes is not None else "—", "Auction length",
         f"{clock(started)} to {clock(ended)}" if started and ended else "not timed"),
        (money(statistics.fmean(prices)) if prices else "—", "Average price",
         f"median {money(statistics.median(prices))}" if prices else ""),
        (money(max(prices)) if prices else "—", "Biggest cheque",
         buys[0].name if buys else ""),
        (str(sum(1 for s in buys if s.at_base)), "At base price", "bought without a contest"),
        (str(sum(1 for s in buys if s.unsold_before)), "Comebacks", "unsold once, bought later"),
    ]

    role_cost = []
    for role in ROLE_ORDER:
        mine = [s.price for s in buys if s.role_short == role]
        if mine:
            avg = statistics.fmean(mine)
            role_cost.append(Bar(ROLE_NAME[role], avg, f"avg {money(avg)} · {len(mine)}"))

    def share(n: int) -> tuple[str, str, str]:
        amount = sum(prices[:n])
        return ("Top player" if n == 1 else f"Top {n} players", money(amount), f"{(amount / spent * 100) if spent else 0:.1f}%")

    concentration = [share(n) for n in (1, 3, 5) if len(prices) >= n]
    at_base = [s for s in buys if s.at_base]
    concentration.append(("Bought at base price", f"{len(at_base)} players",
                          f"{(sum(s.price for s in at_base) / spent * 100) if spent else 0:.1f}%"))

    priciest_by_role = []
    for role in ROLE_ORDER:
        top = next((s for s in buys if s.role_short == role), None)
        if top:
            priciest_by_role.append(top)

    role_mix = [
        Bar(ROLE_NAME[r], sum(1 for s in buys if s.role_short == r),
            str(sum(1 for s in buys if s.role_short == r)))
        for r in ROLE_ORDER
    ]
    overseas = sum(1 for s in buys if s.overseas)
    uncapped = sum(1 for s in buys if s.uncapped)
    mix_detail = [
        ("Squad", f"{len(buys)} players"),
        ("Indian / overseas", f"{len(buys) - overseas} / {overseas}"),
        ("Capped / uncapped", f"{len(buys) - uncapped} / {uncapped}"),
    ]

    # --- value for money (own) -------------------------------------------
    with_record = [s for s in buys if (s.matches or 0) >= MIN_MATCHES_FOR_VALUE and s.price > 0]
    per_crore = sorted(((s, s.impact / (s.price / 100)) for s in with_record),
                       key=lambda t: t[1], reverse=True)
    steals = per_crore[:6]
    # Only the players not already named as steals, so the two lists never
    # contradict each other on a small squad.
    paid_for_potential = sorted(per_crore[len(steals):], key=lambda t: t[1])[:5]
    run_leaders = sorted((s for s in buys if s.runs), key=lambda s: -(s.runs or 0))[:5]
    wicket_leaders = sorted((s for s in buys if s.wickets), key=lambda s: -(s.wickets or 0))[:5]

    experience_bands = []
    for label, low, high in (("Under 20 matches", 0, 19), ("20–49", 20, 49),
                             ("50–99", 50, 99), ("100 + matches", 100, 10_000)):
        band = [s.price for s in buys if s.matches is not None and low <= s.matches <= high]
        avg = statistics.fmean(band) if band else 0
        experience_bands.append(Bar(label, avg, f"avg {money(avg)} · {len(band)}" if band else "none"))

    # --- career record (own) ---------------------------------------------
    total_runs = sum(s.runs or 0 for s in buys)
    total_wickets = sum(s.wickets or 0 for s in buys)
    batting_depth = [Bar(s.name, float(s.runs or 0), f"{(s.runs or 0):,} runs")
                     for s in sorted((s for s in buys if s.runs), key=lambda s: -(s.runs or 0))[:10]]
    bowling_depth = [Bar(s.name, float(s.wickets or 0), f"{(s.wickets or 0)} wkts")
                     for s in sorted((s for s in buys if s.wickets), key=lambda s: -(s.wickets or 0))[:10]]

    report = FranchiseReport(
        room_code=getattr(room, "code", "MAIN"),
        generated_at=time.time(),
        team={k: team.get(k) for k in ("id", "name", "code", "color")},
        teams=[{k: t.get(k) for k in ("id", "name", "code", "color")} for t in room.teams],
        season_through=season_through,
        top_bid=max(sales, key=lambda s: s.price) if sales else None,
        total_sold=len(sales),
        ten_most_expensive=sorted(sales, key=lambda s: (-s.price, s.ts or 0))[:10],
        moments=_moments(room, sales),
        awards=_awards(room, sales),
        comeback_kings=sorted((s for s in sales if s.unsold_before),
                              key=lambda s: (-s.unsold_before, -s.price))[:16],
        auction_minutes=minutes,
        started_at=started,
        ended_at=ended,
        purse=purse,
        spent=spent,
        left=purse - spent,
        buys=buys,
        numbers=numbers,
        price_bands=_price_bands(buys),
        role_cost=role_cost,
        concentration=concentration,
        priciest_by_role=priciest_by_role,
        role_mix=role_mix,
        mix_detail=mix_detail,
        value_points=with_record,
        steals=steals,
        paid_for_potential=paid_for_potential,
        run_leaders=run_leaders,
        wicket_leaders=wicket_leaders,
        experience_bands=experience_bands,
        combined_impact=total_runs + WICKET_WEIGHT * total_wickets,
        batting_depth=batting_depth,
        bowling_depth=bowling_depth,
        total_runs=total_runs,
        total_wickets=total_wickets,
        card=card,
    )
    if not any(s.ts for s in sales):
        report.notes.append("This room recorded no sale times, so the moments page is empty.")
    return report
