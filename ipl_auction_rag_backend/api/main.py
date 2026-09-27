"""
main.py
FastAPI application entrypoint for the IPL Auction RAG Backend.

Usage:
    cd ipl_auction_rag_backend
    uvicorn api.main:app --reload --port 8001

Serves both the API and the built console, so the whole app runs on one port.
"""
import asyncio
import logging
import os
import sys
import time
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


async def _warm_models() -> None:
    """
    Load the Hugging Face models into RAM before the first request needs them.

    **The problem this removes.** `get_embedding_model` and `get_reranker_model`
    are both `@lru_cache(maxsize=1)`, which is a LAZY singleton: the cache fills
    on first *use*, and first use is inside a request handler. Measured on this
    machine, a cold `retrieve_for` took 13.27 seconds against 0.05 warm -- so
    whichever unlucky request arrives first pays thirteen seconds of disk I/O
    and model construction while holding the handler.

    That matters more here than in an ordinary API, because this process also
    runs the auction WebSocket and its seven-second bid timers. A cold load can
    outlast an entire bid window, and the lot closes while the loop is busy
    building a transformer.

    **Why before `yield`.** Uvicorn does not serve until lifespan startup
    returns, so finishing here means the server is never reachable in a state
    where a model is still cold. It also closes a genuine race: `lru_cache` does
    not hold a lock across concurrent first-calls, so two simultaneous cold
    requests can each construct a model and one copy is discarded after paying
    for it.

    **Why a thread.** The loaders are synchronous and CPU-bound. Awaiting them
    through `asyncio.to_thread` keeps the event loop free during startup rather
    than blocking it for the duration.

    Never raises. A corrupt or partial model cache should cost the RAG features,
    not the auction -- the loaders will simply try again lazily on first use,
    which is exactly the behaviour that existed before this function.
    """
    started = time.perf_counter()

    def _load(label: str, loader) -> None:
        mark = time.perf_counter()
        loader()
        logger.info("Warmed %s in %.1fs", label, time.perf_counter() - mark)

    for label, path in (
        ("embedding model", "models.embedding_loader:get_embedding_model"),
        ("reranker model", "models.reranker_loader:get_reranker_model"),
    ):
        module_name, attr = path.split(":")
        try:
            module = __import__(module_name, fromlist=[attr])
            await asyncio.to_thread(_load, label, getattr(module, attr))
        except Exception as exc:  # noqa: BLE001 - a cold model is not a dead server
            logger.warning(
                "Could not warm the %s (%s). It will load on first use instead, "
                "which costs that request roughly 13s.",
                label,
                exc,
            )

    logger.info("Model warmup finished in %.1fs", time.perf_counter() - started)


