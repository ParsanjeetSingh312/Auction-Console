"""
ws.py
The socket in front of the auction room.

This module does three things and deliberately no more: it holds the open
connections, it validates and attributes every frame, and it broadcasts the
room's state after anything changes. All auction reasoning lives in `room.py`.
Keeping the transport thin is what makes the rules testable without a socket.

The trust boundary is here. Everything arriving on a connection is hostile
until proven otherwise, and it is proven in four steps before the room sees it:

  1. **Size.** A frame larger than `MAX_FRAME_BYTES` is dropped unparsed. JSON
     parsers are a classic place to spend someone else's CPU.
  2. **Rate.** A connection gets `BURST` messages and then one every
     `1/RATE` seconds. A bid flood is the obvious abuse of an auction socket
     and it costs nothing to refuse.
  3. **Shape.** Pydantic's discriminated union parses the frame or rejects it.
     There is no permissive fallback and no default branch.
  4. **Authority.** The action is attributed to the seat held by *this
     connection*, never to anything the frame claims. A franchise cannot bid as
     another franchise because the message has no field for whose bid it is.

Validation failures are answered, not hung up on. A malformed frame is usually
a version mismatch or a bug in a client, and dropping the connection makes that
much harder to diagnose than saying what was wrong.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Response, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from accounts import notifications, passes
from accounts import store as accounts
from accounts.store import Account
from api.routes_accounts import COOKIE, origin_allowed
from auction.report_card import build_team_card
from auction.report_pdf import render_team_pdf
from auction.room import AuctionRoom, RoomError
from auction.rooms import MAIN, RoomEntry, RoomsFull, normalise_code, normalise_kind, registry
from auction.schemas import ClientMessage
from db import get_player_db

logger = logging.getLogger("auction.ws")

router = APIRouter(prefix="/api/v1/auction", tags=["Auction room"])

# 8 KB is generous for the largest legitimate frame (a join with a display
# name); anything above it is not a client of this protocol.
MAX_FRAME_BYTES = 8 * 1024

# Sustained rate and burst allowance, per connection.
RATE = 20.0  # messages per second
BURST = 40.0

# Ceilings on simultaneous connections, per room and across every room. A
# room's twelve franchises, its auctioneer and a gallery of spectators fit well
# within the first; the second is set from the load test (see
# security/loadtest_auction.py) with headroom under where bids start to slow. A
# flood that opens thousands of sockets to exhaust the process is refused at
# the door, which the per-connection rate limiter above cannot do on its own.
ROOM_MAX_CONNECTIONS = 40
MAX_CONNECTIONS = int(os.getenv("AUCTION_MAX_CONNECTIONS", "600"))

_message_adapter: TypeAdapter[Any] = TypeAdapter(ClientMessage)


class RateLimiter:
    """
    A token bucket per connection.

    Chosen over a fixed window because bidding is genuinely bursty — a
    contested lot produces a flurry of legitimate clicks — and a fixed window
    would refuse the honest flurry while still admitting a steady flood.
    """

    __slots__ = ("tokens", "last")

    def __init__(self) -> None:
        self.tokens = BURST
        self.last = time.monotonic()

    def allow(self) -> bool:
        now = time.monotonic()
        self.tokens = min(BURST, self.tokens + (now - self.last) * RATE)
        self.last = now
        if self.tokens < 1.0:
            return False
        self.tokens -= 1.0
        return True


class ConnectionManager:
    """Open sockets, and the one place that writes to them."""

    def __init__(self) -> None:
        self._sockets: dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket) -> str | None:
        # Refuse a new connection past either ceiling, before the handshake
        # completes. 1013 is "try again later", so a legitimate client knows to
        # retry rather than reading it as a protocol error. None tells the caller
        # the socket was closed and it should stop.
        if len(self._sockets) >= ROOM_MAX_CONNECTIONS or total_connections() >= MAX_CONNECTIONS:
            await websocket.close(code=1013)
            return None
        await websocket.accept()
        client_id = uuid.uuid4().hex
        self._sockets[client_id] = websocket
        return client_id

    def disconnect(self, client_id: str) -> None:
        self._sockets.pop(client_id, None)

    async def send(self, client_id: str, payload: dict[str, Any]) -> None:
        socket = self._sockets.get(client_id)
        if socket is None:
            return
        try:
            await socket.send_text(json.dumps(payload))
        except Exception:
            # A send failing means the peer is gone; the receive loop will
            # notice and clean up. Nothing useful to do here.
            logger.debug("send failed for %s", client_id, exc_info=True)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        """
        Fan out to everyone.

        Iterates a copy because a failing send can prompt a disconnect, and
        mutating the dict mid-iteration would drop an unrelated client.
        """
        text = json.dumps(payload)
        for client_id, socket in list(self._sockets.items()):
            try:
                await socket.send_text(text)
            except Exception:
                logger.debug("broadcast drop for %s", client_id, exc_info=True)

    @property
    def count(self) -> int:
        return len(self._sockets)


# One set of sockets per room, keyed by room code. The room object is kept
# beside its manager so a code reopened after its old room was swept gets a
# fresh manager rather than the old room's.
_managers: dict[str, tuple[AuctionRoom, ConnectionManager]] = {}


def total_connections() -> int:
    return sum(manager.count for _, manager in _managers.values())


def manager_for(entry: RoomEntry) -> ConnectionManager:
    """The room's sockets, and the room's clock pointed at them."""
    held = _managers.get(entry.code)
    if held is not None and held[0] is entry.room:
        return held[1]
    manager = ConnectionManager()
    _managers[entry.code] = (entry.room, manager)
    room = entry.room

    async def broadcast_state() -> None:
        await manager.broadcast(room.state_payload())

    # The clock's voice -- see the note at the end of this module.
    room.set_broadcaster(broadcast_state)
    # Forget managers whose rooms have been closed.
    stale = [c for c, (r, _) in _managers.items() if (e := registry.get(c)) is None or e.room is not r]
    for code in stale:
        _managers.pop(code, None)
    return manager


async def _refuse(websocket: WebSocket, code: int, message: str) -> None:
    """
    Turn a connection away with a reason. Accepted first, because a socket
    closed during the handshake reaches a browser as a bare failure with no
    code and no words; the 44xx code tells the client not to retry.
    """
    await websocket.accept()
    await websocket.send_text(json.dumps({"type": "error", "message": message, "about": "room"}))
    await websocket.close(code=code)


def _room_for(code_raw: str | None) -> AuctionRoom:
    """The open room a REST read names, or 404. No code means MAIN."""
    code = normalise_code(code_raw)
    entry = registry.get(code) if code else None
    if entry is None:
        raise HTTPException(status_code=404, detail="No auction room with that code.")
    return entry.room


def _refund_unclaimed(entry: RoomEntry) -> None:
    """A room closed before any auctioneer sat in it: its pass goes back."""
    room = entry.room
    if not entry.claimed and room.create_ref and room.owner_account_id is not None:
        if passes.refund(room.owner_account_id, room.create_ref):
            notifications.notify(
                room.owner_account_id, "gift_returned", "Room pass refunded",
                f"Room {room.code} closed before it started, so its pass is back in your wallet.",
            )


registry.on_close.append(_refund_unclaimed)


@router.websocket("/ws")
async def auction_socket(
    websocket: WebSocket,
    room: str | None = None,
    kind: str | None = None,
    open: str | None = None,  # noqa: A002 - the query parameter's name
    type: str | None = None,  # noqa: A002 - the query parameter's name
) -> None:
    """
    One connection to one room. `?room=<code>` picks it. A code nobody has
    opened is opened only when the connection asks to: `open=1` (the app's
    "create a room": twelve franchise seats, so ten- to twelve-team auctions
    all fit) or an explicit `kind` (mega for ten, mini for twelve). No code
    means MAIN, the room older clients join.
    """
    code = normalise_code(room)
    if code is None:
        await _refuse(websocket, 4400, "That is not a room code. Codes are letters, digits and dashes.")
        return

    # Whose account this connection is: the session cookie the browser sent
    # with the handshake, from a page this server serves (or the dev server).
    # Fixed for the life of the connection; logging in or out reconnects.
    account: Account | None = None
    if origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        account = await asyncio.to_thread(accounts.account_for_session, websocket.cookies.get(COOKIE))

    entry = registry.get(code)
    if entry is None:
        if kind is None and open is None:
            await _refuse(websocket, 4404, "No auction room with that code is open. Check the code with your auctioneer.")
            return
        # What an account may create: an Auctioneer account an auctioneer
        # room, a Delegate account a delegate room (one it runs itself), an
        # administrator either. A delegate asking for an auctioneer room is
        # refused, whatever it sends.
        room_type = "delegate" if type == "delegate" else "auctioneer"
        if account is None:
            await _refuse(websocket, 4403, "Log in to create an auction room.")
            return
        if not account.admin and account.role != room_type:
            await _refuse(
                websocket,
                4403,
                "Delegate accounts can create delegate rooms only, not auctioneer rooms."
                if account.role == "delegate"
                else "Only an Auctioneer account can create an auctioneer room."
                if room_type == "auctioneer"
                else "Only a Delegate account can create a delegate room.",
            )
            return
        # Creating a room costs its kind of pass: an A-pass for an auctioneer
        # room, a D-pass for a delegate room. Admins pay nothing.
        instance = uuid.uuid4().hex[:12]
        create_ref: str | None = None
        pass_kind = passes.room_pass(account, "create", room_type)
        if pass_kind is not None:
            ref = f"room:{code}:{instance}:create"
            try:
                if await asyncio.to_thread(passes.spend, account, pass_kind, ref):
                    create_ref = ref
            except passes.PassError as exc:
                await _refuse(websocket, 4402, str(exc))
                return
        try:
            entry = registry.open(
                code,
                normalise_kind(kind) if kind else "mini",
                owner_account_id=account.id,
                room_type=room_type,
                instance=instance,
            )
        except RoomsFull:
            if create_ref:
                await asyncio.to_thread(passes.refund, account.id, create_ref)
            await _refuse(websocket, 4429, "Every auction room is in use. Try again once one has finished.")
            return
        if entry.room.instance != instance:
            # Someone opened this code while the pass was being taken: this
            # connection joins their room, and its pass goes back.
            if create_ref:
                await asyncio.to_thread(passes.refund, account.id, create_ref)
        else:
            entry.room.create_ref = create_ref
    manager = manager_for(entry)
    client_id = await manager.connect(websocket)
    if client_id is None:
        return  # at capacity; connect() already closed the socket
    registry.connected(entry)
    room = entry.room  # from here on, the room object itself
    limiter = RateLimiter()

    # A connection with no seat yet still gets the state, so a spectator's UI
    # can render the room before anyone chooses who they are.
    await manager.send(client_id, room.state_payload())

    try:
        while True:
            raw = await websocket.receive_text()

            if len(raw) > MAX_FRAME_BYTES:
                await manager.send(
                    client_id,
                    {"type": "error", "message": "Message too large.", "about": "frame"},
                )
                continue

            if not limiter.allow():
                await manager.send(
                    client_id,
                    {
                        "type": "error",
                        "message": "Slow down — too many messages.",
                        "about": "rate",
                    },
                )
                continue

            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send(
                    client_id,
                    {"type": "error", "message": "Malformed JSON.", "about": "parse"},
                )
                continue

            try:
                message = _message_adapter.validate_python(payload)
            except ValidationError as exc:
                await manager.send(
                    client_id,
                    {
                        "type": "error",
                        "message": _first_error(exc),
                        "about": "validation",
                    },
                )
                continue

            try:
                await _dispatch(room, manager, client_id, message, account)
            except RoomError as exc:
                # An expected refusal: wrong role, illegal bid, stale lot. The
                # client is told why and the connection carries on.
                await manager.send(
                    client_id,
                    {"type": "error", "message": exc.message, "about": exc.about},
                )
            except Exception:
                logger.exception("auction action failed")
                await manager.send(
                    client_id,
                    {
                        "type": "error",
                        "message": "The room could not process that.",
                        "about": "server",
                    },
                )

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("socket loop failed for %s", client_id)
    finally:
        manager.disconnect(client_id)
        registry.disconnected(entry)
        await room.leave(client_id)
        await manager.broadcast(room.state_payload())


async def _dispatch(
    room: AuctionRoom,
    manager: ConnectionManager,
    client_id: str,
    message: Any,
    account: Account | None = None,
) -> None:
    """
    Route a validated message to the room, then broadcast what changed.

    Broadcasting once here rather than inside each room method keeps the room
    ignorant of transport — it changes state and returns; this decides who is
    told. `ping` is the one message that changes nothing and so tells nobody.
    """
    kind = message.type

    if kind == "ping":
        await manager.send(client_id, {"type": "pong"})
        return

    if kind == "join":
        # A franchise seat in an account-run room costs a Delegate or Free
        # account one D-pass, once per room: reconnecting is free, and a
        # seat refused below gives the pass straight back.
        spent_ref: str | None = None
        if (
            message.role == "franchise"
            and account is not None
            and room.owner_account_id is not None
            and account.role in ("delegate", "member")
        ):
            pass_kind = passes.room_pass(account, "seat", room.room_type)
            if pass_kind is not None:
                ref = f"room:{room.code}:{room.instance}:seat"
                try:
                    if await asyncio.to_thread(passes.spend, account, pass_kind, ref):
                        spent_ref = ref
                except passes.PassError as exc:
                    raise RoomError(str(exc), about="pass") from exc
        try:
            seat = await room.join(
                client_id,
                message.role,
                message.team_id,
                message.display_name,
                message.password,
                account_id=account.id if account else None,
                account_role=account.role if account else None,
                account_admin=account.admin if account else False,
            )
        except RoomError:
            if spent_ref and account is not None:
                await asyncio.to_thread(passes.refund, account.id, spent_ref)
            raise
        if seat.role == "auctioneer":
            entry = registry.get(room.code)
            if entry is not None:
                entry.claimed = True  # kept for IDLE_SECONDS, not the short wait
        team = room.team_by_id(seat.team_id)
        await manager.send(
            client_id,
            {
                "type": "joined",
                "seat": {
                    "role": seat.role,
                    "team_id": seat.team_id,
                    "team_code": team["code"] if team else None,
                    "client_id": client_id,
                },
                "pass_spent": spent_ref is not None,
            },
        )

    elif kind == "open_waiting_room":
        await room.open_waiting_room(client_id, message.countdown_seconds)

    elif kind == "start_auction":
        await room.start_auction(client_id)

    elif kind == "put_up":
        await room.put_up(client_id, message.player_id)

    elif kind == "bid":
        await room.bid(client_id, message.amount, message.lot_version)

    elif kind == "sell":
        await room.sell(client_id)

    elif kind == "unsold":
        await room.mark_unsold(client_id)

    elif kind == "withdraw":
        await room.withdraw(client_id)

    elif kind == "timeout":
        await room.call_timeout(client_id)

    elif kind == "undo":
        await room.undo(client_id)

    elif kind == "reset":
        await room.reset(client_id)

    elif kind == "set_rules":
        # The broadcast below is what propagates the change: every connected
        # client receives the new rules, the new rules_version and the
        # regenerated briefing in one frame.
        await room.set_rules(
            client_id,
            message.purse,
            message.max_squad,
            message.min_squad,
            message.max_overseas,
            message.max_players,
            message.min_overseas,
        )

    elif kind == "acknowledge_rules":
        await room.acknowledge_rules(client_id, message.rules_version)

    elif kind == "finish":
        await room.finish(client_id)
        await manager.send(client_id, {"type": "report", "report": room.report()})

    await manager.broadcast(room.state_payload())


def _first_error(exc: ValidationError) -> str:
    """
    One readable sentence from a Pydantic error.

    The raw error list is accurate and unreadable, and it echoes the input back
    — which is both noisy and a small information leak. The field and the
    reason are enough for a client author to fix their message.
    """
    errors = exc.errors()
    if not errors:
        return "Invalid message."
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ()) if part != "function-after")
    reason = first.get("msg", "invalid")
    return f"Invalid message{f' at {location}' if location else ''}: {reason}"


# --------------------------------------------------------------------- #
# REST alongside the socket
#
# Both are reads. They exist so a client can inspect the room without holding a
# connection — health checks, the post-auction report opened in a new tab, and
# anything that wants the state once rather than continuously.
# --------------------------------------------------------------------- #


@router.get("/state")
async def get_state(room: str | None = None) -> dict[str, Any]:
    """A room's current state, same shape the socket broadcasts."""
    return _room_for(room).state_payload()


