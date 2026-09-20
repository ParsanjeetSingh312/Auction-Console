"""
state.py
What travels between SCOUT's nodes, and what a caller hands in and gets back.

Three shapes, and the split matters:

    ScoutInput   -- Pydantic. What a caller provides. A trust boundary.
    ScoutState   -- TypedDict. What flows between nodes. Internal.
    ScoutOutput  -- Pydantic. What comes back. Validated before it leaves.

`StateGraph` takes all three (`state_schema`, `input_schema`, `output_schema`),
so this is the framework's own seam rather than something bolted on.

**Why the internal state is a TypedDict and not a BaseModel.** LangGraph merges
partial updates: a node returns `{"notes": ["..."]}` and the framework folds it
into the state through that field's reducer. A Pydantic state has to be
reconstructed and revalidated on every one of those merges, which turns a node
returning one key into a full re-validation of the whole graph state -- and
makes a partial update from a node that legitimately knows nothing about
`recommendation` look like a missing required field. The TypedDict carries
Pydantic models *as its values*, so every payload is still strictly validated at
the point it is built. The container is loose; the contents are not.

**Why the message list is not `add_messages`.** LangGraph ships a reducer for
LangChain message objects, and Hermes speaks plain OpenAI JSON. Using it would
mean importing langchain-core's message classes, converting to them, and
converting back at the transport -- two lossy hops to gain nothing. `HermesTurn`
below is the wire shape already, so it accumulates with a plain list reducer.

**Why deadlines are wall-clock floats.** `time.monotonic()` is meaningless once
a state has been checkpointed to SQLite and resumed in another process, which is
exactly what the checkpointer exists to allow. A unix timestamp survives that,
and it matches `RoomState.countdown_ends_at`, which the auction already uses for
the same purpose.
"""
from __future__ import annotations

import operator
import time
from typing import Annotated, Literal, TypedDict

from pydantic import BaseModel, Field

from scout.schemas.player import ResearchBatch
from scout.schemas.queries import (
    QUESTION_MAX_LENGTH,
    AdvisorRecommendation,
    Constraints,
    Engine,
    TeamContext,
)

#: Every Pydantic type that travels in the state and therefore through the
#: checkpointer. LangGraph's msgpack serde accepts unregistered types today
#: with a deprecation warning and "will be blocked in a future version" -- so
#: they are declared here rather than left to a default that is on its way out.
#: Nested models need their own entry: AdvisorRecommendation carries Candidate,
#: ResearchBatch carries the whole PlayerUpdate tree, and each is encoded as
#: its own extension type.
SCOUT_CHECKPOINT_TYPES: tuple[tuple[str, str], ...] = (
    ("scout.graph.state", "HermesTurn"),
    ("scout.graph.state", "RetrievedRef"),
    ("scout.schemas.queries", "Constraints"),
    ("scout.schemas.queries", "TeamContext"),
    ("scout.schemas.queries", "Candidate"),
    ("scout.schemas.queries", "AdvisorRecommendation"),
    ("scout.schemas.player", "SourceRef"),
    ("scout.schemas.player", "PlayerMatch"),
    ("scout.schemas.player", "PlayerStatUpdate"),
    ("scout.schemas.player", "PlayerValuation"),
    ("scout.schemas.player", "PlayerFact"),
    ("scout.schemas.player", "PlayerUpdate"),
    ("scout.schemas.player", "ResearchBatch"),
)

#: Which branch the supervisor sends a turn down. Named for what the user wants,
#: not for which node runs, so a future third branch does not require renaming
#: the two that exist.
Intent = Literal["research", "advise"]

#: Sentinel a node puts first in its `notes` list to clear what came before.
NOTES_RESET = "\x00reset"


def merge_notes(left: list[str] | None, right: list[str] | None) -> list[str]:
    """
    Accumulate notes within a turn; start a new turn empty.

    A plain `operator.add` reducer is right inside one turn -- the researcher
    and the advisor both have things to say and neither should erase the
    other. It is wrong ACROSS turns, and the failure is not obvious: a thread
    resumes from its checkpoint, so the second question on a thread answers
    with the first question's notes still attached. Observed in testing with
    three separate requests, whose notes arrived merged into one response --
    including "understood as: role=Wicket Keeper" on a question about
    all-rounders. On a shared thread that is one caller reading another
    caller's context.

    So the entry node leads its notes with NOTES_RESET, and everything
    previously accumulated is dropped at that point.
    """
    fresh = list(right or [])
    if fresh and fresh[0] == NOTES_RESET:
        return fresh[1:]
    return list(left or []) + fresh


