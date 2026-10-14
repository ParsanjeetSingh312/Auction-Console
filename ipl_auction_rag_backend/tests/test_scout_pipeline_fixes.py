"""
Regression tests for the SCOUT pipeline fixes of 2026-10-14.

One class per reported bug, and one per safeguard added for it:

- Situational stats were filtered on the career figure ("strike rate above
  180 against fast bowlers" filtered `bat_sr`, not `sr_vs_fast`).
- The advisor returned one card when several players matched.
- "A batter ... against fast bowlers" was parsed as role=Bowler.
- Hallucinated players and keys reached the console.
- An empty filter result fell back to unrelated vector matches.
- Weak vector matches reached the advisor unfiltered.
- Per-turn state survived into the next question on the same thread.

The model is stubbed throughout, as in test_cricket_advisor.py: these assert
what the code does with a reply, never what a model chooses to say.
"""
import asyncio
import json

from rag import llm_provider
from scout.agents import cricket_advisor as ca
from scout.agents.cricket_advisor import parse_constraints
from scout.graph import workflow
from scout.graph.state import RetrievedRef
from scout.schemas.queries import NO_MATCH_ANSWER, AdvisorQuery, AdvisorRecommendation, Constraints
from scout.tools.search_engine import RetrievalResult, constraints_to_sql, gate_by_similarity


def match_refs(n: int) -> list[RetrievedRef]:
    """Rows that passed the SQL filter, as `by_constraints` returns them."""
    return [
        RetrievedRef(
            player_id=i, player_name=f"Player {i}",
            text=f"Player {i} (India), Batter, capped. strike rate vs pace {180 + i}",
            score=None, scored_by="keyword",
        )
        for i in range(1, n + 1)
    ]


def card(pid: int, **extra) -> dict:
    return {
        "player_id": pid, "player_name": f"Player {pid}", "role": "Batter",
        "rationale": "Scores quickly against pace and fits the budget.",
        "evidence": [f"sr_vs_fast {180 + pid}"], **extra,
    }


class _ModelCalls:
    def __init__(self, payload: dict | None):
        self.payload = payload
        self.count = 0

    def __call__(self, *a, on_answer=None, **k):
        self.count += 1
        if on_answer is not None:
            on_answer("groq")
        return json.dumps(self.payload)


def run_advise(question: str, retrieval: RetrievalResult, payload: dict | None = None):
    calls = _ModelCalls(payload)
    llm_provider.complete = calls

    async def fake_retrieve(*a, **k):
        return retrieval

    ca.retrieve_for = fake_retrieve
    constraints, _ = parse_constraints(question)
    rec = asyncio.run(ca.advise(AdvisorQuery(question=question, constraints=constraints)))
    return rec, calls


class TestSituationalStats:
    def test_strike_rate_against_pace_filters_the_split_not_the_career_figure(self):
        c, found = parse_constraints("Batter with strike rate above 180 against fast bowlers")
        assert c.min_sr_vs_fast == 180
        assert c.min_bat_sr is None, "the career filter would drop players who are quick against pace"
        sql, params = constraints_to_sql(c)
        assert '"sr_vs_fast" >= ?' in sql and 180 in params
        assert '"bat_sr"' not in sql.split("ORDER BY")[0], "bat_sr must not be filtered"
        assert sql.split("ORDER BY")[1].strip().startswith("sr_vs_fast DESC")
        assert "strike rate vs pace>=180" in found

    def test_spin_and_handedness_splits(self):
        c, _ = parse_constraints("an opener with SR over 150 vs spin")
        assert c.min_sr_vs_spin == 150 and c.min_bat_sr is None
        c, _ = parse_constraints("bowler with economy under 8 against left-handed batters")
        assert c.max_econ_vs_lhb == 8 and c.max_economy is None

    def test_no_split_for_a_phase_is_said_not_invented(self):
        c, found = parse_constraints("death overs batter with strike rate above 170")
        assert c.min_bat_sr == 170
        assert any("death overs" in f for f in found)


class TestRoleIsReadFromTheQuestion:
    def test_batter_against_bowlers_is_a_batter(self):
        c, _ = parse_constraints("Batter with strike rate above 180 against fast bowlers")
        assert c.role == "Batter"

    def test_finisher_against_pace_bowling_is_a_batter(self):
        c, _ = parse_constraints("Find me a finisher who scores quickly against pace bowling")
        assert c.role == "Batter"

    def test_the_first_role_named_wins(self):
        c, _ = parse_constraints("an all-rounder who can also keep wicket")
        assert c.role == "All-Rounder"

    def test_bowlers_still_parse_as_bowlers(self):
        c, _ = parse_constraints("a bowler with economy under 7.5")
        assert c.role == "Bowler" and c.max_economy == 7.5


class TestEveryMatchGetsACard:
    def test_four_matches_and_a_one_card_reply_still_show_four(self):
        rec, _ = run_advise(
            "Batter with strike rate above 180 against fast bowlers",
            RetrievalResult(refs=match_refs(4), matched_by_constraints=4),
            {"answer": "Player 2 is the pick.", "candidates": [card(2)]},
        )
        assert [c.player_id for c in rec.candidates] == [2, 1, 3, 4]
        assert any("left out of the model's reply" in n for n in rec.notes)

    def test_the_model_s_order_is_kept_ahead_of_the_filler(self):
        rec, _ = run_advise(
            "Batter with strike rate above 180 against fast bowlers",
            RetrievalResult(refs=match_refs(3), matched_by_constraints=3),
            {"answer": "Three fits.", "candidates": [card(3), card(1), card(2)]},
        )
        assert [c.player_id for c in rec.candidates] == [3, 1, 2]


