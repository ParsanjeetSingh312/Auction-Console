"""
room.py
The auction, owned by the server.

Phase 2 put the auction in the browser, which was the right call at the time:
one operator, one screen, and `localStorage` made a refresh survivable. It
stops being the right call the moment a second person joins. Ten franchises
cannot watch one block from ten copies of the state, "franchises may not start
the auction" is unenforceable where the franchise owns the state, and there is
nowhere to put a bid lock when every client holds its own ledger.

So this module owns it. There is exactly one `AuctionRoom` per process, it is
the only thing that may change the auction, and every client is a subscriber.
The browser engine survives untouched for `/console`, which is now explicitly
the *offline* path.

Three properties are load-bearing and worth stating plainly.

**Serialisation.** Every mutating method runs under one `asyncio.Lock`. Two
franchises pressing bid in the same tick do not interleave; one wins, the other
sees the raised price and is told it was outbid. The lock is coarse on purpose
-- an auction is a sequence of single decisions, and making it concurrent would
buy throughput nobody needs at the cost of exactly the bug that matters.

**Staleness.** A lock alone is not enough. Both bidders can still be *serialised*
into applying a bid to a lot that has moved, which is how you get two teams
paying the same price for one player. So a bid may carry the `lot_version` it
was made against, and one made against a superseded lot is refused rather than
applied. The lock decides who goes first; the version decides whether going
first was still meaningful.

**Authority over identity.** No client message says who sent it. The seat is
assigned when a connection joins and held here, keyed by connection. A message
is attributed by the socket it arrived on, so a franchise cannot bid as another
franchise or call itself the auctioneer -- there is no field in which to lie.

Money is ₹ lakh throughout, matching the frontend exactly. The increment ladder
and the legality rules below are deliberate transcriptions of `format.ts` and
`useAuctionEngine.ts`; if either side changes, both must.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger("auction.room")


def _current_task() -> "asyncio.Task[Any] | None":
    """`asyncio.current_task()` outside a running loop, without the exception."""
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None

# --------------------------------------------------------------------- #
# Rules, transcribed from the client
# --------------------------------------------------------------------- #

BASE_PRICE_FLOOR = 30  # format.ts BASE_PRICE_FLOOR
MAX_LOG = 400
MAX_UNDO = 60

# --------------------------------------------------------------------- #
# The clock
#
# Four numbers, and between them they are the whole of the bidding lifecycle.
#
#   OPEN_SECONDS      a lot with no bid on it. Lapses into UNSOLD.
#   CLOSE_SECONDS     a lot with a bid standing. Lapses into SOLD.
#   TIMEOUT_SECONDS   a franchise has spent a lifeline. The thirty seconds are
#                     the thinking window, so lapsing also means SOLD -- a
#                     strategy timer nobody answered is still nobody answering.
#   TIMEOUTS_PER_TEAM how many of those a franchise gets for the whole auction.
#
# They are carried in `rules` and broadcast, not compiled into the client,
# because the dial, the lifeline counter and the room must not be able to
# disagree about how long seven seconds is.
# --------------------------------------------------------------------- #

OPEN_SECONDS = 7
CLOSE_SECONDS = 7
TIMEOUT_SECONDS = 30
TIMEOUTS_PER_TEAM = 3

DEFAULT_TEAMS: list[dict[str, Any]] = [
    {"id": 1, "name": "Mumbai", "code": "MUM", "color": "#123E8C"},
    {"id": 2, "name": "Chennai", "code": "CHE", "color": "#B58200"},
    {"id": 3, "name": "Bengaluru", "code": "BLR", "color": "#A62B22"},
    {"id": 4, "name": "Kolkata", "code": "KOL", "color": "#5C3B8F"},
    {"id": 5, "name": "Delhi", "code": "DEL", "color": "#1E86A8"},
    {"id": 6, "name": "Punjab", "code": "PBK", "color": "#B2354F"},
    {"id": 7, "name": "Rajasthan", "code": "RAJ", "color": "#C4557E"},
    {"id": 8, "name": "Hyderabad", "code": "HYD", "color": "#C2622A"},
    {"id": 9, "name": "Lucknow", "code": "LKO", "color": "#1E7A5E"},
    {"id": 10, "name": "Ahmedabad", "code": "AHM", "color": "#2B4F6E"},
]

DEFAULT_RULES = {
    "purse": 12000,
    "max_squad": 25,
    "min_squad": 18,
    "max_overseas": 8,
    "open_seconds": OPEN_SECONDS,
    "close_seconds": CLOSE_SECONDS,
    "timeout_seconds": TIMEOUT_SECONDS,
    "timeouts_per_team": TIMEOUTS_PER_TEAM,
}

# Playing XI shape. Not a hard constraint of the auction -- it is how the
# post-auction report picks a side, and a side with no keeper is not a side.
XI_SIZE = 11
XI_MAX_OVERSEAS = 4


def increment_for(bid: int) -> int:
    """The ladder, exactly as `format.ts` defines it."""
    if bid < 100:
        return 5
    if bid < 200:
        return 10
    if bid < 500:
        return 20
    if bid < 1000:
        return 25
    return 50


def role_short(role: str) -> str:
    """Four-way short code, matching the client's `roleShort`."""
    text = (role or "").strip().lower()
    if "keeper" in text or text == "wk":
        return "WK"
    if "all" in text:
        return "AR"
    if "bowl" in text:
        return "BOWL"
    return "BAT"


def money(lakh: int | float | None) -> str:
    """₹ lakh rendered the way the console renders it, for ledger strings."""
    if lakh is None:
        return "—"
    if lakh >= 100:
        return f"₹{lakh / 100:.2f} Cr"
    return f"₹{lakh} L"


# --------------------------------------------------------------------- #
# State
# --------------------------------------------------------------------- #


