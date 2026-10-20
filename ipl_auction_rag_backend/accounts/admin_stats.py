"""
admin_stats.py
The administrator's overview: one read of everything worth watching.

Everything here is derived from rows that already exist -- the pass ledger,
the gifts, the accounts and the auction log -- so the panel can never
disagree with what actually happened. Nothing is cached or stored twice.

`overview(admin, days)` answers, for the last `days` days and for all time:

    accounts     how many of each tier, and how many joined in the window
    passes       generated, sent, claimed, pending, returned and spent, per kind
    given_by_me  what this administrator personally sent, per kind
    auctions     opened / started / finished, in total and per day
    top          the auctioneers who started the most auctions
    recent       the latest room events and the latest pass gifts
"""
from __future__ import annotations

import time
from typing import Any

from accounts import activity, store
from accounts.store import Account

DAY = 24 * 3600
KINDS = ("A", "D")


def _per_kind() -> dict[str, int]:
    return {k: 0 for k in KINDS}


def _accounts(conn, since: float) -> dict[str, Any]:
    admins = store.admin_emails()
    out = {"total": 0, "joined": 0, "admin": 0, "auctioneer": 0, "delegate": 0, "member": 0}
    for row in conn.execute("SELECT email, role, created_at FROM accounts"):
        out["total"] += 1
        if row["created_at"] >= since:
            out["joined"] += 1
        if row["email"] in admins:
            out["admin"] += 1
        else:
            out[row["role"]] += 1
    return out


def _gift_flow(conn, since: float, sender_id: int | None = None) -> dict[str, dict[str, int]]:
    """Gifts by state and kind: sent (in the window), and where they stand now."""
    flow = {name: _per_kind() for name in ("sent", "claimed", "pending", "returned")}
    where = "WHERE created_at >= ?"
    args: list[Any] = [since]
    if sender_id is not None:
        where += " AND sender_id = ?"
        args.append(sender_id)
    rows = conn.execute(
        f"SELECT kind, status, SUM(quantity) AS n FROM pass_gifts {where} GROUP BY kind, status",
        args,
    ).fetchall()
    for row in rows:
        kind, n = row["kind"], row["n"] or 0
        flow["sent"][kind] += n
        state = "returned" if row["status"] in ("returned", "expired") else row["status"]
        flow[state][kind] += n
    return flow


def _ledger_sum(conn, reason: str, since: float) -> dict[str, int]:
    out = _per_kind()
    for row in conn.execute(
        "SELECT kind, SUM(ABS(delta)) AS n FROM pass_ledger WHERE reason = ? AND created_at >= ? GROUP BY kind",
        (reason, since),
    ):
        out[row["kind"]] = row["n"] or 0
    return out


def _spent(conn, since: float) -> dict[str, int]:
    """Passes used to open a room or take a seat, net of refunds."""
    spent = _ledger_sum(conn, "spend", since)
    refunded = _ledger_sum(conn, "refund", since)
    return {k: max(0, spent[k] - refunded[k]) for k in KINDS}


