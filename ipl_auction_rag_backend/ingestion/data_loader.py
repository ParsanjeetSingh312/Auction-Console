"""
data_loader.py
Orchestrates the dual data ingestion pipeline:
1. Excel → pandas → SQLite (structured stats)
2. Excel → synthetic text summaries → BGE embeddings → ChromaDB (vector search)
"""
import logging
import math
from typing import Any

import pandas as pd

from db.sqlite_manager import SQLiteManager
from db.chroma_manager import ChromaManager
from ingestion.excel_parser import parse_excel

logger = logging.getLogger(__name__)


def generate_player_summary(row: dict[str, Any]) -> str:
    """
    Generate a synthetic text summary for a player, used as the
    document text for vector embedding. Designed to capture semantic
    meaning for natural language searches.
    
    Args:
        row: Dictionary of player attributes.
    
    Returns:
        A rich natural language description of the player.
    """
    def num(key: str) -> float | None:
        """Read a numeric field, treating NaN and missing alike as absent."""
        value = row.get(key)
        if value is None:
            return None
        try:
            value = float(value)
        except (TypeError, ValueError):
            return None
        return None if math.isnan(value) else value

    name = row.get("player_name", "Unknown")
    role = row.get("role", "Unknown")
    cap_status = str(row.get("cap_status", "CAPPED"))
    overseas = "overseas" if row.get("overseas", 0) == 1 else "Indian"
    country = row.get("country") or "Unknown"

    parts = [f"{name} is a {cap_status.lower()} {overseas} {role} from {country}."]

    rating = num("rating")
    base_price = num("base_price")
    if rating is not None:
        parts.append(f"Auction rating: {rating}/10.")
    if base_price is not None:
        parts.append(f"Base price: ₹{int(base_price)} Lakh.")

    matches = num("matches")
    if matches is not None and matches > 0:
        parts.append(f"Has played {int(matches)} IPL matches.")
    elif matches == 0:
        # State this plainly so semantic queries for untested prospects match.
        parts.append(
            "Has no IPL match experience yet — an unproven uncapped prospect "
            "with no top-flight statistical record available."
        )

    # --- Batting record (present for Batter / Wicket Keeper / All-Rounder) ---
    total_runs, bat_avg, bat_sr = num("total_runs"), num("bat_avg"), num("bat_sr")
    if total_runs is not None and total_runs > 0:
        parts.append(f"Scored {int(total_runs)} runs.")

    batting = []
    if bat_avg is not None:
        batting.append(f"average {bat_avg:.2f}")
    if bat_sr is not None:
        batting.append(f"strike rate {bat_sr:.2f}")
    if batting:
        parts.append(f"Batting record: {', '.join(batting)}.")

    # Matchup splits vs spin and pace.
    matchups = []
    for key, label in (
        ("boundary_pct_spin", "boundary rate vs spin"),
        ("boundary_pct_fast", "boundary rate vs pace"),
    ):
        value = num(key)
        if value is not None:
            matchups.append(f"{value:.1f}% {label}")
    for key, label in (("sr_vs_spin", "spin"), ("sr_vs_fast", "pace")):
        value = num(key)
        if value is not None:
            matchups.append(f"strike rate {value:.1f} vs {label}")
    if matchups:
        parts.append(f"Matchups: {', '.join(matchups)}.")

    # --- Bowling record (present for Bowler rows) ---
    bowling = []
    wickets = num("wickets")
    if wickets is not None and wickets > 0:
        bowling.append(f"{int(wickets)} wickets")
    for key, label, fmt in (
        ("economy", "economy rate", "{:.2f}"),
        ("bowl_avg", "bowling average", "{:.2f}"),
        ("bowl_sr", "bowling strike rate", "{:.1f}"),
    ):
        value = num(key)
        if value is not None:
            bowling.append(f"{label} {fmt.format(value)}")
    econ_lhb, econ_rhb = num("econ_vs_lhb"), num("econ_vs_rhb")
    if econ_lhb is not None:
        bowling.append(f"economy vs left-hand batters {econ_lhb:.2f}")
    if econ_rhb is not None:
        bowling.append(f"economy vs right-hand batters {econ_rhb:.2f}")
    if bowling:
        parts.append(f"Bowling record: {', '.join(bowling)}.")

    # --- Qualitative traits, derived only from stats actually present ---
    # These give the embedding model natural-language handles ("finisher",
    # "anchor") that the raw numbers alone do not surface.
    traits: list[str] = []

    if role in ("Batter", "Wicket Keeper", "All-Rounder"):
        if bat_sr is not None and bat_sr >= 150:
            traits.append(
                "Explosive power hitter who scores at a very high rate, "
                "suited to finishing innings in the death overs"
            )
        elif bat_sr is not None and bat_sr >= 138:
            traits.append("Aggressive attacking batter who takes on the bowling")
        if bat_avg is not None and bat_avg >= 35:
            traits.append(
                "Reliable and consistent top-order anchor who builds innings"
            )
        spin_sr, pace_sr = num("sr_vs_spin"), num("sr_vs_fast")
        if spin_sr is not None and pace_sr is not None:
            if spin_sr - pace_sr >= 10:
                traits.append("Dominates spin bowling more than pace")
            elif pace_sr - spin_sr >= 10:
                traits.append("Stronger against pace bowling than spin")

    if role == "All-Rounder":
        traits.append(
            "High-utility all-rounder who contributes with both bat and ball "
            "and adds balance to team composition"
        )

    if role == "Bowler":
        economy = num("economy")
        bowl_avg = num("bowl_avg")
        if economy is not None and economy <= 8.0:
            traits.append(
                "Economical containment bowler who restricts scoring and dries up boundaries"
            )
        if bowl_avg is not None and bowl_avg <= 25.0:
            traits.append("Wicket-taking strike bowler with a strong bowling average")

    if traits:
        parts.append(". ".join(traits) + ".")

    return " ".join(parts)


