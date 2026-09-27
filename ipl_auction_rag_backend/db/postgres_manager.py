"""
postgres_manager.py
The Supabase/PostgreSQL backend for the players table.

A DROP-IN replacement for SQLiteManager: same method names, same signatures,
same return shapes (list[dict], one dict per row). That is the whole design
constraint, and it is what keeps the change at each of the eight call sites down
to which class they ask for.

WHY THIS IS AN ADAPTER AND NOT A REWRITE
========================================

The obvious plan -- write Postgres queries and update the callers -- does not
survive contact with this codebase. The SQL is not in one place. It is built,
piece by piece, in rag/local_analyst.py, scout/tools/search_engine.py and
api/routes.py, all of it using SQLite's `?` placeholder:

    where.append("role = ?")                       local_analyst.py:355
    where.append(f'"{column}" IS NOT NULL ... ?')  search_engine.py:134
    "SELECT * FROM players ... LIMIT ? OFFSET ?"   routes.py:135

psycopg wants `%s`. Porting those call sites would mean rewriting three
query builders, and -- worse -- would BREAK SQLite, because SQLite does not
accept `%s`. There would no longer be a local development database.

So the translation happens here instead, in `to_pg_placeholders`. Callers keep
writing `?` against both backends, and the only thing that changes is which
manager they hold.

THE `%` HAZARD THIS ALSO FIXES
==============================

psycopg does client-side `%`-interpolation whenever parameters are passed, so a
literal percent sign in the SQL has to be doubled or binding fails. That would
be an ugly trap for LLM-generated SQL out of rag/text_to_sql.py, which is free
to emit `LIKE '%kohli%'`. The translator doubles literal `%` as it goes, so
neither the callers nor the LLM have to know.

NOT ASYNC, DELIBERATELY
=======================

psycopg 3 offers both APIs. This uses the synchronous one because SQLiteManager
is synchronous and every one of the eight call sites calls it synchronously --
several from inside `async def` handlers. Switching to the async API would mean
making all of them awaitable, which is a far larger change than this phase.

The consequence is real and worth stating plainly: a synchronous query inside an
async handler blocks the event loop for its duration. Against a local SQLite
file that is about a millisecond. Against Supabase across the network it is tens
of milliseconds, on the same loop that runs the auction's seven-second bid
timers. The connection pool below is what keeps that number at "one query" rather
than "one query plus a TCP and TLS handshake". If it ever measurably hurts the
auction clock, the fix is to wrap the call sites in `asyncio.to_thread` -- which
api/main.py already does for model warming -- and not to rewrite this file.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pandas as pd

from config.settings import get_settings

# The SQL safety validator is IMPORTED, never reimplemented. It is the control
# that stops LLM-generated SQL from doing anything but SELECT, it is covered by
# tests/test_sql_safety.py, and a second copy here would be a second thing to
# keep correct -- with the copy guarding the production database and the tested
# original guarding the development one.
from db.sqlite_manager import validate_select_only

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Dialect translation
# ---------------------------------------------------------------------------

def to_pg_placeholders(sql: str) -> str:
    """
    Rewrite SQLite-flavoured SQL into what psycopg expects.

    Two substitutions, both only where they are safe:

        ?   ->  %s      parameter placeholders
        %   ->  %%      literal percent signs, which psycopg would otherwise
                        read as the start of its own placeholder

    Scans character by character rather than using a regex with a replace,
    because both substitutions are wrong inside a string literal -- `WHERE
    player_name = 'Who?'` must keep its question mark, and `LIKE '%kohli%'`
    must keep percent signs that psycopg can still parse. So literals are
    copied through with only the `%` doubling applied, and `?` inside them is
    left alone.

    Single-quoted literals honour SQL's doubled-quote escape (`'it''s'`), which
    is the form both SQLite and Postgres use.

    >>> to_pg_placeholders("SELECT * FROM players WHERE role = ? LIMIT ?")
    'SELECT * FROM players WHERE role = %s LIMIT %s'
    >>> to_pg_placeholders("SELECT * FROM players WHERE player_name LIKE '%li%'")
    "SELECT * FROM players WHERE player_name LIKE '%%li%%'"
    >>> to_pg_placeholders("SELECT 'Who?' AS q WHERE role = ?")
    "SELECT 'Who?' AS q WHERE role = %s"
    """
    out: list[str] = []
    i = 0
    n = len(sql)

    while i < n:
        char = sql[i]

        # --- single-quoted string literal ---------------------------------
        if char == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    # '' is an escaped quote, not the end of the literal.
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            # j is the closing quote, or n if the literal is unterminated --
            # which is malformed SQL that the server should reject, not
            # something to repair here.
            out.append(sql[i : j + 1].replace("%", "%%"))
            i = j + 1
            continue

        # --- double-quoted identifier -------------------------------------
        # search_engine.py quotes column names this way. Contents are an
        # identifier, so no ? substitution, but % still needs doubling.
        if char == '"':
            j = sql.find('"', i + 1)
            if j == -1:
                out.append(sql[i:].replace("%", "%%"))
                break
            out.append(sql[i : j + 1].replace("%", "%%"))
            i = j + 1
            continue

        if char == "?":
            out.append("%s")
        elif char == "%":
            out.append("%%")
        else:
            out.append(char)
        i += 1

    return "".join(out)


# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------
#
# One pool per process, created on first use and never at import time. Import
# time is wrong for two reasons: `import db.postgres_manager` happens during
# module loading, where a network timeout would look like a hung import; and the
# factory in db/__init__.py imports this module to decide whether it CAN use
# Postgres, which must not itself require a working database.

_pool: Any = None
_pool_lock = threading.Lock()


def _get_pool() -> Any:
    """
    The process-wide connection pool, opened on first call.

    Opened with wait=True so that a bad DATABASE_URL, a paused Supabase project
    or a firewall surfaces HERE, once, with a clear message -- rather than as a
    confusing failure on whichever query happens to run first.
    """
    global _pool
    if _pool is not None:
        return _pool

    with _pool_lock:
        # Re-checked inside the lock: two threads can both pass the check above.
        if _pool is not None:
            return _pool

        # Imported inside the function, not at module scope, so that this module
        # can be imported on a machine with no psycopg installed -- which is
        # every developer machine until DATABASE_URL is set.
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        settings = get_settings()
        problem = settings.database_url_problem
        if problem:
            raise RuntimeError(f"DATABASE_URL {problem}")

        pool = ConnectionPool(
            conninfo=settings.DATABASE_URL.strip(),
            min_size=settings.DB_POOL_MIN_SIZE,
            max_size=settings.DB_POOL_MAX_SIZE,
            # dict_row is what makes this a drop-in replacement: SQLiteManager
            # sets sqlite3.Row and returns dict(row), so callers index rows by
            # column name. The psycopg default returns tuples, which would break
            # every one of them.
            kwargs={"row_factory": dict_row},
            open=False,
            name="auctoniq-players",
        )
        pool.open(wait=True, timeout=20.0)
        logger.info(
            "Postgres pool open (min=%d max=%d) against %s",
            settings.DB_POOL_MIN_SIZE,
            settings.DB_POOL_MAX_SIZE,
            settings.safe_database_target,
        )
        _pool = pool
        return _pool


def close_pool() -> None:
    """
    Close the pool on shutdown. Safe to call when it was never opened.

    Called from api/main.py's lifespan for the same reason scout_aclose() is:
    connections left open hold threads, and a process that never releases them
    finishes serving and then sits there looking hung.
    """
    global _pool
    with _pool_lock:
        if _pool is None:
            return
        try:
            _pool.close()
            logger.info("Postgres pool closed")
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            logger.warning("Could not close the Postgres pool: %s", exc)
        finally:
            _pool = None


def pool_is_open() -> bool:
    """Whether a pool has been created. Used by health reporting, not by queries."""
    return _pool is not None


# ---------------------------------------------------------------------------
# The manager
# ---------------------------------------------------------------------------

#: Where the Postgres schema lives. The migration file is the single source of
#: truth for the production table -- it is already written, already idempotent,
#: and already documents the three load-bearing SQLite-to-Postgres type
#: decisions. Reading it beats keeping a second copy of the DDL in this file.
MIGRATION_PATH = Path(__file__).resolve().parent / "migrations" / "001_players.sql"


class PostgresManager:
    """
    Manages the players table in Supabase.

    Mirrors SQLiteManager method for method. Where behaviour differs, the
    difference is documented on the method rather than left for a caller to
    discover at runtime.
    """

    def __init__(self, dsn: str | None = None):
        # Stored but not connected to. The pool is process-wide and lazy, so
        # constructing a manager is free -- which matters, because the call
        # sites construct one per call (`SQLiteManager().get_all_players(...)`)
        # and that pattern carries over unchanged.
        self.dsn = dsn or get_settings().DATABASE_URL.strip()

    @contextmanager
    def _get_connection(self) -> Iterator[Any]:
        """
        Yield a pooled connection, committed on success and rolled back on error.

        Same contract as SQLiteManager._get_connection, with one difference that
        matters: the connection is RETURNED to the pool rather than closed.
        psycopg's own context manager already commits or rolls back on exit; the
        explicit calls here are kept so the control flow reads identically to the
        SQLite version.
        """
        pool = _get_pool()
        with pool.connection() as conn:
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    # --- schema ----------------------------------------------------------

    def create_tables(self) -> None:
        """
        Apply db/migrations/001_players.sql.

        The migration is idempotent by design (CREATE TABLE IF NOT EXISTS, plus
        ADD COLUMN IF NOT EXISTS for jersey_number), so this is safe to call on
        every startup and safe to call against a table that already holds data.
        """
        if not MIGRATION_PATH.is_file():
            raise FileNotFoundError(
                f"Migration not found at {MIGRATION_PATH}. It defines the "
                "players table and cannot be skipped."
            )

        sql = MIGRATION_PATH.read_text(encoding="utf-8")
        with self._get_connection() as conn:
            # No parameters, so psycopg sends this as a single simple query and
            # the file's multiple statements all run. Passing params here would
            # force the extended protocol, which permits only one statement.
            conn.execute(sql)
        logger.info("Postgres players table ensured from %s", MIGRATION_PATH.name)

    def drop_tables(self) -> None:
        """Drop the players table (used during re-ingestion)."""
        with self._get_connection() as conn:
            conn.execute("DROP TABLE IF EXISTS players;")
        logger.info("Postgres players table dropped")

    def get_table_schema(self) -> str:
        """
        The CREATE TABLE statement, for the Text-to-SQL prompt.

        Returns the POSTGRES DDL, not SQLite's. This is not cosmetic: this string
        is what rag/text_to_sql.py shows the LLM as the schema it is writing
        against. Given SQLite's DDL it would reasonably emit SQLite-flavoured
        SQL, and the first thing to break would be a function name Postgres does
        not have.

        Comments are stripped -- the migration file's are written for a human
        reading a diff, and they would be tokens spent teaching the model about
        type-translation decisions it has no use for.
        """
        if not MIGRATION_PATH.is_file():
            return ""

        lines: list[str] = []
        in_create = False
        for raw in MIGRATION_PATH.read_text(encoding="utf-8").splitlines():
            line = raw.split("--", 1)[0].rstrip()
            if not line.strip():
                continue
            if line.upper().startswith("CREATE TABLE"):
                in_create = True
            if in_create:
                lines.append(line)
                if line.rstrip().endswith(");"):
                    break
        return "\n".join(lines).strip()

    # --- writes ----------------------------------------------------------

    def insert_players(self, df: pd.DataFrame) -> int:
        """
        Bulk insert player records from a DataFrame.

        Identical contract to SQLiteManager.insert_players, including the
        itertuples-with-pd.isna row build. That detail is not stylistic: casting
        a mixed-dtype frame with df.values.tolist() turns None into float nan,
        and nan lands in an INTEGER column as junk instead of NULL. Postgres is
        stricter than SQLite here and would reject it outright, so the careful
        version is load-bearing on this backend rather than merely correct.
        """
        columns = df.columns.tolist()
        placeholders = ", ".join(["%s"] * len(columns))
        col_names = ", ".join(f'"{c}"' for c in columns)
        sql = f"INSERT INTO players ({col_names}) VALUES ({placeholders})"

        rows = [
            tuple(None if pd.isna(value) else value for value in record)
            for record in df.itertuples(index=False, name=None)
        ]

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(sql, rows)

        count = len(rows)
        logger.info("Inserted %d players into Postgres", count)
        return count

    # --- reads -----------------------------------------------------------

    def execute_query(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """
        Execute a SELECT and return a list of dicts, one per row.

        Accepts SQLite-flavoured SQL with `?` placeholders and translates it --
        see to_pg_placeholders and the module docstring. The safety validator
        runs BEFORE translation, against the caller's original text, so that the
        thing checked is the thing the caller wrote.

        Raises:
            ValueError: if the SQL is not a single read-only SELECT.
        """
        is_safe, reason = validate_select_only(sql)
        if not is_safe:
            raise ValueError(reason)

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                if params:
                    cur.execute(to_pg_placeholders(sql), params)
                else:
                    # No parameters means no %-interpolation, so the SQL is sent
                    # untouched. Translating anyway would double every literal
                    # percent sign for no reason and change the query's meaning.
                    cur.execute(sql)
                return [dict(row) for row in cur.fetchall()]

    def get_player_count(self) -> int:
        """Return the number of players in the database."""
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM players;")
                row = cur.fetchone()
                return int(row["n"]) if row else 0

    def get_all_players(self, limit: int = 500, offset: int = 0) -> list[dict[str, Any]]:
        """
        Return all players with pagination.

        ORDER BY id is added, which SQLiteManager's version omits. Without it
        Postgres gives no ordering guarantee at all, so LIMIT/OFFSET paging
        could repeat or skip rows between calls. SQLite happens to return rowid
        order in practice, which is why the omission was never visible there.
        """
        return self.execute_query(
            "SELECT * FROM players ORDER BY id LIMIT ? OFFSET ?",
            (limit, offset),
        )

    def update_player_column(
        self,
        player_id: int,
        column: str,
        value: Any,
        *,
        fill_only: bool = False,
    ) -> int:
        """
        Set one column on one player. Returns the number of rows changed.

        Mirrors SQLiteManager.update_player_column exactly, including the
        isidentifier() guard and the fill_only semantics. See that method for why
        this exists rather than going through execute_query.

        Written with %s directly rather than through to_pg_placeholders: this SQL
        is built here, not handed in by a caller, so there is no SQLite dialect
        to translate.
        """
        if not column.isidentifier():
            raise ValueError(f"Not a valid column name: {column!r}")

        clause = f' AND "{column}" IS NULL' if fill_only else ""
        sql = f'UPDATE players SET "{column}" = %s WHERE id = %s{clause}'
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (value, player_id))
                return cur.rowcount
