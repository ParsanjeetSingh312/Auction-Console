"""
store.py
AUCTEAM's own SQLite state: the curated tiers and the saved reports.

Opened directly with sqlite3 rather than through db.get_player_db(), because
that factory's managers are deliberately SELECT-only for the players table, and
these two tables are AUCTEAM's, not the players table's. They always live in
the local file -- see the note in aucteam_schema.py.

Every function opens and closes its own connection. AUCTEAM writes perhaps one
row a minute; a pool would be machinery without a load to justify it.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from config.settings import get_settings

from aucteam.aucteam_schema import SCHEMA_STATEMENTS, TierCode
from aucteam.tiers import CURATED_TIERS, name_key

logger = logging.getLogger(__name__)

_ready_for: str | None = None


def _db_path() -> str:
    return get_settings().SQLITE_DB_PATH


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    path = _db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def ensure_schema() -> None:
    """
    Create both tables and seed the curated tiers. Idempotent and cheap after
    the first call per database path.

    The seed is INSERT OR IGNORE, so an operator who has edited a tier in the
    table keeps their edit across restarts: the code supplies defaults, the
    table holds decisions.
    """
    global _ready_for
    path = _db_path()
    if _ready_for == path:
        return
    with _connect() as conn:
        for statement in SCHEMA_STATEMENTS:
            conn.execute(statement)
        conn.executemany(
            "INSERT OR IGNORE INTO aucteam_tier_overrides (name_key, player_name, tier, reason) "
            "VALUES (?, ?, ?, ?)",
            [(name_key(name), name, tier, reason) for name, tier, reason in CURATED_TIERS],
        )
    _ready_for = path


def load_overrides() -> dict[str, tuple[TierCode, str]]:
    """name_key -> (tier, reason). Empty, never raising, if the table is unreadable."""
    try:
        ensure_schema()
        with _connect() as conn:
            rows = conn.execute(
                "SELECT name_key, tier, reason FROM aucteam_tier_overrides"
            ).fetchall()
    except sqlite3.Error as exc:
        # Tiers fall back to derivation for everyone. Worse, but a working pool.
        logger.error("AUCTEAM: could not read tier overrides (%s); deriving all tiers", exc)
        return {}
    return {row["name_key"]: (row["tier"], row["reason"] or "Curated") for row in rows}


def save_report(
    team_name: str | None,
    roster: list[dict[str, Any]],
    metrics: dict[str, Any],
    report: dict[str, Any],
    mode: str,
) -> int | None:
    """Persist one report. Returns its id, or None if the write failed."""
    try:
        ensure_schema()
        with _connect() as conn:
            cursor = conn.execute(
                "INSERT INTO aucteam_reports (team_name, roster_json, metrics_json, report_json, mode) "
                "VALUES (?, ?, ?, ?, ?)",
                (team_name, json.dumps(roster), json.dumps(metrics), json.dumps(report), mode),
            )
            return int(cursor.lastrowid)
    except sqlite3.Error as exc:
        # The user still gets their report; only the archive copy is lost.
        logger.error("AUCTEAM: could not save report (%s)", exc)
        return None


def load_report(report_id: int) -> dict[str, Any] | None:
    ensure_schema()
    with _connect() as conn:
        row = conn.execute(
            "SELECT report_json FROM aucteam_reports WHERE id = ?", (report_id,)
        ).fetchone()
    return json.loads(row["report_json"]) if row else None
