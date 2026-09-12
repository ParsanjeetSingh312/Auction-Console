"""
schemas.py
The WebSocket contract for the auction room.

Every byte a client sends is parsed through these models before any auction
code sees it. That is the whole security posture for the socket, and it is
deliberately stricter than it looks:

  - `ClientMessage` is a *discriminated union* on `type`. A payload whose type
    is not one of the known literals is rejected by the parser, so there is no
    dispatch table to fall through and no `else` branch to forget.

  - Every numeric field is bounded. `amount` cannot be negative, cannot exceed
    the largest purse the rules permit, and is an `int` of lakh -- a float bid
    is a parse error rather than something that rounds oddly three screens
    later. `team_id` and `player_id` have floors and ceilings too.

  - `extra="forbid"` on every model. A message carrying a field the server does
    not know about is refused rather than quietly ignored, which is what stops
    a client smuggling `{"type":"bid","amount":100,"role":"auctioneer"}` past a
    handler that only reads the fields it expects.

  - Nothing in a client message names the actor. Role and team come from the
    connection's own seat, assigned at join time and held server-side. A client
    cannot claim to be someone else because there is no field in which to make
    the claim.

The server->client side is modelled loosely by comparison, because it is not a
trust boundary: the server is the one writing it.
"""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

# The largest bid the rules could ever permit: one franchise's whole purse.
# A real bid is bounded far below this by `max_bid`, but the parser should
# refuse an absurd integer before the auction logic has to reason about it.
MAX_AMOUNT_LAKH = 12_000

Strict = ConfigDict(extra="forbid")


# --------------------------------------------------------------------- #
# Client -> server
# --------------------------------------------------------------------- #


class Join(BaseModel):
    """
    Claim a seat.

    This is the one message that names a role, and it is a *request*, not an
    assertion -- the room decides whether to grant it (the chair may be taken,
    the franchise may already be occupied) and the answer is what becomes the
    connection's identity for the rest of its life.
    """

    model_config = Strict
    type: Literal["join"]
    role: Literal["auctioneer", "franchise"]
    # Required for a franchise, ignored for the auctioneer. Validated against
    # the actual team list in the room, not just this range.
    team_id: int | None = Field(default=None, ge=1, le=100)
    display_name: str | None = Field(default=None, max_length=40)


class OpenWaitingRoom(BaseModel):
    """Auctioneer: summon the franchises and start the countdown."""

    model_config = Strict
    type: Literal["open_waiting_room"]
    countdown_seconds: int = Field(default=600, ge=0, le=3600)


class StartAuction(BaseModel):
    """Auctioneer: begin, whether or not the countdown has run out."""

    model_config = Strict
    type: Literal["start_auction"]


class PutUp(BaseModel):
    """Auctioneer: put a player on the block."""

    model_config = Strict
    type: Literal["put_up"]
    player_id: int = Field(ge=1, le=10_000_000)


class Bid(BaseModel):
    """
    Franchise: bid on the current lot.

    `amount` omitted means the standard next increment. `amount` supplied is a
    jumpbid -- the franchise naming its own figure to skip the ladder. Either
    way the room re-derives what is legal; this is a request, and the number in
    it is never trusted as the new price without being checked against the
    standing bid, the ladder and the bidder's purse.

    `lot_version` is the anti-race field. A client bids against the state it
    can see; if the room has moved on since that state was sent, the bid is
    stale and is refused rather than applied to a lot the bidder never saw.
    """

    model_config = Strict
    type: Literal["bid"]
    amount: int | None = Field(default=None, ge=1, le=MAX_AMOUNT_LAKH)
    lot_version: int | None = Field(default=None, ge=0)


class Sell(BaseModel):
    """Auctioneer: knock the lot down to the standing bidder."""

    model_config = Strict
    type: Literal["sell"]


class MarkUnsold(BaseModel):
    """Auctioneer: no bids, or the reserve was not met."""

    model_config = Strict
    type: Literal["unsold"]


class Undo(BaseModel):
    """Auctioneer: take back the last action."""

    model_config = Strict
    type: Literal["undo"]


class FinishAuction(BaseModel):
    """Auctioneer: close the auction and generate the report."""

    model_config = Strict
    type: Literal["finish"]


class Ping(BaseModel):
    """Keepalive. Answered with a pong; touches no state."""

    model_config = Strict
    type: Literal["ping"]


ClientMessage = Annotated[
    Join
    | OpenWaitingRoom
    | StartAuction
    | PutUp
    | Bid
    | Sell
    | MarkUnsold
    | Undo
    | FinishAuction
    | Ping,
    Field(discriminator="type"),
]


class ClientEnvelope(BaseModel):
    """
    Wrapper used to parse an arbitrary incoming frame.

    Pydantic needs a model to hang the discriminated union on; this is it.
    `parse_client_message` below is the only thing that should build one.
    """

    model_config = Strict
    message: ClientMessage


# --------------------------------------------------------------------- #
# Server -> client
# --------------------------------------------------------------------- #


class SeatInfo(BaseModel):
    """Who the room decided this connection is."""

    role: Literal["auctioneer", "franchise", "spectator"]
    team_id: int | None = None
    team_code: str | None = None
    client_id: str


class TeamState(BaseModel):
    """A franchise as the room sees it."""

    id: int
    name: str
    code: str
    color: str
    spent: int
    left: int
    size: int
    overseas: int
    max_bid: int
    connected: bool


class LotState(BaseModel):
    """The player on the block, if any."""

    player_id: int
    player_name: str
    role: str
    country: str | None
    overseas: bool
    rating: float | None
    base: int
    bid: int
    bidder_id: int | None
    bidder_code: str | None
    next_ask: int


class LogItem(BaseModel):
    seq: int
    kind: Literal["note", "bid", "sold", "unsold"]
    what: str
    amount: int | None = None
    ts: float


class RoomState(BaseModel):
    """
    The whole auction, as broadcast.

    Deliberately excludes the player pool. That is 284 rows of seventeen
    statistics each, it never changes during an auction, and every client
    already has it from `GET /api/v1/players` -- re-sending it on every bid
    would put a megabyte on the wire to communicate a five-lakh raise.
    """

    type: Literal["state"] = "state"
    version: int
    phase: Literal["lobby", "waiting", "live", "finished"]
    rules: dict
    teams: list[TeamState]
    lot: LotState | None
    log: list[LogItem]
    counts: dict
    # Unix timestamp the waiting-room countdown expires. None outside `waiting`.
    countdown_ends_at: float | None = None
    connected: int = 0


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    message: str
    # Set when the error answers a specific action, so a client can decide
    # whether to surface it loudly or just log it.
    about: str | None = None


class JoinedMessage(BaseModel):
    type: Literal["joined"] = "joined"
    seat: SeatInfo


class PongMessage(BaseModel):
    type: Literal["pong"] = "pong"


class ReportMessage(BaseModel):
    type: Literal["report"] = "report"
    report: dict