def run_ingestion(
    excel_path: str | None = None,
    reset: bool = True,
) -> dict[str, int]:
    """
    Run the complete data ingestion pipeline.
    
    Args:
        excel_path: Optional path to Excel file.
        reset: If True, drops and recreates tables before inserting.
    
    Returns:
        Dict with counts: {"players_loaded": N, "vectors_created": N}
    """
    logger.info("Starting data ingestion pipeline...")
    
    # Step 1: Parse Excel
    df = parse_excel(excel_path)
    logger.info("Parsed %d players from Excel", len(df))
    
    # Step 2: Load into SQLite
    sqlite_mgr = SQLiteManager()
    if reset:
        sqlite_mgr.drop_tables()
    sqlite_mgr.create_tables()
    
    # Select only columns that match the SQLite schema
    db_columns = [
        "player_name", "country", "role", "cap_status", "overseas",
        "base_price", "rating", "matches", "total_runs",
        "bat_avg", "bat_sr", "boundary_pct_spin", "boundary_pct_fast",
        "sr_vs_spin", "sr_vs_fast",
        "wickets", "runs_conceded", "economy",
        "bowl_avg", "bowl_sr", "econ_vs_lhb", "econ_vs_rhb",
    ]
    available_db_cols = [c for c in db_columns if c in df.columns]
    db_df = df[available_db_cols].copy()
    
    # Replace NaN with None for SQLite
    db_df = db_df.where(db_df.notna(), None)
    
    players_loaded = sqlite_mgr.insert_players(db_df)
    logger.info("Loaded %d players into SQLite", players_loaded)
    
    # Step 3: Generate text summaries and load into ChromaDB
    chroma_mgr = ChromaManager()
    if reset:
        chroma_mgr.reset_collection()
    
    texts = []
    metadatas = []
    ids = []
    
    for idx, row in df.iterrows():
        row_dict = row.to_dict()
        
        # Generate synthetic text summary
        summary = generate_player_summary(row_dict)
        texts.append(summary)
        
        # Metadata for ChromaDB filtering
        metadata = {
            "player_name": str(row_dict.get("player_name", "Unknown")),
            "role": str(row_dict.get("role", "Unknown")),
            "cap_status": str(row_dict.get("cap_status", "CAPPED")),
            "overseas": int(row_dict.get("overseas", 0)),
            "sqlite_id": int(idx) + 1,  # 1-based to match SQLite AUTOINCREMENT
        }
        metadatas.append(metadata)
        ids.append(f"player_{idx + 1}")
    
    vectors_created = chroma_mgr.add_documents(texts, metadatas, ids)
    logger.info("Created %d vector embeddings in ChromaDB", vectors_created)
    
    result = {
        "players_loaded": players_loaded,
        "vectors_created": vectors_created,
    }
    logger.info("Ingestion complete: %s", result)
    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    result = run_ingestion()
    print(f"Ingestion complete: {result}")
