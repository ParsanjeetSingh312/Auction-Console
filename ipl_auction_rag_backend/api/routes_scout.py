"""
routes_scout.py
SCOUT's own endpoints, mounted on the application that already exists.

Not a second FastAPI app. The brief's file tree had `src/main.py`, which would
have meant a second server on a second port, a second CORS configuration, and a
frontend pointing at two origins. This is a router on the app that already
serves /api/v1/*, the auction WebSocket and the built console on port 8001.

Right now it exposes one endpoint, and its job is to answer "is SCOUT wired in?"
from a browser, before any of it does anything. Everything Phase 1 built --
settings, schemas, graph state, the provider ladder -- is invisible until
something reports on it, and invisible reads as broken.

**This route must stay cheap.** `/api/v1/health` carries a comment explaining
that it deliberately does not construct a ChromaManager, because that loads the
BGE embedding model and would hold the event loop for about forty seconds on a
cold start -- turning the cheapest endpoint in the API into the most expensive.
The same rule applies here, and harder: this one also runs in the same process
as the auction's seven-second bid timers. So the vector counts below are read
straight out of Chroma's own SQLite file, and the one genuinely remote check
(Hermes) is opt-in behind `?probe=true` rather than paid for on every call.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config.settings import get_settings
from scout.graph.state import ScoutInput, ScoutOutput
from scout.schemas.queries import QUESTION_MAX_LENGTH, TeamContext

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/scout", tags=["SCOUT"])


# ---------------------------------------------------------------------------
# Response models
#
# Defined here rather than in api/schemas.py so this phase adds a file instead
# of editing one. They move if SCOUT grows enough endpoints to be worth it.
# ---------------------------------------------------------------------------


class SourceStatus(BaseModel):
    """One entry from config/sources.yaml, as the operator needs to see it."""

    id: str
    name: str
    enabled: bool
    kind: str | None = None
    #: Present when a source is off because it refused an identified crawler.
    #: Surfaced rather than hidden: "disabled" and "disabled because they said
    #: no" are different facts, and only one of them is worth revisiting.
    blocked_measurement: str | None = None


class AdviseRequest(BaseModel):
    """
    A question for the advisor.

    **There is no field for the purse, and that is the point.** A client says
    which franchise it is asking as; the server reads what that franchise can
    actually afford from the auction room. The same reasoning `auction/schemas.py`
    gives for its own client messages applies here: "a client cannot claim to be
    someone else because there is no field in which to make the claim". A bid
    ceiling a caller could state is a bid ceiling a caller could raise.
    """

    question: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    #: None means no franchise context: the advisor answers without budget
    #: reasoning, which is the right behaviour for the read-only /data screen.
    team_id: int | None = Field(default=None, ge=1, le=50)
    on_block_player_id: int | None = Field(default=None, ge=1)
    #: Seconds for the whole turn. The console should send something short
    #: while a lot is live -- the room opens one for seven seconds.
    budget_seconds: float | None = Field(default=None, gt=0, le=120)
    #: The checkpoint key. The same value resumes a conversation; a different
    #: one starts fresh.
    #:
    #: Unset means a new thread per request. It used to default to the literal
    #: string "default", which made every caller in the building share one
    #: conversation and one checkpoint -- so a question about keepers resumed
    #: from a question about all-rounders, and the notes arrived merged.
    #: Sharing a thread should be something a caller opts into by naming it.
    thread_id: str | None = Field(default=None, min_length=1, max_length=64)


class ResearchRequest(BaseModel):
    """Trigger an acquisition pass."""

    seasons_back: int = Field(default=3, ge=1, le=20)
    #: False records and embeds without touching `players` -- a dry run. The
    #: pipeline forces this anyway while an auction is live.
    apply_to_players: bool = True
    thread_id: str = Field(default="research", min_length=1, max_length=64)


class ScoutHealthResponse(BaseModel):
    """What SCOUT can do right now, and what is missing."""

    status: Literal["ok", "degraded", "blocked"]

    # --- sources ---
    sources_path: str
    sources_total: int = 0
    sources_enabled: int = 0
    sources: list[SourceStatus] = Field(default_factory=list)
    search_fallback: bool = False

    # --- stores ---
    pool_collection: str = "ipl_players"
    pool_documents: int | None = None
    research_collection: str
    #: None means the collection does not exist yet, which is the correct state
    #: before the Researcher has ever run -- distinct from 0, which would mean
    #: it ran and wrote nothing.
    research_documents: int | None = None

    # --- reasoning ---
    #: From llm_provider.describe(): who serves a request and who catches it.
    reasoning_engine: str
    hermes_configured: bool = False
    #: The host only, never the key.
    hermes_base_url: str | None = None
    #: Only populated with ?probe=true. None means "not asked".
    hermes_reachable: bool | None = None

    # --- graph ---
    checkpoint_path: str
    checkpoint_exists: bool = False
    graph_ready: bool = False
    #: The compiled graph's nodes and edges, read off the graph itself rather
    #: than described by hand, so this cannot claim a shape the code lacks.
    graph: dict[str, Any] | None = None

    notes: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_sources(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    """The sources file, or None and a reason fit to show an operator."""
    if not path.is_file():
        return None, f"sources.yaml not found at {path}"
    try:
        with path.open("r", encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}, None
    except yaml.YAMLError as exc:
        # A broken YAML file is a configuration error the operator can fix, so
        # it is reported rather than raised as a 500 with a stack trace.
        return None, f"sources.yaml is not valid YAML: {exc}"


def _collection_counts(chroma_dir: Path) -> dict[str, int]:
    """
    Documents per collection, read from Chroma's SQLite file directly.

    Deliberately not via ChromaManager: constructing one loads the BGE model.
    The join is collections -> segments -> embeddings, verified against the
    live store (ipl_players, 284). A collection that has never been written to
    is simply absent from the result, which is what lets the caller tell "never
    ran" from "ran and found nothing".
    """
    store = chroma_dir / "chroma.sqlite3"
    if not store.is_file():
        return {}
    try:
        with sqlite3.connect(f"file:{store}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                """
                SELECT c.name, COUNT(e.id)
                  FROM collections c
                  LEFT JOIN segments s ON s.collection = c.id
                  LEFT JOIN embeddings e ON e.segment_id = s.id
                 GROUP BY c.name
                """
            ).fetchall()
        return {name: count for name, count in rows}
    except Exception as exc:  # noqa: BLE001 - any failure means "cannot report"
        logger.warning("Could not read collection counts: %s", exc)
        return {}


async def _probe_hermes(base_url: str, api_key: str, timeout: float) -> bool:
    """
    Ask a Hermes endpoint whether it is up, the OpenAI-compatible way.

    `GET {base}/models` rather than a chat completion: it costs the remote host
    nothing, needs no model name to be correct, and answers the only question
    being asked. Any exception is a False -- a health check that can raise is a
    health check that takes the page down with it.
    """
    import httpx

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{base_url.rstrip('/')}/models", headers=headers)
        return response.status_code == 200
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def _team_context(team_id: int | None) -> tuple[TeamContext | None, list[str]]:
    """
    A franchise's real position, read from the room.

    Every number here comes from `Room.summary_for`, which is the same
    arithmetic the room uses to accept or refuse a bid -- so the advisor and
    the auction cannot disagree about what a team can afford. In particular
    `max_bid` already holds back enough purse to fill a minimum squad, which
    is why it is smaller than `left` and why it, not `left`, is the ceiling.
    """
    if team_id is None:
        return None, []
    try:
        from auction.room import room

        team = room.team_by_id(team_id)
        if team is None:
            return None, [f"No franchise with id {team_id}; answering without budget context."]
        summary = room.summary_for(team_id)
        return TeamContext(
            team_id=team["id"], name=team["name"], code=team["code"],
            purse_left_lakh=summary["left"], max_bid_lakh=summary["max_bid"],
            squad_size=summary["size"], overseas_count=summary["overseas"],
            max_squad=room.rules["max_squad"], min_squad=room.rules["min_squad"],
            max_overseas=room.rules["max_overseas"],
        ), []
    except Exception as exc:  # noqa: BLE001 - no room is not a failed request
        logger.warning("Could not read team %s from the room: %s", team_id, exc)
        return None, [f"Could not read franchise {team_id} from the auction room; "
                      "answering without budget context."]


@router.post("/advise", response_model=ScoutOutput)
async def advise(request: AdviseRequest) -> ScoutOutput:
    """
    Ask SCOUT who to bid on.

    Runs the whole graph: classify, retrieve, reason, and -- if the research is
    stale and the budget allows -- fetch fresher data and answer again. The
    response always carries `engine_used` and `notes`, so a degraded answer
    arrives looking degraded rather than confident.
    """
    from scout.graph.workflow import run

    team, team_notes = _team_context(request.team_id)
    try:
        output = await run(
            ScoutInput(
                question=request.question,
                team=team,
                on_block_player_id=request.on_block_player_id,
                budget_seconds=request.budget_seconds,
            ),
            thread_id=request.thread_id or f"req-{uuid.uuid4().hex[:16]}",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("SCOUT advise failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"SCOUT failed: {exc}") from exc

    return output.model_copy(update={"notes": team_notes + output.notes})


# ---------------------------------------------------------------------------
# The pipeline, as it happens
# ---------------------------------------------------------------------------

#: What each graph node is called in the interface, and what it is doing while
#: it runs.
#:
#: Keyed by the node's real name in `scout/graph/workflow.py`, so a node that is
#: renamed there stops appearing here rather than appearing under a stale label.
#: The stream sends this map to the client instead of the client hard-coding it,
#: which means the interface cannot claim a pipeline the graph does not have --
#: the same rule `graph_shape()` already follows.
NODE_LABELS: dict[str, dict[str, str]] = {
    "supervisor": {
        "title": "Supervisor",
        "running": "Reading the question and extracting constraints",
        "done": "Intent classified",
    },
    "researcher": {
        "title": "Data Researcher",
        "running": "Gathering IPL stats, economy rates and recent form",
        "done": "Research indexed",
    },
    "advisor": {
        "title": "Cricket Advisor",
        "running": "Cross-checking squad gaps, purse and role fit",
        "done": "Recommendation ready",
    },
}


def _sse(payload: dict[str, Any]) -> str:
    """
    One Server-Sent Event.

    `default=str` because the state carries datetimes on its research batch, and
    a serialisation error halfway through a stream closes the connection with no
    status code the client can report.
    """
    return "data: " + json.dumps(payload, default=str) + "\n\n"


@router.post("/advise/stream")
async def advise_stream(request: AdviseRequest) -> StreamingResponse:
    """
    The same answer as `/advise`, with the graph's progress as it happens.

    **Why a second route rather than a flag on the first.** `/advise` returns a
    validated `ScoutOutput` and is what a script or a test should call; this one
    returns an event stream and is what an interface should call. A single route
    returning either shape depending on a query parameter has no usable
    `response_model` and cannot be typed on either side.

    **The progress is real, not a timed animation.** `stream_mode="tasks"` emits
    one chunk when a node starts and another when it finishes -- distinguishable
    because only the finish chunk carries a `result` key. So a node lights up
    because it is running, and the refresh cycle back to the Researcher shows up
    as the Researcher genuinely lighting a second time.

    **`values` is requested only for the final state.** The last chunk of that
    mode is the whole state at the end of the run, which is exactly what
    `output_from` needs. Accumulating it from `updates` instead would mean
    reimplementing LangGraph's reducers out here, including `merge_notes`.

    Nothing in this handler blocks: the auction's seven-second bid timers run on
    this same event loop, and a synchronous call in here would stall them.
    """
    from scout.graph.state import NOTES_RESET
    from scout.graph.workflow import compiled, output_from

    team, team_notes = _team_context(request.team_id)
    thread_id = request.thread_id or f"req-{uuid.uuid4().hex[:16]}"

    async def events() -> AsyncIterator[str]:
        started = time.perf_counter()

        # The shape first, so the interface can draw the whole pipeline greyed
        # out before anything runs rather than growing it a node at a time.
        yield _sse({"type": "graph", "labels": NODE_LABELS})

        if team_notes:
            yield _sse({"type": "notes", "notes": team_notes})

        final: dict[str, Any] = {}

        try:
            app = await compiled()
            payload = ScoutInput(
                question=request.question,
                team=team,
                on_block_player_id=request.on_block_player_id,
                budget_seconds=request.budget_seconds,
            )

            async for mode, chunk in app.astream(
                payload.model_dump(),
                {"configurable": {"thread_id": thread_id}},
                stream_mode=["tasks", "updates", "values"],
            ):
                if mode == "tasks":
                    name = chunk.get("name")
                    if name not in NODE_LABELS:
                        continue
                    if "result" in chunk:
                        error = chunk.get("error")
                        yield _sse(
                            {
                                "type": "node",
                                "node": name,
                                "status": "failed" if error else "done",
                                "detail": str(error) if error else None,
                            }
                        )
                    else:
                        yield _sse({"type": "node", "node": name, "status": "running"})

                elif mode == "updates":
                    # Notes as each node produces them, so a degradation is
                    # visible while the turn is still running rather than only
                    # in the final payload.
                    for node, update in (chunk or {}).items():
                        if not isinstance(update, dict):
                            continue
                        fresh = [
                            n for n in (update.get("notes") or []) if n != NOTES_RESET
                        ]
                        if fresh:
                            yield _sse({"type": "notes", "node": node, "notes": fresh})

                elif mode == "values":
                    final = chunk

            output = output_from(final, time.perf_counter() - started)
            output = output.model_copy(update={"notes": team_notes + output.notes})
            yield _sse({"type": "result", "output": output.model_dump(mode="json")})

        except Exception as exc:  # noqa: BLE001
            # A stream cannot raise an HTTPException once the first byte is out,
            # so the failure is delivered as an event the client can render.
            logger.error("SCOUT stream failed: %s", exc, exc_info=True)
            yield _sse({"type": "error", "detail": f"SCOUT failed: {exc}"})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            # `no-transform` matters as much as `no-cache`: a proxy that
            # compresses the body will also buffer it, and a buffered event
            # stream arrives all at once at the end -- which looks exactly like
            # the pipeline not working.
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/research", response_model=ScoutOutput)
async def research(request: ResearchRequest | None = None) -> ScoutOutput:
    """
    Fetch and index the latest data.

    Slow by nature -- it downloads an archive and aggregates a few hundred
    matches -- so it is a deliberate call rather than something the advisor
    does behind a user's back on every question.
    """
    from scout.agents.data_researcher import research as run_research

    payload = request or ResearchRequest()
    try:
        batch = await run_research(
            seasons_back=payload.seasons_back,
            apply_to_players=payload.apply_to_players,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("SCOUT research failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Research failed: {exc}") from exc

    return ScoutOutput(
        intent="research",
        research=batch,
        notes=list(dict.fromkeys(batch.notes)),
        elapsed_seconds=round(
            (batch.finished_at - batch.started_at).total_seconds(), 2
        ),
    )


@router.get("/health", response_model=ScoutHealthResponse)
async def scout_health(
    probe: bool = Query(
        default=False,
        description=(
            "Also make one network call to the Hermes endpoint. Off by default "
            "so this route stays instant and cannot stall the auction loop."
        ),
    ),
) -> ScoutHealthResponse:
    """
    What SCOUT is wired up to, and what it still needs.

    Open it in a browser. Everything Phase 1 built is configuration and type
    definitions, and this is the surface that makes it visible.
    """
    settings = get_settings()
    notes: list[str] = []

    # --- sources -----------------------------------------------------------
    sources_path = Path(settings.SCOUT_SOURCES_PATH)
    config, problem = _load_sources(sources_path)
    if problem:
        notes.append(problem)

    entries = (config or {}).get("sources") or []
    statuses = [
        SourceStatus(
            id=str(s.get("id", "?")),
            name=str(s.get("name", s.get("id", "?"))),
            enabled=bool(s.get("enabled", False)),
            kind=s.get("kind"),
            blocked_measurement=s.get("blocked_measurement"),
        )
        for s in entries
        if isinstance(s, dict)
    ]
    enabled = sum(1 for s in statuses if s.enabled)
    blocked = [s for s in statuses if s.blocked_measurement]
    if blocked:
        notes.append(
            f"{len(blocked)} source(s) disabled after refusing an identified "
            "crawler; prose research goes through the search fallback instead."
        )

    search_on = bool((config or {}).get("search_fallback", {}).get("enabled"))
    if search_on and not settings.TAVILY_API_KEY:
        notes.append(
            "Search fallback is enabled in sources.yaml but TAVILY_API_KEY is "
            "unset, so it will report itself unavailable."
        )

    # --- stores ------------------------------------------------------------
    counts = _collection_counts(Path(settings.CHROMA_DB_PATH))
    research_docs = counts.get(settings.SCOUT_COLLECTION_NAME)
    if research_docs is None:
        notes.append(
            f"Research collection '{settings.SCOUT_COLLECTION_NAME}' does not "
            "exist yet - the Data Researcher has not run."
        )

    # --- reasoning ---------------------------------------------------------
    from rag.llm_provider import describe

    hermes_url = (settings.HERMES_API_BASE_URL or "").strip()
    reachable: bool | None = None
    if hermes_url and probe:
        reachable = await _probe_hermes(
            hermes_url, settings.HERMES_API_KEY, min(settings.HERMES_TIMEOUT, 5.0)
        )
        if not reachable:
            notes.append(
                f"Hermes did not answer at {hermes_url} - the advisor will use "
                "the local provider ladder."
            )
    elif not hermes_url:
        notes.append(
            "HERMES_API_BASE_URL is unset; the advisor will use the local "
            "provider ladder. This is a configuration state, not a fault."
        )

    # --- graph -------------------------------------------------------------
    checkpoint = Path(settings.SCOUT_CHECKPOINT_PATH)
    shape: dict[str, Any] | None = None
    try:
        from scout.graph.workflow import graph_shape

        shape = graph_shape()
    except Exception as exc:  # noqa: BLE001 - reporting must not take the route down
        notes.append(f"Graph could not be built: {exc}")

    status: Literal["ok", "degraded", "blocked"] = "ok"
    if problem:
        status = "blocked"
    elif enabled == 0 or research_docs is None:
        status = "degraded"

    return ScoutHealthResponse(
        status=status,
        sources_path=str(sources_path),
        sources_total=len(statuses),
        sources_enabled=enabled,
        sources=statuses,
        search_fallback=search_on,
        pool_documents=counts.get("ipl_players"),
        research_collection=settings.SCOUT_COLLECTION_NAME,
        research_documents=research_docs,
        reasoning_engine=describe(),
        hermes_configured=bool(hermes_url),
        hermes_base_url=hermes_url or None,
        hermes_reachable=reachable,
        checkpoint_path=str(checkpoint),
        checkpoint_exists=checkpoint.is_file(),
        graph_ready=shape is not None,
        graph=shape,
        notes=notes,
    )
