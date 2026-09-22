"""
schemas.py
Pydantic V2 request/response models for the IPL Auction RAG API.
"""
from pydantic import BaseModel, Field


# --------------- Request Models ---------------

class ChatMessage(BaseModel):
    """A single message in chat history."""
    role: str = Field(..., description="Message role: 'user' or 'assistant'")
    content: str = Field(..., description="Message content")


class QueryRequest(BaseModel):
    """Request body for /api/v1/search endpoint."""
    query: str = Field(..., min_length=1, max_length=500, description="Natural language search query")
    top_k: int = Field(default=5, ge=1, le=20, description="Number of results to return")
    use_reranker: bool = Field(default=True, description="Whether to apply cross-encoder reranking")


class ChatRequest(BaseModel):
    """Request body for /api/v1/chat endpoint."""
    query: str = Field(..., min_length=1, max_length=500, description="Chat message")
    history: list[ChatMessage] | None = Field(default=None, description="Previous conversation history")
    top_k: int = Field(default=5, ge=1, le=20, description="Number of context documents")


class IngestRequest(BaseModel):
    """Request body for /api/v1/ingest endpoint."""
    excel_path: str | None = Field(default=None, description="Optional custom Excel file path")
    reset: bool = Field(default=True, description="Drop and recreate tables before inserting")


# --------------- Response Models ---------------

class PlayerResponse(BaseModel):
    """Individual player data response."""
    id: int | None = None
    player_name: str
    country: str | None = None
    role: str
    cap_status: str | None = None
    overseas: int | None = None
    base_price: float | None = None
    rating: float | None = None
    #: Null means not verified, not absent. The card falls back to the role
    #: badge rather than rendering an invented number at hero size.
    jersey_number: int | None = None
    matches: int | None = None
    total_runs: int | None = None
    bat_avg: float | None = None
    bat_sr: float | None = None
    boundary_pct_spin: float | None = None
    boundary_pct_fast: float | None = None
    sr_vs_spin: float | None = None
    sr_vs_fast: float | None = None
    wickets: int | None = None
    runs_conceded: int | None = None
    economy: float | None = None
    bowl_avg: float | None = None
    bowl_sr: float | None = None
    econ_vs_lhb: float | None = None
    econ_vs_rhb: float | None = None


class SourceDocument(BaseModel):
    """A source document from vector search."""
    player_name: str
    role: str | None = None
    relevance_score: float | None = None
    text: str | None = None


class SearchResponse(BaseModel):
    """Response from /api/v1/search endpoint."""
    answer: str
    route: str
    sql_query: str | None = None
    sql_results: list[dict] = Field(default_factory=list)
    sources: list[SourceDocument] = Field(default_factory=list)
    mode: str = Field(
        default="llm",
        description=(
            "How the answer was produced: 'llm' for language-model synthesis, "
            "'local_analyst' for the deterministic no-LLM path."
        ),
    )
    notes: list[str] = Field(
        default_factory=list,
        description="Every fallback that fired while answering, in plain English.",
    )


class ChatResponse(BaseModel):
    """Response from /api/v1/chat endpoint."""
    answer: str
    route: str
    sources: list[SourceDocument] = Field(default_factory=list)
    sql_query: str | None = None
    mode: str = Field(default="llm", description="'llm' or 'local_analyst'.")
    notes: list[str] = Field(default_factory=list)


class IngestResponse(BaseModel):
    """Response from /api/v1/ingest endpoint."""
    status: str
    players_loaded: int
    vectors_created: int


class PlayerListResponse(BaseModel):
    """Response from /api/v1/players endpoint."""
    total: int
    players: list[PlayerResponse]
    limit: int
    offset: int


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    version: str
    sqlite_players: int | None = None
    chroma_documents: int | None = None
    llm_ready: bool = Field(
        default=False,
        description="True when a well-formed synthesis key is configured.",
    )
    answer_mode: str = Field(
        default="local_analyst",
        description="Which path answers questions right now: 'llm' or 'local_analyst'.",
    )
    config_warnings: list[str] = Field(
        default_factory=list,
        description="Environment settings that need attention, from the startup check.",
    )
