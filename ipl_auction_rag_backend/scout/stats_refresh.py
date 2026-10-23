"""
stats_refresh.py
Keep every pool player's IPL career figures current, every quarter.

One run does six things, in this order:

  1. fetch Cricsheet's IPL archive (`playwright_scraper`, which honours
     robots.txt and the politeness delay in `config/sources.yaml`);
  2. compute every pool player's full career from it (`career_stats`);
  3. write the figures through SCOUT's ledger (`rag_pipeline.record`), so a
     later re-ingest of the spreadsheet replays them instead of undoing them;
  4. re-embed the pool's summaries, so SCOUT's semantic search quotes the same
     numbers the SQL side now holds;
  5. hand every open auction room the refreshed pool;
  6. write `data/stats_status.json`, which the console reads to say "stats
     through IPL 2026, refreshed 23 Oct" next to every figure it shows.

**Never mid-auction.** A room bidding on a player while his record changes under
it would show two franchises two different careers. A run that finds an auction
live is deferred, and the scheduler simply tries again at its next check.

**Why quarterly.** The IPL is one season a year. Ninety days catches the new
season within weeks of the final, and costs a volunteer-run archive four
downloads a year. `POST /api/v1/stats/refresh` runs it on demand.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from config.settings import get_settings

logger = logging.getLogger(__name__)

_lock = asyncio.Lock()
_running = False

#: Days between retries while some players' playing styles are still unread.
STYLE_RETRY_DAYS = 7


def status_path() -> Path:
    return Path(get_settings().PROJECT_ROOT) / "data" / "stats_status.json"


def load_status() -> dict[str, Any]:
    """The last run's outcome, or an empty dict when there has never been one."""
    path = status_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - an unreadable status reads as "never"
        return {}


def _save_status(status: dict[str, Any]) -> None:
    path = status_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(status, indent=2), encoding="utf-8")
    tmp.replace(path)


def current_status() -> dict[str, Any]:
    """What the API reports: the last outcome, plus whether one is running now."""
    status = load_status()
    status["running"] = _running
    status["refresh_days"] = get_settings().STATS_REFRESH_DAYS
    return status


def is_due(now: datetime | None = None) -> bool:
    """True when the last successful refresh is older than STATS_REFRESH_DAYS."""
    status = load_status()
    stamp = status.get("refreshed_at")
    if not stamp:
        return True
    try:
        last = datetime.fromisoformat(stamp)
    except ValueError:
        return True
    now = now or datetime.now(timezone.utc)
    # Unfinished style lookups (a search quota ran out mid-run) are retried
    # weekly rather than quarterly: cached players cost nothing, so the retry
    # only spends on the ones still missing.
    if status.get("styles_pending") and now - last >= timedelta(days=STYLE_RETRY_DAYS):
        return True
    return now - last >= timedelta(days=get_settings().STATS_REFRESH_DAYS)


async def refresh(*, look_up: bool = True, reason: str = "manual") -> dict[str, Any]:
    """
    One full refresh. Returns the status it wrote.

    Never raises: a failure is recorded as `state: "failed"` with the reason,
    and the previous good figures stay in the table untouched.
    """
    global _running
    if _lock.locked():
        return {**current_status(), "state": "running", "note": "A refresh is already running."}

    async with _lock:
        _running = True
        started = time.perf_counter()
        previous = load_status()
        try:
            return await _refresh(look_up=look_up, reason=reason, previous=previous, started=started)
        except Exception as exc:  # noqa: BLE001 - recorded, never raised
            logger.exception("Career-stats refresh failed")
            status = {
                **{k: v for k, v in previous.items() if k != "running"},
                "state": "failed",
                "error": f"{type(exc).__name__}: {exc}"[:300],
                "attempted_at": datetime.now(timezone.utc).isoformat(),
                "reason": reason,
            }
            _save_status(status)
            return status
        finally:
            _running = False


