"""
passes.py
Auction passes: the entry ticket to every account-run auction room.

Two kinds:

    A  the gold Auctioneer pass   creates an auctioneer room
    D  the blue Delegate pass     creates a delegate room, or takes a
                                  franchise seat in any account-run room

The order, highest first, is ADMIN > AUCTIONEER > DELEGATE > FREE (member):

    generate   an admin either kind, without limit; an auctioneer D-passes,
               up to AUCTIONEER_DAILY_GENERATE_CAP a day; nobody else
    send       an admin either kind to anyone; an auctioneer D-passes to the
               delegates and free accounts it is connected with -- never to
               another auctioneer; delegates and free accounts send nothing
    spend      creating a room or taking a seat. Admins never spend.

**The ledger.** Every movement is a row in pass_ledger and a balance is the
sum of an account's rows, so a balance is never overwritten and can always be
explained. Checks and writes share one IMMEDIATE transaction, so two spends
racing for the last pass cannot both win. A spend names what it paid for
(`ref`), and an account pays for a ref once -- rejoining a room is free --
unless it was refunded (a seat that could not be taken after all).

**Gifts.** Sent passes leave the sender at once and wait in a pass_gifts row
until the recipient claims them from the bell (accounts/notifications.py).
One left unclaimed for GIFT_EXPIRY_DAYS goes back to its sender, so passes
are never stranded with an account that stopped logging in.
"""
from __future__ import annotations

import sqlite3
import time
from typing import Any, Iterable, Literal

from accounts import connections, notifications, store
from accounts.store import Account
from config.settings import get_settings

Kind = Literal["A", "D"]
KINDS: tuple[Kind, ...] = ("A", "D")
NAME: dict[str, str] = {"A": "Auctioneer pass", "D": "Delegate pass"}

#: The order, highest first. Admin is not a role but outranks every role.
RANK = {"admin": 0, "auctioneer": 1, "delegate": 2, "member": 3}

DAY = 24 * 3600
MAX_PER_SEND = 100


class PassError(Exception):
    """A refusal to show the person, as one sentence."""


def tier(account: Account) -> str:
    return "admin" if account.admin else account.role


def _plural(kind: str, n: int) -> str:
    return f"{n} {NAME[kind]}{'' if n == 1 else 'es'}"


def enforced() -> bool:
    return get_settings().PASSES_ENFORCED


# ------------------------------------------------------------- the rules --


def can_generate(account: Account, kind: str) -> bool:
    if account.admin:
        return kind in KINDS
    return account.role == "auctioneer" and kind == "D"


def can_send(sender: Account, recipient: Account, kind: str) -> bool:
    """May `sender` send `kind` to `recipient`? Only down the order."""
    if kind not in KINDS or sender.id == recipient.id:
        return False
    if sender.admin:
        return True
    if sender.role == "auctioneer":
        return kind == "D" and not recipient.admin and recipient.role in ("delegate", "member")
    return False


def room_pass(account: Account, action: Literal["create", "seat"], room_type: str) -> Kind | None:
    """The pass a room action costs this account, or None if it is free."""
    if account.admin:
        return None
    if action == "create":
        return "A" if room_type == "auctioneer" else "D"
    return "D"


def capabilities(account: Account) -> dict[str, Any]:
    """What this account may do with passes, for the client to draw."""
    return {
        "tier": tier(account),
        "generate": [k for k in KINDS if can_generate(account, k)],
        "send": ["A", "D"] if account.admin else (["D"] if account.role == "auctioneer" else []),
        "send_to_roles": (
            ["auctioneer", "delegate", "member"] if account.admin
            else ["delegate", "member"] if account.role == "auctioneer" else []
        ),
        "unlimited": account.admin,
        "generate_cap": None if account.admin else (
            get_settings().AUCTIONEER_DAILY_GENERATE_CAP if account.role == "auctioneer" else 0
        ),
    }


# ---------------------------------------------------------------- ledger --


def _write(
    conn: sqlite3.Connection,
    account_id: int,
    kind: str,
    delta: int,
    reason: str,
    ref: str | None = None,
    counterpart_id: int | None = None,
) -> None:
    conn.execute(
        "INSERT INTO pass_ledger (account_id, kind, delta, reason, ref, counterpart_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (account_id, kind, delta, reason, ref, counterpart_id, time.time()),
    )


