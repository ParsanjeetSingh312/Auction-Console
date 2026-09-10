"""
routes.py
FastAPI router exposing the RAG search engine API endpoints.
"""
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

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
from db.sqlite_manager import SQLiteManager

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
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


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
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")


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
        sqlite_mgr = SQLiteManager()
        
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
        count_result = sqlite_mgr.execute_query(count_sql, tuple(params))
        total = count_result[0]["cnt"] if count_result else 0
        
        # Get paginated results
        query_sql = f"SELECT * FROM players {where_sql} ORDER BY id LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        players = sqlite_mgr.execute_query(query_sql, tuple(params))
        
        return PlayerListResponse(
            total=total,
            players=[PlayerResponse(**p) for p in players],
            limit=limit,
            offset=offset,
        )
    except Exception as e:
        logger.error("Player listing failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to list players: {str(e)}")


@router.post("/ingest", response_model=IngestResponse)
async def ingest(request: IngestRequest | None = None) -> IngestResponse:
    """
    Trigger re-parsing of the Excel dataset and reload into
    both SQLite and ChromaDB.
    """
    try:
        from ingestion.data_loader import run_ingestion
        
        excel_path = request.excel_path if request else None
        reset = request.reset if request else True
        
        result = run_ingestion(excel_path=excel_path, reset=reset)
        
        return IngestResponse(
            status="success",
            players_loaded=result["players_loaded"],
            vectors_created=result["vectors_created"],
        )
    except Exception as e:
        logger.error("Ingestion failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """
    Capability report: what the agent can do right now, and what is missing.

    Counts come from the startup check, which reads both stores over plain
    SQLite. It deliberately does not construct a ChromaManager: that would load
    the embedding model, and because the route is synchronous it would hold the
    event loop for the ~40 seconds that takes on a cold start - turning the
    cheapest endpoint in the API into the most expensive one.
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
