#!/bin/sh
# ==============================================================================
# docker-entrypoint.sh -- runs before `python api/main.py` in the container.
#
# Two jobs, both only needed on Railway, both no-ops everywhere else.
#
# 1. POINT DERIVED STATE AT THE RAILWAY VOLUME
#
#    Railway gives a service at most one volume and tells the container where it
#    is mounted through RAILWAY_VOLUME_MOUNT_PATH. Without this block every
#    deploy starts on the image's own filesystem: the ~1.2 GB of model weights
#    download again, the Chroma index is empty, and the SQLite ledger and SCOUT
#    checkpoints are gone. A value already set in the Railway dashboard wins --
#    this only fills in what is unset (or set to the empty string, which for a
#    path means "broken", not "default").
#
# 2. MAKE THAT VOLUME WRITABLE BY UID 1000
#
#    Railway mounts volumes owned by root. The application runs as `user`
#    (UID 1000, see the Dockerfile), so the first model download or Chroma write
#    would die with EACCES. So the container starts as root, fixes ownership of
#    the volume -- and ONLY the volume -- and then drops to `user` with setpriv
#    before the application starts. Nothing in the application ever runs as root.
#
#    Ownership is fixed only inside RAILWAY_VOLUME_MOUNT_PATH, deliberately.
#    docker-compose.yml bind-mounts the host's ~/.cache/huggingface; chowning
#    that would rewrite ownership of files on the developer's own machine.
#
# Hugging Face Spaces forces UID 1000 and never runs this as root, so it skips
# straight to the final exec, exactly as before this script existed.
#
# `exec` throughout, so python ends up as PID 1 and receives SIGTERM directly --
# the lifespan shutdown that closes the Postgres pool depends on that.
# ==============================================================================
set -eu

VOLUME="${RAILWAY_VOLUME_MOUNT_PATH:-}"
IMAGE_HF_HOME="/home/user/.cache/huggingface"

if [ -n "$VOLUME" ]; then
    # HF_HOME is always set (the Dockerfile sets it), so "unset" here means
    # "still the image default".
    if [ "${HF_HOME:-$IMAGE_HF_HOME}" = "$IMAGE_HF_HOME" ]; then
        HF_HOME="$VOLUME/huggingface"
    fi
    : "${CHROMA_DB_PATH:=$VOLUME/chroma_db}"
    : "${SQLITE_DB_PATH:=$VOLUME/ipl_auction.db}"
    : "${SCOUT_CHECKPOINT_PATH:=$VOLUME/scout_checkpoints.db}"
    export HF_HOME CHROMA_DB_PATH SQLITE_DB_PATH SCOUT_CHECKPOINT_PATH
fi

if [ "$(id -u)" = "0" ]; then
    if [ -n "$VOLUME" ] && [ -d "$VOLUME" ]; then
        # Only touch what is not already ours: after the first boot this finds
        # nothing, so restarts do not walk the whole model cache again.
        find "$VOLUME" \! -user user -exec chown user:user {} +
    fi
    exec setpriv --reuid=user --regid=user --init-groups -- "$@"
fi

exec "$@"
