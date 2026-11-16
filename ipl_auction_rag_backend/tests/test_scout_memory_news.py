"""
Tests for SCOUT's conversation memory, its player-news ledger, intent routing
and the pieces of training that can be checked without a model.

Everything here runs against temporary files: no model, no Chroma, no network.
"""
import asyncio
from datetime import date

import pytest

from config.settings import get_settings


@pytest.fixture()
def tmp_stores(tmp_path, monkeypatch):
    """Point memory, news and knowledge at a scratch directory."""
    settings = get_settings()
    monkeypatch.setattr(settings, "SCOUT_MEMORY_PATH", str(tmp_path / "memory.db"))
    monkeypatch.setattr(settings, "SCOUT_NEWS_PATH", str(tmp_path / "news.json"))
    monkeypatch.setattr(settings, "SCOUT_KNOWLEDGE_PATH", str(tmp_path / "knowledge.json"))
    monkeypatch.setattr(settings, "SCOUT_MEMORY_TOKEN_LIMIT", 6000)
    monkeypatch.setattr(settings, "SCOUT_MEMORY_KEEP_TURNS", 2)
    from scout import knowledge

    monkeypatch.setattr(knowledge, "_cache", None)
    return tmp_path


# ---------------------------------------------------------------------------
# Conversation memory
# ---------------------------------------------------------------------------


class TestMemory:
    def test_a_thread_remembers_its_turns_in_order(self, tmp_stores):
        from scout import memory

        memory.remember("t1", "Stats of Virat Kohli", "Kohli: 9,346 runs.", [{"id": 4, "name": "Virat Kohli"}])
        memory.remember("t1", "And his 2026 season?", "675 runs at 165.8.", [{"id": 4, "name": "Virat Kohli"}])
        m = memory.load("t1")
        assert [t.question for t in m.turns] == ["Stats of Virat Kohli", "And his 2026 season?"]
        assert m.messages()[0] == {"role": "user", "content": "Stats of Virat Kohli"}
        assert m.messages()[1]["role"] == "assistant"
        assert m.focus == [{"id": 4, "name": "Virat Kohli"}]

    def test_threads_do_not_share_memory(self, tmp_stores):
        from scout import memory

        memory.remember("a", "q", "an answer", [])
        assert memory.load("b").is_empty()

    def test_a_shortlist_does_not_steal_the_focus(self, tmp_stores):
        from scout import memory

        memory.remember("t", "Kohli stats", "...", [{"id": 4, "name": "Virat Kohli"}])
        five = [{"id": i, "name": f"P{i}"} for i in range(10, 15)]
        memory.remember("t", "five bowlers under 8", "...", five)
        assert memory.load("t").focus == [{"id": 4, "name": "Virat Kohli"}]

    def test_pronouns_resolve_to_the_focus(self, tmp_stores):
        from scout import memory

        memory.remember("t", "Kohli stats", "...", [{"id": 4, "name": "Virat Kohli"}])
        m = memory.load("t")
        assert memory.followup_players("what is his strike rate against spin?", m) == m.focus
        assert memory.followup_players("bowlers under 8 economy", m) == []

    def test_the_second_one_means_the_last_answers_second_player(self, tmp_stores):
        from scout import memory

        five = [{"id": i, "name": f"P{i}"} for i in range(10, 15)]
        memory.remember("t", "five bowlers", "...", five)
        assert memory.followup_players("tell me more about the second one", memory.load("t")) == [five[1]]

    def test_compaction_keeps_the_last_turns_and_summarises_the_rest(self, tmp_stores):
        from scout import memory

        for i in range(5):
            memory.remember("t", f"question {i}", f"answer number {i}.", [{"id": 4, "name": "Virat Kohli"}])
        before = memory.load("t").tokens()
        m = memory.compact("t", use_model=False)
        assert [t.question for t in m.turns] == ["question 3", "question 4"]
        assert "question 0" in m.summary and m.compacted_turns == 3
        assert m.usage()["turns"] == 5 and m.tokens() < before + 200

    def test_a_full_thread_compacts_itself(self, tmp_stores, monkeypatch):
        from scout import memory

        monkeypatch.setattr(get_settings(), "SCOUT_MEMORY_TOKEN_LIMIT", 120)
        monkeypatch.setattr(memory, "_model_summary", lambda *a, **k: None)
        for i in range(6):
            memory.remember("t", f"question {i} " + "x" * 60, "answer " + "y" * 80, [])
        m = memory.load("t")
        assert m.compactions >= 1 and len(m.turns) <= 2 + 1

    def test_clear_forgets_everything(self, tmp_stores):
        from scout import memory

        memory.remember("t", "q", "an answer", [])
        assert memory.clear("t") is True
        assert memory.load("t").is_empty()

    def test_a_hostile_thread_id_is_ignored(self, tmp_stores):
        from scout import memory

        assert memory.remember("../../etc", "q", "a", []) is None
        assert memory.load("x' OR 1=1 --").is_empty()


