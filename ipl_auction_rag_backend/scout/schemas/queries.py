"""
queries.py
What the Cricket Advisor is asked, and what it is allowed to answer.

`AdvisorRecommendation` is also the contract a remote Hermes endpoint must
satisfy. We define it here and send `model_json_schema()` in the system prompt,
rather than parsing whatever shape Hermes happens to emit -- so a malformed
reply fails validation and degrades to the local ladder, instead of reaching a
bidder as a confident-looking number.

Two things in here are load-bearing.

**Units are in the field names, because the error is silent and 100x.** The
backend counts in lakh throughout: `MAX_AMOUNT_LAKH` is 12,000, a full purse is
12,000 lakh, and `auction/schemas.py` insists amounts are `int` because "a float
bid is a parse error rather than something that rounds oddly three screens
later". But people ask in crore -- "an all-rounder under 15 Cr" is 1,500 lakh.
A field called `max_price` invites a parser to put 15 in it. `max_price_lakh`
does not, and nothing here is a bare number.

**A recommendation cannot exceed what the room would allow.** The obvious
ceiling is the team's remaining purse, and it is the wrong one.
`Room.summary_for` computes:

    reserve = slots_needed_after_this * cheapest_base_price
    max_bid = max(0, left - reserve)

so a franchise holds back enough to fill its minimum squad and cannot spend
itself into an illegal side. A bid bounded by `left` sails past that and is
refused by `blocked_reason` with "over budget". `AdvisorRecommendation`
validates every candidate against `max_bid_lakh` instead, which means the
advisor is structurally unable to suggest a bid the auction would reject.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from scout.schemas.player import CapStatus, Role

#: 1 crore = 100 lakh. Stated once, here, so no call site does the arithmetic
#: from memory. A full IPL purse is 120 crore, which is the 12,000 lakh that
#: `auction/schemas.py` calls MAX_AMOUNT_LAKH -- the two agree, and this is
#: where you check that they still do.
LAKH_PER_CRORE = 100

#: Matches ChatRequest.query and QueryRequest.query in api/schemas.py. Kept the
#: same deliberately: a question the advisor accepts but /api/v1/chat refuses is
#: a difference a user discovers by being cut off mid-sentence.
QUESTION_MAX_LENGTH = 500

#: Who actually produced an answer. Surfaced to the caller, because "Hermes 70B
#: recommended this bid" and "Hermes was unreachable so a rule-based fallback
#: recommended this bid" are different facts, and a bidder acting on a number
#: deserves to know which one they have.
Engine = Literal["hermes", "anthropic", "gemini", "groq", "local_analyst"]


def money_lakh(lakh: int | float | None) -> str:
    """
    Render an amount the way the console and the auction ledger render it.

    A deliberate mirror of `auction.room.money`, not an import of it:
    `auction/room.py` constructs a module-level `room = AuctionRoom()` at the
    bottom of the file, so importing anything from it here would instantiate a
    live auction room as a side effect of importing a schema.

    The copy is five lines and the verification asserts the two agree across
    the whole range, so drift fails a test rather than reaching a user as two
    different vocabularies for the same refusal.
    """
    if lakh is None:
        return "\u2014"
    if lakh >= 100:
        return f"\u20b9{lakh / 100:.2f} Cr"
    return f"\u20b9{lakh} L"


def crore_to_lakh(crore: float) -> int:
    """
    Convert a spoken figure to the unit the backend counts in.

    Rounded to int because every amount downstream is an int of lakh. "1.5 Cr"
    is 150; "15 Cr" is 1,500.
    """
    return round(crore * LAKH_PER_CRORE)


class Constraints(BaseModel):
    """
    A natural-language ask, parsed into something retrieval can execute.

    Every field is optional, because most questions pin down two or three of
    them. None means "unconstrained", which is why nothing here defaults to a
    sentinel like 0 or -1 -- a minimum strike rate of 0 reads as a filter and
    matches everything, and the difference is invisible in a query plan.

    The bounds mirror `PlayerStatUpdate`, so a constraint cannot ask for a value
    that could never have been stored in the first place.
    """

    role: Role | None = None
    cap_status: CapStatus | None = None

    #: True = overseas only, False = Indian only, None = either. Named for the
    #: column (`players.overseas`), not for "foreign", so the mapping is direct.
    overseas: bool | None = None

    # --- price, in lakh --------------------------------------------------
    #: "under 15 Cr" -> max_price_lakh=1500. See crore_to_lakh.
    max_price_lakh: int | None = Field(default=None, ge=0, le=12_000)
    min_price_lakh: int | None = Field(default=None, ge=0, le=12_000)

    # --- form and quality ------------------------------------------------
    min_rating: float | None = Field(default=None, ge=0, le=10)
    min_bat_sr: float | None = Field(default=None, ge=0, le=400)
    min_bat_avg: float | None = Field(default=None, ge=0, le=100)
    #: Bowling reads the other way round: lower economy is better, so this is a
    #: ceiling where the batting fields are floors.
    max_economy: float | None = Field(default=None, ge=0, le=30)
    min_wickets: int | None = Field(default=None, ge=0, le=500)
    min_matches: int | None = Field(default=None, ge=0, le=500)

    #: Players already sold, already on the asking squad, or explicitly ruled
    #: out. Recommending someone another franchise bought twenty minutes ago is
    #: the fastest way for an advisor to lose a user's trust.
    exclude_player_ids: list[int] = Field(default_factory=list, max_length=300)

    #: How many names to come back with. Small on purpose -- a shortlist a
    #: bidder can read between two bids, not a search result page.
    limit: int = Field(default=5, ge=1, le=20)

    @model_validator(mode="after")
    def _price_window_is_coherent(self) -> Constraints:
        lo, hi = self.min_price_lakh, self.max_price_lakh
        if lo is not None and hi is not None and lo > hi:
            raise ValueError(
                f"min_price_lakh ({lo}) is above max_price_lakh ({hi}) - "
                "an empty price window, usually a parse that swapped the bounds"
            )
        return self

    def is_empty(self) -> bool:
        """
        True when nothing was pinned down.

        Worth knowing rather than guessing: an empty parse means the question
        was qualitative ("who suits a spin-heavy pitch?") and belongs on the
        vector path, not behind a SQL filter that would match the whole pool.
        """
        # Every constraint field defaults to None; `limit` and
        # `exclude_player_ids` are excluded because they are always set and say
        # nothing about what was asked for. Note `overseas=False` is a real
        # constraint ("Indian only"), which is why this tests for None rather
        # than for falsiness.
        ignored = {"limit", "exclude_player_ids"}
        return all(
            v is None for k, v in self.model_dump().items() if k not in ignored
        )


class TeamContext(BaseModel):
    """
    The asking franchise's position, mirrored from `TeamState`.

    Every field here is read from the room's own broadcast rather than
    recomputed, so the advisor and the auction can never disagree about what a
    team can afford. The rule values travel with it for the same reason: a
    recommendation should be checkable against the rules that were in force when
    it was made, not against whatever the defaults say later.
    """

    team_id: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=64)
    code: str = Field(min_length=2, max_length=8)

    #: TeamState.left -- purse minus spend, in lakh.
    purse_left_lakh: int = Field(ge=0, le=12_000)

    #: TeamState.max_bid -- what the room will actually permit right now, after
    #: holding back enough to fill the minimum squad. THIS is the ceiling a
    #: recommendation must respect; purse_left_lakh is always equal or larger
    #: and bidding to it can be illegal.
    max_bid_lakh: int = Field(ge=0, le=12_000)

    squad_size: int = Field(ge=0, le=50)
    overseas_count: int = Field(ge=0, le=50)

    # --- the rules in force, from RoomState.rules ---
    max_squad: int = Field(default=25, ge=1, le=50)
    min_squad: int = Field(default=18, ge=1, le=50)
    max_overseas: int = Field(default=8, ge=0, le=50)

    @property
    def squad_slots_left(self) -> int:
        return max(0, self.max_squad - self.squad_size)

    @property
    def overseas_slots_left(self) -> int:
        return max(0, self.max_overseas - self.overseas_count)

    def rejects(self, amount_lakh: int, *, overseas: bool) -> str | None:
        """
        Why this team could not bid `amount_lakh` on a player. None if they could.

        Deliberately the same three checks, in the same order, as
        `Room.blocked_reason`. If the two ever drift, the advisor starts
        recommending bids the room refuses -- so this is the place to keep in
        step. The strings are formatted through `money_lakh` for the same
        reason: a bidder told "over budget \u2014 max \u20b9114.90 Cr" by the room and
        "over budget - max 11490 lakh" by the advisor has to work out for
        themselves that those are the same number.
        """
        if self.squad_slots_left == 0:
            return f"squad full ({self.max_squad})"
        if overseas and self.overseas_slots_left == 0:
            return f"overseas full ({self.max_overseas})"
        if amount_lakh > self.max_bid_lakh:
            return f"over budget \u2014 max {money_lakh(self.max_bid_lakh)}"
        return None


class AdvisorQuery(BaseModel):
    """One question put to the advisor, with everything needed to answer it."""

    question: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)

    #: The parsed form. Built by the advisor node, not by the caller -- a client
    #: sends prose and gets structure back, which is the whole point.
    constraints: Constraints = Field(default_factory=Constraints)

    #: None when nobody is in a seat: /data is read-only and has no franchise.
    #: The advisor must still answer, just without budget reasoning.
    team: TeamContext | None = None

    #: The lot currently on the block, when there is one. `useScout.ts` already
    #: folds this player into the question text for /api/v1/chat; carrying the
    #: id as well means the advisor can look the player up rather than parse
    #: them back out of a sentence.
    on_block_player_id: int | None = Field(default=None, ge=1)

    asked_at: datetime | None = None


class Candidate(BaseModel):
    """One name the advisor is putting forward, and why."""

    player_id: int = Field(ge=1)
    player_name: str = Field(min_length=1, max_length=120)
    role: Role

    #: Why this player, in a sentence or two a bidder can act on between bids.
    rationale: str = Field(min_length=10, max_length=600)

    #: The figures the rationale rests on, as short strings ("bat_sr 148.2 vs
    #: pool median 131"). Required to be non-empty: an advisor that cannot cite
    #: anything is generating prose, and this field is what makes that visible
    #: rather than persuasive.
    evidence: list[str] = Field(min_length=1, max_length=8)

    #: What to stop at, in lakh. Validated against the recommendation's ceiling,
    #: so this can never be a number the room would refuse.
    suggested_max_bid_lakh: int | None = Field(default=None, ge=0, le=12_000)

    #: Reasons to be careful -- an injury note, a thin sample, a rival with a
    #: bigger purse. Optional, because sometimes there genuinely are none, but
    #: the field exists so the model has somewhere to put a caveat other than
    #: burying it in the rationale.
    risks: list[str] = Field(default_factory=list, max_length=6)


class AdvisorRecommendation(BaseModel):
    """
    The advisor's answer -- and the JSON contract Hermes must return.

    Sent to a remote engine as `AdvisorRecommendation.model_json_schema()`,
    never as a schema written out by hand in a prompt, so the two cannot drift
    apart when a field is added here.
    """

    #: The prose answer. What a user reads first, and the only part that
    #: survives if the structured half fails to parse.
    answer: str = Field(min_length=1, max_length=4_000)

    candidates: list[Candidate] = Field(default_factory=list, max_length=20)

    engine_used: Engine

    #: Every degradation that fired, in the same style the RAG chain already
    #: uses: "Hermes unreachable, answered with gemini", "data last refreshed 6
    #: days ago". A degraded answer that does not say it is degraded is worse
    #: than no answer.
    notes: list[str] = Field(default_factory=list, max_length=12)

    #: The ceiling in force when this was produced, copied from
    #: `TeamContext.max_bid_lakh`. Stored rather than looked up so the answer
    #: stays auditable after the purse has moved on -- and so the validator
    #: below has something to check against.
    max_bid_lakh: int | None = Field(default=None, ge=0, le=12_000)

    #: How many times the graph went back to the Researcher for fresher data
    #: before answering. Bounded by SCOUT_MAX_REFRESH_CYCLES; surfaced so a slow
    #: answer has a visible reason.
    refresh_cycles: int = Field(default=0, ge=0, le=5)

    @model_validator(mode="after")
    def _no_candidate_exceeds_the_ceiling(self) -> AdvisorRecommendation:
        if self.max_bid_lakh is None:
            # No team context -- /data asks questions with no franchise behind
            # them. Nothing to check against, and inventing a ceiling would be
            # worse than having none.
            return self

        for c in self.candidates:
            if c.suggested_max_bid_lakh is not None and c.suggested_max_bid_lakh > self.max_bid_lakh:
                raise ValueError(
                    f"{c.player_name}: suggested bid "
                    f"{money_lakh(c.suggested_max_bid_lakh)} exceeds the team's "
                    f"ceiling of {money_lakh(self.max_bid_lakh)} - the room would "
                    "refuse this bid with 'over budget'"
                )
        return self
