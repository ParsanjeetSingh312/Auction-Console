"""
player.py
What the Data Researcher is allowed to say about a player.

These models exist to stand between a scraped web page and the `players` table.
That table is read on every bid by `auction/room.py`, which caches it at startup,
and it is the source for all 284 rows of the console's pool -- so the cost of a
bad write is not a wrong number on a page, it is an auction running on data the
clients disagree with.

Three ideas do most of the work here.

**Identity is not modelled, so it cannot be written.** There is no field on any
model below for `player_name`, `role`, `cap_status` or `overseas`. Those four
come from the auction spreadsheet, the room caches them, and a scrape that
"corrected" a role mid-auction would leave the room bidding on a batter the
console is drawing as a bowler. Leaving them out of the schema is a stronger
guarantee than a rule in the pipeline that someone can later forget.

**Valuation is separated from observation.** `base_price` and `rating` are
auction-facing: the room reads base prices to open a lot. They are also the
emptiest columns in the table -- null for 191 of 284 players, which is most of
the reason the Researcher exists. So they get their own model and their own
rule (fill, never overwrite; never while a lot is live), rather than sitting
next to a strike rate that is safe to refresh whenever.

**Every number has a bound.** The likeliest failure in this whole pipeline is
not a network error, it is a misparsed table cell -- a column offset by one, a
footnote marker glued to a digit, a career total read as an innings score. Those
arrive as plausible-looking floats and are invisible once stored. The bounds
below are drawn wide enough to admit a genuinely new record and narrow enough
that misalignment fails validation instead of entering the pool. They are
derived from what the table actually holds today, noted per field.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

#: The four roles in `players.role`, verified against the live table. A Literal
#: rather than a str because a scrape that invents "Allrounder" should fail here
#: rather than create a fifth role nothing filters on.
Role = Literal["Batter", "Bowler", "All-Rounder", "Wicket Keeper"]

#: `players.cap_status` holds exactly these two.
CapStatus = Literal["CAPPED", "UNCAPPED"]

#: How a fact reached us. Recorded because the two are not equally trustworthy:
#: a scrape read a specific element on a named page, a search fallback read a
#: snippet an engine chose. The advisor should be able to tell them apart.
Method = Literal["scrape", "search"]


class SourceRef(BaseModel):
    """
    Where a fact came from, and when.

    Carried on every model below rather than stored once per batch, because
    facts are merged from several sources and then re-sorted by player. Once a
    fact is separated from its origin there is no way to age it out, no way to
    prefer a stats portal over a blog, and no way for the advisor to say "as of
    Tuesday" -- which is the difference between a recommendation and a guess.
    """

    #: The key from config/sources.yaml, not the domain. Sites move.
    source_id: str = Field(min_length=1, max_length=64)
    url: str = Field(min_length=1, max_length=2048)
    method: Method
    retrieved_at: datetime

    #: 0-1. How much the extractor trusts its own read of this page: a clean
    #: table cell scores high, a number recovered from prose scores low. The
    #: pipeline uses it to break ties when two sources disagree.
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class PlayerMatch(BaseModel):
    """
    The link between a name on a web page and a row in `players`.

    Kept explicit, and allowed to fail, because it is the step most likely to go
    quietly wrong. Pages write "V Kohli", "Virat Kohli" and "Kohli, V" for one
    person, and two players in this pool share a surname. An unresolved match is
    a normal outcome that parks the fact for review; a *wrong* match writes one
    player's form onto another's record, where nothing will ever flag it.
    """

    #: Exactly as the page spelled it, never normalised. Kept so a bad match can
    #: be diagnosed later without re-fetching the page.
    raw_name: str = Field(min_length=1, max_length=120)

    #: None when the name could not be resolved. The pipeline must treat this as
    #: "hold", not as "insert a new player" -- the pool is fixed by the auction
    #: spreadsheet and SCOUT does not add to it.
    player_id: int | None = Field(default=None, ge=1)

    #: The `players.player_name` that `player_id` points at. Redundant on
    #: purpose: it makes a mismatched id visible on inspection.
    resolved_name: str | None = Field(default=None, max_length=120)

    #: 0-1. Below the pipeline's threshold the update is held rather than applied.
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)

    @field_validator("resolved_name")
    @classmethod
    def _resolved_name_needs_an_id(cls, v: str | None, info) -> str | None:
        # A name without an id is a claim with nothing behind it, and reads as a
        # successful match at a glance.
        if v is not None and info.data.get("player_id") is None:
            raise ValueError("resolved_name set without player_id")
        return v


class PlayerStatUpdate(BaseModel):
    """
    Observed cricket statistics, safe to refresh whenever.

    Every field is optional: a page about a bowler says nothing about strike
    rate against spin, and a partial update is the normal case rather than an
    error. None means "this source did not say", which is different from zero
    and must not be flattened into it.

    Ranges in the comments are what `players` holds today across 284 rows.
    """

    # --- match volume ---            table: 0 - 264
    matches: int | None = Field(default=None, ge=0, le=500)

    # --- batting ---                 table: 0 - 7,697
    total_runs: int | None = Field(default=None, ge=0, le=20_000)
    #                                 table: 1.0 - 48.63
    bat_avg: float | None = Field(default=None, ge=0, le=100)
    #                                 table: 33.33 - 234.04. A T20 innings can
    #                                 spike far above a career figure, so the
    #                                 ceiling is well clear of the observed max.
    bat_sr: float | None = Field(default=None, ge=0, le=400)
    #                                 table: 3.5 - 34.2; a percentage either way
    boundary_pct_spin: float | None = Field(default=None, ge=0, le=100)
    boundary_pct_fast: float | None = Field(default=None, ge=0, le=100)
    #                                 table: 30.0 - 248.6
    sr_vs_spin: float | None = Field(default=None, ge=0, le=400)
    sr_vs_fast: float | None = Field(default=None, ge=0, le=400)

    # --- bowling ---                 table: 0 - 205
    wickets: int | None = Field(default=None, ge=0, le=500)
    #                                 table: 0 - 4,845
    runs_conceded: int | None = Field(default=None, ge=0, le=20_000)
    #                                 table: 6.98 - 14.0. Twenty is already
    #                                 absurd for a career economy; past thirty
    #                                 the cell was not an economy.
    economy: float | None = Field(default=None, ge=0, le=30)
    #                                 table: 15.0 - 88.0
    bowl_avg: float | None = Field(default=None, ge=0, le=200)
    #                                 table: 11.1 - 40.0
    bowl_sr: float | None = Field(default=None, ge=0, le=200)
    #                                 table: 6.85 - 14.5
    econ_vs_lhb: float | None = Field(default=None, ge=0, le=30)
    econ_vs_rhb: float | None = Field(default=None, ge=0, le=30)

    def populated(self) -> dict[str, float | int]:
        """
        Only the fields this source actually reported.

        The pipeline writes from this rather than from the model, so a None
        never overwrites a value the spreadsheet already holds.
        """
        return {k: v for k, v in self.model_dump().items() if v is not None}


class PlayerValuation(BaseModel):
    """
    `base_price` and `rating` -- the two auction-facing columns.

    Separate from PlayerStatUpdate because they carry a different rule. The room
    reads base prices to open a lot and caches the pool at startup, so an
    overwrite mid-auction desynchronises the server from every client. And both
    are null for 191 of the 284 rows, which makes filling them the single most
    useful thing the Researcher can do.

    The rule the pipeline enforces, stated here because this is where a reader
    will look for it: **fill only where the column is NULL, and never while the
    room's phase is anything but lobby or finished.** `api/routes.py` already
    refuses to refresh the room's pool mid-auction for the same reason.
    """

    #: Lakh. BASE_PRICE_FLOOR in auction/room.py is 30 and the table tops out at
    #: 200; the ceiling here allows for a pool with bigger names in it without
    #: admitting a figure that was really a career run tally.
    base_price: float | None = Field(default=None, ge=30, le=2_000)

    #: The table holds 8.25 - 9.75, assigned to roughly the top third only. The
    #: full 0-10 is allowed because a scale that only ever emits 8+ is not a
    #: scale, and a future source may rate the rest of the pool.
    rating: float | None = Field(default=None, ge=0, le=10)

    def populated(self) -> dict[str, float]:
        """Only the fields this source actually reported."""
        return {k: v for k, v in self.model_dump().items() if v is not None}


class PlayerFact(BaseModel):
    """
    Something said about a player in prose -- form, an injury, a transfer note.

    This is what reaches the vector store. The existing `ipl_players` collection
    holds one synthetic summary per player built from the spreadsheet; these go
    into a separate collection, so re-ingesting the spreadsheet cannot delete
    research. `text` is the string that gets embedded, so it should read as a
    sentence about a person and not as a fragment of a page.
    """

    kind: Literal["form", "injury", "availability", "news", "valuation"]

    #: Embedded as written. Bounded because an unbounded scrape occasionally
    #: returns an entire page, which embeds into noise and costs a model call.
    text: str = Field(min_length=10, max_length=2_000)

    #: When the fact was true, when the page said so. Distinct from
    #: `source.retrieved_at`, which is when we read it: a three-year-old injury
    #: report fetched this morning is fresh by one measure and useless by the
    #: other.
    as_of: datetime | None = None

    source: SourceRef


class PlayerUpdate(BaseModel):
    """
    One player's worth of research, from one pass.

    The unit the Data Researcher emits and the RAG pipeline consumes. Stats and
    valuation go to SQLite; facts go to the vector store; the match decides
    whether any of it is applied at all.
    """

    match: PlayerMatch
    stats: PlayerStatUpdate = Field(default_factory=PlayerStatUpdate)
    valuation: PlayerValuation = Field(default_factory=PlayerValuation)
    facts: list[PlayerFact] = Field(default_factory=list)
    source: SourceRef

    def is_empty(self) -> bool:
        """
        True when this update would write nothing.

        A page can parse cleanly, resolve to a real player and still carry no
        new information. Saying so here keeps that out of the logs as a
        non-event rather than a failure.
        """
        return not (self.stats.populated() or self.valuation.populated() or self.facts)


class ResearchBatch(BaseModel):
    """
    Everything one research pass produced, successes and failures together.

    The failures travel with the results deliberately. A pass that scraped six
    sources, was refused by two and resolved no name on a third has not
    succeeded, and a caller that only ever sees the updates cannot tell that
    from a pass that found nothing to report.
    """

    updates: list[PlayerUpdate] = Field(default_factory=list)

    #: Names that reached the extractor but matched no row in `players`. Held
    #: rather than dropped: a recurring unresolved name is usually a spelling
    #: the matcher should learn, not a player who does not exist.
    unresolved: list[str] = Field(default_factory=list)

    #: One line per source that failed, naming the source and why -- a timeout,
    #: an anti-bot challenge, an empty parse. Surfaced to the caller for the
    #: same reason `rag_chain` surfaces its fallback notes: a degraded result
    #: that does not say it is degraded is worse than no result.
    notes: list[str] = Field(default_factory=list)

    started_at: datetime
    finished_at: datetime

    @property
    def wrote_anything(self) -> bool:
        return any(not u.is_empty() for u in self.updates)
