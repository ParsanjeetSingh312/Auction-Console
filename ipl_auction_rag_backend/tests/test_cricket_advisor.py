"""
Tests for the Cricket Advisor: constraint parsing, bid ceilings, and fallbacks.

This agent answers during a live auction, where a bid clears in seven seconds
and nobody reads a stack trace. So the failures worth guarding are the ones that
return something plausible rather than something obviously broken.

Three shapes recur:

*Advice the room would refuse.* `TeamContext.rejects` deliberately duplicates
`Room.blocked_reason` -- same three checks, same order, same wording. Duplication
is the cost of the advisor not importing the room, and these tests are what stops
the copy drifting into recommending bids that get rejected at the block.

*A number that is merely too large.* A bid over the ceiling is not a crash; it
is confident, specific and illegal. It is caught by a bound or it reaches the
user.

*An empty answer that validated.* Per-candidate validation drops what does not
fit the contract, which is correct until it drops everything -- an empty list is
legal, the payload validates, and the user gets prose with no players while
retrieval is holding five exact matches. Measured across four runs of one
unchanged question: 5, 1, 0 and 2 candidates, from an identical set of SQL rows.

The model is stubbed throughout. These tests assert what the code does with a
reply, never what a model chooses to say.
"""
import asyncio
import json

import pytest

from rag import llm_provider
from scout.agents import cricket_advisor as ca
from scout.agents.cricket_advisor import _clamp, parse_constraints
from scout.graph.state import RetrievedRef
from scout.schemas.queries import (
    AdvisorQuery,
    AdvisorRecommendation,
    Candidate,
    Constraints,
    TeamContext,
)
from scout.tools.search_engine import RetrievalResult, constraints_to_sql

LAKH_PER_CRORE = 100


def team(**kwargs) -> TeamContext:
    """A mid-auction franchise: room to bid, but not unlimited room."""
    base = dict(
        team_id=1, name="Mumbai Indians", code="MI",
        purse_left_lakh=3_000, max_bid_lakh=2_400,
        squad_size=10, overseas_count=4,
    )
    base.update(kwargs)
    return TeamContext(**base)


def refs(n: int = 5) -> list[RetrievedRef]:
    return [
        RetrievedRef(
            player_id=i,
            player_name=f"Player {i}",
            text=f"Player {i}, All-Rounder, bat_sr 145.0, matches 60",
            score=0.9,
        )
        for i in range(1, n + 1)
    ]


def stub_model(payload: dict) -> None:
    """Replace the provider ladder with a fixed reply."""
    llm_provider.complete = lambda *a, **k: json.dumps(payload)


def advise(query: AdvisorQuery, retrieval: RetrievalResult | None = None):
    """Run `advise` with retrieval stubbed, so nothing touches Chroma or SQLite."""
    result = retrieval if retrieval is not None else RetrievalResult(refs=refs())

    async def fake_retrieve(*a, **k):
        return result

    ca.retrieve_for = fake_retrieve
    return asyncio.run(ca.advise(query, timeout=30.0))


def query(question: str, **kwargs) -> AdvisorQuery:
    constraints, _ = parse_constraints(question)
    return AdvisorQuery(question=question, constraints=constraints, **kwargs)


class TestConstraintParsing:
    """
    Parsing is done by regex, on purpose: it costs no quota and cannot be
    rate-limited mid-auction. These are the five questions from the console.
    """

    def test_role_and_price_and_strike_rate(self):
        c, _ = parse_constraints(
            "Find a primary All-Rounder under 15 Cr with a strike rate > 140")
        assert c.role == "All-Rounder"
        assert c.max_price_lakh == 15 * LAKH_PER_CRORE, "crore was not converted to lakh"
        assert c.min_bat_sr == 140

    def test_rating_floor(self):
        c, _ = parse_constraints(
            "Suggest a marquee batsman with a 9.5+ rating within our remaining budget")
        assert c.min_rating == 9.5

    @pytest.mark.parametrize("phrasing,expected", [
        ("an all rounder under 15 Cr", 1_500),
        ("a bowler under 2 crore", 200),
        ("someone below 7.5 Cr", 750),
    ])
    def test_price_phrasings_all_land_in_lakh(self, phrasing, expected):
        c, _ = parse_constraints(phrasing)
        assert c.max_price_lakh == expected, f"{phrasing!r} -> {c.max_price_lakh}"

    def test_an_unconstrained_question_parses_to_empty(self):
        c, _ = parse_constraints("who should we buy next?")
        assert c.is_empty(), f"invented constraints from a vague question: {c}"