def _balance(conn: sqlite3.Connection, account_id: int, kind: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(delta), 0) AS n FROM pass_ledger WHERE account_id = ? AND kind = ?",
        (account_id, kind),
    ).fetchone()
    return int(row["n"])


def balances(account_id: int) -> dict[str, int]:
    with store._connect() as conn:
        return {kind: _balance(conn, account_id, kind) for kind in KINDS}


def _generated_today(conn: sqlite3.Connection, account_id: int, kind: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(delta), 0) AS n FROM pass_ledger "
        "WHERE account_id = ? AND kind = ? AND reason = 'generate' AND created_at > ?",
        (account_id, kind, time.time() - DAY),
    ).fetchone()
    return int(row["n"])


def _generate(conn: sqlite3.Connection, account: Account, kind: str, quantity: int) -> None:
    if not can_generate(account, kind):
        if kind == "A":
            raise PassError("Only an administrator can generate Auctioneer passes.")
        raise PassError("Only Auctioneer accounts and administrators can generate Delegate passes.")
    if not account.admin:
        cap = get_settings().AUCTIONEER_DAILY_GENERATE_CAP
        left = cap - _generated_today(conn, account.id, kind)
        if quantity > left:
            raise PassError(
                f"You can generate {max(left, 0)} more Delegate pass{'' if left == 1 else 'es'} today "
                f"(the limit is {cap} a day)."
            )
    _write(conn, account.id, kind, quantity, "generate")


def generate(account: Account, kind: str, quantity: int) -> dict[str, int]:
    """Make passes into this account's own wallet."""
    if kind not in KINDS:
        raise PassError("Unknown pass kind.")
    if not 1 <= quantity <= MAX_PER_SEND:
        raise PassError(f"Generate between 1 and {MAX_PER_SEND} at a time.")
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _generate(conn, account, kind, quantity)
        return {k: _balance(conn, account.id, k) for k in KINDS}


def ledger(account_id: int, limit: int = 50) -> list[dict[str, Any]]:
    with store._connect() as conn:
        rows = conn.execute(
            """
            SELECT l.*, c.name AS counterpart_name FROM pass_ledger l
            LEFT JOIN accounts c ON c.id = l.counterpart_id
            WHERE l.account_id = ? ORDER BY l.id DESC LIMIT ?
            """,
            (account_id, max(1, min(limit, 200))),
        ).fetchall()
    return [
        {
            "id": r["id"], "kind": r["kind"], "delta": r["delta"], "reason": r["reason"],
            "ref": r["ref"], "counterpart": r["counterpart_name"], "created_at": r["created_at"],
        }
        for r in rows
    ]


# ----------------------------------------------------------------- gifts --


def _gift(
    conn: sqlite3.Connection,
    sender: Account | None,
    recipient_id: int,
    kind: str,
    quantity: int,
    note: str | None,
    title: str,
    body: str,
    notification_kind: str = "gift",
) -> int:
    now = time.time()
    cursor = conn.execute(
        "INSERT INTO pass_gifts (sender_id, recipient_id, kind, quantity, note, created_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sender.id if sender else None, recipient_id, kind, quantity, note, now,
         now + get_settings().GIFT_EXPIRY_DAYS * DAY),
    )
    gift_id = int(cursor.lastrowid)
    notifications.add(conn, recipient_id, notification_kind, title, body, gift_id=gift_id)
    return gift_id


