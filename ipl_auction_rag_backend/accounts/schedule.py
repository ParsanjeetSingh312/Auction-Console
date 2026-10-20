"""
schedule.py
An auctioneer's upcoming auctions.

AUCTONIQ keeps the schedule itself, so it works with no Google account at
all. When the owner has connected Google Calendar (accounts/google_calendar.py)
each change here is copied there too, and the Google event's id is kept on the
row so later edits and deletions reach the same event.

Who may schedule: Auctioneer accounts and administrators -- the people who
open auctioneer rooms. An entry belongs to its owner; nobody else may change it.
"""
from __future__ import annotations

import time
from typing import Any

from accounts import store
from accounts.store import Account

MAX_TITLE = 120
MAX_NOTES = 600
MIN_DURATION, MAX_DURATION = 15, 12 * 60
#: How far ahead an auction may be scheduled.
HORIZON = 366 * 24 * 3600
#: How long a just-started auction still counts as "upcoming".
GRACE = 6 * 3600


class ScheduleError(Exception):
    """A refusal to show the person, as one sentence."""


def can_schedule(account: Account) -> bool:
    return account.admin or account.role == "auctioneer"


def _row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "room_type": row["room_type"],
        "starts_at": row["starts_at"],
        "duration_min": row["duration_min"],
        "notes": row["notes"],
        "google_event_id": row["google_event_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _clean(
    title: str,
    starts_at: float,
    duration_min: int,
    notes: str,
    room_type: str,
    *,
    now: float,
) -> tuple[str, float, int, str, str]:
    title = " ".join((title or "").split())
    if not title:
        raise ScheduleError("Give the auction a name.")
    if len(title) > MAX_TITLE:
        raise ScheduleError(f"Keep the name under {MAX_TITLE} characters.")
    notes = (notes or "").strip()
    if len(notes) > MAX_NOTES:
        raise ScheduleError(f"Keep the notes under {MAX_NOTES} characters.")
    if room_type not in ("auctioneer", "delegate"):
        raise ScheduleError("Choose an auctioneer or a delegate room.")
    if not MIN_DURATION <= int(duration_min) <= MAX_DURATION:
        raise ScheduleError(f"An auction runs between {MIN_DURATION} minutes and {MAX_DURATION // 60} hours.")
    if starts_at < now - 60:
        raise ScheduleError("Pick a time that has not passed yet.")
    if starts_at > now + HORIZON:
        raise ScheduleError("Auctions can be scheduled up to a year ahead.")
    return title, float(starts_at), int(duration_min), notes, room_type


def create(
    owner: Account,
    title: str,
    starts_at: float,
    duration_min: int = 120,
    notes: str = "",
    room_type: str = "auctioneer",
) -> dict[str, Any]:
    if not can_schedule(owner):
        raise ScheduleError("Only Auctioneer accounts can schedule auctions.")
    now = time.time()
    title, starts_at, duration_min, notes, room_type = _clean(
        title, starts_at, duration_min, notes, room_type, now=now
    )
    with store._connect() as conn:
        cursor = conn.execute(
            "INSERT INTO auction_schedule (owner_id, title, room_type, starts_at, duration_min, notes, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (owner.id, title, room_type, starts_at, duration_min, notes, now, now),
        )
        row = conn.execute("SELECT * FROM auction_schedule WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _row(row)


def get(owner: Account, entry_id: int) -> dict[str, Any]:
    with store._connect() as conn:
        row = conn.execute(
            "SELECT * FROM auction_schedule WHERE id = ? AND owner_id = ?", (entry_id, owner.id)
        ).fetchone()
    if row is None:
        raise ScheduleError("That auction is not on your schedule.")
    return _row(row)


def update(owner: Account, entry_id: int, **changes: Any) -> dict[str, Any]:
    current = get(owner, entry_id)
    merged = {**current, **{k: v for k, v in changes.items() if v is not None}}
    now = time.time()
    title, starts_at, duration_min, notes, room_type = _clean(
        merged["title"], merged["starts_at"], merged["duration_min"], merged["notes"], merged["room_type"], now=now
    )
    with store._connect() as conn:
        conn.execute(
            "UPDATE auction_schedule SET title = ?, starts_at = ?, duration_min = ?, notes = ?, room_type = ?, updated_at = ? "
            "WHERE id = ? AND owner_id = ?",
            (title, starts_at, duration_min, notes, room_type, now, entry_id, owner.id),
        )
    return get(owner, entry_id)


def delete(owner: Account, entry_id: int) -> dict[str, Any]:
    """Remove an entry. Returns it as it was, so its Google event can follow."""
    entry = get(owner, entry_id)
    with store._connect() as conn:
        conn.execute("DELETE FROM auction_schedule WHERE id = ? AND owner_id = ?", (entry_id, owner.id))
    return entry


def set_google_event(owner_id: int, entry_id: int, event_id: str | None) -> None:
    with store._connect() as conn:
        conn.execute(
            "UPDATE auction_schedule SET google_event_id = ? WHERE id = ? AND owner_id = ?",
            (event_id, entry_id, owner_id),
        )


def list_for(owner: Account, *, include_past: bool = False, limit: int = 100) -> list[dict[str, Any]]:
    """The owner's entries in start order: upcoming only, unless asked for all."""
    since = 0.0 if include_past else time.time() - GRACE
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT * FROM auction_schedule WHERE owner_id = ? AND starts_at >= ? ORDER BY starts_at LIMIT ?",
            (owner.id, since, limit),
        ).fetchall()
    return [_row(r) for r in rows]
