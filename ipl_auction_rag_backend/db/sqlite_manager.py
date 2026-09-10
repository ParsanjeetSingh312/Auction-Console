"""
sqlite_manager.py
SQLite database manager for the IPL Auction RAG search engine.
Handles schema creation, bulk inserts, and parameterized query execution.

The schema includes ALL planned attributes (17+ columns). Columns not
present in the current Excel dataset are stored as nullable and can be
populated when enriched data becomes available.
"""
import logging
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pandas as pd

from config.settings import get_settings

logger = logging.getLogger(__name__)

# Full schema: columns from actual Excel + planned columns (nullable)
CREATE_PLAYERS_TABLE = """
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Core Identity
    player_name TEXT NOT NULL,
    country TEXT DEFAULT 'Unknown',
    role TEXT NOT NULL,
    cap_status TEXT NOT NULL DEFAULT 'CAPPED',
    overseas INTEGER NOT NULL DEFAULT 0,
    base_price REAL,
    rating REAL,
    
    -- Match Stats
    matches INTEGER,
    total_runs INTEGER,
    
    -- Batting Stats (batting-semantics rows: Batter/Wicket Keeper/All-Rounder)
    bat_avg REAL,
    bat_sr REAL,
    boundary_pct_spin REAL,
    boundary_pct_fast REAL,
    sr_vs_spin REAL,
    sr_vs_fast REAL,

    -- Bowling Stats (bowling-semantics rows: Bowler)
    wickets INTEGER,
    runs_conceded INTEGER,
    economy REAL,
    bowl_avg REAL,
    bowl_sr REAL,
    econ_vs_lhb REAL,
    econ_vs_rhb REAL
);
"""

CREATE_INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_players_role ON players(role);",
    "CREATE INDEX IF NOT EXISTS idx_players_cap_status ON players(cap_status);",
    "CREATE INDEX IF NOT EXISTS idx_players_overseas ON players(overseas);",
    "CREATE INDEX IF NOT EXISTS idx_players_name ON players(player_name);",
]


# Statement types that must never appear in LLM-generated SQL.
_FORBIDDEN_KEYWORDS: set[str] = {
    "DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "TRUNCATE",
    "REPLACE", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "EXEC",
}

# Identifiers and quoted strings, so keyword checks skip string literals.
_TOKEN_RE = re.compile(r"'[^']*'|\"[^\"]*\"|\b[A-Za-z_][A-Za-z_0-9]*\b|;|--|/\*")


def validate_select_only(sql: str) -> tuple[bool, str]:
    """
    Validate that `sql` is a single read-only SELECT statement.

    Tokenizes rather than substring-matching, so a keyword inside a string
    literal or column name does not trigger a false rejection, while genuine
    statement chaining and comment-based injection are caught.

    Returns:
        (True, "") when safe, else (False, reason).
    """
    stripped = sql.strip()
    if not stripped:
        return False, "Empty SQL statement."

    # A single trailing semicolon is fine; anything after it is a second
    # statement and is rejected.
    body = stripped.rstrip().removesuffix(";")

    for match in _TOKEN_RE.finditer(body):
        token = match.group(0)
        if token.startswith(("'", '"')):
            continue  # string literal or quoted identifier
        if token in (";", "--", "/*"):
            label = "statement chaining" if token == ";" else "SQL comment"
            return False, f"Rejected: {label} is not allowed in generated SQL."
        if token.upper() in _FORBIDDEN_KEYWORDS:
            return False, f"Rejected: non-SELECT keyword '{token.upper()}' detected."

    if not body.upper().startswith(("SELECT", "WITH")):
        return False, "Only SELECT queries are allowed."

    return True, ""


class SQLiteManager:
    """Manages the SQLite database for player statistics."""
    
    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or get_settings().SQLITE_DB_PATH
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
    
    @contextmanager
    def _get_connection(self) -> Iterator[sqlite3.Connection]:
        """
        Yield a connection that is committed on success, rolled back on error,
        and always closed.

        `with sqlite3.connect(...)` alone only manages the transaction — it does
        not close the handle — so this wraps it to avoid leaking one connection
        per call across the request lifetime.
        """
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    
    def create_tables(self) -> None:
        """Create the players table and indexes if they don't exist."""
        with self._get_connection() as conn:
            conn.execute(CREATE_PLAYERS_TABLE)
            for idx_sql in CREATE_INDEX_STATEMENTS:
                conn.execute(idx_sql)
        logger.info("SQLite tables and indexes created at %s", self.db_path)

    def drop_tables(self) -> None:
        """Drop the players table (used during re-ingestion)."""
        with self._get_connection() as conn:
            conn.execute("DROP TABLE IF EXISTS players;")
        logger.info("SQLite players table dropped")
    
    def insert_players(self, df: pd.DataFrame) -> int:
        """
        Bulk insert player records from a DataFrame.
        
        Args:
            df: DataFrame with columns matching the players table schema.
        
        Returns:
            Number of rows inserted.
        """
        columns = df.columns.tolist()
        placeholders = ", ".join(["?"] * len(columns))
        col_names = ", ".join(columns)
        sql = f"INSERT INTO players ({col_names}) VALUES ({placeholders})"

        # Build rows via itertuples rather than df.values.tolist(): the latter
        # casts a mixed-dtype frame to a single object dtype, which turns None
        # into float nan. sqlite3 has no nan binding, so those land as junk
        # floats in INTEGER columns instead of NULL.
        rows = [
            tuple(None if pd.isna(value) else value for value in record)
            for record in df.itertuples(index=False, name=None)
        ]

        with self._get_connection() as conn:
            conn.executemany(sql, rows)

        count = len(rows)
        logger.info("Inserted %d players into SQLite", count)
        return count
    
    def execute_query(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """
        Execute a SELECT query and return results as a list of dicts.
        
        Args:
            sql: SQL query string (must be a SELECT statement).
            params: Query parameters for safe parameterization.
        
        Returns:
            List of dictionaries, one per row.
        
        Raises:
            ValueError: If the SQL is not a SELECT statement.
        """
        is_safe, reason = validate_select_only(sql)
        if not is_safe:
            raise ValueError(reason)

        with self._get_connection() as conn:
            # Reject multi-statement input at the driver level: execute() raises
            # on a second statement, closing off "SELECT 1; DROP TABLE players".
            cursor = conn.execute(sql, params)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
    
    def get_table_schema(self) -> str:
        """
        Return the CREATE TABLE statement for the players table.
        Used by the Text-to-SQL module to provide schema context to the LLM.
        """
        return CREATE_PLAYERS_TABLE.strip()
    
    def get_player_count(self) -> int:
        """Return the number of players in the database."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM players;")
            return cursor.fetchone()[0]
    
    def get_all_players(self, limit: int = 500, offset: int = 0) -> list[dict[str, Any]]:
        """Return all players with pagination."""
        return self.execute_query(
            "SELECT * FROM players LIMIT ? OFFSET ?",
            (limit, offset)
        )