async def _keep_alive() -> None:
    """
    Request this service's own /api/v1/ping on a fixed interval, forever.

    **A FALLBACK, off by default.** UptimeRobot polls /api/v1/ping from outside,
    which is the better mechanism: it still reports when the process is down --
    a self-ping cannot, because the reporter is what died -- and it exercises the
    whole path a visitor takes, DNS and TLS and Render's proxy included, where a
    request from inside the container can succeed while the site is unreachable.
    So this runs only when KEEP_ALIVE_ENABLED is set, for a deployment with no
    external monitor attached.

    **What it is for.** Render idles a free-tier web service after roughly
    fifteen minutes without an inbound request. Waking it is not a fast cold
    start here -- lifespan startup reloads two Hugging Face models -- so the
    first visitor after an idle spell waits a long time for a page. A request
    that leaves the container, reaches Render's edge and comes back counts as
    inbound traffic, which resets that idle timer.

    **Where the URL comes from.** Render injects RENDER_EXTERNAL_URL with the
    service's own public address, so nothing has to be hardcoded or guessed.
    KEEP_ALIVE_URL overrides it for the cases the platform variable does not
    cover. With neither set -- every developer machine -- the loop logs that it
    is disabled and returns, because a server pinging itself on a laptop is pure
    log noise.

    **Two honest caveats.** On a PAID Render instance the service never idles, so
    this prevents nothing; with the persistent disk in render.yaml attached, it is
    already redundant. And on the free tier it keeps the clock running
    continuously, so it consumes free instance-hours whether or not anyone is
    using the site.

    Never raises. A failed ping is logged and the loop continues: the internet
    being briefly unavailable is not a reason to stop trying, and it is certainly
    not a reason to disturb the auction this process is also running.
    """
    settings = get_settings()
    if not settings.KEEP_ALIVE_ENABLED:
        logger.info(
            "Keep-alive: disabled (KEEP_ALIVE_ENABLED is false; an external "
            "monitor such as UptimeRobot should poll /api/v1/ping instead)"
        )
        return

    base = (settings.KEEP_ALIVE_URL or os.getenv("RENDER_EXTERNAL_URL", "")).strip()
    if not base:
        logger.warning(
            "Keep-alive: enabled but no target - set KEEP_ALIVE_URL, or run "
            "somewhere that provides RENDER_EXTERNAL_URL"
        )
        return

    url = f"{base.rstrip('/')}/api/v1/ping"
    # Floored rather than trusted. A tiny interval configured by mistake would
    # turn this into a self-inflicted load generator on the loop that also runs
    # the bid timers.
    interval = max(30.0, settings.KEEP_ALIVE_INTERVAL)
    logger.info("Keep-alive: %s every %.0fs", url, interval)

    import httpx

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            while True:
                # Sleep FIRST. At this point uvicorn has not finished starting --
                # lifespan has not returned -- so an immediate request would hit
                # a socket that is not accepting yet and log a spurious failure.
                await asyncio.sleep(interval)
                try:
                    response = await client.get(url)
                    logger.debug("Keep-alive ping -> %s", response.status_code)
                except Exception as exc:  # noqa: BLE001 - a missed ping is not fatal
                    logger.warning("Keep-alive ping failed: %s", exc)
    except asyncio.CancelledError:
        # Raised when lifespan shutdown cancels the task. Re-raised, not
        # swallowed: swallowing it tells asyncio the cancellation did not take,
        # and shutdown then waits on a task that will never finish.
        logger.info("Keep-alive stopped")
        raise


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
    # safe_database_target, never DATABASE_URL: the URL embeds the Supabase
    # password, and this line goes to Render's log stream, where it is retained
    # and searchable. The property returns host/dbname with the credentials
    # stripped, and the plain path when the backend is SQLite.
    logger.info("Players DB: %s", settings.safe_database_target)
    logger.info("ChromaDB: %s", settings.CHROMA_DB_PATH)
    if settings.use_postgres:
        # Worth stating explicitly, because it is the detail that surprises
        # people: Postgres takes over the players table only. These two stay on
        # local SQLite and depend on the persistent disk to survive a deploy.
        logger.info("SQLite (vector store + SCOUT checkpoint): %s", settings.SQLITE_DB_PATH)
    problem = settings.database_url_problem
    if problem:
        logger.error("DATABASE_URL %s", problem)
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
        from db import get_player_db

        rows = get_player_db().get_all_players(limit=1000, offset=0)
        loaded = auction_room.load_players(rows)
        logger.info("Auction room: %d players loaded", loaded)
    except Exception as exc:  # noqa: BLE001 - startup must not die here
        logger.warning(
            "Auction room has no player pool (%s). Run POST /api/v1/ingest, "
            "then restart to enable live bidding.",
            exc,
        )

    # Pre-warm the Hugging Face models. Deliberately the last thing before the
    # server starts accepting traffic: everything above is cheap, and this is
    # the one step that takes seconds rather than milliseconds.
    await _warm_models()

    # Start the keep-alive loop last, and do NOT await it -- awaiting a `while
    # True` here would mean lifespan startup never returns and the server never
    # serves. The handle is kept so shutdown can cancel it; an orphaned task
    # holding an httpx client would keep the process alive after serving stops.
    keep_alive_task = asyncio.create_task(_keep_alive(), name="keep-alive")

    logger.info("=" * 60)

    yield

    # Stop the keep-alive before anything else. It is the only thing that might
    # still be issuing requests, and letting it run while the stores below are
    # closing invites a ping to arrive mid-teardown.
    keep_alive_task.cancel()
    try:
        await keep_alive_task
    except asyncio.CancelledError:
        pass
    except Exception as exc:  # noqa: BLE001 - shutdown must not raise
        logger.warning("Keep-alive did not stop cleanly: %s", exc)

    # Release the Postgres pool. A no-op on SQLite, which holds nothing between
    # calls. Left open, pooled connections keep non-daemon threads alive and the
    # process finishes serving and then sits there looking hung -- the same
    # failure mode the SCOUT checkpointer has, handled just below.
    try:
        from db import close_player_db

        close_player_db()
    except Exception as exc:  # noqa: BLE001 - shutdown must not raise
        logger.warning("Could not close the player database: %s", exc)

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
#
# Locked to the origins in CORS_ORIGINS -- no wildcard. The old `origins + ["*"]`
# paired with allow_credentials=True told the browser that any website could make
# credentialed requests here, which is a misconfiguration that turns dangerous the
# moment any authentication exists. In production, set CORS_ORIGINS to the
# frontend's origin; when this backend serves the console itself (same origin), no
# entry is needed at all.
settings = get_settings()
origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]

