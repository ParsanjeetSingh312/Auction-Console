"""
Tests for the Data Researcher: ball-by-ball aggregation and name resolution.

Two things here can corrupt the pool quietly rather than loudly, and both have
already done so once.

The first is the shape of a row. `players` stores batting *or* bowling per
player and `role` decides which -- ball-by-ball data happily supports both, and
writing both broke two existing tests and put a batting average on five bowlers.
The repair for that was a full re-ingest, which is how three columns came to be
NULL for the whole pool. A quiet write, an obvious-looking fix, and the damage
was downstream of both.

The second is resolution. A name that fails to match is parked and reported. A
name that matches the *wrong* row writes one player's form onto another's record
where nothing will ever flag it, so the tie rule matters more than the hit rate:
this pool has twenty-one shared surnames and twelve Sharmas.
"""
from datetime import datetime, timezone

import pytest

from scout.agents.data_researcher import (
    BOWLING_ROLE,
    MIN_BALLS_BOWLED,
    MIN_BALLS_FACED,
    _updates_from_tally,
    aggregate_cricsheet,
)
from scout.schemas.player import SourceRef
from scout.tools.rag_pipeline import resolve_player

SOURCE = SourceRef(
    source_id="cricsheet",
    url="https://cricsheet.org/downloads/ipl_male_json.zip",
    method="scrape",
    retrieved_at=datetime.now(timezone.utc),
)

#: Two roles, one shared surname, and an initial-only spelling to resolve.
POOL = [
    {"id": 1, "player_name": "Hardik Pandya", "role": "All-Rounder"},
    {"id": 2, "player_name": "Jasprit Bumrah", "role": "Bowler"},
    {"id": 3, "player_name": "Rohit Sharma", "role": "Batter"},
    {"id": 4, "player_name": "Ishan Sharma", "role": "Bowler"},
    {"id": 5, "player_name": "MS Dhoni", "role": "Wicket Keeper"},
]


def tally(**kwargs) -> dict[str, float]:
    """A tally row with every key present, since the aggregator always sets all six."""
    row = {"runs": 0, "balls": 0, "outs": 0, "conceded": 0, "bowled": 0, "wickets": 0}
    row.update(kwargs)
    return row


def stats_for(name: str, row: dict[str, float], pool=POOL) -> dict:
    updates, _ = _updates_from_tally({name: row}, pool, SOURCE)
    return updates[0].stats.model_dump(exclude_none=True) if updates else {}


class TestRoleDecidesTheShapeOfTheRow:
    """
    `ingestion/excel_parser.py` picks one parser or the other on role, so a
    Bowler's row has no batting columns and everyone else's has no bowling
    columns. Two tests in the existing suite assert it from the other side.
    The aggregator has to agree, even though the source data supports both.
    """

    def test_bowler_gets_no_batting_stats_however_many_runs(self):
        stats = stats_for("Jasprit Bumrah", tally(runs=400, balls=300, outs=10))
        assert stats == {}, f"wrote batting stats onto a Bowler: {stats}"

    def test_non_bowler_gets_no_bowling_stats_however_many_overs(self):
        stats = stats_for("Rohit Sharma", tally(bowled=600, conceded=700, wickets=20))
        assert stats == {}, f"wrote bowling stats onto a Batter: {stats}"

    def test_all_rounder_is_batted_not_bowled(self):
        """
        An All-Rounder is not a Bowler by this rule, however it reads in
        English. Only the literal role 'Bowler' takes bowling columns, because
        that is the branch the spreadsheet parser takes.
        """
        stats = stats_for(
            "Hardik Pandya",
            tally(runs=400, balls=300, outs=10, bowled=600, conceded=700, wickets=20),
        )
        assert "bat_sr" in stats, "an All-Rounder should carry batting stats"
        assert "economy" not in stats, f"an All-Rounder must not carry bowling stats: {stats}"

    def test_bowler_role_constant_matches_the_pool_spelling(self):
        assert BOWLING_ROLE == "Bowler"


