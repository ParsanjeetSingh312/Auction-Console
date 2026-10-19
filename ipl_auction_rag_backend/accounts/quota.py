"""
quota.py
SCOUT's allowance for the free tier: SCOUT_FREE_LIMIT requests in a rolling
SCOUT_FREE_WINDOW_SECONDS (10 in 2 hours by default).

Counted for Member accounts by account, and for signed-out visitors by
address, so logging out is not a way round it. Auctioneer, Delegate and admin
accounts are not counted. Rolling rather than fixed: each request frees up
again exactly one window after it was made, so "resets in" is the time until
the oldest one in the window ages out.

Kept in accounts.db, beside the accounts, so a deploy does not hand everyone
a fresh allowance.
"""
from __future__ import annotations

import time
from typing import Any

from accounts import store
from accounts.store import Account
from config.settings import get_settings


def key_for(account: Account | None, address: str) -> str | None:
    """Whose allowance a request counts against, or None if it is not limited."""
    if get_settings().SCOUT_FREE_LIMIT <= 0:
        return None  # the allowance is switched off
    if account is None:
        return f"ip:{address}"
    if account.admin or account.role != "member":
        return None
    return f"account:{account.id}"


def status(key: str | None, now: float | None = None) -> dict[str, Any]:
    settings = get_settings()
    if key is None:
        return {"limited": False, "limit": None, "used": 0, "remaining": None, "resets_at": None,
                "window_seconds": settings.SCOUT_FREE_WINDOW_SECONDS}
    now = time.time() if now is None else now
    since = now - settings.SCOUT_FREE_WINDOW_SECONDS
    with store._connect() as conn:
        conn.execute("DELETE FROM scout_usage WHERE at < ?", (since,))
        rows = conn.execute(
            "SELECT at FROM scout_usage WHERE key = ? AND at >= ? ORDER BY at", (key, since)
        ).fetchall()
    used = len(rows)
    return {
        "limited": True,
        "limit": settings.SCOUT_FREE_LIMIT,
        "used": used,
        "remaining": max(settings.SCOUT_FREE_LIMIT - used, 0),
        "resets_at": rows[0]["at"] + settings.SCOUT_FREE_WINDOW_SECONDS if rows else None,
        "window_seconds": settings.SCOUT_FREE_WINDOW_SECONDS,
    }


def take(key: str | None, now: float | None = None) -> dict[str, Any]:
    """
    Use one request from the allowance. Returns the status after it, with
    `allowed` False (and nothing used) if the allowance is spent.
    """
    if key is None:
        return {**status(None), "allowed": True}
    settings = get_settings()
    now = time.time() if now is None else now
    since = now - settings.SCOUT_FREE_WINDOW_SECONDS
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM scout_usage WHERE key = ? AND at >= ?", (key, since)
        ).fetchone()["n"]
        allowed = used < settings.SCOUT_FREE_LIMIT
        if allowed:
            conn.execute("INSERT INTO scout_usage (key, at) VALUES (?, ?)", (key, now))
    return {**status(key, now), "allowed": allowed}
