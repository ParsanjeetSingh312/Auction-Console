"""
Tests for the category-polymorphic Excel parser.

The source sheet reuses 11 physical columns with different meanings depending
on a row's Category, so these tests pin the per-role interpretation and the
treatment of "no IPL record" zeros.
"""

import pandas as pd
import pytest

from ingestion.data_loader import generate_player_summary
from ingestion.excel_parser import (
    _as_percent,
    _parse_batting_row,
    _parse_bowling_row,
    _rate,
    parse_excel,
)


class TestRateCoercion:
    """A rate of 0 means 'no record', not a real zero."""

    def test_zero_rate_becomes_none(self):
        assert _rate(0) is None
        assert _rate(0.0) is None

    def test_real_values_pass_through(self):
        assert _rate(7.3) == 7.3
        assert _rate(149.7) == 149.7

    def test_none_stays_none(self):
        assert _rate(None) is None


class TestPercentNormalisation:
    def test_fraction_scales_to_percent(self):
        assert _as_percent(0.185) == 18.5

    def test_already_percent_is_untouched(self):
        assert _as_percent(23.8) == 23.8

    def test_boundary_at_one(self):
        # 1.0 is ambiguous; treated as a fraction -> 100%.
        assert _as_percent(1.0) == 100.0

    def test_none_stays_none(self):
        assert _as_percent(None) is None