class TestSampleSizeThresholds:
    """A strike rate from nine balls is not a strike rate."""

    def test_batting_below_threshold_writes_nothing(self):
        assert stats_for("Rohit Sharma", tally(runs=59, balls=MIN_BALLS_FACED - 1, outs=1)) == {}

    def test_batting_at_threshold_writes(self):
        stats = stats_for("Rohit Sharma", tally(runs=90, balls=MIN_BALLS_FACED, outs=2))
        assert stats["bat_sr"] == 150.0
        assert stats["bat_avg"] == 45.0
        assert stats["total_runs"] == 90

    def test_bowling_below_threshold_writes_nothing(self):
        assert stats_for(
            "Jasprit Bumrah", tally(bowled=MIN_BALLS_BOWLED - 1, conceded=100, wickets=5)
        ) == {}

    def test_bowling_at_threshold_writes(self):
        stats = stats_for(
            "Jasprit Bumrah", tally(bowled=MIN_BALLS_BOWLED, conceded=160, wickets=8)
        )
        assert stats["economy"] == 8.0, "160 runs from 20 overs is an economy of 8"
        assert stats["wickets"] == 8
        assert stats["bowl_sr"] == 15.0, "120 balls for 8 wickets is a ball every 15"

    def test_a_batter_who_was_never_out_still_gets_a_strike_rate(self):
        """Dividing by zero outs would crash; an average is simply omitted."""
        stats = stats_for("Rohit Sharma", tally(runs=120, balls=80, outs=0))
        assert stats["bat_sr"] == 150.0
        assert "bat_avg" not in stats

    def test_a_bowler_who_took_no_wickets_still_gets_an_economy(self):
        stats = stats_for("Jasprit Bumrah", tally(bowled=120, conceded=180, wickets=0))
        assert stats["economy"] == 9.0
        assert "bowl_avg" not in stats
        assert "bowl_sr" not in stats


class TestUnresolvedNamesAreReported:
    def test_a_name_not_in_the_pool_is_returned_not_dropped(self):
        updates, unresolved = _updates_from_tally(
            {"Nobody Here": tally(runs=200, balls=120, outs=4)}, POOL, SOURCE
        )
        assert updates == []
        assert unresolved == ["Nobody Here"], "an unmatched name must be reported, not swallowed"


class TestNameResolution:
    """
    Scorecards spell one person several ways. Getting this wrong is worse than
    failing, because a wrong match is invisible once written.
    """

    @pytest.mark.parametrize("spelling", [
        "Hardik Pandya",
        "HH Pandya",
        "Pandya, HH",
        "hardik pandya",
    ])
    def test_the_same_player_through_several_spellings(self, spelling):
        assert resolve_player(spelling, POOL).player_id == 1, f"{spelling!r} did not resolve"

    def test_an_ambiguous_surname_is_refused_rather_than_guessed(self):
        """
        Two Sharmas in this pool, twelve in the real one. A bare surname cannot
        choose between them, and choosing anyway writes a batter's form onto a
        bowler's record.
        """
        match = resolve_player("Sharma", POOL)
        assert match.player_id is None, (
            f"picked {match.resolved_name!r} from an ambiguous surname"
        )

    def test_an_unresolved_match_carries_no_resolved_name(self):
        """The schema rejects a resolved_name without an id; this is that rule live."""
        match = resolve_player("Someone Entirely Absent", POOL)
        assert match.player_id is None
        assert match.resolved_name is None