@router.get("/rooms/stats")
async def rooms_stats() -> dict[str, Any]:
    """
    How busy the server is: rooms open and sockets held, against the ceilings.
    Counts only -- no room codes, which would let anyone walk into another
    league's auction.
    """
    entries = registry.entries()
    return {
        "rooms_open": len(entries),
        "rooms_live": sum(1 for e in entries if e.room.phase == "live"),
        "connections": total_connections(),
        "max_connections": MAX_CONNECTIONS,
        "room_max_connections": ROOM_MAX_CONNECTIONS,
    }


# --------------------------------------------------------------------- #
# The clock's voice
#
# Everything else in this module answers a request: a frame arrives, the room
# changes, `_dispatch` broadcasts what changed. A lot that sells because seven
# seconds elapsed has no frame to answer.
#
# Without this line the room settles such a lot correctly and silently, and the
# sale surfaces only when some *other* message happens to trigger a broadcast --
# most visibly a disconnect, since the socket's `finally` block broadcasts on
# the way out. That is the bug where a player appears to sell only when a
# franchise leaves their seat: the auction was right, the telling was missing.
#
# Installed at import, once, and pointed at the same `_broadcast_state` every
# other path uses, so a clock-made settlement and a gavel-made one reach the
# room by exactly the same route.
# --------------------------------------------------------------------- #