async def _refresh(
    *, look_up: bool, reason: str, previous: dict[str, Any], started: float
) -> dict[str, Any]:
    from db import get_player_db
    from scout.agents.career_stats import SOURCE_ID, build_updates
    from scout.tools.playwright_scraper import load_sources, scrape_source
    from scout.tools.rag_pipeline import auction_is_running, record

    now = datetime.now(timezone.utc)
    running, phase = auction_is_running()
    if running:
        status = {
            **{k: v for k, v in previous.items() if k != "running"},
            "state": "deferred",
            "note": f"An auction is {phase}; the refresh will run once it ends.",
            "attempted_at": now.isoformat(),
        }
        _save_status(status)
        return status

    # --- 1. the archive ------------------------------------------------------
    config = load_sources()
    outcomes = await scrape_source("cricsheet", config)
    archive = next(
        (o for o in outcomes if o.ok and o.path and o.path.suffix == ".zip"), None
    )
    if archive is None:
        why = "; ".join(f"{o.url}: {o.detail}" for o in outcomes if not o.ok) or "no archive"
        raise RuntimeError(f"Cricsheet archive unavailable ({why})")

    # --- 2. careers ------------------------------------------------------------
    pool = await asyncio.to_thread(get_player_db().get_all_players, 10_000, 0)
    run = await asyncio.to_thread(
        build_updates,
        archive.path,
        pool,
        source_url=archive.url,
        retrieved_at=archive.fetched_at,
        look_up=look_up,
    )

    # --- 3. write through the ledger ---------------------------------------------
    report = await asyncio.to_thread(record, run.updates, apply_to_players=True)
    notes = [*run.notes, *report.notes, f"Stored: {report.summary()}"]

    # --- 4. vector summaries -------------------------------------------------------
    try:
        from ingestion.data_loader import reembed_pool

        embedded = await asyncio.to_thread(reembed_pool, run.season_through)
        notes.append(f"Re-embedded {embedded} player summaries for SCOUT.")
    except Exception as exc:  # noqa: BLE001 - SQL side is already current
        logger.warning("Could not re-embed the pool: %s", exc)
        notes.append(f"Vector summaries not rebuilt ({type(exc).__name__}); SQL figures are current.")

    # Squad numbers ride along: a refresh is the moment every environment's
    # table is being brought up to date anyway (ingestion/jersey_numbers.py).
    from ingestion.jersey_numbers import sync_jersey_numbers

    numbered = await asyncio.to_thread(sync_jersey_numbers)
    if numbered:
        notes.append(f"Applied {numbered} squad number(s) from jersey_numbers.json.")

    # --- 5. auction rooms ------------------------------------------------------------
    try:
        from auction.rooms import registry as auction_rooms

        rows = await asyncio.to_thread(get_player_db().get_all_players, 10_000, 0)
        kept = auction_rooms.refresh_pool(rows)
        if kept:
            notes.append("Rooms mid-auction kept their pool: " + ", ".join(kept))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not refresh the auction room pools: %s", exc)

    # --- 6. status -----------------------------------------------------------------------
    finished = datetime.now(timezone.utc)
    status = {
        "state": "ok",
        "reason": reason,
        "refreshed_at": finished.isoformat(),
        "next_due": (finished + timedelta(days=get_settings().STATS_REFRESH_DAYS)).isoformat(),
        "season_through": run.season_through,
        "last_match_date": run.last_match_date,
        "matches_read": run.matches_read,
        "players_updated": len(run.updates),
        "players_in_pool": len(pool),
        "split_coverage": run.split_coverage,
        "styles_pending": run.styles_pending,
        "source": SOURCE_ID,
        "source_url": archive.url,
        "seconds": round(time.perf_counter() - started, 1),
        "notes": notes,
    }
    _save_status(status)
    logger.info(
        "Career stats refreshed: %d players through IPL %s in %.1fs",
        status["players_updated"], status["season_through"], status["seconds"],
    )
    return status


async def run_scheduler() -> None:
    """
    The quarterly loop. Started from the API's lifespan and cancelled on shutdown.

    Checks rather than sleeps for ninety days: a restart never resets the
    clock, because "due" is read from the status file each time.
    """
    settings = get_settings()
    if not settings.STATS_REFRESH_ENABLED:
        logger.info("Career-stats refresh: disabled (STATS_REFRESH_ENABLED is false)")
        return
    interval = max(600.0, settings.STATS_REFRESH_CHECK_HOURS * 3600)
    logger.info(
        "Career-stats refresh: every %.0f days, checked every %.1f h",
        settings.STATS_REFRESH_DAYS, interval / 3600,
    )
    try:
        # A minute's grace first, so startup and model warm-up finish before a
        # refresh competes with them for the CPU.
        await asyncio.sleep(60)
        while True:
            if is_due():
                await refresh(reason="scheduled")
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("Career-stats scheduler stopped")
        raise
