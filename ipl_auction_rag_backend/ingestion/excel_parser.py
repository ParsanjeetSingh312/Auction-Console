"""
excel_parser.py
Parses and cleans the IPL Auction Player Pool Excel file.

IMPORTANT — the source sheet is category-polymorphic. It has 11 physical
columns whose MEANING changes depending on the row's Category:

  Batsman / Wicket Keeper / All Rounder (batting semantics)
    Matches | Total Runs | Bat Avg | Bat SR | Bnd% vs Spin | Bnd% vs Fast
    | SR vs Spin | SR vs Fast

  Bowler (bowling semantics — same physical columns, different data)
    Matches | Wickets | Runs Conceded | Economy | Bowl Avg | Econ split A
    | Econ split B | (unused)

Verified against known IPL records, e.g. Jasprit Bumrah:
    runs_conceded / economy = 4363 / 7.30 = 597.7 overs
        -> 158 matches ~ 3.8 overs per match (correct for a T20 quota bowler)
    runs_conceded / wickets = 4363 / 184 = 23.7
        -> matches the 23.8 in the 'Boundary % (vs Spin)' column
    Same identity holds for Starc (1245/51 = 24.4 vs 24.41) and
    Boult (3244/121 = 26.8 vs 26.81).

Reading bowler rows with batting semantics is what produced nonsense such as
"Bumrah bat_avg = 4363". This module therefore splits parsing by category.

Attributes genuinely absent from the sheet are left NULL rather than being
synthesised, so that downstream SQL and RAG answers only ever cite real data.
"""
import logging
import math
from pathlib import Path

import pandas as pd

from config.settings import get_settings

logger = logging.getLogger(__name__)

# Physical column order in the sheet, independent of meaning.
STAT_COLUMNS = [
    "Matches",
    "Total Runs",
    "Bat Avg",
    "Bat SR",
    "Boundary % (vs Spin)",
    "Boundary % (vs Fast)",
    "SR (vs Spin)",
    "SR (vs Fast)",
]

# Category -> internal role
ROLE_MAPPING = {
    "Batsman": "Batter",
    "Bowler": "Bowler",
    "All Rounder": "All-Rounder",
    "Wicket Keeper": "Wicket Keeper",
}

BATTING_ROLES = {"Batter", "Wicket Keeper", "All-Rounder"}


def _num(value: float | int | str | None) -> float | None:
    """Coerce a cell to float, returning None for blanks and non-numerics."""
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(result) else result


def _rate(value: float | None) -> float | None:
    """
    Coerce a rate-type stat (average, strike rate, economy, boundary %) where
    the sheet writes 0 to mean "no IPL record" rather than a true zero.

    68 uncapped players in the pool have never played an IPL match and carry 0
    across every stat column. A literal 0 would rank them as the most
    economical bowlers and best-average batters under ORDER BY ... ASC, so an
    absent record must be NULL instead.

    Counting stats (matches, runs, wickets) keep their 0 — for a player with no
    appearances that is factually correct.
    """
    if value is None or value == 0:
        return None
    return value


def _as_percent(value: float | None) -> float | None:
    """
    Normalise a boundary percentage to a 0-100 scale.
    The sheet stores batting boundary rates as fractions (0.185 -> 18.5%).
    """
    if value is None:
        return None
    return round(value * 100, 2) if value <= 1.0 else round(value, 2)


def _parse_batting_row(stats: list[float | None]) -> dict[str, float | None]:
    """Interpret the 8 stat columns using batting semantics."""
    matches, total_runs, bat_avg, bat_sr, bnd_spin, bnd_fast, sr_spin, sr_fast = stats
    return {
        "matches": matches,
        "total_runs": total_runs,
        "bat_avg": _rate(bat_avg),
        "bat_sr": _rate(bat_sr),
        "boundary_pct_spin": _as_percent(_rate(bnd_spin)),
        "boundary_pct_fast": _as_percent(_rate(bnd_fast)),
        "sr_vs_spin": _rate(sr_spin),
        "sr_vs_fast": _rate(sr_fast),
        # Bowling columns are not present for batting-semantics rows.
        "wickets": None,
        "runs_conceded": None,
        "economy": None,
        "bowl_avg": None,
        "bowl_sr": None,
        "econ_vs_lhb": None,
        "econ_vs_rhb": None,
    }