class TestHallucinationsStopAtTheBackend:
    def test_an_invented_player_is_dropped(self):
        rec, _ = run_advise(
            "Batter with strike rate above 180 against fast bowlers",
            RetrievalResult(refs=match_refs(2), matched_by_constraints=2),
            {"answer": "x", "candidates": [card(1), card(9001, player_name="Ghost Player")]},
        )
        assert 9001 not in [c.player_id for c in rec.candidates]
        assert any("Ghost Player" in n and "not one of the players" in n for n in rec.notes)

    def test_unknown_keys_are_stripped_and_reported(self):
        rec, _ = run_advise(
            "Batter with strike rate above 180 against fast bowlers",
            RetrievalResult(refs=match_refs(1), matched_by_constraints=1),
            {"answer": "x", "confidence": 0.99,
             "candidates": [card(1, star_rating=5, player_name="P1 (misspelt)")]},
        )
        assert rec.candidates[0].player_name == "Player 1", "the pool's spelling wins"
        dumped = rec.model_dump()
        assert "confidence" not in dumped and "star_rating" not in dumped["candidates"][0]
        assert any("star_rating" in n for n in rec.notes)
        assert any("confidence" in n for n in rec.notes)


class TestEmptyResultShortCircuits:
    def test_no_match_returns_the_fixed_answer_without_calling_a_model(self):
        rec, calls = run_advise(
            "Batter with strike rate above 300 against fast bowlers",
            RetrievalResult(refs=[], no_match=True),
            {"answer": "should never be used", "candidates": []},
        )
        assert rec.answer == NO_MATCH_ANSWER
        assert rec.candidates == []
        assert rec.engine_used == "local_analyst"
        assert calls.count == 0, "the advisor was called with nothing to recommend"

    def test_the_supervisor_ends_the_turn_before_research(self, monkeypatch):
        async def none_match(constraints):
            return 0

        monkeypatch.setattr(workflow, "_count_matches", none_match)
        update = asyncio.run(workflow.supervisor_node(
            {"question": "Batter with strike rate above 300 against fast bowlers"}
        ))
        assert update["recommendation"].answer == NO_MATCH_ANSWER
        assert workflow.route_from_supervisor({**update, "intent": "advise"}) == "answered"

    def test_an_uncountable_pool_is_not_reported_as_empty(self, monkeypatch):
        async def unknown(constraints):
            return None

        monkeypatch.setattr(workflow, "_count_matches", unknown)
        update = asyncio.run(workflow.supervisor_node(
            {"question": "Batter with strike rate above 180 against fast bowlers"}
        ))
        assert update["recommendation"] is None
        assert workflow.route_from_supervisor({**update, "intent": "advise"}) == "research"


class TestSimilarityGate:
    def vec(self, pid: int, score: float) -> RetrievedRef:
        return RetrievedRef(player_id=pid, player_name=f"P{pid}", text="x", score=score, scored_by="vector")

    def test_off_topic_matches_are_dropped_by_the_floor(self):
        kept, dropped = gate_by_similarity(
            [self.vec(1, 0.46), self.vec(2, 0.44)], floor=0.55, band=0.06)
        assert kept == [] and dropped == 2

    def test_the_band_keeps_only_matches_near_the_best(self):
        kept, dropped = gate_by_similarity(
            [self.vec(1, 0.77), self.vec(2, 0.74), self.vec(3, 0.62)], floor=0.55, band=0.06)
        assert [r.player_id for r in kept] == [1, 2] and dropped == 1

    def test_exact_matches_are_never_gated(self):
        exact = RetrievedRef(player_id=9, player_name="P9", text="x", score=None, scored_by="keyword")
        kept, _ = gate_by_similarity([exact, self.vec(1, 0.40)], floor=0.55, band=0.06)
        assert kept == [exact]


class TestNoStateBleedsBetweenTurns:
    def test_the_supervisor_clears_every_per_turn_field(self, monkeypatch):
        async def some(constraints):
            return 4

        monkeypatch.setattr(workflow, "_count_matches", some)
        stale = AdvisorRecommendation(answer="old", candidates=[], engine_used="groq")
        update = asyncio.run(workflow.supervisor_node({
            "question": "Batter with strike rate above 180 against fast bowlers",
            # Left on the thread by a previous question about bowlers.
            "constraints": Constraints(role="Bowler", max_economy=7.0),
            "recommendation": stale,
            "research_context": "old news",
            "research": object(),
            "engine_used": "groq",
            "retrieved": ["old"],
            "refresh_cycles": 1,
        }))
        assert update["constraints"].role == "Batter"
        assert update["constraints"].max_economy is None
        for key in ("recommendation", "research_context", "research", "engine_used"):
            assert update[key] is None, key
        assert update["retrieved"] == [] and update["refresh_cycles"] == 0

    def test_a_research_turn_does_not_keep_the_last_constraints(self):
        update = asyncio.run(workflow.supervisor_node({
            "question": "refresh the data",
            "constraints": Constraints(role="Bowler"),
        }))
        assert update["intent"] == "research"
        assert update["constraints"].is_empty()
