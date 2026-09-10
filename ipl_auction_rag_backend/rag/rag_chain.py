"""
rag_chain.py
Final RAG synthesis chain. Merges SQL results, vector-retrieved context,
and user query into a structured prompt, then generates the final
analytical response using whichever LLM provider is configured.
"""
import logging
from typing import Any, Callable

from rag import local_analyst
from rag.llm_provider import LLMError
from rag import llm_provider
from rag.query_router import QueryRoute, route_query
from rag.text_to_sql import execute_sql_query
from rag.retriever import retrieve, RetrievedDocument

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Capability detection
#
# Every stage below asks what is actually available rather than assuming, so a
# missing key degrades one stage instead of failing the request. The three
# stages fail independently: routing falls back to keywords, text-to-SQL falls
# back to the deterministic parser, and synthesis falls back to the local
# analyst.
# ---------------------------------------------------------------------------

#: Answer produced by a language model.
MODE_LLM = "llm"
#: Answer composed from the data by rule, with no language model involved.
MODE_LOCAL = "local_analyst"


def llm_available() -> bool:
    """
    True when some provider is configured with a well-formed key.

    Format is checked rather than merely presence: a placeholder, or a key for
    the wrong provider, would otherwise reach the API and come back as an opaque
    401 mid-query — which reads like a bug in the agent rather than a
    configuration problem.
    """
    return llm_provider.available()


def _gather(query: str, top_k: int, use_reranker: bool) -> dict[str, Any]:
    """
    Run the retrieval stages, degrading each one independently.

    Returns the SQL result, the vector documents, any keyword rows that stood in
    for them, and a list of human-readable notes naming every fallback that
    fired. The notes are surfaced to the client: a degraded answer that does not
    say it is degraded is worse than no answer.
    """
    notes: list[str] = []
    has_llm = llm_available()

    route = route_query(query)
    if not has_llm:
        notes.append("Query routed by keyword heuristics (no LLM configured).")

    sql_result: dict[str, Any] = {"sql": None, "results": [], "error": None}
    documents: list[RetrievedDocument] = []
    keyword_rows: list[dict[str, Any]] = []

    # --- structured stage ---
    if route in (QueryRoute.METRIC_SQL, QueryRoute.HYBRID):
        if has_llm:
            sql_result = execute_sql_query(query)
            if sql_result.get("error"):
                # The LLM produced unusable SQL; the deterministic parser is a
                # better answer than an error message.
                fallback = local_analyst.build_sql(query, local_analyst.known_player_names())
                if fallback.get("results"):
                    notes.append("Generated SQL failed; used the deterministic parser instead.")
                    sql_result = fallback
        else:
            sql_result = local_analyst.build_sql(query, local_analyst.known_player_names())
            if sql_result.get("sql"):
                notes.append("SQL built by the deterministic parser (no LLM configured).")

    # --- semantic stage ---
    if route in (QueryRoute.SEMANTIC_VECTOR, QueryRoute.HYBRID):
        try:
            documents = retrieve(query=query, top_k=top_k, use_reranker=use_reranker)
        except Exception as exc:  # noqa: BLE001 — retrieval is optional, not fatal
            logger.warning("Vector retrieval unavailable (%s); using keyword search", exc)
            notes.append(
                "Vector store unavailable — matches below are keyword overlaps, "
                "not semantic matches."
            )
            keyword_rows = local_analyst.keyword_search(query, top_k=top_k)

    return {
        "route": route,
        "sql_result": sql_result,
        "documents": documents,
        "keyword_rows": keyword_rows,
        "notes": notes,
        "has_llm": has_llm,
    }