manager = manager_for(registry.get(MAIN))  # MAIN's sockets, and its clock's voice


async def _broadcast_state() -> None:
    """MAIN's broadcast. Kept for callers that predate rooms."""
    entry = registry.get(MAIN)
    await manager_for(entry).broadcast(entry.room.state_payload())


@router.get("/report")
async def get_report(room: str | None = None) -> dict[str, Any]:
    """
    The closing report.

    Available before the auction finishes as well, because a half-finished
    report is genuinely useful mid-auction — it is how an auctioneer answers
    "who still has no keeper?" without counting by hand.
    """
    return _room_for(room).report()


@router.get("/report/{team_id}/pdf")
async def get_team_pdf(team_id: int, room: str | None = None) -> Response:
    """
    One franchise's closing report, as a PDF.

    Per franchise rather than one document for the room, and the document holds
    that franchise's figures alone — no standings and no rival squads. A report
    handed to one team that reads out another team's auction is a scouting
    advantage, which is the same reason `/data` shows participants the narrow
    sheet.

    Generated on request rather than written to disk when the auction closes.
    Ten PDFs nobody asked for is ten files to clean up, and the room's state is
    the only input — so the document can be produced at any time and will always
    describe the auction as it stands.

    The full player statistics are read from SQLite here rather than held on the
    room: `Room.load_players` keeps eight fields per player and the report needs
    the batting and bowling columns, so the join happens at report time.
    """
    auction = _room_for(room)
    team = auction.team_by_id(team_id)
    if team is None:
        raise HTTPException(status_code=404, detail=f"No franchise with id {team_id}.")

    try:
        rows = {
            int(row["id"]): row
            for row in get_player_db().get_all_players(limit=10_000, offset=0)
            if row.get("id") is not None
        }
    except Exception:
        # A missing statistics table costs the standout-figure column and the
        # stat-derived weak points, not the report. Everything else is built
        # from the room, which is in memory and always available.
        logger.warning("Could not read player statistics for the PDF", exc_info=True)
        rows = {}

    try:
        card = build_team_card(auction, team_id, rows)
        pdf = render_team_pdf(card)
    except Exception:
        logger.exception("Failed to render the report for team %s", team_id)
        raise HTTPException(
            status_code=500,
            detail="Could not generate the report. See the server logs.",
        ) from None

    stamp = time.strftime("%Y-%m-%d", time.localtime())
    # The franchise's full name as well as its code: ten files called
    # AUCTONIQ-MUM-... in one downloads folder are ten files you have to open to
    # tell apart, and the code alone is not what anyone outside the room calls
    # the team. Non-filename characters are replaced rather than stripped, so a
    # name like "Royal Challengers Bengaluru" survives as a readable slug.
    slug = re.sub(r"[^A-Za-z0-9]+", "-", str(team["name"])).strip("-") or "Franchise"
    filename = f"AUCTONIQ-{slug}-{team['code']}-auction-report-{stamp}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # The room changes; a cached report would describe an auction that
            # has moved on.
            "Cache-Control": "no-store",
        },
    )
