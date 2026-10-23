"""
routes_stats.py
How fresh the player statistics are, and the button that freshens them.

`GET  /api/v1/stats/status`   public. The console prints it beside every figure
                              ("IPL career stats through 2026 · refreshed 23 Oct")
                              so a number on screen always says how old it is.
`POST /api/v1/stats/refresh`  admin. Runs the quarterly refresh now, in the
                              background, and returns at once -- a full run
                              downloads an archive and walks 1,200 matches, which
                              is too long to hold a request open for.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends

from api.auth import require_admin
from scout import stats_refresh

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/stats", tags=["Player statistics"])

#: The background run started by the last POST, kept so it is not collected
#: mid-flight -- asyncio holds only a weak reference to a bare task.
_task: asyncio.Task[Any] | None = None


@router.get("/status")
async def stats_status() -> dict[str, Any]:
    status = stats_refresh.current_status()
    # The notes are an operator's diagnostics; the public status needs the
    # dates and counts, not the archive's internals.
    status.pop("notes", None)
    status.pop("error", None)
    return status


@router.get("/status/detail", dependencies=[Depends(require_admin)])
async def stats_status_detail() -> dict[str, Any]:
    return stats_refresh.current_status()


@router.post("/refresh", dependencies=[Depends(require_admin)])
async def stats_refresh_now() -> dict[str, Any]:
    global _task
    if _task is not None and not _task.done():
        return {**stats_refresh.current_status(), "accepted": False,
                "note": "A refresh is already running."}
    _task = asyncio.create_task(stats_refresh.refresh(reason="manual"), name="stats-refresh")
    return {**stats_refresh.current_status(), "running": True, "accepted": True}