# ---------------------------------------------------------------------------
# The news ledger
# ---------------------------------------------------------------------------


def _item(**kw):
    from scout.news import NewsItem

    base = dict(
        player_name="Test Bowler", kind="trade", season=2027, from_team="Punjab Kings",
        to_team="Mumbai Indians", summary="Traded in an all-cash deal during the trade window.",
        reported_on=date(2026, 11, 10), source_name="ESPNcricinfo",
        source_url="https://www.espncricinfo.com/story/test",
    )
    base.update(kw)
    return NewsItem(**base)


class TestNews:
    def test_a_record_needs_a_source_link(self):
        from scout.news import NewsItem

        with pytest.raises(Exception):
            NewsItem(player_name="X Y", kind="injury", summary="Hamstring strain, out.", source_url="")
        with pytest.raises(Exception):
            NewsItem(player_name="X Y", kind="injury", summary="Hamstring strain, out.", source_url="a tweet")

    def test_upsert_is_idempotent_and_items_are_found_by_name(self, tmp_stores, monkeypatch):
        from scout import news

        monkeypatch.setattr(news, "_resolve_pool_id", lambda name: None)
        assert news.upsert([_item()]) == (1, 0)
        assert news.upsert([_item()]) == (0, 1)
        found = news.items_for(["test bowler"], [])
        assert len(found) == 1 and found[0].to_team == "Mumbai Indians"
        assert found[0].credible

    def test_names_outside_the_pool_are_found_in_a_question(self, tmp_stores, monkeypatch):
        from scout import news

        monkeypatch.setattr(news, "_resolve_pool_id", lambda name: None)
        news.upsert([_item(player_name="Nathan Example", kind="ruled_out", season=2026)])
        assert news.names_in_question("Why did Nathan Example miss IPL 2026?") == ["Nathan Example"]
        assert news.names_in_question("why did Example miss it") == ["Nathan Example"]
        assert news.season_in("Why did he miss IPL 2026?") == 2026

    def test_the_headline_cites_its_source(self):
        line = _item().headline()
        assert "traded from Punjab Kings to Mumbai Indians ahead of IPL 2027" in line
        assert "ESPNcricinfo" in line and "10 Nov 2026" in line

    def test_without_a_record_the_answer_says_so(self, tmp_stores, monkeypatch):
        from rag import llm_provider
        from scout.agents import news_desk

        monkeypatch.setattr(llm_provider, "available", lambda: False)
        monkeypatch.setattr(news_desk, "_pool_rows", lambda ids: {})
        rec = asyncio.run(news_desk.answer_news(
            "Was Somebody traded?", subjects=[{"id": 99, "name": "Some Body"}],
            knowledge=None, history=[], memory_summary=None, team=None,
        ))
        assert rec.answer.startswith("SCOUT has no recorded")
        assert rec.engine_used == "local_analyst"

    def test_with_a_record_the_answer_is_the_record(self, tmp_stores, monkeypatch):
        from rag import llm_provider
        from scout import news
        from scout.agents import news_desk

        monkeypatch.setattr(news, "_resolve_pool_id", lambda name: None)
        news.upsert([_item()])
        monkeypatch.setattr(llm_provider, "available", lambda: False)
        rec = asyncio.run(news_desk.answer_news(
            "Was Test Bowler traded before IPL 2027?", subjects=[],
            knowledge=None, history=[], memory_summary=None, team=None,
        ))
        assert "Mumbai Indians" in rec.answer and "ESPNcricinfo" in rec.answer


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


