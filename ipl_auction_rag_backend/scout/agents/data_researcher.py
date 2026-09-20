"""
data_researcher.py
The first graph node: acquire, extract, store, report.

It is a thin orchestrator by design. Fetching lives in `playwright_scraper`,
storage in `rag_pipeline`, and the shapes in `scout.schemas.player` -- this file
decides the order, handles the failures, and turns the result into a state
update LangGraph can merge.

**Extraction is chosen by source kind, and only one of the two costs a model
call.** Cricsheet ships ball-by-ball JSON, so per-player figures come out of
arithmetic rather than out of a language model: no quota, no hallucinated strike
rate, and a number that can be recomputed and checked. Prose sources -- an
article, a search snippet -- have no such structure, so those go through the LLM
into `PlayerFact`s. Given three of the four configured sources refuse an
identified crawler, the arithmetic path is the one that actually runs today.

**The scorecard name format is the format the resolver was built for.**
Cricsheet writes "V Kohli" and "DA Warner", which is exactly the initial-and-
surname form `resolve_player` handles, and unresolved names are held rather than
guessed at. With twelve Sharmas in this pool that distinction is not academic.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config.settings import get_settings
from scout.graph.state import ScoutState, seconds_left
from scout.schemas.player import (
    PlayerStatUpdate,
    PlayerUpdate,
    PlayerValuation,
    ResearchBatch,
    SourceRef,
)
from scout.tools.playwright_scraper import Refusal, ScrapeOutcome, enabled_sources, load_sources
from scout.tools.rag_pipeline import record, resolve_player

logger = logging.getLogger(__name__)

#: A wide is not a ball faced by the batter, and is not a legal ball bowled.
#: A no-ball is faced but is not a legal delivery. Byes and leg-byes are runs
#: off the batter's body or past the keeper -- not the bowler's concern and not
#: the batter's runs -- so they count for neither.
_NOT_FACED = ("wides",)
_NOT_BOWLED = ("wides", "noballs")
_NOT_BOWLER_FAULT = ("byes", "legbyes")

#: A run out is not the bowler's wicket. Retirements are not dismissals at all.
_NOT_BOWLER_WICKET = {"run out", "retired hurt", "retired not out", "obstructing the field"}
_NOT_A_DISMISSAL = {"retired hurt", "retired not out"}

#: Below this a career figure is noise. A strike rate from nine balls is not a
#: strike rate, and writing one into the pool would make it look like evidence.
MIN_BALLS_FACED = 60
MIN_BALLS_BOWLED = 120

#: The pool stores batting OR bowling per row, never both, and `role` decides
#: which. `ingestion/excel_parser.py` puts it plainly -- "_parse_bowling_row
#: if role == 'Bowler' else _parse_batting_row" -- and the test suite asserts
#: it twice: no Bowler may have a bat_avg, no Batter may have an economy.
#:
#: Writing both, which ball-by-ball data happily supports, broke those two
#: tests. A number being true is not sufficient reason to store it: the pool
#: has a shape, the console reads it expecting that shape, and a bowler with
#: a batting average would surface in a "reliable anchor" shortlist.
BOWLING_ROLE = "Bowler"


# ---------------------------------------------------------------------------
# Cricsheet
# ---------------------------------------------------------------------------


def _season_year(season: Any) -> int:
    """'2020/21' -> 2020. Cricsheet writes split seasons that way."""
    text = str(season or "")
    return int(text[:4]) if text[:4].isdigit() else 0


def aggregate_cricsheet(
    archive: Path, *, seasons_back: int = 3, deadline: float | None = None
) -> tuple[dict[str, dict[str, float]], list[str]]:
    """
    Per-player batting and bowling figures from ball-by-ball data.

    Restricted to recent seasons because this is meant to describe current form
    rather than a career: a strike rate averaged over ten years tells a bidder
    very little about who to bid on tomorrow.

    Returns raw tallies keyed by the scorecard name, plus notes. Deliberately
    not PlayerUpdates yet -- resolution against the pool is a separate step with
    its own failure mode.
    """
    notes: list[str] = []
    tally: dict[str, dict[str, float]] = defaultdict(
        lambda: {"runs": 0, "balls": 0, "outs": 0, "conceded": 0, "bowled": 0, "wickets": 0}
    )

    with zipfile.ZipFile(archive) as zf:
        files = [n for n in zf.namelist() if n.endswith(".json")]

        # One pass to find the newest season, so "last three" is relative to the
        # data rather than to the calendar -- an archive downloaded in February
        # has no current-season matches in it.
        newest = 0
        for name in files:
            try:
                newest = max(newest, _season_year(json.loads(zf.read(name))["info"].get("season")))
            except Exception:  # noqa: BLE001 - a bad file is skipped, not fatal
                continue
        cutoff = newest - seasons_back + 1
        notes.append(f"newest season in archive: {newest}; including {cutoff}-{newest}")

        used = skipped = 0
        for name in files:
            if deadline is not None and time.time() > deadline:
                notes.append(f"stopped at {used} matches: out of time")
                break
            try:
                match = json.loads(zf.read(name))
            except Exception:  # noqa: BLE001
                skipped += 1
                continue
            if _season_year(match.get("info", {}).get("season")) < cutoff:
                continue
            used += 1

            for innings in match.get("innings", []):
                for over in innings.get("overs", []):
                    for ball in over.get("deliveries", []):
                        extras = ball.get("extras") or {}
                        runs = ball.get("runs") or {}
                        batter, bowler = ball.get("batter"), ball.get("bowler")

                        if batter:
                            row = tally[batter]
                            row["runs"] += runs.get("batter", 0)
                            if not any(k in extras for k in _NOT_FACED):
                                row["balls"] += 1

                        if bowler:
                            row = tally[bowler]
                            if not any(k in extras for k in _NOT_BOWLED):
                                row["bowled"] += 1
                            # Byes and leg-byes are not charged to the bowler.
                            row["conceded"] += runs.get("total", 0) - sum(
                                extras.get(k, 0) for k in _NOT_BOWLER_FAULT
                            )

                        for wicket in ball.get("wickets") or []:
                            kind = wicket.get("kind", "")
                            out = wicket.get("player_out")
                            if out and kind not in _NOT_A_DISMISSAL:
                                tally[out]["outs"] += 1
                            if bowler and kind not in _NOT_BOWLER_WICKET:
                                tally[bowler]["wickets"] += 1

        notes.append(f"{used} match(es) in range, {skipped} unreadable, {len(tally)} name(s)")

    return dict(tally), notes


def _updates_from_tally(
    tally: dict[str, dict[str, float]], pool: list[dict[str, Any]], source: SourceRef
) -> tuple[list[PlayerUpdate], list[str]]:
    """Turn raw tallies into validated updates, holding what cannot be resolved."""
    updates: list[PlayerUpdate] = []
    unresolved: list[str] = []
    roles = {int(p["id"]): str(p.get("role") or "") for p in pool}

    for name, row in tally.items():
        match = resolve_player(name, pool)
        if match.player_id is None:
            unresolved.append(name)
            continue

        stats: dict[str, float] = {}
        bowls = roles.get(match.player_id) == BOWLING_ROLE

        if not bowls and row["balls"] >= MIN_BALLS_FACED:
            stats["bat_sr"] = round(row["runs"] / row["balls"] * 100, 2)
            if row["outs"]:
                stats["bat_avg"] = round(row["runs"] / row["outs"], 2)
            stats["total_runs"] = int(row["runs"])

        if bowls and row["bowled"] >= MIN_BALLS_BOWLED:
            stats["economy"] = round(row["conceded"] / (row["bowled"] / 6), 2)
            stats["runs_conceded"] = int(row["conceded"])
            stats["wickets"] = int(row["wickets"])
            if row["wickets"]:
                stats["bowl_avg"] = round(row["conceded"] / row["wickets"], 2)
                stats["bowl_sr"] = round(row["bowled"] / row["wickets"], 2)

        if not stats:
            continue

        try:
            update = PlayerUpdate(
                match=match,
                stats=PlayerStatUpdate(**stats),
                valuation=PlayerValuation(),
                source=source,
            )
        except Exception as exc:  # noqa: BLE001 - a bound rejected it
            # The bounds exist to catch exactly this. A figure outside them is
            # an arithmetic bug here, not a player who broke a record.
            logger.warning("rejected computed stats for %s: %s", name, str(exc)[:160])
            continue

        updates.append(update)

    return updates, unresolved


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------


async def research(
    *, seasons_back: int = 3, deadline: float | None = None, apply_to_players: bool = True
) -> ResearchBatch:
    """
    One research pass over every enabled source.

    Callable outside the graph -- from the CLI, from a test, from an endpoint --
    because a node that can only run inside a graph can only be debugged inside
    a graph.
    """
    from db.sqlite_manager import SQLiteManager
    from scout.tools.playwright_scraper import scrape_source

    settings = get_settings()
    started = datetime.now(timezone.utc)
    notes: list[str] = []
    updates: list[PlayerUpdate] = []
    unresolved: list[str] = []

    config = load_sources()
    sources = enabled_sources(config)
    if not sources:
        notes.append("No enabled sources in sources.yaml; nothing to research.")
        return ResearchBatch(notes=notes, started_at=started,
                             finished_at=datetime.now(timezone.utc))

    pool = SQLiteManager().get_all_players(limit=1000, offset=0)
    outcomes: list[ScrapeOutcome] = []
    for source in sources:
        outcomes.extend(await scrape_source(str(source["id"]), config))

    for outcome in outcomes:
        if not outcome.ok:
            # A refusal is reported, not swallowed. This is the line that tells
            # a user why a player's form is three weeks old.
            notes.append(f"{outcome.source_id}: {outcome.refusal.value} - {outcome.detail}")
            continue

        if outcome.path and outcome.path.suffix == ".zip":
            source_ref = SourceRef(
                source_id=outcome.source_id, url=outcome.url, method="scrape",
                retrieved_at=outcome.fetched_at,
                # Computed from ball-by-ball records rather than read off a
                # page, so this is as trustworthy as the archive itself.
                confidence=0.95,
            )
            tally, agg_notes = await asyncio.to_thread(
                aggregate_cricsheet, outcome.path, seasons_back=seasons_back, deadline=deadline
            )
            notes.extend(f"{outcome.source_id}: {n}" for n in agg_notes)
            got, missed = _updates_from_tally(tally, pool, source_ref)
            updates.extend(got)
            unresolved.extend(missed)
            notes.append(
                f"{outcome.source_id}: {len(got)} player(s) matched, {len(missed)} unresolved"
            )
        elif outcome.text:
            notes.append(
                f"{outcome.source_id}: {len(outcome.text)} chars of prose - LLM extraction "
                "is not wired in yet, so this was fetched but not read."
            )

    # `record` embeds every fact and writes SQLite, both synchronous.
    report = await asyncio.to_thread(record, updates, apply_to_players=apply_to_players)
    notes.extend(report.notes)
    notes.append(f"stored: {report.summary()}")

    return ResearchBatch(
        updates=updates,
        unresolved=sorted(set(unresolved)),
        notes=notes,
        started_at=started,
        finished_at=datetime.now(timezone.utc),
    )


async def data_researcher_node(state: ScoutState) -> dict:
    """
    The LangGraph node.

    Returns a partial update: the batch, its notes, and nothing else. The
    refresh counter is incremented here rather than by the advisor, because
    this is the thing whose cost the budget is protecting against.
    """
    budget = seconds_left(state)
    deadline = None if budget == float("inf") else time.time() + budget

    batch = await research(deadline=deadline)

    return {
        "research": batch,
        "refresh_cycles": state.get("refresh_cycles", 0) + 1,
        "notes": batch.notes,
    }


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.agents.data_researcher            last 3 seasons, dry run
#   python -m scout.agents.data_researcher --apply    write it to the pool
#   python -m scout.agents.data_researcher --apply 5  last 5 seasons
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(name)-30s | %(message)s")
    args = sys.argv[1:]
    apply_now = "--apply" in args
    years = next((int(a) for a in args if a.isdigit()), 3)

    started = time.perf_counter()
    result = asyncio.run(research(seasons_back=years, apply_to_players=apply_now))

    print(f"\n{'APPLIED TO POOL' if apply_now else 'DRY RUN (nothing written to players)'}"
          f"  -  {time.perf_counter() - started:.1f}s\n")
    for note in result.notes:
        print("  ", note)
    print(f"\n  {len(result.updates)} update(s), {len(result.unresolved)} unresolved name(s)")
    for update in result.updates[:8]:
        print(f"    {update.match.resolved_name:<24} {update.stats.populated()}")
    if result.unresolved:
        print(f"    unresolved sample: {result.unresolved[:8]}")