class HermesTurn(BaseModel):
    """
    One message in the OpenAI chat shape, which is what Hermes accepts.

    Modelled rather than left as a bare dict so a malformed turn fails here
    instead of as a 400 from a remote host with no useful body.
    """

    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1)


class RetrievedRef(BaseModel):
    """
    One thing retrieval found, reduced to what a reasoning engine needs.

    Deliberately not `rag.retriever.RetrievedDocument`. Importing that module
    reaches `models.embedding_loader`, which loads the BGE model -- roughly
    forty seconds on a cold start. A state module is imported by everything,
    including the environment check and the test suite, and none of them should
    pay for an embedding model to read a type definition. The tool layer
    converts; this stays cheap.
    """

    player_id: int | None = Field(default=None, ge=1)
    player_name: str
    text: str
    #: The reranker's score where one ran, the vector distance otherwise. Which
    #: of the two it is matters, so it travels alongside.
    score: float | None = None
    scored_by: Literal["reranker", "vector", "keyword"] = "vector"
    #: True when this came from the scraped collection rather than the
    #: spreadsheet, so the advisor can weight fresh research against the
    #: authoritative pool and say which it used.
    from_research: bool = False


# ---------------------------------------------------------------------------
# The boundaries
# ---------------------------------------------------------------------------


class ScoutInput(BaseModel):
    """
    What a caller hands the graph. Validated before anything runs.

    `intent` is a hint, not an instruction: a caller that knows it wants
    research can say so and skip a model call, and the supervisor classifies
    when it is None. Leaving it out is the normal case.
    """

    question: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    intent: Intent | None = None
    team: TeamContext | None = None
    on_block_player_id: int | None = Field(default=None, ge=1)

    #: Wall-clock seconds this whole turn may take. The advisor tightens it
    #: further when a lot is live -- the room opens one for seven seconds, and
    #: an answer that arrives after the hammer is not an answer.
    budget_seconds: float | None = Field(default=None, gt=0, le=120)


class ScoutOutput(BaseModel):
    """
    What comes back. Exactly one of `recommendation` or `research` is set.

    `notes` is always present and is the honest half of the response: every
    fallback that fired, every source that refused, every cycle that ran out of
    time. The RAG chain already surfaces its degradations this way, and the
    console already renders them, so a degraded SCOUT answer arrives looking
    like a degraded answer rather than a confident one.
    """

    intent: Intent
    recommendation: AdvisorRecommendation | None = None
    research: ResearchBatch | None = None

    engine_used: Engine | None = None
    notes: list[str] = Field(default_factory=list)
    refresh_cycles: int = Field(default=0, ge=0, le=5)
    elapsed_seconds: float = Field(default=0.0, ge=0)


# ---------------------------------------------------------------------------
# The internal state
# ---------------------------------------------------------------------------


class ScoutState(TypedDict, total=False):
    """
    What flows between nodes.

    `total=False` throughout: a node returns only the keys it changed, and
    LangGraph folds them in. Two fields carry reducers because they accumulate
    across nodes rather than being replaced by the last writer -- losing a note
    from the researcher because the advisor also wrote one is precisely the bug
    the `notes` list exists to prevent.
    """

    # --- from the caller ---
    question: str
    intent: Intent | None
    team: TeamContext | None
    on_block_player_id: int | None

    # --- supervisor ---
    constraints: Constraints

    # --- researcher ---
    research: ResearchBatch | None

    # --- advisor ---
    retrieved: list[RetrievedRef]
    recommendation: AdvisorRecommendation | None

    # --- the Hermes conversation, accumulated ---
    messages: Annotated[list[HermesTurn], operator.add]

    # --- control ---
    #: Carried through from ScoutInput. It has to be declared here as well as
    #: there: StateGraph filters the invoke payload down to the input schema
    #: and then down again to keys the state declares, so a field present in
    #: only one of the two never reaches a node.
    budget_seconds: float | None

    #: How many times the advisor has sent the turn back to the researcher for
    #: fresher data. Checked against SCOUT_MAX_REFRESH_CYCLES by the conditional
    #: edge; without it the one cyclic edge in the graph is unbounded.
    refresh_cycles: int
    #: Unix timestamp this turn must finish by. See the module docstring on why
    #: this is not monotonic.
    deadline_at: float | None
    started_at: float
    engine_used: Engine | None

    #: Accumulated within a turn, cleared at the start of the next one.
    notes: Annotated[list[str], merge_notes]


