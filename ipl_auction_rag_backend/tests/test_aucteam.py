"""
AUCTEAM: tiers, the live check, the grade, and the routes.

The route tests mount only the AUCTEAM router on a bare app rather than
importing api.main, which would load the embedding stack for no reason. They
read the real 284-player pool from a *copy* of the SQLite file, so creating
AUCTEAM's tables never touches the database the server uses.
"""
from __future__ import annotations

import shutil

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aucteam import store
from aucteam.analysis import (
    SCOUT_PROMPT_LIMIT,
    build_report,
    check_roster,
    compute_metrics,
    scout_prompt,
    score_team,
)
from aucteam.aucteam_schema import AucteamPlayer, ReportRequest, TeamPayload
from aucteam.tiers import derive_tier, name_key, to_card
from config.settings import get_settings


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

_next_id = iter(range(1, 10_000))


def row(role="Batter", matches=60, capped=True, overseas=False, name=None, **stats):
    pid = next(_next_id)
    return {
        "id": pid,
        "player_name": name or f"Player {pid}",
        "role": role,
        "cap_status": "CAPPED" if capped else "UNCAPPED",
        "overseas": int(overseas),
        "matches": matches,
        "rating": 8.0,
        "jersey_number": None,
        "total_runs": 1500, "bat_avg": 30.0, "bat_sr": 135.0,
        "sr_vs_fast": 135.0, "sr_vs_spin": 130.0,
        "wickets": 60, "economy": 8.0, "bowl_avg": 25.0, "bowl_sr": 19.0,
        "econ_vs_lhb": 8.1, "econ_vs_rhb": 7.9,
        **stats,
    }


def card(**kwargs) -> AucteamPlayer:
    return to_card(row(**kwargs), {})


def balanced_eleven() -> list[AucteamPlayer]:
    return [
        card(role="Batter", matches=200, bat_sr=150, bat_avg=40),
        card(role="Batter", matches=90, bat_sr=145, bat_avg=34, sr_vs_spin=145),
        card(role="Batter", matches=40, bat_sr=142, bat_avg=31),
        card(role="Wicket Keeper", matches=120, bat_sr=148, bat_avg=33),
        card(role="All-Rounder", matches=70, overseas=True),
        card(role="All-Rounder", matches=15),
        card(role="Bowler", matches=110, overseas=True),
        card(role="Bowler", matches=80, overseas=True),
        card(role="Bowler", matches=55),
        card(role="Bowler", matches=10, capped=False),
        card(role="Batter", matches=30, overseas=True),
    ]


# ---------------------------------------------------------------------------
# Tiers
# ---------------------------------------------------------------------------


class TestTiers:
    @pytest.mark.parametrize(
        ("matches", "capped", "overseas", "tier"),
        [(264, True, False, "MQ"), (150, True, True, "MQ"), (65, True, False, "PR"),
         (16, True, False, "PR"), (15, True, False, "EM"), (3, True, True, "PR"),
         (0, False, False, "EM"), (49, False, True, "EM"), (55, False, False, "PR")],
    )
    def test_derivation_thresholds(self, matches, capped, overseas, tier):
        row_ = {"matches": matches, "overseas": int(overseas),
                "cap_status": "CAPPED" if capped else "UNCAPPED"}
        assert derive_tier(row_)[0] == tier

    def test_missing_matches_reads_as_none_played(self):
        assert derive_tier({"matches": None})[0] == "EM"

    def test_curated_tier_beats_derivation(self):
        # Uncapped with 264 matches would derive MQ anyway; an EM override must still win.
        dhoni = row(name="MS Dhoni", matches=264, capped=False)
        result = to_card(dhoni, {name_key("M.S. Dhoni"): ("PR", "test")})
        assert (result.tier, result.tier_source) == ("PR", "curated")

    def test_bowler_card_shows_bowling_figures(self):
        keys = [s.key for s in card(role="Bowler").stats]
        assert keys == ["matches", "wickets", "economy", "bowl_avg", "bowl_sr", "econ_vs_lhb"]

    def test_batting_card_shows_the_six_from_the_brief(self):
        keys = [s.key for s in card(role="Batter").stats]
        assert keys == ["matches", "total_runs", "bat_avg", "bat_sr", "sr_vs_fast", "sr_vs_spin"]

    def test_absent_stat_is_none_not_zero(self):
        assert card(role="Batter", bat_avg=None).stats[2].value is None

    def test_unknown_role_is_skipped(self):
        assert to_card(row(role="Umpire"), {}) is None


