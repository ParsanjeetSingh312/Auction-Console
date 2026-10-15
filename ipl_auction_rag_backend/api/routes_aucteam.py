"""
routes_aucteam.py
AUCTEAM's HTTP surface, under /api/v1/aucteam.

    GET  /pool                 every player as a card, with tier and the rules
    POST /validate             the live check, run on each change to the board
    POST /report               the eleven's SCOUT report (LLM, or by rule)
    GET  /report/{report_id}   a saved report, by id

Players are always looked up here. The client sends ids and nothing else, so
role, tier and overseas status are the server's word, not the client's.

The report call can spend up to ~45 s on a language model. It runs in a worker
thread so that one user's report never blocks the event loop that also carries
the live auction's WebSocket.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from aucteam import store
from aucteam.analysis import (
    build_report,
    check_roster,
    compute_metrics,
    is_legal,
    scout_prompt,
)
from aucteam.aucteam_schema import (
    SQUAD_SIZE,
    TIER_NAMES,
    AucteamPlayer,
    PoolResponse,
    ReportRequest,
    TeamPayload,
    TeamReport,
    ValidateResponse,
)
from aucteam.tiers import to_card
from db import get_player_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/aucteam", tags=["AUCTEAM"])


#: How long the card pool is served from memory. Long enough that a whole
#: build -- dozens of /validate calls and a /report -- costs one database read;
#: short enough that a re-ingest or a tier edit shows up within minutes.
POOL_TTL_SECONDS = 300.0

_pool_lock = threading.Lock()
_pool_cache: tuple[float, list[AucteamPlayer]] | None = None


def _all_cards(force: bool = False) -> list[AucteamPlayer]:
    """
    Every player as a card, cached for POOL_TTL_SECONDS.

    The cache exists because the players table can be slow to reach. With
    DATABASE_URL pointing at a Supabase project that is paused or far away,
    each read can take 20+ seconds (the Postgres attempt, then the SQLite
    fallback in db.get_player_db). A builder that re-read the table on every
    drag would be unusable; this way only the first load waits.
    """
    global _pool_cache
    with _pool_lock:
        now = time.monotonic()
        if not force and _pool_cache and now - _pool_cache[0] < POOL_TTL_SECONDS:
            return _pool_cache[1]
        rows = get_player_db().execute_query("SELECT * FROM players ORDER BY id")
        overrides = store.load_overrides()
        cards = [card for row in rows if (card := to_card(row, overrides)) is not None]
        _pool_cache = (time.monotonic(), cards)
        return cards


def reset_pool_cache() -> None:
    global _pool_cache
    with _pool_lock:
        _pool_cache = None


def _roster(ids: list[int]) -> list[AucteamPlayer]:
    """The cards for `ids`, in the order given. 422 naming any id not in the pool."""
    by_id = {card.id: card for card in _all_cards()}
    if any(i not in by_id for i in ids):
        # Possibly a player ingested since the cache filled: look once more.
        by_id = {card.id: card for card in _all_cards(force=True)}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Not in the player pool: {', '.join(map(str, missing))}.",
        )
    return [by_id[i] for i in ids]


@router.get("/pool", response_model=PoolResponse)
async def pool(
    tier: str | None = Query(default=None, pattern="^(MQ|PR|EM)$"),
    role: str | None = Query(default=None, pattern="^(BAT|WK|AR|BWL)$"),
) -> PoolResponse:
    try:
        cards = await asyncio.to_thread(_all_cards)
    except Exception as exc:  # noqa: BLE001
        logger.error("AUCTEAM pool failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Could not load the player pool.")
    counts = {code: sum(1 for c in cards if c.tier == code) for code in TIER_NAMES}
    if tier:
        cards = [c for c in cards if c.tier == tier]
    if role:
        cards = [c for c in cards if c.role == role]
    return PoolResponse(total=len(cards), players=cards, tier_counts=counts)


@router.post("/validate", response_model=ValidateResponse)
async def validate(payload: TeamPayload) -> ValidateResponse:
    roster = await asyncio.to_thread(_roster, payload.player_ids)
    metrics = compute_metrics(roster)
    issues = check_roster(roster, metrics)
    return ValidateResponse(
        metrics=metrics,
        issues=issues,
        complete=len(roster) == SQUAD_SIZE,
        legal=is_legal(issues),
        scout_prompt=scout_prompt(roster, metrics),
    )


@router.post("/report", response_model=TeamReport)
async def report(payload: ReportRequest) -> TeamReport:
    roster = await asyncio.to_thread(_roster, payload.player_ids)
    metrics = compute_metrics(roster)
    issues = check_roster(roster, metrics)
    blocking = [issue.message for issue in issues if issue.severity == "block"]
    if blocking:
        raise HTTPException(status_code=422, detail=" ".join(blocking))

    result = await asyncio.to_thread(build_report, payload.team_name, roster)
    data: dict[str, Any] = result.model_dump()
    report_id = await asyncio.to_thread(
        store.save_report,
        payload.team_name,
        [p.model_dump() for p in roster],
        result.metrics.model_dump(),
        data,
        result.mode,
    )
    result.report_id = report_id
    return result


@router.get("/report/{report_id}", response_model=TeamReport)
async def saved_report(report_id: int) -> TeamReport:
    data = await asyncio.to_thread(store.load_report, report_id)
    if data is None:
        raise HTTPException(status_code=404, detail="No such report.")
    data["report_id"] = report_id
    return TeamReport(**data)
