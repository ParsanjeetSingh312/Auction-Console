"""
hf_runtime.py
Hugging Face runtime configuration, applied before any model library loads.

Three things this fixes, all visible in the startup log:

1. **Nineteen seconds of network revalidation.** Both models are already on
   disk, but the Hub client still issues a HEAD request per config file to
   check for updates. That is dead time on every boot, and it makes startup
   depend on huggingface.co being reachable — a local, CPU-only pipeline should
   not fail because a CDN is down. When the cache is complete this switches the
   client to offline mode and the models load straight from disk.

2. **"You are sending unauthenticated requests to the HF Hub."** That warning
   is the Hub telling you it is rate-limiting anonymous traffic. Offline mode
   removes the requests entirely; `HUGGINGFACE_API_KEY` in .env is honoured for
   the first download, when requests do have to go out.

3. **Progress bars in the server log.** `Loading weights: 100%|####...` is fine
   in a terminal and noise in a log file.

Import order matters. `huggingface_hub` reads several of these variables into
module constants at import time, so this module must be imported before
`sentence_transformers`, `transformers`, or any LangChain embedding class. The
loaders in this package do that, and the cache check here is a plain
filesystem test precisely so that it needs no Hub import of its own.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

#: Set this to any truthy value to force network mode — needed to download a
#: model for the first time, or to pick up an updated revision.
FORCE_ONLINE_VAR = "HF_FORCE_ONLINE"

#: The files sentence-transformers needs before a model can load from disk. A
#: directory that exists but is missing these is a half-finished download, and
#: going offline against it would fail at load time instead of re-fetching.
_REQUIRED_MARKERS = ("config.json",)

#: The mode chosen on the first call. Both model loaders configure at import
#: time, so without this the same decision is made — and logged — twice per
#: process. The environment variables are process-wide, so doing the work once
#: is not merely quieter, it is the correct scope.
_RESOLVED: str | None = None


def _cache_root() -> Path:
    """Where the Hub keeps models, honouring the usual overrides."""
    explicit = os.environ.get("HF_HUB_CACHE")
    if explicit:
        return Path(explicit)

    home = os.environ.get("HF_HOME")
    if home:
        return Path(home) / "hub"

    return Path.home() / ".cache" / "huggingface" / "hub"


def _repo_dir(model_name: str) -> Path:
    """The Hub's on-disk folder name for a repo id: BAAI/x -> models--BAAI--x."""
    return _cache_root() / f"models--{model_name.replace('/', '--')}"


def is_cached(model_name: str) -> bool:
    """
    True when `model_name` looks completely downloaded.

    Checks for the config inside a snapshot rather than merely that the folder
    exists, so an interrupted download is treated as absent.
    """
    repo = _repo_dir(model_name)
    snapshots = repo / "snapshots"
    if not snapshots.is_dir():
        return False

    for snapshot in snapshots.iterdir():
        if not snapshot.is_dir():
            continue
        if all((snapshot / marker).exists() for marker in _REQUIRED_MARKERS):
            return True
    return False


def configure(
    model_names: tuple[str, ...], hf_token: str = "", *, force: bool = False
) -> str:
    """
    Apply the runtime settings and report which mode was chosen.

    Returns "offline", "online", or "forced-online" so the caller can log it.
    Idempotent: repeat calls return the first result without redoing the work,
    unless `force` is set. Never raises — a misconfigured cache should fall back
    to a slow load, not a crashed server.
    """
    global _RESOLVED
    if _RESOLVED is not None and not force:
        return _RESOLVED

    # Progress bars are for humans at a terminal, not for a log file.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    # Telemetry adds another network call to a pipeline that wants none.
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    # A token only matters when requests actually go out, but setting it early
    # means the first download is authenticated rather than rate-limited.
    token = (hf_token or "").strip()
    if token and not os.environ.get("HF_TOKEN"):
        os.environ["HF_TOKEN"] = token

    if os.environ.get(FORCE_ONLINE_VAR):
        os.environ.pop("HF_HUB_OFFLINE", None)
        logger.info("HF: online (forced by %s)", FORCE_ONLINE_VAR)
        _RESOLVED = "forced-online"
        return _RESOLVED

    try:
        missing = [name for name in model_names if not is_cached(name)]
    except OSError as exc:
        logger.warning("HF: could not inspect the model cache (%s); staying online", exc)
        _RESOLVED = "online"
        return _RESOLVED

    if missing:
        os.environ.pop("HF_HUB_OFFLINE", None)
        logger.info(
            "HF: online - %s not in the cache at %s; it will download on first use.",
            ", ".join(missing),
            _cache_root(),
        )
        _RESOLVED = "online"
        return _RESOLVED

    os.environ["HF_HUB_OFFLINE"] = "1"
    logger.info(
        "HF: offline - all %d model(s) cached at %s, loading from disk.",
        len(model_names),
        _cache_root(),
    )
    _RESOLVED = "offline"
    return _RESOLVED


def configure_from_settings(*, force: bool = False) -> str:
    """Configure using the models named in settings. Safe to call repeatedly."""
    # Imported here rather than at module scope so that importing this module
    # has no side effects beyond what `configure` explicitly does.
    from config.settings import get_settings

    settings = get_settings()
    return configure(
        (settings.EMBEDDING_MODEL_NAME, settings.RERANKER_MODEL_NAME),
        settings.HUGGINGFACE_API_KEY,
        force=force,
    )
