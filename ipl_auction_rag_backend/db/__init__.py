"""
DB module.

Holds the two interchangeable backends for the players table and the factory
that picks between them.

WHICH DATABASE, AND WHO DECIDES
===============================

`get_player_db()` is the only place in the codebase that answers that question.
Call sites ask it for a manager instead of naming SQLiteManager directly, so
moving between backends is a configuration change rather than a code change, and
there is no way for two modules to end up talking to different databases in the
same request.

The rule is one line: DATABASE_URL set means Supabase, unset means the local
SQLite file. Unset is the default and the state of every developer machine, so
nothing about local behaviour changes until someone deliberately sets it.

WHAT THIS DOES *NOT* SWITCH
===========================

SQLite is not going away. It still backs:

  * Chroma's vector store, under CHROMA_DB_PATH
  * SCOUT's langgraph checkpointer, under SCOUT_CHECKPOINT_PATH
  * the read-only inspection queries in config/env_check.py and
    api/routes_scout.py, which open the file directly

None of those is a players-table concern, and Supabase replaces none of them.
"Postgres" here means the players table and nothing else.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Union

from config.settings import get_settings

if TYPE_CHECKING:  # pragma: no cover - import cycle at runtime, fine for typing
    from db.postgres_manager import PostgresManager
    from db.sqlite_manager import SQLiteManager

    PlayerDB = Union[SQLiteManager, PostgresManager]

logger = logging.getLogger(__name__)

#: Logged once, on the first call, rather than on every one. The call sites
#: construct a manager per call, so without this the choice would be announced
#: hundreds of times during a single auction.
_announced = False


def get_player_db():  # noqa: ANN201 - the union is only meaningful to a type checker
    """
    Return a manager for the players table: Postgres when configured, else SQLite.

    Both classes expose the same methods with the same signatures and the same
    return shapes, so a caller never needs to know which one it received. See
    db/postgres_manager.py for how `?` placeholders keep working against both.

    Postgres failures fall back to SQLite deliberately. If DATABASE_URL is set
    but the pool cannot open -- a paused Supabase project, a rotated password, a
    network partition -- this returns SQLiteManager and logs the reason loudly.
    That is the same rule the rest of this codebase follows: a broken dependency
    costs a capability, not the service. During a live auction, serving base
    prices from a possibly stale local file is strictly better than failing every
    request and stranding ten franchises mid-lot.

    The fallback is not silent. It logs at ERROR, and config/env_check.py reports
    it at startup, so a degraded deployment is visible rather than merely
    survivable.
    """
    global _announced
    settings = get_settings()

    if not settings.use_postgres:
        from db.sqlite_manager import SQLiteManager

        if not _announced:
            logger.info("Players table: SQLite at %s", settings.SQLITE_DB_PATH)
            _announced = True
        return SQLiteManager()

    try:
        from db.postgres_manager import PostgresManager

        manager = PostgresManager()
        # Force the pool open here rather than on the first query. A failure
        # needs to happen where this function can still fall back; inside a
        # query it would surface as a 500 to whoever was unlucky.
        manager.get_player_count()
    except Exception as exc:  # noqa: BLE001 - the fallback is the point
        from db.sqlite_manager import SQLiteManager

        logger.error(
            "Postgres is configured (%s) but unusable: %s. Falling back to "
            "SQLite at %s -- player data may be stale. Fix the connection and "
            "restart.",
            settings.safe_database_target,
            exc,
            settings.SQLITE_DB_PATH,
        )
        return SQLiteManager()

    if not _announced:
        logger.info("Players table: %s", settings.safe_database_target)
        _announced = True
    return manager


def close_player_db() -> None:
    """
    Release whatever the factory opened. Safe to call unconditionally.

    SQLiteManager holds nothing between calls, so this only ever has work to do
    on the Postgres side. Called from api/main.py's lifespan shutdown.
    """
    if not get_settings().use_postgres:
        return
    try:
        from db.postgres_manager import close_pool

        close_pool()
    except Exception as exc:  # noqa: BLE001 - shutdown must not raise
        logger.warning("Could not close the player database: %s", exc)
