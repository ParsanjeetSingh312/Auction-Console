"""
activity.py
What happened in the auction rooms, kept after the rooms are gone.

Rooms live in memory (auction/rooms.py) and close when idle, so the registry
cannot answer "how many auctions ran this week". Each room's three moments --
opened, started, finished -- are written to `auction_log` as they happen, and
the admin panel (accounts/admin_stats.py) reads them back.

Writing never raises into the caller: a room must keep running even if the
log cannot be written, so a failure is logged and dropped.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Literal

from accounts import store

logger = logging.getLogger("accounts.activity")

Event = Literal["opened", "started", "finished"]
DAY = 24 * 3600


def record(
    event: Event,
    room_code: str,
    *,
    instance: str = "",
    room_type: str = "auctioneer",
    owner_id: int | None = None,
    teams: int | None = None,
    at: float | None = None,
) -> None:
    """Note one moment in a room's life. Never raises."""
    try:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO auction_log (room_code, instance, room_type, owner_id, event, teams, at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (room_code, instance or "", room_type, owner_id, event, teams, at or time.time()),
            )
    except Exception:  # noqa: BLE001 - the room matters more than its log
        logger.exception("Could not log %s for room %s", event, room_code)


def record_room(event: Event, room: Any) -> None:
    """`record` for an AuctionRoom, reading its code, instance, type and owner."""
    record(
        event,
        getattr(room, "code", "MAIN") or "MAIN",
        instance=getattr(room, "instance", "") or "",
        room_type=getattr(room, "room_type", "auctioneer"),
        owner_id=getattr(room, "owner_account_id", None),
        teams=len(getattr(room, "teams", []) or []),
    )


def per_day(days: int, now: float | None = None) -> list[dict[str, Any]]:
    """
    Opened / started / finished counts for each of the last `days` days,
    oldest first. Days are UTC calendar days, so the buckets line up with the
    dates the panel prints.
    """
    now = time.time() if now is None else now
    today = int(now // DAY)
    first = today - days + 1
    buckets = {
        day: {"day": day * DAY, "opened": 0, "started": 0, "finished": 0}
        for day in range(first, today + 1)
    }
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT CAST(at / ? AS INTEGER) AS day, event, COUNT(*) AS n "
            "FROM auction_log WHERE at >= ? GROUP BY day, event",
            (DAY, first * DAY),
        ).fetchall()
    for row in rows:
        bucket = buckets.get(row["day"])
        if bucket is not None:
            bucket[row["event"]] = row["n"]
    return list(buckets.values())


def totals(since: float = 0) -> dict[str, int]:
    """How many rooms were opened, started and finished since `since`."""
    out = {"opened": 0, "started": 0, "finished": 0}
    with store._connect() as conn:
        for row in conn.execute(
            "SELECT event, COUNT(*) AS n FROM auction_log WHERE at >= ? GROUP BY event", (since,)
        ):
            out[row["event"]] = row["n"]
    return out


def recent(limit: int = 12) -> list[dict[str, Any]]:
    """The latest room events, newest first, with the owner's name."""
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT l.room_code, l.room_type, l.event, l.teams, l.at, a.name AS owner "
            "FROM auction_log l LEFT JOIN accounts a ON a.id = l.owner_id "
            "ORDER BY l.at DESC, l.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def top_auctioneers(since: float, limit: int = 5) -> list[dict[str, Any]]:
    """Accounts that started the most auctions since `since`."""
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT a.id, a.name, a.email, COUNT(*) AS started "
            "FROM auction_log l JOIN accounts a ON a.id = l.owner_id "
            "WHERE l.event = 'started' AND l.at >= ? "
            "GROUP BY a.id ORDER BY started DESC, a.name LIMIT ?",
            (since, limit),
        ).fetchall()
    return [dict(r) for r in rows]
