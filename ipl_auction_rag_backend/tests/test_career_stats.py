"""
Tests for the full-career refresh (scout/agents/career_stats.py) and the style
parser it depends on (scout/tools/player_styles.py).

The failure these exist to prevent is the one that started the work: a pool
column holding a fraction of a career. So the aggregation is checked across
seasons, the role shape is checked, and the splits are checked to count only
deliveries whose opponent's style is actually known.
"""
from __future__ import annotations

import json
import zipfile

from scout.agents.career_stats import _stats_for, aggregate, build_updates
from scout.tools.player_styles import Style, parse_profile, same_person


def _ball(batter, bowler, runs, *, wides=0, wicket=None):
    ball = {"batter": batter, "bowler": bowler,
            "runs": {"batter": runs, "extras": wides, "total": runs + wides}}
    if wides:
        ball["extras"] = {"wides": wides}
    if wicket:
        ball["wickets"] = [{"kind": wicket, "player_out": batter}]
    return ball


def _match(season, balls, players):
    return {
        "info": {"season": season, "dates": [f"{season}-04-01"],
                 "players": {"A": players[:2], "B": players[2:]},
                 "registry": {"people": {p: f"id-{p}" for p in players}}},
        "innings": [{"overs": [{"deliveries": balls}]}],
    }


def _archive(tmp_path):
    players = ["V Kohli", "X Other", "JJ Bumrah", "S Spinner"]
    matches = [
        _match(2015, [_ball("V Kohli", "JJ Bumrah", 4)] * 20 + [_ball("V Kohli", "S Spinner", 1)] * 20,
               players),
        _match(2026, [_ball("V Kohli", "JJ Bumrah", 2)] * 20
               + [_ball("V Kohli", "JJ Bumrah", 0, wides=1)]
               + [_ball("V Kohli", "S Spinner", 0, wicket="bowled")], players),
    ]
    path = tmp_path / "ipl.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for i, m in enumerate(matches):
            zf.writestr(f"{i}.json", json.dumps(m))
    return path


class TestCareerAggregation:
    def test_whole_career_not_recent_seasons(self, tmp_path):
        careers, newest, *_ = aggregate(_archive(tmp_path))
        kohli = careers["id-V Kohli"]
        assert newest == 2026
        assert kohli.matches == 2
        assert kohli.runs == 20 * 4 + 20 * 1 + 20 * 2  # both seasons
        assert kohli.balls == 61  # the wide is not a ball faced
        assert careers["id-S Spinner"].wickets == 1

    def test_splits_count_only_known_styles(self, tmp_path):
        careers, *_ = aggregate(_archive(tmp_path))
        kohli = careers["id-V Kohli"]
        styles = {"id-JJ Bumrah": Style("pace", "right")}  # the spinner is unknown
        counted = [0, 0]
        stats = _stats_for(kohli, "Batter", styles, counted)
        assert stats["matches"] == 2 and stats["total_runs"] == 140
        assert stats["sr_vs_fast"] == round((80 + 40) / 40 * 100, 2)
        assert "sr_vs_spin" not in stats, "no spin split from an unclassified bowler"
        assert counted == [40, 61]
        assert "economy" not in stats, "a Batter's row carries no bowling"

    def test_build_updates_maps_the_pool(self, tmp_path):
        pool = [{"id": 1, "player_name": "Virat Kohli", "role": "Batter"},
                {"id": 2, "player_name": "Jasprit Bumrah", "role": "Bowler"}]
        run = build_updates(_archive(tmp_path), pool, source_url="test", look_up=False)
        by_id = {u.match.player_id: u.stats.populated() for u in run.updates}
        assert by_id[1]["total_runs"] == 140
        assert by_id[2]["matches"] == 2 and "total_runs" not in by_id[2]
        assert run.season_through == 2026


class TestProfileParsing:
    def test_cricinfo_and_cricbuzz_wording(self):
        assert parse_profile("Batting Style. Left hand Bat ; Bowling Style. Left arm Fast medium.") == Style("pace", "left")
        assert parse_profile("Batting Style Right Handed Bat Bowling Style Right-arm offbreak") == Style("spin", "right")
        assert parse_profile("Batting Style Right Handed Bat Bowling Style Left-arm orthodox") == Style("spin", "right")
        assert parse_profile("Batting Style. Left hand Bat ; Bowling Style. Right arm").bowl == "unknown"

    def test_a_namesake_page_is_refused(self):
        assert same_person("Mustafizur Rahman", "Mustafizur Rahman Profile - Cricinfo")
        assert not same_person("Mustafizur Rahman", "Ziaur Rahman Profile - Cricket Player")
        assert same_person("RE van der Merwe", "Roelof van der Merwe Profile - ICC Ranking")
        assert not same_person("RE van der Merwe", "Stuart van der Merwe Profile - Cricket Player")
        assert same_person("CV Varun", "Varun Chakaravarthy Profile")
