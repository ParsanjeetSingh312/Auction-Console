"""
career_stats.py
Full IPL career figures for every pool player, from Cricsheet's ball-by-ball
archive.

**Why not `data_researcher.aggregate_cricsheet`.** That function answers a
different question -- current form over the last three seasons -- and was never
meant to fill the career columns. It writes "total_runs" from three seasons,
leaves `matches` alone and computes none of the matchup splits, which is how the
site came to show Virat Kohli at 7,697 runs from the spreadsheet long after he
had passed 9,000. This module computes the whole career, every column the
console and SCOUT show:

  batters    matches, runs, average, strike rate, strike rate vs pace and vs
             spin, boundary % vs pace and vs spin
  bowlers    matches, wickets, runs conceded, economy, average, strike rate,
             economy vs left- and right-hand batters
  all-rounders get both.

**Identity.** Cricsheet gives every person a registry id, and the aggregation is
keyed by it, so two "R Sharma"s are two people. Mapping an identity onto a pool
row reuses `rag_pipeline.resolve_player`. When several identities resolve to the
same pool player, the one who played most recently wins: everyone in the pool is
a 2026 auction candidate, and the namesake who retired in 2014 is not. An
identity that matched on initials rather than the full name must also have
played within `RECENT_SEASONS`, because an uncapped pool player with no IPL
record would otherwise inherit a retired namesake's career.

**The matchup splits need the other player's style** (pace or spin bowler,
left- or right-hand batter), which the archive does not record. That comes from
`player_styles`. Deliveries involving an unclassified opponent are left out of
the split, and a split built on fewer than `MIN_SPLIT_BALLS` deliveries is not
written at all.
"""
from __future__ import annotations

import json
import logging
import time
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from scout.schemas.player import PlayerStatUpdate, PlayerUpdate, PlayerValuation, SourceRef
from scout.tools.player_styles import Person, Style, resolve_styles
from scout.tools.rag_pipeline import MATCH_THRESHOLD, resolve_player

logger = logging.getLogger(__name__)

SOURCE_ID = "cricsheet-career"

#: Below this a rate is noise rather than a record.
MIN_BALLS_FOR_SR = 30
MIN_BALLS_FOR_ECONOMY = 30
MIN_SPLIT_BALLS = 30

#: An identity matched on initials (not the full name) must have played in one
#: of the archive's last this-many seasons to be attributed to a pool player.
RECENT_SEASONS = 4

_NOT_FACED = ("wides",)
_NOT_BOWLED = ("wides", "noballs")
_NOT_BOWLER_FAULT = ("byes", "legbyes")
_NOT_BOWLER_WICKET = {"run out", "retired hurt", "retired not out", "obstructing the field"}
_NOT_A_DISMISSAL = {"retired hurt", "retired not out"}

#: Pool name -> the scorecard name Cricsheet uses, for players the resolver
#: cannot bridge on its own (a different given name, a surname the scorecard
#: drops, a common surname that ties). Each was checked against the archive on
#: 2026-10-23, so an alias is trusted over the recency rule.
ALIASES: dict[str, str] = {
    "Rinku Singh": "RK Singh",
    "Varun Chakravarthy": "CV Varun",
    "Wanindu Hasaranga": "PWH de Silva",
    "Rasikh Dar": "Rasikh Salam",
    "Karn Sharma": "KV Sharma",
    "Dasun Shanaka": "MD Shanaka",
    "Alex Carey": "AT Carey",
    "Syed Khaleel Ahmed": "KK Ahmed",
    "Prashant Solanki": "PH Solanki",
    "Steve Smith": "SPD Smith",
    "Odean Smith": "OF Smith",
    "Tom Banton": "T Banton",
    "Sam Billings": "SW Billings",
    "Josh Philippe": "JR Philippe",
    "Dushmantha Chameera": "PVD Chameera",
    "Tabraiz Shamsi": "T Shamsi",
    "Yudhvir Charak": "Yudhvir Singh",
    "Baba Indrajith": "B Indrajith",
    "Ishan Porel": "IC Porel",
    "Jagadeesha Suchith": "J Suchith",
    "Sean Abbott": "SA Abbott",
    "Tom Curran": "TK Curran",
    "Sarfaraz Khan": "SN Khan",
}

BATTING_ROLES = {"Batter", "Wicket Keeper", "All-Rounder"}
BOWLING_ROLES = {"Bowler", "All-Rounder"}