class TestAggregationFollowsTheLawsOfCricket:
    """
    The arithmetic that turns deliveries into figures. Each of these is a rule
    a naive sum would get wrong, and getting one wrong shifts a real player's
    numbers by a plausible-looking amount that no bound would catch.
    """

    @staticmethod
    def _archive(tmp_path, deliveries):
        import json
        import zipfile

        match = {
            "info": {"season": "2026"},
            "innings": [{"overs": [{"over": 0, "deliveries": deliveries}]}],
        }
        path = tmp_path / "ipl.zip"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("2026_match.json", json.dumps(match))
        return path

    def test_a_wide_is_not_a_ball_faced_and_not_a_ball_bowled(self, tmp_path):
        archive = self._archive(tmp_path, [
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 1},
             "extras": {"wides": 1}},
        ])
        counts, _ = aggregate_cricsheet(archive, seasons_back=3)
        assert counts["A"]["balls"] == 0, "a wide was counted as a ball faced"
        assert counts["B"]["bowled"] == 0, "a wide was counted as a ball bowled"
        assert counts["B"]["conceded"] == 1, "a wide is still charged to the bowler"

    def test_a_no_ball_is_not_bowled_but_is_charged(self, tmp_path):
        archive = self._archive(tmp_path, [
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 1},
             "extras": {"noballs": 1}},
        ])
        counts, _ = aggregate_cricsheet(archive, seasons_back=3)
        assert counts["B"]["bowled"] == 0
        assert counts["B"]["conceded"] == 1

    def test_byes_and_leg_byes_are_not_charged_to_the_bowler(self, tmp_path):
        archive = self._archive(tmp_path, [
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 4},
             "extras": {"byes": 4}},
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 2},
             "extras": {"legbyes": 2}},
        ])
        counts, _ = aggregate_cricsheet(archive, seasons_back=3)
        assert counts["B"]["conceded"] == 0, "byes were charged to the bowler"
        assert counts["B"]["bowled"] == 2, "both were legal deliveries"

    def test_a_run_out_is_a_dismissal_but_not_the_bowlers_wicket(self, tmp_path):
        archive = self._archive(tmp_path, [
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 0},
             "wickets": [{"kind": "run out", "player_out": "A"}]},
        ])
        counts, _ = aggregate_cricsheet(archive, seasons_back=3)
        assert counts["A"]["outs"] == 1, "a run out still ends the batter's innings"
        assert counts["B"]["wickets"] == 0, "a run out was credited to the bowler"

    def test_a_retirement_is_neither_a_dismissal_nor_a_wicket(self, tmp_path):
        archive = self._archive(tmp_path, [
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 0},
             "wickets": [{"kind": "retired hurt", "player_out": "A"}]},
        ])
        counts, _ = aggregate_cricsheet(archive, seasons_back=3)
        assert counts["A"]["outs"] == 0, "a retirement is not a dismissal"
        assert counts["B"]["wickets"] == 0

    def test_a_caught_dismissal_counts_for_both(self, tmp_path):
        archive = self._archive(tmp_path, [
            {"batter": "A", "bowler": "B", "runs": {"batter": 0, "total": 0},
             "wickets": [{"kind": "caught", "player_out": "A"}]},
        ])
        counts, _ = aggregate_cricsheet(archive, seasons_back=3)
        assert counts["A"]["outs"] == 1
        assert counts["B"]["wickets"] == 1

    def test_seasons_outside_the_window_are_excluded(self, tmp_path):
        """
        "Last three seasons" is relative to the newest season in the archive,
        not to the calendar -- an archive pulled in February contains no
        current-season matches, and a calendar cutoff would return nothing.
        """
        import json
        import zipfile

        path = tmp_path / "ipl.zip"
        with zipfile.ZipFile(path, "w") as zf:
            for season, batter in (("2026", "Recent"), ("2015", "Ancient")):
                zf.writestr(f"{season}.json", json.dumps({
                    "info": {"season": season},
                    "innings": [{"overs": [{"over": 0, "deliveries": [
                        {"batter": batter, "bowler": "B",
                         "runs": {"batter": 1, "total": 1}}]}]}],
                }))

        counts, notes = aggregate_cricsheet(path, seasons_back=3)
        assert "Recent" in counts
        assert "Ancient" not in counts, "a 2015 match was included in a three-season window"
        assert any("2024-2026" in n for n in notes), notes