class TestPriceCeilingAdmitsUnpricedPlayers:
    def test_null_base_price_is_not_excluded_by_a_ceiling(self):
        """
        Two thirds of the pool has no base price. `base_price <= 1500` alone
        drops every one of them, which took All-Rounders under 15 Cr from 80
        matches to 28 -- a filter that looks like it is working while hiding
        most of the answer.
        """
        sql, params = constraints_to_sql(Constraints(max_price_lakh=1_500))
        assert '"base_price" IS NULL OR' in sql, (
            f"a price ceiling excludes unpriced players: {sql}")
        assert 1_500 in params


class TestTeamContextMirrorsTheRoom:
    """
    The same three checks, in the same order, as `Room.blocked_reason`. Order
    matters: a full squad is reported as a full squad, not as being over budget.
    """

    def test_a_bid_inside_every_limit_is_allowed(self):
        assert team().rejects(2_000, overseas=False) is None

    def test_over_the_ceiling_is_refused(self):
        reason = team().rejects(2_500, overseas=False)
        assert reason is not None and "over budget" in reason

    def test_the_ceiling_is_max_bid_not_purse(self):
        """
        `purse_left` is always >= `max_bid`, because the room holds back enough
        to fill the minimum squad. Advising to the purse is advising an illegal
        bid: this team has 3,000 left and may bid 2,400.
        """
        t = team(purse_left_lakh=3_000, max_bid_lakh=2_400)
        assert t.rejects(2_500, overseas=False) is not None, (
            "a bid under the purse but over max_bid was allowed")

    def test_a_full_squad_is_refused_before_budget_is_considered(self):
        t = team(squad_size=25, max_squad=25)
        assert "squad full" in (t.rejects(1, overseas=False) or "")

    def test_overseas_limit_is_refused_only_for_overseas_players(self):
        t = team(overseas_count=8, max_overseas=8)
        assert "overseas full" in (t.rejects(100, overseas=True) or "")
        assert t.rejects(100, overseas=False) is None

    def test_the_refusal_is_worded_in_crore_like_the_room(self):
        """
        Told "max 11490 lakh" by one surface and "max 114.90 Cr" by the other,
        a bidder has to work out that those are the same number.
        """
        reason = team(max_bid_lakh=11_490).rejects(12_000, overseas=False) or ""
        assert "Cr" in reason and "11490" not in reason, reason


class TestBidsCannotExceedTheCeiling:
    def test_the_schema_refuses_a_recommendation_that_bids_over_the_ceiling(self):
        with pytest.raises(Exception):
            AdvisorRecommendation(
                answer="Bid the house.",
                engine_used="groq",
                max_bid_lakh=2_400,
                candidates=[Candidate(
                    player_id=1, player_name="Player 1", role="All-Rounder",
                    rationale="Worth more than we are allowed to spend on him.",
                    evidence=["bat_sr 145"],
                    suggested_max_bid_lakh=2_500,
                )],
            )

    def test_clamp_reduces_an_over_ceiling_bid_and_says_so(self):
        payload = {"candidates": [
            {"player_name": "Player 1", "suggested_max_bid_lakh": 5_000}]}
        notes: list[str] = []
        _clamp(payload, team(max_bid_lakh=2_400), notes)
        assert payload["candidates"][0]["suggested_max_bid_lakh"] == 2_400
        assert notes and "reduced" in notes[0]

    def test_without_a_team_no_bid_guidance_is_offered(self):
        """
        No franchise context means no ceiling to check against, and a bid
        suggested against no budget is a number with nothing behind it.
        """
        payload = {"candidates": [
            {"player_name": "Player 1", "suggested_max_bid_lakh": 5_000}]}
        _clamp(payload, None, [])
        assert "suggested_max_bid_lakh" not in payload["candidates"][0]


