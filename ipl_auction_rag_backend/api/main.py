"""
main.py
FastAPI application entrypoint for the IPL Auction RAG Backend.

Usage:
    cd ipl_auction_rag_backend
    uvicorn api.main:app --reload --port 8001

Serves both the API and the built console, so the whole app runs on one port.
"""
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Ensure the package root is on sys.path for imports
package_root = str(Path(__file__).resolve().parent.parent)
if package_root not in sys.path:
    sys.path.insert(0, package_root)

from config.env_check import check_environment, log_report
from config.settings import get_settings
from api.routes import router as api_router
from api.routes_scout import router as scout_router
from auction.room import room as auction_room
from auction.ws import router as auction_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)-30s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("rag.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown events."""
    settings = get_settings()
    logger.info("=" * 60)
    logger.info("IPL Auction RAG Backend starting...")
    logger.info("RAG LLM Model: %s", settings.RAG_LLM_MODEL)
    logger.info("SQL LLM Model: %s", settings.SQL_LLM_MODEL)
    logger.info("Embedding Model: %s", settings.EMBEDDING_MODEL_NAME)
    logger.info("Groq API Key: %s", "configured" if settings.GROQ_API_KEY else "NOT SET")
    logger.info("SQLite DB: %s", settings.SQLITE_DB_PATH)
    logger.info("ChromaDB: %s", settings.CHROMA_DB_PATH)
    logger.info("=" * 60)

    # Ensure data directories exist before the check inspects them, so a first
    # run reports "empty" rather than "missing".
    Path(settings.SQLITE_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(settings.CHROMA_DB_PATH).mkdir(parents=True, exist_ok=True)

    # Validate the environment and say plainly what is and is not available.
    # This never aborts startup: a missing key costs a capability, not the
    # service. Only a genuinely unusable player table is called out as blocking,
    # and even then the app stays up so the operator can hit /api/v1/ingest.
    report = check_environment(settings)
    log_report(report, logger)
    if report.blocking:
        logger.error(
            "Starting anyway so the problem can be fixed through the API, but "
            "player queries will fail until it is resolved."
        )
    # Hand the auction room its player pool.
    #
    # Read once, at startup, from the same SQLite table the console hydrates
    # from - so the room and every client agree on base prices and roles. A
    # failure here is logged and survived: the API and the console still work,
    # and the room refuses to start an auction rather than running one on an
    # empty pool.
    try:
        from db.sqlite_manager import SQLiteManager

        rows = SQLiteManager().get_all_players(limit=1000, offset=0)
        loaded = auction_room.load_players(rows)
        logger.info("Auction room: %d players loaded", loaded)
    except Exception as exc:  # noqa: BLE001 - startup must not die here
        logger.warning(
            "Auction room has no player pool (%s). Run POST /api/v1/ingest, "
            "then restart to enable live bidding.",
            exc,
        )

    logger.info("=" * 60)

    yield

    # Release SCOUT's checkpointer.
    #
    # aiosqlite runs its connection on a thread that is NOT a daemon, so a
    # process that never closes it never exits -- it finishes serving, returns
    # from the loop, and then sits there looking hung. Under `uvicorn --reload`
    # that means every reload leaks a thread and eventually the port.
    try:
        from scout.graph.workflow import aclose as scout_aclose

        await scout_aclose()
        logger.info("SCOUT checkpointer closed")
    except Exception as exc:  # noqa: BLE001 - shutdown must not raise
        logger.warning("Could not close the SCOUT checkpointer: %s", exc)
    
    logger.info("IPL Auction RAG Backend shutting down...")


app = FastAPI(
    title="IPL Auction RAG Search Engine",
    description=(
        "Phase 2: Hybrid RAG backend for the IPL 2026 Mega Auction. "
        "Combines SQL analytics with semantic vector search over ~300 player profiles."
    ),
    version="2.0.0",
    lifespan=lifespan,
)

# CORS middleware
settings = get_settings()
origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins + ["*"],  # Allow all in dev; restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount API routes. These are registered before the frontend catch-all below,
# so /api/v1/* always resolves here rather than being swallowed by the SPA.
app.include_router(api_router)

# The live auction room: WebSocket at /api/v1/auction/ws, plus two read-only
# REST views of the same state. Registered here for the same reason as the API
# router - before the SPA catch-all, so its paths are never swallowed.
app.include_router(auction_router)

# SCOUT: the orchestration layer. A router on this app rather than a second
# service, so it shares this port, this CORS configuration and this process --
# and so the console keeps talking to exactly one origin.
app.include_router(scout_router)


# ---------------------------------------------------------------------------
# Frontend
#
# The built console is served from this same app, so the whole thing runs on
# one port: http://127.0.0.1:8001 is the dashboard, /api/v1/* is the API, /docs
# is the schema. Build it with `npm run build` from the repository root.
#
# Vite emits content-hashed filenames under dist/assets, so those are safe to
# cache hard; index.html is not, and must never be cached or a rebuild leaves
# browsers loading asset URLs that no longer exist.
# ---------------------------------------------------------------------------

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "dist"
INDEX_HTML = FRONTEND_DIST / "index.html"


@app.get("/api", include_in_schema=False)
async def api_root():
    """Service metadata, kept reachable now that / serves the console."""
    return {
        "service": "IPL Auction RAG Search Engine",
        "version": "2.0.0",
        "docs": "/docs",
        "phase": 2,
        "frontend": "built" if INDEX_HTML.is_file() else "not built",
    }


if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )
    logger.info("Serving the console from %s", FRONTEND_DIST)
else:
    logger.warning(
        "No frontend build at %s — run `npm run build` from the repository root. "
        "The API still works.",
        FRONTEND_DIST,
    )


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_console(full_path: str):
    """
    Serve the single-page console.

    Registered last so it only sees paths no API route claimed. An unmatched
    /api/* path returns a JSON 404 rather than the HTML shell, because a client
    expecting JSON should not have to parse a document to discover it was wrong.
    """
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="No such API route")

    if not INDEX_HTML.is_file():
        raise HTTPException(
            status_code=503,
            detail=(
                "The console has not been built. Run `npm run build` from the "
                "repository root, then reload."
            ),
        )

    # Real files (favicon, robots.txt) are served as themselves; every other
    # path is a client-side route and gets the shell.
    candidate = (FRONTEND_DIST / full_path).resolve()
    if (
        full_path
        and candidate.is_file()
        and candidate.is_relative_to(FRONTEND_DIST.resolve())
    ):
        return FileResponse(candidate)

    return FileResponse(INDEX_HTML, headers={"Cache-Control": "no-cache"})
