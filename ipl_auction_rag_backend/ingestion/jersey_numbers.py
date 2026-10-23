"""
jersey_numbers.py
Keep every environment's squad numbers in step with data/jersey_numbers.json.

**Why a file and a sync, not a one-off write.** The players table is not in the
repository -- each deployment has its own (a local SQLite file, Supabase in
production), built once by ingestion. Numbers written straight into one of them
never reach the others: that is how this machine came to show 46 shirt numbers
while auctoniq.com showed 5. So the numbers live in a committed file and this
module applies it wherever the backend runs.

Applied at startup (api/main.py), after the quarterly stats refresh and after a
re-ingest, because a rebuilt table would otherwise lose them. Cheap enough for
all three: one read of the pool and a write only for rows that differ.

The file wins where it names a player. A player it does not name keeps whatever
the table holds -- usually null, which the cards render as the role rather than
an invented number.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from config.settings import get_settings

logger = logging.getLogger(__name__)


def numbers_path() -> Path:
    return Path(get_settings().PROJECT_ROOT) / "data" / "jersey_numbers.json"


def load_numbers() -> dict[str, int]:
    """Pool name -> squad number, from the committed file. Empty if it is missing."""
    path = numbers_path()
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(name): int(number)
        for name, number in (data.get("numbers") or {}).items()
        if isinstance(number, int) and 0 <= number <= 999
    }


def sync_jersey_numbers() -> int:
    """
    Write the file's numbers into the players table. Returns rows changed.

    Never raises: a missing file or an unreachable table costs the shirt
    numbers, not the caller's startup or refresh.
    """
    try:
        from db import get_player_db

        numbers = load_numbers()
        if not numbers:
            return 0
        player_db = get_player_db()
        changed = 0
        for row in player_db.get_all_players(10_000, 0):
            wanted = numbers.get(str(row.get("player_name") or ""))
            if wanted is not None and row.get("jersey_number") != wanted:
                changed += player_db.update_player_column(int(row["id"]), "jersey_number", wanted)
        if changed:
            logger.info("Jersey numbers: %d player(s) updated from %s", changed, numbers_path().name)
        return changed
    except Exception as exc:  # noqa: BLE001 - shirt numbers are not worth a failed startup
        logger.warning("Could not sync jersey numbers: %s", exc)
        return 0
