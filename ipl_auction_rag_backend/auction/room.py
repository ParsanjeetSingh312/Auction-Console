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
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger("auction.room")

# --------------------------------------------------------------------- #
# Rules, transcribed from the client
# --------------------------------------------------------------------- #

BASE_PRICE_FLOOR = 30  # format.ts BASE_PRICE_FLOOR
MAX_LOG = 400
MAX_UNDO = 60

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


@dataclass
class Lot:
    player_id: int
    bid: int
    bidder_id: int | None = None
    # Bumped on every change to this lot. A bid quoting an older value is
    # answering a question the room has already moved past.
    version: int = 0


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

    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _loaded: bool = False

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
            )
        )
        del self.undo_stack[:-MAX_UNDO]

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
            self.version += 1

    async def sell(self, client_id: str) -> None:
        self._require_auctioneer(client_id, "sell a lot")
        async with self._lock:
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="sell")
            if self.lot.bidder_id is None:
                raise RoomError(
                    "No bids — mark it unsold instead.", about="sell"
                )

            player = self.players[self.lot.player_id]
            team = self.team_by_id(self.lot.bidder_id)

            # Re-check legality at the hammer. The squad may have filled since
            # the bid was accepted -- it cannot in this design, but a rule that
            # is only enforced on the way in is a rule waiting to be bypassed.
            blocked = self.blocked_reason(self.lot.bidder_id, player, self.lot.bid)
            if blocked:
                raise RoomError(f"{team['name']} cannot take this lot: {blocked}", about="sell")

            self._checkpoint()
            self.records[player.id] = Record(
                status="sold", team_id=self.lot.bidder_id, price=self.lot.bid
            )
            self._append("sold", f"{player.name} → {team['code']}", self.lot.bid)
            self.lot = None
            self.version += 1

    async def mark_unsold(self, client_id: str) -> None:
        self._require_auctioneer(client_id, "mark a lot unsold")
        async with self._lock:
            if not self.lot:
                raise RoomError("Nothing is on the block.", about="unsold")
            player = self.players[self.lot.player_id]
            self._checkpoint()
            self.records[player.id] = Record(status="unsold")
            self._append("unsold", f"{player.name} unsold")
            self.lot = None
            self.version += 1

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
            self._note("Undone")
            self.version += 1

    async def finish(self, client_id: str) -> None:
        self._require_auctioneer(client_id, "finish the auction")
        async with self._lock:
            if self.phase == "finished":
                raise RoomError("Already finished.", about="finish")
            self._checkpoint()
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
        """
        self._require_auctioneer(client_id, "reset the room")
        async with self._lock:
            for pid in self.records:
                self.records[pid] = Record()
            self.lot = None
            self.log = []
            self.seq = 0
            self.undo_stack = []
            self.phase = "lobby"
            self.countdown_ends_at = None
            self._note("Room reset")
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
            self.version += 1
            return target

    # ---------------------------------------------------------------- #
    # Broadcast shape
    # ---------------------------------------------------------------- #

    def state_payload(self) -> dict[str, Any]:
        """The room as every client sees it. No player pool — see RoomState."""
        connected = self.connected_team_ids()

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
