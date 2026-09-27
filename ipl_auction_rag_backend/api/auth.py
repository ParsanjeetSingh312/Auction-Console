"""
auth.py
The admin gate for the destructive and expensive endpoints.

Most of the API is deliberately open: the console reads the player pool, the room
state and the report without credentials, because a spectator's screen needs
them. Two endpoints are not like the others --

  * POST /api/v1/ingest          rebuilds the whole player pool (reset=True by
                                  default), so an unauthenticated one lets anyone
                                  who can reach the API wipe it;
  * POST /api/v1/scout/research  spends a real scrape-and-embed budget.

-- and both are gated by an admin key.

The key lives in `settings.ADMIN_API_KEY`, read from the environment and sent by
the caller as the `X-Admin-Key` header. It is compared in constant time and never
logged.

**Unset means OPEN, with a warning.** Local development uses `POST /ingest`
routinely, and forcing a key there would break the everyday workflow. So an unset
key leaves the gate open but logs a warning on every call, which keeps local use
unchanged while making a deployment that forgot to set one noisy rather than
silently unprotected. Setting the key closes the gate.
"""
from __future__ import annotations

import logging
import secrets

from fastapi import Header, HTTPException, status

from config.settings import get_settings

logger = logging.getLogger("api.auth")


async def require_admin(x_admin_key: str | None = Header(default=None)) -> None:
    """FastAPI dependency: allow the request only if the admin key matches."""
    required = get_settings().ADMIN_API_KEY

    if not required:
        logger.warning(
            "ADMIN_API_KEY is not set — an admin endpoint was reached with no "
            "authentication. Set ADMIN_API_KEY before deploying."
        )
        return

    if not x_admin_key or not secrets.compare_digest(x_admin_key, required):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication required.",
        )