class TestTheShortlistSurvivesABadReply:
    """
    The advisor's job is to put players in front of a bidder. A reply that
    cannot be parsed into candidates must not become an answer with none.
    """

    def test_one_malformed_candidate_does_not_discard_the_others(self):
        stub_model({"answer": "Three of these are worth your money.", "candidates": [
            {"player_id": 1, "player_name": "Player 1", "role": "All-Rounder",
             "rationale": "Strikes at 145 and comes in under the ceiling.",
             "evidence": ["bat_sr 145"]},
            {"player_name": "Nonsense", "role": "Wizard"},
            {"player_id": 3, "player_name": "Player 3", "role": "All-Rounder",
             "rationale": "Economical through the middle overs, and available.",
             "evidence": ["economy 7.1"]},
        ]})
        rec = advise(query("an all rounder under 15 Cr"))
        names = [c.player_name for c in rec.candidates]
        assert names == ["Player 1", "Player 3"], names
        dropped = [n for n in rec.notes if "Nonsense" in n]
        assert dropped, "the dropped candidate was not named"
        assert "errors.pydantic.dev" not in dropped[0], (
            f"the note tells the user to read a docs page instead of the reason: {dropped[0]}")
        assert "role" in dropped[0], f"the note does not say what was wrong: {dropped[0]}"

    def test_no_candidates_at_all_falls_back_to_the_filter_matches(self):
        stub_model({"answer": "Here is my read on the market.", "candidates": []})
        rec = advise(query("an all rounder under 15 Cr"))
        assert len(rec.candidates) == 5, (
            "an empty shortlist was returned while retrieval held five matches")
        assert rec.answer.startswith("Here is my read"), "the model's prose was discarded"
        assert any("no usable shortlist" in n for n in rec.notes)

    def test_every_candidate_malformed_falls_back_the_same_way(self):
        stub_model({"answer": "Here is my read on the market.",
                    "candidates": [{"player_name": "Ghost"}, {"nope": True}]})
        rec = advise(query("an all rounder under 15 Cr"))
        assert len(rec.candidates) == 5
        assert any("no usable shortlist" in n for n in rec.notes)

    def test_a_good_reply_is_left_alone(self):
        stub_model({"answer": "Player 1 is the one to chase.", "candidates": [
            {"player_id": 1, "player_name": "Player 1", "role": "All-Rounder",
             "rationale": "Strikes at 145 and comes in under the ceiling.",
             "evidence": ["bat_sr 145"]},
        ]})
        rec = advise(query("an all rounder under 15 Cr"))
        assert [c.player_name for c in rec.candidates] == ["Player 1"]
        assert not any("no usable shortlist" in n for n in rec.notes), (
            "the fallback fired when the model had answered perfectly well")

    def test_nothing_retrieved_and_nothing_returned_is_an_honest_empty(self):
        """With no rows to fall back to there is nothing to rebuild from."""
        stub_model({"answer": "Nobody in the pool fits that.", "candidates": []})
        rec = advise(query("an all rounder under 15 Cr"), RetrievalResult(refs=[]))
        assert rec.candidates == []
        assert not any("no usable shortlist" in n for n in rec.notes)


class TestWhenNoModelAnswers:
    def test_an_unusable_reply_falls_back_to_rule_and_says_which(self):
        """
        `engine_used` is how the UI tells the user no model was involved. A
        rule-built shortlist labelled as a model's work is the one outcome
        worse than no shortlist.
        """
        def boom(*a, **k):
            raise RuntimeError("every provider refused")

        llm_provider.complete = boom
        rec = advise(query("an all rounder under 15 Cr"))
        assert rec.engine_used == "local_analyst"
        assert len(rec.candidates) == 5, "the rule-based path returned no players"

    def test_a_declared_provider_failure_falls_back(self):
        """The arm the ladder promises: every rung tried and refused."""
        def refused(*a, **k):
            raise llm_provider.LLMError("Every configured provider failed")

        llm_provider.complete = refused
        rec = advise(query("an all rounder under 15 Cr"))
        assert rec.engine_used == "local_analyst"
        assert any("No model answered" in n for n in rec.notes)

    def test_an_undeclared_exception_also_falls_back(self):
        """
        The arm the ladder does not promise. Groq and Anthropic wrap with
        `except Exception`; Gemini and Hermes wrap `httpx.HTTPError` only, so a
        malformed response body escapes as a KeyError and would take the node
        with it -- during a live lot.
        """
        def boom(*a, **k):
            raise KeyError("candidates")

        llm_provider.complete = boom
        rec = advise(query("an all rounder under 15 Cr"))
        assert rec.engine_used == "local_analyst"
        assert any("unexpectedly" in n for n in rec.notes), rec.notes

    def test_the_rule_based_rationale_does_not_pretend_to_be_an_assessment(self):
        def boom(*a, **k):
            raise RuntimeError("every provider refused")

        llm_provider.complete = boom
        rec = advise(query("an all rounder under 15 Cr"))
        assert all("no model" in c.rationale.lower() for c in rec.candidates), (
            "a data match was worded as though something had judged it")
