"""
trending.py
Build the landing's Trending Players list, fresh after every ingestion.

**Why.** Trending used to be six names hardcoded in the frontend
(utils/players.ts): the same Kohli, Rohit, Dhoni, Bumrah, Jadeja and Rahul on
every visit, with no way to follow trades or auction news. Now the list is
rebuilt whenever the pool changes, and the frontend reads it from
`GET /api/v1/trending`.

**How a list is built** (`build_trending`):

  1. **In the news first.** Every player named in `data/trending_players.json`
     (the file the team edits when trades or auction news happen) leads the
     list, carrying its tag, e.g. "Trade news".
  2. **A fresh mix for the rest.** The strongest players of each role (by IPL
     runs, wickets or both) form a shortlist, and a different selection is
     drawn from it on every build. The draw is seeded by the build time, so
     one build always gives the same list, and the next build a new one.
  3. **Roles take turns,** batter, bowler, all-rounder, keeper, so the deal
     never shows five openers in a row.

**Verified shirt numbers only.** The Trending cards are built around the jersey
number, so a player without a verified one (data/jersey_numbers.json) is left
out rather than shown with a guess.

Rebuilt at startup when no snapshot exists, after the quarterly stats refresh,
and after every re-ingest (scout/stats_refresh.py, api/routes.py). Never
raises: a failed build keeps the previous snapshot.
"""
from __future__ import annotations

import json
import logging
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config.settings import get_settings

logger = logging.getLogger(__name__)

#: Cards in the deal: the landing's strip shows six to eight comfortably.
COUNT = 8
#: How many of each role's strongest players the fresh mix draws from.
SHORTLIST_PER_ROLE = 10

ROLES = {
    "Batter": ("BAT", "Batter"),
    "Bowler": ("BOWL", "Bowler"),
    "All-Rounder": ("AR", "All-Rounder"),
    "Wicket Keeper": ("WK", "Wicket Keeper"),
}
#: The order roles take turns in.
TURN_ORDER = ("BAT", "BOWL", "AR", "WK")


def _data_dir() -> Path:
    return Path(get_settings().PROJECT_ROOT) / "data"


def curated_path() -> Path:
    return _data_dir() / "trending_players.json"


def snapshot_path() -> Path:
    return _data_dir() / "trending_snapshot.json"


def load_curated() -> list[dict[str, str]]:
    """The players in the news, in the file's order. Empty if the file is missing."""
    path = curated_path()
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [
        {"name": str(p["name"]), "tag": str(p.get("tag") or "In the news")}
        for p in data.get("players") or []
        if p.get("name")
    ]


# --- one card ------------------------------------------------------------------


