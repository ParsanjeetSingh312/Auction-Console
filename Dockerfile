# ==============================================================================
# Dockerfile — AUCTONIQ as one container.
#
# At the repository ROOT because Hugging Face Spaces looks for it here and
# nowhere else. The build context is the root too: the image needs the frontend
# sources (it builds the console in its first stage) and the backend package.
#
#     docker compose up --build          local
#     git push hf main                   Hugging Face Spaces
#     git push (Railway watches main)    Railway, configured by railway.json
#
# ------------------------------------------------------------------------------
# WHY IT RUNS AS A NON-ROOT USER
#
# Hugging Face Spaces runs every container as UID 1000, not root, and that is
# not negotiable. A root-owned /app/data or an HF_HOME under /root means the
# first model download and the first Chroma write fail with EACCES -- which
# surfaces as a container that starts and then dies on its first request, with
# a permission error buried in a stack trace.
#
# The same layout is correct on a VPS, so this is ONE Dockerfile rather than a
# Spaces variant that drifts from the real one. Verify it anywhere with:
#
#     docker run --user 1000:1000 ...
#
# ------------------------------------------------------------------------------
# WHY DOCKER RATHER THAN A PLAIN PYTHON RUNTIME
#
# SCOUT's scraper drives a real Chromium, which needs system libraries installed
# with apt. Platforms that give no apt and no root cannot install it, and the
# scraper degrades to a search fallback. Here it is baked in at build time.
#
# ------------------------------------------------------------------------------
# THE IMAGE LAYOUT IS LOAD-BEARING
#
# The application derives three paths by walking up from its own __file__:
#
#   /home/user/app                     the backend package (WORKDIR)
#   /home/user/dist                    the built console
#   /home/user/IPL AUCTION DATA.xlsx   the ingestion source
#
# api/main.py resolves ../../dist from /home/user/app/api, and
# config/settings.py resolves ../../.. from /home/user/app/config. Move any of
# them and the console 503s or ingestion cannot find its input.
# ==============================================================================


# --- Stage 1: build the console -----------------------------------------------
# Without this stage the API answers correctly and every page request returns
# 503, because uvicorn serves the dist/ directory this produces.
#
# Node 24 matches the version this project builds with locally; a different
# major is the usual source of "it worked on my machine".
FROM node:24-slim AS frontend

WORKDIR /build

# Manifests first, as their own cached layer. They change far less often than
# source, so `npm ci` -- the slow step -- survives ordinary code edits.
COPY package.json package-lock.json ./
RUN npm ci

# Then everything else in one COPY. This was previously an explicit list of
# directories and the list went stale: pages/, hooks/ and utils/ were all
# imported and none were copied, so the build failed on a missing module.
# `COPY . .` plus .dockerignore cannot rot that way.
COPY . .
RUN npm run build


# --- Stage 2: the service -----------------------------------------------------
# 3.12 to match the interpreter the backend is developed and tested against.
FROM python:3.12-slim

# The user Spaces will run this as. Created before anything is copied, so
# ownership is set on the way in rather than fixed afterwards -- a recursive
# chown would duplicate every affected file into a new layer.
RUN useradd -m -u 1000 user

ENV HOME=/home/user \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# --- root-only build steps ---------------------------------------------------
# fonts-dejavu-core gives the auction report PDF (auction/auction_book_pdf.py) a
# face with the rupee sign; without it the document falls back to "Rs".
# build-essential is kept although most pins ship manylinux wheels: a source
# build that fails costs a full rebuild to discover, and ~300 MB is not material
# against an image this size.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# torch, CPU-only, installed BEFORE requirements.txt.
#
# The single biggest size decision here. `pip install torch` from PyPI pulls the
# CUDA build and its bundled NVIDIA libraries -- gigabytes of CUDA runtime that
# a CPU-only host has no GPU to use. Installing the CPU wheel first means
# sentence-transformers finds its requirement already satisfied and does not
# fetch the CUDA build over the top. Everything in this project is explicitly
# CPU-only; the reranker is profiled at seconds-per-query on CPU.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch

COPY ipl_auction_rag_backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Playwright's Chromium, installed system-wide and made world-readable.
#
# PLAYWRIGHT_BROWSERS_PATH is set BEFORE the install so the browser lands at a
# fixed, known location. /opt is chosen deliberately: a path under /var/cache
# would be shadowed on hosts that mount a persistent disk there, and a path
# under /root would be unreadable to UID 1000.
#
# `a+rX` (capital X) sets execute only on directories and on files that are
# already executable, so the browser binary stays runnable without marking every
# data file executable.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN python -m playwright install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# --- everything below belongs to the user ------------------------------------
USER user
WORKDIR $HOME/app

# The model cache. Under the user's home, because UID 1000 cannot write to
# /root -- which is what makes the difference between a working Space and one
# that dies on its first model download.
ENV HF_HOME=$HOME/.cache/huggingface

# Application code, owned on the way in.
COPY --chown=user ipl_auction_rag_backend/ ./

# The built console, at the path api/main.py computes (../../dist).
COPY --chown=user --from=frontend /build/dist $HOME/dist

# The ingestion source. JSON array form because the filename contains spaces;
# the shell form would read it as two arguments.
COPY --chown=user ["IPL AUCTION DATA.xlsx", "/home/user/"]

# Writable state directories. Created as the user so the first ingestion does
# not fail on a root-owned parent. On a host with a persistent disk these are
# redirected by environment variable instead.
RUN mkdir -p $HOME/app/data/raw $HOME/app/data/database/chroma_db \
    && mkdir -p $HOME/.cache/huggingface

# The entrypoint. Copied as root-owned and read-only to `user`: it is the one
# piece of the image that runs with root privileges (briefly, before it drops
# to `user`), so the unprivileged application must not be able to rewrite it.
#
# The `command -v setpriv` check fails the BUILD if a future base image drops
# util-linux, instead of every container failing at start with a bare
# "setpriv: not found".
USER root
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && command -v setpriv

# Documentation only. The real port comes from $PORT at runtime; Hugging Face
# Spaces routes to whatever `app_port` in README.md names.
EXPOSE 8001

# Exec form, so python is PID 1 and receives SIGTERM directly -- which is what
# lets the lifespan shutdown run and close the SCOUT checkpointer and the
# Postgres pool. A shell wrapper would swallow the signal and the container
# would be killed after its grace period on every deploy.
#
# `python api/main.py` rather than a uvicorn command line: the __main__ block in
# that file already reads $PORT, binds 0.0.0.0 and enables proxy headers, so the
# binding logic lives in one place instead of being duplicated here.
#
# Deliberately one worker and no reload: the auction room is in-process state,
# so a second worker would be a second, entirely separate auction.
#
# The container STARTS as root (the `USER root` above) and the entrypoint drops
# to `user` before this command runs -- see deploy/docker-entrypoint.sh for why
# Railway's root-owned volumes require that. Where the platform forces UID 1000
# (Hugging Face Spaces, `docker run --user 1000:1000`) the entrypoint simply
# execs this as-is.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "api/main.py"]
