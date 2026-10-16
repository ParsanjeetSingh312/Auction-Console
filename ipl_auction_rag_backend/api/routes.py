"""
routes.py
FastAPI router exposing the RAG search engine API endpoints.
"""
import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from api.schemas import (
    ChatRequest,
    ChatResponse,
    HealthResponse,
    IngestRequest,
    IngestResponse,
    PlayerListResponse,
    PlayerResponse,
    QueryRequest,
    SearchResponse,
    SourceDocument,
)
from db import get_player_db
from api.auth import require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["RAG Search"])


@router.post("/search", response_model=SearchResponse)
async def search(request: QueryRequest) -> SearchResponse:
    """
    Hybrid RAG search endpoint.
    Routes queries to SQL, vector search, or both, then synthesizes a response.
    """
    try:
        from rag.rag_chain import search as rag_search
        
        result = rag_search(
            query=request.query,
            top_k=request.top_k,
            use_reranker=request.use_reranker,
        )
        
        return SearchResponse(
            answer=result["answer"],
            route=result["route"],
            sql_query=result.get("sql_query"),
            sql_results=result.get("sql_results", []),
            sources=[
                SourceDocument(**s) for s in result.get("sources", [])
            ],
            mode=result.get("mode", "llm"),
            notes=result.get("notes", []),
        )
    except Exception as e:
        logger.error("Search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500, detail="Search failed. See the server logs for details."
        )


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """
    Conversational RAG endpoint with chat history support.
    """
    try:
        from rag.rag_chain import chat as rag_chat
        
        history = None
        if request.history:
            history = [{"role": m.role, "content": m.content} for m in request.history]
        
        result = rag_chat(
            query=request.query,
            history=history,
            top_k=request.top_k,
        )
        
        return ChatResponse(
            answer=result["answer"],
            route=result["route"],
            sources=[
                SourceDocument(**s) for s in result.get("sources", [])
            ],
            sql_query=result.get("sql_query"),
            mode=result.get("mode", "llm"),
            notes=result.get("notes", []),
        )
    except Exception as e:
        logger.error("Chat failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500, detail="Chat failed. See the server logs for details."
        )


@router.get("/players", response_model=PlayerListResponse)
async def list_players(
    limit: int = Query(default=50, ge=1, le=500, description="Max results"),
    offset: int = Query(default=0, ge=0, description="Offset for pagination"),
    role: str | None = Query(default=None, description="Filter by role"),
    cap_status: str | None = Query(default=None, description="Filter: CAPPED or UNCAPPED"),
    overseas: bool | None = Query(default=None, description="Filter: overseas players"),
) -> PlayerListResponse:
    """
    Retrieve the master player table with optional filters and pagination.
    """
    try:
        player_db = get_player_db()
        
        # Build dynamic query with filters
        conditions = []
        params: list[Any] = []
        
        if role:
            conditions.append("role = ?")
            params.append(role)
        if cap_status:
            conditions.append("cap_status = ?")
            params.append(cap_status)
        if overseas is not None:
            conditions.append("overseas = ?")
            params.append(1 if overseas else 0)
        
        where_clause = " AND ".join(conditions)
        where_sql = f"WHERE {where_clause}" if where_clause else ""
        
        # Get total count
        count_sql = f"SELECT COUNT(*) as cnt FROM players {where_sql}"
        count_result = player_db.execute_query(count_sql, tuple(params))
        total = count_result[0]["cnt"] if count_result else 0
        
        # Get paginated results
        query_sql = f"SELECT * FROM players {where_sql} ORDER BY id LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        players = player_db.execute_query(query_sql, tuple(params))
        
        return PlayerListResponse(
            total=total,
            players=[PlayerResponse(**p) for p in players],
            limit=limit,
            offset=offset,
        )
    except Exception as e:
        logger.error("Player listing failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500, detail="Failed to list players. See the server logs."
        )