def _season_year(season: Any) -> int:
    text = str(season or "")
    return int(text[:4]) if text[:4].isdigit() else 0


@dataclass
class Career:
    """Raw tallies for one Cricsheet identity across every season."""

    key: str
    name: str
    matches: int = 0
    seasons: set[int] = field(default_factory=set)
    teams: set[str] = field(default_factory=set)
    # batting
    runs: int = 0
    balls: int = 0
    outs: int = 0
    # bowling
    bowled: int = 0
    conceded: int = 0
    wickets: int = 0
    # per opponent: [runs, balls, boundaries] faced from that bowler, and
    # [conceded, legal balls] bowled to that batter.
    vs_bowler: dict[str, list[int]] = field(default_factory=lambda: defaultdict(lambda: [0, 0, 0]))
    vs_batter: dict[str, list[int]] = field(default_factory=lambda: defaultdict(lambda: [0, 0]))

    @property
    def last_season(self) -> int:
        return max(self.seasons) if self.seasons else 0


@dataclass
class CareerRun:
    """Everything one aggregation produced, for the refresh report."""

    season_through: int = 0
    last_match_date: str = ""
    matches_read: int = 0
    updates: list[PlayerUpdate] = field(default_factory=list)
    matched: dict[int, str] = field(default_factory=dict)
    """Pool id -> the scorecard name whose career it received."""
    styles_pending: int = 0
    """Opponents still waiting for a style lookup; the scheduler retries weekly."""
    split_coverage: float | None = None
    """Share of matched players' deliveries whose opponent had a known style."""
    notes: list[str] = field(default_factory=list)


def aggregate(archive: Path, *, deadline: float | None = None) -> tuple[dict[str, Career], int, str, int, list[str]]:
    """
    Every identity's career, keyed by registry id.

    Returns (careers, newest season, last match date, matches read, notes).
    """
    careers: dict[str, Career] = {}
    notes: list[str] = []
    newest = 0
    last_date = ""
    read = 0

    def person(key: str, name: str) -> Career:
        career = careers.get(key)
        if career is None:
            career = careers[key] = Career(key=key, name=name)
        return career

    with zipfile.ZipFile(archive) as zf:
        for entry in zf.namelist():
            if not entry.endswith(".json"):
                continue
            if deadline is not None and time.time() > deadline:
                notes.append(f"Stopped after {read} matches: out of time.")
                break
            try:
                match = json.loads(zf.read(entry))
            except Exception:  # noqa: BLE001 - one bad file is skipped, not fatal
                continue
            info = match.get("info") or {}
            registry = (info.get("registry") or {}).get("people") or {}
            season = _season_year(info.get("season"))
            newest = max(newest, season)
            dates = info.get("dates") or []
            if dates:
                last_date = max(last_date, str(dates[-1]))
            read += 1

            def key_of(name: str) -> str:
                return str(registry.get(name) or name)

            for team, names in (info.get("players") or {}).items():
                for name in names:
                    career = person(key_of(name), name)
                    career.matches += 1
                    career.seasons.add(season)
                    career.teams.add(team)
                    # The most recent spelling wins, so a player Cricsheet
                    # renamed is reported under today's name.
                    if season >= career.last_season:
                        career.name = name

            for innings in match.get("innings") or []:
                for over in innings.get("overs") or []:
                    for ball in over.get("deliveries") or []:
                        extras = ball.get("extras") or {}
                        runs = ball.get("runs") or {}
                        batter_name, bowler_name = ball.get("batter"), ball.get("bowler")
                        if not batter_name or not bowler_name:
                            continue
                        bat_key, bowl_key = key_of(batter_name), key_of(bowler_name)
                        batter = person(bat_key, batter_name)
                        bowler = person(bowl_key, bowler_name)

                        off_bat = int(runs.get("batter", 0) or 0)
                        faced = not any(k in extras for k in _NOT_FACED)
                        legal = not any(k in extras for k in _NOT_BOWLED)
                        boundary = off_bat in (4, 6) and not runs.get("non_boundary")
                        conceded = int(runs.get("total", 0) or 0) - sum(
                            int(extras.get(k, 0) or 0) for k in _NOT_BOWLER_FAULT
                        )

                        batter.runs += off_bat
                        if faced:
                            batter.balls += 1
                            split = batter.vs_bowler[bowl_key]
                            split[0] += off_bat
                            split[1] += 1
                            split[2] += int(boundary)

                        if legal:
                            bowler.bowled += 1
                        bowler.conceded += conceded
                        against = bowler.vs_batter[bat_key]
                        against[0] += conceded
                        against[1] += int(legal)

                        for wicket in ball.get("wickets") or []:
                            kind = wicket.get("kind", "")
                            out = wicket.get("player_out")
                            if out and kind not in _NOT_A_DISMISSAL:
                                person(key_of(out), out).outs += 1
                            if kind not in _NOT_BOWLER_WICKET:
                                bowler.wickets += 1

    notes.append(f"Read {read} IPL matches through the {newest} season (last match {last_date}).")
    return careers, newest, last_date, read, notes


