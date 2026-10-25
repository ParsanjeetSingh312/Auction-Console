"""
rooms.py
More than one auction at a time.

`room.py` is one auction, and for a long time the server ran exactly one: a
single module-level `AuctionRoom`. That holds for one league night. It does not
hold for a season that runs four mini auctions and two mega auctions -- six
auctioneers each needing their own chair, their own block and their own purses.
With one room the second auctioneer was told the chair was taken, and every
franchise past the tenth was told the room was full.

So the server now keeps rooms by code, all in this one process. Rooms stay in
memory for the same reason the single room did (see room.py): the bid path
must not touch a database. One process is still the rule -- a second worker
would be a second, separate set of rooms -- and that is fine, because a room
costs almost nothing: its share of a broadcast is a few kilobytes to a dozen
sockets.

**The default room is unchanged.** It is code MAIN, a mega auction with ten
franchises, and it is the `room` every older import of `auction.room` still
gets. A client that sends no room code lands in it, exactly as before.

**Other rooms are opened on purpose.** A connection that names a new code and
asks to open it does: `open=1` is the app's "create a room", and an explicit
kind (mega or mini) is kept for tools such as the load test. Every room opens
with the ten IPL franchises, and its auctioneer may add any number of fictional
ones before the auction starts (`AuctionRoom.add_franchise`). A connection that names a code nobody has opened, with
no kind, is told there is no such room, so a franchise who mistypes a code is
told so instead of being seated alone in an empty auction.

Opening is bounded: at most MAX_ROOMS at once, codes from a short alphabet, and
a room nobody is connected to is closed after a while -- IDLE_SECONDS once an
auctioneer has taken its chair, UNCLAIMED_IDLE_SECONDS if no auctioneer ever
did, so codes opened and abandoned cannot hold the slots for long. MAIN is
never closed.
"""
from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from auction.room import AuctionRoom, room as main_room
from auction.rules import TEAMS_BY_KIND

logger = logging.getLogger("auction.rooms")

MAIN = "MAIN"

#: How many auctions may be open at once, MAIN included. The season's six with
#: room to spare; the load test (security/loadtest_auction.py) shows the
#: process carries several times this before bids slow down.
MAX_ROOMS = int(os.getenv("AUCTION_MAX_ROOMS", "24"))

#: A room with nobody connected for this long is closed. Long enough to cover
#: a break, a dropped laptop or the post-auction report being read the next
#: morning; short enough that abandoned codes do not accumulate.
IDLE_SECONDS = 12 * 3600

#: The same, for a room no auctioneer has ever sat in.
UNCLAIMED_IDLE_SECONDS = 15 * 60

ROOM_CODE = re.compile(r"^[A-Z0-9][A-Z0-9-]{0,23}$")

Kind = Literal["mega", "mini"]


class RoomsFull(Exception):
    """No room may be opened: MAX_ROOMS are already open."""


@dataclass
class RoomEntry:
    code: str
    kind: Kind
    room: AuctionRoom
    connections: int = 0
    last_seen: float = field(default_factory=time.monotonic)
    #: An auctioneer has taken the chair at least once.
    claimed: bool = False


def normalise_code(raw: str | None) -> str | None:
    """A room code as the server keys it, or None if it is not a valid one."""
    if raw is None or not raw.strip():
        return MAIN
    code = raw.strip().upper()
    return code if ROOM_CODE.match(code) else None


def normalise_kind(raw: str | None) -> Kind:
    return "mini" if (raw or "").strip().lower() == "mini" else "mega"


