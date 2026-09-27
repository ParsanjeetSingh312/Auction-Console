"""
test_phase4_dast_fuzzing.py
Phase 4 -- dynamic scanning, fuzzing, and static analysis.

The brief wanted OWASP ZAP spidering and payload fuzzing plus a Semgrep pass.
None of those tools are installed and all sit outside the uvicorn workflow, so
this does the same jobs against the real app with the Python toolchain already in
the venv:

  * **Spider** -- enumerate the routes from the app's own OpenAPI schema, then
    probe the safe read endpoints and assert none returns a 500. Heavy and
    destructive routes (search, chat, advise, and especially ingest) are
    catalogued but never called, so the scan cannot corrupt data or load models.
  * **Fuzz** -- throw malformed, oversized, and unknown-type frames at the
    WebSocket and malformed bodies and out-of-range parameters at the REST API,
    asserting a clean refusal (an error frame, a 422, a 404) and never a crash.
  * **Static analysis** -- the Semgrep-style pass: scan the handlers for
    hardcoded secrets and for SQL built by f-string, confirming the only dynamic
    SQL is at reviewed sites that interpolate static fragments with ?-placeholders.

Everything runs in-process against the seeded staging app.
"""
from __future__ import annotations

import ast
import pathlib
import re

import pytest

pytestmark = pytest.mark.dast

WS = "/api/v1/auction/ws"
BACKEND = pathlib.Path(__file__).resolve().parent.parent


@pytest.fixture
def ws_client(staging_client):
    """
    staging_client with the shared auction room reset to a clean lobby.

    Defined locally rather than shared with Phase 2, to keep this file
    self-contained; the room is a process singleton, so a prior test's phase or
    seats would otherwise leak into the frames fuzzed here.
    """
    from auction.room import Record, room

    room.seats.clear()
    room.phase = "lobby"
    room.lot = None
    room.log.clear()
    room.seq = 0
    room.undo_stack.clear()
    room.countdown_ends_at = None
    for pid in list(room.records):
        room.records[pid] = Record()
    room._refill_timeouts()
    return staging_client


# ---------------------------------------------------------------------------
# Spider
# ---------------------------------------------------------------------------


class TestRouteSpider:
    #: Read endpoints that are cheap and side-effect-free. Probed for real.
    SAFE_GETS = [
        "/api/v1/auction/state",
        "/api/v1/auction/report",
        "/api/v1/players",
        "/api",
    ]

    def test_openapi_documents_the_expected_surface(self, staging_client):
        """The app's own schema is the attack-surface catalogue."""
        spec = staging_client.get("/openapi.json").json()
        paths = set(spec["paths"])
        expected = {
            "/api/v1/players",
            "/api/v1/search",
            "/api/v1/chat",
            "/api/v1/ingest",
            "/api/v1/health",
            "/api/v1/auction/state",
            "/api/v1/auction/report",
            "/api/v1/scout/advise",
            "/api/v1/scout/health",
        }
        missing = expected - paths
        assert not missing, f"expected routes missing from the API: {missing}"

    @pytest.mark.parametrize("path", SAFE_GETS)
    def test_safe_get_endpoints_never_500(self, staging_client, path):
        assert staging_client.get(path).status_code == 200


# ---------------------------------------------------------------------------
# WebSocket fuzzing
# ---------------------------------------------------------------------------


class TestWebSocketFuzzing:
    """Every malformed frame is answered, not crashed on."""

    def test_oversized_frame_is_rejected(self, ws_client):
        with ws_client.websocket_connect(WS) as ws:
            ws.receive_json()  # initial state
            ws.send_json({"type": "ping", "pad": "A" * 9000})  # > MAX_FRAME_BYTES
            error = ws.receive_json()
        assert error["type"] == "error"
        assert error["about"] == "frame"

    def test_malformed_json_is_rejected(self, ws_client):
        with ws_client.websocket_connect(WS) as ws:
            ws.receive_json()
            ws.send_text("this is not json {{{")
            error = ws.receive_json()
        assert error["type"] == "error"
        assert error["about"] == "parse"

    def test_unknown_message_type_is_rejected(self, ws_client):
        with ws_client.websocket_connect(WS) as ws:
            ws.receive_json()
            ws.send_json({"type": "definitely_not_a_real_type"})
            error = ws.receive_json()
        assert error["type"] == "error"
        assert error["about"] == "validation"

    def test_rate_limiter_throttles_a_flood(self, ws_client):
        """A ping flood past the burst allowance draws rate-limit refusals."""
        flood = 70  # BURST is 40, so a flood this size cannot all be admitted
        with ws_client.websocket_connect(WS) as ws:
            ws.receive_json()  # initial state
            for _ in range(flood):
                ws.send_json({"type": "ping"})
            responses = [ws.receive_json() for _ in range(flood)]

        rate_errors = [
            r for r in responses
            if r.get("type") == "error" and r.get("about") == "rate"
        ]
        assert rate_errors, "the rate limiter admitted an unbounded ping flood"


# ---------------------------------------------------------------------------
# REST fuzzing
# ---------------------------------------------------------------------------


class TestRestFuzzing:
    """
    Malformed input is rejected at validation with a 422, before any handler
    runs -- which is also why these are safe: the search/chat handlers, which
    would load models, are never reached with a body this broken.
    """

    def test_missing_required_field_is_422(self, staging_client):
        assert staging_client.post("/api/v1/search", json={}).status_code == 422

    def test_oversized_query_is_422(self, staging_client):
        response = staging_client.post("/api/v1/search", json={"query": "A" * 1000})
        assert response.status_code == 422

    def test_wrong_type_is_422(self, staging_client):
        response = staging_client.post(
            "/api/v1/search", json={"query": "ok", "top_k": "not-a-number"}
        )
        assert response.status_code == 422

    def test_out_of_range_pagination_is_422(self, staging_client):
        assert staging_client.get("/api/v1/players", params={"limit": 99999}).status_code == 422
        assert staging_client.get("/api/v1/players", params={"limit": 0}).status_code == 422

    def test_unknown_api_route_is_json_404(self, staging_client):
        response = staging_client.get("/api/v1/does-not-exist")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Static analysis (the Semgrep-style pass)
