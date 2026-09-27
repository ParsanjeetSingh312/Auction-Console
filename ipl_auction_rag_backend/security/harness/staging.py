"""
staging.py
A throwaway AUCTIQ, built to be attacked.

Every security test runs against a disposable instance seeded with five fake
players -- never the real `ipl_auction.db`. That is not politeness, it is a
precondition: Phase 4 fuzzes HTTP endpoints and Phase 1 drives the auction to
settlement hundreds of times, and neither should be able to touch the data an
actual auction depends on.

Two builders, because the phases attack at two different altitudes:

    fresh_room()        an AuctionRoom in memory, pool loaded, no socket, no DB.
                        The target for Phase 1 (concurrency) and much of Phase 2
                        (seat RBAC), which reason about `room.py`'s asyncio lock
                        and its `_require_*` gate directly, with no transport in
                        the way to blur what actually enforced the rule.

    seed_sqlite(path)   a temp SQLite file carrying the real schema and the
                        seeded pool, for the REST/DAST phases that go through
                        SQLiteManager and the FastAPI app.

`point_settings_at` is the one bridge to the running app: it swaps
`settings.SQLITE_DB_PATH` for a temp file and puts the original back, so a
TestClient started inside it hydrates the room and the /players route from the
seeded pool instead of the developer's database.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

# ---------------------------------------------------------------------------
# The seeded pool
#
# Shaped exactly like a `SQLiteManager.get_all_players()` row so that both
# `room.load_players()` and `PlayerResponse(**row)` accept it unchanged. It is
# deliberately small and deterministic -- five players is enough to have a
# contested lot, an overseas cap to bump against, and a keeper for the report,
# while staying countable by hand when a test asserts "total == 5".
#
# Two rows (ids 3 and 4) carry no base_price on purpose: `room.load_players`
# substitutes BASE_PRICE_FLOOR for a missing base exactly as the console does,
# and a harness that never exercised that substitution would let a regression in
# it pass unseen.
# ---------------------------------------------------------------------------

SEEDED_PLAYERS: list[dict[str, Any]] = [
    {"id": 1, "player_name": "Test Opener", "role": "Batter",
     "country": "India", "overseas": 0, "base_price": 200, "rating": 8.5,
     "cap_status": "CAPPED"},
    {"id": 2, "player_name": "Test Keeper", "role": "Wicket Keeper",
     "country": "India", "overseas": 0, "base_price": 150, "rating": 7.9,
     "cap_status": "CAPPED"},
    {"id": 3, "player_name": "Test Allrounder", "role": "All-Rounder",
     "country": "Australia", "overseas": 1, "base_price": None, "rating": 9.1,
     "cap_status": "CAPPED"},
    {"id": 4, "player_name": "Test Pacer", "role": "Bowler",
     "country": "India", "overseas": 0, "base_price": None, "rating": 8.0,
     "cap_status": "UNCAPPED"},
    {"id": 5, "player_name": "Test Spinner", "role": "Bowler",
     "country": "England", "overseas": 1, "base_price": 100, "rating": 7.2,
     "cap_status": "CAPPED"},
]

#: The two ids whose base_price is None, so a test can assert the floor stood in
#: for exactly these and left the others alone.
UNPRICED_PLAYER_IDS: tuple[int, ...] = (3, 4)

#: The auctioneer password the suite runs under. A conftest fixture sets
#: settings.AUCTIONEER_PASSWORD to this for every test, so a test that needs to
#: seat an auctioneer passes this value, and a test probing the gate has a known
#: right answer to contrast a wrong one against.
AUCTIONEER_TEST_PASSWORD = "test-auctioneer-secret"


def fresh_room():
    """
    A brand-new AuctionRoom with the seeded pool loaded.

    A fresh instance rather than `auction.room.room`: the module singleton is
    shared with the live app and with any TestClient in the same process, and a
    concurrency test that hammered it would be racing the wrong object. This one
    is the test's alone.
    """
    from auction.room import AuctionRoom

    room = AuctionRoom()
    # Copy each dict: load_players reads them, and a test that later mutates the
    # module-level SEEDED_PLAYERS would otherwise poison every subsequent room.
    room.load_players([dict(row) for row in SEEDED_PLAYERS])
    return room


def seed_sqlite(db_path: str) -> int:
    """
    Create the real players schema at `db_path` and insert the seeded pool.

    Uses the production SQLiteManager so the temp DB is byte-for-byte the schema
    the app expects -- same columns, same WAL mode, same NULL handling for the
    unpriced rows. Returns the row count inserted, for a caller that wants to
    assert it.
    """
    import pandas as pd

    from db.sqlite_manager import SQLiteManager

    manager = SQLiteManager(db_path=db_path)
    manager.drop_tables()
    manager.create_tables()
    return manager.insert_players(pd.DataFrame(SEEDED_PLAYERS))


@contextmanager
def point_settings_at(db_path: str) -> Iterator[Any]:
    """
    Temporarily make the whole app read `db_path` as its SQLite database.

    `get_settings()` is an lru_cache singleton, so mutating the one instance
    every SQLiteManager() and the app lifespan resolve their path from is enough
    to redirect all of them at once. The original value is restored on exit even
    if the body raises, so one test's staging DB never leaks into the next.

    DATABASE_URL is cleared for the same duration, and that is not optional.
    Redirecting SQLITE_DB_PATH alone stopped being sufficient once the players
    table could live in Supabase: db.get_player_db() checks DATABASE_URL FIRST
    and hands back a PostgresManager when it is set, so the staging database
    would be seeded with five players while the app under test answered from the
    real one with 284. "The whole app reads db_path" has to mean the whole app.
    """
    from config.settings import get_settings

    settings = get_settings()
    original_path = settings.SQLITE_DB_PATH
    original_url = settings.DATABASE_URL
    settings.SQLITE_DB_PATH = db_path
    settings.DATABASE_URL = ""
    try:
        yield settings
    finally:
        settings.SQLITE_DB_PATH = original_path
        settings.DATABASE_URL = original_url
