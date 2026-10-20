"""
invites.py
Who an auctioneer invited to a room, and whether each of them is ready.

An invite is made by sending Delegate passes *for a room* -- from the waiting
room section of the Send passes dialog. Each recipient becomes a row in
`room_invites`, keyed on the room's code and its opening (`instance`, since a
code can be reused once a room closes), and the gift's notification links
straight into that room.

An invitee moves through four states:

    sent          the pass is waiting in their bell
    claimed       they claimed it into their wallet
    seated        they spent it on a franchise seat in this room
    acknowledged  they read and acknowledged the room's rules

The start gate: an auction with invites may not start until every invitee is
`acknowledged` (auction/room.py `start_auction`, fed by `blockers`). Rooms are
in memory, so seat state is read from the room object passed in; the gift
state is read from the database.
"""
from __future__ import annotations

import time
from typing import Any, Iterable

from accounts import store

ORDER = ("sent", "claimed", "seated", "acknowledged")
LABEL = {
    "sent": "has not claimed the pass yet",
    "claimed": "has not taken a seat yet",
    "seated": "has not acknowledged the rules yet",
    "returned": "let the pass expire",
}


def record(room_code: str, instance: str, inviter_id: int, gifts: Iterable[tuple[int, int]]) -> None:
    """Note invites: `gifts` is (recipient account id, gift id) pairs."""
    now = time.time()
    with store._connect() as conn:
        for account_id, gift_id in gifts:
            conn.execute(
                "INSERT INTO room_invites (room_code, instance, inviter_id, account_id, gift_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(room_code, instance, account_id) DO UPDATE SET gift_id = excluded.gift_id",
                (room_code, instance or "", inviter_id, account_id, gift_id, now),
            )
            conn.execute(
                "UPDATE notifications SET link = ? WHERE gift_id = ?",
                (f"/auction/live?room={room_code}", gift_id),
            )


def _rows(room_code: str, instance: str) -> list[dict[str, Any]]:
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT i.account_id, a.name, a.email, g.status AS gift_status, i.created_at "
            "FROM room_invites i JOIN accounts a ON a.id = i.account_id "
            "LEFT JOIN pass_gifts g ON g.id = i.gift_id "
            "WHERE i.room_code = ? AND i.instance = ? ORDER BY i.created_at, a.name",
            (room_code, instance or ""),
        ).fetchall()
    return [dict(r) for r in rows]


def _seats(room: Any) -> dict[int, dict[str, Any]]:
    """Franchise seats in the room, by account id."""
    out: dict[int, dict[str, Any]] = {}
    for seat in list(room.seats.values()):
        if seat.role == "franchise" and seat.account_id is not None:
            team = room.team_by_id(seat.team_id) or {}
            out[seat.account_id] = {
                "team_code": team.get("code"),
                "acknowledged": seat.acked_version == room.rules_version,
            }
    return out


def status(room: Any) -> list[dict[str, Any]]:
    """Every invitee to this room and where they stand, in invite order."""
    seats = _seats(room)
    out = []
    for row in _rows(room.code, room.instance):
        seat = seats.get(row["account_id"])
        if seat is not None:
            state = "acknowledged" if seat["acknowledged"] else "seated"
        elif row["gift_status"] == "claimed":
            state = "claimed"
        elif row["gift_status"] in ("returned", "expired"):
            state = "returned"
        else:
            state = "sent"
        out.append({
            "account_id": row["account_id"],
            "name": row["name"],
            "email": row["email"],
            "state": state,
            "team_code": seat["team_code"] if seat else None,
            "invited_at": row["created_at"],
        })
    return out


def blockers(room: Any) -> list[str]:
    """
    Why the auction may not start yet, one sentence per invitee not ready.
    An invitee whose pass expired unclaimed no longer holds the room up: the
    pass went back to the auctioneer, and they cannot take a seat with it.
    """
    return [
        f"{p['name']} {LABEL[p['state']]}"
        for p in status(room)
        if p["state"] not in ("acknowledged", "returned")
    ]


def remove(room: Any, account_id: int) -> bool:
    """Take someone off this room's invite list, so they no longer hold up the start."""
    with store._connect() as conn:
        cursor = conn.execute(
            "DELETE FROM room_invites WHERE room_code = ? AND instance = ? AND account_id = ?",
            (room.code, room.instance or "", account_id),
        )
    return cursor.rowcount > 0


def has_invites(room: Any) -> bool:
    return bool(_rows(room.code, room.instance))