def _sources(
    documents: list[RetrievedDocument], keyword_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Normalise whichever retrieval path ran into the API's source shape."""
    if documents:
        return [
            {
                "player_name": doc.metadata.get("player_name", "Unknown"),
                "role": doc.metadata.get("role", "Unknown"),
                "relevance_score": doc.rerank_score,
                "text": doc.text,
            }
            for doc in documents
        ]

    return [
        {
            "player_name": row.get("player_name", "Unknown"),
            "role": row.get("role", "Unknown"),
            "relevance_score": row.get("_match_score"),
            "text": None,
        }
        for row in keyword_rows
    ]

SYSTEM_PROMPT = """You are an expert IPL cricket analyst and auction advisor. You help users find and evaluate players for the IPL 2026 mega auction.

You have access to a database of ~284 players. The available statistics differ
by role:
- All players: country, role, capped/uncapped status, Indian/overseas, matches
- Batters, Wicket Keepers and All-Rounders: total runs, batting average,
  batting strike rate, boundary % vs spin and vs pace, strike rate vs spin
  and vs pace
- Bowlers: wickets, runs conceded, economy rate, bowling average, bowling
  strike rate, economy vs left- and right-hand batters
- Some players also have an auction base price and rating

The dataset does NOT contain phase-wise strike rates (powerplay, middle overs,
death overs) or highest scores. Never state such figures; if asked, say the
data is not available and reason from strike rate and the spin/pace splits.

RULES:
1. Base your answers STRICTLY on the provided data context. Do not make up statistics.
2. When presenting player comparisons, use a clear tabular or list format.
3. Highlight the key differentiators between players.
4. If the data is insufficient to answer fully, say so clearly.
5. For auction strategy advice, consider both player statistics and value (if base price is available).
6. Keep responses concise but informative.
7. Use markdown formatting for better readability.
"""


def _format_sql_context(sql_result: dict[str, Any]) -> str:
    """Format SQL query results into readable context."""
    if sql_result.get("error"):
        return f"SQL Query Error: {sql_result['error']}"
    
    if not sql_result.get("results"):
        return "SQL query returned no results."
    
    lines = [f"**SQL Query:** `{sql_result['sql']}`\n"]
    lines.append(f"**Results ({len(sql_result['results'])} players):**\n")
    
    for row in sql_result["results"]:
        # Format each player as a compact line
        name = row.get("player_name", "Unknown")
        parts = [f"**{name}**"]
        for key, val in row.items():
            if key != "player_name" and key != "id" and val is not None:
                parts.append(f"{key}: {val}")
        lines.append("- " + " | ".join(parts))
    
    return "\n".join(lines)


def _format_vector_context(documents: list[RetrievedDocument]) -> str:
    """Format retrieved documents into readable context."""
    if not documents:
        return "No relevant player profiles found via semantic search."
    
    lines = [f"**Semantic Search Results ({len(documents)} players):**\n"]
    for i, doc in enumerate(documents, 1):
        score_info = ""
        if doc.rerank_score is not None:
            score_info = f" (relevance: {doc.rerank_score:.3f})"
        lines.append(f"{i}. {doc.text}{score_info}")
    
    return "\n".join(lines)


def search(
    query: str,
    top_k: int = 5,
    use_reranker: bool = True,
) -> dict[str, Any]:
    """
    Hybrid search: route, retrieve, answer.

    Every stage degrades independently, so the shape of the response is the same
    whether an LLM was involved or not. `mode` says which path produced the
    answer and `notes` lists every fallback that fired, so the client can label
    a degraded answer honestly instead of presenting it as a full one.
    """
    gathered = _gather(query, top_k, use_reranker)
    sql_result = gathered["sql_result"]
    documents = gathered["documents"]
    keyword_rows = gathered["keyword_rows"]

    answer, mode = _answer(
        query, gathered, lambda context: _synthesize(query, context)
    )

    return {
        "answer": answer,
        "route": gathered["route"].value,
        "sql_query": sql_result.get("sql"),
        "sql_results": sql_result.get("results", []),
        "sources": _sources(documents, keyword_rows),
        "mode": mode,
        "notes": gathered["notes"],
    }


def chat(
    query: str,
    history: list[dict[str, str]] | None = None,
    top_k: int = 5,
) -> dict[str, Any]:
    """
    Conversational search.

    History only reaches a language model; the deterministic analyst answers
    each question on its own. That is a real limitation of the no-LLM path
    rather than something worth papering over — follow-ups like "and cheaper?"
    will not resolve, so the answer is composed from the current question alone.
    """
    gathered = _gather(query, top_k, use_reranker=True)
    sql_result = gathered["sql_result"]
    documents = gathered["documents"]
    keyword_rows = gathered["keyword_rows"]

    answer, mode = _answer(
        query,
        gathered,
        lambda context: _synthesize_chat(query, context, history),
    )
    if mode == MODE_LOCAL and history:
        gathered["notes"].append(
            "Answered from this question alone — following the conversation "
            "needs a language model."
        )

    return {
        "answer": answer,
        "route": gathered["route"].value,
        "sources": _sources(documents, keyword_rows),
        "sql_query": sql_result.get("sql"),
        "mode": mode,
        "notes": gathered["notes"],
    }


def _answer(
    query: str,
    gathered: dict[str, Any],
    synthesise: Callable[[str], str],
) -> tuple[str, str]:
    """
    Produce the answer, preferring the LLM and falling back to the analyst.

    A configured key that fails at request time — expired, revoked, rate-limited,
    or simply wrong — is treated as an absent one rather than an error to show
    the user. The retrieval already succeeded, so there is a real answer to give;
    returning a stack trace instead would be a worse outcome than the rule-based
    prose. The failure is recorded in `notes` so the downgrade is still visible.
    """
    sql_result = gathered["sql_result"]
    documents = gathered["documents"]
    keyword_rows = gathered["keyword_rows"]

    if gathered["has_llm"]:
        try:
            context = _build_context(sql_result, documents, keyword_rows)
            return synthesise(context), MODE_LLM
        except LLMError as exc:
            logger.warning("LLM synthesis failed (%s); using the local analyst", exc)
            gathered["notes"].append(f"Language model unavailable ({exc}); answered by rule.")

    return (
        local_analyst.compose(query, sql_result, documents, keyword_rows),
        MODE_LOCAL,
    )


def _build_context(
    sql_result: dict[str, Any],
    documents: list[RetrievedDocument],
    keyword_rows: list[dict[str, Any]],
) -> str:
    """Assemble everything retrieved into one prompt context."""
    parts: list[str] = []
    if sql_result.get("results") or sql_result.get("error"):
        parts.append(_format_sql_context(sql_result))
    if documents:
        parts.append(_format_vector_context(documents))
    elif keyword_rows:
        names = ", ".join(r.get("player_name", "?") for r in keyword_rows)
        parts.append(f"**Keyword matches (vector store unavailable):** {names}")
    return "\n\n---\n\n".join(parts) if parts else "No data found for the query."


def _synthesize_chat(
    query: str,
    context: str,
    history: list[dict[str, str]] | None,
) -> str:
    """Synthesis with conversation history. Only reached when a key is present."""
    messages: list[dict[str, str]] = []
    if history:
        # Ten turns is the practical ceiling before the context window starts
        # crowding out the retrieved data, which matters more than old chat.
        for message in history[-10:]:
            messages.append({"role": message["role"], "content": message["content"]})

    messages.append(
        {
            "role": "user",
            "content": f"Based on the following player data:\n\n{context}\n\nUser question: {query}",
        }
    )

    try:
        return llm_provider.complete(
            SYSTEM_PROMPT, messages, task="rag", temperature=0.3, max_tokens=1500
        )
    except LLMError:
        raise  # handled by _answer, which falls back to the local analyst


def _synthesize(query: str, context: str) -> str:
    """
    Write the final answer from the retrieved context, via the active provider.

    Only reached when `llm_available()` is true, so an absent key is not handled
    here — `search` sends that case to the deterministic analyst instead. A
    provider that fails at request time still yields the retrieval, with the
    failure named first so the downgrade is never silent.
    """
    user_message = (
        f"Based on the following player data:\n\n{context}\n\n"
        f"User question: {query}\n\n"
        "Provide a clear, well-structured analysis answering the user's question. "
        "Use markdown formatting."
    )

    try:
        return llm_provider.complete(
            SYSTEM_PROMPT,
            [{"role": "user", "content": user_message}],
            task="rag",
            temperature=0.3,
            max_tokens=1500,
        )
    except LLMError:
        raise  # handled by _answer, which falls back to the local analyst
