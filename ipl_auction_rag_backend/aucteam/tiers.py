"""
tiers.py
Which of the three AUCTEAM tiers a player sits in, and the six figures on the
face of their card.

THE TIERS
=========

    MQ  MARQUEE   veterans -- the names a franchise is built around
    PR  PRIME     high-impact players at the peak of their output
    EM  EMERGING  young prospects, short on matches, long on upside

Two sources, in strict order:

1. **Curated.** A short list of players whose tier is a judgement, not a
   statistic. MS Dhoni is UNCAPPED in this dataset (the IPL's retired-player
   rule) and a derivation that read cap status would file the most decorated
   wicketkeeper in the league's history as a prospect. The curated list is seeded
   into `aucteam_tier_overrides` and edited there, not here.
2. **Derived.** Everyone else, by IPL matches and cap status:

       150+ IPL matches                                  -> MQ
       uncapped, under 50 IPL matches                    -> EM
       capped Indian, 15 or fewer IPL matches            -> EM
       anything else                                     -> PR

   The dataset has no ages, so cap status stands in for career stage. A
   capped *overseas* player new to the IPL is an established international,
   not a prospect, and lands in PR; a capped Indian with a handful of IPL
   games (Mayank Yadav, Akash Deep) is the young international the EM tier
   means. Against the 284-player pool this gives 13 MQ / 159 PR / 112 EM --
   Marquee deliberately scarce, as a real auction's marquee set is. A player
   with no matches on record is treated as having none.

THE CARD FIGURES
================

Six per card, three either side of the jersey number. Batting rows (batters,
wicketkeepers, all-rounders) show the six the brief names. Bowlers carry no
batting columns in this dataset -- `players` stores bowling semantics for them
-- so a bowler's card shows the bowling equivalents rather than six dashes.
"""
from __future__ import annotations

import re
from typing import Any

from aucteam.aucteam_schema import (
    ROLE_FROM_DB,
    ROLE_NAMES,
    AucteamPlayer,
    CardStat,
    TierCode,
)

#: IPL matches at which a career reads as a veteran's.
MARQUEE_MATCHES = 150
#: An uncapped player under this many IPL matches is still emerging.
UNCAPPED_EMERGING_MATCHES = 50
#: A capped Indian player at or under this many IPL matches is still emerging.
CAPPED_EMERGING_MATCHES = 15

#: The brief's examples, seeded into aucteam_tier_overrides on first start.
#: Names absent from the pool (Vaibhav Sooryavanshi, at the time of writing)
#: stay listed: the override applies the day ingestion brings them in.
CURATED_TIERS: tuple[tuple[str, TierCode, str], ...] = (
    ("MS Dhoni", "MQ", "Veteran captain; uncapped only under the retired-player rule"),
    ("Virat Kohli", "MQ", "Veteran; the league's leading run-scorer"),
    ("Rohit Sharma", "MQ", "Veteran; five-time title-winning captain"),
    ("Sai Sudharsan", "PR", "High-impact top-order batter"),
    ("Abhishek Sharma", "PR", "High-impact opener"),
    ("Vaibhav Sooryavanshi", "PR", "High-impact opener"),
    ("Arshdeep Singh", "PR", "High-impact left-arm seamer"),
    ("Nitish Kumar Reddy", "EM", "Young seam-bowling all-rounder"),
    ("Sakib Hussain", "EM", "Young fast-bowling prospect"),
    ("Anshul Kamboj", "EM", "Young seam-bowling all-rounder"),
)


def name_key(name: str) -> str:
    """Lowercased letters only: 'M.S. Dhoni' and 'MS Dhoni' are one key."""
    return re.sub(r"[^a-z]", "", (name or "").lower())


def derive_tier(row: dict[str, Any]) -> tuple[TierCode, str]:
    """The stats-based tier for one players-table row, with the reason in words."""
    matches = int(row.get("matches") or 0)
    capped = str(row.get("cap_status") or "CAPPED").upper() == "CAPPED"
    overseas = bool(row.get("overseas"))
    played = f"{matches} IPL matches" if matches else "No IPL matches yet"

    if matches >= MARQUEE_MATCHES:
        return "MQ", played
    if not capped and matches < UNCAPPED_EMERGING_MATCHES:
        return "EM", f"Uncapped, {played[0].lower()}{played[1:]}"
    if capped and not overseas and matches <= CAPPED_EMERGING_MATCHES:
        return "EM", f"Young international, {played[0].lower()}{played[1:]}"
    return "PR", played


def resolve_tier(
    row: dict[str, Any], overrides: dict[str, tuple[TierCode, str]]
) -> tuple[TierCode, str, str]:
    """(tier, source, reason): the curated tier if there is one, else derived."""
    curated = overrides.get(name_key(row.get("player_name", "")))
    if curated:
        return curated[0], "curated", curated[1]
    tier, reason = derive_tier(row)
    return tier, "derived", reason


def _num(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def card_stats(row: dict[str, Any], role: str) -> list[CardStat]:
    """Six figures in card order: left column top to bottom, then right."""
    if role == "BWL":
        return [
            CardStat(key="matches", label="Matches", value=_num(row, "matches")),
            CardStat(key="wickets", label="Wickets", value=_num(row, "wickets")),
            CardStat(key="economy", label="Economy", value=_num(row, "economy"), format="dec2"),
            CardStat(key="bowl_avg", label="Bowl Avg", value=_num(row, "bowl_avg"), format="dec1"),
            CardStat(key="bowl_sr", label="Bowl SR", value=_num(row, "bowl_sr"), format="dec1"),
            CardStat(key="econ_vs_lhb", label="Econ v LHB", value=_num(row, "econ_vs_lhb"), format="dec2"),
        ]
    return [
        CardStat(key="matches", label="Matches", value=_num(row, "matches")),
        CardStat(key="total_runs", label="IPL Runs", value=_num(row, "total_runs")),
        CardStat(key="bat_avg", label="Average", value=_num(row, "bat_avg"), format="dec1"),
        CardStat(key="bat_sr", label="Strike Rate", value=_num(row, "bat_sr"), format="dec1"),
        CardStat(key="sr_vs_fast", label="SR v Pace", value=_num(row, "sr_vs_fast"), format="dec1"),
        CardStat(key="sr_vs_spin", label="SR v Spin", value=_num(row, "sr_vs_spin"), format="dec1"),
    ]


def to_card(row: dict[str, Any], overrides: dict[str, tuple[TierCode, str]]) -> AucteamPlayer | None:
    """
    One players-table row as an AUCTEAM card, or None for a row with a role
    AUCTEAM does not recognise -- skipped rather than guessed at.
    """
    role = ROLE_FROM_DB.get(str(row.get("role") or ""))
    if role is None:
        return None
    tier, source, reason = resolve_tier(row, overrides)
    jersey = row.get("jersey_number")
    matches = row.get("matches")
    return AucteamPlayer(
        id=int(row["id"]),
        name=str(row["player_name"]),
        role=role,
        role_label=ROLE_NAMES[role],
        tier=tier,
        tier_source=source,  # type: ignore[arg-type]
        tier_reason=reason,
        jersey_number=int(jersey) if jersey is not None else None,
        country=str(row.get("country") or "Unknown"),
        overseas=bool(row.get("overseas")),
        capped=str(row.get("cap_status") or "CAPPED").upper() == "CAPPED",
        rating=_num(row, "rating"),
        matches=int(matches) if matches is not None else None,
        stats=card_stats(row, role),
    )
