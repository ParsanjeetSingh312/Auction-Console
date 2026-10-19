"""
notifications.py
The bell at the top right: what an account is told, and what it can claim.

One row per message per account, in accounts.db. Kinds:

    welcome        the first thing a new account sees (with its welcome gift)
    gift           passes someone sent; carries a pass_gifts row to claim
    gift_returned  a gift nobody claimed came back to its sender
    connection     a friend request, or one accepted
    reminder       an auction you are part of is about to start
    announcement   an administrator's message to everyone (or to some roles)

A gift's passes are not in the recipient's wallet until it is claimed from
here (accounts/passes.py), the way a game hands out rewards.

Functions taking `conn` write inside the caller's transaction, so a gift and
the message announcing it are made together or not at all.
"""
from __future__ import annotations

import sqlite3
import time
from typing import Any, Iterable

from accounts import store

KINDS = ("welcome", "gift", "gift_returned", "connection", "reminder", "announcement")


def add(
    conn: sqlite3.Connection,
    account_id: int,
    kind: str,
    title: str,
    body: str = "",
    gift_id: int | None = None,
    link: str | None = None,
) -> int:
    cursor = conn.execute(
        "INSERT INTO notifications (account_id, kind, title, body, gift_id, link, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (account_id, kind, title, body, gift_id, link, time.time()),
    )
    return int(cursor.lastrowid)


def notify(account_id: int, kind: str, title: str, body: str = "", link: str | None = None) -> int:
    with store._connect() as conn:
        return add(conn, account_id, kind, title, body, link=link)


def notify_many(account_ids: Iterable[int], kind: str, title: str, body: str = "", link: str | None = None) -> int:
    ids = list(dict.fromkeys(account_ids))
    with store._connect() as conn:
        for account_id in ids:
            add(conn, account_id, kind, title, body, link=link)
    return len(ids)


def broadcast(title: str, body: str = "", link: str | None = None, roles: Iterable[str] | None = None) -> int:
    """An announcement to every account, or to the accounts of `roles`. Returns how many."""
    wanted = [r for r in (roles or []) if r in store.ROLES]
    with store._connect() as conn:
        if wanted:
            marks = ",".join("?" * len(wanted))
            rows = conn.execute(f"SELECT id FROM accounts WHERE role IN ({marks})", wanted).fetchall()
        else:
            rows = conn.execute("SELECT id FROM accounts").fetchall()
        for row in rows:
            add(conn, row["id"], "announcement", title, body, link=link)
    return len(rows)


def _item(row: sqlite3.Row) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "body": row["body"],
        "link": row["link"],
        "created_at": row["created_at"],
        "read": row["read_at"] is not None,
        "gift": None,
    }
    if row["gift_id"] is not None and row["g_kind"] is not None:
        item["gift"] = {
            "id": row["gift_id"],
            "kind": row["g_kind"],
            "quantity": row["g_quantity"],
            "status": row["g_status"],
            "note": row["g_note"],
            "expires_at": row["g_expires_at"],
            "sender": row["sender_name"] or "AUCTONIQ",
        }
    return item


def list_for(account_id: int, limit: int = 50) -> list[dict[str, Any]]:
    """The newest messages first, each with its gift's state if it has one."""
    with store._connect() as conn:
        rows = conn.execute(
            """
            SELECT n.*, g.kind AS g_kind, g.quantity AS g_quantity, g.status AS g_status,
                   g.note AS g_note, g.expires_at AS g_expires_at, s.name AS sender_name
            FROM notifications n
            LEFT JOIN pass_gifts g ON g.id = n.gift_id
            LEFT JOIN accounts s ON s.id = g.sender_id
            WHERE n.account_id = ?
            ORDER BY n.id DESC
            LIMIT ?
            """,
            (account_id, max(1, min(limit, 200))),
        ).fetchall()
    return [_item(row) for row in rows]


def unread_count(account_id: int) -> int:
    with store._connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL",
            (account_id,),
        ).fetchone()
    return int(row["n"])


def mark_read(account_id: int, ids: Iterable[int] | None = None) -> int:
    """Mark some, or with no ids all, of an account's messages read."""
    now = time.time()
    with store._connect() as conn:
        if ids is None:
            cursor = conn.execute(
                "UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL",
                (now, account_id),
            )
        else:
            wanted = [int(i) for i in ids][:200]
            if not wanted:
                return 0
            marks = ",".join("?" * len(wanted))
            cursor = conn.execute(
                f"UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL AND id IN ({marks})",
                (now, account_id, *wanted),
            )
    return cursor.rowcount
