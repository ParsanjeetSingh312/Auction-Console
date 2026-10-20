"""
routes_schedule.py
The auctioneer's schedule, its Google Calendar link, and the auctioneer's own
pass figures.

    GET    /api/v1/schedule                    upcoming entries + Google status
    POST   /api/v1/schedule                    title, starts_at, duration_min, notes, room_type
    PATCH  /api/v1/schedule/{id}               any of the above
    DELETE /api/v1/schedule/{id}

    GET    /api/v1/schedule/google/connect     -> Google's consent screen (a browser navigation)
    GET    /api/v1/schedule/google/callback    <- Google, then back to /account
    POST   /api/v1/schedule/google/sync        copy every upcoming entry into Google again
    POST   /api/v1/schedule/google/disconnect

    GET    /api/v1/auctioneer/overview?days=30 Delegate passes generated, given, claimed

    GET    /api/v1/schedule/{id}/share         the auction's public share link
    POST   /api/v1/schedule/{id}/share         recipient_ids -> a bell notification each
    GET    /api/v1/calendar/{token}            the shared auction (public)
    GET    /api/v1/calendar/{token}/ics        the shared auction as an .ics file (public)

Saving an entry never depends on Google: the entry is stored first, then
copied, and a failed copy comes back as `sync.error` beside the saved entry.
"""
from __future__ import annotations

import asyncio
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field

from accounts import admin_stats, calendar_share, google_calendar, schedule
from accounts.store import Account
from api.routes_accounts import account_from_request

router = APIRouter(prefix="/api/v1", tags=["Schedule"])


async def _account(request: Request) -> Account:
    account = await asyncio.to_thread(account_from_request, request)
    if account is None:
        raise HTTPException(status_code=401, detail="Not logged in.")
    return account


async def _scheduler(request: Request) -> Account:
    account = await _account(request)
    if not schedule.can_schedule(account):
        raise HTTPException(status_code=403, detail="Only Auctioneer accounts can schedule auctions.")
    return account


