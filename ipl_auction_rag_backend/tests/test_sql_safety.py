"""
Tests for the SQL guard applied to LLM-generated queries.

The Text-to-SQL path sends model output to the database, so the validator is
the boundary that keeps a hallucinated or injected statement from mutating
data. It must reject writes and chaining without rejecting legitimate reads.
"""
import pytest

from db.sqlite_manager import SQLiteManager, validate_select_only


class TestAcceptsLegitimateQueries:
    @pytest.mark.parametrize("sql", [
        "SELECT player_name FROM players",
        "SELECT * FROM players LIMIT 10;",
        "SELECT player_name, economy FROM players WHERE role = 'Bowler' ORDER BY economy ASC LIMIT 5",
        "SELECT COUNT(*) FROM players WHERE cap_status = 'UNCAPPED'",
        "WITH top AS (SELECT * FROM players LIMIT 5) SELECT player_name FROM top",
        "SELECT AVG(bat_sr) FROM players WHERE bat_sr IS NOT NULL",
    ])
    def test_read_only_queries_pass(self, sql):
        is_safe, reason = validate_select_only(sql)
        assert is_safe, f"rejected a valid query: {reason}"

    def test_hyphenated_role_literal_passes(self):
        """
        'All-Rounder' contains '--', which a substring scan reads as the start
        of a SQL comment. This is the single most common query in the app.
        """
        sql = "SELECT player_name FROM players WHERE role = 'All-Rounder'"
        is_safe, reason = validate_select_only(sql)
        assert is_safe, f"rejected the All-Rounder filter: {reason}"

    def test_column_named_like_a_keyword_passes(self):
        sql = "SELECT player_name, runs_conceded FROM players WHERE role = 'Bowler'"
        assert validate_select_only(sql)[0]


class TestRejectsWrites:
    @pytest.mark.parametrize("sql", [
        "DROP TABLE players",
        "DELETE FROM players",
        "INSERT INTO players (player_name) VALUES ('x')",
        "UPDATE players SET rating = 10",
        "ALTER TABLE players ADD COLUMN x TEXT",
        "CREATE TABLE evil (id INT)",
        "REPLACE INTO players VALUES (1)",
        "VACUUM",
        "PRAGMA table_info(players)",
        "ATTACH DATABASE '/tmp/evil.db' AS evil",
    ])
    def test_write_statements_rejected(self, sql):
        is_safe, reason = validate_select_only(sql)
        assert not is_safe
        assert reason


class TestRejectsInjection:
    def test_statement_chaining_rejected(self):
        is_safe, reason = validate_select_only("SELECT 1; DROP TABLE players")
        assert not is_safe
        assert "chaining" in reason

    def test_write_hidden_after_select_rejected(self):
        assert not validate_select_only(
            "SELECT * FROM players; DELETE FROM players WHERE 1=1"
        )[0]

    def test_line_comment_rejected(self):
        is_safe, reason = validate_select_only("SELECT * FROM players -- comment")
        assert not is_safe
        assert "comment" in reason

    def test_block_comment_rejected(self):
        assert not validate_select_only("SELECT /* sneaky */ * FROM players")[0]

    def test_empty_input_rejected(self):
        assert not validate_select_only("")[0]
        assert not validate_select_only("   ")[0]

    def test_non_select_prose_rejected(self):
        assert not validate_select_only("I cannot answer that question.")[0]

    def test_trailing_semicolon_allowed(self):
        assert validate_select_only("SELECT * FROM players;")[0]


class TestExecutionLayerEnforcement:
    """execute_query must guard independently of the generator's check."""

    def test_write_raises_before_touching_db(self):
        manager = SQLiteManager()
        with pytest.raises(ValueError):
            manager.execute_query("DROP TABLE players")

    def test_chained_statement_raises(self):
        manager = SQLiteManager()
        with pytest.raises(ValueError):
            manager.execute_query("SELECT 1; DROP TABLE players")

    def test_table_survives_attempted_drop(self):
        manager = SQLiteManager()
        before = manager.get_player_count()
        for attack in ("DROP TABLE players", "DELETE FROM players",
                       "SELECT 1; DROP TABLE players"):
            with pytest.raises(ValueError):
                manager.execute_query(attack)
        assert manager.get_player_count() == before

    def test_legitimate_query_still_executes(self):
        rows = SQLiteManager().execute_query(
            "SELECT player_name FROM players WHERE role = 'All-Rounder' LIMIT 3"
        )
        assert len(rows) == 3
        assert all("player_name" in row for row in rows)

    def test_parameterised_query_executes(self):
        rows = SQLiteManager().execute_query(
            "SELECT player_name FROM players WHERE role = ? LIMIT ?",
            ("Bowler", 2),
        )
        assert len(rows) == 2


class TestNullHandling:
    """NaN must reach SQLite as NULL, never as a junk float."""

    def test_bowlers_have_null_not_nan_batting(self):
        rows = SQLiteManager().execute_query(
            "SELECT COUNT(*) AS c FROM players "
            "WHERE role = 'Bowler' AND bat_avg IS NOT NULL"
        )
        assert rows[0]["c"] == 0

    def test_null_ordering_excludes_missing_rows(self):
        rows = SQLiteManager().execute_query(
            "SELECT player_name, economy FROM players "
            "WHERE economy IS NOT NULL ORDER BY economy ASC LIMIT 5"
        )
        assert all(row["economy"] > 0 for row in rows)
