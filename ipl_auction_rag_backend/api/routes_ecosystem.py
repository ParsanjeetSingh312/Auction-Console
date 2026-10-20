"""
routes_ecosystem.py
Passes, the notification bell and connections, for the signed-in account.

    GET    /api/v1/passes                    wallet balances and what this account may do
    GET    /api/v1/passes/ledger             the wallet's history, newest first
    POST   /api/v1/passes/generate           kind, quantity           -> new balances
    POST   /api/v1/passes/send               recipient_ids, kind, quantity, note, generate_missing
    POST   /api/v1/passes/claim              gift_id                  -> new balances

    GET    /api/v1/notifications             the bell: newest first, unread count, balances
    POST   /api/v1/notifications/read        ids (or none for all)
    POST   /api/v1/notifications/broadcast   admins: title, body, link, roles

    GET    /api/v1/admin/overview?days=7    admins: passes given, auctions held, accounts

    GET    /api/v1/connections               friends, incoming and outgoing requests
    GET    /api/v1/connections/search?q=     accounts to connect with
    POST   /api/v1/connections/request       account_id
    POST   /api/v1/connections/{id}/respond  accept
    DELETE /api/v1/connections/{account_id}  disconnect, or withdraw a request

Every rule lives in accounts/ (passes.py says who may generate, send and
spend); this file only finds the account from its session and turns a refusal
into a 400 with the sentence to show.
"""
from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from accounts import admin_stats, connections, invites, notifications, passes
from accounts.store import Account
from api.routes_accounts import account_from_request

router = APIRouter(prefix="/api/v1", tags=["Ecosystem"])


async def _account(request: Request) -> Account:
    account = await asyncio.to_thread(account_from_request, request)
    if account is None:
        raise HTTPException(status_code=401, detail="Not logged in.")
    return account


