"""
calendar_share.py
"Add to calendar" for scheduled auctions: no Google sign-in, no tokens.

Each scheduled auction can have a share link (`/calendar/<token>`): a public
page showing the auction, with "Add to Google Calendar" (Google's own event
template link, built in the browser) and "Download .ics" (an iCalendar file
that Apple Calendar, Outlook and Google all import). Anyone holding the link
can add the auction to their calendar; the token is long and random, so the
link is the permission, the same way a shared document link works.

The auctioneer can also share an auction with their connections: each gets a
bell notification that opens the share page.

The .ics follows RFC 5545: CRLF line endings, text escaped, long lines folded
at 75 octets, times in UTC, and a stable UID so importing the same auction
twice updates the event instead of duplicating it.
"""
from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone
from typing import Any, Iterable

from accounts import connections, notifications, store
from accounts.store import Account

#: How many people one share may notify at once.
MAX_RECIPIENTS = 50


class ShareError(Exception):
    """A refusal to show the person, as one sentence."""


# ---------------------------------------------------------------- tokens --


def token_for(owner: Account, entry_id: int) -> str:
    """The entry's share token, made on first use. Only the owner may ask."""
    with store._connect() as conn:
        owned = conn.execute(
            "SELECT 1 FROM auction_schedule WHERE id = ? AND owner_id = ?", (entry_id, owner.id)
        ).fetchone()
        if owned is None:
            raise ShareError("That auction is not on your schedule.")
        row = conn.execute("SELECT token FROM schedule_shares WHERE entry_id = ?", (entry_id,)).fetchone()
        if row is not None:
            return row["token"]
        token = secrets.token_urlsafe(18)
        conn.execute(
            "INSERT INTO schedule_shares (entry_id, token, created_at) VALUES (?, ?, ?)",
            (entry_id, token, time.time()),
        )
        return token


def public_entry(token: str) -> dict[str, Any] | None:
    """What the share page shows: the auction and who runs it. None if unknown."""
    if not token or len(token) > 64:
        return None
    with store._connect() as conn:
        row = conn.execute(
            "SELECT s.id, s.title, s.room_type, s.starts_at, s.duration_min, s.notes, s.updated_at, "
            "a.name AS host, sh.token "
            "FROM schedule_shares sh JOIN auction_schedule s ON s.id = sh.entry_id "
            "JOIN accounts a ON a.id = s.owner_id WHERE sh.token = ?",
            (token,),
        ).fetchone()
    return dict(row) if row else None


# ----------------------------------------------------------------- share --


def share(owner: Account, entry_id: int, recipient_ids: Iterable[int]) -> dict[str, Any]:
    """
    Tell connections about a scheduled auction: one bell notification each,
    linking to the share page. An auctioneer reaches its connections; an
    administrator anyone.
    """
    ids = list(dict.fromkeys(int(i) for i in recipient_ids))
    if not ids:
        raise ShareError("Choose at least one person to share with.")
    if len(ids) > MAX_RECIPIENTS:
        raise ShareError(f"Share with at most {MAX_RECIPIENTS} people at a time.")
    token = token_for(owner, entry_id)
    entry = public_entry(token)
    assert entry is not None
    when = datetime.fromtimestamp(entry["starts_at"], tz=timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    with store._connect() as conn:
        for rid in ids:
            if rid == owner.id:
                continue
            recipient = conn.execute("SELECT id, name FROM accounts WHERE id = ?", (rid,)).fetchone()
            if recipient is None:
                raise ShareError("One of those accounts no longer exists.")
            if not owner.admin and not connections.are_connected(conn, owner.id, rid):
                raise ShareError(f"Connect with {recipient['name']} first: auctions are shared with your connections.")
        for rid in ids:
            if rid == owner.id:
                continue
            notifications.add(
                conn,
                rid,
                "schedule",
                f"{owner.name} scheduled {entry['title']}",
                f"{when}. Open it to add the auction to your calendar.",
                link=f"/calendar/{token}",
            )
    return {"token": token, "shared": len([i for i in ids if i != owner.id])}


# ------------------------------------------------------------------- ics --


def _stamp(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> list[str]:
    """Split a content line into 75-octet pieces, continuations starting with a space."""
    out: list[str] = []
    current = ""
    for ch in line:
        limit = 75 if not out else 74  # a continuation spends one octet on its leading space
        if len((current + ch).encode("utf-8")) > limit:
            out.append(current)
            current = ch
        else:
            current += ch
    out.append(current)
    return [out[0]] + [" " + piece for piece in out[1:]]


def ics(entry: dict[str, Any], site_url: str = "", host_domain: str = "auctoniq") -> str:
    """One auction as an iCalendar file, with a reminder 30 minutes before."""
    start = float(entry["starts_at"])
    end = start + int(entry["duration_min"]) * 60
    room = "Auctioneer room" if entry["room_type"] == "auctioneer" else "Delegate room"
    parts = [f"{room} on AUCTONIQ, run by {entry.get('host') or 'your auctioneer'}."]
    if entry.get("notes"):
        parts.append(entry["notes"])
    live = f"{site_url.rstrip('/')}/auction/live" if site_url else ""
    if live:
        parts.append(f"Join on the day: {live}")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//AUCTONIQ//Auction schedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:auction-{entry['id']}@{host_domain}",
        f"DTSTAMP:{_stamp(time.time())}",
        f"LAST-MODIFIED:{_stamp(float(entry.get('updated_at') or time.time()))}",
        f"DTSTART:{_stamp(start)}",
        f"DTEND:{_stamp(end)}",
        f"SUMMARY:{_escape('AUCTONIQ · ' + entry['title'])}",
        f"DESCRIPTION:{_escape(chr(10).join(parts))}",
    ]
    if live:
        lines += [f"URL:{live}", f"LOCATION:{_escape(live)}"]
    lines += [
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:AUCTONIQ auction starts in 30 minutes",
        "TRIGGER:-PT30M",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    folded = [piece for line in lines for piece in _fold(line)]
    return "\r\n".join(folded) + "\r\n"