# ---------------------------------------------------------------------------
# Policy helpers
#
# The conditional edges in workflow.py should read as decisions, not as
# arithmetic on timestamps. These live beside the state because they are the
# only things that interpret it.
# ---------------------------------------------------------------------------


def open_turn(state: ScoutState, *, default_budget: float) -> dict:
    """
    The clock a turn runs against. **Returned by the graph's entry node**, and
    never built by the caller.

    That distinction is the whole reason this function exists, and it is not
    obvious. `StateGraph(..., input_schema=ScoutInput)` filters whatever is
    passed to `invoke` down to ScoutInput's own fields before the first node
    sees it. A deadline computed outside the graph is therefore discarded --
    silently, with no error and no warning. `seconds_left` then returns
    infinity, `may_refresh` never refuses, and the budget that exists to stop
    the advisor answering after the hammer is not enforced at all.

    Measured, not assumed: invoking with a fully seeded state delivered only
    {question, intent, team, on_block_player_id, messages, notes} to the first
    node. Everything else was dropped.

    The deadline is computed once so every node works to the same instant: a
    slow first node shortens the ones after it rather than each getting a
    fresh full budget.
    """
    now = time.time()
    budget = state.get("budget_seconds") or default_budget
    update: dict = {"started_at": now, "deadline_at": now + budget}

    # `input_schema` filters which keys reach a node. It does NOT coerce their
    # values. So `team` arrives as a TeamContext when a Python caller passed
    # model instances, and as a plain dict when the caller passed parsed JSON --
    # which is what an HTTP handler has, and therefore what production traffic
    # looks like. A node then does `state["team"].max_bid_lakh` and raises
    # AttributeError several frames deep, on the request path only, having
    # worked perfectly in every test written in Python.
    #
    # Normalising once here means no node has to know which shape it got.
    team = state.get("team")
    if isinstance(team, dict):
        update["team"] = TeamContext.model_validate(team)

    return update


def seconds_left(state: ScoutState) -> float:
    """
    How long this turn has. Never negative.

    Passed down to a transport as its timeout, so a slow retrieval cannot leave
    a model call with the full budget it would have had on its own.
    """
    deadline = state.get("deadline_at")
    if deadline is None:
        return float("inf")
    return max(0.0, deadline - time.time())


def past_deadline(state: ScoutState) -> bool:
    """True when the turn is out of time and must answer with what it has."""
    return seconds_left(state) <= 0.0


def may_refresh(state: ScoutState, *, max_cycles: int) -> bool:
    """
    Whether the advisor may hand the turn back to the researcher.

    Both conditions, not either. The counter alone would allow one refresh that
    runs past the bid window; the deadline alone would allow an endless series
    of fast refreshes inside it.
    """
    if past_deadline(state):
        return False
    return state.get("refresh_cycles", 0) < max_cycles


def elapsed(state: ScoutState) -> float:
    """Wall-clock seconds since the turn began, for ScoutOutput."""
    started = state.get("started_at")
    return 0.0 if started is None else max(0.0, time.time() - started)

def make_serde():
    """
    A checkpoint serializer that knows SCOUT's types by name.

    `SqliteSaver(conn, serde=...)` takes one; `SqliteSaver.from_conn_string`
    does not, so workflow.py opens the connection itself. Imported lazily so
    that reading a type definition out of this module does not pull in the
    checkpoint machinery -- the environment check and the schema tests both
    import this file and neither of them checkpoints anything.
    """
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

    return JsonPlusSerializer(allowed_msgpack_modules=list(SCOUT_CHECKPOINT_TYPES))
