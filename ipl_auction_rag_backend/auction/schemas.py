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
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

# The largest bid the rules could ever permit: one franchise's whole purse.
# A real bid is bounded by the franchise's purse left, but the parser should
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
    # Sent only for an auctioneer login, ignored for a franchise. The chair is
    # password-gated (settings.AUCTIONEER_PASSWORD); this carries the attempt.
    # Bounded like every other field, verified server-side, and never echoed
    # back -- there is no server->client message that contains it.
    password: str | None = Field(default=None, max_length=200)


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


class SetMode(BaseModel):
    """
    Auctioneer, before the auction starts: online (bids on screen, on the
    clock) or offline (placards in the room, sales logged by the auctioneer),
    and in an online room a manual or AI auctioneer.
    """

    model_config = Strict
    type: Literal["set_mode"]
    mode: Literal["online", "offline"]
    auctioneer: Literal["manual", "ai"] = "manual"


class RecordSale(BaseModel):
    """
    Auctioneer, offline: the room has sold the player on the block by placard;
    log who bought him and for how much. Checked like any bid (purse, squad,
    overseas), then knocked down by the same hammer.
    """

    model_config = Strict
    type: Literal["record_sale"]
    team_id: int = Field(ge=1, le=100)
    # Up to the largest purse a room can set (rules.SETUP_FIELDS["purse"]).
    price: int = Field(ge=1, le=1_000_000)


class AiControl(BaseModel):
    """
    The human in the chair of an AI-run room: pause the AI auctioneer's
    calls, resume them, or take the room over (it becomes a manual room).
    """

    model_config = Strict
    type: Literal["ai_control"]
    action: Literal["pause", "resume", "take_over"]


class Withdraw(BaseModel):
    """
    Franchise: step out of the contest for the lot on the block.

    Carries nothing, for the same reason `CallTimeout` does not: the seat the
    frame arrived on is who withdrew, and there is no field in which to claim
    otherwise.

    This exists because the alternative franchises were actually using was
    *leaving their seat* -- which drops the connection, frees the franchise for
    anyone to claim, and says "I am out of the auction" when the intent was "I
    am out of this player". A withdrawal is per-lot and costs nothing; the next
    player puts every franchise back in contention.
    """

    model_config = Strict
    type: Literal["withdraw"]


class CallTimeout(BaseModel):
    """
    Franchise: spend a lifeline and freeze the block.

    Carries nothing, and the emptiness is the design. Who called it is the seat
    the frame arrived on; how many are left is the room's count; how long the
    freeze lasts is the room's rule. A message with fields for those three
    would be a message a client could use to call a timeout as another
    franchise, call a fourth after spending three, or call a five-minute one.

    The room refuses it unless the closing buffer is actually running and the
    caller is not the franchise currently holding the bid -- a lifeline is for
    answering a bid, not for stalling behind your own.
    """

    model_config = Strict
    type: Literal["timeout"]


class Undo(BaseModel):
    """Auctioneer: take back the last action."""

    model_config = Strict
    type: Literal["undo"]


class FinishAuction(BaseModel):
    """Auctioneer: close the auction and generate the report."""

    model_config = Strict
    type: Literal["finish"]


class ResetRoom(BaseModel):
    """
    Auctioneer: wipe the auction and go back to the lobby.

    Needed for a reason that is not only convenience. Without it the only way
    out of `finished` is restarting the server, which means a practice run and
    the real auction cannot happen in the same session -- and the practice run
    is exactly how an auctioneer learns the controls before ten franchises are
    watching.
    """

    model_config = Strict
    type: Literal["reset"]


