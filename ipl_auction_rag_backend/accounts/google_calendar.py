"""
google_calendar.py
Connecting an auctioneer's Google Calendar, and copying their schedule into it.

The flow is Google's standard OAuth 2.0 for web servers:

    1. /schedule/google/connect   sends the browser to Google's consent screen
                                  with a one-time `state`
    2. Google sends it back to    /schedule/google/callback?code=...&state=...
    3. the code is exchanged for an access token and a refresh token; only the
       refresh token is kept for long (google_links), access tokens are
       re-minted from it when they expire

Scopes: `openid email` (to show which Google account is connected) and
`calendar.events` (to add, change and remove the events AUCTONIQ made -- it
never reads the rest of the calendar).

Nothing here is required for the schedule to work. With no client configured
(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) `configured()` is False and the app
says so; a Google call that fails is reported back as a sync problem and the
schedule entry stays saved in AUCTONIQ.
"""
from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

from accounts import store
from config.settings import get_settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{calendar}/events"
SCOPES = "openid email https://www.googleapis.com/auth/calendar.events"

#: How long a consent-screen round trip may take.
STATE_SECONDS = 10 * 60
TIMEOUT = 15.0

# One-time states, kept in this process (the server runs one process; see
# auction/rooms.py). state -> (account_id, redirect_uri, expires_at)
_states: dict[str, tuple[int, str, float]] = {}


class GoogleError(Exception):
    """A refusal or failure to show the person, as one sentence."""


def configured() -> bool:
    s = get_settings()
    return bool(s.GOOGLE_CLIENT_ID and s.GOOGLE_CLIENT_SECRET)


def redirect_uri(request_base: str) -> str:
    """The callback address: the configured one, else this server's own."""
    configured_url = get_settings().GOOGLE_REDIRECT_URL.strip()
    if configured_url:
        return configured_url
    return request_base.rstrip("/") + "/api/v1/schedule/google/callback"


# ------------------------------------------------------------- connect --


def consent_url(account_id: int, redirect: str) -> str:
    """Google's consent screen for this account, with a fresh one-time state."""
    if not configured():
        raise GoogleError("Google Calendar is not set up on this server yet.")
    now = time.time()
    for key in [k for k, (_, _, exp) in _states.items() if exp < now]:
        _states.pop(key, None)
    state = secrets.token_urlsafe(24)
    _states[state] = (account_id, redirect, now + STATE_SECONDS)
    return AUTH_URL + "?" + urlencode({
        "client_id": get_settings().GOOGLE_CLIENT_ID,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",     # a refresh token, so sync keeps working
        "prompt": "consent",          # ...and Google re-issues it on reconnect
        "include_granted_scopes": "true",
        "state": state,
    })