@dataclass
class Player:
    id: int
    name: str
    role: str
    role_short: str
    country: str | None
    overseas: bool
    base: int
    rating: float | None


@dataclass
class Record:
    status: Literal["available", "sold", "unsold"] = "available"
    team_id: int | None = None
    price: int | None = None


# What a running countdown means, and the switch `_fire` turns on.
#
#   opening   nobody has bid yet. Lapses into UNSOLD.
#   closing   a bid stands. Lapses into SOLD, to the highest bidder, however
#             many franchises are still in the contest.
#   timeout   a lifeline is burning. Settles exactly as `closing` does.
#
# There is deliberately no state in which a lot stops having a deadline. An
# earlier draft held a contested lot open until every rival withdrew, which
# read well and worked badly: five franchises bidding on one player produced a
# lot that no amount of waiting would settle, and the auctioneer had to close
# every contested lot by hand. The buffer settles the lot; withdrawing only
# gets there sooner.
Clock = Literal["opening", "closing", "timeout"]


@dataclass
class Lot:
    player_id: int
    bid: int
    bidder_id: int | None = None
    # Bumped on every change to this lot. A bid quoting an older value is
    # answering a question the room has already moved past.
    version: int = 0
    # The countdown. None only while the auctioneer holds the lot manually --
    # which cannot currently happen, but a lot without a clock has to be a
    # representable state or every read of `deadline` needs a special case.
    clock: Clock | None = None
    # Unix time the countdown fires.
    deadline: float | None = None
    # The franchise whose lifeline is burning, while `clock` is "timeout".
    timeout_by: int | None = None
    # Franchises that have bid on this lot and not withdrawn. One is an
    # uncontested lot the clock may settle; two or more is a live contest.
    contenders: list[int] = field(default_factory=list)


@dataclass
class Seat:
    client_id: str
    role: Literal["auctioneer", "franchise", "spectator"]
    team_id: int | None = None
    display_name: str | None = None


@dataclass
class Snapshot:
    """Everything `undo` has to put back."""

    records: dict[int, Record]
    lot: Lot | None
    log: list[dict[str, Any]]
    seq: int
    phase: str
    # Lifelines are part of what undo has to put back: reversing the sale that
    # a timeout was spent defending, and not returning the timeout, would quietly
    # charge a franchise for an action the room has just agreed did not happen.
    timeouts: dict[int, int] = field(default_factory=dict)


@dataclass
class RoomError(Exception):
    """A refusal the client should see. Never a stack trace."""

    message: str
    about: str | None = None

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.message