# ---------------------------------------------------------------------------
# Payloads
# ---------------------------------------------------------------------------


class TestPayloads:
    def test_duplicates_refused(self):
        with pytest.raises(ValueError):
            TeamPayload(player_ids=[1, 2, 2])

    def test_twelve_refused(self):
        with pytest.raises(ValueError):
            TeamPayload(player_ids=list(range(1, 13)))

    def test_report_needs_exactly_eleven(self):
        with pytest.raises(ValueError):
            ReportRequest(player_ids=list(range(1, 11)))
        assert len(ReportRequest(player_ids=list(range(1, 12))).player_ids) == 11


# ---------------------------------------------------------------------------
# The live check and the grade
# ---------------------------------------------------------------------------


class TestCheck:
    def test_balanced_eleven_is_legal_and_grades_well(self):
        roster = balanced_eleven()
        metrics = compute_metrics(roster)
        issues = check_roster(roster, metrics)
        assert not [i for i in issues if i.severity == "block"]
        score, grade = score_team(metrics, issues)
        assert grade in ("A", "B"), (score, issues)

    def test_five_overseas_blocks(self):
        roster = balanced_eleven()
        roster[5] = card(role="All-Rounder", matches=15, overseas=True)
        issues = check_roster(roster, compute_metrics(roster))
        assert any(i.code == "overseas" and i.severity == "block" for i in issues)

    def test_no_keeper_blocks_only_when_no_slot_left(self):
        partial = [card(role="Batter") for _ in range(6)]
        assert not any(i.code == "no_keeper" for i in check_roster(partial, compute_metrics(partial)))
        full = [card(role="Batter") for _ in range(4)] + [card(role="Bowler") for _ in range(7)]
        assert any(i.code == "no_keeper" for i in check_roster(full, compute_metrics(full)))

    def test_short_roles_not_flagged_while_there_is_room(self):
        partial = [card(role="Batter"), card(role="Batter")]
        assert check_roster(partial, compute_metrics(partial)) == []

    def test_all_batters_grades_poorly(self):
        roster = [card(role="Wicket Keeper")] + [card(role="Batter") for _ in range(10)]
        metrics = compute_metrics(roster)
        _, grade = score_team(metrics, check_roster(roster, metrics))
        assert grade == "D"

    def test_experience_shares(self):
        roster = [card(matches=200) for _ in range(3)] + [card(matches=5, capped=False) for _ in range(2)]
        metrics = compute_metrics(roster)
        assert metrics.tier_counts == {"MQ": 3, "PR": 0, "EM": 2}
        assert metrics.marquee_share == pytest.approx(0.6)

    def test_scout_prompt_fits_the_drawer(self):
        roster = [card(name=f"Extraordinarily Longnamed Cricketer{i}") for i in range(11)]
        prompt = scout_prompt(roster, compute_metrics(roster))
        assert len(prompt) <= SCOUT_PROMPT_LIMIT
        assert prompt.endswith("weakest link?")


class TestReportWithoutModel:
    def test_rule_based_report_when_no_provider(self, monkeypatch):
        from rag import llm_provider

        monkeypatch.setattr(llm_provider, "available", lambda: False)
        report = build_report("Test XI", balanced_eleven())
        assert report.mode == "local_analyst"
        assert report.notes and "rule" in report.notes[0]
        assert report.balance.body and report.experience.body

    def test_bad_model_json_falls_back(self, monkeypatch):
        from rag import llm_provider

        monkeypatch.setattr(llm_provider, "available", lambda: True)
        monkeypatch.setattr(llm_provider, "complete", lambda *a, **k: "not json at all")
        report = build_report(None, balanced_eleven())
        assert report.mode == "local_analyst"
        assert any("JSON" in note for note in report.notes)

    def test_model_prose_is_used_but_grade_is_not(self, monkeypatch):
        from rag import llm_provider

        reply = ('{"headline": "H", "summary": "S", "grade": "A",'
                 '"balance": {"verdict": "V", "body": "B"},'
                 '"experience": {"verdict": "V2", "body": "B2"},'
                 '"strengths": ["s"], "missing_links": ["m"], "avoidable": ["a"]}')
        monkeypatch.setattr(llm_provider, "available", lambda: True)
        monkeypatch.setattr(llm_provider, "complete", lambda *a, **k: reply)
        roster = [card(role="Wicket Keeper")] + [card(role="Batter") for _ in range(10)]
        report = build_report(None, roster)
        assert report.mode == "llm"
        assert report.headline == "H"
        assert report.grade == "D"  # the model's "A" is ignored