@router.post(
    "/ingest",
    response_model=IngestResponse,
    dependencies=[Depends(require_admin)],
)
async def ingest(request: IngestRequest | None = None) -> IngestResponse:
    """
    Trigger re-parsing of the Excel dataset and reload into
    both SQLite and ChromaDB.
    """
    try:
        from ingestion.data_loader import run_ingestion
        
        excel_path = request.excel_path if request else None
        reset = request.reset if request else True
        
        # On a worker thread, not the event loop. Ingestion embeds every player
        # on the CPU -- minutes on a throttled host -- and this process has one
        # event loop serving everything: run inline, it froze /ping, the
        # console and the auction WebSocket until it finished, and the host's
        # proxy answered every request with a 502.
        result = await asyncio.to_thread(
            run_ingestion, excel_path=excel_path, reset=reset
        )

        # Put SCOUT's research back.
        #
        # `reset=True` rebuilds `players` from the spreadsheet, which undoes
        # every column the Data Researcher had filled in -- and 191 of the 284
        # rows have no base price or rating in the spreadsheet at all, so that
        # is most of what research contributes. The ledger in
        # scout_player_updates is the durable record; this replays it onto the
        # freshly rebuilt pool. Ordered before the room refresh below so the
        # room reads the pool with the research already in it.
        #
        # Failure here is logged and survived: the ingest itself succeeded, and
        # a pool without research is degraded rather than broken.
        try:
            from scout.tools.rag_pipeline import replay_research

            replay = await asyncio.to_thread(replay_research)
            if replay.ledger_rows:
                logger.info("SCOUT research replayed: %s", replay.summary())
            for note in replay.notes:
                logger.warning("SCOUT replay: %s", note)
        except Exception as exc:  # noqa: BLE001 - ingestion itself succeeded
            logger.warning("Could not replay SCOUT research: %s", exc)

        # Refresh the auction room's copy of the pool.
        #
        # The room reads the player table once, at startup, because it needs
        # base prices and roles on every bid and re-querying SQLite per bid
        # would be silly. That cache is correct until someone re-ingests --
        # at which point the room would keep bidding on the old pool while
        # every client showed the new one. Re-reading here closes that window.
        try:
            from auction.rooms import registry as auction_rooms
            from db import get_player_db

            # Every open room, not just the default one. A room mid-auction
            # keeps its pool: swapping it under a running auction would
            # invalidate the block and every record keyed by player id, so the
            # operator is told rather than the auction quietly corrupted.
            kept = auction_rooms.refresh_pool(
                get_player_db().get_all_players(limit=1000, offset=0)
            )
            logger.info("Auction room pools refreshed after ingestion")
            if kept:
                logger.warning(
                    "Ingestion finished, but an auction is running in %s - "
                    "those rooms kept their existing pool. Finish or reset "
                    "them, then restart to pick up the new data.",
                    ", ".join(kept),
                )
        except Exception as exc:  # noqa: BLE001 - ingestion itself succeeded
            logger.warning("Could not refresh the auction room pool: %s", exc)

        return IngestResponse(
            status="success",
            players_loaded=result["players_loaded"],
            vectors_created=result["vectors_created"],
        )
    except Exception as e:
        logger.error("Ingestion failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500, detail="Ingestion failed. See the server logs for details."
        )


@router.get("/ping", include_in_schema=True)
async def ping() -> dict[str, str]:
    """
    The cheapest possible proof that this process is alive.

    Exists because /health is NOT cheap: it runs check_environment(), which
    opens SQLite, counts players, inspects the Chroma directory and validates
    every setting. That is the right amount of work for an operator asking
    "what is broken", and far too much to repeat every five minutes forever.

    This touches nothing. No database, no filesystem, no settings read. It
    answers from memory so that the keep-alive loop in api/main.py -- which is
    what stops Render idling the container -- costs essentially nothing, and so
    that a platform health check can distinguish "the process is up" from "every
    capability is configured".
    """
    return {"status": "alive"}


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """
    Capability report: what the agent can do right now, and what is missing.

    DELIBERATELY `def`, NOT `async def`, and that one keyword is load-bearing.

    FastAPI runs an `async def` path operation directly on the event loop, and a
    `def` one in a worker thread. Everything this function calls is BLOCKING:
    check_environment() opens SQLite, stats the Chroma directory and -- since
    DATABASE_URL arrived -- probes Postgres over a real socket. On the loop
    thread, that blocks EVERY other request for as long as it takes.

    This was not theoretical. With the Supabase project deleted, the Postgres
    probe sat waiting out its timeout and measurement showed /api/v1/ping going
    from 0.003s to 19.03s whenever a single /health was in flight -- the whole
    application frozen, WebSocket frames included, which mid-lot means all ten
    franchises stall at once. A browser hitting /health on page load (see
    pages/Home.tsx) was enough to trigger it.

    Returning to `async def` reintroduces that. If this ever needs to await
    something, wrap the blocking work in `run_in_threadpool` rather than
    flipping the keyword back.

    Counts come from the startup check, which reads the player store directly.
    It deliberately does not construct a ChromaManager: that would load the
    embedding model and cost ~40 seconds on a cold start, turning the endpoint
    an operator reaches for when things look wrong into the slowest one in the
    API. Running in a worker thread makes that survivable rather than fatal, but
    it is still the wrong amount of work to do per request.
    """
    from config.env_check import check_environment
    from rag.rag_chain import MODE_LLM, MODE_LOCAL, llm_available

    report = check_environment()
    ready = llm_available()

    return HealthResponse(
        status="ok" if report.can_start else "degraded",
        version="2.0.0",
        sqlite_players=report.player_count,
        chroma_documents=report.vector_count,
        llm_ready=ready,
        answer_mode=MODE_LLM if ready else MODE_LOCAL,
        config_warnings=[f"{f.name}: {f.message}" for f in report.problems],
    )