def _map_to_pool(
    careers: dict[str, Career], pool: list[dict[str, Any]], newest: int
) -> tuple[dict[int, Career], list[str]]:
    """Pool id -> the one identity whose career it receives."""
    notes: list[str] = []
    best: dict[int, tuple[tuple[float, int, int], Career]] = {}
    recent_floor = newest - RECENT_SEASONS + 1

    for career in careers.values():
        if not career.matches:
            continue
        match = resolve_player(career.name, pool)
        if match.player_id is None or match.confidence < MATCH_THRESHOLD:
            continue
        exact = match.confidence >= 1.0
        if not exact and career.last_season < recent_floor:
            continue
        rank = (1.0 if exact else 0.0, career.last_season, career.matches)
        held = best.get(match.player_id)
        if held is None or rank > held[0]:
            best[match.player_id] = (rank, career)

    # Aliases last, so they override whatever the resolver concluded.
    by_name: dict[str, Career] = {}
    for career in careers.values():
        held = by_name.get(career.name)
        if held is None or (career.last_season, career.matches) > (held.last_season, held.matches):
            by_name[career.name] = career
    pool_ids = {str(p.get("player_name") or ""): int(p["id"]) for p in pool}
    for pool_name, scorecard in ALIASES.items():
        pid, career = pool_ids.get(pool_name), by_name.get(scorecard)
        if pid is not None and career is not None and career.matches:
            best[pid] = ((2.0, career.last_season, career.matches), career)
    # An aliased career belongs to its alias alone: if the resolver had also
    # handed it to someone else, that other attribution was the wrong one.
    owner = {held[1].key: pid for pid, held in best.items() if held[0][0] == 2.0}
    for pid in [p for p, held in best.items() if held[1].key in owner and owner[held[1].key] != p]:
        del best[pid]

    mapped = {pid: career for pid, (_, career) in best.items()}
    notes.append(f"Matched {len(mapped)} of {len(pool)} pool players to an IPL career.")
    return mapped, notes


def _valid_stats(raw: dict[str, Any]) -> dict[str, Any]:
    """Each field checked on its own, so one out-of-bounds figure drops alone."""
    kept: dict[str, Any] = {}
    for name, value in raw.items():
        try:
            PlayerStatUpdate(**{name: value})
        except ValidationError:
            logger.debug("dropped %s=%r: outside the schema's bounds", name, value)
            continue
        kept[name] = value
    return kept


