"""
rag_chain.py
Final RAG synthesis chain. Merges SQL results, vector-retrieved context,
and user query into a structured prompt, then generates the final
analytical response using whichever LLM provider is configured.
"""
import asyncio
import concurrent.futures
import logging
import re
from datetime import datetime
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

    # --- live web stage ---
    # Only worth its seconds when a model will read it: the rule-based analyst
    # composes from the table and has no use for prose.
    web_text = None
    if has_llm:
        web_text, web_notes = live_research(query)
        notes.extend(web_notes)

    return {
        "route": route,
        "sql_result": sql_result,
        "documents": documents,
        "keyword_rows": keyword_rows,
        "web": web_text,
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


def system_prompt() -> str:
    """
    SYSTEM_PROMPT plus what the model cannot know on its own: today's date and
    how current the figures in front of it are.

    Built per request because both change. Without it the model fell back on
    its training data and quoted career totals from a season or two ago --
    confidently, and in disagreement with the table it had just been handed.
    """
    from scout.stats_refresh import load_status

    status = load_status()
    season = status.get("season_through")
    refreshed = status.get("refreshed_at")
    lines = [
        "",
        "DATA FRESHNESS:",
        f"- Today is {datetime.now():%d %B %Y}.",
    ]
    if season:
        when = ""
        if refreshed:
            try:
                when = f", recomputed on {datetime.fromisoformat(refreshed):%d %B %Y}"
            except ValueError:
                when = ""
        lines.append(
            f"- Matches, runs, wickets, strike rates, economies and the spin/pace "
            f"and left/right-hand splits in the data context are complete IPL "
            f"career figures through the IPL {season} season{when}."
        )
    lines += [
        "- The data context and the live web research are more current than "
        "your own memory. Where they disagree with what you remember, they win. "
        "Never quote a career total, season figure or squad from memory.",
        "- When LIVE WEB RESEARCH is present it comes from ESPNcricinfo, Cricbuzz "
        "and other reference sites; use it for form, injuries, availability and "
        "anything after the last completed season, and name the source.",
    ]
    return SYSTEM_PROMPT + "\n".join(lines) + "\n"


#: Words that mean a question is about the present rather than the table.
_RECENCY = re.compile(
    r"\b(form|injur\w*|news|latest|recent\w*|current\w*|now|today|this season|"
    r"last season|20\d\d|fit|fitness|availab\w*|retain\w*|released|trade\w*|"
    r"captain\w*|squad|sold|bought|price)\b",
    re.I,
)


def _mentions_player(query: str) -> bool:
    lowered = query.lower()
    for name in local_analyst.known_player_names():
        parts = name.lower().split()
        if name.lower() in lowered or (len(parts) > 1 and len(parts[-1]) >= 5
                                       and re.search(rf"\b{re.escape(parts[-1])}\b", lowered)):
            return True
    return False


def live_research(query: str) -> tuple[str | None, list[str]]:
    """
    Live web context for a question, from the same researcher the SCOUT drawer uses.

    Only for questions about the present or about a named player -- "top five
    economies" is answered by the table and needs no search. Runs its own event
    loop on a worker thread, so it is safe from both a request thread and a
    coroutine, and is bounded by SCOUT_LIVE_CONTEXT_TIMEOUT either way.
    """
    from config.settings import get_settings
    from scout.agents.live_context import gather
    from scout.tools.search_engine import search_available

    if not search_available():
        return None, []
    if not (_RECENCY.search(query) or _mentions_player(query)):
        return None, []

    timeout = get_settings().SCOUT_LIVE_CONTEXT_TIMEOUT

    def _run():
        return asyncio.run(asyncio.wait_for(gather(query, timeout=timeout), timeout=timeout + 1))

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            found = pool.submit(_run).result(timeout=timeout + 3)
    except Exception as exc:  # noqa: BLE001 - the table still answers
        logger.warning("Live research failed: %s", exc)
        return None, [f"Live web research did not finish ({type(exc).__name__}); answered from the data."]
    return found.text, found.notes


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
            context = _build_context(sql_result, documents, keyword_rows, gathered.get("web"))
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
    web: str | None = None,
) -> str:
    """Assemble everything retrieved into one prompt context."""
    parts: list[str] = []
    if web:
        parts.append(f"**LIVE WEB RESEARCH (ESPNcricinfo, Cricbuzz and reference sites):**\n{web}")
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
            system_prompt(), messages, task="rag", temperature=0.3, max_tokens=1500
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
            system_prompt(),
            [{"role": "user", "content": user_message}],
            task="rag",
            temperature=0.3,
            max_tokens=1500,
        )
    except LLMError:
        raise  # handled by _answer, which falls back to the local analyst
