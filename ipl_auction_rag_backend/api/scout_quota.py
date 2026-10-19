"""
scout_quota.py
The FastAPI side of SCOUT's free-tier allowance (accounts/quota.py): a
dependency on every route that asks SCOUT a question, and the route the
console reads its "7 of 10 left" meter from.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import HTTPException, Request

from accounts import quota
from api.routes_accounts import account_from_request


def _key(request: Request) -> str | None:
    account = account_from_request(request)
    address = request.client.host if request.client else "unknown"
    return quota.key_for(account, address)


async def use_scout_allowance(request: Request) -> None:
    """Spend one SCOUT request, or refuse with 429 and when it frees up."""
    key = await asyncio.to_thread(_key, request)
    result = await asyncio.to_thread(quota.take, key)
    if not result["allowed"]:
        wait = max(0, int((result["resets_at"] or time.time()) - time.time()))
        hours, minutes = divmod((wait + 59) // 60, 60)
        when = f"{hours}h {minutes}m" if hours else f"{minutes}m"
        raise HTTPException(
            status_code=429,
            detail=f"You have used all {result['limit']} SCOUT requests for now. "
            f"More in {when}. Delegate and Auctioneer accounts have no limit.",
            headers={"Retry-After": str(wait)},
        )


async def scout_allowance(request: Request) -> dict[str, Any]:
    key = await asyncio.to_thread(_key, request)
    return await asyncio.to_thread(quota.status, key)