# Add this service's own public origin on Render, if the platform told us what it
# is. Strictly this is belt and braces: uvicorn serves the console from the same
# origin as the API, so the browser treats those calls as same-origin and never
# consults CORS at all. It matters for the cases that are not same-origin -- a
# custom domain in front of the service, the /docs page, or a second frontend
# deployment pointed at this API.
#
# NOT a wildcard, deliberately. The note above records that `origins + ["*"]`
# together with allow_credentials=True was removed as a misconfiguration, and it
# is worth being explicit about why so nobody restores it as a quick fix during a
# deploy: that pair tells the browser ANY website may make credentialed requests
# here, and this service now has an auctioneer password and an admin key behind
# it. The CORS spec forbids the combination and browsers reject it, so it does not
# even work -- it just fails in a way that looks like a different bug.
render_origin = os.getenv("RENDER_EXTERNAL_URL", "").strip().rstrip("/")
if render_origin and render_origin not in origins:
    origins.append(render_origin)
    logger.info("CORS: added the Render origin %s", render_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request, call_next):
    """
    Baseline security headers on every HTTP response.

    Deliberately without a Content-Security-Policy: a strict one has to be
    tailored against the built console's inline styles, fonts and 3D bundle, and a
    wrong CSP breaks the page silently -- so it is a separate, tested step. The
    four below are safe everywhere. They stop MIME sniffing, framing
    (clickjacking) and referrer leakage; HSTS is ignored by browsers over plain
    HTTP, so it is harmless locally and takes effect once the host terminates TLS.
    """
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
    )
    return response

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


# ---------------------------------------------------------------------------
# Direct execution: `python api/main.py`
#
# NOT the path Render takes -- that is start.sh, which is the same binding plus
# the working-directory change that lets config/settings.py find .env. This block
# exists so that running this file directly cannot accidentally bind somewhere
# unreachable, and it reads the port the same way the platform assigns it.
#
#   $PORT        Render assigns this and routes to it alone. A service bound to
#                anything else is running and unreachable, which presents as a
#                deploy that "works" but times out the health check.
#   0.0.0.0      The container's external interface. Bound to 127.0.0.1 the
#                service answers from inside the container and nowhere else.
#
# Deliberately one worker and no --reload, for the reasons spelled out at length
# in start.sh: the auction room is in-process state, so a second worker is a
# second independent auction, and a reload drops every open WebSocket mid-lot.
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", str(settings.API_PORT)))
    host = os.getenv("HOST", settings.API_HOST)
    logger.info("Starting uvicorn directly on %s:%d", host, port)
    uvicorn.run(
        app,
        host=host,
        port=port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
