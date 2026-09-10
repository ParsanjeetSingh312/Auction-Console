"""
text_to_sql.py
Converts natural language queries to valid SQLite SELECT statements
using whichever LLM provider is configured, then executes them safely.
"""
import logging
import re
from typing import Any

from db.sqlite_manager import SQLiteManager, validate_select_only
from rag import llm_provider

logger = logging.getLogger(__name__)


def _extract_sql(llm_response: str) -> str:
    """
    Extract a SQL query from the LLM response, handling markdown
    code blocks and other formatting.
    """
    # Try to extract from markdown code blocks
    sql_match = re.search(r"```(?:sql)?\s*\n?(.*?)\n?```", llm_response, re.DOTALL | re.IGNORECASE)
    if sql_match:
        return sql_match.group(1).strip()
    
    # Try to find a SELECT statement directly
    select_match = re.search(r"(SELECT\s+.+?)(?:;|$)", llm_response, re.DOTALL | re.IGNORECASE)
    if select_match:
        return select_match.group(1).strip() + ";"
    
    return llm_response.strip()


def _validate_sql(sql: str) -> tuple[bool, str]:
    """
    Validate that the generated SQL is a single read-only SELECT.

    Delegates to the shared tokenizing validator in sqlite_manager, which is
    also enforced independently at execution time. A plain substring scan is
    not usable here: it rejects legitimate queries such as
    `WHERE role = 'All-Rounder'`, whose hyphen looks like a SQL comment.
    """
    return validate_select_only(sql)


def generate_sql(query: str) -> str | None:
    """
    Convert a natural language query to a SQLite SELECT statement
    using whichever LLM provider is configured.
    
    Args:
        query: Natural language query about player stats.
    
    Returns:
        Generated SQL string, or None if generation fails.
    """
    if not llm_provider.available():
        # Not an error: the caller falls back to the deterministic parser in
        # rag/local_analyst.py, which needs no model at all.
        logger.info("No LLM configured for text-to-SQL; caller will use the deterministic parser")
        return None

    sqlite_mgr = SQLiteManager()
    schema = sqlite_mgr.get_table_schema()
    
    system_prompt = f"""You are an expert SQL query generator for a SQLite database containing IPL cricket player statistics.

Here is the database schema:
{schema}

CRITICAL — the data is split by role. Batting columns are populated ONLY for
Batter, Wicket Keeper and All-Rounder rows. Bowling columns are populated ONLY
for Bowler rows. Every other cell is NULL.

  Batting columns (Batter / Wicket Keeper / All-Rounder only):
    total_runs, bat_avg, bat_sr, boundary_pct_spin, boundary_pct_fast,
    sr_vs_spin, sr_vs_fast
  Bowling columns (Bowler only):
    wickets, runs_conceded, economy, bowl_avg, bowl_sr,
    econ_vs_lhb, econ_vs_rhb
  Always populated:
    player_name, country, role, cap_status, overseas, matches
  Often NULL (only for players in the Phase 1 auction pool):
    base_price, rating

Because of this split, ALWAYS add `IS NOT NULL` guards on the metrics you
filter or sort by, so NULL rows from the other role group cannot leak in.

IMPORTANT RULES:
1. Generate ONLY valid SQLite SELECT queries.
2. Use the exact column names from the schema.
3. The 'role' column values are: 'Batter', 'Bowler', 'All-Rounder', 'Wicket Keeper'
4. The 'cap_status' column values are: 'CAPPED', 'UNCAPPED'
5. The 'overseas' column is 0 (Indian) or 1 (overseas).
6. Always include player_name in the SELECT.
7. Use LIMIT to restrict results (default LIMIT 10 unless specified).
8. For "top N" queries, use ORDER BY ... DESC/ASC LIMIT N.
9. Boundary percentages (boundary_pct_spin, boundary_pct_fast) are stored as percentages (e.g., 18.5 means 18.5%).
10. There are no phase-wise strike rate columns (no powerplay/middle/death SR)
    and no highest-score column. If asked for those, approximate using bat_sr
    and the spin/pace splits instead of inventing columns.
11. Output ONLY the SQL query, nothing else. No explanations.

Example — "most economical bowlers":
SELECT player_name, country, matches, wickets, economy, bowl_avg FROM players
WHERE role = 'Bowler' AND economy IS NOT NULL ORDER BY economy ASC LIMIT 10;
"""
    
    try:
        raw_sql = llm_provider.complete(
            system_prompt,
            [{"role": "user", "content": f"Convert this to SQL: {query}"}],
            task="sql",
            temperature=0.0,
            max_tokens=300,
            timeout=30.0,
        )
        sql = _extract_sql(raw_sql)

        is_safe, reason = _validate_sql(sql)
        if not is_safe:
            logger.warning("Generated SQL failed validation (%s): %s", reason, sql)
            return None

        logger.info("Generated SQL: %s", sql)
        return sql
        
    except Exception as e:
        logger.error("Text-to-SQL generation failed: %s", e)
        return None


def execute_sql_query(query: str) -> dict[str, Any]:
    """
    End-to-end: convert natural language to SQL, execute, and return results.
    
    Args:
        query: Natural language query.
    
    Returns:
        Dict with 'sql' (the generated query), 'results' (list of row dicts),
        and 'error' (None or error message).
    """
    sql = generate_sql(query)
    
    if sql is None:
        return {
            "sql": None,
            "results": [],
            "error": "Failed to generate SQL from the query."
        }
    
    try:
        sqlite_mgr = SQLiteManager()
        results = sqlite_mgr.execute_query(sql)
        return {
            "sql": sql,
            "results": results,
            "error": None,
        }
    except Exception as e:
        logger.error("SQL execution failed: %s (SQL: %s)", e, sql)
        return {
            "sql": sql,
            "results": [],
            "error": f"SQL execution error: {str(e)}"
        }