def send(
    sender: Account,
    recipient_ids: Iterable[int],
    kind: str,
    quantity: int,
    note: str | None = None,
    generate_missing: bool = False,
) -> dict[str, Any]:
    """
    Send `quantity` passes of `kind` to each recipient, as gifts to claim.

    All or nothing: one recipient the rules refuse refuses the whole send, so
    a sender is never left guessing who got what. With `generate_missing`, an
    account that may generate makes up the shortfall first (within its cap).
    """
    ids = list(dict.fromkeys(int(i) for i in recipient_ids))
    if kind not in KINDS:
        raise PassError("Unknown pass kind.")
    if not ids:
        raise PassError("Choose at least one person to send to.")
    if len(ids) > 50:
        raise PassError("Send to at most 50 people at a time.")
    if not 1 <= quantity <= MAX_PER_SEND:
        raise PassError(f"Send between 1 and {MAX_PER_SEND} passes each.")
    note = (note or "").strip()[:200] or None
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        recipients: list[Account] = []
        for rid in ids:
            recipient = store._account(conn.execute("SELECT * FROM accounts WHERE id = ?", (rid,)).fetchone())
            if recipient is None:
                raise PassError("One of those accounts no longer exists.")
            if not can_send(sender, recipient, kind):
                if kind == "A" and not sender.admin:
                    raise PassError("Only an administrator can send Auctioneer passes.")
                if sender.role == "auctioneer" and (recipient.admin or recipient.role == "auctioneer"):
                    raise PassError(f"{recipient.name} is an Auctioneer: passes go to Delegates and Free accounts only.")
                raise PassError("Your account cannot send passes. They are sent by Auctioneers and administrators.")
            if not sender.admin and not connections.are_connected(conn, sender.id, recipient.id):
                raise PassError(f"Connect with {recipient.name} first: passes go to your connections.")
            recipients.append(recipient)

        needed = quantity * len(recipients)
        have = _balance(conn, sender.id, kind)
        if have < needed:
            if sender.admin or generate_missing:
                _generate(conn, sender, kind, needed - have)
            else:
                raise PassError(
                    f"You have {_plural(kind, have)} and this needs {needed}. Generate more first."
                    if can_generate(sender, kind)
                    else f"You have {_plural(kind, have)} and this needs {needed}."
                )

        gift_ids = []
        for recipient in recipients:
            gift_id = _gift(
                conn, sender, recipient.id, kind, quantity, note,
                title=f"{sender.name} sent you {_plural(kind, quantity)}",
                body=note or "Claim it to add it to your wallet.",
            )
            _write(conn, sender.id, kind, -quantity, "gift_out", f"gift:{gift_id}", recipient.id)
            gift_ids.append(gift_id)
        return {"gifts": gift_ids, "balances": {k: _balance(conn, sender.id, k) for k in KINDS}}


def grant(
    recipient_id: int,
    kind: str,
    quantity: int,
    title: str,
    body: str,
    notification_kind: str = "gift",
    conn: sqlite3.Connection | None = None,
) -> int:
    """A gift from AUCTONIQ itself (the welcome gift), not from an account."""
    if conn is not None:
        return _gift(conn, None, recipient_id, kind, quantity, None, title, body, notification_kind)
    with store._connect() as own:
        return _gift(own, None, recipient_id, kind, quantity, None, title, body, notification_kind)


def claim(account: Account, gift_id: int) -> dict[str, int]:
    """Move a gift's passes into the recipient's wallet."""
    expire_due()
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        gift = conn.execute(
            "SELECT * FROM pass_gifts WHERE id = ? AND recipient_id = ?", (gift_id, account.id)
        ).fetchone()
        if gift is None:
            raise PassError("No such gift.")
        if gift["status"] == "claimed":
            raise PassError("You have already claimed this.")
        if gift["status"] != "pending":
            raise PassError("This gift expired and went back to its sender.")
        now = time.time()
        conn.execute("UPDATE pass_gifts SET status = 'claimed', resolved_at = ? WHERE id = ?", (now, gift_id))
        _write(conn, account.id, gift["kind"], gift["quantity"], "claim", f"gift:{gift_id}", gift["sender_id"])
        conn.execute(
            "UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE gift_id = ? AND account_id = ?",
            (now, gift_id, account.id),
        )
        return {k: _balance(conn, account.id, k) for k in KINDS}


def expire_due(now: float | None = None) -> int:
    """Send every overdue unclaimed gift back to its sender. Returns how many."""
    now = time.time() if now is None else now
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        due = conn.execute(
            "SELECT g.*, r.name AS recipient_name FROM pass_gifts g JOIN accounts r ON r.id = g.recipient_id "
            "WHERE g.status = 'pending' AND g.expires_at < ?",
            (now,),
        ).fetchall()
        for gift in due:
            if gift["sender_id"] is None:
                conn.execute("UPDATE pass_gifts SET status = 'expired', resolved_at = ? WHERE id = ?", (now, gift["id"]))
                continue
            conn.execute("UPDATE pass_gifts SET status = 'returned', resolved_at = ? WHERE id = ?", (now, gift["id"]))
            _write(conn, gift["sender_id"], gift["kind"], gift["quantity"], "gift_returned",
                   f"gift:{gift['id']}", gift["recipient_id"])
            notifications.add(
                conn, gift["sender_id"], "gift_returned",
                f"{_plural(gift['kind'], gift['quantity'])} came back",
                f"{gift['recipient_name']} did not claim them in time, so they are back in your wallet.",
            )
    return len(due)