class SetRules(BaseModel):
    """
    Auctioneer: change the auction's own parameters.

    The Auction Setup panel has offered these four fields since Phase 4 and
    until now there was no message to carry them, so the dialog wrote to a
    local engine the live room never reads -- an auctioneer could set a squad
    cap of 11, be told "Auction rules updated", and watch the leaderboard go on
    saying 25. Same class of break as `reset` before its wire existed.

    Only the four the panel edits. The clock durations and the lifeline count
    are not in the dialog, and a message that could rewrite them would be a
    wider hole than the feature needs -- the server merges these over whatever
    else the rules hold.

    Bounds are generous but finite: a purse of 2^31 lakh or a squad of a
    million is not a configuration, it is a way to make some other part of the
    room misbehave.
    """

    model_config = Strict
    type: Literal["set_rules"]
    # Total Budget, lakh.
    purse: int = Field(ge=1, le=10_000_000)
    # Total Squad: the most players one franchise may hold.
    max_squad: int = Field(ge=1, le=100)
    # Minimum Players: the squad every franchise must finish with.
    min_squad: int = Field(ge=1, le=100)
    max_overseas: int = Field(ge=0, le=100)
    # Optional so an older client sending only the four fields above still
    # works; the room keeps its current value for anything omitted.
    # Maximum Players: how many players may go under the hammer in total.
    max_players: int | None = Field(default=None, ge=0, le=10_000)
    min_overseas: int | None = Field(default=None, ge=0, le=100)


class AcknowledgeRules(BaseModel):
    """
    Franchise: "I have read the briefing."

    Quotes the `rules_version` the franchise was shown. The room accepts it only
    when it matches the current version, so an acknowledgement of yesterday's
    rules cannot be replayed after the host changes them -- the briefing must be
    read again, which is the point of rule 7.
    """

    model_config = Strict
    type: Literal["acknowledge_rules"]
    rules_version: int = Field(ge=0)


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
    | Withdraw
    | CallTimeout
    | Undo
    | FinishAuction
    | ResetRoom
    | SetRules
    | SetMode
    | RecordSale
    | AiControl
    | AcknowledgeRules
    | Ping,
    Field(discriminator="type"),
]


def supported_message_types() -> list[str]:
    """
    Every `type` the server will accept, derived from the union itself.

    Broadcast in the room state so a client can tell whether the server it is
    talking to understands the messages it intends to send. That sounds like
    over-engineering until you have watched an auctioneer set a squad cap of 11
    on a page whose JavaScript was rebuilt an hour ago, against a uvicorn
    process started before the message type existed: the browser sends
    `set_rules`, the old server rejects it as unknown, and the only evidence is
    a toast that scrolls past. The frontend is re-read from `dist/` on every
    request and the Python is not, so the two halves drift apart routinely in
    this project's workflow, and nothing on screen said so.

    Read off the discriminated union rather than hand-listed, so a message type
    added later cannot forget to appear here.
    """
    union = get_args(get_args(ClientMessage)[0])
    out: list[str] = []
    for model in union:
        annotation = model.model_fields["type"].annotation
        literals = get_args(annotation)
        if literals:
            out.append(str(literals[0]))
    return sorted(out)


# --------------------------------------------------------------------- #
# Server -> client
#
# Declarative. Nothing below is constructed: auction/room.py and auction/ws.py
# build these frames as plain dicts, and this section is the server-side
# specification of what those dicts contain. Comments in room.py and
# scout/schemas/queries.py cite these classes by name as the contract.
#
# The client -> server section above is the opposite -- every model there is live
# code, assembled into the ClientMessage discriminated union that ws.py parses
# with TypeAdapter.
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
    # Strategic buffers not yet spent. Sent for every franchise, not just your
    # own: which rivals can still freeze a lot is exactly the sort of thing a
    # bidder should be able to price in before committing.
    timeouts_left: int = 0
    uncapped: int = 0
    # Still owed to reach the room's minimums: squad places a franchise must
    # keep free. Places only -- no purse is held back for them.
    overseas_needed: int = 0
    uncapped_needed: int = 0
    # Has this franchise acknowledged the current rules_version?
    acknowledged: bool = False
    # [player_id, price] pairs. Lets a client rebuild this squad without
    # re-fetching the pool -- see RoomState on why the pool is not broadcast.
    buys: list[list[int]] = Field(default_factory=list)