def _num(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _stat(label: str, value: float | None, decimals: int = 0) -> dict[str, Any] | None:
    if value is None:
        return None
    return {"label": label, "value": round(value, decimals), "decimals": decimals}


def _sheet(role: str, row: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Six career figures, three a side, chosen to suit the role (as utils/playerStats.ts)."""
    m = lambda k: _num(row, k)  # noqa: E731 - a short local reader
    if role == "BOWL":
        left = [_stat("Matches", m("matches")), _stat("Wickets", m("wickets")), _stat("Economy", m("economy"), 2)]
        right = [_stat("Bowl average", m("bowl_avg"), 1), _stat("Econ vs LHB", m("econ_vs_lhb"), 2), _stat("Econ vs RHB", m("econ_vs_rhb"), 2)]
    elif role == "AR":
        left = [_stat("Matches", m("matches")), _stat("IPL runs", m("total_runs")), _stat("Strike rate", m("bat_sr"), 1)]
        right = [_stat("Wickets", m("wickets")), _stat("Economy", m("economy"), 2), _stat("Bowl average", m("bowl_avg"), 1)]
    else:
        left = [_stat("Matches", m("matches")), _stat("IPL runs", m("total_runs")), _stat("Average", m("bat_avg"), 2)]
        right = [_stat("Strike rate", m("bat_sr"), 1), _stat("SR vs pace", m("sr_vs_fast"), 1), _stat("SR vs spin", m("sr_vs_spin"), 1)]
    return {"left": [s for s in left if s], "right": [s for s in right if s]}


def _headline(role: str, row: dict[str, Any]) -> tuple[str, str]:
    """The one figure on the card face: runs for batters, wickets for bowlers."""
    runs, wickets = _num(row, "total_runs"), _num(row, "wickets")
    if role == "BOWL" or (role == "AR" and (wickets or 0) * 25 >= (runs or 0)):
        return (f"{int(wickets or 0):,}", "IPL wickets")
    return (f"{int(runs or 0):,}", "IPL runs")


def _card(row: dict[str, Any], tag: str | None) -> dict[str, Any] | None:
    role_info = ROLES.get(str(row.get("role") or ""))
    jersey = row.get("jersey_number")
    if role_info is None or not isinstance(jersey, int):
        return None
    role, role_label = role_info
    name = str(row["player_name"])
    first, _, surname = name.partition(" ")
    stat, stat_label = _headline(role, row)
    return {
        "name": name,
        "first_name": first,
        "surname": surname or first,
        "jersey": jersey,
        "role": role,
        "role_label": role_label,
        "country": row.get("country") or "",
        "tag": tag,
        "stat": stat,
        "stat_label": stat_label,
        "sheet": _sheet(role, row),
    }


def _strength(role: str, row: dict[str, Any]) -> float:
    """How a role's shortlist is ranked: IPL runs, wickets, or both."""
    runs = _num(row, "total_runs") or 0.0
    wickets = _num(row, "wickets") or 0.0
    if role == "BOWL":
        return wickets
    if role == "AR":
        return runs + 25 * wickets
    return runs


# --- the list ---------------------------------------------------------------------


def build_trending(*, seed: str | None = None, count: int = COUNT) -> dict[str, Any]:
    """Build the list from the current pool and save it as the snapshot."""
    from db import get_player_db

    built_at = datetime.now(timezone.utc).isoformat()
    seed = seed or built_at
    rows = get_player_db().get_all_players(10_000, 0)
    by_name = {str(r.get("player_name")): r for r in rows}

    players: list[dict[str, Any]] = []
    taken: set[str] = set()

    # 1. In the news.
    for entry in load_curated():
        row = by_name.get(entry["name"])
        card = _card(row, entry["tag"]) if row else None
        if card is None:
            logger.info("Trending: skipped %s (not in the pool, or no verified jersey number)", entry["name"])
            continue
        players.append(card)
        taken.add(card["name"])

    # 2. A fresh draw from each role's shortlist, 3. taking turns by role.
    rng = random.Random(seed)
    pools: dict[str, list[dict[str, Any]]] = {}
    for role in TURN_ORDER:
        candidates = [
            r for r in rows
            if ROLES.get(str(r.get("role") or ""), ("",))[0] == role
            and isinstance(r.get("jersey_number"), int)
            and str(r.get("player_name")) not in taken
        ]
        candidates.sort(key=lambda r: _strength(role, r), reverse=True)
        shortlist = candidates[:SHORTLIST_PER_ROLE]
        rng.shuffle(shortlist)
        pools[role] = shortlist

    while len(players) < count and any(pools.values()):
        for role in TURN_ORDER:
            if len(players) >= count:
                break
            if pools[role]:
                card = _card(pools[role].pop(), None)
                if card:
                    players.append(card)

    snapshot = {"built_at": built_at, "seed": seed, "count": len(players), "players": players}
    snapshot_path().write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("Trending: %d player(s), %d in the news", len(players), len(taken))
    return snapshot


def refresh_trending() -> int:
    """Rebuild after an ingestion or refresh. Returns the number of players; never raises."""
    try:
        return int(build_trending()["count"])
    except Exception as exc:  # noqa: BLE001 - Trending is not worth a failed ingestion
        logger.warning("Could not rebuild Trending Players: %s", exc)
        return 0


def load_trending() -> dict[str, Any]:
    """The saved list, building one first if none exists yet."""
    path = snapshot_path()
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("Trending snapshot unreadable; rebuilding it")
    return build_trending()