# ----------------------------------------------------------------- rooms --


def _paid(conn: sqlite3.Connection, account_id: int, ref: str) -> int:
    """Spends on `ref` not since refunded: 1 if it is paid for, else 0."""
    row = conn.execute(
        "SELECT COALESCE(SUM(CASE reason WHEN 'spend' THEN 1 WHEN 'refund' THEN -1 ELSE 0 END), 0) AS n "
        "FROM pass_ledger WHERE account_id = ? AND ref = ?",
        (account_id, ref),
    ).fetchone()
    return int(row["n"])


def spend(account: Account, kind: str, ref: str) -> bool:
    """
    Pay one pass for `ref`. True if a pass was taken now, False if this
    account has already paid for `ref` (or passes are not enforced, or it is
    an admin). Raises PassError if there is none to pay with.
    """
    if account.admin or not enforced():
        return False
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if _paid(conn, account.id, ref) > 0:
            return False
        if _balance(conn, account.id, kind) < 1:
            raise PassError(no_pass_message(account, kind))
        _write(conn, account.id, kind, -1, "spend", ref)
    return True


def refund(account_id: int, ref: str) -> bool:
    """Give back the pass spent on `ref`. True if one was given back."""
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if _paid(conn, account_id, ref) < 1:
            return False
        spent = conn.execute(
            "SELECT kind FROM pass_ledger WHERE account_id = ? AND ref = ? AND reason = 'spend' "
            "ORDER BY id DESC LIMIT 1",
            (account_id, ref),
        ).fetchone()
        _write(conn, account_id, spent["kind"], 1, "refund", ref)
    return True


def paid_for(account_id: int, ref: str) -> bool:
    with store._connect() as conn:
        return _paid(conn, account_id, ref) > 0


def no_pass_message(account: Account, kind: str) -> str:
    if kind == "A":
        return "You are out of Auctioneer passes. Claim one from your notifications, or ask an administrator."
    if account.role == "delegate" or account.role == "member":
        return "You are out of Delegate passes. Ask your Auctioneer to send you one."
    return "You are out of Delegate passes. Generate some from the Send passes menu."


# ------------------------------------------------------------- welcome --


def welcome(account: Account) -> None:
    """The first message a new account finds in its bell, with its gift."""
    settings = get_settings()
    with store._connect() as conn:
        if account.role == "auctioneer" and settings.WELCOME_AUCTIONEER_PASSES > 0:
            n = settings.WELCOME_AUCTIONEER_PASSES
            grant(account.id, "A", n, "Welcome to AUCTONIQ",
                  f"Here {'is' if n == 1 else 'are'} {_plural('A', n)} to open your first auction room. "
                  "Claim it below, then create a room from Live Bidding.",
                  notification_kind="welcome", conn=conn)
        elif account.role == "delegate" and settings.WELCOME_DELEGATE_PASSES > 0:
            n = settings.WELCOME_DELEGATE_PASSES
            grant(account.id, "D", n, "Welcome to AUCTONIQ",
                  f"Here {'is' if n == 1 else 'are'} {_plural('D', n)} to take your first franchise seat. "
                  "Claim it below; your Auctioneer can send you more.",
                  notification_kind="welcome", conn=conn)
        else:
            notifications.add(
                conn, account.id, "welcome", "Welcome to AUCTONIQ",
                "Explore the data room and ask SCOUT anything. To bid in a live auction, connect "
                "with an Auctioneer and they can send you a Delegate pass.",
                link="/connections",
            )


def welcome_missing() -> int:
    """
    Welcome every account that has never been welcomed -- the ones made
    before passes existed -- with the message and gift a new account gets.
    Returns how many. Safe to run on every start: a welcomed account is
    never welcomed twice.
    """
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT a.* FROM accounts a WHERE NOT EXISTS ("
            "SELECT 1 FROM notifications n WHERE n.account_id = a.id AND n.kind = 'welcome')"
        ).fetchall()
    accounts = [store._account(row) for row in rows]
    for account in accounts:
        welcome(account)  # type: ignore[arg-type]
    return len(accounts)


def top_up(account_id: int, kind: str, target: int) -> int:
    """Bring a balance up to `target` (demo accounts). Returns how many were added."""
    with store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        have = _balance(conn, account_id, kind)
        if have >= target:
            return 0
        _write(conn, account_id, kind, target - have, "demo_top_up")
        return target - have