def _stats_for(
    career: Career, role: str, styles: dict[str, Style], counted: list[int]
) -> dict[str, Any]:
    """The columns this role stores, from one career. `counted` = [known, total] balls."""
    stats: dict[str, Any] = {"matches": career.matches}

    if role in BATTING_ROLES or role not in BOWLING_ROLES:
        stats["total_runs"] = career.runs
        if career.balls >= MIN_BALLS_FOR_SR:
            stats["bat_sr"] = round(career.runs / career.balls * 100, 2)
        if career.outs:
            stats["bat_avg"] = round(career.runs / career.outs, 2)

        by_kind = {"pace": [0, 0, 0], "spin": [0, 0, 0]}
        for bowler_key, (runs, balls, boundaries) in career.vs_bowler.items():
            counted[1] += balls
            kind = styles.get(bowler_key, Style()).bowl
            if kind in by_kind:
                counted[0] += balls
                tally = by_kind[kind]
                tally[0] += runs
                tally[1] += balls
                tally[2] += boundaries
        for kind, column_sr, column_bd in (
            ("pace", "sr_vs_fast", "boundary_pct_fast"),
            ("spin", "sr_vs_spin", "boundary_pct_spin"),
        ):
            runs, balls, boundaries = by_kind[kind]
            if balls >= MIN_SPLIT_BALLS:
                stats[column_sr] = round(runs / balls * 100, 2)
                stats[column_bd] = round(boundaries / balls * 100, 2)

    if role in BOWLING_ROLES:
        stats["wickets"] = career.wickets
        stats["runs_conceded"] = career.conceded
        if career.bowled >= MIN_BALLS_FOR_ECONOMY:
            stats["economy"] = round(career.conceded / (career.bowled / 6), 2)
        if career.wickets:
            stats["bowl_avg"] = round(career.conceded / career.wickets, 2)
            stats["bowl_sr"] = round(career.bowled / career.wickets, 2)

        by_hand = {"left": [0, 0], "right": [0, 0]}
        for batter_key, (conceded, legal) in career.vs_batter.items():
            counted[1] += legal
            hand = styles.get(batter_key, Style()).bat
            if hand in by_hand:
                counted[0] += legal
                by_hand[hand][0] += conceded
                by_hand[hand][1] += legal
        for hand, column in (("left", "econ_vs_lhb"), ("right", "econ_vs_rhb")):
            conceded, legal = by_hand[hand]
            if legal >= MIN_SPLIT_BALLS:
                stats[column] = round(conceded / (legal / 6), 2)

    return _valid_stats(stats)


def build_updates(
    archive: Path,
    pool: list[dict[str, Any]],
    *,
    source_url: str,
    retrieved_at: datetime | None = None,
    look_up: bool = True,
    deadline: float | None = None,
) -> CareerRun:
    """The whole computation: aggregate, map, classify opponents, build updates."""
    run = CareerRun()
    careers, newest, last_date, read, notes = aggregate(archive, deadline=deadline)
    run.season_through, run.last_match_date, run.matches_read = newest, last_date, read
    run.notes.extend(notes)

    mapped, map_notes = _map_to_pool(careers, pool, newest)
    run.notes.extend(map_notes)
    roles = {int(p["id"]): str(p.get("role") or "") for p in pool}
    pool_by_id = {int(p["id"]): p for p in pool}

    # Only the opponents of matched players need a style -- the whole of what
    # the splits read. Each is weighted by the deliveries it contributes, so
    # the per-run lookup cap is spent where it moves the splits most.
    pool_name_of = {career.key: str(pool_by_id[pid].get("player_name"))
                    for pid, career in mapped.items()}
    weights: dict[str, int] = defaultdict(int)
    for pid, career in mapped.items():
        role = roles.get(pid, "")
        if role in BATTING_ROLES or role not in BOWLING_ROLES:
            for key, (_, balls, _) in career.vs_bowler.items():
                weights[key] += balls
        if role in BOWLING_ROLES:
            for key, (_, legal) in career.vs_batter.items():
                weights[key] += legal
    wanted = [
        Person(
            key=key,
            name=careers[key].name,
            full_name=pool_name_of.get(key),
            teams=tuple(sorted(careers[key].teams, key=lambda t: t)),
            weight=weight,
        )
        for key, weight in weights.items()
        if key in careers
    ]
    styles, style_notes, run.styles_pending = resolve_styles(wanted, look_up=look_up)
    run.notes.extend(style_notes)

    source = SourceRef(
        source_id=SOURCE_ID,
        url=source_url,
        method="scrape",
        retrieved_at=retrieved_at or datetime.now(timezone.utc),
        # Computed from ball-by-ball records, not read off a page.
        confidence=0.97,
    )

    counted = [0, 0]
    from scout.schemas.player import PlayerMatch

    for pid, career in mapped.items():
        stats = _stats_for(career, roles.get(pid, ""), styles, counted)
        if not stats:
            continue
        row = pool_by_id[pid]
        run.updates.append(
            PlayerUpdate(
                match=PlayerMatch(
                    raw_name=career.name,
                    player_id=pid,
                    resolved_name=str(row.get("player_name")),
                    confidence=1.0,
                ),
                stats=PlayerStatUpdate(**stats),
                valuation=PlayerValuation(),
                source=source,
            )
        )
        run.matched[pid] = career.name

    if counted[1]:
        run.split_coverage = round(counted[0] / counted[1], 4)
        run.notes.append(
            f"Matchup splits cover {run.split_coverage:.1%} of the matched players' deliveries."
        )
    return run