def _parse_bowling_row(stats: list[float | None]) -> dict[str, float | None]:
    """Interpret the 8 stat columns using bowling semantics."""
    matches, wickets, runs_conceded, economy, bowl_avg, econ_a, econ_b, _unused = stats
    economy, bowl_avg = _rate(economy), _rate(bowl_avg)
    econ_a, econ_b = _rate(econ_a), _rate(econ_b)

    # Bowling strike rate = balls bowled per wicket. Balls are recoverable
    # from runs conceded and economy: overs = runs / econ, balls = overs * 6.
    bowl_sr = None
    if runs_conceded and economy and wickets:
        balls = (runs_conceded / economy) * 6
        bowl_sr = round(balls / wickets, 1)

    return {
        "matches": matches,
        # A bowler's own batting record is not in this sheet.
        "total_runs": None,
        "bat_avg": None,
        "bat_sr": None,
        "boundary_pct_spin": None,
        "boundary_pct_fast": None,
        "sr_vs_spin": None,
        "sr_vs_fast": None,
        "wickets": wickets,
        "runs_conceded": runs_conceded,
        "economy": economy,
        "bowl_avg": bowl_avg,
        "bowl_sr": bowl_sr,
        # The sheet gives two economy splits but does not label which handedness
        # each belongs to. Assigned in the blueprint's column order (LHB, RHB).
        "econ_vs_lhb": econ_a,
        "econ_vs_rhb": econ_b,
    }


def parse_excel(file_path: str | None = None) -> pd.DataFrame:
    """
    Parse the IPL Auction Excel file into a DataFrame matching the SQLite
    players schema, applying per-category column semantics.

    Args:
        file_path: Path to the Excel file. Defaults to settings.

    Returns:
        Cleaned DataFrame ready for database insertion.
    """
    path = file_path or get_settings().EXCEL_FILE_PATH
    logger.info("Parsing Excel file: %s", path)

    raw = pd.read_excel(path, engine="openpyxl")
    raw = raw.dropna(how="all")

    known_pool = _load_known_pool_metadata()

    rows: list[dict] = []
    skipped = 0

    for _, excel_row in raw.iterrows():
        name = excel_row.get("Player Name")
        category = excel_row.get("Category")

        # Skip blanks and repeated header rows embedded in the sheet.
        if not isinstance(name, str) or not name.strip():
            skipped += 1
            continue
        name = name.strip()
        if name in ("Player Name", "Category") or category == "Category":
            skipped += 1
            continue

        role = ROLE_MAPPING.get(str(category).strip(), "Batter")

        tags = excel_row.get("Tags")
        tags_upper = tags.upper() if isinstance(tags, str) else ""
        overseas = 1 if "OV" in tags_upper else 0
        cap_status = "UNCAPPED" if "UC" in tags_upper else "CAPPED"

        stats = [_num(excel_row.get(col)) for col in STAT_COLUMNS]
        parsed = _parse_bowling_row(stats) if role == "Bowler" else _parse_batting_row(stats)

        # Auction metadata (country, base price, rating) comes from the Phase 1
        # player pool where available. It is not in the stats sheet.
        known = known_pool.get(name.lower(), {})
        if known.get("cap_status"):
            cap_status = known["cap_status"]

        rows.append({
            "player_name": name,
            "country": known.get("country") or ("Overseas" if overseas else "India"),
            "role": role,
            "cap_status": cap_status,
            "overseas": overseas,
            "base_price": known.get("base_price"),
            "rating": known.get("rating"),
            **parsed,
        })

    df = pd.DataFrame(rows)

    matched = df["base_price"].notna().sum()
    logger.info(
        "Parsed %d players (%d rows skipped). Roles: %s",
        len(df), skipped, df["role"].value_counts().to_dict(),
    )
    logger.info(
        "Auction metadata matched from Phase 1 pool for %d/%d players; "
        "the remainder have NULL base_price/rating.",
        matched, len(df),
    )
    return df


def _load_known_pool_metadata() -> dict[str, dict]:
    """
    Extract real auction metadata (country, base price, rating, cap status)
    for known players from the Phase 1 prototype's POOL_RAW table.
    """
    known: dict[str, dict] = {}
    try:
        html_path = Path(__file__).resolve().parent.parent.parent / "auction-console.html"
        if not html_path.exists():
            logger.warning("auction-console.html not found; base_price/rating will be NULL")
            return known

        import json
        import re

        content = html_path.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r"POOL_RAW\s*=\s*(\[.*?\]);", content, re.DOTALL)
        if not match:
            logger.warning("POOL_RAW not found in auction-console.html")
            return known

        for row in json.loads(match.group(1)):
            # [sno, set_no, set_code, first_name, surname, country, role,
            #  cap_status, base_price, rating]
            player = f"{row[3]} {row[4]}".strip().lower()
            known[player] = {
                "country": row[5],
                "base_price": row[8],
                "rating": row[9],
                "cap_status": str(row[7]).upper(),
            }
    except Exception as exc:
        logger.warning("Could not load POOL_RAW metadata: %s", exc)

    return known