def complete(account_id: int, state: str, code: str) -> dict[str, Any]:
    """Finish the round trip: check the state, swap the code, store the link."""
    held = _states.pop(state, None)
    if held is None or held[0] != account_id or held[2] < time.time():
        raise GoogleError("That Google sign-in expired or was not started here. Try connecting again.")
    redirect = held[1]
    s = get_settings()
    with httpx.Client(timeout=TIMEOUT) as client:
        response = client.post(TOKEN_URL, data={
            "code": code,
            "client_id": s.GOOGLE_CLIENT_ID,
            "client_secret": s.GOOGLE_CLIENT_SECRET,
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
        })
        if response.status_code != 200:
            raise GoogleError("Google did not accept the sign-in. Try connecting again.")
        tokens = response.json()
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise GoogleError("Google did not grant offline access. Remove AUCTONIQ from your Google account's third-party access and connect again.")
        email = None
        info = client.get(USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"})
        if info.status_code == 200:
            email = info.json().get("email")
    now = time.time()
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO google_links (account_id, google_email, refresh_token, access_token, expires_at, linked_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(account_id) DO UPDATE SET google_email = excluded.google_email, "
            "refresh_token = excluded.refresh_token, access_token = excluded.access_token, "
            "expires_at = excluded.expires_at, linked_at = excluded.linked_at",
            (account_id, email, refresh, tokens.get("access_token"),
             now + float(tokens.get("expires_in", 3600)) - 60, now),
        )
    return status(account_id)


def status(account_id: int) -> dict[str, Any]:
    with store._connect() as conn:
        row = conn.execute(
            "SELECT google_email, linked_at FROM google_links WHERE account_id = ?", (account_id,)
        ).fetchone()
    return {
        "configured": configured(),
        "connected": row is not None,
        "email": row["google_email"] if row else None,
        "linked_at": row["linked_at"] if row else None,
    }


def disconnect(account_id: int) -> dict[str, Any]:
    """Forget the link, and ask Google to revoke the token too."""
    with store._connect() as conn:
        row = conn.execute("SELECT refresh_token FROM google_links WHERE account_id = ?", (account_id,)).fetchone()
        conn.execute("DELETE FROM google_links WHERE account_id = ?", (account_id,))
    if row is not None:
        try:
            httpx.post(REVOKE_URL, data={"token": row["refresh_token"]}, timeout=TIMEOUT)
        except httpx.HTTPError:
            pass  # the link is gone on our side either way
    return status(account_id)


# -------------------------------------------------------------- tokens --


def _access_token(account_id: int) -> tuple[str, str] | None:
    """A live access token and the calendar id, refreshing if needed; None if not connected."""
    with store._connect() as conn:
        row = conn.execute("SELECT * FROM google_links WHERE account_id = ?", (account_id,)).fetchone()
    if row is None:
        return None
    if row["access_token"] and (row["expires_at"] or 0) > time.time():
        return row["access_token"], row["calendar_id"]
    s = get_settings()
    response = httpx.post(TOKEN_URL, data={
        "client_id": s.GOOGLE_CLIENT_ID,
        "client_secret": s.GOOGLE_CLIENT_SECRET,
        "refresh_token": row["refresh_token"],
        "grant_type": "refresh_token",
    }, timeout=TIMEOUT)
    if response.status_code != 200:
        raise GoogleError("Google Calendar access was withdrawn. Connect it again to keep syncing.")
    tokens = response.json()
    with store._connect() as conn:
        conn.execute(
            "UPDATE google_links SET access_token = ?, expires_at = ? WHERE account_id = ?",
            (tokens["access_token"], time.time() + float(tokens.get("expires_in", 3600)) - 60, account_id),
        )
    return tokens["access_token"], row["calendar_id"]


# -------------------------------------------------------------- events --


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def event_body(entry: dict[str, Any], site_url: str = "") -> dict[str, Any]:
    room = "Auctioneer room" if entry["room_type"] == "auctioneer" else "Delegate room"
    lines = [f"{room} on AUCTONIQ."]
    if entry.get("notes"):
        lines.append(entry["notes"])
    if site_url:
        lines.append(f"Open Live Bidding: {site_url.rstrip('/')}/auction/live")
    return {
        "summary": f"AUCTONIQ · {entry['title']}",
        "description": "\n\n".join(lines),
        "start": {"dateTime": _iso(entry["starts_at"]), "timeZone": "UTC"},
        "end": {"dateTime": _iso(entry["starts_at"] + entry["duration_min"] * 60), "timeZone": "UTC"},
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 30}]},
        "source": {"title": "AUCTONIQ", "url": f"{site_url.rstrip('/')}/account"} if site_url else None,
    }


def upsert_event(account_id: int, entry: dict[str, Any], site_url: str = "") -> str | None:
    """
    Copy an entry into the owner's Google Calendar. Returns the Google event id,
    or None when the account has not connected Google. Raises GoogleError on a
    failed call.
    """
    if not configured():
        return None
    token = _access_token(account_id)
    if token is None:
        return None
    access, calendar = token
    body = {k: v for k, v in event_body(entry, site_url).items() if v is not None}
    url = EVENTS_URL.format(calendar=calendar)
    headers = {"Authorization": f"Bearer {access}"}
    with httpx.Client(timeout=TIMEOUT) as client:
        if entry.get("google_event_id"):
            response = client.patch(f"{url}/{entry['google_event_id']}", json=body, headers=headers)
            if response.status_code in (404, 410):  # deleted in Google: make it again
                response = client.post(url, json=body, headers=headers)
        else:
            response = client.post(url, json=body, headers=headers)
    if response.status_code not in (200, 201):
        raise GoogleError("Google Calendar did not accept the event. It is still saved in AUCTONIQ.")
    return response.json().get("id")


def delete_event(account_id: int, event_id: str | None) -> None:
    if not event_id or not configured():
        return
    token = _access_token(account_id)
    if token is None:
        return
    access, calendar = token
    response = httpx.delete(
        f"{EVENTS_URL.format(calendar=calendar)}/{event_id}",
        headers={"Authorization": f"Bearer {access}"},
        timeout=TIMEOUT,
    )
    if response.status_code not in (200, 204, 404, 410):
        raise GoogleError("Google Calendar did not remove the event. Remove it there by hand.")
