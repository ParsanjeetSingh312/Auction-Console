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

import json
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from auction.room import RoomError, room
from auction.schemas import ClientMessage

logger = logging.getLogger("auction.ws")

router = APIRouter(prefix="/api/v1/auction", tags=["Auction room"])

# 8 KB is generous for the largest legitimate frame (a join with a display
# name); anything above it is not a client of this protocol.
MAX_FRAME_BYTES = 8 * 1024

# Sustained rate and burst allowance, per connection.
RATE = 20.0  # messages per second
BURST = 40.0

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

    async def connect(self, websocket: WebSocket) -> str:
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


manager = ConnectionManager()


async def _broadcast_state() -> None:
    await manager.broadcast(room.state_payload())


@router.websocket("/ws")
async def auction_socket(websocket: WebSocket) -> None:
    client_id = await manager.connect(websocket)
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
                await _dispatch(client_id, message)
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
        await room.leave(client_id)
        await _broadcast_state()


async def _dispatch(client_id: str, message: Any) -> None:
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
        seat = await room.join(
            client_id, message.role, message.team_id, message.display_name
        )
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

    elif kind == "undo":
        await room.undo(client_id)

    elif kind == "reset":
        await room.reset(client_id)

    elif kind == "finish":
        await room.finish(client_id)
        await manager.send(client_id, {"type": "report", "report": room.report()})

    await _broadcast_state()


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
async def get_state() -> dict[str, Any]:
    """The room's current state, same shape the socket broadcasts."""
    return room.state_payload()


@router.get("/report")
async def get_report() -> dict[str, Any]:
    """
    The closing report.

    Available before the auction finishes as well, because a half-finished
    report is genuinely useful mid-auction — it is how an auctioneer answers
    "who still has no keeper?" without counting by hand.
    """
    return room.report()
