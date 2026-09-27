"""Pytest configuration: put the package root on sys.path, and keep the suite off
the production database."""
import sys
from pathlib import Path

import pytest

package_root = str(Path(__file__).resolve().parent.parent)
if package_root not in sys.path:
    sys.path.insert(0, package_root)


@pytest.fixture(autouse=True, scope="session")
def _never_touch_production_postgres():
    """
    Force every test in this suite onto local SQLite, whatever .env says.

    THE PROBLEM THIS EXISTS FOR. Call sites ask db.get_player_db() for a manager,
    and that factory returns PostgresManager whenever DATABASE_URL is set. A
    developer with a working Supabase connection in .env -- which is now the
    normal state, not an exotic one -- would therefore have the whole suite
    silently pointed at the production database.

    Nothing here writes to the players table (the security harness constructs
    SQLiteManager directly, and the DAST spider explicitly skips
    /api/v1/ingest), so the damage would be wrong answers rather than lost data:
    tests asserting against five seeded players would be served the real 284.
    But "wrong answers" includes a suite that passes when it should fail, and a
    test run should never depend on a network service being reachable anyway.

    autouse and session-scoped so it cannot be forgotten by a new test file.
    The original value is restored afterwards, so running the app in the same
    process later still sees the real configuration.
    """
    from config.settings import get_settings

    settings = get_settings()
    original = settings.DATABASE_URL
    settings.DATABASE_URL = ""
    try:
        yield
    finally:
        settings.DATABASE_URL = original