class LotState(BaseModel):
    """
    The player on the block, if any -- and the clock running on them.

    The clock is the whole of this phase on the wire. A lot is never just a
    price now; it is a price with a deadline, and what happens when that
    deadline arrives depends entirely on whether anyone has bid.
    """

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
    # Bumped by every change to this lot. A bid quotes it back so one made
    # against a price the room has already moved past can be refused rather
    # than applied. See the race guard in room.bid.
    version: int = 0

    # ---------------------------- the clock ---------------------------- #
    #
    # `clock` says what the countdown *means*, which is the only thing a client
    # needs in order to render it honestly:
    #
    #   opening   nobody has bid. Expiry marks the player UNSOLD.
    #   closing   a bid stands. Expiry knocks the lot down to that bidder.
    #   timeout   a franchise spent a lifeline. The thirty seconds *are* the
    #             thinking window, so expiry settles exactly as `closing` does:
    #             a strategy timer nobody answered sells the lot. Only a bid
    #             gets out of it, and a bid returns the lot to `closing`.
    #
    # Every lot always has a deadline while it is on the block. A `withdraw`
    # does not stop the clock -- it settles the lot early once nobody but the
    # standing bidder is left in.
    #
    # `closing` and `timeout` therefore differ in duration and in what the dial
    # should say, never in consequence.
    #
    # `presenting` holds a marquee player's lot while every client plays his
    # reveal; nothing can be bid, folded or bought time for until it lapses
    # into `opening`.
    #
    # None when no lot is live, or when the auctioneer has taken manual control.
    clock: Literal["presenting", "opening", "closing", "timeout"] | None = None

    # Unix time the countdown fires. Absolute, so a client re-rendering
    # mid-second does not restart its own dial from the top.
    deadline: float | None = None

    # Seconds left at the moment this frame was written.
    #
    # Sent *alongside* the absolute deadline rather than instead of it, because
    # seven seconds is short enough for clock skew to matter: a client whose
    # system clock runs two seconds fast would show a lot expiring while the
    # room still considers it open, and would show its own bid button going
    # dead a third of the way through the window it actually has. A client that
    # anchors on this figure and then counts down on its own monotonic clock
    # has no skew to accumulate.
    ends_in: float | None = None

    # The full length of a marquee hold while `clock` is "presenting".
    reveal_seconds: float | None = None

    # Who is holding the room up, when `clock` is "timeout". Named because a
    # thirty-second freeze with no attribution reads as the room having hung.
    timeout_by_id: int | None = None
    timeout_by_code: str | None = None

    # Franchises that have bid on this lot and not withdrawn from it. One entry
    # is an uncontested lot the clock may settle; two or more is a live contest
    # that only a withdrawal (or the gavel) resolves. Sent so every station can
    # see who it is actually still bidding against.
    contenders: list[int] = Field(default_factory=list)
    contender_codes: list[str] = Field(default_factory=list)
    # Franchises that folded on this lot. They may not bid on it again.
    folded: list[int] = Field(default_factory=list)
    folded_codes: list[str] = Field(default_factory=list)
    has_bid: bool = False
    # The +5 / +10 / +15 Cr shortcuts as absolute prices from where the lot
    # stands, computed by the room so the buttons can never offer an illegal bid.
    jump_options: list[int] = Field(default_factory=list)


class LogItem(BaseModel):
    seq: int
    kind: Literal["note", "bid", "sold", "unsold", "timeout", "withdraw"]
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
    # purse, max_squad, min_squad, max_overseas, and the four this phase adds:
    # open_seconds, close_seconds, timeout_seconds, timeouts_per_team. Sent
    # rather than hardcoded in the client so the dial, the lifeline counter and
    # the room can never disagree about how long seven seconds is.
    rules: dict
    # Bumped on every setup change. A franchise must acknowledge this exact
    # number before it may bid, fold or call a buffer.
    rules_version: int = 0
    # The briefing as {id, title, body} items, generated from `rules` so the
    # text can never quote a number the engine is not enforcing.
    briefing: list[dict] = Field(default_factory=list)
    teams: list[TeamState]
    lot: LotState | None
    log: list[LogItem]
    # Player ids the room has passed over. The sold side travels per team on
    # `TeamState.buys`; this is the other half of the same idea.
    unsold: list[int] = Field(default_factory=list)
    counts: dict
    # Unix timestamp the waiting-room countdown expires. None outside `waiting`.
    countdown_ends_at: float | None = None
    # The latest sale -- seq, player, team, team_code, price -- for the
    # "SOLD TO" banner. A new seq is a new sale; undo clears it.
    last_sale: dict | None = None
    connected: int = 0
    # Whether the auctioneer's chair is currently occupied. Lets the seat picker
    # show it as taken rather than offering a login the room would refuse.
    auctioneer_present: bool = False


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
