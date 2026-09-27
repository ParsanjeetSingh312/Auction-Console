#!/usr/bin/env bash
# start.sh
# The Linux counterpart to start.ps1 -- this is what Render runs.
#
# start.ps1 stays exactly as it is. It is how the project runs on Windows, and
# nothing here changes or replaces it. This is a translation for a different OS
# and a different lifecycle, not a rewrite of it.
#
# WHAT IS DIFFERENT FROM start.ps1, AND WHY
#
#   no npm run build      On Render the build is a separate, earlier phase
#                         (buildCommand in render.yaml). Building here would
#                         re-run on every restart, burn the health-check window,
#                         and need devDependencies the runtime image does not
#                         install.
#
#   no .venv path         Render's buildCommand pip-installs into the image's own
#                         site-packages. There is no virtualenv to point at.
#
#   no port-in-use check  Get-NetTCPConnection is Windows-only, and the question
#                         it answers does not arise: Render gives the container
#                         one port and runs one process on it.
#
#   $PORT, not 8001       Render assigns the port and routes to that alone. A
#                         hardcoded port is unreachable from outside the
#                         container. 8001 remains the fallback so this script
#                         also works on a plain Linux box or WSL.
#
# Run it locally if you want:  ./start.sh          (serves on 8001)
#                             PORT=8002 ./start.sh (serves on 8002)
# but build first, because this script deliberately does not:  npm run build

set -euo pipefail

# Resolve the repository root from this script's own location rather than
# trusting the working directory. Render happens to invoke it from the root, but
# depending on that would make the script silently wrong anywhere else.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/ipl_auction_rag_backend"
PORT="${PORT:-8001}"

step() { printf '\n==> %s\n' "$1"; }

# --- which python ------------------------------------------------------------
# python3 first: on a bare Ubuntu image `python` may not exist at all. Render's
# Python runtime provides both, so this is insurance for local Linux use.
if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON=python
else
    echo "No python on PATH. Nothing to start." >&2
    exit 1
fi

# --- sanity ------------------------------------------------------------------
if [ ! -d "$BACKEND" ]; then
    echo "Backend not found at $BACKEND" >&2
    exit 1
fi

# A missing dist/ is a warning, not a fatal error -- deliberately, and matching
# how the rest of this codebase treats a missing capability. api/main.py returns
# 503 for page requests without it while the API, the WebSocket and /docs all
# keep working. Failing here instead would mean the health check never passes
# and you would have no running service to diagnose from.
if [ ! -f "$ROOT/dist/index.html" ]; then
    echo ""
    echo "WARNING: no frontend build at $ROOT/dist"
    echo "         The API and the auction WebSocket will work; every page"
    echo "         request will return 503. On Render this means buildCommand"
    echo "         did not run 'npm run build', or it failed."
    echo ""
fi

# --- the persistent disk -----------------------------------------------------
# Render mounts the disk before the start command runs, but the SUBDIRECTORIES
# under it are ours to create -- a freshly provisioned disk is empty. Doing it
# here rather than relying on the application means a permissions problem shows
# up in the deploy log as a clear mkdir failure, instead of surfacing minutes
# later as a confusing Chroma or huggingface_hub traceback.
#
# Driven off the environment rather than hardcoded to /var/cache, so this script
# stays correct when run locally with none of these set.
if [ -n "${HF_HOME:-}" ]; then
    mkdir -p "$HF_HOME"
fi
if [ -n "${CHROMA_DB_PATH:-}" ]; then
    mkdir -p "$CHROMA_DB_PATH"
fi
if [ -n "${SCOUT_CHECKPOINT_PATH:-}" ]; then
    mkdir -p "$(dirname "$SCOUT_CHECKPOINT_PATH")"
fi

# --- serve -------------------------------------------------------------------
# The working directory must be the backend package. config/settings.py declares
# env_file='.env', which pydantic-settings resolves against the PROCESS working
# directory -- so started from the repository root the .env is silently not
# found and the backend comes up with no API keys at all. Same reason start.ps1
# does its Push-Location.
#
# On Render there is no .env file (the dashboard supplies real environment
# variables, which take precedence anyway), but this keeps one code path for
# both, and it is the path that is correct locally.
cd "$BACKEND"

step "Starting AUCTONIQ on 0.0.0.0:$PORT"

# `exec` matters, and not only for tidiness. It replaces this shell with uvicorn
# so that the process Render signals IS uvicorn. Without it, SIGTERM on deploy
# or scale-down is delivered to bash, uvicorn is killed without a graceful
# shutdown, and the lifespan teardown in api/main.py never runs -- which means
# scout_aclose() never closes the aiosqlite checkpointer. That connection runs on
# a NON-daemon thread, so the process can then hang instead of exiting, and
# Render waits out its timeout before killing it on every single deploy.
#
# --host 0.0.0.0
#     Render routes to the container's external interface. Bound to 127.0.0.1
#     the service is up, healthy from inside, and unreachable from the internet.
#
# --forwarded-allow-ips '*'
#     Render terminates TLS and proxies to this container, so every request
#     arrives over plain HTTP carrying X-Forwarded-Proto: https. uvicorn ignores
#     those headers unless the immediate peer is in this list, and the peer here
#     is Render's proxy, not 127.0.0.1 -- so without it the app believes it is
#     serving HTTP and any absolute URL or redirect it builds comes out as
#     http://, which a browser on an https page then refuses as mixed content.
#     '*' is safe in this topology because nothing but Render's proxy can reach
#     the container. Note also that auction/ws.py's RateLimiter is per
#     connection, not per IP, so no access control depends on this.
#
# NO --reload
#     Same reason start.ps1 defaults it off: a reload drops every open
#     WebSocket, which mid-lot disconnects all ten franchises at once. In
#     production there is no argument for it at all.
#
# NO --workers
#     Leave this at one. This is not a tuning choice, it is a correctness
#     requirement: the auction room is in-process state (auction/room.py), held
#     in one module-level object. A second worker is a second, entirely separate
#     room -- franchises would be spread across two independent auctions by
#     whichever worker accepted their socket, each seeing only half the bids,
#     with two different players on the block. Scale this service UP, never OUT.
exec "$PYTHON" -m uvicorn api.main:app \
    --host 0.0.0.0 \
    --port "$PORT" \
    --proxy-headers \
    --forwarded-allow-ips '*'