# ---------------------------------------------------------------------------
# Routes, against the real pool
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    settings = get_settings()
    original = settings.SQLITE_DB_PATH
    copy = tmp_path_factory.mktemp("aucteam") / "ipl_auction.db"
    shutil.copy(original, copy)
    settings.SQLITE_DB_PATH = str(copy)
    store._ready_for = None
    from api.routes_aucteam import reset_pool_cache, router

    reset_pool_cache()

    app = FastAPI()
    app.include_router(router)
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        settings.SQLITE_DB_PATH = original
        store._ready_for = None
        reset_pool_cache()


def _ids_by_name(client, *names):
    players = client.get("/api/v1/aucteam/pool").json()["players"]
    lookup = {p["name"]: p for p in players}
    return [lookup[n]["id"] for n in names]


class TestRoutes:
    def test_pool_serves_every_player_with_a_tier(self, client):
        body = client.get("/api/v1/aucteam/pool").json()
        assert body["total"] == 284
        assert body["tier_counts"] == {"MQ": 13, "PR": 159, "EM": 112}
        assert body["rules"]["squad_size"] == 11

    def test_brief_examples_land_in_their_tiers(self, client):
        players = {p["name"]: p for p in client.get("/api/v1/aucteam/pool").json()["players"]}
        expected = {
            "MS Dhoni": "MQ", "Virat Kohli": "MQ", "Rohit Sharma": "MQ",
            "Sai Sudharsan": "PR", "Abhishek Sharma": "PR", "Arshdeep Singh": "PR",
            "Nitish Kumar Reddy": "EM", "Sakib Hussain": "EM", "Anshul Kamboj": "EM",
        }
        assert {n: players[n]["tier"] for n in expected} == expected
        assert players["MS Dhoni"]["jersey_number"] == 7

    def test_tier_filter(self, client):
        body = client.get("/api/v1/aucteam/pool?tier=MQ").json()
        assert body["players"] and all(p["tier"] == "MQ" for p in body["players"])

    def test_validate_unknown_id_is_422(self, client):
        assert client.post("/api/v1/aucteam/validate", json={"player_ids": [999999]}).status_code == 422

    def test_validate_partial(self, client):
        ids = _ids_by_name(client, "Virat Kohli", "MS Dhoni")
        body = client.post("/api/v1/aucteam/validate", json={"player_ids": ids}).json()
        assert body["complete"] is False and body["legal"] is True
        assert "Kohli" in body["scout_prompt"]

    def test_report_for_ten_is_422(self, client):
        ids = [p["id"] for p in client.get("/api/v1/aucteam/pool").json()["players"][:10]]
        assert client.post("/api/v1/aucteam/report", json={"player_ids": ids}).status_code == 422

    def test_full_report_round_trip(self, client, monkeypatch):
        from rag import llm_provider

        monkeypatch.setattr(llm_provider, "available", lambda: False)
        ids = _ids_by_name(
            client,
            "Virat Kohli", "Rohit Sharma", "Sai Sudharsan", "MS Dhoni", "Abhishek Sharma",
            "Nitish Kumar Reddy", "Anshul Kamboj", "Arshdeep Singh", "Jasprit Bumrah",
            "Sakib Hussain", "Shubman Gill",
        )
        response = client.post("/api/v1/aucteam/report", json={"team_name": "Test XI", "player_ids": ids})
        assert response.status_code == 200, response.text
        report = response.json()
        assert report["grade"] in "ABCD" and len(report["roster"]) == 11
        assert report["report_id"]
        saved = client.get(f"/api/v1/aucteam/report/{report['report_id']}").json()
        assert saved["headline"] == report["headline"]