class TestBattingRowSemantics:
    """Batter / Wicket Keeper / All-Rounder rows carry batting stats."""

    # Virat Kohli's row from the sheet.
    KOHLI = [206.0, 7697.0, 44.49, 138.6, 0.128, 0.184, 129.62, 150.75]

    def test_batting_fields_map_in_order(self):
        result = _parse_batting_row(self.KOHLI)
        assert result["matches"] == 206
        assert result["total_runs"] == 7697
        assert result["bat_avg"] == 44.49
        assert result["bat_sr"] == 138.6
        assert result["sr_vs_spin"] == 129.62
        assert result["sr_vs_fast"] == 150.75

    def test_boundary_percentages_normalised(self):
        result = _parse_batting_row(self.KOHLI)
        assert result["boundary_pct_spin"] == 12.8
        assert result["boundary_pct_fast"] == 18.4

    def test_bowling_fields_are_null(self):
        result = _parse_batting_row(self.KOHLI)
        for field in ("wickets", "runs_conceded", "economy", "bowl_avg",
                      "bowl_sr", "econ_vs_lhb", "econ_vs_rhb"):
            assert result[field] is None, f"{field} leaked into a batting row"

    def test_debutant_with_all_zeros_has_null_rates(self):
        result = _parse_batting_row([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        assert result["matches"] == 0       # factually correct
        assert result["total_runs"] == 0    # factually correct
        assert result["bat_avg"] is None    # not a 0.00 average
        assert result["bat_sr"] is None


class TestBowlingRowSemantics:
    """Bowler rows carry bowling stats in the same physical columns."""

    # Jasprit Bumrah's row from the sheet.
    BUMRAH = [158.0, 184.0, 4363.0, 7.3, 23.8, 7.15, 7.35, None]

    def test_bowling_fields_map_in_order(self):
        result = _parse_bowling_row(self.BUMRAH)
        assert result["matches"] == 158
        assert result["wickets"] == 184
        assert result["runs_conceded"] == 4363
        assert result["economy"] == 7.3
        assert result["bowl_avg"] == 23.8
        assert result["econ_vs_lhb"] == 7.15
        assert result["econ_vs_rhb"] == 7.35

    def test_batting_fields_are_null(self):
        """The old parser read 4363 runs conceded as a batting average."""
        result = _parse_bowling_row(self.BUMRAH)
        for field in ("total_runs", "bat_avg", "bat_sr", "boundary_pct_spin",
                      "boundary_pct_fast", "sr_vs_spin", "sr_vs_fast"):
            assert result[field] is None, f"{field} leaked into a bowling row"

    def test_bowling_strike_rate_is_derived(self):
        # overs = 4363 / 7.3 = 597.7; balls = 3586.3; / 184 wickets = 19.5
        assert _parse_bowling_row(self.BUMRAH)["bowl_sr"] == 19.5

    def test_bowling_average_identity_holds(self):
        """runs_conceded / wickets should reproduce the stated bowl_avg."""
        result = _parse_bowling_row(self.BUMRAH)
        derived = result["runs_conceded"] / result["wickets"]
        assert derived == pytest.approx(result["bowl_avg"], abs=0.1)

    def test_bowl_sr_is_none_without_inputs(self):
        assert _parse_bowling_row([0.0] * 8)["bowl_sr"] is None


class TestParseExcelIntegration:
    """End-to-end parse of the real workbook."""

    # Parsing the workbook once per class keeps this suite fast, but a
    # class-scoped fixture written as an instance method is removed in pytest
    # 10 — each test gets a fresh instance while the fixture runs once, so
    # anything set on `self` would silently vanish. Declaring it a staticmethod
    # makes the absence of instance state explicit and forward-compatible.
    @pytest.fixture(scope="class")
    @staticmethod
    def df():
        return parse_excel()

    def test_all_players_parsed(self, df):
        assert len(df) == 284

    def test_header_rows_excluded(self, df):
        assert not df["player_name"].isin(["Player Name", "Category"]).any()

    def test_roles_normalised(self, df):
        assert set(df["role"].unique()) == {
            "Batter", "Bowler", "All-Rounder", "Wicket Keeper"
        }

    def test_required_fields_never_null(self, df):
        for column in ("player_name", "role", "cap_status", "overseas"):
            assert df[column].notna().all(), f"{column} has nulls"

    def test_no_batting_stats_on_bowlers(self, df):
        bowlers = df[df["role"] == "Bowler"]
        assert bowlers["bat_avg"].isna().all()
        assert bowlers["bat_sr"].isna().all()

    def test_no_bowling_stats_on_batters(self, df):
        batters = df[df["role"] != "Bowler"]
        assert batters["economy"].isna().all()
        assert batters["wickets"].isna().all()

    def test_batting_stats_within_plausible_range(self, df):
        """
        Loose bounds only. Bowling all-rounders genuinely post very low batting
        strike rates on tiny samples (Adam Zampa: 5 runs off 11 balls = 45.45),
        so the floor here is deliberately generous — this catches unit errors,
        not selectivity.
        """
        strike_rates = df["bat_sr"].dropna()
        assert strike_rates.between(20, 260).all(), "implausible batting SR"
        averages = df["bat_avg"].dropna()
        assert averages.between(1, 70).all(), "implausible batting average"

    def test_established_batters_have_tight_stats(self, df):
        """Players with a real sample must land in true top-flight T20 ranges."""
        established = df[(df["matches"] >= 20) & (df["total_runs"] >= 500)]
        assert len(established) > 50, "expected a substantial established cohort"
        assert established["bat_sr"].between(100, 200).all()
        assert established["bat_avg"].between(10, 60).all()

    def test_bowling_stats_within_plausible_range(self, df):
        economies = df["economy"].dropna()
        assert economies.between(4, 16).all(), "implausible economy rate"

    def test_no_zero_valued_rates(self, df):
        """A 0 rate would sort as best-in-class under ORDER BY ASC."""
        for column in ("bat_avg", "bat_sr", "economy", "bowl_avg"):
            assert not (df[column].dropna() == 0).any(), f"{column} has a 0"

    def test_overseas_flag_is_binary(self, df):
        assert set(df["overseas"].unique()) <= {0, 1}

    def test_known_bowler_is_correct(self, df):
        bumrah = df[df["player_name"] == "Jasprit Bumrah"].iloc[0]
        assert bumrah["wickets"] == 184
        assert bumrah["economy"] == 7.3
        assert pd.isna(bumrah["bat_avg"])

    def test_known_batter_is_correct(self, df):
        kohli = df[df["player_name"] == "Virat Kohli"].iloc[0]
        assert kohli["total_runs"] == 7697
        assert kohli["bat_avg"] == 44.49
        assert pd.isna(kohli["economy"])


class TestPlayerSummary:
    """Embedded summaries must not surface NaN or invented figures."""

    def test_bowler_summary_has_no_nan(self):
        summary = generate_player_summary({
            "player_name": "Jasprit Bumrah", "role": "Bowler",
            "cap_status": "CAPPED", "overseas": 0, "country": "India",
            "matches": 158, "wickets": 184, "runs_conceded": 4363,
            "economy": 7.3, "bowl_avg": 23.8, "bowl_sr": 19.5,
            "econ_vs_lhb": 7.15, "econ_vs_rhb": 7.35,
            "total_runs": None, "bat_avg": None, "bat_sr": None,
        })
        assert "nan" not in summary.lower()
        assert "184 wickets" in summary
        assert "economy rate 7.30" in summary

    def test_nan_values_are_omitted(self):
        summary = generate_player_summary({
            "player_name": "Test Player", "role": "Bowler",
            "cap_status": "CAPPED", "overseas": 0, "country": "India",
            "bowl_avg": float("nan"), "economy": float("nan"),
        })
        assert "nan" not in summary.lower()

    def test_debutant_is_described_as_unproven(self):
        summary = generate_player_summary({
            "player_name": "Rookie", "role": "Batter", "cap_status": "UNCAPPED",
            "overseas": 0, "country": "India", "matches": 0, "total_runs": 0,
        })
        assert "no IPL match experience" in summary
        assert "Scored 0 runs" not in summary

    def test_summary_starts_with_identity(self):
        summary = generate_player_summary({
            "player_name": "Virat Kohli", "role": "Batter",
            "cap_status": "CAPPED", "overseas": 0, "country": "India",
        })
        assert summary.startswith("Virat Kohli is a capped Indian Batter from India.")