# ---------------------------------------------------------------------------

#: Detects an SQL f-string by its leading keyword, on a word boundary so an
#: ordinary word like "Dropped" is not mistaken for a DROP statement.
_SQL_KEYWORD_RE = re.compile(
    r"\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b",
    re.IGNORECASE,
)

#: The modules allowed to build SQL with an f-string. Each was read on 2026-09-25
#: and confirmed to interpolate only allowlisted column names and operators --
#: never a value, which always travels as a bound ? parameter -- and each states
#: that invariant in its own docstring:
#:   * routes.py          list_players: a WHERE clause of ?-placeholders
#:   * search_engine.py   columns/ops from _NUMERIC_FILTERS; values bound
#:   * local_analyst.py   projection columns; sort_column gated on ALLOWED_COLUMNS
#:   * sqlite_manager.py  insert columns from the DataFrame's own schema;
#:                        update_player_column's column gated on isidentifier()
#:                        and, at the call site, on _STAT/_VALUATION_COLUMNS
#:   * rag_pipeline.py    write columns checked against _STAT/_VALUATION_COLUMNS
#:
#: Added 2026-09-27 with the Supabase backend:
#:   * postgres_manager.py  the same two statements as sqlite_manager, in the
#:                        Postgres dialect. insert_players interpolates only
#:                        df.columns (the DataFrame's own schema) and a run of
#:                        %s; update_player_column interpolates only a column
#:                        name that passed isidentifier() plus a fixed IS NULL
#:                        clause selected by a bool. Every value is bound.
#:                        to_pg_placeholders rewrites ? to %s in CALLER-supplied
#:                        SQL, but builds no SQL of its own and interpolates
#:                        nothing -- and execute_query still runs
#:                        validate_select_only first, on the caller's original
#:                        text, so the read path remains SELECT-only.
_REVIEWED_SQL_MODULES = {
    "routes.py",
    "search_engine.py",
    "local_analyst.py",
    "sqlite_manager.py",
    "rag_pipeline.py",
    "postgres_manager.py",
}


def _backend_modules():
    """Every backend .py file, skipping the test suites and the virtualenv."""
    for path in BACKEND.rglob("*.py"):
        parts = set(path.parts)
        if {"security", "tests", ".venv", "__pycache__"} & parts:
            continue
        yield path


def _static_prefix(joined: ast.JoinedStr) -> str:
    """The leading literal text of an f-string, up to its first interpolation."""
    out: list[str] = []
    for value in joined.values:
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            out.append(value.value)
        else:
            break
    return "".join(out)


class TestStaticAnalysis:
    def test_no_hardcoded_provider_secrets(self):
        """
        No real API key or token is committed in source; they belong in .env.

        The length thresholds are what tell a genuine key from the placeholder and
        prefix strings the code legitimately carries -- e.g. "sk-ant-your-key-here"
        (a value the config check rejects) or a `startswith("gsk_")` guard. A real
        key is a long unbroken run; those are short.
        """
        key_patterns = [
            re.compile(r"sk-ant-[A-Za-z0-9_\-]{30,}"),  # Anthropic
            re.compile(r"\bgsk_[A-Za-z0-9]{30,}"),       # Groq
            re.compile(r"AIza[A-Za-z0-9_\-]{30,}"),      # Google
            re.compile(r"\btvly-[A-Za-z0-9]{20,}"),      # Tavily
        ]
        offenders = []
        for module in _backend_modules():
            text = module.read_text(encoding="utf-8", errors="ignore")
            for pattern in key_patterns:
                if pattern.search(text):
                    offenders.append((module.name, pattern.pattern))
        assert not offenders, f"possible hardcoded secret(s): {offenders}"

    def test_auctioneer_password_is_not_baked_into_source(self):
        """The gate's default must be empty -- the real value lives only in .env."""
        text = (BACKEND / "config" / "settings.py").read_text(encoding="utf-8")
        match = re.search(r'AUCTIONEER_PASSWORD:\s*str\s*=\s*"([^"]*)"', text)
        assert match is not None, "AUCTIONEER_PASSWORD setting not found"
        assert match.group(1) == "", "AUCTIONEER_PASSWORD must default to empty"

    def test_fstring_sql_is_confined_to_reviewed_query_builders(self):
        """
        Every SQL statement built with an f-string must live in one of the
        reviewed query-builder modules. Those interpolate only allowlisted column
        names and operators and bind every value through a ? placeholder.

        This does not re-prove that invariant on each run -- an f-string that
        interpolates a column right after SELECT gives the AST nothing specific to
        match on. It guards the thing most likely to go wrong: dynamic SQL
        appearing somewhere new and unreviewed, which is where a value-into-query
        bug would be introduced. A hit means "read this new SQL before shipping".
        """
        offenders = []
        for module in _backend_modules():
            try:
                tree = ast.parse(module.read_text(encoding="utf-8", errors="ignore"))
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.JoinedStr):
                    continue
                if not _SQL_KEYWORD_RE.match(_static_prefix(node)):
                    continue  # an ordinary f-string, not SQL
                if module.name not in _REVIEWED_SQL_MODULES:
                    offenders.append(
                        (module.name, node.lineno, _static_prefix(node)[:70])
                    )
        assert not offenders, f"f-string SQL in an unreviewed module: {offenders}"
