"""
aucteam_schema.py
The shape of AUCTEAM: its two tables, its roster rules, and every payload that
crosses the wire.

WHAT AUCTEAM IS
===============

A fantasy team builder. The user drags cards out of the 284-player pool into an
eleven-slot board, and once the eleventh lands, SCOUT writes a report on the
side they picked: balance, experience against youth, the gaps, and what they
would have been better off avoiding.

THE TWO TABLES
==============

`aucteam_tier_overrides` holds the *curated* tiers and nothing else. Every
other player's tier is derived on read from the players table (see tiers.py).
Persisting the derived tiers as well would freeze them: re-ingest a season of
stats and a 19-match prospect who has since played 40 would still be filed as
EMERGING. Storing only the human decisions keeps the table small and keeps the
derivation honest.

Keyed on a normalised player name, not on `players.id`. Ingestion rebuilds the
players table and the Supabase copy numbers its rows independently, so an id is
not a stable identity across either; the name is what both share.

`aucteam_reports` keeps every report SCOUT writes, with the roster and metrics
it was written from. A report is a claim about a specific eleven, and storing
it beside that eleven is what makes it checkable later.

Both tables live in the local SQLite file whatever DATABASE_URL says, for the
same reason SCOUT's checkpointer does: they are AUCTEAM's own state, not part
of the shared players table, and they have no business on a remote database.

THE ROSTER RULES
================

Two kinds, and the difference matters to the UI.

* **Hard rules** refuse a roster. Eleven players, no duplicates, at least one
  wicketkeeper, at most four overseas players -- the last two are the real IPL
  playing-XI rules, so a team that breaks them is not a team.
* **Role bands** are advice. Three to five batters is a sound shape; two is not
  illegal, it is a gamble, and the report should say so rather than refuse it.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

TierCode = Literal["MQ", "PR", "EM"]
RoleCode = Literal["BAT", "WK", "AR", "BWL"]
Severity = Literal["block", "warn", "info"]
AnswerMode = Literal["llm", "local_analyst"]

#: Display names for the three tiers, keyed by the two-letter card label.
TIER_NAMES: dict[str, str] = {
    "MQ": "Marquee",
    "PR": "Prime",
    "EM": "Emerging",
}

#: The players table spells roles four ways; AUCTEAM speaks in four codes.
ROLE_FROM_DB: dict[str, RoleCode] = {
    "Batter": "BAT",
    "Wicket Keeper": "WK",
    "All-Rounder": "AR",
    "Bowler": "BWL",
}

ROLE_NAMES: dict[str, str] = {
    "BAT": "Batter",
    "WK": "Wicketkeeper",
    "AR": "All-Rounder",
    "BWL": "Bowler",
}

# ---------------------------------------------------------------------------
# Roster rules
# ---------------------------------------------------------------------------

SQUAD_SIZE = 11
MAX_OVERSEAS = 4
MIN_WICKETKEEPERS = 1

#: Soft bands per role: (fewest that is sound, most that is sound). Inside the
#: band is silent; outside it raises a warning, never a refusal.
ROLE_BANDS: dict[str, tuple[int, int]] = {
    "BAT": (3, 5),
    "WK": (1, 2),
    "AR": (1, 3),
    "BWL": (3, 5),
}

#: A T20 side needs twenty overs. Bowlers and all-rounders are the players who
#: can bowl them; five is the floor that leaves no one bowling out of turn.
MIN_BOWLING_OPTIONS = 5

# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

CREATE_TIER_OVERRIDES = """
CREATE TABLE IF NOT EXISTS aucteam_tier_overrides (
    name_key     TEXT PRIMARY KEY,           -- normalised: lowercased, letters only
    player_name  TEXT NOT NULL,              -- as written, for humans reading the table
    tier         TEXT NOT NULL CHECK (tier IN ('MQ', 'PR', 'EM')),
    reason       TEXT,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""

CREATE_REPORTS = """
CREATE TABLE IF NOT EXISTS aucteam_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name     TEXT,
    roster_json   TEXT NOT NULL,             -- the eleven, as served to the card grid
    metrics_json  TEXT NOT NULL,             -- what the report was computed from
    report_json   TEXT NOT NULL,             -- the report itself
    mode          TEXT NOT NULL CHECK (mode IN ('llm', 'local_analyst')),
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""

SCHEMA_STATEMENTS: tuple[str, ...] = (CREATE_TIER_OVERRIDES, CREATE_REPORTS)

# ---------------------------------------------------------------------------
# The pool, as cards
# ---------------------------------------------------------------------------


class CardStat(BaseModel):
    """
    One figure flanking the jersey number.

    `value` is None when the dataset does not hold it, and the card prints a
    dash. It is never zero-filled: a bowler with no batting average has not
    averaged zero.
    """

    key: str
    label: str
    value: float | None = None
    #: How the card renders it: "int" (264), "dec1" (39.1), "dec2" (8.75).
    format: Literal["int", "dec1", "dec2"] = "int"


class AucteamPlayer(BaseModel):
    """A pool row, reshaped for a card."""

    id: int
    name: str
    role: RoleCode
    role_label: str
    tier: TierCode
    #: "curated" for a hand-picked tier, "derived" for one computed from stats.
    tier_source: Literal["curated", "derived"]
    tier_reason: str
    jersey_number: int | None = None
    country: str = "Unknown"
    overseas: bool = False
    capped: bool = True
    rating: float | None = None
    matches: int | None = None
    #: Six figures, in card order: three on the left, three on the right.
    stats: list[CardStat]


class RosterRules(BaseModel):
    """The rules, served so the client never hardcodes a second copy."""

    squad_size: int = SQUAD_SIZE
    max_overseas: int = MAX_OVERSEAS
    min_wicketkeepers: int = MIN_WICKETKEEPERS
    min_bowling_options: int = MIN_BOWLING_OPTIONS
    role_bands: dict[str, tuple[int, int]] = Field(default_factory=lambda: dict(ROLE_BANDS))


class PoolResponse(BaseModel):
    total: int
    players: list[AucteamPlayer]
    tier_counts: dict[str, int]
    rules: RosterRules = Field(default_factory=RosterRules)


# ---------------------------------------------------------------------------
# The eleven, inbound
# ---------------------------------------------------------------------------


class TeamPayload(BaseModel):
    """
    A roster in progress: one to eleven player ids.

    Only ids travel. Role, tier, overseas status and every statistic are looked
    up server-side, so a client cannot submit a "bowler" who is a batter or an
    "emerging" player with 250 caps -- there is no field in which to say so.
    """

    team_name: str | None = Field(default=None, max_length=40)
    player_ids: list[int] = Field(min_length=1, max_length=SQUAD_SIZE)

    @field_validator("player_ids")
    @classmethod
    def _no_duplicates(cls, ids: list[int]) -> list[int]:
        if len(set(ids)) != len(ids):
            raise ValueError("A player can only be picked once.")
        return ids

    @field_validator("team_name")
    @classmethod
    def _tidy_name(cls, name: str | None) -> str | None:
        if name is None:
            return None
        name = " ".join(name.split())
        return name or None


class ReportRequest(TeamPayload):
    """The finished eleven. Exactly SQUAD_SIZE ids, or the report is refused."""

    @field_validator("player_ids")
    @classmethod
    def _exactly_eleven(cls, ids: list[int]) -> list[int]:
        if len(ids) != SQUAD_SIZE:
            raise ValueError(
                f"A team report needs exactly {SQUAD_SIZE} players; got {len(ids)}."
            )
        return ids


# ---------------------------------------------------------------------------
# What comes back
# ---------------------------------------------------------------------------


class RosterIssue(BaseModel):
    severity: Severity
    code: str
    message: str


class TeamMetrics(BaseModel):
    """Every number the report is allowed to talk about."""

    size: int
    role_counts: dict[str, int]
    tier_counts: dict[str, int]
    overseas: int
    uncapped: int
    total_matches: int
    avg_matches: float
    #: Share of the eleven in the MQ tier, 0-1.
    marquee_share: float
    #: Share in the EM tier, 0-1.
    emerging_share: float
    #: Bowlers plus all-rounders.
    bowling_options: int
    #: Players with a recorded batting strike rate of 140 or more.
    power_hitters: int
    #: Top-order quality: mean batting average of the best four bats picked.
    top_order_avg: float | None = None
    #: Mean economy across picked bowlers with one on record.
    bowling_economy: float | None = None
    #: The two eras of the side, for the experience-vs-youth gauge.
    most_capped: str | None = None
    least_capped: str | None = None


class ValidateResponse(BaseModel):
    """The live check, run on every change to the board."""

    metrics: TeamMetrics
    issues: list[RosterIssue]
    complete: bool
    #: True when no `block` issue stands, so a report may be requested.
    legal: bool
    #: A question for SCOUT with this roster written into it. The SCOUT dock
    #: hands it to the drawer as a draft, so the user can edit before sending.
    scout_prompt: str


class ReportSection(BaseModel):
    title: str
    #: One line, shown large: the section's verdict before its argument.
    verdict: str
    body: str


class TeamReport(BaseModel):
    report_id: int | None = None
    team_name: str | None = None
    #: A to D. Derived from the metrics by rule in both modes, so the grade is
    #: the same whichever model wrote the prose.
    grade: Literal["A", "B", "C", "D"]
    score: int = Field(ge=0, le=100)
    headline: str
    summary: str
    balance: ReportSection
    experience: ReportSection
    strengths: list[str]
    missing_links: list[str]
    avoidable: list[str]
    mode: AnswerMode
    #: Each fallback that fired, named rather than hidden.
    notes: list[str] = Field(default_factory=list)
    metrics: TeamMetrics
    issues: list[RosterIssue] = Field(default_factory=list)
    roster: list[AucteamPlayer]
