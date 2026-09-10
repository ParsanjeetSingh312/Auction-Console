"""
query_router.py
Classifies incoming user queries into execution paths:
- METRIC_SQL: Pure statistical/numerical queries -> SQLite
- SEMANTIC_VECTOR: Qualitative/descriptive queries -> ChromaDB
- HYBRID: Mixed queries -> Both engines
"""
import logging
import re
from enum import Enum

from rag import llm_provider

logger = logging.getLogger(__name__)


class QueryRoute(str, Enum):
    METRIC_SQL = "METRIC_SQL"
    SEMANTIC_VECTOR = "SEMANTIC_VECTOR"
    HYBRID = "HYBRID"


# Keywords that strongly indicate SQL-type queries
SQL_INDICATORS = [
    r"\b(greater|less|more|fewer|above|below|over|under|between|equal|exactly)\b",
    r"[><=!]+",
    r"\b(top|bottom|highest|lowest|max|min|rank|sort)\b",
    r"\b(average|avg|count|sum|total)\b",
    r"\b(sr|strike rate|bat avg|batting average|econ|economy|matches|runs)\s*(>|<|=|above|below|over|under)",
]

# Keywords that strongly indicate semantic/vector queries
SEMANTIC_INDICATORS = [
    r"\b(like|similar|type|style|kind|profile)\b",
    r"\b(aggressive|defensive|consistent|reliable|explosive|anchor|finisher|powerplay|death)\b",
    r"\b(against spin|against pace|spin basher|pace hitter|dominant)\b",
    r"\b(best|ideal|perfect|suited|good for|recommend)\b",
    r"\b(describe|explain|tell me about|who is|what makes)\b",
]


def _heuristic_route(query: str) -> QueryRoute:
    """Fallback keyword-based routing when LLM is unavailable."""
    query_lower = query.lower()
    
    sql_score = sum(1 for pattern in SQL_INDICATORS if re.search(pattern, query_lower))
    semantic_score = sum(1 for pattern in SEMANTIC_INDICATORS if re.search(pattern, query_lower))
    
    if sql_score > 0 and semantic_score > 0:
        return QueryRoute.HYBRID
    elif sql_score > semantic_score:
        return QueryRoute.METRIC_SQL
    elif semantic_score > sql_score:
        return QueryRoute.SEMANTIC_VECTOR
    else:
        return QueryRoute.HYBRID  # Default to hybrid for ambiguous queries


def route_query(query: str) -> QueryRoute:
    """
    Classify a user query into one of three execution paths.
    Uses the configured LLM for classification, with keyword
    heuristics as fallback.
    
    Args:
        query: The user's natural language query.
    
    Returns:
        QueryRoute enum value.
    """
    if not llm_provider.available():
        logger.warning("No LLM configured, using heuristic routing")
        return _heuristic_route(query)

    try:
        system_prompt = """You are a query classifier for an IPL cricket player database.
Classify the user's query into exactly ONE of these categories:

1. METRIC_SQL - The query asks for specific numerical comparisons, filters, rankings, or statistical lookups.
   Examples: "players with strike rate above 150", "top 5 run scorers", "batsmen with avg > 35 and SR > 140"

2. SEMANTIC_VECTOR - The query describes a player profile, playing style, or qualitative attributes.
   Examples: "aggressive powerplay batsman against spin", "reliable anchor player", "who plays like AB de Villiers"

3. HYBRID - The query combines both numerical criteria AND qualitative/style descriptions.
   Examples: "aggressive batsmen with SR > 145", "consistent all-rounder with batting average above 30"

Respond with ONLY the category name: METRIC_SQL, SEMANTIC_VECTOR, or HYBRID"""

        result = llm_provider.complete(
            system_prompt,
            [{"role": "user", "content": query}],
            task="router",
            temperature=0.0,
            # One word of output. Generous enough for a stray newline, tight
            # enough that a runaway response cannot cost anything.
            max_tokens=24,
            timeout=20.0,
        ).strip().upper()

        # Parse the response
        if "METRIC_SQL" in result:
            route = QueryRoute.METRIC_SQL
        elif "SEMANTIC_VECTOR" in result:
            route = QueryRoute.SEMANTIC_VECTOR
        elif "HYBRID" in result:
            route = QueryRoute.HYBRID
        else:
            logger.warning("LLM returned unexpected route '%s', falling back to heuristic", result)
            route = _heuristic_route(query)

        logger.info("Query routed to %s: '%s'", route.value, query[:80])
        return route

    except Exception as e:
        logger.warning("LLM routing failed (%s), using heuristic fallback", e)
        return _heuristic_route(query)