@dataclass
class AuctionRoom:
    rules: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_RULES))
    teams: list[dict[str, Any]] = field(default_factory=lambda: copy.deepcopy(DEFAULT_TEAMS))

    players: dict[int, Player] = field(default_factory=dict)
    records: dict[int, Record] = field(default_factory=dict)

    phase: Literal["lobby", "waiting", "live", "finished"] = "lobby"
    lot: Lot | None = None
    log: list[dict[str, Any]] = field(default_factory=list)
    seq: int = 0
    version: int = 0
    countdown_ends_at: float | None = None

    seats: dict[str, Seat] = field(default_factory=dict)
    undo_stack: list[Snapshot] = field(default_factory=list)

    # team_id -> strategic buffers not yet spent, for this auction.
    timeouts: dict[int, int] = field(default_factory=dict)

    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _loaded: bool = False

    # The clock. One task, one token, one way to speak -- see "The clock" below.
    _clock_task: asyncio.Task[None] | None = field(default=None, repr=False)
    _clock_token: int = field(default=0, repr=False)
    _broadcast: Callable[[], Awaitable[None]] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        self._refill_timeouts()

    # ---------------------------------------------------------------- #
    # Roster
    # ---------------------------------------------------------------- #

    def load_players(self, rows: list[dict[str, Any]]) -> int:
        """
        Take the player pool from SQLite.

        Called once at startup. The same substitution the client makes is made
        here: two thirds of the dataset has no `base_price`, and bidding needs
        a number, so the floor stands in. Both sides must agree on that or the
        opening bid would differ between the room and the console.
        """
        self.players.clear()
        self.records.clear()

        for index, row in enumerate(rows, start=1):
            pid = row.get("id") or index
            role = str(row.get("role") or "Batter")
            self.players[pid] = Player(
                id=pid,
                name=str(row.get("player_name") or "Unknown"),
                role=role,
                role_short=role_short(role),
                country=row.get("country"),
                overseas=bool(row.get("overseas")),
                base=int(row.get("base_price") or BASE_PRICE_FLOOR),
                rating=row.get("rating"),
            )
            self.records[pid] = Record()

        self._loaded = True
        logger.info("Auction room loaded %d players", len(self.players))
        return len(self.players)

    # ---------------------------------------------------------------- #
    # Derived readings
    # ---------------------------------------------------------------- #

    def _min_base(self) -> int:
        """Cheapest player still available — the cost of one more squad slot."""
        available = [
            self.players[pid].base
            for pid, rec in self.records.items()
            if rec.status == "available" and pid in self.players
        ]
        return min(available) if available else BASE_PRICE_FLOOR

    def squad_of(self, team_id: int) -> list[Player]:
        return [
            self.players[pid]
            for pid, rec in self.records.items()
            if rec.status == "sold" and rec.team_id == team_id and pid in self.players
        ]

    def summary_for(self, team_id: int) -> dict[str, Any]:
        """
        A franchise's position.

        `max_bid` holds back enough to fill the minimum squad at the cheapest
        going rate, so a team cannot spend itself into an illegal squad. Same
        arithmetic as the client's `summaries`.
        """
        squad = self.squad_of(team_id)
        spent = sum(
            rec.price or 0
            for rec in self.records.values()
            if rec.status == "sold" and rec.team_id == team_id
        )
        left = self.rules["purse"] - spent
        slots_after_this = max(0, self.rules["min_squad"] - (len(squad) + 1))
        reserve = slots_after_this * self._min_base()

        return {
            "spent": spent,
            "left": left,
            "size": len(squad),
            "overseas": sum(1 for p in squad if p.overseas),
            "max_bid": max(0, left - reserve),
        }

    def blocked_reason(self, team_id: int, player: Player, amount: int) -> str | None:
        """Why this team may not go to `amount` on this player. None if they may."""
        summary = self.summary_for(team_id)
        if summary["size"] >= self.rules["max_squad"]:
            return f"squad full ({self.rules['max_squad']})"
        if player.overseas and summary["overseas"] >= self.rules["max_overseas"]:
            return f"overseas full ({self.rules['max_overseas']})"
        if amount > summary["max_bid"]:
            return f"over budget — max {money(summary['max_bid'])}"
        return None

    @property
    def next_ask(self) -> int:
        """What the next bid costs. The opening ask is the base itself."""
        if not self.lot:
            return 0
        if self.lot.bidder_id is None:
            return self.lot.bid
        return self.lot.bid + increment_for(self.lot.bid)

    def counts(self) -> dict[str, int]:
        sold = sum(1 for r in self.records.values() if r.status == "sold")
        unsold = sum(1 for r in self.records.values() if r.status == "unsold")
        return {
            "available": len(self.records) - sold - unsold,
            "sold": sold,
            "unsold": unsold,
            "spent": sum(r.price or 0 for r in self.records.values() if r.status == "sold"),
        }

    def team_by_id(self, team_id: int | None) -> dict[str, Any] | None:
        if team_id is None:
            return None
        return next((t for t in self.teams if t["id"] == team_id), None)

    # ---------------------------------------------------------------- #
    # Seats and access control
    # ---------------------------------------------------------------- #

    def seat_of(self, client_id: str) -> Seat:
        seat = self.seats.get(client_id)
        if seat is None:
            raise RoomError("Join the room before sending anything else.", about="seat")
        return seat

    def _require_auctioneer(self, client_id: str, action: str) -> Seat:
        """
        The RBAC gate.

        Every privileged action passes through here, so there is one place that
        decides what "auctioneer" means rather than a check copied into eight
        handlers, one of which will eventually be wrong.
        """
        seat = self.seat_of(client_id)
        if seat.role != "auctioneer":
            raise RoomError(
                f"Only the auctioneer can {action}.",
                about=action,
            )
        return seat

    def _require_franchise(self, client_id: str, action: str) -> Seat:
        seat = self.seat_of(client_id)
        if seat.role != "franchise" or seat.team_id is None:
            raise RoomError(f"Only a franchise can {action}.", about=action)
        return seat

    async def join(
        self,
        client_id: str,
        role: str,
        team_id: int | None,
        display_name: str | None,
    ) -> Seat:
        """
        Claim a seat, if it is free.

        The chair is single-occupancy and so is each franchise, because two
        people bidding as Mumbai is indistinguishable from one person bidding
        twice. A refused claim is an error, not a silent downgrade to
        spectator: someone who asked to be Mumbai should be told Mumbai is
        taken rather than left wondering why their buttons do nothing.
        """
        async with self._lock:
            if role == "auctioneer":
                taken = any(
                    s.role == "auctioneer" and s.client_id != client_id
                    for s in self.seats.values()
                )
                if taken:
                    raise RoomError("The auctioneer's chair is already taken.", about="join")
                seat = Seat(client_id=client_id, role="auctioneer", display_name=display_name)

            else:
                if team_id is None or self.team_by_id(team_id) is None:
                    raise RoomError("Pick a franchise that exists.", about="join")
                taken = any(
                    s.role == "franchise" and s.team_id == team_id and s.client_id != client_id
                    for s in self.seats.values()
                )
                if taken:
                    team = self.team_by_id(team_id)
                    raise RoomError(
                        f"{team['name']} is already being played.", about="join"
                    )
                seat = Seat(
                    client_id=client_id,
                    role="franchise",
                    team_id=team_id,
                    display_name=display_name,
                )

            self.seats[client_id] = seat
            label = (
                "the auctioneer"
                if seat.role == "auctioneer"
                else self.team_by_id(seat.team_id)["name"]
            )
            self._note(f"{label} joined the room")
            self.version += 1
            return seat

    async def leave(self, client_id: str) -> None:
        async with self._lock:
            seat = self.seats.pop(client_id, None)
            if seat is None:
                return
            label = (
                "the auctioneer"
                if seat.role == "auctioneer"
                else (self.team_by_id(seat.team_id) or {}).get("name", "a franchise")
            )
            self._note(f"{label} left the room")
            self.version += 1

    def connected_team_ids(self) -> set[int]:
        return {s.team_id for s in self.seats.values() if s.team_id is not None}

    # ---------------------------------------------------------------- #
    # Ledger
    # ---------------------------------------------------------------- #

    def _append(self, kind: str, what: str, amount: int | None = None) -> None:
        self.seq += 1
        self.log.insert(
            0,
            {"seq": self.seq, "kind": kind, "what": what, "amount": amount, "ts": time.time()},
        )
        del self.log[MAX_LOG:]

    def _note(self, what: str) -> None:
        self._append("note", what)

    def _checkpoint(self) -> None:
        """Snapshot before a mutation, so undo has somewhere to go back to."""
        self.undo_stack.append(
            Snapshot(
                records=copy.deepcopy(self.records),
                lot=copy.deepcopy(self.lot),
                log=list(self.log),
                seq=self.seq,
                phase=self.phase,
                timeouts=dict(self.timeouts),
            )
        )
        del self.undo_stack[:-MAX_UNDO]

    # ---------------------------------------------------------------- #
    # The clock
    #
    # A lot is never just a price any more; it is a price with a deadline. One
    # `asyncio.Task` holds that deadline and `_arm` is the only thing that
    # starts one, so "what is the room waiting for?" has a single answer
    # instead of four.
    #
    # It is one deadline with a label rather than three timers on purpose.
    # Three timers is three cancellation paths and three chances to leave one
    # running behind a lot that has already sold. `lot.clock` says what the
    # countdown *means* and `_fire` is a switch on it and nothing else.
    #
    # **The staleness guard.** `_clock_token` is bumped by every arm and every
    # disarm. A task quotes the token it was spawned with, and is checked
    # against the room's *after* taking the lock -- so a bid that landed in the
    # microseconds between the sleep expiring and the lock being granted voids
    # the settlement rather than racing it. Cancellation alone cannot do this:
    # a task already past its sleep and queued on the lock is not cancellable,
    # and would otherwise wake and sell a lot somebody had just bid on. Same
    # argument as `lot.version` for bids -- the lock decides who goes first,
    # the token decides whether going first still meant anything.
    # ---------------------------------------------------------------- #

    def set_broadcaster(self, broadcast: Callable[[], Awaitable[None]]) -> None:
        """
        Install the function the clock speaks through.

        Every other change in this module is made and returned, and `ws.py`
        decides who is told. A settlement the *clock* made has no request to
        answer, so it needs its own way out. One callable, installed once, is
        the smallest hole to cut for that; leaving it None keeps every rule
        here testable without a socket.
        """
        self._broadcast = broadcast

    def _refill_timeouts(self) -> None:
        """Every franchise back to a full set of lifelines."""
        self.timeouts = {t["id"]: self.rules["timeouts_per_team"] for t in self.teams}

    def timeouts_left(self, team_id: int) -> int:
        return self.timeouts.get(team_id, self.rules["timeouts_per_team"])

    def _arm(self, clock: Clock, seconds: float) -> None:
        """Start the countdown, replacing whatever was running. Lock held."""
        if self.lot is None:
            return
        self._clock_token += 1
        self.lot.clock = clock
        self.lot.deadline = time.time() + seconds
        self._spawn(self._clock_token, seconds)

    def _disarm(self) -> None:
        """Stop the countdown. Lock held. Safe when nothing is armed."""
        self._clock_token += 1
        task, self._clock_task = self._clock_task, None
        # Never cancel the task we are running inside: `_fire` reaches here
        # through `_hammer_down`, and a task cancelling itself raises at its
        # next await instead of finishing the sale it is in the middle of.
        if task is not None and task is not _current_task():
            task.cancel()
        if self.lot is not None:
            self.lot.clock = None
            self.lot.deadline = None
            self.lot.timeout_by = None

    def _spawn(self, token: int, seconds: float) -> None:
        task, self._clock_task = self._clock_task, None
        if task is not None and task is not _current_task():
            task.cancel()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop -- a synchronous test driving the room directly. Every
            # rule still holds; only automatic settlement is absent, and the
            # auctioneer's gavel settles the lot exactly as it always did.
            return
        self._clock_task = loop.create_task(self._run_clock(token, seconds))

    async def _run_clock(self, token: int, seconds: float) -> None:
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            return

        async with self._lock:
            if token != self._clock_token or self.lot is None or self.phase != "live":
                return  # superseded -- a bid, a timeout, or the gavel got here first
            self._fire()

        # Outside the lock: broadcasting is I/O to an arbitrary number of
        # sockets, and holding the auction still for it would let one slow peer
        # delay everybody else's next bid.
        await self._announce()

    def _fire(self) -> None:
        """The countdown lapsed. Lock held, lot present, phase live."""
        assert self.lot is not None
        if self.lot.clock == "opening":
            self._pass_over("no bid in %ds" % self.rules["open_seconds"])
            return

        # "closing" and "timeout" both lapse into a sale, however many
        # franchises are in the contest. Seven seconds of silence from all of
        # them is the room agreeing, and the highest bid is what it agreed to.
        try:
            self._hammer_down(how="on the clock")
        except RoomError as exc:
            # The standing bidder can no longer take the lot. It should not be
            # reachable -- a bid is checked on the way in and nothing between
            # then and here spends a purse -- but an exception escaping into a
            # background task would freeze the lot with nobody to tell.
            logger.warning("clock could not settle lot: %s", exc.message)
            self._pass_over(exc.message)

    def _hammer_down(self, *, how: str | None = None, checkpoint: bool = True) -> None:
        """
        Knock the lot down to the standing bidder. Lock held, lot present.

        Shared by the auctioneer's gavel, the clock and a resolving withdrawal,
        so no two of them can settle a lot differently. It raises rather than
        returning a failure: the gavel has a client to answer and the clock has
        a fallback, and neither wants a silent no-op.

        `checkpoint=False` is for a caller that has already taken one. A
        withdrawal that ends a contest is *one* action and must cost *one*
        undo: without this, `withdraw` would snapshot before removing the
        contender and this would snapshot again after, so the auctioneer's
        first undo would land in a half-applied state -- the sale reversed but
        the withdrawal still standing -- and only the second would get back to
        the contest. An undo that needs pressing twice to mean anything is
        worse than no undo, because the intermediate state looks legitimate.
        """
        lot = self.lot
        assert lot is not None
        if lot.bidder_id is None:
            raise RoomError("No bids — mark it unsold instead.", about="sell")

        player = self.players[lot.player_id]
        team = self.team_by_id(lot.bidder_id)

        # Re-check legality at the hammer. It cannot fail in this design, but a
        # rule enforced only on the way in is a rule waiting to be bypassed.
        blocked = self.blocked_reason(lot.bidder_id, player, lot.bid)
        if blocked:
            raise RoomError(
                f"{team['name']} cannot take this lot: {blocked}", about="sell"
            )

        # Taken only after every refusal above, so a raised hammer leaves no
        # orphan snapshot on the undo stack.
        if checkpoint:
            self._checkpoint()
        self.records[player.id] = Record(
            status="sold", team_id=lot.bidder_id, price=lot.bid
        )
        self._append(
            "sold",
            f"{player.name} → {team['code']}" + (f" {how}" if how else ""),
            lot.bid,
        )
        self._disarm()
        self.lot = None
        self.version += 1

    def _pass_over(self, why: str | None = None, *, checkpoint: bool = True) -> None:
        """
        Mark the lot unsold. Lock held, lot present.

        `checkpoint=False` as in `_hammer_down`: one action, one undo entry.
        """
        lot = self.lot
        assert lot is not None
        player = self.players[lot.player_id]
        if checkpoint:
            self._checkpoint()
        self.records[player.id] = Record(status="unsold")
        self._append("unsold", f"{player.name} unsold" + (f" — {why}" if why else ""))
        self._disarm()
        self.lot = None
        self.version += 1

    async def _announce(self) -> None:
        """Tell every client what the clock just did."""
        if self._broadcast is None:
            return
        try:
            await self._broadcast()
        except Exception:
            logger.exception("clock broadcast failed")

    # ---------------------------------------------------------------- #
    # Auctioneer actions
    # ---------------------------------------------------------------- #

    async def open_waiting_room(self, client_id: str, countdown_seconds: int) -> None:
        self._require_auctioneer(client_id, "open the waiting room")
        async with self._lock:
            if self.phase not in ("lobby", "waiting"):
                raise RoomError("The auction has already started.", about="open_waiting_room")
            self.phase = "waiting"
            self.countdown_ends_at = time.time() + countdown_seconds
            minutes = max(1, round(countdown_seconds / 60))
            self._note(f"Waiting room open — {minutes} min to join")
            self.version += 1

    async def start_auction(self, client_id: str) -> None:
        """
        Begin.

        Reachable from `waiting` (countdown run out, or the auctioneer's manual
        override) and straight from `lobby`, because an auctioneer who has
        everyone in the room already should not have to sit through a timer to
        prove it.
        """
        self._require_auctioneer(client_id, "start the auction")
        async with self._lock:
            if self.phase == "live":
                raise RoomError("The auction is already running.", about="start_auction")
            if self.phase == "finished":
                raise RoomError("The auction has finished.", about="start_auction")
            if not self._loaded or not self.players:
                raise RoomError(
                    "No player pool loaded — run POST /api/v1/ingest first.",
                    about="start_auction",
                )
            self._checkpoint()
            self.phase = "live"
            self.countdown_ends_at = None
            self._note("Auction started")
            self.version += 1

    async def put_up(self, client_id: str, player_id: int) -> None:
        self._require_auctioneer(client_id, "put a player up")
        async with self._lock:
            if self.phase != "live":
                raise RoomError("The auction is not running.", about="put_up")
            if self.lot is not None:
                raise RoomError("Settle the current lot first.", about="put_up")

            player = self.players.get(player_id)
            if player is None:
                raise RoomError("No such player.", about="put_up")

            record = self.records[player_id]
            if record.status == "sold":
                raise RoomError(f"{player.name} is already sold.", about="put_up")

            self._checkpoint()
            # Opening ask is the base itself: the first bidder pays base, and
            # only the second onwards climbs the ladder.
            self.lot = Lot(player_id=player_id, bid=player.base, bidder_id=None, version=0)
            record.status = "available"
            self._append("note", f"{player.name} on the block", player.base)
            # The clock starts the instant the player appears, not when the
            # auctioneer gets round to asking for bids. That is the point of
            # the rule: an unwanted lot costs the room seven seconds, not
            # however long it takes somebody to decide nobody wants him.
            self._arm("opening", self.rules["open_seconds"])
            self.version += 1

    async def sell(self, client_id: str) -> None:
        """
        The gavel, brought down early.

        The clock would settle this lot on its own within seven seconds, so
        this is now an override rather than the only way a lot closes: an
        auctioneer who can see the room has finished bidding should not have to
        wait out a buffer nobody is going to use.
        """
        self._require_auctioneer(client_id, "sell a lot")
        async with self._lock:
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="sell")
            self._hammer_down()

    async def mark_unsold(self, client_id: str) -> None:
        """Pass over the lot now, rather than waiting for the opening buffer."""
        self._require_auctioneer(client_id, "mark a lot unsold")
        async with self._lock:
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="unsold")
            self._pass_over()

    async def undo(self, client_id: str) -> None:
        self._require_auctioneer(client_id, "undo")
        async with self._lock:
            if not self.undo_stack:
                raise RoomError("Nothing to undo.", about="undo")
            snap = self.undo_stack.pop()
            self.records = snap.records
            self.lot = snap.lot
            self.log = snap.log
            self.seq = snap.seq
            self.phase = snap.phase  # type: ignore[assignment]
            if snap.timeouts:
                self.timeouts = dict(snap.timeouts)

            # The restored deadline is in the past by definition, so it is not
            # restored -- a lot handed back with 0.2 seconds on it would settle
            # again before anyone in the room could react to seeing it return.
            # The buffer it gets is a fresh full one, matched to whether a bid
            # stands on it.
            self._disarm()
            if self.lot is not None and self.phase == "live":
                if self.lot.bidder_id is not None:
                    self._arm("closing", self.rules["close_seconds"])
                else:
                    self._arm("opening", self.rules["open_seconds"])

            self._note("Undone")
            self.version += 1

    async def finish(self, client_id: str) -> None:
        self._require_auctioneer(client_id, "finish the auction")
        async with self._lock:
            if self.phase == "finished":
                raise RoomError("Already finished.", about="finish")
            self._checkpoint()
            self._disarm()
            self.phase = "finished"
            self.lot = None
            self._note("Auction closed")
            self.version += 1

    async def reset(self, client_id: str) -> None:
        """
        Back to an empty lobby, keeping the pool and everyone's seat.

        Seats are deliberately kept: the people in the room are still in the
        room, and making ten franchises re-pick their teams after a practice
        run would be a worse experience than the reset is worth. The undo stack
        goes, because undoing across a reset would restore an auction that no
        longer exists.

        What it clears, in the order the client cares about: the lot and any
        bid standing on it, the clock running underneath it, every franchise's
        lifelines, every player's status back to available -- which is what
        restores the purses, since a purse here is derived from what a
        franchise has bought and never stored -- and the ledger.
        """
        self._require_auctioneer(client_id, "reset the room")
        async with self._lock:
            # Disarmed first. A clock left running across a reset would wake up
            # inside a fresh lobby holding a token from the auction before it;
            # the token check would refuse it, but stopping the task is honest
            # where relying on the guard is merely lucky.
            self._disarm()
            for pid in self.records:
                self.records[pid] = Record()
            self.lot = None
            self.log = []
            self.seq = 0
            self.undo_stack = []
            self._refill_timeouts()
            self.phase = "lobby"
            self.countdown_ends_at = None
            self._note("Room reset — pool, purses and lifelines restored")
            self.version += 1

    # ---------------------------------------------------------------- #
    # Bidding
    # ---------------------------------------------------------------- #

    async def bid(
        self,
        client_id: str,
        amount: int | None = None,
        lot_version: int | None = None,
    ) -> int:
        """
        Place a bid for the connection's own franchise.

        This is the one method where concurrency is a real hazard, and it is
        guarded twice. The lock serialises processing, so two simultaneous bids
        become an ordered pair rather than a torn read. The version check then
        refuses the loser if the lot moved underneath it -- without that, both
        bids would be applied in turn and the second would silently overwrite
        the first at the same price.

        `amount` is the jumpbid: a franchise naming its own figure to skip the
        ladder. It is checked, never trusted -- it must clear the current ask,
        must be a whole number of lakh, and must be inside the bidder's purse.
        """
        seat = self._require_franchise(client_id, "bid")
        team_id = seat.team_id
        assert team_id is not None  # guaranteed by _require_franchise

        async with self._lock:
            if self.phase != "live":
                raise RoomError("The auction is not running.", about="bid")
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="bid")

            if lot_version is not None and lot_version != self.lot.version:
                raise RoomError(
                    "Someone bid first — the price has moved.", about="bid"
                )

            if self.lot.bidder_id == team_id:
                raise RoomError("You already hold the bid.", about="bid")

            player = self.players[self.lot.player_id]
            ask = self.next_ask

            if amount is None:
                target = ask
            else:
                if amount < ask:
                    raise RoomError(
                        f"A jumpbid must beat the ask of {money(ask)}.", about="bid"
                    )
                target = amount

            blocked = self.blocked_reason(team_id, player, target)
            if blocked:
                raise RoomError(blocked, about="bid")

            team = self.team_by_id(team_id)
            self._checkpoint()
            self.lot.bid = target
            self.lot.bidder_id = team_id
            self.lot.version += 1

            jump = amount is not None and amount > ask
            self._append(
                "bid",
                f"{team['code']} {'jumps to' if jump else 'bids'}",
                target,
            )

            # Bidding puts you in the contest, and stays that way until you
            # withdraw. It is what the clock consults before knocking a lot
            # down: one contender is a lot the buffer may settle, two is a
            # contest that only a withdrawal resolves.
            if team_id not in self.lot.contenders:
                self.lot.contenders.append(team_id)

            # Every bid resets the buffer to a full seven seconds, from
            # whichever clock was running -- a timeout somebody just spent a
            # lifeline on. That is the intended trade: a
            # lifeline buys the room thirty seconds to think, and the moment
            # somebody acts on the thinking, the ordinary rule resumes.
            self._arm("closing", self.rules["close_seconds"])

            self.version += 1
            return target

    # ---------------------------------------------------------------- #
    # Withdrawal
    # ---------------------------------------------------------------- #

    async def withdraw(self, client_id: str) -> int:
        """
        Step out of the contest for the lot on the block.

        Withdrawing is an accelerator, never a block. The seven-second buffer
        settles every lot on its own; stepping out only says "do not wait for
        me", and once everybody but the standing bidder has said it there is
        nothing left to wait for, so the lot goes at once instead of sitting
        out a buffer nobody is going to use.

        It replaces a workaround rather than adding a feature. Before this, the
        only way to signal "I am done with this player" was to leave the seat --
        which drops the socket, frees the franchise for anyone to claim, and
        says something far broader than was meant. A withdrawal is per-lot and
        costs nothing: the next player puts every franchise back in contention.

        Two refusals, both rules:

        **You must be in the contest.** Withdrawing from a player you never bid
        on communicates nothing the room does not already know, and a log full
        of them would bury the withdrawals that mean something.

        **The leader may not withdraw.** Stepping back from your own standing
        bid is retracting it, which is a different act with different
        consequences for the ladder -- and one the auctioneer's undo exists for.

        Returns how many contenders remain.
        """
        seat = self._require_franchise(client_id, "withdraw")
        team_id = seat.team_id
        assert team_id is not None  # guaranteed by _require_franchise

        async with self._lock:
            if self.phase != "live":
                raise RoomError("The auction is not running.", about="withdraw")
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="withdraw")
            if team_id not in self.lot.contenders:
                raise RoomError(
                    "You are not in this contest — you have not bid on this lot.",
                    about="withdraw",
                )
            if self.lot.bidder_id == team_id:
                raise RoomError(
                    "You hold the bid — withdrawing would retract it. "
                    "Let it stand, or be outbid.",
                    about="withdraw",
                )

            self._checkpoint()
            self.lot.contenders = [t for t in self.lot.contenders if t != team_id]
            self.lot.version += 1

            team = self.team_by_id(team_id)
            remaining = len(self.lot.contenders)
            self._append("withdraw", f"{team['code']} withdraws")

            if remaining <= 1 and self.lot.bidder_id is not None:
                # Everyone who was in has stepped back but the standing bidder.
                # The contest is over, so the lot goes now -- making the room
                # sit out a seven-second buffer it has already answered would be
                # ceremony, not process.
                # `checkpoint=False`: the snapshot above already covers this
                # whole action, and a second one would make the withdrawal take
                # two undos to reverse.
                try:
                    self._hammer_down(how="unopposed", checkpoint=False)
                except RoomError as exc:
                    logger.warning("withdrawal could not settle lot: %s", exc.message)
                    self._pass_over(exc.message, checkpoint=False)
            else:
                # Somebody is still in. The remaining franchises get a fresh
                # full buffer to act in: a withdrawal should never shorten
                # anyone else's thinking time, only their own.
                self._arm("closing", self.rules["close_seconds"])

            self.version += 1
            return remaining

    # ---------------------------------------------------------------- #
    # Lifelines
    # ---------------------------------------------------------------- #

    async def call_timeout(self, client_id: str) -> int:
        """
        Spend a lifeline and freeze the block for thirty seconds.

        Three refusals, and each one is a rule rather than a guard:

        **Only while the closing buffer runs.** A timeout is for answering a
        bid. Before anyone has bid there is nothing to answer, and allowing one
        there would let a franchise freeze a lot nobody wants for half a minute
        at a time.

        **Not by the franchise holding the bid.** The leader already has what
        they want; thirty more seconds of it is a filibuster, not a strategy.
        The lifeline exists for the teams deciding whether to come back at
        them.

        **Not on top of another timeout.** The check that the closing buffer is
        running is also the check that stops two of these stacking into a
        minute, and it is what makes the simultaneous case safe -- see below.

        **The race.** Two franchises pressing this in the same millisecond both
        serialise on `self._lock`. The winner finds `clock == "closing"`,
        spends a lifeline and arms the freeze. The loser then finds
        `clock == "timeout"` and is refused -- with their own lifeline
        untouched, because the decrement happens after the check and under the
        same lock. Neither team is charged for an action the room did not take.
        """
        seat = self._require_franchise(client_id, "call a timeout")
        team_id = seat.team_id
        assert team_id is not None  # guaranteed by _require_franchise

        async with self._lock:
            if self.phase != "live":
                raise RoomError("The auction is not running.", about="timeout")
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="timeout")

            if self.lot.clock == "timeout":
                holder = self.team_by_id(self.lot.timeout_by)
                raise RoomError(
                    f"{holder['code'] if holder else 'Another franchise'} already "
                    "has the room held.",
                    about="timeout",
                )
            if self.lot.clock != "closing":
                raise RoomError(
                    "A timeout answers a bid — nobody has bid yet.", about="timeout"
                )
            if self.lot.bidder_id == team_id:
                raise RoomError(
                    "You hold the bid — a timeout is for the teams answering it.",
                    about="timeout",
                )

            left = self.timeouts_left(team_id)
            if left <= 0:
                raise RoomError(
                    f"No timeouts left — all {self.rules['timeouts_per_team']} are spent.",
                    about="timeout",
                )

            self._checkpoint()
            self.timeouts[team_id] = left - 1
            self.lot.timeout_by = team_id

            team = self.team_by_id(team_id)
            self._append(
                "timeout",
                f"{team['code']} calls timeout — {left - 1} left",
            )
            self._arm("timeout", self.rules["timeout_seconds"])
            self.version += 1
            return left - 1

    # ---------------------------------------------------------------- #
    # Broadcast shape
    # ---------------------------------------------------------------- #

    def state_payload(self) -> dict[str, Any]:
        """The room as every client sees it. No player pool — see RoomState."""
        connected = self.connected_team_ids()
        now = time.time()

        # Who bought whom, so a client can rebuild squads and the price column
        # without a second request. Sent as [player_id, price] pairs rather than
        # whole player rows: the client already holds the pool from
        # GET /api/v1/players and only needs the auction's verdict on it. Two
        # hundred and fifty pairs is a few kilobytes, where the equivalent in
        # player objects would be most of a megabyte on every bid.
        buys: dict[int, list[list[int]]] = {team["id"]: [] for team in self.teams}
        unsold: list[int] = []
        for pid, rec in self.records.items():
            if rec.status == "sold" and rec.team_id in buys:
                buys[rec.team_id].append([pid, rec.price or 0])
            elif rec.status == "unsold":
                unsold.append(pid)

        teams = []
        for team in self.teams:
            summary = self.summary_for(team["id"])
            teams.append(
                {
                    "id": team["id"],
                    "name": team["name"],
                    "code": team["code"],
                    "color": team["color"],
                    "connected": team["id"] in connected,
                    "buys": buys[team["id"]],
                    "timeouts_left": self.timeouts_left(team["id"]),
                    **summary,
                }
            )

        lot = None
        if self.lot:
            player = self.players[self.lot.player_id]
            bidder = self.team_by_id(self.lot.bidder_id)
            lot = {
                "player_id": player.id,
                "player_name": player.name,
                "role": player.role,
                "country": player.country,
                "overseas": player.overseas,
                "rating": player.rating,
                "base": player.base,
                "bid": self.lot.bid,
                "bidder_id": self.lot.bidder_id,
                "bidder_code": bidder["code"] if bidder else None,
                "next_ask": self.next_ask,
                "version": self.lot.version,
                "clock": self.lot.clock,
                "deadline": self.lot.deadline,
                # Seconds left as this frame is written. Sent beside the
                # absolute deadline because seven seconds is short enough for
                # clock skew to matter: a client two seconds fast would show a
                # lot expiring while the room still holds it open. Anchoring on
                # this and counting down locally has no skew to accumulate.
                "ends_in": (
                    max(0.0, round(self.lot.deadline - now, 3))
                    if self.lot.deadline is not None
                    else None
                ),
                "timeout_by_id": self.lot.timeout_by,
                "timeout_by_code": (
                    (self.team_by_id(self.lot.timeout_by) or {}).get("code")
                ),
                "contenders": list(self.lot.contenders),
                "contender_codes": [
                    (self.team_by_id(t) or {}).get("code", "?")
                    for t in self.lot.contenders
                ],
            }

        return {
            "type": "state",
            "version": self.version,
            "phase": self.phase,
            "rules": dict(self.rules),
            "teams": teams,
            "lot": lot,
            "log": self.log[:40],
            "unsold": unsold,
            "counts": self.counts(),
            "countdown_ends_at": self.countdown_ends_at,
            "connected": len(self.seats),
        }

    # ---------------------------------------------------------------- #
    # Post-auction report
    # ---------------------------------------------------------------- #

    def report(self) -> dict[str, Any]:
        """
        The closing report: a Playing XI per franchise, ratings, and purse.

        The XI is picked by role first and rating second, because a side chosen
        purely on rating regularly comes out with no keeper and eight batters.
        The shape is one keeper, four batters, two all-rounders and three
        bowlers, with the eleventh slot going to the best player left -- then
        the overseas cap is applied by swapping the weakest overseas pick for
        the strongest Indian outside the side, repeatedly, until it is legal.

        It is a heuristic and it says so. It is not trying to be a selection
        committee; it is trying to make a squad legible at a glance.
        """
        franchises = []

        for team in self.teams:
            squad = sorted(
                self.squad_of(team["id"]),
                key=lambda p: (p.rating if p.rating is not None else 0),
                reverse=True,
            )
            summary = self.summary_for(team["id"])
            xi = self._pick_xi(squad)

            rated = [p.rating for p in squad if p.rating is not None]
            xi_rated = [p.rating for p in xi if p.rating is not None]

            franchises.append(
                {
                    "team": {k: team[k] for k in ("id", "name", "code", "color")},
                    "squad_size": len(squad),
                    "overseas": sum(1 for p in squad if p.overseas),
                    "spent": summary["spent"],
                    "purse": self.rules["purse"],
                    "left": summary["left"],
                    "squad_rating": round(sum(rated) / len(rated), 2) if rated else None,
                    "xi_rating": round(sum(xi_rated) / len(xi_rated), 2) if xi_rated else None,
                    "playing_xi": [self._player_row(p, team["id"]) for p in xi],
                    "bench": [
                        self._player_row(p, team["id"]) for p in squad if p not in xi
                    ],
                    "incomplete": len(squad) < XI_SIZE,
                }
            )

        # Ranked by the side they can actually field, not by what they spent --
        # but a complete side always outranks an incomplete one, whatever the
        # averages say. Sorting on mean rating alone puts a franchise holding
        # one 9.5 and nobody else above a full eleven averaging 9.3, which is
        # exactly backwards: the first cannot take the field at all.
        franchises.sort(
            key=lambda f: (not f["incomplete"], f["xi_rating"] or 0),
            reverse=True,
        )

        counts = self.counts()
        return {
            "generated_at": time.time(),
            "phase": self.phase,
            "rules": dict(self.rules),
            "totals": {
                **counts,
                "purse_pool": self.rules["purse"] * len(self.teams),
            },
            "franchises": franchises,
        }

    def _player_row(self, player: Player, team_id: int) -> dict[str, Any]:
        record = self.records.get(player.id, Record())
        return {
            "id": player.id,
            "name": player.name,
            "role": player.role,
            "role_short": player.role_short,
            "country": player.country,
            "overseas": player.overseas,
            "rating": player.rating,
            "price": record.price if record.team_id == team_id else None,
        }

    @staticmethod
    def _pick_xi(squad: list[Player]) -> list[Player]:
        """`squad` must already be sorted best-first."""
        if len(squad) <= XI_SIZE:
            return list(squad)

        quota = {"WK": 1, "BAT": 4, "AR": 2, "BOWL": 3}
        chosen: list[Player] = []

        for player in squad:
            if quota.get(player.role_short, 0) > 0:
                quota[player.role_short] -= 1
                chosen.append(player)

        # Any unfilled quota (a squad with no keeper, say) leaves room for the
        # best players not yet picked.
        for player in squad:
            if len(chosen) >= XI_SIZE:
                break
            if player not in chosen:
                chosen.append(player)

        # Overseas cap, applied by substitution rather than by rejection, so a
        # squad that is legal overall always yields a legal XI.
        def overseas_count(side: list[Player]) -> int:
            return sum(1 for p in side if p.overseas)

        while overseas_count(chosen) > XI_MAX_OVERSEAS:
            weakest = min(
                (p for p in chosen if p.overseas),
                key=lambda p: (p.rating if p.rating is not None else 0),
            )
            replacement = next(
                (p for p in squad if not p.overseas and p not in chosen), None
            )
            if replacement is None:
                break  # not enough domestic players to fix it; report as-is
            chosen[chosen.index(weakest)] = replacement

        return chosen[:XI_SIZE]


# One room per process. A multi-room build would key these by an id; there is
# one auction here, and inventing a registry for it now would be machinery
# without a user.
room = AuctionRoom()