async def _run(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except (passes.PassError, connections.ConnectionError_) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------- passes --


class GenerateRequest(BaseModel):
    kind: Literal["A", "D"]
    quantity: int = Field(ge=1, le=passes.MAX_PER_SEND)


class SendRequest(BaseModel):
    recipient_ids: list[int] = Field(min_length=1, max_length=50)
    kind: Literal["A", "D"]
    quantity: int = Field(default=1, ge=1, le=passes.MAX_PER_SEND)
    note: str | None = Field(default=None, max_length=200)
    generate_missing: bool = False
    # Sent from a room's waiting room: the recipients become that room's
    # invitees, and the auction cannot start until each has sat down.
    room_code: str | None = Field(default=None, max_length=12)


class ClaimRequest(BaseModel):
    gift_id: int


def _wallet(account: Account) -> dict[str, Any]:
    return {"balances": passes.balances(account.id), "capabilities": passes.capabilities(account)}


@router.get("/passes")
async def wallet(request: Request) -> dict[str, Any]:
    account = await _account(request)
    return await asyncio.to_thread(_wallet, account)


@router.get("/passes/ledger")
async def wallet_ledger(request: Request, limit: int = 50) -> dict[str, Any]:
    account = await _account(request)
    return {"entries": await asyncio.to_thread(passes.ledger, account.id, limit)}


@router.post("/passes/generate")
async def generate(payload: GenerateRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    return {"balances": await _run(passes.generate, account, payload.kind, payload.quantity)}


@router.post("/passes/send")
async def send(payload: SendRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    room = _own_room(account, payload.room_code) if payload.room_code else None
    if room is not None and payload.kind != "D":
        raise HTTPException(status_code=400, detail="Invite delegates to a room with Delegate passes.")
    if room is not None and room.phase not in ("lobby", "waiting"):
        raise HTTPException(status_code=400, detail="The auction has started; the invite list is closed.")
    result = await _run(
        passes.send, account, payload.recipient_ids, payload.kind, payload.quantity,
        payload.note, payload.generate_missing,
    )
    if room is not None:
        ids = list(dict.fromkeys(int(i) for i in payload.recipient_ids))
        await asyncio.to_thread(
            invites.record, room.code, room.instance, account.id, zip(ids, result["gifts"])
        )
    return result


@router.post("/passes/claim")
async def claim(payload: ClaimRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    return {"balances": await _run(passes.claim, account, payload.gift_id)}


# --------------------------------------------------------- notifications --


class ReadRequest(BaseModel):
    ids: list[int] | None = Field(default=None, max_length=200)


class BroadcastRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=600)
    link: str | None = Field(default=None, max_length=200)
    roles: list[Literal["auctioneer", "delegate", "member"]] | None = None


def _bell(account: Account, limit: int) -> dict[str, Any]:
    passes.expire_due()
    return {
        "items": notifications.list_for(account.id, limit),
        "unread": notifications.unread_count(account.id),
        "balances": passes.balances(account.id),
    }


@router.get("/notifications")
async def bell(request: Request, limit: int = 40) -> dict[str, Any]:
    account = await _account(request)
    return await asyncio.to_thread(_bell, account, limit)


@router.post("/notifications/read")
async def read(payload: ReadRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    marked = await asyncio.to_thread(notifications.mark_read, account.id, payload.ids)
    return {"marked": marked, "unread": await asyncio.to_thread(notifications.unread_count, account.id)}


@router.post("/notifications/broadcast")
async def broadcast(payload: BroadcastRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    if not account.admin:
        raise HTTPException(status_code=403, detail="Only administrators can send announcements.")
    link = payload.link if payload.link and payload.link.startswith("/") else None
    sent = await asyncio.to_thread(notifications.broadcast, payload.title, payload.body, link, payload.roles)
    return {"sent": sent}


# ----------------------------------------------------------- connections --


class ConnectRequest(BaseModel):
    account_id: int


class RespondRequest(BaseModel):
    accept: bool


@router.get("/connections")
async def connection_list(request: Request) -> dict[str, Any]:
    account = await _account(request)
    return await asyncio.to_thread(connections.list_for, account)


@router.get("/connections/search")
async def connection_search(request: Request, q: str = "") -> dict[str, Any]:
    account = await _account(request)
    return {"results": await asyncio.to_thread(connections.search, account, q)}


@router.post("/connections/request")
async def connection_request(payload: ConnectRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    return await _run(connections.request, account, payload.account_id)


@router.post("/connections/{connection_id}/respond")
async def connection_respond(connection_id: int, payload: RespondRequest, request: Request) -> dict[str, Any]:
    account = await _account(request)
    return await _run(connections.respond, account, connection_id, payload.accept)


@router.delete("/connections/{account_id}")
async def connection_remove(account_id: int, request: Request) -> dict[str, Any]:
    account = await _account(request)
    await asyncio.to_thread(connections.remove, account, account_id)
    return {"ok": True}


# ----------------------------------------------------------------- admin --


def _live_rooms() -> list[dict[str, Any]]:
    """The rooms open right now, from the in-memory registry."""
    from accounts import store
    from auction.rooms import registry

    out = []
    for entry in registry.entries():
        room = entry.room
        owner = store.account_by_id(room.owner_account_id) if room.owner_account_id else None
        seated = sum(1 for s in room.seats.values() if s.role == "franchise")
        # MAIN sits idle in the lobby on every server; it is only news once used.
        if entry.code == "MAIN" and room.phase == "lobby" and entry.connections == 0:
            continue
        out.append({
            "code": entry.code,
            "phase": room.phase,
            "room_type": room.room_type,
            "teams": len(room.teams),
            "seated": seated,
            "connections": entry.connections,
            "owner": owner.name if owner else None,
        })
    return out


@router.get("/admin/overview")
async def admin_overview(request: Request, days: int = 7) -> dict[str, Any]:
    """Administrators: passes given, auctions held, accounts, recent activity."""
    account = await _account(request)
    if not account.admin:
        raise HTTPException(status_code=403, detail="Only administrators can see the admin panel.")
    live = _live_rooms()
    return await asyncio.to_thread(admin_stats.overview, account, days, live)


# --------------------------------------------------------- waiting room --


def _own_room(account: Account, code: str | None):
    """A room this account runs (or any room, for an admin), still before its start."""
    from auction.rooms import normalise_code, registry

    key = normalise_code(code)
    entry = registry.get(key) if key else None
    if entry is None:
        raise HTTPException(status_code=404, detail="That room is not open.")
    room = entry.room
    if not account.admin and room.owner_account_id != account.id:
        raise HTTPException(status_code=403, detail="Only the room's auctioneer can invite to it.")
    return room


@router.get("/rooms/{code}/waiting")
async def waiting_room(code: str, request: Request) -> dict[str, Any]:
    """The room's invitees and where each stands; what still blocks the start."""
    account = await _account(request)
    room = _own_room(account, code)
    people = await asyncio.to_thread(invites.status, room)
    blockers = await asyncio.to_thread(invites.blockers, room)
    return {
        "code": room.code,
        "phase": room.phase,
        "invitees": people,
        "blockers": blockers,
        "ready": not blockers,
    }


@router.delete("/rooms/{code}/invites/{account_id}")
async def waiting_room_remove(code: str, account_id: int, request: Request) -> dict[str, Any]:
    account = await _account(request)
    room = _own_room(account, code)
    if room.phase not in ("lobby", "waiting"):
        raise HTTPException(status_code=400, detail="The auction has started; the invite list is closed.")
    return {"removed": await asyncio.to_thread(invites.remove, room, account_id)}