class TestIntent:
    @pytest.mark.parametrize("question", [
        "Arshdeep Singh has been traded to which team before IPL 2027?",
        "Why did Nathan Ellis miss IPL 2026?",
        "Is Bumrah injured?",
        "Was he retained?",
    ])
    def test_news_questions(self, question):
        from scout.graph.workflow import classify_intent

        assert classify_intent(question, about_a_player=True) == "news"

    @pytest.mark.parametrize("question", [
        "Batter with strike rate above 180 against fast bowlers",
        "Bowler with economy under 8 against left-handed batters",
        "Which team needs a wicket keeper?",
    ])
    def test_shortlist_questions_stay_advise(self, question):
        from scout.graph.workflow import classify_intent

        assert classify_intent(question) == "advise"

    def test_which_team_is_news_only_about_a_player(self):
        from scout.graph.workflow import classify_intent

        assert classify_intent("Which team does he play for?", about_a_player=True) == "news"
        assert classify_intent("Which team does he play for?", about_a_player=False) == "advise"

    def test_refresh_is_still_research(self):
        from scout.graph.workflow import classify_intent

        assert classify_intent("refresh the data") == "research"


class TestNamedPlayers:
    POOL = [(4, "Virat Kohli"), (27, "Jasprit Bumrah"), (40, "Travis Head")]

    def test_a_name_without_stats_wording_is_a_profile(self, monkeypatch):
        from scout.agents import cricket_advisor

        monkeypatch.setattr(cricket_advisor, "_pool_names", lambda: self.POOL)
        c, found = cricket_advisor.parse_constraints("How good is Bumrah against left-handers?")
        assert c.player_ids == [27] and found == ["profile of Jasprit Bumrah"]

    def test_a_lowercase_common_word_is_not_a_surname(self, monkeypatch):
        from scout.agents import cricket_advisor

        monkeypatch.setattr(cricket_advisor, "_pool_names", lambda: self.POOL)
        c, _ = cricket_advisor.parse_constraints("best batters head to head against spin")
        assert c.player_ids is None

    def test_a_filter_keeps_a_search_a_search(self, monkeypatch):
        from scout.agents import cricket_advisor

        monkeypatch.setattr(cricket_advisor, "_pool_names", lambda: self.POOL)
        c, _ = cricket_advisor.parse_constraints("batters like Virat Kohli under 5 Cr")
        assert c.player_ids is None and c.max_price_lakh == 500


# ---------------------------------------------------------------------------
# Training helpers
# ---------------------------------------------------------------------------


class TestKnowledge:
    def test_seasons_are_read_by_the_year_played(self):
        from scout.knowledge import _season_year

        assert _season_year({"season": "2007/08", "dates": ["2008-04-18"]}) == 2008
        assert _season_year({"season": "2020/21", "dates": ["2020-09-19"]}) == 2020
        assert _season_year({"season": 2026}) == 2026

    def test_a_rename_is_not_a_move_and_gaps_collapse(self):
        from scout.knowledge import SeasonLine, _player_documents, franchise

        def line(team):
            s = SeasonLine()
            s.teams[franchise(team)] = 14
            s.matches = 14
            return s

        seasons = {2019: line("Kings XI Punjab"), 2021: line("Punjab Kings"),
                   2024: line("Mumbai Indians"), 2025: line("Mumbai Indians")}
        _, record = _player_documents(7, "Test Player", seasons, newest=2026)
        assert record["franchises"] == ["Punjab Kings 2019", "Punjab Kings 2021", "Mumbai Indians 2024-2025"]
        events = " | ".join(record["events"])
        assert "moved franchise: Punjab Kings in IPL 2021, Mumbai Indians in IPL 2024" in events
        assert "IPL 2020" in events and "IPL 2022-2023" in events
        assert "no IPL 2026 appearance" in events
        assert "Kings XI Punjab" not in events

    def test_the_profile_states_bands_by_role(self):
        from scout.knowledge import dataset_profile

        pool = [{"player_name": f"B{i}", "role": "Bowler", "economy": 7 + i / 10, "matches": 20,
                 "wickets": 20 + i, "overseas": 0, "cap_status": "CAPPED"} for i in range(10)]
        profile = dataset_profile(pool)
        econ = next(b for b in profile["bands"] if b["column"] == "economy")
        assert econ["role"] == "Bowler" and econ["higher_is_better"] is False
        lead = next(l for l in profile["leaders"] if l["column"] == "economy")
        assert lead["players"][0].startswith("B0 ")
