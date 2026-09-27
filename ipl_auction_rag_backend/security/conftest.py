"""
conftest.py
Test discovery, import paths, and the fixtures every phase shares.

Two directories go on sys.path, mirroring what `tests/conftest.py` does for the
unit suite:

  - the backend package root, so `import auction`, `import db`, `import api`
    resolve exactly as they do under uvicorn;
  - this `security/` directory, so `import harness` resolves whatever the
    current working directory happens to be.

Markers are registered here rather than in a pytest.ini so the suite adds no
global config file to a project that deliberately has none -- run it with
`python -m pytest security` from the backend directory and nothing else needs to
change.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SECURITY_DIR = Path(__file__).resolve().parent
_PACKAGE_ROOT = _SECURITY_DIR.parent
for _path in (str(_SECURITY_DIR), str(_PACKAGE_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)


def pytest_configure(config: pytest.Config) -> None:
    """Name the markers, so `-W error` and `--strict-markers` stay usable."""
    config.addinivalue_line(
        "markers",
        "concurrency: Phase 1 -- races the auction's asyncio lock and version guard.",
    )
    config.addinivalue_line(
        "markers",
        "access_control: Phase 2 -- seat RBAC, franchise isolation, CORS, unauth surface.",
    )
    config.addinivalue_line(
        "markers",
        "redteam: Phase 3 -- adversarial input against the SCOUT LLM path and its guards.",
    )
    config.addinivalue_line(
        "markers",
        "dast: Phase 4 -- route spidering, payload fuzzing, and static analysis.",
    )
    config.addinivalue_line(
        "markers",
        "live: needs a real LLM key or network egress; skipped unless explicitly run.",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """
    Skip `live` tests unless they were asked for.

    A live test reaches a real model or the network and can take tens of seconds
    (the embedding model loads on first retrieval). So the default run leaves them
    out and stays fast and offline; select them explicitly with `-m live` to run
    them.
    """
    markexpr = getattr(config.option, "markexpr", "") or ""
    if "live" in markexpr:
        return  # the caller asked for live tests by name
    skip_live = pytest.mark.skip(reason="live test; run it with -m live")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)


@pytest.fixture(autouse=True)
def _auctioneer_password():
    """
    Run every test under a known auctioneer password.

    The auctioneer chair is now password-gated, and an unset password locks it
    entirely. So the suite configures one for the process (restoring whatever was
    there after), which lets a test seat an auctioneer with
    `AUCTIONEER_TEST_PASSWORD` and lets a gate test contrast that right answer
    with a wrong one.
    """
    from harness.staging import AUCTIONEER_TEST_PASSWORD

    from config.settings import get_settings

    settings = get_settings()
    original = settings.AUCTIONEER_PASSWORD
    settings.AUCTIONEER_PASSWORD = AUCTIONEER_TEST_PASSWORD
    try:
        yield
    finally:
        settings.AUCTIONEER_PASSWORD = original


@pytest.fixture(autouse=True, scope="session")
def _never_touch_production_postgres():
    """
    Force this suite onto local SQLite, whatever .env says.

    `point_settings_at` already clears DATABASE_URL for the tests that use it,
    but that only covers `staging_client`. This is the backstop for everything
    else: db.get_player_db() returns a PostgresManager whenever DATABASE_URL is
    set, so once a developer has a working Supabase string in .env -- now the
    normal state -- any test reaching the players table through the factory
    would be answered by the production database.

    A security suite in particular must not depend on a remote service being
    reachable, and must not be able to observe or disturb production data.
    autouse and session-scoped so a new test file cannot forget it; the original
    value is restored afterwards.
    """
    from config.settings import get_settings

    settings = get_settings()
    original = settings.DATABASE_URL
    settings.DATABASE_URL = ""
    try:
        yield
    finally:
        settings.DATABASE_URL = original


@pytest.fixture
def room():
    """
    A fresh, seeded AuctionRoom for the room-level phases.

    Teardown cancels any countdown task `put_up` may have armed. The task holds a
    reference to *this* room, not the singleton, so a stray firing would settle a
    discarded object harmlessly -- but cancelling it keeps the test log free of
    "Task was destroyed but it is pending" noise.
    """
    from harness.staging import fresh_room

    room = fresh_room()
    yield room

    task = getattr(room, "_clock_task", None)
    if task is not None:
        try:
            task.cancel()
        except Exception:  # noqa: BLE001 - teardown must never fail a green test
            pass


@pytest.fixture
def staging_client(tmp_path):
    """
    A TestClient over the real app, wired to a disposable seeded database.

    Entering the client runs the app's lifespan, which loads the auction room
    from `settings.SQLITE_DB_PATH` -- pointed here at the temp file -- so both
    the room and the /players route serve the five seeded players. The temp DB
    lives under pytest's tmp_path and is gone when the test ends.
    """
    from fastapi.testclient import TestClient

    from harness.staging import point_settings_at, seed_sqlite

    db_path = tmp_path / "staging.db"
    seed_sqlite(str(db_path))

    with point_settings_at(str(db_path)):
        from api.main import app

        with TestClient(app) as client:
            yield client