def _site(request: Request) -> str:
    """This site's public address, honouring the proxy's scheme (Railway terminates TLS)."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


async def _call(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except schedule.ScheduleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except google_calendar.GoogleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


async def _sync(account: Account, entry: dict[str, Any], site: str) -> dict[str, Any]:
    """Copy one entry to Google. Never raises: the result says what happened."""
    try:
        event_id = await asyncio.to_thread(google_calendar.upsert_event, account.id, entry, site)
    except google_calendar.GoogleError as exc:
        return {"state": "error", "error": str(exc)}
    except Exception:  # noqa: BLE001 - network trouble must not lose the entry
        return {"state": "error", "error": "Could not reach Google Calendar. The auction is saved in AUCTONIQ."}
    if event_id is None:
        return {"state": "off"}
    if event_id != entry.get("google_event_id"):
        await asyncio.to_thread(schedule.set_google_event, account.id, entry["id"], event_id)
        entry["google_event_id"] = event_id
    return {"state": "synced"}


# ------------------------------------------------------------ schedule --


class EntryIn(BaseModel):
    title: str = Field(min_length=1, max_length=schedule.MAX_TITLE)
    starts_at: float
    duration_min: int = Field(default=120, ge=schedule.MIN_DURATION, le=schedule.MAX_DURATION)
    notes: str = Field(default="", max_length=schedule.MAX_NOTES)
    room_type: Literal["auctioneer", "delegate"] = "auctioneer"


class EntryPatch(BaseModel):
    title: str | None = Field(default=None, max_length=schedule.MAX_TITLE)
    starts_at: float | None = None
    duration_min: int | None = Field(default=None, ge=schedule.MIN_DURATION, le=schedule.MAX_DURATION)
    notes: str | None = Field(default=None, max_length=schedule.MAX_NOTES)
    room_type: Literal["auctioneer", "delegate"] | None = None


@router.get("/schedule")
async def schedule_list(request: Request, past: bool = False) -> dict[str, Any]:
    account = await _scheduler(request)
    entries = await asyncio.to_thread(schedule.list_for, account, include_past=past)
    google = await asyncio.to_thread(google_calendar.status, account.id)
    return {"entries": entries, "google": google}


@router.post("/schedule")
async def schedule_create(payload: EntryIn, request: Request) -> dict[str, Any]:
    account = await _scheduler(request)
    entry = await _call(
        schedule.create, account, payload.title, payload.starts_at, payload.duration_min, payload.notes, payload.room_type
    )
    return {"entry": entry, "sync": await _sync(account, entry, _site(request))}


@router.patch("/schedule/{entry_id}")
async def schedule_update(entry_id: int, payload: EntryPatch, request: Request) -> dict[str, Any]:
    account = await _scheduler(request)
    entry = await _call(schedule.update, account, entry_id, **payload.model_dump())
    return {"entry": entry, "sync": await _sync(account, entry, _site(request))}


@router.delete("/schedule/{entry_id}")
async def schedule_delete(entry_id: int, request: Request) -> dict[str, Any]:
    account = await _scheduler(request)
    entry = await _call(schedule.delete, account, entry_id)
    sync: dict[str, Any] = {"state": "off"}
    if entry.get("google_event_id"):
        try:
            await asyncio.to_thread(google_calendar.delete_event, account.id, entry["google_event_id"])
            sync = {"state": "synced"}
        except Exception as exc:  # noqa: BLE001
            sync = {"state": "error", "error": str(exc) if isinstance(exc, google_calendar.GoogleError) else "Could not reach Google Calendar."}
    return {"ok": True, "sync": sync}


# --------------------------------------------------------------- google --


@router.get("/schedule/google/connect")
async def google_connect(request: Request) -> RedirectResponse:
    account = await asyncio.to_thread(account_from_request, request)
    if account is None:
        return RedirectResponse("/login?next=/account", status_code=303)
    if not schedule.can_schedule(account):
        return RedirectResponse("/account?google=error&reason=" + quote("Only Auctioneer accounts can connect a calendar."), status_code=303)
    try:
        url = google_calendar.consent_url(account.id, google_calendar.redirect_uri(_site(request)))
    except google_calendar.GoogleError as exc:
        return RedirectResponse("/account?google=error&reason=" + quote(str(exc)), status_code=303)
    return RedirectResponse(url, status_code=303)


@router.get("/schedule/google/callback")
async def google_callback(
    request: Request, code: str | None = None, state: str | None = None, error: str | None = None
) -> RedirectResponse:
    account = await asyncio.to_thread(account_from_request, request)
    if account is None:
        return RedirectResponse("/login?next=/account", status_code=303)
    if error or not code or not state:
        reason = "Google sign-in was cancelled." if error == "access_denied" else "Google sign-in did not finish."
        return RedirectResponse("/account?google=error&reason=" + quote(reason), status_code=303)
    try:
        await asyncio.to_thread(google_calendar.complete, account.id, state, code)
    except google_calendar.GoogleError as exc:
        return RedirectResponse("/account?google=error&reason=" + quote(str(exc)), status_code=303)
    except Exception:  # noqa: BLE001
        return RedirectResponse("/account?google=error&reason=" + quote("Could not reach Google. Try again."), status_code=303)
    # Bring everything already scheduled across.
    site = _site(request)
    for entry in await asyncio.to_thread(schedule.list_for, account):
        await _sync(account, entry, site)
    return RedirectResponse("/account?google=connected", status_code=303)


@router.post("/schedule/google/sync")
async def google_sync(request: Request) -> dict[str, Any]:
    account = await _scheduler(request)
    site = _site(request)
    results = [await _sync(account, e, site) for e in await asyncio.to_thread(schedule.list_for, account)]
    errors = [r["error"] for r in results if r["state"] == "error"]
    return {"synced": sum(r["state"] == "synced" for r in results), "errors": errors[:3]}


@router.post("/schedule/google/disconnect")
async def google_disconnect(request: Request) -> dict[str, Any]:
    account = await _scheduler(request)
    return await asyncio.to_thread(google_calendar.disconnect, account.id)


# ----------------------------------------------------------- auctioneer --


@router.get("/auctioneer/overview")
async def auctioneer_overview(request: Request, days: int = 30) -> dict[str, Any]:
    account = await _scheduler(request)
    return await asyncio.to_thread(admin_stats.auctioneer_overview, account, days)


# -------------------------------------------------------- add to calendar --
#
# No Google sign-in: a share link per auction, an .ics file anyone's calendar
# imports, and a bell notification to the auctioneer's connections
# (accounts/calendar_share.py).


class ShareIn(BaseModel):
    recipient_ids: list[int] = Field(min_length=1, max_length=calendar_share.MAX_RECIPIENTS)


@router.get("/schedule/{entry_id}/share")
async def schedule_share_link(entry_id: int, request: Request) -> dict[str, Any]:
    """The auction's public share link, made on first request."""
    account = await _scheduler(request)
    try:
        token = await asyncio.to_thread(calendar_share.token_for, account, entry_id)
    except calendar_share.ShareError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"token": token, "path": f"/calendar/{token}"}


@router.post("/schedule/{entry_id}/share")
async def schedule_share(entry_id: int, payload: ShareIn, request: Request) -> dict[str, Any]:
    """Send the auction to connections' bells, each linking to the share page."""
    account = await _scheduler(request)
    try:
        return await asyncio.to_thread(calendar_share.share, account, entry_id, payload.recipient_ids)
    except calendar_share.ShareError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/calendar/{token}")
async def calendar_public(token: str) -> dict[str, Any]:
    """A shared auction, for its public page. No login: the link is the permission."""
    entry = await asyncio.to_thread(calendar_share.public_entry, token)
    if entry is None:
        raise HTTPException(status_code=404, detail="This auction link is not valid, or the auction was removed.")
    return {k: entry[k] for k in ("title", "room_type", "starts_at", "duration_min", "notes", "host", "token")}


@router.get("/calendar/{token}/ics")
async def calendar_ics(token: str, request: Request) -> Response:
    """The shared auction as an .ics file for Apple Calendar, Outlook or Google."""
    entry = await asyncio.to_thread(calendar_share.public_entry, token)
    if entry is None:
        raise HTTPException(status_code=404, detail="This auction link is not valid, or the auction was removed.")
    site = _site(request)
    body = calendar_share.ics(entry, site, host_domain=request.headers.get("host", "auctoniq").split(":")[0])
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="auctoniq-auction.ics"'},
    )