def _recent_gifts(conn, limit: int = 10) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT g.kind, g.quantity, g.status, g.created_at, "
        "COALESCE(s.name, 'AUCTONIQ') AS sender, r.name AS recipient "
        "FROM pass_gifts g LEFT JOIN accounts s ON s.id = g.sender_id "
        "JOIN accounts r ON r.id = g.recipient_id "
        "ORDER BY g.created_at DESC, g.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def overview(admin: Account, days: int = 7, live_rooms: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The administrator's panel, for the last `days` days (1-90)."""
    days = max(1, min(90, int(days)))
    now = time.time()
    since = (int(now // DAY) - days + 1) * DAY
    with store._connect() as conn:
        accounts = _accounts(conn, since)
        window = {
            "generated": _ledger_sum(conn, "generate", since),
            **_gift_flow(conn, since),
            "spent": _spent(conn, since),
        }
        all_time = {
            "generated": _ledger_sum(conn, "generate", 0),
            **_gift_flow(conn, 0),
            "spent": _spent(conn, 0),
        }
        given_by_me = _gift_flow(conn, 0, sender_id=admin.id)
        given_by_me_window = _gift_flow(conn, since, sender_id=admin.id)
        recent_gifts = _recent_gifts(conn)

    return {
        "days": days,
        "since": since,
        "generated_at": now,
        "accounts": accounts,
        "passes": {"window": window, "all_time": all_time},
        "given_by_me": {"all_time": given_by_me, "window": given_by_me_window},
        "auctions": {
            "window": activity.totals(since),
            "all_time": activity.totals(0),
            "per_day": activity.per_day(days, now),
            "live": live_rooms or [],
        },
        "top_auctioneers": activity.top_auctioneers(since),
        "recent_rooms": activity.recent(),
        "recent_gifts": recent_gifts,
    }


# ----------------------------------------------------------- auctioneer --


def _ledger_sum_for(conn, account_id: int, reason: str, since: float) -> dict[str, int]:
    out = _per_kind()
    for row in conn.execute(
        "SELECT kind, SUM(ABS(delta)) AS n FROM pass_ledger "
        "WHERE account_id = ? AND reason = ? AND created_at >= ? GROUP BY kind",
        (account_id, reason, since),
    ):
        out[row["kind"]] = row["n"] or 0
    return out


def auctioneer_overview(account: Account, days: int = 30) -> dict[str, Any]:
    """
    An auctioneer's own figures: the Delegate passes it generated and gave,
    where each gift stands, who received them, and the auctions it ran.
    """
    from accounts import passes

    days = max(1, min(90, int(days)))
    now = time.time()
    since = (int(now // DAY) - days + 1) * DAY
    with store._connect() as conn:
        generated = {
            "window": _ledger_sum_for(conn, account.id, "generate", since),
            "all_time": _ledger_sum_for(conn, account.id, "generate", 0),
        }
        given = {
            "window": _gift_flow(conn, since, sender_id=account.id),
            "all_time": _gift_flow(conn, 0, sender_id=account.id),
        }
        recipients = [
            dict(r)
            for r in conn.execute(
                "SELECT r.id, r.name, r.email, r.role, g.kind, "
                "SUM(g.quantity) AS sent, "
                "SUM(CASE WHEN g.status = 'claimed' THEN g.quantity ELSE 0 END) AS claimed, "
                "SUM(CASE WHEN g.status = 'pending' THEN g.quantity ELSE 0 END) AS pending, "
                "MAX(g.created_at) AS last_sent "
                "FROM pass_gifts g JOIN accounts r ON r.id = g.recipient_id "
                "WHERE g.sender_id = ? GROUP BY r.id, g.kind ORDER BY last_sent DESC LIMIT 50",
                (account.id,),
            )
        ]
        generated_today = conn.execute(
            "SELECT COALESCE(SUM(delta), 0) AS n FROM pass_ledger "
            "WHERE account_id = ? AND kind = 'D' AND reason = 'generate' AND created_at > ?",
            (account.id, now - DAY),
        ).fetchone()["n"]
        auctions = {"window": {"opened": 0, "started": 0, "finished": 0},
                    "all_time": {"opened": 0, "started": 0, "finished": 0}}
        for key, start in (("window", since), ("all_time", 0)):
            for row in conn.execute(
                "SELECT event, COUNT(*) AS n FROM auction_log WHERE owner_id = ? AND at >= ? GROUP BY event",
                (account.id, start),
            ):
                auctions[key][row["event"]] = row["n"]
    caps = passes.capabilities(account)
    return {
        "days": days,
        "since": since,
        "balances": passes.balances(account.id),
        "generate_cap": caps.get("generate_cap"),
        "generated_today": generated_today,
        "generated": generated,
        "given": given,
        "recipients": recipients,
        "auctions": auctions,
    }
