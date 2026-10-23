"""
ai_auctioneer.py
The AI auctioneer: the judge of an online room whose chair is set to AI.

An online room already runs itself -- the random draw brings each player to
the block and the clock settles each lot -- so what the chair adds is judgment
and voice. On every room event this posts a call to the room's auctioneer
feed (auction/room.py `post_feed`), which every screen shows:

    lot_open   the player announced: who he is, what the numbers say, what
               AUCTONIQ values him at, anything SCOUT has on his form
    sold       the result and the room's verdict on it (steal, good bid, fair
               price, paid over), computed from the AUCTONIQ value curve
    unsold     the pass, said plainly
    finished   a closing summary: biggest buy, best value, biggest spender

What it says comes from auction/auctioneer_brain.py; this module only listens,
schedules and posts. It is registered as a room event hook, so it hears every
room, and speaks only in those whose chair is AI and is not paused by the
human in it. Its work runs as background tasks: a slow model can never delay
a bid, a sale or the next draw.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from auction import auctioneer_brain as brain
from auction.room import EVENT_HOOKS, AuctionRoom

logger = logging.getLogger("auction.ai")

#: Rows per room, read once (see brain.PoolRows); keyed by room identity.
_rows: dict[int, brain.PoolRows] = {}
#: The task speaking in each room, so a call superseded by the next lot can
#: still finish -- calls are about their own player and are labelled with him.
_tasks: set[asyncio.Task[Any]] = set()


def _on_event(room: AuctionRoom, kind: str, data: dict[str, Any]) -> None:
    """The room hook. Lock held, synchronous: schedule, never wait."""
    if not room.ai_active or room.ai_paused:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # a synchronous caller: nothing to speak to
    task = loop.create_task(_call(room, kind, dict(data)))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _call(room: AuctionRoom, kind: str, data: dict[str, Any]) -> None:
    rows = _rows.setdefault(id(room), brain.PoolRows())
    room.ai_status = "thinking"
    try:
        extra: dict[str, Any] = {}
        if kind == "lot_open":
            notes = await brain.scout_notes(data["player"])
            facts, fallback = await asyncio.to_thread(brain.lot_facts, room, rows, data["player_id"], notes)
            extra = {"player": data["player"], "player_id": data["player_id"], "sources": _sources(notes)}
            kind_out = "announce"
        elif kind == "sold":
            facts, fallback, ruling = brain.sale_facts(room, data)
            extra = {"player": data["player"], "player_id": data["player_id"], "verdict": ruling,
                     "team_code": data.get("team_code"), "price": data["price"], "sources": ["AUCTONIQ value"]}
            kind_out = "sold"
        elif kind == "unsold":
            facts, fallback = brain.unsold_facts(room, data)
            extra = {"player": data["player"], "player_id": data["player_id"]}
            kind_out = "unsold"
        elif kind == "finished":
            facts, fallback = brain.summary_facts(room)
            kind_out = "summary"
        else:
            return
        line, source = await brain.speak(facts, fallback)
        # The human may have paused or taken over while the model thought.
        if not room.ai_active or room.ai_paused:
            return
        room.post_feed(kind_out, line, source=source, **extra)
        await room._announce()
    except Exception:  # noqa: BLE001 - the auctioneer is a voice; the room carries on
        logger.exception("AI auctioneer call failed (%s)", kind)
    finally:
        room.ai_status = "presiding" if room.ai_active else "idle"


def _sources(notes: list[str]) -> list[str]:
    out = ["Player data", "AUCTONIQ value"]
    if notes:
        out.append("SCOUT")
    return out


def install() -> None:
    """Register the hook once. Imported by auction/ws.py."""
    if _on_event not in EVENT_HOOKS:
        EVENT_HOOKS.append(_on_event)


install()
