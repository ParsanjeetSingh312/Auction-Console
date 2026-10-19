"""
connections.py
Friend requests between accounts, and the friends list they make.

Anyone may connect with anyone: an Auctioneer with the Delegates and Free
accounts it plays with, two Delegates with each other. What a connection
allows is decided elsewhere -- passes travel only between connected accounts,
and only down the order (accounts/passes.py) -- so connecting is never a way
round the order.

One row per pair (low_id, high_id is unique): a request one way and a request
back are the same row, and sending a request to someone who already asked you
accepts theirs.
"""
from __future__ import annotations

import sqlite3
import time
from typing import Any

from accounts import notifications, store
from accounts.store import Account


class ConnectionError_(Exception):
    """A refusal to show the person, as one sentence."""


def summary(row: sqlite3.Row | Account) -> dict[str, Any]:
    """An account as another account sees it: no email."""
    account = row if isinstance(row, Account) else store._account(row)
    assert account is not None
    return {"id": account.id, "name": account.name, "role": account.role, "admin": account.admin}


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def are_connected(conn: sqlite3.Connection, a: int, b: int) -> bool:
    low, high = _pair(a, b)
    row = conn.execute(
        "SELECT 1 FROM connections WHERE low_id = ? AND high_id = ? AND status = 'accepted'",
        (low, high),
    ).fetchone()
    return row is not None


def friend_ids(account_id: int) -> list[int]:
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT CASE WHEN low_id = ? THEN high_id ELSE low_id END AS other "
            "FROM connections WHERE (low_id = ? OR high_id = ?) AND status = 'accepted'",
            (account_id, account_id, account_id),
        ).fetchall()
    return [row["other"] for row in rows]


def request(account: Account, other_id: int) -> dict[str, Any]:
    """Ask `other_id` to connect. Accepts theirs instead if they already asked."""
    if other_id == account.id:
        raise ConnectionError_("That is your own account.")
    low, high = _pair(account.id, other_id)
    now = time.time()
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        other = conn.execute("SELECT * FROM accounts WHERE id = ?", (other_id,)).fetchone()
        if other is None:
            raise ConnectionError_("No such account.")
        row = conn.execute("SELECT * FROM connections WHERE low_id = ? AND high_id = ?", (low, high)).fetchone()
        if row is not None and row["status"] == "accepted":
            return {"status": "accepted"}
        if row is not None and row["requester_id"] == account.id:
            return {"status": "pending"}
        if row is not None:
            # They asked first: this is a yes.
            conn.execute(
                "UPDATE connections SET status = 'accepted', responded_at = ? WHERE id = ?",
                (now, row["id"]),
            )
            notifications.add(
                conn, other_id, "connection", f"{account.name} accepted your request",
                "You are now connected.", link="/connections",
            )
            return {"status": "accepted"}
        conn.execute(
            "INSERT INTO connections (requester_id, addressee_id, low_id, high_id, status, created_at) "
            "VALUES (?, ?, ?, ?, 'pending', ?)",
            (account.id, other_id, low, high, now),
        )
        notifications.add(
            conn, other_id, "connection", f"{account.name} wants to connect",
            f"A {('admin' if account.admin else account.role)} account sent you a friend request.",
            link="/connections",
        )
    return {"status": "pending"}


def respond(account: Account, connection_id: int, accept: bool) -> dict[str, Any]:
    """Accept or decline a request addressed to this account."""
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM connections WHERE id = ? AND addressee_id = ? AND status = 'pending'",
            (connection_id, account.id),
        ).fetchone()
        if row is None:
            raise ConnectionError_("That request is no longer waiting for you.")
        if accept:
            conn.execute(
                "UPDATE connections SET status = 'accepted', responded_at = ? WHERE id = ?",
                (time.time(), connection_id),
            )
            notifications.add(
                conn, row["requester_id"], "connection", f"{account.name} accepted your request",
                "You are now connected.", link="/connections",
            )
        else:
            conn.execute("DELETE FROM connections WHERE id = ?", (connection_id,))
    return {"status": "accepted" if accept else "declined"}


def remove(account: Account, other_id: int) -> None:
    """Disconnect, or withdraw a request either way."""
    low, high = _pair(account.id, other_id)
    with store._connect() as conn:
        conn.execute("DELETE FROM connections WHERE low_id = ? AND high_id = ?", (low, high))


def list_for(account: Account) -> dict[str, list[dict[str, Any]]]:
    """Friends, requests waiting for this account, and requests it sent."""
    with store._connect() as conn:
        rows = conn.execute(
            """
            SELECT c.id AS connection_id, c.status, c.requester_id, c.created_at AS since, a.*
            FROM connections c
            JOIN accounts a ON a.id = CASE WHEN c.low_id = ? THEN c.high_id ELSE c.low_id END
            WHERE c.low_id = ? OR c.high_id = ?
            ORDER BY a.name COLLATE NOCASE
            """,
            (account.id, account.id, account.id),
        ).fetchall()
    out: dict[str, list[dict[str, Any]]] = {"friends": [], "incoming": [], "outgoing": []}
    for row in rows:
        entry = {**summary(row), "connection_id": row["connection_id"], "since": row["since"]}
        if row["status"] == "accepted":
            out["friends"].append(entry)
        elif row["requester_id"] == account.id:
            out["outgoing"].append(entry)
        else:
            out["incoming"].append(entry)
    return out


def search(account: Account, query: str, limit: int = 10) -> list[dict[str, Any]]:
    """
    Accounts to connect with: an exact email, or names starting with the text.
    Emails are matched, never listed, so the search cannot be used to collect
    them.
    """
    text = " ".join(query.split())[:80]
    if len(text) < 2:
        return []
    with store._connect() as conn:
        rows = conn.execute(
            """
            SELECT a.*, c.status AS link_status, c.requester_id AS link_requester
            FROM accounts a
            LEFT JOIN connections c
              ON c.low_id = MIN(a.id, ?) AND c.high_id = MAX(a.id, ?)
            WHERE a.id != ? AND (a.email = ? OR a.name LIKE ? ESCAPE '\\')
            ORDER BY (a.email = ?) DESC, a.name COLLATE NOCASE
            LIMIT ?
            """,
            (
                account.id, account.id, account.id,
                text.lower(),
                text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",
                text.lower(),
                max(1, min(limit, 25)),
            ),
        ).fetchall()
    results = []
    for row in rows:
        if row["link_status"] == "accepted":
            link = "friends"
        elif row["link_status"] == "pending":
            link = "outgoing" if row["link_requester"] == account.id else "incoming"
        else:
            link = "none"
        results.append({**summary(row), "link": link})
    return results