class RoomRegistry:
    def __init__(self, main: AuctionRoom) -> None:
        self._rooms: dict[str, RoomEntry] = {MAIN: RoomEntry(MAIN, "mega", main)}
        self._pool: list[dict[str, Any]] = []
        #: Called with each room the sweep closes (auction/ws.py refunds the
        #: pass of a room no auctioneer ever sat in).
        self.on_close: list[Callable[[RoomEntry], None]] = []

    # ------------------------------------------------------------ pool --

    def set_pool(self, rows: list[dict[str, Any]]) -> None:
        """The player rows every new room loads. MAIN is loaded by its owner."""
        self._pool = list(rows)

    def refresh_pool(self, rows: list[dict[str, Any]]) -> list[str]:
        """
        Re-load the pool into every room not mid-auction, after an ingest.
        Returns the codes of the rooms that kept their old pool because an
        auction was running in them.
        """
        self._pool = list(rows)
        kept = []
        for entry in self._rooms.values():
            if entry.room.phase in ("lobby", "finished"):
                entry.room.load_players(rows)
            else:
                kept.append(entry.code)
        return kept

    # ----------------------------------------------------------- rooms --

    def get(self, code: str) -> RoomEntry | None:
        return self._rooms.get(code)

    def open(
        self,
        code: str,
        kind: Kind,
        owner_account_id: int | None = None,
        room_type: Literal["auctioneer", "delegate"] = "auctioneer",
        instance: str | None = None,
    ) -> RoomEntry:
        """
        The room with this code, opening it as `kind` if it is not open. A room
        opened by an account seats by account (see AuctionRoom.owner_account_id).
        """
        entry = self._rooms.get(code)
        if entry is not None:
            return entry
        self.sweep()
        if len(self._rooms) >= MAX_ROOMS:
            raise RoomsFull(f"{MAX_ROOMS} auctions are already open.")
        room = AuctionRoom(code=code, kind=kind, owner_account_id=owner_account_id, room_type=room_type)
        if instance:
            room.instance = instance
        room.configure_seats(TEAMS_BY_KIND[kind])
        if self._pool:
            room.load_players(self._pool)
        entry = RoomEntry(code, kind, room)
        self._rooms[code] = entry
        logger.info("Opened auction room %s (%s, %d franchises)", code, kind, len(room.teams))
        return entry

    def connected(self, entry: RoomEntry) -> None:
        entry.connections += 1
        entry.last_seen = time.monotonic()

    def disconnected(self, entry: RoomEntry) -> None:
        entry.connections = max(0, entry.connections - 1)
        entry.last_seen = time.monotonic()

    def sweep(self, now: float | None = None) -> list[str]:
        """Close every room but MAIN that nobody has been in for long enough."""
        now = time.monotonic() if now is None else now
        closed = [
            code
            for code, entry in self._rooms.items()
            if code != MAIN
            and entry.connections == 0
            and now - entry.last_seen > (IDLE_SECONDS if entry.claimed else UNCLAIMED_IDLE_SECONDS)
        ]
        for code in closed:
            entry = self._rooms.pop(code)
            entry.room._disarm()
            logger.info("Closed idle auction room %s", code)
            for hook in self.on_close:
                try:
                    hook(entry)
                except Exception:  # noqa: BLE001 - one hook must not stop the sweep
                    logger.exception("on_close hook failed for room %s", code)
        return closed

    def close(self, code: str) -> RoomEntry | None:
        """
        Close one room now, whoever is still in it. Never MAIN.

        The sweep closes rooms nobody is in; this closes a room on purpose --
        its auctioneer starting the next auction under a fresh code
        (auction/ws.py, `new_auction`). The caller tells the room's sockets
        first; the same close hooks run as for a swept room.
        """
        if code == MAIN:
            return None
        entry = self._rooms.pop(code, None)
        if entry is None:
            return None
        entry.room._disarm()
        logger.info("Closed auction room %s", code)
        for hook in self.on_close:
            try:
                hook(entry)
            except Exception:  # noqa: BLE001 - one hook must not stop the close
                logger.exception("on_close hook failed for room %s", code)
        return entry

    def entries(self) -> list[RoomEntry]:
        return list(self._rooms.values())

    def any_running(self) -> tuple[bool, str]:
        """Whether a lot is in play in any room, and that room's phase."""
        for entry in self._rooms.values():
            if entry.room.phase not in ("lobby", "finished"):
                return True, entry.room.phase
        return False, self._rooms[MAIN].room.phase


registry = RoomRegistry(main_room)
